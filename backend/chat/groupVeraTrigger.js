'use strict';
/**
 * GROUP CHAT — Vera Trigger with Natural Delay Protocol
 *
 * Called when groupJudge returns TRIGGER_VERA. Implements four things:
 *
 * 1. Natural delay (2–4s random) — prevents the "instant bot" feel.
 *    Vera should feel like she took a moment to think, not like an API call.
 *
 * 2. Interrupt detection — during that delay, if a new user message
 *    arrives, re-evaluate with the judge before proceeding. Vera doesn't
 *    answer a question that's already been superseded mid-thought.
 *
 * 3. Real typing indicator — broadcasts 'typing' the moment this function
 *    starts (before the natural delay even begins), and 'stopped_typing'
 *    on every exit path (interrupted, success, or error). Replaces the
 *    old frontend heuristic that guessed "still typing" from how recently
 *    the last message arrived — this is the actual signal, reusing the
 *    same broadcast channel/shape the human typing indicator already uses.
 *    We don't await realtime.send() — a delivery hiccup on the typing
 *    signal should never block or fail Vera's actual response.
 *
 * 4. reply_to — Vera's response quotes the specific message that triggered
 *    it (same quote-reply model the frontend already uses for human
 *    replies). Safe by construction: the interrupt check above guarantees
 *    that if we reach the response step, nothing has superseded the
 *    triggering message, so it's still the right thing to be quoting.
 *    Degrades gracefully to no reply_to if that message object has no
 *    `id` (e.g. an older/partial call site) — never throws over this.
 *
 * 5. Live external grounding (currency, etc. — capability audit, 25 Jul
 *    2026) via lib/liveContext.js, the same shared module handler.js
 *    (personal chat) uses. Built from the triggering message's content,
 *    computed once and reused for both this and reply_to below. Empty
 *    string when nothing applies or a lookup genuinely failed — see
 *    liveContext.js for why this never tells Vera she has data she
 *    doesn't actually have.
 *
 * 6. Group memory context (Fase 11 item #2, 22 Aug 2026) — approved
 *    group_memories fetched via lib/groupMemoryExtractor.js's
 *    getApprovedGroupMemoryContext(), same "empty string if nothing/
 *    failed" safety as liveContext above. Gives Vera persistent awareness
 *    of this group's goals/decisions/plans across sessions, not just
 *    the last 10 messages of raw history.
 *
 * Output is saved directly to group_messages with sender_type='vera'.
 * The Realtime subscription on the frontend picks it up automatically.
 */
const { anthropic } = require('../lib/anthropic');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');
const { buildLiveContext } = require('../lib/liveContext');
const { getResponseLanguageInstruction } = require('../lib/agentLanguage');
const { getApprovedGroupMemoryContext } = require('../lib/groupMemoryExtractor');

const VERA_MODEL   = process.env.VERA_MODEL   || 'claude-sonnet-4-6'; // kept per user decision, despite not matching Claude's current model list
const DELAY_MIN_MS = 2000;
const DELAY_MAX_MS = 4000;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const randomDelay = () =>
  DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

/**
 * Fire-and-forget broadcast on the group's realtime channel. Calls the
 * public.broadcast_group_event() wrapper (Phase 8.6) rather than the
 * `realtime` schema directly — that wrapper reuses the same "Database"
 * broadcast method already proven in the message-insert trigger, and
 * avoids depending on `realtime` being in the project's exposed-schemas
 * list (a documented pitfall for calling realtime.send() straight over
 * PostgREST from outside the database). Payload shape matches what
 * useGroupMessages.ts already listens for ('typing'/'stopped_typing'
 * events, { user_id }). Never awaited by callers and never throws past
 * this function: a failed typing signal is cosmetic and must not affect
 * message generation/saving.
 */
const broadcastPresence = async (groupId, event) => {
  try {
    await supabase.rpc('broadcast_group_event', {
      p_group_id: groupId,
      p_event:    event,
      p_payload:  { user_id: 'vera' },
    });
  } catch (err) {
    console.warn(`[VeraTrigger] ${groupId}: ${event} broadcast failed (non-fatal):`, err.message);
  }
};

/**
 * Fetch the latest message timestamp for a group — used to detect if
 * a new user message arrived during Vera's thinking delay.
 */
const getLatestUserMessageTime = async (groupId) => {
  const { data } = await supabase
    .from('group_messages')
    .select('created_at')
    .eq('group_id', groupId)
    .eq('sender_type', 'user')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at || null;
};

/**
 * Build a group-context system prompt for Vera.
 * She knows the group's purpose, milestones, and her own role.
 */
const buildVeraGroupPrompt = (group, members) => {
  const memberList = members
    .map(m => `${m.display_name} (${m.role})`)
    .join(', ');

  return (
    `You are Vera, the research and analysis agent for a group called "${group.name}".\n\n` +
    `Group purpose: ${group.purpose || 'Not yet defined.'}\n` +
    `Members: ${memberList || 'Unknown.'}\n\n` +
    `You provide depth, research, and nuanced analysis when the group needs it. ` +
    `You are NOT the conversation moderator — you only respond when Aksel ` +
    `explicitly defers to you. Keep your response focused and concise for a ` +
    `group chat context (max 3-4 short paragraphs). ` +
    `Never use markdown headers. Use plain prose. ` +
    `Address the group naturally, not as if writing a report.`
  );
};

/**
 * Core trigger function. Called with the context at the moment the judge
 * decided TRIGGER_VERA. Returns the saved message row, or null if
 * interrupted or skipped.
 */
const triggerVera = async ({ groupId, recentMessages, snapshotTime, userId }) => {
  broadcastPresence(groupId, 'typing'); // fire-and-forget — starts before the delay so it's visible during the "thinking" pause

  try {
    // ── 1. Natural delay ──────────────────────────────────────────────────
    await delay(randomDelay());

    // ── 2. Interrupt check ───────────────────────────────────────────────
    // If a new user message arrived while we were "thinking", back off.
    // The new message will go through the judge again fresh.
    const latestTime = await getLatestUserMessageTime(groupId);
    if (latestTime && latestTime > snapshotTime) {
      console.log(`[VeraTrigger] ${groupId}: interrupted by new message, backing off`);
      broadcastPresence(groupId, 'stopped_typing');
      return null;
    }

    // ── 3. Fetch group context ────────────────────────────────────────────
    const { data: group } = await supabase
      .from('groups')
      .select('name, purpose, milestones, agent_config')
      .eq('id', groupId)
      .single();

    const { data: members } = await supabase
      .from('group_members')
      .select('role, profile:user_profiles(display_name)')
      .eq('group_id', groupId)
      .eq('status', 'active');

    const memberList = (members || [])
      .filter(m => m.profile)
      .map(m => ({ display_name: m.profile.display_name, role: m.role }));

    // The triggering message is the last one in recentMessages (the judge
    // evaluated it and returned TRIGGER_VERA for it specifically) — the
    // interrupt check above guarantees nothing has superseded it by now.
    // Computed once here, reused below for both live grounding and
    // reply_to.
    const triggeringMessage = recentMessages[recentMessages.length - 1];
    const liveContext        = await buildLiveContext(triggeringMessage?.content || '');
    const languageInstruction = await getResponseLanguageInstruction(triggeringMessage?.sender_id);
    const groupMemoryContext  = await getApprovedGroupMemoryContext(groupId);

    // ── 4. Build conversation for Vera ────────────────────────────────────
    const history = recentMessages
      .slice(-10)
      .map(m => ({
        role:    m.sender_type === 'user' ? 'user' : 'assistant',
        content: `[${m.sender_name || m.sender_type}]: ${m.content}`,
      }));

    // ── 5. Generate Vera's response ───────────────────────────────────────
    const response = await anthropic.messages.create({
      model:      VERA_MODEL,
      max_tokens: 600,
      system:     buildVeraGroupPrompt(group || {}, memberList) +
                  (liveContext ? `\n\nLIVE DATA FOR THIS MESSAGE:\n\n${liveContext}` : '') +
                  (groupMemoryContext ? `\n\nWHAT YOU KNOW ABOUT THIS GROUP:\n\n${groupMemoryContext}` : '') +
                  (languageInstruction ? `\n\n${languageInstruction}` : ''),
      messages:   history,
    });

    logUsage({
      model:        VERA_MODEL,
      callType:     'group_vera_response',
      inputTokens:  response.usage?.input_tokens  || 0,
      outputTokens: response.usage?.output_tokens || 0,
      userId,
    });

    const content = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    if (!content) {
      broadcastPresence(groupId, 'stopped_typing');
      return null;
    }

    // ── 6. Save to group_messages (Realtime broadcasts it to members) ────
    // triggeringMessage already computed above (step 3) — reply_to is
    // simply omitted if that message has no `id` on it.
    const { data: saved, error } = await supabase
      .from('group_messages')
      .insert({
        group_id:    groupId,
        sender_type: 'vera',
        sender_name: 'Vera',
        content,
        reply_to:    triggeringMessage?.id || null,
      })
      .select()
      .single();

    if (error) throw error;

    broadcastPresence(groupId, 'stopped_typing');
    console.log(`[VeraTrigger] ${groupId}: Vera responded (${content.length} chars)`);
    return saved;

  } catch (err) {
    console.error(`[VeraTrigger] ${groupId}: error —`, err.message);
    broadcastPresence(groupId, 'stopped_typing');
    return null;
  }
};

module.exports = { triggerVera };
