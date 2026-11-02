'use strict';
const { tavily } = require('@tavily/core');
const { createRotator, collectApiKeys } = require('./apiKeyRotator');

// Preferred .env format is now numbered vars (TAVILY_API_KEY_1,
// TAVILY_API_KEY_2, ...) — collectApiKeys() also still falls back to the
// older comma-separated TAVILY_API_KEYS, so nothing breaks if this
// hasn't been migrated to the numbered format yet (24 Aug 2026, ".env
// kerapihan" cleanup).
const keys = collectApiKeys('TAVILY');

if (keys.length === 0) {
  throw new Error('[Tavily] Missing TAVILY_API_KEYS in .env');
}

// Tavily's SDK doesn't document a status code as consistently as Groq's —
// being conservative here: only rotate on something that actually looks
// like a rate/usage limit, so a malformed query or a real outage doesn't
// get masked by silently trying every key (which would just fail the same
// way on all of them and hide the real error behind rotation noise).
const isRateLimitError = (err) =>
  err?.status === 429 || /rate.?limit|usage.?limit|quota/i.test(err?.message || '');

// Fix (24 Aug 2026, same reasoning as groq.js): a 401 is inherently a
// per-key credential problem, not something that fails the same way on
// every key — rotation should try the next one, not give up entirely.
const isInvalidKeyError = (err) => err?.status === 401;

// Tavily doesn't return a precise "try again in Xs" hint the way Groq
// does, so this uses a flat, reasonably conservative cooldown window
// instead of guessing at parsing something that isn't there.
const parseRetryAfterMs = () => 30000;

const rotator = createRotator(
  keys,
  (key) => tavily({ apiKey: key }),
  isRateLimitError,
  parseRetryAfterMs,
  { isInvalidKeyError }
);

console.log(`[Tavily] ${keys.length} API key(s) configured${keys.length > 1 ? ' for rotation' : ''}.`);

const tavilyClient = {
  // Same call shape every existing caller already uses
  // (lib/tools/webSearch.js) — rotation is fully transparent, no other
  // file needs to change.
  search: (query, options) => rotator.callWithRotation((client) => client.search(query, options)),
};

module.exports = { tavilyClient };
