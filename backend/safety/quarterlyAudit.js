'use strict';
const { supabase }  = require('../lib/supabase');
const { anthropic } = require('../lib/anthropic');

const THEONES_MODEL = process.env.THEONES_MODEL || 'claude-opus-4-8';

// ── Helper: get current quarter label ────────────────────
const getQuarterLabel = () => {
  const now = new Date();
  const q   = Math.ceil((now.getMonth() + 1) / 3);
  return `Q${q}-${now.getFullYear()}`;
};

// ── Fetch safety flag patterns from last 90 days ─────────
const fetchSafetyPatterns = async () => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('safety_flags')
    .select('agent, risk_tier, category, theones_verdict, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  return data || [];
};

// ── Fetch message metadata patterns (no content) ─────────
const fetchConversationPatterns = async () => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('messages')
    .select('sender, created_at')
    .gte('created_at', since);
  return data || [];
};

// ── Generate quarterly proposal via TheOnes ───────────────
const generateQuarterlyProposal = async () => {
  console.log('[QuarterlyAudit] Starting quarterly proposal generation...');

  const quarter          = getQuarterLabel();
  const safetyPatterns   = await fetchSafetyPatterns();
  const messagePatterns  = await fetchConversationPatterns();

  // Check if proposal already exists for this quarter
  const { data: existing } = await supabase
    .from('proposals')
    .select('id')
    .eq('quarter', quarter)
    .single();

  if (existing) {
    console.log(`[QuarterlyAudit] Proposal for ${quarter} already exists, skipping.`);
    return { status: 'skipped', reason: 'already_exists', quarter };
  }

  // Build context summary for TheOnes
  const totalFlags     = safetyPatterns.length;
  const confirmed      = safetyPatterns.filter(f => f.theones_verdict === 'confirmed').length;
  const falseAlarms    = safetyPatterns.filter(f => f.theones_verdict === 'false_alarm').length;
  const pending        = safetyPatterns.filter(f => f.theones_verdict === 'pending').length;
  const byCategory     = safetyPatterns.reduce((acc, f) => {
    acc[f.category] = (acc[f.category] || 0) + 1;
    return acc;
  }, {});
  const byAgent        = safetyPatterns.reduce((acc, f) => {
    acc[f.agent] = (acc[f.agent] || 0) + 1;
    return acc;
  }, {});
  const totalMessages  = messagePatterns.length;
  const byDay          = messagePatterns.reduce((acc, m) => {
    const day = m.created_at.slice(0, 10);
    acc[day]  = (acc[day] || 0) + 1;
    return acc;
  }, {});
  const avgPerDay = totalMessages > 0
    ? (totalMessages / Math.max(Object.keys(byDay).length, 1)).toFixed(1)
    : 0;

  const contextSummary = `
QUARTERLY AUDIT DATA — ${quarter}

SAFETY FLAGS (last 90 days):
Total flags: ${totalFlags}
Confirmed: ${confirmed} | False alarms: ${falseAlarms} | Pending: ${pending}
By category: ${JSON.stringify(byCategory)}
By agent: ${JSON.stringify(byAgent)}

CONVERSATION PATTERNS:
Total messages: ${totalMessages}
Average messages per active day: ${avgPerDay}
Active days in period: ${Object.keys(byDay).length}
`.trim();

  try {
    const response = await anthropic.messages.create({
      model:      THEONES_MODEL,
      max_tokens: 4000,
      messages: [{
        role:    'user',
        content: `You are TheOnes, generating a quarterly system audit proposal for The Triangle platform.

${contextSummary}

Generate a structured proposal with exactly 4 sections. Each section should contain specific, actionable observations and recommendations based on the data above. Be honest — if the data shows no issues in a section, say so clearly.

Respond ONLY with valid JSON in this exact structure:
{
  "summary": "2-3 sentence overall assessment of the quarter",
  "safety_conduct": {
    "observations": ["observation 1", "observation 2"],
    "recommendations": ["recommendation 1", "recommendation 2"],
    "priority": "high | medium | low"
  },
  "api_news": {
    "observations": ["observation 1"],
    "recommendations": ["recommendation 1"],
    "priority": "high | medium | low"
  },
  "bug_function": {
    "observations": ["observation 1"],
    "recommendations": ["recommendation 1"],
    "priority": "high | medium | low"
  },
  "user_feedback": {
    "observations": ["No user feedback system active yet — this section will populate once AI Contact Support is live."],
    "recommendations": ["Prioritize building AI Contact Support to enable this section."],
    "priority": "low"
  }
}`
      }],
    });

    const raw   = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in TheOnes quarterly response');
    const parsed = JSON.parse(match[0]);

    // Save proposal to DB
    const { data: saved, error } = await supabase
      .from('proposals')
      .insert({
        quarter,
        status:           'pending',
        safety_conduct:   parsed.safety_conduct,
        api_news:         parsed.api_news,
        bug_function:     parsed.bug_function,
        user_feedback:    parsed.user_feedback,
        theones_summary:  parsed.summary,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[QuarterlyAudit] Proposal ${saved.id} generated for ${quarter}`);
    return {
      status:     'success',
      proposalId: saved.id,
      quarter,
      summary:    parsed.summary,
    };

  } catch (err) {
    console.error('[QuarterlyAudit] Error generating proposal:', err.message);
    return { status: 'error', message: err.message };
  }
};

// ── Update section approval status ────────────────────────
const updateProposalStatus = async (proposalId, sectionApprovals) => {
  const allApproved  = Object.values(sectionApprovals).every(v => v === 'approved');
  const allRejected  = Object.values(sectionApprovals).every(v => v === 'rejected');
  const overallStatus = allApproved ? 'approved'
    : allRejected ? 'rejected'
    : 'partially_approved';

  const { error } = await supabase
    .from('proposals')
    .update({
      status:      overallStatus,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', proposalId);

  if (error) throw error;
  return { status: 'success', overallStatus };
};

module.exports = { generateQuarterlyProposal, updateProposalStatus, getQuarterLabel };