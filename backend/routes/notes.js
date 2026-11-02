'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// GET /api/notes
// Returns the single note for this user (creates empty one if none exists)
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('quick_notes')
      .select('id, content, updated_at')
      .eq('user_id', req.userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // PGRST116 = no rows found — return empty state, don't create yet
    res.json({
      status:  'success',
      note:    data || { content: '', updated_at: null },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PUT /api/notes
// Upsert — creates or updates the single note for this user
router.put('/', async (req, res) => {
  const { content } = req.body;
  if (content === undefined) {
    return res.status(400).json({ status: 'error', message: 'Content required' });
  }
  try {
    const { data, error } = await supabase
      .from('quick_notes')
      .upsert(
        {
          user_id:    req.userId,
          content:    content,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', note: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;