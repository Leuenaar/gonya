'use strict';
const Groq = require('groq-sdk');
const { createRotator, collectApiKeys } = require('./apiKeyRotator');

// Supports multiple keys for automatic rotation when one hits a rate
// limit. Preferred .env format is now numbered vars (GROQ_API_KEY_1,
// GROQ_API_KEY_2, ...) — collectApiKeys() also still falls back to the
// older comma-separated GROQ_API_KEYS and the original singular
// GROQ_API_KEY, so nothing breaks if this hasn't been migrated to the
// numbered format yet (24 Aug 2026, ".env kerapihan" cleanup).
const keys = collectApiKeys('GROQ');

if (keys.length === 0) {
  throw new Error('[Groq] Missing GROQ_API_KEY or GROQ_API_KEYS in .env');
}

const isRateLimitError = (err) => err?.status === 429;

// Fix (24 Aug 2026): a 401 "invalid_api_key" used to be treated as a
// non-retryable environmental error (thrown immediately, no rotation) —
// but that's wrong for THIS error specifically, since an invalid key is
// a PER-KEY problem, not something that fails identically regardless of
// which key is used. Confirmed in production: key #1/10 was invalid,
// rotation gave up instead of trying the 9 good keys behind it.
const isInvalidKeyError = (err) => err?.status === 401;

// Groq's own error message includes a hint like "Please try again in
// 2.445s" — parsed out so a rate-limited key cools down for roughly the
// right amount of time instead of a blind fixed guess. Falls back to 30s
// if that hint isn't present for some reason.
const parseRetryAfterMs = (err) => {
  const match = /try again in ([\d.]+)s/i.exec(err?.message || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : 30000;
};

const rotator = createRotator(
  keys,
  (key) => new Groq({ apiKey: key }),
  isRateLimitError,
  parseRetryAfterMs,
  // Each key gets its own 5s budget — a slow/hanging key costs at most
  // this long before rotation moves to the next one, instead of one slow
  // key silently eating most of whatever timeout the CALLER wraps the
  // whole rotation sequence in (voice/voiceGenerate.js's own timeout is
  // sized to accommodate the full worst case across however many keys
  // are configured, see the comment there).
  { perAttemptTimeoutMs: 5000, isInvalidKeyError }
);

console.log(`[Groq] ${keys.length} API key(s) configured${keys.length > 1 ? ' for rotation' : ''}.`);

const groq = {
  chat: {
    completions: {
      // Same call shape every existing caller already uses
      // (handler.js, voiceGenerate.js, groupJudge.js, groupAkselTrigger.js,
      // groupIdleTrigger.js, memoryExtractor.js) — rotation is fully
      // transparent to all of them, no other file needs to change.
      // Works for both streaming (`stream:true`) and non-streaming calls:
      // a rate limit always fails at this initial call, before any
      // streaming begins, so rotation catches it the same way either way.
      create: (body) => rotator.callWithRotation((client) => client.chat.completions.create(body)),
    },
  },
};

module.exports = { groq };
