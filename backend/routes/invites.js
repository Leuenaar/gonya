'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// ── GET /api/invites/mine — Pending invites addressed to the current user ──
// This is the missing piece behind "invited by username but no way to
// accept": groupInvites.js's own GET / (list) is owner/co_admin-scoped —
// there was never an endpoint letting a REGULAR user see invites sent TO
// them. Accepting/declining still goes through the existing
// /api/groups/:id/invites/accept and /decline routes (this list supplies
// the group_id each of those needs).
//
// MUST be registered before GET /:token below — Express matches routes in
// registration order, and /:token is a wildcard that would otherwise
// swallow every request to /mine (treating "mine" as a literal token
// value) before this handler ever got a chance to run. This ordering bug
// was the actual root cause of "invites never show up anywhere": the
// request wasn't failing, it was being answered by the wrong handler.
router.get('/mine', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('group_invites')
      .select('id, group_id, invite_type, created_at, group:groups(name, purpose)')
      .eq('target_user_id', req.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ status: 'success', invites: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/invites/:token — Preview an invite by its link token ────────────
// Flat and group-agnostic ON PURPOSE: the whole point of a shareable link
// is that the recipient doesn't know which group it's for until they open
// it — a nested /groups/:id/invites/join/:token route (which is what
// groupInvites.js actually exposes) can never work for this, since
// JoinGroup.tsx only ever has the token, never a group id. This was the
// root cause of "invite via link always shows Invite Unavailable" — the
// frontend was calling a URL that never existed at all (plain 404 on
// every attempt, regardless of the 24h expiry).
//
// Reuses the exact same lookup groupInvites.js's nested route already
// does — that one queries by invite_token alone too (the :id path param
// was never actually used in that query), so this isn't new logic, just
// exposed at the URL shape the frontend actually needs.
router.get('/:token', async (req, res) => {
  try {
    const { data: invite } = await supabase
      .from('group_invites')
      .select('id, group_id, expires_at, status, group:groups(name, purpose)')
      .eq('invite_token', req.params.token)
      .maybeSingle();

    if (!invite || invite.status !== 'pending')
      return res.status(404).json({ status: 'error', message: 'Invite not found or already used' });

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await supabase.from('group_invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(410).json({ status: 'error', message: 'This invite link has expired' });
    }

    res.json({ status: 'success', group: invite.group });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/invites/:token/accept — Accept a link invite ───────────────────
router.post('/:token/accept', async (req, res) => {
  try {
    const { data: invite } = await supabase
      .from('group_invites')
      .select('id, group_id, invite_type, expires_at, status')
      .eq('invite_token', req.params.token)
      .maybeSingle();

    if (!invite || invite.status !== 'pending')
      return res.status(404).json({ status: 'error', message: 'Invite not found or already used' });

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await supabase.from('group_invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(410).json({ status: 'error', message: 'This invite has expired' });
    }

    const { data: group } = await supabase
      .from('groups')
      .select('id, name, max_members, status')
      .eq('id', invite.group_id)
      .single();
    if (!group || group.status !== 'active')
      return res.status(404).json({ status: 'error', message: 'Group not found or inactive' });

    const { count: memberCount } = await supabase
      .from('group_members')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', invite.group_id)
      .eq('status', 'active');
    if ((memberCount || 0) >= group.max_members)
      return res.status(400).json({ status: 'error', message: 'Group is now full' });

    const { error: mErr } = await supabase
      .from('group_members')
      .insert({ group_id: invite.group_id, user_id: req.userId, role: 'member' });
    if (mErr) throw mErr;

    await supabase
      .from('group_invites')
      .update({ status: 'accepted', used_by: req.userId, used_at: new Date().toISOString() })
      .eq('id', invite.id);

    res.json({ status: 'success', message: 'Joined group successfully', group_id: invite.group_id, group_name: group.name });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;