'use strict';
/**
 * SAFETY CORE — Age Pattern Detector (Layer 2 of the hybrid age system)
 *
 * Layer 1 is the real birthdate collected at onboarding (see
 * OnboardingShell.tsx). This file is Layer 2: passive, ongoing pattern
 * monitoring that can catch a case where the birthdate was falsified.
 *
 * Deliberately does NOT do what most "age from text" approaches do —
 * no vibe/slang/tone/grammar-based guessing. Research on this specific
 * problem shows: (a) accuracy for the 18-year boundary specifically is
 * mediocre (~80%, i.e. roughly 1 in 5 wrong) even in the best studies,
 * worse across languages/dialects, and (b) tone/grammar/slang-based
 * signals are exactly the ones that carry the most bias against
 * non-native speakers and regional dialects. So this only looks for a
 * narrow set of near-factual signals (see DETECTOR_SYSTEM_PROMPT) and
 * treats everything else as noise.
 *
 * Cost control mirrors crisisDetector.js's shape: cheap Haiku prefilter
 * on every message, expensive Opus reasoning only for the ambiguous
 * "weak" signals that actually need judgment. "Strong" (explicit)
 * signals skip Opus entirely — there's nothing to reason about.
 *
 * Fail-safe direction is the OPPOSITE of crisisDetector.js on purpose.
 * For crisis detection, a missed real case is far worse than a false
 * alarm, so errors default to needs_review. Here, wrongly treating an
 * adult as a minor is the worse failure mode, and this signal is never
 * decisive on its own anyway — so errors default to no change at all.
 */
const { anthropic } = require('../lib/anthropic');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');

const HAIKU_MODEL   = 'claude-haiku-4-5-20251001';
const THEONES_MODEL = process.env.THEONES_MODEL || 'claude-opus-4-8';

const MAX_CHECKS         = 10;  // lifetime cap per user — hard cost ceiling
const FLAG_THRESHOLD     = 60;  // minor_confidence >= this -> flagged (review + nudge)
const CLEAR_THRESHOLD    = -60; // minor_confidence <= this -> adult_confirmed, stop checking
const STRONG_MINOR_DELTA = 80;
const STRONG_ADULT_DELTA = -80;

const TERMINAL_STATUSES = ['flagged', 'adult_confirmed', 'inconclusive'];

// ── Stage 1: Haiku prefilter ───────────────────────────────
const DETECTOR_SYSTEM_PROMPT =
  'You are an age-signal classifier. You are NOT trying to guess someone\'s age from tone, slang, ' +
  'emoji use, grammar, typos, or general "vibe" — those are unreliable and biased (especially against ' +
  'non-native speakers and regional dialects), so ignore all of that completely.\n\n' +
  'Only flag these specific, narrow signal types:\n\n' +
  '- explicit_statement: the person directly states their own age or birth year — either direction, ' +
  'stating they are a minor OR stating they are an adult/18+/a specific adult age.\n' +
  '- explicit_contradiction: the person states something mathematically impossible for an adult (a ' +
  'school-grade timeline that only works if they are currently a minor), or impossible for a minor ' +
  '(holding a job that legally requires being an adult).\n' +
  '- guardianship_constraint: the person describes being subject to a parent/guardian\'s CONTROL in a ' +
  'way an adult would not be — a curfew being enforced, a parent confiscating their device, needing ' +
  'permission to install an app. This is about control, NOT living situation — living with parents is ' +
  'completely normal at any adult age in Indonesia and must never be flagged on its own.\n' +
  '- independence_marker: the reverse — adult-level independence (paying their own rent/bills, ' +
  'managing their own household, being someone else\'s parent/guardian, signing their own legal or ' +
  'financial documents).\n\n' +
  'Signal strength:\n' +
  '- strong: explicit_statement or explicit_contradiction only — unambiguous by definition.\n' +
  '- weak: guardianship_constraint or independence_marker — plausible but needs deeper judgment, could ' +
  'have other explanations.\n' +
  '- none: nothing in the message matches any category above. This will be the vast majority of messages.\n\n' +
  'Respond ONLY with valid JSON: {"signal": "none"|"weak"|"strong", "direction": "minor"|"adult"|null, ' +
  '"category": "explicit_statement"|"explicit_contradiction"|"guardianship_constraint"|"independence_marker"|null}\n' +
  'If signal is none, direction and category must both be null.';

const detectAgeSignal = async (userMessage, userId = null) => {
  try {
    const response = await anthropic.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 60,
      system:     DETECTOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    logUsage({
      model:        HAIKU_MODEL,
      callType:     'age_pattern_detector',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const raw   = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in age detector response');
    const parsed = JSON.parse(match[0]);

    return {
      signal:    parsed.signal    || 'none',
      direction: parsed.direction || null,
      category:  parsed.category  || null,
    };
  } catch (err) {
    console.error('[AgePattern] Detector error:', err.message);
    return { signal: 'none', direction: null, category: null };
  }
};

// ── Stage 2: Opus reasons about a weak, ambiguous signal ───
const evaluateWeakSignal = async (userMessage, category, direction, priorConfidence, userId) => {
  try {
    const response = await anthropic.messages.create({
      model:      THEONES_MODEL,
      max_tokens: 150,
      messages: [{
        role:    'user',
        content:
          `You are reviewing a single message for a soft age-related signal, as part of a safety system ` +
          `that leans strongly against false positives. Wrongly treating an adult as a minor causes real ` +
          `harm; being slow to notice a genuine minor is the lesser cost here, because this signal type is ` +
          `never decisive on its own — it only nudges an ongoing, reversible estimate built from multiple ` +
          `observations over time.\n\n` +
          `Message: "${userMessage}"\n` +
          `Detected category: ${category} (direction: ${direction})\n` +
          `Current running estimate: ${priorConfidence} (scale -100 strongly-adult to +100 strongly-minor, 0 unknown)\n\n` +
          `Before treating this as real evidence, actively consider alternative explanations: could this be ` +
          `a teacher or tutor, a parent talking about their own child, someone who still lives with family ` +
          `(completely normal at any adult age in Indonesia), a cultural or dialect pattern, a non-native ` +
          `English speaker, sarcasm, or roleplay/fiction? If a plausible alternative exists, weight this ` +
          `signal down accordingly.\n\n` +
          `Respond ONLY with valid JSON: {"delta": <integer from -25 to 25>, "reason": "one sentence"}\n` +
          `Positive delta moves toward minor, negative moves toward adult. Use small values unless the ` +
          `signal is genuinely hard to explain another way.`
      }],
    });

    logUsage({
      model:        THEONES_MODEL,
      callType:     'age_pattern_escalation',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const raw    = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const match  = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in age escalation response');
    const parsed = JSON.parse(match[0]);

    return {
      delta:  Math.max(-25, Math.min(25, Number(parsed.delta) || 0)),
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error('[AgePattern] Escalation error:', err.message);
    return { delta: 0, reason: 'evaluation error, no change applied' };
  }
};

// ── Record helpers ──────────────────────────────────────────
const getOrCreateRecord = async (userId) => {
  const { data } = await supabase
    .from('age_pattern_signals')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (data) return data;

  const { data: created } = await supabase
    .from('age_pattern_signals')
    .insert({ user_id: userId })
    .select()
    .single();

  return created;
};

const clampConfidence = (n) => Math.max(-100, Math.min(100, n));

const applyEvidence = async (record, delta, category, reason) => {
  const nextConfidence = clampConfidence(record.minor_confidence + delta);
  const nextCheckCount = record.check_count + 1;

  let nextStatus;
  if (nextConfidence >= FLAG_THRESHOLD)       nextStatus = 'flagged';
  else if (nextConfidence <= CLEAR_THRESHOLD) nextStatus = 'adult_confirmed';
  else if (nextCheckCount >= MAX_CHECKS)      nextStatus = 'inconclusive';
  else                                        nextStatus = 'monitoring';

  const evidenceEntry = {
    at:               new Date().toISOString(),
    category,
    delta,
    reason,
    confidence_after: nextConfidence,
  };

  const { data: updated, error } = await supabase
    .from('age_pattern_signals')
    .update({
      minor_confidence: nextConfidence,
      check_count:       nextCheckCount,
      status:            nextStatus,
      last_category:     category,
      evidence_log:      [...(record.evidence_log || []), evidenceEntry].slice(-20),
      updated_at:        new Date().toISOString(),
    })
    .eq('user_id', record.user_id)
    .select()
    .single();

  if (error) console.error('[AgePattern] Failed to update record:', error.message);
  return updated || record;
};

// ── Main entry point — fire-and-forget from handler.js ─────
const checkAgePattern = async (userId, userMessage) => {
  try {
    const record = await getOrCreateRecord(userId);
    if (!record) return;

    // Terminal states or a human-reviewed verdict: stop checking entirely.
    // This is what keeps the lifetime cost bounded per user.
    if (TERMINAL_STATUSES.includes(record.status)) return;
    if (record.admin_verdict) return;

    const detected = await detectAgeSignal(userMessage, userId);
    if (detected.signal === 'none') return; // the overwhelming majority of messages stop here

    if (detected.signal === 'strong') {
      // explicit_statement / explicit_contradiction — unambiguous by
      // definition, skip Opus entirely and save the cost.
      const delta = detected.direction === 'minor' ? STRONG_MINOR_DELTA : STRONG_ADULT_DELTA;
      await applyEvidence(record, delta, detected.category, 'explicit signal, unambiguous by definition');
      return;
    }

    // Weak signal — needs Opus's judgment before it counts for anything.
    const { delta, reason } = await evaluateWeakSignal(
      userMessage, detected.category, detected.direction, record.minor_confidence, userId
    );
    if (delta !== 0) {
      await applyEvidence(record, delta, detected.category, reason);
    }
  } catch (err) {
    console.error('[AgePattern] checkAgePattern error:', err.message);
  }
};

// ── Does this user currently warrant the soft conversational nudge? ──
// Separate from (and a higher bar than) just being in the admin review
// queue — this only reflects the automatic, reversible in-conversation
// adjustment, not a human decision.
const shouldApplyMinorNudge = async (userId) => {
  try {
    const { data } = await supabase
      .from('age_pattern_signals')
      .select('status, admin_verdict')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) return false;
    if (data.admin_verdict === 'adult_confirmed') return false; // human already overrode this
    return data.status === 'flagged';
  } catch (err) {
    console.error('[AgePattern] shouldApplyMinorNudge error:', err.message);
    return false; // fail closed — same "don't wrongly restrict" bias as everywhere else here
  }
};

module.exports = { checkAgePattern, shouldApplyMinorNudge };