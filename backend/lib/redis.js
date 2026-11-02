'use strict';
require('dotenv').config();
const { Redis } = require('ioredis');

if (!process.env.REDIS_URL) {
  throw new Error('[Redis] Missing REDIS_URL in .env');
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

module.exports = { redis };