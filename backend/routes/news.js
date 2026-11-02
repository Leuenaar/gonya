'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { fetchNewsForUser, fetchRadarNewsForUser } = require('../lib/news');

// GET /api/news/macro?categories=Business,Technology
router.get('/macro', verifyToken, async (req, res) => {
  try {
    const categories = req.query.categories
      ? req.query.categories.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    // Always need the profile now — language drives which sources get
    // used, not just the radar_categories fallback.
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('language, radar_categories')
      .eq('id', req.userId)
      .single();

    if (categories.length === 0) {
      if (profile?.radar_categories?.length > 0) {
        categories.push(...profile.radar_categories);
      } else {
        categories.push('Technology', 'Business');
      }
    }

    const news = await fetchNewsForUser(profile?.language, categories);
    res.json({ status: 'success', data: news });

  } catch (err) {
    console.error('[News] /macro error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/news/radar
router.get('/radar', verifyToken, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('language')
      .eq('id', req.userId)
      .single();

    // Get user domain + custom sources
    const { data: config } = await supabase
      .from('agent_configs')
      .select('domain')
      .eq('user_id', req.userId)
      .limit(1)
      .single();

    const { data: sources } = await supabase
      .from('user_news_sources')
      .select('*')
      .eq('user_id', req.userId);

    const domain = config?.domain || '';
    const news   = await fetchRadarNewsForUser(profile?.language, domain, sources || []);

    res.json({ status: 'success', data: news });

  } catch (err) {
    console.error('[News] /radar error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/news/sources
router.get('/sources', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_news_sources')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ status: 'success', data: data || [] });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/news/sources
router.post('/sources', verifyToken, async (req, res) => {
  const { name, url, category } = req.body;

  if (!name?.trim() || !url?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Name and URL required' });
  }

  try {
    const { data, error } = await supabase
      .from('user_news_sources')
      .insert([{
        user_id:  req.userId,
        name:     name.trim(),
        url:      url.trim(),
        category: category?.trim() || 'Custom',
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', data });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/news/sources/:id
router.delete('/sources/:id', verifyToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('user_news_sources')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ status: 'success' });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/news/categories — update user radar categories
router.patch('/categories', verifyToken, async (req, res) => {
  const { categories } = req.body;

  if (!Array.isArray(categories)) {
    return res.status(400).json({ status: 'error', message: 'Categories must be an array' });
  }

  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ radar_categories: categories })
      .eq('id', req.userId)
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', data });

  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;