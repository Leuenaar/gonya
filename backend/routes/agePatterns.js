'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

const requireAdmin = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', req.userId)
      .single();
    if (error) throw error;
    if (data?.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};

router.use(requireAdmin);

// GET /api/age-patterns?status=flagged
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('age_pattern_signals')
      .select('user_id, minor_confidence, check_count, status, last_category, evidence_log, admin_reviewed_at, admin_verdict, created_at, updated_at')
      .neq('status', 'clear')
      .order('updated_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ status: 'success', signals: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/age-patterns/:userId  { verdict: 'adult_confirmed' | 'resolved_minor' }
router.patch('/:userId', async (req, res) => {
  const { verdict } = req.body;
  if (!['adult_confirmed', 'resolved_minor'].includes(verdict)) {
    return res.status(400).json({ status: 'error', message: 'Invalid verdict' });
  }
  try {
    const { data, error } = await supabase
      .from('age_pattern_signals')
      .update({
        admin_verdict:     verdict,
        admin_reviewed_at: new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      })
      .eq('user_id', req.params.userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Record not found' });
    res.json({ status: 'success', signal: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;