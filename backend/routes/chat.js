'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { handleChat }  = require('../chat/handler');
const { perUserLimiter } = require('../middleware/rateLimit');

// Shared quota between /send and /edit — both trigger the same expensive
// handleChat pipeline (crisis + age-pattern detection, agent generation,
// memory extraction), so a client alternating between the two endpoints
// shouldn't be able to bypass the limit by switching routes.
const chatGenerationLimiter = perUserLimiter(
  60 * 1000, 20,
  'Too many messages — please wait a moment before sending more.'
);

// ── Guest token chat quota enforcement ────────────────────────────────────
// Fase 11 pre-demo security audit (23 Aug 2026): guest_access_tokens.
// chat_quota was set at token-creation time (admin.js) but never read or
// decremented anywhere in the actual chat pipeline — a guest token holder
// could send unlimited messages, capped only by the SAME generic 20/min
// rate limit every user gets (chatGenerationLimiter above), which is a
// completely different kind of protection (anti-spam, not a usage cap).
//
// Checked once here, shared between /send and /edit — same "one check,
// two routes" reasoning as chatGenerationLimiter. Runs BEFORE handleChat()
// so a guest who's already out of quota doesn't also burn a real
// safety-detector API call for a message that's going to be rejected
// anyway. Quota is consumed on the ATTEMPT (matching how the rate limiter
// above also counts attempts, not successes) rather than threading a
// quota-refund path through the whole handleChat pipeline for the edge
// case of a system-side failure — a reasonable first pass, revisit if
// that fairness edge case turns out to matter in practice.
const checkGuestQuota = async (userId) => {
  const { data: token } = await supabase
    .from('guest_access_tokens')
    .select('id, chat_quota')
    .eq('assigned_user_id', userId)
    .maybeSingle();

  // Not a guest account at all — nothing to enforce, same as every other
  // user on the platform.
  if (!token) return { allowed: true };

  if (token.chat_quota <= 0) return { allowed: false };

  // Atomic guarded decrement (not select-then-update) — the `.gt('chat_quota', 0)`
  // guard closes the race window where two concurrent requests could both
  // read chat_quota > 0 and both decrement, letting a guest slip past
  // their actual limit. If another request already brought it to 0
  // between our SELECT and this UPDATE, the guard matches zero rows and
  // `updated` comes back null — correctly denying this request too.
  const { data: updated } = await supabase
    .from('guest_access_tokens')
    .update({ chat_quota: token.chat_quota - 1 })
    .eq('id', token.id)
    .gt('chat_quota', 0)
    .select('id')
    .maybeSingle();

  return { allowed: !!updated };
};

// POST /api/chat/send
router.post('/send', verifyToken, chatGenerationLimiter, async (req, res) => {
  const { message, mode } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message is required' });
  }

  const quotaCheck = await checkGuestQuota(req.userId);
  if (!quotaCheck.allowed) {
    return res.status(403).json({
      status:  'error',
      code:    'GUEST_QUOTA_EXCEEDED',
      message: 'Your demo chat quota has been used up.',
    });
  }

  const chatMode = mode === 'deep' ? 'deep' : 'quick';

  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('display_name, gender, language_style, language')
      .eq('id', req.userId)
      .single();

    if (!profile) {
      return res.status(404).json({ status: 'error', message: 'Profile not found' });
    }

    const result = await handleChat(req.userId, profile, message.trim(), chatMode);
    res.json({
      status:        'success',
      userMessage:   result.userMessage,
      responses:     result.responses,
      mode:          chatMode,
      safetySupport: result.safetySupport || false,
    });

  } catch (err) {
    console.error('[Chat Route] /send error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/chat/edit
router.post('/edit', verifyToken, chatGenerationLimiter, async (req, res) => {
  const { messageId, content, mode } = req.body;

  if (!messageId || !content?.trim()) {
    return res.status(400).json({ status: 'error', message: 'messageId and content are required' });
  }

  const quotaCheck = await checkGuestQuota(req.userId);
  if (!quotaCheck.allowed) {
    return res.status(403).json({
      status:  'error',
      code:    'GUEST_QUOTA_EXCEEDED',
      message: 'Your demo chat quota has been used up.',
    });
  }

  try {
    const { data: original, error: findErr } = await supabase
      .from('messages')
      .select('created_at, sender')
      .eq('id', messageId)
      .eq('user_id', req.userId)
      .single();

    if (findErr || !original) {
      return res.status(404).json({ status: 'error', message: 'Message not found' });
    }
    if (original.sender !== 'User') {
      return res.status(400).json({ status: 'error', message: 'Only your own messages can be edited' });
    }

    const { error: delErr } = await supabase
      .from('messages')
      .delete()
      .eq('user_id', req.userId)
      .gte('created_at', original.created_at);

    if (delErr) throw delErr;

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('display_name, gender, language_style, language')
      .eq('id', req.userId)
      .single();

    if (!profile) {
      return res.status(404).json({ status: 'error', message: 'Profile not found' });
    }

    const chatMode = mode === 'deep' ? 'deep' : 'quick';
    const result   = await handleChat(req.userId, profile, content.trim(), chatMode);

    res.json({
      status:        'success',
      userMessage:   result.userMessage,
      responses:     result.responses,
      mode:          chatMode,
      safetySupport: result.safetySupport || false,
    });

  } catch (err) {
    console.error('[Chat Route] /edit error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/chat/message/:id
router.delete('/message/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success' });

  } catch (err) {
    console.error('[Chat Route] /message delete error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/chat/messages — bulk delete
router.delete('/messages', verifyToken, async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ status: 'error', message: 'ids array is required' });
  }

  try {
    const { error } = await supabase
      .from('messages')
      .delete()
      .in('id', ids)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success', deletedCount: ids.length });

  } catch (err) {
    console.error('[Chat Route] /messages bulk delete error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/chat/history?limit=50
router.get('/history', verifyToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender, content, created_at, voice_transcript, sources')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    res.json({ status: 'success', data: data || [] });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/chat/vault
router.get('/vault', verifyToken, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 30, 100);
  const before = req.query.before;
  const search = req.query.search;
  const sender = req.query.sender;

  try {
    let query = supabase
      .from('messages')
      .select('id, sender, content, created_at, voice_transcript, sources')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) query = query.lt('created_at', before);
    if (sender && sender !== 'All') query = query.eq('sender', sender);
    if (search?.trim()) query = query.ilike('content', `%${search.trim()}%`);

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      status:  'success',
      data:    data || [],
      hasMore: (data || []).length === limit,
    });

  } catch (err) {
    console.error('[Chat Route] /vault error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;