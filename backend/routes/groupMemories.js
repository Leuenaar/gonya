'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// ── Helper ────────────────────────────────────────────────────────────────
// Same pattern as groupMessages.js's getMember() — one lookup, reused by
// every route below to check both membership AND role.
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

const isOwnerOrCoAdmin = (member) => member && (member.role === 'owner' || member.role === 'co_admin');

// ── GET /api/groups/:id/memories ──────────────────────────────────────────
// Regular members: approved only (matches the RLS policy a direct client
// query would see). Owner/co-admin: everything, OR filtered to a specific
// status via ?status= — the approval queue (step 6's UI) uses
// ?status=pending against this same endpoint rather than a separate route.
router.get('/', async (req, res) => {
  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });

    let query = supabase
      .from('group_memories')
      .select('id, group_id, content, layer, category, status, agent_target, approved_by, created_at')
      .eq('group_id', req.params.id)
      .order('created_at', { ascending: false });

    if (isOwnerOrCoAdmin(member)) {
      // Owner/co-admin can see any status — narrow with ?status= if given,
      // otherwise return everything for this group.
      if (req.query.status) query = query.eq('status', req.query.status);
    } else {
      // Regular members never see the raw pending queue — approved only,
      // matching what the RLS policy itself would allow them to read.
      query = query.eq('status', 'approved');
    }

    const { data: memories, error } = await query;
    if (error) throw error;

    res.json({ status: 'success', memories: memories || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/groups/:id/memories/:memoryId ──────────────────────────────
// Approve or reject a pending group memory. Owner/co-admin ONLY — checked
// here in code (not left to RLS alone), same hardened pattern already used
// for AdminTerminal's privileged writes. Uses the service-role Supabase
// client (bypasses RLS, which itself has no insert/update policy for
// `authenticated` at all for this table — see add_group_memories_policies.sql).
router.patch('/:memoryId', async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ status: 'error', message: "status must be 'approved' or 'rejected'" });

  try {
    const member = await getMember(req.params.id, req.userId);
    if (!member) return res.status(403).json({ status: 'error', message: 'Not a member' });
    if (!isOwnerOrCoAdmin(member))
      return res.status(403).json({ status: 'error', message: 'Only the group owner or co-admin can approve or reject group memories' });

    // Confirm the memory actually belongs to this group (avoid approving/
    // rejecting a memoryId from a different group via a crafted request) —
    // same defensive check groupMessages.js's reaction/delete routes use.
    const { data: memory } = await supabase
      .from('group_memories')
      .select('id, status')
      .eq('id', req.params.memoryId)
      .eq('group_id', req.params.id)
      .maybeSingle();

    if (!memory) return res.status(404).json({ status: 'error', message: 'Memory not found in this group' });

    const { data: updated, error } = await supabase
      .from('group_memories')
      .update({ status, approved_by: req.userId })
      .eq('id', req.params.memoryId)
      .select()
      .single();

    if (error) throw error;

    res.json({ status: 'success', memory: updated });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
