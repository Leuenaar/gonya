'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { ensureShortId } = require('../lib/shortId');
const { generateGroupQuestions, runGroupOnboarding } = require('../theones/groupOrchestrator');
const { anthropic }  = require('../lib/anthropic');
const { logUsage }   = require('../lib/usageLogger');

const VERA_MODEL = process.env.VERA_MODEL || 'claude-sonnet-4-6';
const CATCHUP_MESSAGE_LIMIT = 50;

router.use(verifyToken);

// ── Helpers ──────────────────────────────────────────────────────────────────

const isMember = async (groupId, userId) => {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  return data || null;
};

const isOwnerOrCoAdmin = async (groupId, userId) => {
  const member = await isMember(groupId, userId);
  return member && ['owner', 'co_admin'].includes(member.role) ? member : null;
};

// Used by the onboarding routes below — selects the columns THEY need
// (name, onboarding_done), distinct from groupInvites.js's own local
// getGroup() which selects a different column set for its own purposes.
const getGroup = async (groupId) => {
  const { data } = await supabase
    .from('groups')
    .select('id, name, status, onboarding_done, owner_id')
    .eq('id', groupId)
    .single();
  return data || null;
};

// ── POST /api/groups — Create a new group ────────────────────────────────────
router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ status: 'error', message: 'Group name is required' });

  try {
    // Ensure the creator has a Short ID before creating the group
    await ensureShortId(supabase, req.userId);

    const { data: group, error: gErr } = await supabase
      .from('groups')
      .insert({ name: name.trim(), owner_id: req.userId })
      .select()
      .single();
    if (gErr) throw gErr;

    // Auto-insert the creator as owner member
    const { error: mErr } = await supabase
      .from('group_members')
      .insert({ group_id: group.id, user_id: req.userId, role: 'owner' });
    if (mErr) throw mErr;

    res.json({ status: 'success', group });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/groups — List groups the caller belongs to ─────────────────────
router.get('/', async (req, res) => {
  try {
    const { data: memberships, error } = await supabase
      .from('group_members')
      .select('role, group:groups(id, name, purpose, status, onboarding_done, owner_id, created_at)')
      .eq('user_id', req.userId)
      .eq('status', 'active')
      .neq('group.status', 'dissolved');
    if (error) throw error;

    const groups = (memberships || [])
      .filter(m => m.group)
      .map(m => ({ ...m.group, my_role: m.role }));

    res.json({ status: 'success', groups });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/groups/:id — Get one group (members only) ──────────────────────
router.get('/:id', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member of this group' });

    const { data: group, error } = await supabase
      .from('groups')
      .select('*, members:group_members(user_id, role, joined_at, profile:user_profiles(display_name, username, short_id))')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    if (!group) return res.status(404).json({ status: 'error', message: 'Group not found' });

    res.json({ status: 'success', group: { ...group, my_role: member.role } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/groups/:id — Update name / purpose / agent_config (owner + co_admin) ──
router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'purpose', 'milestones', 'agent_config', 'onboarding_done'];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ status: 'error', message: 'No valid fields to update' });

  try {
    const actor = await isOwnerOrCoAdmin(req.params.id, req.userId);
    if (!actor) return res.status(403).json({ status: 'error', message: 'Insufficient permissions' });

    const { data: group, error } = await supabase
      .from('groups')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ status: 'success', group });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/archive — Owner only ───────────────────────────────
router.post('/:id/archive', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (member?.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the owner can archive a group' });

    const { data: group, error } = await supabase
      .from('groups')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    res.json({ status: 'success', group });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── DELETE /api/groups/:id — Hard delete (owner only, permanent) ───────────
// This comment always said "permanent" — the implementation didn't match
// it (only flipped status to 'dissolved'). Fixed as part of Portfolio v1
// item 5, per explicit product decision: hard delete, not soft.
router.delete('/:id', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (member?.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the owner can delete a group' });

    // Broadcast BEFORE the actual delete — while group_members rows still
    // exist, so the RLS check backing the "group:%" realtime topic (which
    // verifies active membership) still passes for anyone currently
    // viewing the group right now. Broadcasting from a DB trigger AFTER
    // the row (and its cascaded children) are gone would race against
    // that same check with no guaranteed winner.
    try {
      await supabase.rpc('broadcast_group_event', {
        p_group_id: req.params.id,
        p_event:    'group_deleted',
        p_payload:  {},
      });
    } catch (err) {
      console.warn(`[Groups] group_deleted broadcast failed for ${req.params.id} (non-fatal):`, err.message);
    }

    // Hard delete — every table referencing groups(id) already has ON
    // DELETE CASCADE (group_members, group_messages, group_invites,
    // group_message_reactions, confirmed via schema introspection), so
    // this single statement cleans up everything else automatically.
    const { error } = await supabase
      .from('groups')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;

    res.json({ status: 'success', message: 'Group permanently deleted' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/leave — Leave a group (any non-owner member) ──────
// Owners can't leave — a group must always have an owner. If an owner
// wants out, they delete the group (DELETE /:id) or would need an
// ownership-transfer flow first (not built — out of scope for now).
// This is the self-service safety valve members had no way to reach
// before: previously the only "exit" was the owner hard-deleting the
// whole group, which isn't the right tool for "I want out of this one
// group" (e.g. interpersonal conflict, no longer relevant to the project).
router.post('/:id/leave', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member of this group' });
    if (member.role === 'owner')
      return res.status(400).json({ status: 'error', message: "Owners can't leave a group — delete it instead, or transfer ownership first." });

    // Same reasoning as the hard-delete endpoint above: broadcast while the
    // membership row (and the RLS check it backs) still exists.
    try {
      await supabase.rpc('broadcast_group_event', {
        p_group_id: req.params.id,
        p_event:    'member_left',
        p_payload:  { user_id: req.userId },
      });
    } catch (err) {
      console.warn(`[Groups] member_left broadcast failed for ${req.params.id} (non-fatal):`, err.message);
    }

    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;

    // Also clear out any leftover 'pending' invite rows for this user in
    // this group. Normally accepting an invite flips it to 'accepted'
    // (see /accept below), but a duplicate invite created through a
    // different path (username vs short_id) before the first was ever
    // accepted can leave a second row permanently stuck at 'pending' —
    // which then blocks re-inviting this same person after they leave,
    // with "A pending invite already exists for this user". Leaving is a
    // deliberate exit, so any pending invite for them here is moot either
    // way; expiring it (not deleting, to keep the audit trail) guarantees
    // a clean slate for the next invite attempt regardless of how the
    // stale row got there in the first place.
    try {
      await supabase
        .from('group_invites')
        .update({ status: 'expired' })
        .eq('group_id', req.params.id)
        .eq('target_user_id', req.userId)
        .eq('status', 'pending');
    } catch (err) {
      console.warn(`[Groups] pending-invite cleanup failed for ${req.params.id}/${req.userId} (non-fatal):`, err.message);
    }

    res.json({ status: 'success', message: 'Left the group' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/onboard/questions — Phase 1 (owner only) ───────────
// Returns 3 clarifying questions (Haiku) before the owner kicks off the full
// onboarding pipeline. Called once when the owner first opens the onboarding UI.
router.post('/:id/onboard/questions', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (member?.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can run onboarding' });

    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({ status: 'error', message: 'Group not found' });
    if (group.onboarding_done)
      return res.status(400).json({ status: 'error', message: 'Onboarding already complete for this group' });

    const result = await generateGroupQuestions({ groupName: req.body.name || group.name, userId: req.userId });
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/onboard — Phase 2-4 (owner only) ───────────────────
// Body: { answers: string[], name?: string }
// Runs Opus pipeline: project definition → milestones → team context → agent config.
// Flips onboarding_done to true when complete.
router.post('/:id/onboard', async (req, res) => {
  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length < 3)
    return res.status(400).json({ status: 'error', message: 'answers array (min 3 items) is required' });

  try {
    const member = await isMember(req.params.id, req.userId);
    if (member?.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can run onboarding' });

    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({ status: 'error', message: 'Group not found' });
    if (group.onboarding_done)
      return res.status(400).json({ status: 'error', message: 'Onboarding already complete for this group' });

    // Fetch member list for Phase 3 team context
    const { data: members } = await supabase
      .from('group_members')
      .select('role, profile:user_profiles(display_name)')
      .eq('group_id', req.params.id)
      .eq('status', 'active');

    const memberList = (members || []).map(m => ({
      display_name: m.profile?.display_name || 'Unknown',
      role:         m.role,
    }));

    const result = await runGroupOnboarding({
      groupId:   req.params.id,
      groupName: req.body.name || group.name,
      answers,
      members:   memberList,
      userId:    req.userId,
    });

    if (result.status === 'error')
      return res.status(500).json({ status: 'error', message: result.message });

    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── General (demo) group persona — assigned directly, no Opus pipeline ──
// Bug fixed/designed (10 Sep 2026): mirrors routes/theones.js's personal
// /onboard-demo — gives a demo group the full real experience (same
// agent_config shape runGroupOnboarding() produces, same downstream
// consumers) without the 4-phase Opus pipeline's real cost per group.
// Deliberately does NOT invent a fake purpose/milestones tied to a
// specific project — a demo group has no real project, so purpose stays
// honestly generic and milestones stays empty rather than fabricating
// fake progress. team_context explicitly names this as a demo, same
// reasoning as leaving milestones empty: pretending there's a real team
// history here would be the same kind of dishonest persona-writing this
// project already had to walk back once for the personal version.
const GENERAL_GROUP_CONFIG = {
  purpose: 'A shared space to think through ideas, plans, and decisions together.',
  milestones: [],
  agent_config: {
    aksel_focus: "Aksel keeps the group moving — when the conversation is circling a decision or someone raises a concrete question, he steps in with a direct read rather than letting it drift.",
    vera_focus: "Vera pays attention to how people in the group are actually feeling about what's being discussed, not just what's being decided — she steps in when something needs to be worked through, not just resolved.",
    aksel_triggers: ['The group is stuck choosing between real options', 'Someone asks directly what the group should do next'],
    vera_triggers: ["Someone raises a concern or hesitation that hasn't been addressed", 'The conversation would benefit from slowing down before a decision gets made'],
    collaboration_note: "Aksel takes the lead on decisions; Vera steps in first when there's tension or uncertainty to work through before one gets made.",
    team_context: 'This is a demo group exploring what Gonya can do together — not tied to a specific real project yet.',
  },
};

router.post('/:id/onboard-demo', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (member?.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can run onboarding' });

    const group = await getGroup(req.params.id);
    if (!group) return res.status(404).json({ status: 'error', message: 'Group not found' });
    if (group.onboarding_done)
      return res.status(400).json({ status: 'error', message: 'Onboarding already complete for this group' });

    const { error } = await supabase
      .from('groups')
      .update({
        purpose:         GENERAL_GROUP_CONFIG.purpose,
        milestones:      GENERAL_GROUP_CONFIG.milestones,
        agent_config:    GENERAL_GROUP_CONFIG.agent_config,
        onboarding_done: true,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (error) throw error;

    res.json({ status: 'success', ...GENERAL_GROUP_CONFIG });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/catchup — Summarize recent activity (any member) ──
// Group Chat Portfolio v1, item 6. User-initiated and ephemeral: the
// summary is returned directly to the requester only — never saved to
// group_messages or broadcast to the group. Several people could ask at
// different times, and a public "Vera summarizes" message for each would
// just clutter the log with something only one person actually asked for.
router.post('/:id/catchup', async (req, res) => {
  try {
    const member = await isMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member of this group' });

    const { data: messages, error } = await supabase
      .from('group_messages')
      .select('sender_type, sender_name, content, deleted_at, created_at')
      .eq('group_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(CATCHUP_MESSAGE_LIMIT);
    if (error) throw error;

    const ordered = (messages || []).reverse();
    if (ordered.length === 0) {
      return res.json({ status: 'success', summary: 'Belum ada percakapan di grup ini.' });
    }

    // Deleted messages show as a placeholder, never their old content —
    // same tombstone principle as the UI (Phase 8.9).
    const transcript = ordered
      .map(m => `[${m.sender_name || m.sender_type}]: ${m.deleted_at ? '(pesan dihapus)' : m.content}`)
      .join('\n');

    const response = await anthropic.messages.create({
      model:      VERA_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content:
          `You are Vera. Someone just opened this group chat after being away and wants a quick ` +
          `catch-up. Summarize the key points from this recent conversation in 3-5 short bullet ` +
          `points — what was discussed, any decisions made, anything left open or waiting on them. ` +
          `Be concise and skip small talk/greetings unless they're substantive. Write naturally, no markdown headers.\n\n` +
          `Recent conversation:\n${transcript}`,
      }],
    });

    logUsage({
      model:        VERA_MODEL,
      callType:     'group_catchup',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId:       req.userId,
    });

    const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    res.json({ status: 'success', summary: summary || 'Gak ada yang perlu di-highlight dari percakapan terakhir.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;