'use strict';
// ---------------------------------------------------------------------------
// Generic multi-key rotation helper — shared by lib/groq.js, lib/tavily.js,
// lib/deepgram.js, and voice/voiceSession.js's STT rotation so the actual
// rotation LOGIC lives in one tested place. Provider-specific bits (how to
// build a client from a key, how to recognize a rate-limit error, how long
// to cool that key down for) are passed in by the caller.
//
// Behavior: tries keys in order starting from whichever one last worked
// (not always restarting at key #1 — a key that's fine stays "sticky").
// A key that hits a rate limit gets skipped for a cooldown window (parsed
// from the provider's own error when possible) instead of being retried
// immediately. A key that's genuinely INVALID (revoked, mistyped, wrong
// key entirely) is now ALSO skipped and rotation moves to the next key —
// this is a per-key problem, not something that would fail identically
// on every key the way a malformed request would, so there's no reason
// to let one bad key take down the whole rotation (bug fixed 24 Aug 2026,
// after exactly this happened: key #1/10 was invalid, rotation gave up
// immediately instead of trying the 9 perfectly good keys behind it).
// Any OTHER error that isn't a rate limit, invalid key, or a per-attempt
// timeout is NOT retried on another key — it's thrown straight back,
// since a bad request/payload will just fail the same way on every key.
//
// perAttemptTimeoutMs (optional): caps how long ANY SINGLE key's attempt
// is allowed to take. Without this, keys are tried sequentially with no
// individual budget — if key #1 happens to be slow (not necessarily
// rate-limited, just slow), it can eat most or all of whatever timeout
// the CALLER wraps the whole rotation in, leaving little to no time for
// keys #2/#3 to even get a fair shot. This makes each key's slice of time
// predictable and bounded, so a slow key costs at most this long before
// rotation moves on — the total worst case across N keys is then
// N × perAttemptTimeoutMs, not "whatever's left of one shared clock after
// however long earlier keys happened to take."
// ---------------------------------------------------------------------------

function createRotator(keys, buildClient, isRateLimitError, parseRetryAfterMs, options = {}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('createRotator: at least one API key is required.');
  }

  const perAttemptTimeoutMs = options.perAttemptTimeoutMs || null;
  const isInvalidKeyError   = options.isInvalidKeyError || (() => false); // default: nothing extra classified this way — fully backward compatible for callers that don't pass it
  const invalidKeyCooldownMs = options.invalidKeyCooldownMs || 60 * 60 * 1000; // 1h — a genuinely invalid key won't fix itself on retry the way a rate limit does, so this just stops hammering it on every future call within this process's lifetime, not a "try again soon" guess
  const clients        = keys.map(buildClient);
  const cooldownUntil  = new Array(keys.length).fill(0);
  let preferredIndex   = 0;

  function withPerAttemptTimeout(promise, idx) {
    if (!perAttemptTimeoutMs) return promise;
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Key #${idx + 1}/${keys.length} timed out after ${perAttemptTimeoutMs}ms`)),
        perAttemptTimeoutMs
      );
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
  }

  async function callWithRotation(attemptFn) {
    let lastErr;
    let triedAny = false;

    for (let i = 0; i < keys.length; i++) {
      const idx = (preferredIndex + i) % keys.length;
      if (Date.now() < cooldownUntil[idx]) continue; // still cooling down — skip without trying
      triedAny = true;
      const attemptStart = Date.now();

      try {
        const result = await withPerAttemptTimeout(attemptFn(clients[idx]), idx);
        preferredIndex = idx; // stick with a key that just worked
        console.log(`[APIKeyRotator] Key #${idx + 1}/${keys.length} succeeded in ${Date.now() - attemptStart}ms`);
        return result;
      } catch (err) {
        lastErr = err;
        const elapsed = Date.now() - attemptStart;
        const isTimeout = /timed out after \d+ms/.test(err?.message || '');

        if (isRateLimitError(err)) {
          const cooldownMs = parseRetryAfterMs(err);
          cooldownUntil[idx] = Date.now() + cooldownMs;
          console.warn(
            `[APIKeyRotator] Key #${idx + 1}/${keys.length} rate-limited after ${elapsed}ms, ` +
            `cooling down ~${Math.round(cooldownMs / 1000)}s, trying next key...`
          );
          continue;
        }

        if (isInvalidKeyError(err)) {
          cooldownUntil[idx] = Date.now() + invalidKeyCooldownMs;
          console.warn(
            `[APIKeyRotator] Key #${idx + 1}/${keys.length} appears INVALID after ${elapsed}ms ` +
            `(${err.message}) — skipping for ~${Math.round(invalidKeyCooldownMs / 3600000)}h, trying next key...`
          );
          continue;
        }

        if (isTimeout) {
          // Slow, but not necessarily exhausted — a short cooldown avoids
          // immediately re-trying the same slow key on the VERY next
          // request too, without assuming it's out of quota the way a
          // real rate-limit response implies.
          const shortCooldownMs = Math.min(perAttemptTimeoutMs, 5000);
          cooldownUntil[idx] = Date.now() + shortCooldownMs;
          console.warn(
            `[APIKeyRotator] ${err.message} — trying next key ` +
            `(brief ${Math.round(shortCooldownMs / 1000)}s cooldown on this one)...`
          );
          continue;
        }

        console.warn(`[APIKeyRotator] Key #${idx + 1}/${keys.length} failed after ${elapsed}ms with a non-retryable error:`, err.message);
        throw err; // not a rate-limit or timeout — don't rotate, fail immediately
      }
    }

    // Every key is either cooling down or just failed.
    if (!triedAny) {
      throw new Error('[APIKeyRotator] All API keys are currently cooling down from rate limits.');
    }
    throw lastErr;
  }

  return { callWithRotation };
}

// ---------------------------------------------------------------------------
// collectApiKeys(prefix) — reads a provider's API key(s) from .env,
// supporting three formats in priority order (24 Aug 2026, ".env
// kerapihan" cleanup ahead of listing this as a product demo):
//
// 1. Numbered vars — PREFIX_API_KEY_1, PREFIX_API_KEY_2, ... up to
//    MAX_NUMBERED_KEYS. PREFERRED format going forward: each key is its
//    own clearly-named line, easy to comment out individually, no
//    fragile comma-splitting of secrets crammed onto one long line.
// 2. Comma-separated — PREFIX_API_KEYS=key1,key2,key3 (the older
//    multi-key format used before this cleanup).
// 3. Single — PREFIX_API_KEY=key1 (the original, single-key format from
//    before rotation existed at all).
//
// Falls through to the next format only if the preferred one has ZERO
// keys — this means each provider's .env vars can be migrated to the
// numbered format independently, not all at once, without breaking
// anything still on an older format in the meantime.
// ---------------------------------------------------------------------------
const MAX_NUMBERED_KEYS = 20;

function collectApiKeys(prefix) {
  const numbered = [];
  for (let i = 1; i <= MAX_NUMBERED_KEYS; i++) {
    const val = process.env[`${prefix}_API_KEY_${i}`];
    if (val && val.trim()) numbered.push(val.trim());
  }
  if (numbered.length > 0) return numbered;

  const commaSeparated = (process.env[`${prefix}_API_KEYS`] || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (commaSeparated.length > 0) return commaSeparated;

  const single = process.env[`${prefix}_API_KEY`];
  return single && single.trim() ? [single.trim()] : [];
}

module.exports = { createRotator, collectApiKeys };
