'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// GET /api/calendar/events?month=2025-06
router.get('/events', async (req, res) => {
  try {
    const { month } = req.query;
    let query = supabase
      .from('calendar_events')
      .select('id, title, date, time, color, note, created_at')
      .eq('user_id', req.userId)
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    // Filter by month if provided (format: YYYY-MM)
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const start = `${month}-01`;
      const end   = new Date(
        parseInt(month.split('-')[0]),
        parseInt(month.split('-')[1]),
        0
      ).toISOString().slice(0, 10);
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ status: 'success', events: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/calendar/events
router.post('/events', async (req, res) => {
  const { title, date, time, color, note } = req.body;
  if (!title?.trim() || !date) {
    return res.status(400).json({ status: 'error', message: 'Title and date required' });
  }
  try {
    const { data, error } = await supabase
      .from('calendar_events')
      .insert({
        user_id: req.userId,
        title:   title.trim(),
        date,
        time:    time || null,
        color:   color || 'cyan',
        note:    note?.trim() || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', event: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/calendar/events/:id
router.patch('/events/:id', async (req, res) => {
  const allowed = ['title', 'date', 'time', 'color', 'note'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ status: 'error', message: 'No valid fields' });
  }
  updates.updated_at = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('calendar_events')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Event not found' });
    res.json({ status: 'success', event: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/calendar/events/:id
router.delete('/events/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/calendar/global-events?month=2025-06
// Returns global events filtered by user's radar_categories and domain
router.get('/global-events', async (req, res) => {
  try {
    const { month } = req.query;

    // Get user's personalization context
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('radar_categories')
      .eq('id', req.userId)
      .single();

    const { data: akselConfig } = await supabase
      .from('agent_configs')
      .select('domain')
      .eq('user_id', req.userId)
      .eq('agent', 'Aksel')
      .single();

    const { data: veraConfig } = await supabase
      .from('agent_configs')
      .select('domain')
      .eq('user_id', req.userId)
      .eq('agent', 'Vera')
      .single();

    // Map scanner's category taxonomy to the user-facing radar category list,
    // since they use different label sets (e.g. scanner uses "economy", user picks "Finance")
    const CATEGORY_ALIAS = {
      business:      ['business', 'marketing'],
      technology:    ['technology'],
      science:       ['science'],
      health:        ['health'],
      politics:      ['politics'],
      world:         ['world'],
      marketing:     ['marketing', 'business'],
      finance:       ['finance', 'business'],
      education:     ['education'],
      environment:   ['environment'],
      culture:       ['culture', 'entertainment'],
      entertainment: ['entertainment', 'culture'],
      // legacy values from before the taxonomy was unified
      economy:       ['finance', 'business', 'marketing'],
      other:         [],
    };

    const categories = (profile?.radar_categories || []).map(c => c.toLowerCase());
    const domains = [akselConfig?.domain, veraConfig?.domain]
      .filter(Boolean)
      .map(d => d.toLowerCase());

    let query = supabase
      .from('global_events')
      .select('id, title, date, summary, category, tags')
      .order('date', { ascending: true });

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const start = `${month}-01`;
      const end   = new Date(
        parseInt(month.split('-')[0]),
        parseInt(month.split('-')[1]),
        0
      ).toISOString().slice(0, 10);
      query = query.gte('date', start).lte('date', end);
    }

    const { data: allEvents, error } = await query;
    if (error) throw error;

    // No personalization signal yet — return everything for this period
    if (categories.length === 0 && domains.length === 0) {
      return res.json({ status: 'success', events: allEvents || [] });
    }

    // Filter: match if category matches radar_categories,
    // OR any tag loosely matches a domain keyword
    const filtered = (allEvents || []).filter(ev => {
      const evCat = (ev.category || '').toLowerCase();
      const aliasGroup = CATEGORY_ALIAS[evCat] || [evCat];
      const catMatch = aliasGroup.some(alias => categories.includes(alias));
      const tagMatch = (ev.tags || []).some(tag =>
        domains.some(domain =>
          domain.includes(tag.toLowerCase()) || tag.toLowerCase().includes(domain.split(' ')[0])
        )
      );
      return catMatch || tagMatch;
    });

    res.json({ status: 'success', events: filtered });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;