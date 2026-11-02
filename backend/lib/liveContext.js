'use strict';
const { getUsdIdrRate } = require('./currency');

// Lightweight keyword pre-filter — avoids hitting the currency lookup
// (cheap since it's Redis-cache-backed, but not free) on every single
// message regardless of topic. Same "cheap pre-filter before expensive
// work" principle already used in handler.js for file-intent detection.
const CURRENCY_KEYWORDS = /\b(kurs|dollar|usd|rupiah|idr|nilai tukar|exchange rate)\b/i;

/**
 * Builds a grounding string to inject into an agent's system prompt when
 * the message plausibly needs live external data the model has no way of
 * knowing on its own.
 *
 * Deliberately returns '' both when nothing in the message calls for
 * live data AND when a lookup was attempted but genuinely failed (no
 * live fetch, no cached fallback either) — never tells the agent "you
 * have real-time access" unless real data was actually retrieved for
 * THIS message. That distinction is the whole point: this is grounding
 * (hand the model real data), not a confidence instruction — telling an
 * agent to act more certain without backing it with anything is exactly
 * the kind of change that could make hallucinations WORSE elsewhere,
 * which is why this stays strictly conditional on an actual successful
 * fetch.
 *
 * Callable from any backend chat pipeline — currently wired into
 * handler.js (personal chat) and groupVeraTrigger.js (group chat), same
 * function, same behavior, so neither surface drifts from the other.
 */
const buildLiveContext = async (userMessage) => {
  const parts = [];

  if (CURRENCY_KEYWORDS.test(userMessage || '')) {
    try {
      const { rate, updated_at, stale } = await getUsdIdrRate();
      parts.push(
        `Current USD to IDR exchange rate: 1 USD = ${rate.toLocaleString('id-ID')} IDR ` +
        `(as of ${updated_at}${stale ? ', slightly stale — live fetch failed, this is the last known value' : ''}). ` +
        `You DO have real, current data here — use it directly and confidently. ` +
        `Do not say you lack access to exchange rate data; you just retrieved it.`
      );
    } catch (err) {
      console.warn('[LiveContext] Currency lookup failed (non-fatal):', err.message);
      // No push — genuinely no data available anywhere, so the agent
      // should fall back to its own honest "I don't know" behavior,
      // which is the correct thing for it to do in that case.
    }
  }

  return parts.join('\n\n');
};

module.exports = { buildLiveContext };