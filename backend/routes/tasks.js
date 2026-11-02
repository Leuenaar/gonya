'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// GET /api/tasks
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, content, completed, created_at, updated_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json({ status: 'success', tasks: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/tasks
router.post('/', async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Content required' });
  }
  try {
    const { data, error } = await supabase
      .from('tasks')
      .insert({ user_id: req.userId, content: content.trim() })
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', task: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res) => {
  const updates = {};
  if (req.body.content   !== undefined) updates.content   = req.body.content.trim();
  if (req.body.completed !== undefined) updates.completed = req.body.completed;
  if (!Object.keys(updates).length) {
    return res.status(400).json({ status: 'error', message: 'No valid fields' });
  }
  updates.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Task not found' });
    res.json({ status: 'success', task: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/tasks/completed/all
router.delete('/completed/all', async (req, res) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('user_id', req.userId)
      .eq('completed', true);

    if (error) throw error;
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;