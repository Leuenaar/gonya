'use strict';
const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/supabase');

router.get('/', async (req, res) => {
  const checks = { server: true, database: false };

  try {
    const { error } = await supabase.from('user_profiles').select('id').limit(1);
    checks.database = !error;
  } catch {}

  const allOk = Object.values(checks).every(Boolean);

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'success' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
    version:   '1.0.0'
  });
});

router.get('/ping', (_, res) => {
  res.json({ status: 'success', message: 'pong', timestamp: new Date().toISOString() });
});

module.exports = router;