'use strict';
const { redis } = require('./redis');

// Extracted from routes/currency.js (Phase: capability audit, 25 Jul 2026) —
// same cache key, same TTL, same fetch source, same stale-fallback logic,
// unchanged. Moved here so it can be called directly from backend code
// (lib/liveContext.js) as well as from the HTTP route, without the lib
// having to make a self-HTTP-call back into its own API.
const CACHE_KEY = 'currency:usd_idr';
const CACHE_TTL = 60 * 30; // 30 menit

/**
 * Returns { rate, updated_at, cached, stale? }.
 * Throws only if there's no live data AND no cached fallback at all —
 * callers (route or liveContext) decide how to handle that.
 */
const getUsdIdrRate = async () => {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return { ...JSON.parse(cached), cached: true };

  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!response.ok) throw new Error('Exchange rate API unavailable');

    const json = await response.json();
    const rate = json.rates?.IDR;
    if (!rate) throw new Error('IDR rate not found');

    const payload = {
      rate:       Math.round(rate),
      updated_at: new Date().toISOString(),
    };

    await redis.set(CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL);
    return { ...payload, cached: false };
  } catch (err) {
    const fallback = await redis.get(CACHE_KEY);
    if (fallback) return { ...JSON.parse(fallback), cached: true, stale: true };
    throw err;
  }
};

module.exports = { getUsdIdrRate };