'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true }); // inherits :id from groups router
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const crypto          = require('crypto');
const { perUserLimiter } = require('../middleware/rateLimit');

// Usernames are human-guessable (unlike a random short_id), so this is a
// meaningfully larger account-enumeration surface — cap attempts per actor.
const usernameInviteLimiter = perUserLimiter(
  10 * 60 * 1000, 10,
  'Too many invite attempts — please wait before trying again.'
);

router.use(verifyToken);

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const getActiveMemberCount = async (groupId) => {
  const { count } = await supabase
    .from('group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .eq('status', 'active');
  return count || 0;
};

const getGroup = async (groupId) => {
  const { data } = await supabase
    .from('groups')
    .select('id, max_members, status, owner_id')
    .eq('id', groupId)
    .single();
  return data || null;
};

// ── POST /api/groups/:id/invites/short-id ────────────────────────────────────
// Owner-only invites a user by their GNY-XXXXXX Short ID.
router.post('/short-id', async (req, res) => {
  const { short_id } = req.body;
  if (!short_id?.trim())
    return res.status(400).json({ status: 'error', message: 'short_id is required' });

  try {
    const actor = await getMember(req.params.id, req.userId);
    if (!actor || actor.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can send invites' });

    const group = await getGroup(req.params.id);
    if (!group || group.status !== 'active')
      return res.status(404).json({ status: 'error', message: 'Group not found or inactive' });

    // Check capacity
    const memberCount = await getActiveMemberCount(req.params.id);
    if (memberCount >= group.max_members)
      return res.status(400).json({ status: 'error', message: 'Group is full (max 6 members)' });

    // Look up invitee by Short ID
    const { data: invitee } = await supabase
      .from('user_profiles')
      .select('id, display_name')
      .eq('short_id', short_id.trim().toUpperCase())
      .maybeSingle();
    if (!invitee)
      return res.status(404).json({ status: 'error', message: 'No user found with that Short ID' });

    // Check not already a member
    const existing = await getMember(req.params.id, invitee.id);
    if (existing)
      return res.status(400).json({ status: 'error', message: 'User is already a member of this group' });

    // Check no pending invite already
    const { data: pendingInvite } = await supabase
      .from('group_invites')
      .select('id')
      .eq('group_id', req.params.id)
      .eq('target_user_id', invitee.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (pendingInvite)
      return res.status(400).json({ status: 'error', message: 'A pending invite already exists for this user' });

    const { data: invite, error } = await supabase
      .from('group_invites')
      .insert({
        group_id:       req.params.id,
        invited_by:     req.userId,
        invite_type:    'short_id',
        target_user_id: invitee.id,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ status: 'success', invite, invitee: { display_name: invitee.display_name } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/invites/username ────────────────────────────────────
// Owner-only invites a user by their unique @username. Mirrors the
// short-id flow exactly except for the lookup column — username is
// case-insensitive (stored lowercase-only, per the format constraint on
// user_profiles.username), so we lowercase the input before matching.
router.post('/username', usernameInviteLimiter, async (req, res) => {
  const { username } = req.body;
  if (!username?.trim())
    return res.status(400).json({ status: 'error', message: 'username is required' });

  try {
    const actor = await getMember(req.params.id, req.userId);
    if (!actor || actor.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can send invites' });

    const group = await getGroup(req.params.id);
    if (!group || group.status !== 'active')
      return res.status(404).json({ status: 'error', message: 'Group not found or inactive' });

    const memberCount = await getActiveMemberCount(req.params.id);
    if (memberCount >= group.max_members)
      return res.status(400).json({ status: 'error', message: 'Group is full (max 6 members)' });

    // Look up invitee by username (exact match, case folded — usernames are
    // stored lowercase-only, so we normalize the input the same way rather
    // than using ilike, which would need wildcard-escaping to stay exact).
    // Case-insensitive lookup — was previously an exact match against a
    // lowercased input, which assumed every stored username is lowercase.
    // That holds for auto-generated usernames (lib/username.js's slugify()
    // always lowercases), but doesn't hold if a user can set/edit their
    // own username anywhere without the same enforcement, which would
    // silently break this lookup for that one account (reported: a
    // username invite for "clientdemo" failing while short_id invites to
    // the same account worked fine).
    //
    // Escaping is required here, not optional: usernames may legitimately
    // contain underscores (VALID_RE in lib/username.js allows [a-z0-9_]),
    // and ILIKE treats a bare "_" as "match any single character" — an
    // unescaped invite to "client_demo" could silently match a DIFFERENT
    // real account like "clientXdemo" instead of failing to find one,
    // which is worse than a false negative: it invites the wrong person.
    const escapedUsername = username.trim().replace(/[%_\\]/g, ch => `\\${ch}`);
    const { data: invitee } = await supabase
      .from('user_profiles')
      .select('id, display_name')
      .ilike('username', escapedUsername)
      .maybeSingle();
    // Deliberately the same generic message as "not found" for every other
    // failure branch below — usernames are human-guessable (unlike a random
    // short_id), so we avoid leaking distinctions between "no such user",
    // "already a member", etc. to reduce account-enumeration signal.
    if (!invitee)
      return res.status(404).json({ status: 'error', message: 'No user found with that username' });

    const existing = await getMember(req.params.id, invitee.id);
    if (existing)
      return res.status(400).json({ status: 'error', message: 'User is already a member of this group' });

    const { data: pendingInvite } = await supabase
      .from('group_invites')
      .select('id')
      .eq('group_id', req.params.id)
      .eq('target_user_id', invitee.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (pendingInvite)
      return res.status(400).json({ status: 'error', message: 'A pending invite already exists for this user' });

    const { data: invite, error } = await supabase
      .from('group_invites')
      .insert({
        group_id:       req.params.id,
        invited_by:     req.userId,
        invite_type:    'username',
        target_user_id: invitee.id,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ status: 'success', invite, invitee: { display_name: invitee.display_name } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/invites/link ────────────────────────────────────────
// Owner-only generates a one-time link that expires in 24 hours.
router.post('/link', async (req, res) => {
  try {
    const actor = await getMember(req.params.id, req.userId);
    if (!actor || actor.role !== 'owner')
      return res.status(403).json({ status: 'error', message: 'Only the group owner can send invites' });

    const group = await getGroup(req.params.id);
    if (!group || group.status !== 'active')
      return res.status(404).json({ status: 'error', message: 'Group not found or inactive' });

    const memberCount = await getActiveMemberCount(req.params.id);
    if (memberCount >= group.max_members)
      return res.status(400).json({ status: 'error', message: 'Group is full (max 6 members)' });

    const token     = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { data: invite, error } = await supabase
      .from('group_invites')
      .insert({
        group_id:    req.params.id,
        invited_by:  req.userId,
        invite_type: 'link',
        invite_token: token,
        expires_at:   expiresAt,
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ status: 'success', invite, token, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/groups/:id/invites/join/:token ───────────────────────────────────
// Anyone with the link can preview the group before accepting.
router.get('/join/:token', async (req, res) => {
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

// ── POST /api/groups/:id/invites/accept ──────────────────────────────────────
// Invitee accepts. Body: { token } for link flow, empty for short_id flow.
router.post('/accept', async (req, res) => {
  try {
    const group = await getGroup(req.params.id);
    if (!group || group.status !== 'active')
      return res.status(404).json({ status: 'error', message: 'Group not found or inactive' });

    const memberCount = await getActiveMemberCount(req.params.id);
    if (memberCount >= group.max_members)
      return res.status(400).json({ status: 'error', message: 'Group is now full' });

    // Find the pending invite for this user
    let query = supabase
      .from('group_invites')
      .select('id, invite_type, invite_token, target_user_id, expires_at')
      .eq('group_id', req.params.id)
      .eq('status', 'pending');

    if (req.body.token) {
      query = query.eq('invite_token', req.body.token);
    } else {
      query = query.eq('target_user_id', req.userId);
    }

    const { data: invite } = await query.maybeSingle();
    if (!invite)
      return res.status(404).json({ status: 'error', message: 'No pending invite found' });

    // Short_id invites are addressed to a specific user
    if (invite.invite_type === 'short_id' && invite.target_user_id !== req.userId)
      return res.status(403).json({ status: 'error', message: 'This invite is for a different user' });

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await supabase.from('group_invites').update({ status: 'expired' }).eq('id', invite.id);
      return res.status(410).json({ status: 'error', message: 'This invite has expired' });
    }

    // Add to group
    const { error: mErr } = await supabase
      .from('group_members')
      .insert({ group_id: req.params.id, user_id: req.userId, role: 'member' });
    if (mErr) throw mErr;

    // Mark invite used
    await supabase
      .from('group_invites')
      .update({ status: 'accepted', used_by: req.userId, used_at: new Date().toISOString() })
      .eq('id', invite.id);

    res.json({ status: 'success', message: 'Joined group successfully', group_id: req.params.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/groups/:id/invites/decline ─────────────────────────────────────
router.post('/decline', async (req, res) => {
  try {
    const { data: invite } = await supabase
      .from('group_invites')
      .select('id')
      .eq('group_id', req.params.id)
      .eq('target_user_id', req.userId)
      .eq('status', 'pending')
      .maybeSingle();

    if (!invite)
      return res.status(404).json({ status: 'error', message: 'No pending invite found' });

    await supabase.from('group_invites').update({ status: 'declined' }).eq('id', invite.id);
    res.json({ status: 'success', message: 'Invite declined' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── DELETE /api/groups/:id/invites/:inviteId — Revoke (owner + co_admin) ────
router.delete('/:inviteId', async (req, res) => {
  try {
    const actor = await getMember(req.params.id, req.userId);
    if (!actor || !['owner', 'co_admin'].includes(actor.role))
      return res.status(403).json({ status: 'error', message: 'Insufficient permissions' });

    const { data: invite } = await supabase
      .from('group_invites')
      .select('id')
      .eq('id', req.params.inviteId)
      .eq('group_id', req.params.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (!invite)
      return res.status(404).json({ status: 'error', message: 'Pending invite not found' });

    await supabase.from('group_invites').update({ status: 'revoked' }).eq('id', invite.id);
    res.json({ status: 'success', message: 'Invite revoked' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/groups/:id/invites — List pending invites (owner + co_admin) ───
router.get('/', async (req, res) => {
  try {
    const actor = await getMember(req.params.id, req.userId);
    if (!actor || !['owner', 'co_admin'].includes(actor.role))
      return res.status(403).json({ status: 'error', message: 'Insufficient permissions' });

    const { data: invites, error } = await supabase
      .from('group_invites')
      .select('id, invite_type, invite_token, expires_at, status, created_at, target_user:user_profiles(display_name, short_id)')
      .eq('group_id', req.params.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ status: 'success', invites: invites || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;