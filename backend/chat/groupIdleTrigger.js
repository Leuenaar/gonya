'use strict';
/**
 * GROUP CHAT — Idle Trigger System
 *
 * Monitors group message activity. If no user message arrives within the
 * idle threshold (default 30 min, owner-configurable), Aksel sends a
 * brief, natural check-in or summary to re-engage the group.
 *
 * Per-group timers live in memory (same reasoning as groupBatch.js and
 * rateLimit.js — single-process VPS, no shared state needed).
 *
 * Owner can disable this entirely by setting:
 *   agent_config.idle_trigger_enabled = false
 *
 * Or customize the threshold:
 *   agent_config.idle_trigger_minutes = 60  (0 = disabled)
 */
const { groq }      = require('../lib/groq');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');
const { extractGroupMemory } = require('../lib/groupMemoryExtractor');

const AKSEL_MODEL       = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile deprecated by Groq (17 Jun 2026) — same migration as groupJudge.js/groupAkselTrigger.js/handler.js
const DEFAULT_IDLE_MIN  = 30;

// groupId → TimeoutId
const idleTimers = new Map();

const IDLE_SYSTEM =
  'You are Aksel, an AI agent in a group chat. The group has been quiet for a while. ' +
  'Send a brief, natural message — either a short summary of what was discussed, ' +
  'a gentle nudge about an open task or question, or a simple check-in. ' +
  'Keep it to 1-2 sentences maximum. Be warm but not pushy. ' +
  'Never say "I notice you have been quiet" or anything robotic. ' +
  'Never use markdown. Respond as if you are a natural participant in the group.';

const generateIdleMessage = async ({ groupId, recentMessages, userId }) => {
  try {
    const context = recentMessages
      .slice(-6)
      .map(m => `${m.sender_name || m.sender_type}: ${m.content}`)
      .join('\n');

    const completion = await groq.chat.completions.create({
      model:       AKSEL_MODEL,
      max_tokens:  80,
      temperature: 0.7,
      messages: [
        { role: 'system', content: IDLE_SYSTEM },
        { role: 'user',   content: `Recent conversation:\n${context}\n\nSend a brief natural check-in.` },
      ],
    });

    logUsage({
      model:        AKSEL_MODEL,
      callType:     'group_idle_trigger',
      inputTokens:  completion.usage?.prompt_tokens     || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      userId,
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) return;

    await supabase
      .from('group_messages')
      .insert({
        group_id:    groupId,
        sender_type: 'aksel',
        sender_name: 'Aksel',
        content,
      });

    console.log(`[IdleTrigger] ${groupId}: Aksel check-in sent`);
  } catch (err) {
    console.error(`[IdleTrigger] ${groupId}: error —`, err.message);
  }
};

/**
 * Reset (or start) the idle timer for a group.
 * Call this every time a user message is saved to group_messages.
 */
const resetIdleTimer = async (groupId) => {
  // Clear any existing timer first
  const existing = idleTimers.get(groupId);
  if (existing) clearTimeout(existing);

  // Fetch group config to check if idle trigger is enabled
  const { data: group } = await supabase
    .from('groups')
    .select('agent_config, status')
    .eq('id', groupId)
    .maybeSingle();

  if (!group || group.status !== 'active') return;

  const config  = group.agent_config || {};
  const enabled = config.idle_trigger_enabled !== false; // default ON
  const minutes = typeof config.idle_trigger_minutes === 'number'
    ? config.idle_trigger_minutes
    : DEFAULT_IDLE_MIN;

  if (!enabled || minutes === 0) return;

  const timer = setTimeout(async () => {
    idleTimers.delete(groupId);

    // Fire-and-forget, deliberately NOT awaited — this reuses the exact
    // moment the group goes idle as the batched extraction point (user
    // decision: batched on idle, not per-message), but a slow or failed
    // extraction must never delay or break the check-in message below.
    // extractGroupMemory() already catches its own errors internally
    // (never throws), so .catch() here is just a defensive backstop.
    extractGroupMemory(groupId).catch((err) =>
      console.error(`[IdleTrigger] ${groupId}: group memory extraction failed —`, err.message)
    );

    // Fetch recent messages to give Aksel context for the check-in
    const { data: messages } = await supabase
      .from('group_messages')
      .select('sender_type, sender_name, content, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(6);

    if (!messages?.length) return;

    await generateIdleMessage({
      groupId,
      recentMessages: messages.reverse(),
      userId:         null,
    });
  }, minutes * 60 * 1000);

  idleTimers.set(groupId, timer);
};

/**
 * Fully cancel a group's idle timer — call when a group is archived or
 * dissolved so we don't fire a check-in into a dead group.
 */
const cancelIdleTimer = (groupId) => {
  const existing = idleTimers.get(groupId);
  if (existing) { clearTimeout(existing); idleTimers.delete(groupId); }
};

module.exports = { resetIdleTimer, cancelIdleTimer };
