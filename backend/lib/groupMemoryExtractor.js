'use strict';
const { groq }     = require('./groq');
const { supabase } = require('./supabase');
const { logUsage } = require('./usageLogger');

const AKSEL_MODEL = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b';

// How many recent messages to consider per extraction pass. Called on the
// idle-trigger timer (batched — see groupIdleTrigger.js), not per-message,
// so this window just needs to comfortably cover "what happened during
// the conversation burst that just went quiet," not the group's entire
// history.
const EXTRACTION_MESSAGE_WINDOW = 20;

// How many of the group's existing memories to show the model as "already
// known" context. This is the fix for the exact gap found in personal
// memoryExtractor.js's extractLayer1(): a "skip if not genuinely new"
// instruction is unenforceable if the model is never shown what's already
// there to compare against. Applied here from the start rather than
// bolted on later.
const EXISTING_MEMORY_CONTEXT_LIMIT = 30;

/**
 * Extract group-level insights (goals, decisions, plans, shared
 * preferences) from a group's recent conversation. Fire-and-forget,
 * called from groupIdleTrigger.js's timer — never blocks anything user-
 * facing. Requires owner/co-admin approval before an inserted row is
 * usable (status starts 'pending' — see the approve/reject endpoint,
 * step 4 of this feature).
 *
 * @param {string} groupId
 * @param {string|null} userId — for cost logging only; extraction runs on
 *   a timer, not tied to any one user's action, so this is often null.
 */
const extractGroupMemory = async (groupId, userId = null) => {
  try {
    const { data: messages } = await supabase
      .from('group_messages')
      .select('sender_name, sender_type, content, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(EXTRACTION_MESSAGE_WINDOW);

    // Too little to meaningfully extract anything group-level from.
    if (!messages || messages.length < 3) return;

    const conversationText = messages
      .reverse()
      .map((m) => `${m.sender_name || m.sender_type}: ${m.content}`)
      .join('\n');

    const { data: existing } = await supabase
      .from('group_memories')
      .select('content')
      .eq('group_id', groupId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(EXISTING_MEMORY_CONTEXT_LIMIT);

    const existingList = (existing || []).map((m) => `- ${m.content}`).join('\n') || '(none yet)';

    // Strengthened (22 Aug 2026) with the same "worth remembering" bar
    // applied to personal memoryExtractor.js's extractLayer1() — grounded
    // in how ChatGPT's own memory selection actually works (researched
    // same day): it favors recurring signals and inherently-stable facts
    // over one-off details, not "everything that was said." Group memory
    // hadn't shown the same visible noise problem yet (unlike the personal
    // queue, which had user-reported evidence — screenshots of one-off
    // task requests like "count to 10" captured as if they were durable
    // facts), but the structural risk is identical, so this closes the
    // gap preventatively rather than waiting for it to show up here too.
    const prompt =
      'You are analyzing a group chat conversation to extract DURABLE, long-term-worthy facts about ' +
      'the GROUP as a whole — not a transcript of everything that was said, and not anything about a ' +
      "single member's personal life.\n\n" +
      `Conversation:\n${conversationText}\n\n` +
      `Already known about this group:\n${existingList}\n\n` +
      "Extract 0 to 3 insights that would genuinely help a FUTURE conversation with this group — " +
      "think of this like learning to drive: you don't need to remember every shop you passed on the " +
      'way, you need the durable pattern. Only extract:\n' +
      '- A genuine group-level decision that was made (e.g. "the group decided to launch Friday").\n' +
      '- A standing preference for how the group operates, explicitly framed as general — not a ' +
      'one-off request.\n' +
      '- A real ongoing goal or plan the group is actively pursuing over time.\n\n' +
      'Do NOT extract:\n' +
      '- One-off task requests directed at Aksel or Vera during this burst of messages.\n' +
      '- Casual banter, greetings, or small talk with no lasting group-level substance.\n' +
      '- A single passing mention with no clear group-wide emphasis or repetition.\n' +
      '- Anything specific to one individual member rather than the group as a whole.\n' +
      '- Anything that duplicates or closely paraphrases something already listed above as "already ' +
      'known" — only genuinely new information belongs in your answer.\n\n' +
      'Each insight must be a single sentence, 10 to 30 words. Return ONLY a JSON array — no ' +
      'explanation, no markdown, no preamble.\n\n' +
      'Format: [{ "content": "...", "category": "goal|decision|context|preference|plan" }]\n\n' +
      'If nothing durable and new, return: []';

    const completion = await groq.chat.completions.create({
      model:       AKSEL_MODEL,
      max_tokens:  400,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    logUsage({
      model:        AKSEL_MODEL,
      callType:     'group_memory_extract',
      inputTokens:  completion.usage?.prompt_tokens     || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      userId,
    });

    const raw = completion.choices[0]?.message?.content || '[]';
    let insights;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      insights = JSON.parse(clean);
    } catch {
      console.warn(`[GroupMemory] ${groupId}: parse failed, skipping`);
      return;
    }

    if (!Array.isArray(insights) || insights.length === 0) return;

    const rows = insights
      .filter((i) => i.content && i.category)
      .map((i) => ({
        group_id:     groupId,
        content:      i.content,
        layer:        1,
        category:     i.category,
        status:       'pending',
        agent_target: 'Both',
      }));

    if (rows.length === 0) return;

    const { error } = await supabase.from('group_memories').insert(rows);
    if (error) console.error(`[GroupMemory] ${groupId}: insert error:`, error.message);
    else console.log(`[GroupMemory] ${groupId}: ${rows.length} insight(s) queued for review`);
  } catch (err) {
    console.error(`[GroupMemory] ${groupId}: extraction error —`, err.message);
  }
};

/**
 * Fetch approved group memories, formatted as a text block ready to
 * append to an agent's system prompt. Shared by groupAkselTrigger.js and
 * groupVeraTrigger.js — one fetch+format implementation instead of
 * duplicating it in both, matching the same shared-module pattern
 * lib/liveContext.js already uses for both of them.
 *
 * @param {string} groupId
 * @returns {Promise<string>} empty string if there's nothing approved yet
 *   or the fetch itself fails — a memory-context hiccup must never block
 *   an agent from responding at all.
 */
const getApprovedGroupMemoryContext = async (groupId) => {
  try {
    const { data } = await supabase
      .from('group_memories')
      .select('content')
      .eq('group_id', groupId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!data || data.length === 0) return '';

    return data.map((m) => `- ${m.content}`).join('\n');
  } catch (err) {
    console.error(`[GroupMemory] ${groupId}: fetch context error —`, err.message);
    return '';
  }
};

module.exports = { extractGroupMemory, getApprovedGroupMemoryContext };
