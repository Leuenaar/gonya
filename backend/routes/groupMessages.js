'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { perUserLimiter, veraGroupLimiter } = require('../middleware/rateLimit');
const { judgeMessage, CONTEXT_WINDOW }     = require('../safety/groupJudge');
const { triggerVera }                      = require('../chat/groupVeraTrigger');
const { triggerAksel }                     = require('../chat/groupAkselTrigger');
const { addToBatch, hasPendingBatch }      = require('../chat/groupBatch');
const { resetIdleTimer }                   = require('../chat/groupIdleTrigger');
const { uploadFile, getFileUrl }           = require('../lib/storage');

router.use(verifyToken);

// 30 messages per minute per user across all groups — prevents spam
const msgRateLimit = perUserLimiter(60 * 1000, 30,
  'Too many messages — please slow down.');

// Fixed quick-reaction set (WhatsApp-style), not a free emoji picker —
// keeps the UI simple and matches the CHECK constraint in
// group_message_reactions (Phase 8.7).
const ALLOWED_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const getMember = async (groupId, userId) => {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return data || null;
};

const getRecentMessages = async (groupId, limit = CONTEXT_WINDOW) => {
  const { data } = await supabase
    .from('group_messages')
    .select('id, sender_type, sender_name, content, created_at')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse();
};

// ── GET /api/groups/:id/messages ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });

    const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before; // ISO timestamp for pagination

    let query = supabase
      .from('group_messages')
      .select('id, group_id, sender_id, sender_type, sender_name, content, reply_to, created_at, deleted_at, group_message_reactions(id, sender_id, sender_type, sender_name, emoji), group_message_attachments(id, file_name, file_type, storage_provider, storage_path, size_bytes)')
      .eq('group_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data: messages, error } = await query;
    if (error) throw error;

    // Resolve a usable URL for each attachment before responding — Supabase
    // Storage is a private bucket (needs a signed URL, same helper personal
    // chat's files.js already uses), Cloudinary URLs are direct/public.
    // Signed URLs are time-limited (1h, see lib/storage.js) — acceptable
    // trade-off for a portfolio-scale app; a very long-open tab may need a
    // refresh to reload an old inline image, same as most chat apps' own
    // signed-media links eventually expire too.
    const withUrls = await Promise.all(
      (messages || []).map(async (m) => {
        const attachments = m.group_message_attachments || [];
        if (attachments.length === 0) return m;
        const resolved = await Promise.all(
          attachments.map(async (a) => ({
            ...a,
            url: await getFileUrl(a.storage_path, a.storage_provider).catch(() => null),
          }))
        );
        return { ...m, group_message_attachments: resolved };
      })
    );

    res.json({ status: 'success', messages: withUrls.reverse() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/messages ─────────────────────────────────────────────
// 1. Validate + save the user's message
// 2. Fire the full judge pipeline (fire-and-forget, never blocks the response)
router.post('/', msgRateLimit, async (req, res) => {
  const { content, reply_to, file_name, file_type, file_base64 } = req.body;
  const trimmedContent = content?.trim() || '';
  const hasFile         = !!(file_name && file_type && file_base64);

  if (!trimmedContent && !hasFile)
    return res.status(400).json({ status: 'error', message: 'content or a file is required' });

  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });

    // Fetch sender name for display
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('display_name')
      .eq('id', req.userId)
      .single();

    // Save user message — Realtime broadcasts it to all group members immediately
    const { data: message, error } = await supabase
      .from('group_messages')
      .insert({
        group_id:    req.params.id,
        sender_id:   req.userId,
        sender_type: 'user',
        sender_name: profile?.display_name || 'Member',
        content:     trimmedContent,
        reply_to:    reply_to || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Upload + link the attachment AFTER the message exists (needs its id).
    // Reuses uploadFile() from lib/storage.js — the exact same pipeline
    // personal chat's files.js already relies on, no new upload logic.
    // A failed upload does NOT fail the whole request — the message text
    // itself already saved fine; it just ends up without an attachment.
    if (hasFile) {
      try {
        const uploadResult = await uploadFile(req.userId, file_name, file_type, file_base64);
        await supabase.from('group_message_attachments').insert({
          group_id:         req.params.id,
          message_id:       message.id,
          uploaded_by:      req.userId,
          file_name,
          file_type,
          storage_provider: uploadResult.provider,
          storage_path:     uploadResult.storagePath,
          size_bytes:       Buffer.byteLength(file_base64, 'base64'),
        });
      } catch (uploadErr) {
        console.error('[GroupMsg] Attachment upload failed:', uploadErr.message);
      }
    }

    // Respond immediately — pipeline runs in background
    res.json({ status: 'success', message });

    // ── Fire-and-forget judge pipeline ─────────────────────────────────────
    // Same pattern as memory extraction in personal chat (setImmediate),
    // never blocks the response already sent above.
    setImmediate(async () => {
      try {
        const snapshotTime   = message.created_at;
        const recentMessages = await getRecentMessages(req.params.id);

        // Fetch group agent_config for judge context
        const { data: group } = await supabase
          .from('groups')
          .select('agent_config')
          .eq('id', req.params.id)
          .maybeSingle();

        // If batch window is already open for this group, queue and bail —
        // the batch resolver will re-run the judge when the burst settles.
        if (hasPendingBatch(req.params.id)) {
          await addToBatch(req.params.id, message);
          return;
        }

        const verdict = await judgeMessage({
          groupId:       req.params.id,
          userId:        req.userId,
          latestMessage: message,
          recentHistory: recentMessages,
          agentConfig:   group?.agent_config || {},
        });

        if (verdict === 'BATCH_PENDING') {
          await addToBatch(req.params.id, message);
          // addToBatch returns a Promise that resolves when the burst settles.
          // We don't await it here — the batch module handles re-evaluation
          // internally via its own timeout.
          return;
        }

        if (verdict === 'TRIGGER_VERA') {
          if (veraGroupLimiter(req.params.id)) {
            // triggerVera handles its own delay + interrupt detection
            triggerVera({
              groupId:        req.params.id,
              recentMessages,
              snapshotTime,
              userId:         req.userId,
            }).catch(err => console.error('[GroupMsg] Vera error:', err.message));
          } else {
            console.log(`[GroupMsg] ${req.params.id}: Vera rate-limited (20/hr)`);
          }
        }

        if (verdict === 'RESPOND_AKSEL') {
          // No rate limiter here (unlike Vera) — Aksel's model is a free
          // Groq endpoint, so the cost-protection reasoning behind
          // veraGroupLimiter doesn't apply the same way.
          triggerAksel({
            groupId:        req.params.id,
            recentMessages,
            snapshotTime,
            userId:         req.userId,
          }).catch(err => console.error('[GroupMsg] Aksel error:', err.message));
        }

        // Reset idle timer on every user message regardless of verdict
        resetIdleTimer(req.params.id).catch(() => {});

      } catch (err) {
        console.error('[GroupMsg] Pipeline error:', err.message);
      }
    });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/messages/:messageId/reactions ───────────────────────
// Set (or toggle off) the CALLER'S OWN reaction on a message. Tapping the
// same emoji again removes it; tapping a different one replaces it. Agent
// reactions (Aksel/Vera) are inserted directly by their own trigger code,
// not through this endpoint — this one is user-only, same split as the
// message POST route above.
router.post('/:messageId/reactions', async (req, res) => {
  const { emoji } = req.body;
  if (!emoji || !ALLOWED_EMOJI.includes(emoji))
    return res.status(400).json({ status: 'error', message: `emoji must be one of: ${ALLOWED_EMOJI.join(' ')}` });

  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });

    // Confirm the message actually belongs to this group (avoid reacting
    // to a message_id from a different group via a crafted request).
    const { data: message } = await supabase
      .from('group_messages')
      .select('id')
      .eq('id', req.params.messageId)
      .eq('group_id', req.params.id)
      .maybeSingle();
    if (!message) return res.status(404).json({ status: 'error', message: 'Message not found in this group' });

    // Toggle off: caller already has exactly this emoji on this message.
    const { data: existing } = await supabase
      .from('group_message_reactions')
      .select('id, emoji')
      .eq('message_id', req.params.messageId)
      .eq('sender_id', req.userId)
      .maybeSingle();

    if (existing?.emoji === emoji) {
      const { error: delErr } = await supabase
        .from('group_message_reactions')
        .delete()
        .eq('id', existing.id);
      if (delErr) throw delErr;
      return res.json({ status: 'success', action: 'removed' });
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('display_name')
      .eq('id', req.userId)
      .single();

    const reactionPayload = {
      group_id:    req.params.id,
      message_id:  req.params.messageId,
      sender_id:   req.userId,
      sender_type: 'user',
      sender_name: profile?.display_name || 'Member',
      emoji,
    };

    // Insert-then-catch-unique-violation-then-update, NOT .upsert(): the
    // one-reaction-per-person uniqueness is an EXPRESSION index
    // (coalesce(sender_id, sender_type), see Phase 8.7 migration) that
    // supabase-js's onConflict option can't target directly. Same
    // retry-safe principle used elsewhere in this codebase (username
    // generation, Phase 8.5 signup): try the insert; if it collides with
    // a genuine concurrent write, fall back to an update instead.
    const { data: inserted, error: insertErr } = await supabase
      .from('group_message_reactions')
      .insert(reactionPayload)
      .select()
      .single();

    if (!insertErr) {
      return res.json({ status: 'success', action: 'set', reaction: inserted });
    }
    if (insertErr.code !== '23505') throw insertErr;

    const { data: updated, error: updateErr } = await supabase
      .from('group_message_reactions')
      .update({ emoji, sender_name: profile?.display_name || 'Member' })
      .eq('message_id', req.params.messageId)
      .eq('sender_id', req.userId)
      .select()
      .single();

    if (updateErr) throw updateErr;
    res.json({ status: 'success', action: 'set', reaction: updated });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── DELETE /api/groups/:id/messages/:messageId ────────────────────────────
// Delete-for-everyone (Phase 8.9) — content is genuinely cleared, not just
// hidden behind a flag; frontend renders a tombstone based on deleted_at.
// Equal for all senders, no exception for the group owner — anyone can
// delete ONLY their own message, matching the "kesetaraan berargumen"
// product decision. Agent messages (sender_id is null) aren't deletable
// through this endpoint by anyone — there's no "owner" of an agent
// message to authorize the delete against.
router.delete('/:messageId', async (req, res) => {
  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });

    const { data: message } = await supabase
      .from('group_messages')
      .select('id, sender_id')
      .eq('id', req.params.messageId)
      .eq('group_id', req.params.id)
      .maybeSingle();

    if (!message) return res.status(404).json({ status: 'error', message: 'Message not found in this group' });
    if (message.sender_id !== req.userId)
      return res.status(403).json({ status: 'error', message: 'You can only delete your own messages' });

    const { error } = await supabase
      .from('group_messages')
      .update({ content: '', deleted_at: new Date().toISOString() })
      .eq('id', req.params.messageId);

    if (error) throw error;

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;