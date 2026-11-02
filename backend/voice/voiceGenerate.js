'use strict';
const { groq }      = require('../lib/groq');
const { anthropic } = require('../lib/anthropic');
const { logUsage }  = require('../lib/usageLogger');
const { webSearchToolGroq, webSearchToolAnthropic, performWebSearch } = require('../lib/tools/webSearch');

const VERA_MODEL  = process.env.VERA_MODEL  || 'claude-sonnet-4-6';
const AKSEL_MODEL = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b';

// Logged once at startup so "which model is actually being used" is never
// a guessing game during debugging — prints whether each value came from
// .env or the built-in default, since a stale/unexpected .env var is a
// real, previously-hit source of confusion (rate-limit errors mentioning
// a model neither of these defaults to).
console.log(`[Voice] Aksel model: ${AKSEL_MODEL} (${process.env.AKSEL_MODEL ? 'from .env' : 'default'})`);
console.log(`[Voice] Vera model:  ${VERA_MODEL} (${process.env.VERA_MODEL ? 'from .env' : 'default'})`);

// Voice calls skip "deep mode" entirely (see backend/chat/handler.js for
// the text-chat deep-mode research step) — a live call can't afford the
// extra round-trip a Haiku pre-research pass adds. Tool-use search below
// covers the same need (current/real-time info) without that fixed cost:
// it only fires when the model actually decides it needs it.
const MAX_TOOL_ROUNDS = 2;

// ── Sentence buffering ────────────────────────────────────
// Splits a growing text buffer into complete sentences as soon as terminal
// punctuation (. ! ?) is followed by whitespace, so each sentence can be
// handed to TTS the moment it's ready instead of waiting for the full
// response. Deliberately simple for v1 — it will occasionally split early
// on an abbreviation ("Dr. Smith" -> two chunks instead of one). That just
// means TTS speaks it in two pieces rather than one; it doesn't break
// anything. A trailing sentence with no whitespace after its punctuation
// (i.e. still at the very end of the buffer) is intentionally NOT split
// out here — it's caught by the caller's final flush once the stream ends.
const SENTENCE_END_RE = /([.!?]+)(\s+)/;

const splitCompleteSentences = (buffer) => {
  const complete = [];
  let remaining = buffer;
  while (true) {
    const match = remaining.match(SENTENCE_END_RE);
    if (!match) break;
    const endIdx = match.index + match[0].length;
    const sentence = remaining.slice(0, endIdx).trim();
    if (sentence) complete.push(sentence);
    remaining = remaining.slice(endIdx);
  }
  return { complete, remainder: remaining };
};

// Groq occasionally generates a malformed tool-call the API itself can't
// parse back out — a known reliability gap in Groq's function-calling, not
// something caused by our prompt or tool schema (confirmed: same tool
// definition works fine most calls, fails intermittently on others).
// Detecting it here lets us recover in-call instead of the whole turn
// just failing with a generic error.
const isFunctionCallFormatError = (err) =>
  err?.status === 400 && /failed to call a function/i.test(err?.message || '');

// Caps how long a single LLM request is allowed to take, INCLUDING
// however long API-key rotation (lib/apiKeyRotator.js) takes internally if
// the first key is rate-limited and it has to fall through to others —
// each attempt is a real network round-trip, and without this cap a run
// of several slow/failing attempts in a row could leave the user staring
// at silence for a long time before anything gives up and falls back.
// This is now the OUTER safety net, not the primary control — the real
// per-key budget lives in lib/apiKeyRotator.js's perAttemptTimeoutMs
// (5s/key for Groq). With 3 keys configured, worst case there is ~15s;
// this is sized to comfortably cover that plus margin, so it should
// essentially never fire on its own unless something outside the normal
// rotation flow hangs (e.g. the TTS call after generation).
const GENERATION_TIMEOUT_MS = 20000;

// Once a stream has actually started, individual chunks normally arrive
// well under a second apart — this is deliberately much shorter than
// GENERATION_TIMEOUT_MS, since "is the NEXT token taking unreasonably
// long" is a different question from "has the whole turn taken too long
// overall," and waiting the full 20s to notice a mid-stream stall would
// be a much worse experience than catching it quickly.
const STREAM_CHUNK_TIMEOUT_MS = 8000;

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // Whichever settles first wins the race either way — this just makes
  // sure the LOSING timer doesn't linger around doing nothing until its
  // own deadline, once the real work already finished.
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
};

// ── Aksel (Groq) — streaming + tool-use ───────────────────
async function* generateAkselVoice(systemPrompt, history, userMessage, userId) {
  let messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  let buffer       = '';
  let toolRounds   = 0;
  let toolsDisabled = false; // flips on after a malformed-tool-call error; stays off for the rest of this turn

  while (true) {
    let stream;
    try {
      stream = await withTimeout(groq.chat.completions.create({
        model:       AKSEL_MODEL,
        max_tokens:  600,
        temperature: 0.75,
        messages,
        tools:       toolsDisabled ? undefined : [webSearchToolGroq],
        stream:      true,
      }), GENERATION_TIMEOUT_MS, 'Aksel (Groq) request');
    } catch (err) {
      if (isFunctionCallFormatError(err) && !toolsDisabled) {
        console.warn(`[Voice] Aksel malformed tool-call, retrying this turn without tools:`, err.message);
        toolsDisabled = true;
        continue; // retry immediately, same messages, just without the tool this time
      }
      throw err;
    }

    const assembledToolCalls = {}; // index -> { id, name, arguments }
    let assistantText  = '';
    let finishReason    = null;
    let promptTokens     = 0;
    let completionTokens = 0;

    // Manual iteration (not `for await`) so each individual chunk wait can
    // be timed out too — mirrors the same fix applied to Vera below. The
    // outer withTimeout above only covers getting the stream STARTED
    // (i.e. the rotation phase); once actual token chunks are flowing,
    // a `for await` alone can't be interrupted if the connection hangs
    // mid-stream — this catches that case too, not just a slow start.
    const akselIterator = stream[Symbol.asyncIterator]();
    while (true) {
      const { value: chunk, done } = await withTimeout(
        akselIterator.next(), STREAM_CHUNK_TIMEOUT_MS, 'Aksel (Groq) stream chunk'
      );
      if (done) break;
      const choice = chunk.choices?.[0];
      const delta  = choice?.delta;

      if (delta?.content) {
        assistantText += delta.content;
        buffer        += delta.content;
        const { complete, remainder } = splitCompleteSentences(buffer);
        buffer = remainder;
        for (const sentence of complete) yield sentence;
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!assembledToolCalls[idx]) {
            assembledToolCalls[idx] = { id: tc.id, name: '', arguments: '' };
          }
          if (tc.id)               assembledToolCalls[idx].id = tc.id;
          if (tc.function?.name)   assembledToolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) assembledToolCalls[idx].arguments += tc.function.arguments;
        }
      }

      if (choice?.finish_reason) finishReason = choice.finish_reason;
      // x_groq.usage only appears on the final chunk of a Groq stream.
      if (chunk.x_groq?.usage) {
        promptTokens     = chunk.x_groq.usage.prompt_tokens     || 0;
        completionTokens = chunk.x_groq.usage.completion_tokens || 0;
      }
    }

    logUsage({
      model:        AKSEL_MODEL,
      callType:     'voice_aksel',
      inputTokens:  promptTokens,
      outputTokens: completionTokens,
      userId,
    });

    const toolCallList = Object.values(assembledToolCalls);

    if (finishReason === 'tool_calls' && toolCallList.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      messages.push({
        role:    'assistant',
        content: assistantText || null,
        tool_calls: toolCallList.map((tc) => ({
          id:   tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (const tc of toolCallList) {
        let result;
        try {
          const args = JSON.parse(tc.arguments || '{}');
          result = await performWebSearch(args.query);
        } catch (err) {
          result = `Search failed: ${err.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }

      toolRounds++;
      continue;
    }

    if (buffer.trim()) yield buffer.trim();
    return;
  }
}

// ── Vera (Anthropic) — streaming + tool-use ───────────────
async function* generateVeraVoice(systemPrompt, history, userMessage, userId) {
  let messages = mergeRolesLocal([...history, { role: 'user', content: userMessage }]);

  let buffer     = '';
  let toolRounds = 0;

  while (true) {
    const stream = anthropic.messages.stream({
      model:      VERA_MODEL,
      max_tokens: 600,
      system:     systemPrompt,
      messages,
      tools:      [webSearchToolAnthropic],
    });

    // Manual iteration (instead of `for await`) so EACH individual chunk
    // wait can be raced against the timeout, not just the initial
    // request — `for await` alone can't be interrupted once it's blocked
    // waiting on the next chunk, so a hang mid-stream would otherwise
    // never be caught at all, only a hang before the FIRST chunk would be
    // (which is all a plain request-level timeout like Aksel's would
    // protect against here).
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const { value: event, done } = await withTimeout(
        iterator.next(), STREAM_CHUNK_TIMEOUT_MS, 'Vera (Anthropic) stream chunk'
      );
      if (done) break;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        buffer += event.delta.text;
        const { complete, remainder } = splitCompleteSentences(buffer);
        buffer = remainder;
        for (const sentence of complete) yield sentence;
      }
    }

    const finalMessage = await withTimeout(stream.finalMessage(), GENERATION_TIMEOUT_MS, 'Vera (Anthropic) finalMessage');

    logUsage({
      model:        VERA_MODEL,
      callType:     'voice_vera',
      inputTokens:  finalMessage.usage?.input_tokens  || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0,
      userId,
    });

    const toolUseBlocks = finalMessage.content.filter((b) => b.type === 'tool_use');

    if (finalMessage.stop_reason === 'tool_use' && toolUseBlocks.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      messages.push({ role: 'assistant', content: finalMessage.content });

      const toolResults = [];
      for (const block of toolUseBlocks) {
        let result;
        try {
          result = await performWebSearch(block.input?.query);
        } catch (err) {
          result = `Search failed: ${err.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });

      toolRounds++;
      continue;
    }

    if (buffer.trim()) yield buffer.trim();
    return;
  }
}

// Local copy of handler.js's mergeRoles (Anthropic requires no two
// consecutive messages share a role) — small enough that duplicating it
// here beats adding a second cross-file dependency for one helper.
const mergeRolesLocal = (msgs) =>
  msgs.reduce((acc, msg) => {
    if (acc.length === 0) return [msg];
    const last = acc[acc.length - 1];
    if (last.role === msg.role) {
      return [...acc.slice(0, -1), { ...last, content: last.content + '\n' + msg.content }];
    }
    return [...acc, msg];
  }, []);

// ── Strip markdown formatting before speech ───────────────
// Bug fixed (30 Aug 2026): confirmed via real voice-call testing — Aksel
// (which tends toward structured, bulleted action-plan responses) reads
// literal symbols out loud ("asterisk asterisk Phase 1...") because
// nothing strips markdown syntax before text reaches TTS. The LLM has no
// way to know its output is headed for speech rather than a rendered
// chat UI — it writes normal markdown either way. Deliberately
// conservative: only strips syntax that's unambiguously markdown
// formatting (a bold/italic delimiter pair, a heading's leading #s, a
// bullet marker at the very start of a chunk) — never touches a hyphen
// or underscore that's just normal punctuation or part of a word
// ("well-known", "user_id" stay untouched). Order matters: bold (**/__)
// is stripped BEFORE italic (*/_) so a bold pair's own asterisks aren't
// mistaken for italic delimiters first.
const stripMarkdownForSpeech = (text) => {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\b_(.+?)_\b/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*•]\s+/, '')
    .trim();
};

module.exports = { generateAkselVoice, generateVeraVoice, splitCompleteSentences, stripMarkdownForSpeech };
