'use strict';
const { DeepgramClient } = require('@deepgram/sdk');
const { createRotator, collectApiKeys } = require('./apiKeyRotator');

// Same pattern as groq.js/tavily.js. This client is used for TTS only
// (speak.v1.audio.generate()) — STT connects via raw `ws` directly in
// voice/voiceSession.js (see the note there for why: the SDK's own
// listen.v1.connect() has a confirmed bug), so STT has its OWN separate
// rotation setup in that file, not through this client. Preferred .env
// format is now numbered vars (DEEPGRAM_API_KEY_1, DEEPGRAM_API_KEY_2,
// ...) — collectApiKeys() also still falls back to the older
// comma-separated DEEPGRAM_API_KEYS and the original singular
// DEEPGRAM_API_KEY (24 Aug 2026, ".env kerapihan" cleanup).
const keys = collectApiKeys('DEEPGRAM');

if (keys.length === 0) {
  throw new Error('[Deepgram] Missing DEEPGRAM_API_KEY or DEEPGRAM_API_KEYS in .env');
}

const isRateLimitError = (err) =>
  err?.status === 429 || /rate.?limit/i.test(err?.message || '');

// Fix (24 Aug 2026, same reasoning as groq.js/tavily.js): 401 is a
// per-key credential problem, rotation should try the next key instead
// of giving up on the whole request.
const isInvalidKeyError = (err) => err?.status === 401;

// Deepgram doesn't return a precise "try again in Xs" hint the way Groq
// does, so this uses a flat, reasonably conservative cooldown window
// instead of guessing at parsing something that isn't there.
const parseRetryAfterMs = () => 30000;

const rotator = createRotator(
  keys,
  (key) => new DeepgramClient({ apiKey: key }),
  isRateLimitError,
  parseRetryAfterMs,
  // TTS generation for one sentence should be fast (sub-second typically)
  // — an 8s budget per key is already generous, and keeps one bad key
  // from stalling a whole sentence's worth of the conversation.
  { perAttemptTimeoutMs: 8000, isInvalidKeyError }
);

console.log(`[Deepgram] ${keys.length} API key(s) configured${keys.length > 1 ? ' for rotation' : ''} (TTS).`);

// Same call shape voice/voiceSession.js's ttsAndSend() already uses —
// rotation is fully transparent, that function needs zero changes.
const deepgram = {
  speak: {
    v1: {
      audio: {
        generate: (body) => rotator.callWithRotation((client) => client.speak.v1.audio.generate(body)),
      },
    },
  },
};

module.exports = { deepgram };