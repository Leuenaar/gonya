'use strict';
const { supabase } = require('./supabase');

// ── Pricing per 1M tokens (as of Jun 2026) ───────────────
// Update these when Anthropic/Groq change pricing.
const PRICING = {
  'claude-opus-4-8':           { input: 15.00,  output: 75.00  },
  'claude-sonnet-4-6':         { input: 3.00,   output: 15.00  },
  'claude-haiku-4-5-20251001': { input: 0.80,   output: 4.00   },
  'llama-3.3-70b-versatile':   { input: 0.00,   output: 0.00   },
};

const calcCost = (model, inputTokens, outputTokens) => {
  const p = PRICING[model];
  if (!p) return 0;
  return ((inputTokens * p.input) + (outputTokens * p.output)) / 1_000_000;
};

/**
 * Log a single API call with token counts.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * @param {object} opts
 * @param {string}      opts.model
 * @param {string}      opts.callType   e.g. 'chat_vera', 'safety_detector', 'theones_escalation'
 * @param {number}      opts.inputTokens
 * @param {number}      opts.outputTokens
 * @param {string|null} [opts.userId]
 */
const logUsage = async ({ model, callType, inputTokens, outputTokens, userId = null }) => {
  try {
    await supabase.from('usage_logs').insert({
      model,
      call_type:     callType,
      input_tokens:  inputTokens  || 0,
      output_tokens: outputTokens || 0,
      user_id:       userId || null,
    });
  } catch (err) {
    console.warn('[UsageLogger] Failed to log usage:', err.message);
  }
};

/**
 * Get aggregated usage and cost for a time window.
 *
 * @param {'month'|'week'|'day'} period
 * @returns {Promise<object>} stats by model with token counts and USD cost
 */
const getUsageStats = async (period = 'month') => {
  const intervals = { month: 30, week: 7, day: 1 };
  const days      = intervals[period] || 30;
  const since     = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('usage_logs')
    .select('model, call_type, input_tokens, output_tokens')
    .gte('created_at', since);

  if (error || !data) return { byModel: {}, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 };

  const byModel = {};
  let totalCostUsd       = 0;
  let totalInputTokens   = 0;
  let totalOutputTokens  = 0;

  for (const row of data) {
    if (!byModel[row.model]) {
      byModel[row.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
    }
    const entry = byModel[row.model];
    entry.inputTokens  += row.input_tokens;
    entry.outputTokens += row.output_tokens;
    entry.calls        += 1;
    const cost          = calcCost(row.model, row.input_tokens, row.output_tokens);
    entry.costUsd      += cost;
    totalCostUsd       += cost;
    totalInputTokens   += row.input_tokens;
    totalOutputTokens  += row.output_tokens;
  }

  return { byModel, totalCostUsd, totalInputTokens, totalOutputTokens };
};

module.exports = { logUsage, getUsageStats, calcCost, PRICING };