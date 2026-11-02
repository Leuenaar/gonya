'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken }   = require('../middleware/auth');
const { getUsdIdrRate } = require('../lib/currency');

// Logic (fetch + Redis cache + stale fallback) moved to lib/currency.js
// (capability audit, 25 Jul 2026) so it's callable from backend code
// directly (lib/liveContext.js) as well as from this HTTP route — same
// response shape as before, unchanged from the client's perspective.

// GET /api/currency/usd-idr
router.get('/usd-idr', verifyToken, async (req, res) => {
  try {
    const data = await getUsdIdrRate();
    res.json({ status: 'success', ...data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;