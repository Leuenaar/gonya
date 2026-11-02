'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

// ── GET /api/dossiers ─────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('dossiers')
      .select('id, name, description, color, created_at, updated_at')
      .eq('user_id', req.userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/dossiers ────────────────────────────────────
router.post('/', verifyToken, async (req, res) => {
  const { name, description, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ status: 'error', message: 'name required' });
  try {
    const { data, error } = await supabase
      .from('dossiers')
      .insert({ user_id: req.userId, name: name.trim(), description: description || null, color: color || '#00e5ff' })
      .select()
      .single();
    if (error) throw error;
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/dossiers/:id ───────────────────────────────
router.patch('/:id', verifyToken, async (req, res) => {
  const { name, description, color } = req.body;
  try {
    const { data, error } = await supabase
      .from('dossiers')
      .update({ name: name?.trim(), description, color, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── DELETE /api/dossiers/:id ──────────────────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('dossiers')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/dossiers/:id/contents ───────────────────────
// Returns all messages + files linked to this dossier
router.get('/:id/contents', verifyToken, async (req, res) => {
  try {
    const [{ data: msgs, error: msgErr }, { data: files, error: fileErr }] = await Promise.all([
      supabase
        .from('messages')
        .select('id, sender, content, created_at')
        .eq('user_id', req.userId)
        .eq('dossier_id', req.params.id)
        .order('created_at', { ascending: true })
        .limit(100),
      supabase
        .from('conversation_files')
        .select('id, file_name, file_type, storage_provider, size_bytes, created_at, expires_at')
        .eq('user_id', req.userId)
        .eq('dossier_id', req.params.id)
        .order('created_at', { ascending: false }),
    ]);
    if (msgErr)  throw msgErr;
    if (fileErr) throw fileErr;
    res.json({ status: 'success', data: { messages: msgs || [], files: files || [] } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/dossiers/:id/assign ───────────────────────
// Assign a message or file to this dossier
router.patch('/:id/assign', verifyToken, async (req, res) => {
  const { message_id, file_id } = req.body;
  if (!message_id && !file_id) return res.status(400).json({ status: 'error', message: 'message_id or file_id required' });
  try {
    if (message_id) {
      const { error } = await supabase
        .from('messages')
        .update({ dossier_id: req.params.id })
        .eq('id', message_id)
        .eq('user_id', req.userId);
      if (error) throw error;
    }
    if (file_id) {
      const { error } = await supabase
        .from('conversation_files')
        .update({ dossier_id: req.params.id })
        .eq('id', file_id)
        .eq('user_id', req.userId);
      if (error) throw error;
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;