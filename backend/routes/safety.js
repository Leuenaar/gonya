'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken }       = require('../middleware/auth');
const { getCrisisResources } = require('../safety/crisisResources');

// GET /api/safety/resources?country=ID
router.get('/resources', verifyToken, async (req, res) => {
  try {
    const country   = (req.query.country || 'ID').toUpperCase();
    const resources = getCrisisResources(country);
    res.json({ status: 'success', data: resources });
  } catch (err) {
    console.error('[Safety Route] /resources error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;