'use strict';
const express     = require('express');
const { supabase } = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// GET /api/memories/pending
// Returns all pending memories for the authenticated user
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content, layer, category, agent_target, created_at')
      .eq('user_id', req.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ status: 'success', memories: data || [] });
  } catch (err) {
    console.error('[Memories] GET pending error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch pending memories' });
  }
});

// GET /api/memories/approved
// Returns all approved memories for the authenticated user
router.get('/approved', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content, layer, category, agent_target, created_at')
      .eq('user_id', req.userId)
      .eq('status', 'approved')
      .order('layer', { ascending: true });

    if (error) throw error;
    res.json({ status: 'success', memories: data || [] });
  } catch (err) {
    console.error('[Memories] GET approved error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch approved memories' });
  }
});

// PATCH /api/memories/:id/approve
router.patch('/:id/approve', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .update({ status: 'approved' })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Memory not found' });

    res.json({ status: 'success', memory: data });
  } catch (err) {
    console.error('[Memories] Approve error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to approve memory' });
  }
});

// PATCH /api/memories/:id/reject
router.patch('/:id/reject', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .update({ status: 'rejected' })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Memory not found' });

    res.json({ status: 'success', memory: data });
  } catch (err) {
    console.error('[Memories] Reject error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to reject memory' });
  }
});

// DELETE /api/memories/:id
// Permanently deletes a memory (approved or rejected)
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('memories')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success', message: 'Memory deleted' });
  } catch (err) {
    console.error('[Memories] Delete error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to delete memory' });
  }
});

module.exports = router;