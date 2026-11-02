'use strict';
/**
 * Lightweight in-memory rate limiter — same shape as the one already used
 * for TheOnes escalation in safety/theOnesEscalation.js, generalized into
 * reusable Express middleware.
 *
 * Limitation to be aware of: state lives in memory, so it resets on every
 * server restart and does NOT share state across multiple server
 * instances. Fine for a single-process VPS deploy (which is the current
 * plan). If this ever scales to multiple instances behind a load
 * balancer, this would need a shared store instead (Upstash Redis, which
 * is already part of the stack, would be the natural choice).
 */

const createRateLimiter = ({ windowMs, max, keyFn, message }) => {
  const store = new Map();

  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next(); // no identifiable actor — fail open, don't block

    const now    = Date.now();
    const record = store.get(key) || { count: 0, windowStart: now };

    if (now - record.windowStart > windowMs) {
      record.count       = 0;
      record.windowStart = now;
    }

    if (record.count >= max) {
      const retryInMs = windowMs - (now - record.windowStart);
      res.set('Retry-After', String(Math.ceil(retryInMs / 1000)));
      return res.status(429).json({
        status:  'error',
        message: message || 'Too many requests — please slow down and try again shortly.',
      });
    }

    record.count++;
    store.set(key, record);
    next();
  };
};

// Per-user limiter for authenticated routes. Relies on req.userId being
// set already — verifyToken (or equivalent) must run BEFORE this in the
// middleware chain. Falls back to IP if userId isn't present for some reason.
const perUserLimiter = (windowMs, max, message) =>
  createRateLimiter({
    windowMs,
    max,
    keyFn:   (req) => req.userId || req.ip,
    message,
  });

// Per-IP limiter for routes that run before authentication exists yet
// (login, signup, OTP, password reset, etc).
const perIpLimiter = (windowMs, max, message) =>
  createRateLimiter({
    windowMs,
    max,
    keyFn:   (req) => req.ip,
    message,
  });

module.exports = { createRateLimiter, perUserLimiter, perIpLimiter };

// ── Programmatic limiter (non-middleware) ─────────────────────────────────
// Used inside the group chat pipeline where there's no req/res object.
// Returns true if the call is allowed, false if rate-limited.
const createProgrammaticLimiter = ({ windowMs, max }) => {
  const store = new Map();

  return (key) => {
    const now    = Date.now();
    const record = store.get(key) || { count: 0, windowStart: now };

    if (now - record.windowStart > windowMs) {
      record.count       = 0;
      record.windowStart = now;
    }

    if (record.count >= max) return false;

    record.count++;
    store.set(key, record);
    return true;
  };
};

// 20 Vera calls per hour per group — matches the Phase 8 spec.
const veraGroupLimiter = createProgrammaticLimiter({
  windowMs: 60 * 60 * 1000,
  max:      20,
});

module.exports = { createRateLimiter, perUserLimiter, perIpLimiter, veraGroupLimiter };