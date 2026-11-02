'use strict';
/**
 * Aksel-as-Judge — Group Chat Arbitration (Phase 8.2, Step 2.3)
 *
 * Every message sent to a group chat passes through this classifier.
 * Aksel (Groq/Llama, cheap and fast) reads the last N messages and
 * decides what to do. Four possible verdicts:
 *
 *   SILENT        — humans are talking, agents stay out
 *   RESPOND_AKSEL — Aksel handles it directly (execution, quick answers)
 *   TRIGGER_VERA  — Aksel defers to Vera (research, depth, analysis)
 *   BATCH_PENDING — multiple messages arriving fast, wait for more
 *                   before deciding (batching window, see Step 2.5)
 *
 * Explicit @mention handling (added after a live bug: "Hi @vera" was
 * classified SILENT because the old single prompt asked the model to
 * weigh "mentions are a strong signal" against "casual greetings are
 * SILENT" at the same time, for the same message — a genuinely
 * ambiguous instruction, not a model-capability problem). A mention of
 * exactly one agent is not a judgment call, so it's no longer one:
 * detectExplicitMention() below decides it deterministically in code,
 * bypassing the Groq call entirely — cheaper and cannot be second-
 * guessed by the model. The judge prompt below no longer mentions
 * @mentions at all, so there is nothing left for it to weigh against
 * "casual banter → SILENT". A message that mentions BOTH agents is
 * treated as a genuine judgment call and still goes to the judge.
 *
 * Cost profile: this runs on every message but it's a tiny Groq call
 * (~50-100 tokens in, ~20 tokens out) — and now only runs at all when
 * there's no unambiguous explicit mention. Vera (expensive Sonnet) only
 * fires when this judge explicitly says TRIGGER_VERA.
 */
const { groq }       = require('../lib/groq');
const { logUsage }   = require('../lib/usageLogger');

const JUDGE_MODEL = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile deprecated by Groq (announced 17 Jun 2026) — this is Groq's own recommended replacement
const CONTEXT_WINDOW = 8; // last N messages sent to the judge

const JUDGE_SYSTEM =
  'You are Aksel, the COO-persona AI in a group chat. Your only job RIGHT NOW is ' +
  'to decide whether an AI agent should respond to the latest message. You are NOT ' +
  'generating the actual response — that happens separately.\n\n' +
  'Read the conversation context and the latest message, then output EXACTLY ONE of ' +
  'these four tokens and nothing else:\n\n' +
  'SILENT        — humans are having a conversation, no agent input needed\n' +
  'RESPOND_AKSEL — a direct, practical, or execution-focused question that you ' +
  '               (Aksel) can handle well and quickly\n' +
  'TRIGGER_VERA  — a research, analysis, or depth-heavy question that warrants ' +
  '               Vera (Claude Sonnet) being called in\n' +
  'BATCH_PENDING — the conversation is moving fast and it makes more sense to ' +
  '               wait for more messages before deciding\n\n' +
  'Rules:\n' +
  '- Default to SILENT unless there is a clear, specific question or request ' +
  '  directed at the AI agents or the group as a whole.\n' +
  '- Casual banter, acknowledgements ("ok", "got it", "thanks"), or messages ' +
  '  that are clearly addressed to a specific human → SILENT.\n' +
  '- If the group\'s agent_config contains specific triggers for Aksel or Vera, ' +
  '  use those to sharpen your routing decision.\n' +
  '- A message that directly asks an agent something using their bare name ' +
  '  (no @ symbol) — e.g., "vera berapa harga dollar sekarang?", "aksel bisa ' +
  '  bantu gak?" — should route to that agent, same as an explicit @mention. ' +
  '  Only treat the name as a passing reference, not a direct address, if the ' +
  '  sentence is clearly talking ABOUT the agent to the other humans rather ' +
  '  than asking them something right now.\n\n' +
  'Examples for the gray zone (no explicit @mention, so this is genuinely a ' +
  'judgment call):\n' +
  '  "ok siap, nanti gw follow up" -> SILENT (acknowledgement)\n' +
  '  "btw mager banget hari ini wkwk" -> SILENT (casual banter between humans)\n' +
  '  "tolong buatin action items dari diskusi tadi" -> RESPOND_AKSEL (practical, execution-focused)\n' +
  '  "kenapa ya conversion rate kita turun bulan ini, ada insight?" -> TRIGGER_VERA (research/analysis-depth)\n' +
  '  "vera berapa harga dollar sekarang?" -> TRIGGER_VERA (names her directly and asks her something specific, not a passing mention)\n' +
  '  "vera kemarin sempet bilang soal ini kan?" -> SILENT (mentions her name but is recalling something to the humans, not addressing her right now)\n\n' +
  'Output ONLY the single token. No explanation, no punctuation, no newline.';

/**
 * Deterministically checks the raw message text for an explicit, unambiguous
 * @mention of exactly one agent. Word-boundary guarded so "@veranda" doesn't
 * false-positive match "@vera". Returns the verdict to short-circuit
 * straight to, or null if this message needs the judge's actual judgment
 * (no mention, or both agents mentioned at once).
 */
const detectExplicitMention = (message) => {
  const text = message || '';
  const hasVera  = /@vera\b/i.test(text);
  const hasAksel = /@aksel\b/i.test(text);
  if (hasVera && !hasAksel)  return 'TRIGGER_VERA';
  if (hasAksel && !hasVera)  return 'RESPOND_AKSEL';
  return null; // neither, or both — let the judge decide
};

/**
 * The caller may pass either a plain string or a full message row object
 * (e.g. { id, sender_name, content, ... }) as latestMessage — this was the
 * actual root cause behind the original live bug: a message OBJECT was
 * being interpolated/regex-tested directly, silently stringifying to
 * "[object Object]" everywhere it was used (both in detectExplicitMention
 * and in the prompt sent to Groq). Normalizing once here, at the top of
 * judgeMessage, fixes it for every downstream use in one place regardless
 * of what any given caller passes.
 */
const extractMessageText = (msg) => {
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object' && typeof msg.content === 'string') return msg.content;
  return '';
};

/**
 * Run the judge on a single incoming message.
 *
 * @param {object}   opts
 * @param {string}   opts.groupId       — for logging
 * @param {string}   opts.userId        — for cost logging
 * @param {string|object} opts.latestMessage — the message just sent, as
 *                   plain text OR a full message row (normalized internally)
 * @param {object[]} opts.recentHistory — last CONTEXT_WINDOW messages
 *                   Each: { sender_type, sender_name, content }
 * @param {object}   opts.agentConfig   — from groups.agent_config (Phase 8.1)
 *
 * @returns {'SILENT'|'RESPOND_AKSEL'|'TRIGGER_VERA'|'BATCH_PENDING'}
 */
const judgeMessage = async ({ groupId, userId, latestMessage, recentHistory, agentConfig }) => {
  const messageText = extractMessageText(latestMessage);

  const mentionVerdict = detectExplicitMention(messageText);
  if (mentionVerdict) {
    console.log(`[Judge] group=${groupId} verdict=${mentionVerdict} (explicit @mention, Groq skipped)`);
    return mentionVerdict;
  }

  const context = (recentHistory || [])
    .slice(-CONTEXT_WINDOW)
    .map(m => `[${m.sender_name || m.sender_type}]: ${m.content}`)
    .join('\n');

  const configHint = agentConfig
    ? `\nGroup agent config — Aksel focus: ${agentConfig.aksel_focus || 'n/a'}. ` +
      `Vera focus: ${agentConfig.vera_focus || 'n/a'}. ` +
      `Aksel triggers: ${(agentConfig.aksel_triggers || []).join('; ')}. ` +
      `Vera triggers: ${(agentConfig.vera_triggers || []).join('; ')}.`
    : '';

  const userPrompt =
    `Recent conversation:${context ? '\n' + context : ' (none yet)'}\n\n` +
    `Latest message: "${messageText}"` +
    configHint;

  try {
    const completion = await groq.chat.completions.create({
      model:      JUDGE_MODEL,
      max_tokens: 10,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0,
    });

    logUsage({
      model:        JUDGE_MODEL,
      callType:     'group_judge',
      inputTokens:  completion.usage?.prompt_tokens     || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      userId,
    });

    const raw     = completion.choices[0]?.message?.content?.trim() || '';
    const verdict = raw.split(/\s/)[0].toUpperCase();

    const valid = ['SILENT', 'RESPOND_AKSEL', 'TRIGGER_VERA', 'BATCH_PENDING'];
    if (!valid.includes(verdict)) {
      console.warn(`[Judge] Unexpected verdict "${raw}" for group ${groupId} — defaulting SILENT`);
      return 'SILENT';
    }

    console.log(`[Judge] group=${groupId} verdict=${verdict}`);
    return verdict;

  } catch (err) {
    // Fail open: if the judge crashes, stay silent rather than generating
    // an unreviewed agent response.
    console.error(`[Judge] Error for group ${groupId}:`, err.message);
    return 'SILENT';
  }
};

module.exports = { judgeMessage, CONTEXT_WINDOW };