'use strict';
/**
 * GROUP CHAT — Aksel Trigger (Capability Audit, 25 Jul 2026)
 *
 * Called when groupJudge returns RESPOND_AKSEL. Until now this verdict was
 * routed but never executed — routes/groupMessages.js explicitly left it
 * as "kept lightweight for now" (confirmed by reading that file directly)
 * and no other file in backend/chat/ implements it either (groupBatch.js
 * is just the batching queue, groupIdleTrigger.js is an unrelated
 * quiet-group check-in timer, handler.js is personal-chat-only). This
 * file closes that gap, reusing every pattern already proven in
 * groupVeraTrigger.js rather than inventing a new architecture:
 *
 * 1. Natural delay — shorter than Vera's (500-1000ms vs 2-4s). Aksel is
 *    the COO/execution persona, not the "let me think about this"
 *    researcher — a quick, decisive reply fits his character, while
 *    still avoiding the jarring "instant bot" feel of a 0ms reply.
 *
 * 2. Interrupt detection — identical reasoning to Vera: if a new user
 *    message arrives during the delay, back off and let the judge
 *    re-evaluate fresh rather than answering a superseded message.
 *
 * 3. Real typing indicator — same broadcast shape/channel as Vera and
 *    the human typing indicator, via public.broadcast_group_event()
 *    (Phase 8.6). Also re-fires around file generation specifically
 *    (see 6below) so the UI has something live to show during the
 *    longer file-render wait, not just silence.
 *
 * 4. Live external grounding (currency, etc.) via lib/liveContext.js —
 *    the same shared module handler.js (personal chat) and
 *    groupVeraTrigger.js already use. Empty string when nothing applies
 *    or a lookup genuinely failed — never tells Aksel he has data he
 *    doesn't actually have.
 *
 * 5. reply_to — Aksel's response quotes the message that triggered it,
 *    same quote-reply model used everywhere else.
 *
 * 6. File generation — the [[GENERATE_FILE:...]] marker + directive
 *    pattern from handler.js (personal chat), now shared via
 *    lib/fileGenerationDirective.js so the two surfaces can't drift
 *    apart. Delivered as a group_messages insert (broadcasts
 *    automatically via the existing Section-13 trigger — no extra
 *    plumbing needed), replying to the same triggering message.
 *
 * 7. Group memory context (Fase 11 item #2, 22 Aug 2026) — approved
 *    group_memories fetched via lib/groupMemoryExtractor.js's
 *    getApprovedGroupMemoryContext(), same pattern/safety as
 *    groupVeraTrigger.js uses. Gives Aksel persistent awareness of this
 *    group's goals/decisions/plans across sessions, not just the last
 *    10 messages of raw history.
 *
 * Output is saved directly to group_messages with sender_type='aksel'.
 * The Realtime subscription on the frontend picks it up automatically.
 */
const { groq }      = require('../lib/groq');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');
const { buildLiveContext } = require('../lib/liveContext');
const { getResponseLanguageInstruction } = require('../lib/agentLanguage');
const { FILE_GENERATION_DIRECTIVE } = require('../lib/fileGenerationDirective');
const { detectFileMarkers, stripFileMarkers, generateFile } = require('../lib/fileGenerator');
const { getApprovedGroupMemoryContext } = require('../lib/groupMemoryExtractor');

const AKSEL_MODEL  = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile deprecated by Groq (17 Jun 2026) — same migration as groupJudge.js/handler.js
const DELAY_MIN_MS = 500;
const DELAY_MAX_MS = 1500;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const randomDelay = () =>
  DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

/**
 * Fire-and-forget broadcast on the group's realtime channel. Identical
 * mechanism to groupVeraTrigger.js's broadcastPresence — see that file's
 * comment for the full rationale (Database broadcast method via
 * public.broadcast_group_event(), not a direct realtime.send() RPC).
 */
const broadcastPresence = async (groupId, event) => {
  try {
    await supabase.rpc('broadcast_group_event', {
      p_group_id: groupId,
      p_event:    event,
      p_payload:  { user_id: 'aksel' },
    });
  } catch (err) {
    console.warn(`[AkselTrigger] ${groupId}: ${event} broadcast failed (non-fatal):`, err.message);
  }
};

/**
 * Fetch the latest message timestamp for a group — used to detect if
 * a new user message arrived during Aksel's short thinking delay.
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
 * Build a group-context system prompt for Aksel. COO/execution persona —
 * practical, direct, action-oriented, distinct from Vera's research/depth
 * framing in buildVeraGroupPrompt.
 */
const buildAkselGroupPrompt = (group, members) => {
  const memberList = members
    .map(m => `${m.display_name} (${m.role})`)
    .join(', ');

  return (
    `You are Aksel, the COO-persona execution agent for a group called "${group.name}".\n\n` +
    `Group purpose: ${group.purpose || 'Not yet defined.'}\n` +
    `Members: ${memberList || 'Unknown.'}\n\n` +
    `You handle direct, practical, execution-focused requests — quick answers, ` +
    `action items, drafts, and getting things done. You are decisive and to the ` +
    `point, not exhaustive. Keep your response focused and concise for a group ` +
    `chat context (max 2-3 short paragraphs). ` +
    `Never use markdown headers. Use plain prose. ` +
    `Address the group naturally, not as if writing a report. ` +
    `Hand off to Vera implicitly by suggesting she weigh in if the request is ` +
    `really research/analysis-depth territory — you don't decide that here, ` +
    `the judge already routed this to you specifically.\n\n` +
    FILE_GENERATION_DIRECTIVE
  );
};

/**
 * Core trigger function. Called with the context at the moment the judge
 * decided RESPOND_AKSEL. Returns the saved message row, or null if
 * interrupted or skipped.
 */
const triggerAksel = async ({ groupId, recentMessages, snapshotTime, userId }) => {
  broadcastPresence(groupId, 'typing');

  try {
    // ── 1. Natural delay ──────────────────────────────────────────────────
    await delay(randomDelay());

    // ── 2. Interrupt check ───────────────────────────────────────────────
    const latestTime = await getLatestUserMessageTime(groupId);
    if (latestTime && latestTime > snapshotTime) {
      console.log(`[AkselTrigger] ${groupId}: interrupted by new message, backing off`);
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

    // Triggering message: the last one in recentMessages (the judge
    // evaluated it and returned RESPOND_AKSEL for it specifically) — the
    // interrupt check above guarantees nothing has superseded it by now.
    // Reused below for both live grounding and reply_to.
    const triggeringMessage = recentMessages[recentMessages.length - 1];
    const liveContext        = await buildLiveContext(triggeringMessage?.content || '');
    const languageInstruction = await getResponseLanguageInstruction(triggeringMessage?.sender_id);
    const groupMemoryContext  = await getApprovedGroupMemoryContext(groupId);

    // ── 4. Build conversation for Aksel ────────────────────────────────────
    const history = recentMessages
      .slice(-10)
      .map(m => ({
        role:    m.sender_type === 'user' ? 'user' : 'assistant',
        content: `[${m.sender_name || m.sender_type}]: ${m.content}`,
      }));

    const systemPrompt =
      buildAkselGroupPrompt(group || {}, memberList) +
      (liveContext ? `\n\nLIVE DATA FOR THIS MESSAGE:\n\n${liveContext}` : '') +
      (groupMemoryContext ? `\n\nWHAT YOU KNOW ABOUT THIS GROUP:\n\n${groupMemoryContext}` : '') +
      (languageInstruction ? `\n\n${languageInstruction}` : '');

    // ── 5. Generate Aksel's response ───────────────────────────────────────
    const completion = await groq.chat.completions.create({
      model:      AKSEL_MODEL,
      max_tokens: 500,
      messages:   [{ role: 'system', content: systemPrompt }, ...history],
    });

    logUsage({
      model:        AKSEL_MODEL,
      callType:     'group_aksel_response',
      inputTokens:  completion.usage?.prompt_tokens     || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      userId,
    });

    let content = completion.choices[0]?.message?.content?.trim();

    if (!content) {
      broadcastPresence(groupId, 'stopped_typing');
      return null;
    }

    // ── 6. File generation marker detection ────────────────────────────────
    // Strip any [[GENERATE_FILE:...]] marker before saving/broadcasting —
    // the marker itself must never reach the user. Same detection/strip
    // helpers handler.js already uses, imported directly (no duplicated
    // logic).
    let fileMarkers = [];
    try {
      fileMarkers = detectFileMarkers(content);
      if (fileMarkers.length > 0) content = stripFileMarkers(content);
    } catch (err) {
      console.error(`[AkselTrigger] ${groupId}: file marker detection error:`, err.message);
    }

    // ── 7. Save to group_messages (Realtime broadcasts it automatically) ──
    const { data: saved, error } = await supabase
      .from('group_messages')
      .insert({
        group_id:    groupId,
        sender_type: 'aksel',
        sender_name: 'Aksel',
        content,
        reply_to:    triggeringMessage?.id || null,
      })
      .select()
      .single();

    if (error) throw error;

    broadcastPresence(groupId, 'stopped_typing');
    console.log(`[AkselTrigger] ${groupId}: Aksel responded (${content.length} chars)`);

    // ── 8. Fire-and-forget file generation ─────────────────────────────────
    // Group chat's broadcast trigger on group_messages (Section 13)
    // handles delivery automatically once this insert lands — no extra
    // plumbing needed beyond the insert itself, unlike personal chat
    // which needed the Phase 8.8 Realtime fix for this same reason.
    if (fileMarkers.length > 0) {
      const contextSnippet = `Message: "${triggeringMessage?.content || ''}"\nAksel replied: "${content}"`;

      fileMarkers.forEach((marker) => {
        setImmediate(async () => {
          broadcastPresence(groupId, 'typing'); // visible again while the file renders
          try {
            const result = await generateFile({
              userId,
              format:      marker.format,
              title:       marker.title,
              description: marker.description,
              context:     contextSnippet,
            });
            await supabase.from('group_messages').insert({
              group_id:    groupId,
              sender_type: 'aksel',
              sender_name: 'Aksel',
              content:     `Here's your file — ${result.fileName}: ${result.url}`,
              reply_to:    triggeringMessage?.id || null,
            });
          } catch (err) {
            console.error(`[AkselTrigger] ${groupId}: file generation failed (${marker.format}):`, err.message);
            await supabase.from('group_messages').insert({
              group_id:    groupId,
              sender_type: 'aksel',
              sender_name: 'Aksel',
              content:     `Sorry, I ran into an issue generating that file — mind asking again?`,
              reply_to:    triggeringMessage?.id || null,
            }).catch(() => {});
          } finally {
            broadcastPresence(groupId, 'stopped_typing');
          }
        });
      });
    }

    return saved;

  } catch (err) {
    console.error(`[AkselTrigger] ${groupId}: error —`, err.message);
    broadcastPresence(groupId, 'stopped_typing');
    return null;
  }
};

module.exports = { triggerAksel };
