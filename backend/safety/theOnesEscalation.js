'use strict';
const { anthropic } = require('../lib/anthropic');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');

const THEONES_MODEL        = process.env.THEONES_MODEL || 'claude-opus-4-8';
const RATE_LIMIT_MAX       = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ── Rate limiter (in-memory, per user per hour) ───────────
const rateLimitStore = new Map();

const checkRateLimit = (userId) => {
  const now    = Date.now();
  const record = rateLimitStore.get(userId) || { count: 0, windowStart: now };

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count       = 0;
    record.windowStart = now;
  }

  if (record.count >= RATE_LIMIT_MAX) return false;

  record.count++;
  rateLimitStore.set(userId, record);
  return true;
};

// ── Log flag to safety_flags table ───────────────────────
// `category` can legitimately be null — crisisDetector.js's own fail-safe
// path (when its API call itself errors, e.g. an upstream billing/credit
// issue) returns { risk: 'needs_review', category: null } ON PURPOSE, so
// a detector failure never gets silently dropped as "risk: none". But the
// safety_flags.category column is NOT NULL, so inserting that null value
// straight through just fails the DB write — which is worse than skipping
// it, since a failed insert also silently drops the record (just with an
// extra confusing error in between). Guarded here once, at the single
// place that actually writes to the table, so every caller (there are
// three) is covered without each one needing its own check.
const logFlag = async (userId, agentName, riskTier, category, verdict) => {
  if (!category) {
    console.warn(
      `[SafetyCore] Skipping safety_flags insert for user ${userId} — category is null/undefined ` +
      `(the detector itself likely failed upstream, e.g. an API/billing error) and that column doesn't ` +
      `allow NULL. Logged here so this isn't silently lost, but no DB row was written for this flag.`
    );
    return;
  }
  const { error } = await supabase.from('safety_flags').insert({
    user_id:         userId,
    agent:           agentName,
    risk_tier:       riskTier,
    category:        category,
    theones_verdict: verdict || 'pending',
  });
  if (error) console.error('[SafetyCore] Failed to log flag:', error.message);
};

// ── TheOnes escalation for needs_review cases ─────────────
const escalateToTheOnes = async (userId, agentName, userMessage, detectorResult) => {
  const allowed = checkRateLimit(userId);

  if (!allowed) {
    console.warn(`[SafetyCore] Rate limit hit for user ${userId} — skipping TheOnes escalation`);
    await logFlag(userId, agentName, detectorResult.risk, detectorResult.category, 'pending');
    return {
      action:        'fallback',
      rateLimited:   true,
      safetySupport: false,
    };
  }

  try {
    const response = await anthropic.messages.create({
      model:      THEONES_MODEL,
      max_tokens: 150,
      messages: [{
        role:    'user',
        content:
          `You are a safety reviewer inside a confidential safety system. A lightweight classifier flagged this message as needing a deeper review.\n\n` +
          `Message: "${userMessage}"\n` +
          `Flagged category: ${detectorResult.category}\n\n` +
          `Your job is to decide: is this a genuine safety concern requiring intervention, or a false alarm?\n\n` +
          `Two principles you must follow without exception:\n` +
          `1. Evaluate this message with fresh eyes, on its own merits. Do not assume that because a similar pattern appeared safe before, this one is too. Context and personal circumstances can change drastically even when surface wording looks the same. A message that was a false alarm last week may be a real crisis today.\n` +
          `2. When genuinely uncertain, lean toward confirmed rather than false_alarm. The cost of missing a real case is far higher than the cost of an unnecessary intervention.\n\n` +
          `Respond ONLY with valid JSON: {"verdict": "confirmed" | "false_alarm", "reason": "one sentence"}`
      }],
    });

    logUsage({
      model:        THEONES_MODEL,
      callType:     'theones_escalation',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const raw    = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in TheOnes escalation response');
    const parsed = JSON.parse(match[0]);

    const verdict      = parsed.verdict === 'confirmed' ? 'confirmed' : 'false_alarm';
    const isCrisis     = detectorResult.category === 'crisis';
    const needsSupport = verdict === 'confirmed' && isCrisis;

    await logFlag(userId, agentName, detectorResult.risk, detectorResult.category, verdict);

    console.log(`[SafetyCore] TheOnes verdict: ${verdict} (${detectorResult.category}) for user ${userId}`);

    return {
      action:        verdict === 'confirmed' ? 'intervene' : 'pass',
      verdict,
      safetySupport: needsSupport,
      rateLimited:   false,
    };

  } catch (err) {
    console.error('[SafetyCore] TheOnes escalation error:', err.message);
    await logFlag(userId, agentName, detectorResult.risk, detectorResult.category, 'pending');
    return {
      action:        'intervene',
      verdict:       'error',
      safetySupport: detectorResult.category === 'crisis',
      rateLimited:   false,
    };
  }
};

// ── Handle high-risk (no TheOnes needed) ─────────────────
const handleHighRisk = async (userId, agentName, detectorResult) => {
  await logFlag(userId, agentName, detectorResult.risk, detectorResult.category, 'confirmed');

  logUsage({
    model:        THEONES_MODEL,
    callType:     'theones_high_risk',
    inputTokens:  0,
    outputTokens: 0,
    userId,
  });

  console.log(`[SafetyCore] High risk confirmed — category: ${detectorResult.category}, user: ${userId}`);
  return {
    action:        'intervene',
    verdict:       'confirmed',
    safetySupport: detectorResult.category === 'crisis',
    rateLimited:   false,
  };
};

module.exports = { escalateToTheOnes, handleHighRisk };