'use strict';
const { WebSocketServer, WebSocket } = require('ws');
const { deepgram }  = require('../lib/deepgram');
const { synthesize: googleSynthesize } = require('../lib/googleTTS');
const { supabase }  = require('../lib/supabase');
const { createRotator } = require('../lib/apiKeyRotator');

// ── STT connection rotation ───────────────────────────────────────────────
const DEEPGRAM_STT_KEYS = (process.env.DEEPGRAM_API_KEYS || process.env.DEEPGRAM_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

if (DEEPGRAM_STT_KEYS.length === 0) {
  throw new Error('[VoiceMobile] Missing DEEPGRAM_API_KEY or DEEPGRAM_API_KEYS in .env');
}

const sttRotator = createRotator(
  DEEPGRAM_STT_KEYS,
  (key) => key,
  (err) => /\b429\b/.test(err?.message || '') || /rate.?limit/i.test(err?.message || ''),
  () => 30000,
  { perAttemptTimeoutMs: 5000 }
);

console.log(`[VoiceMobile] ${DEEPGRAM_STT_KEYS.length} Deepgram API key(s) configured${DEEPGRAM_STT_KEYS.length > 1 ? ' for rotation' : ''} (STT).`);
const { detectRisk }                        = require('../safety/crisisDetector');
const { escalateToTheOnes, handleHighRisk } = require('../safety/theOnesEscalation');
const { extractLayer1, extractLayer2 }      = require('../lib/memoryExtractor');
const { buildSystemPrompt, buildHistory, CRISIS_DIRECTIVE } = require('../chat/handler');
const { generateAkselVoice, generateVeraVoice, stripMarkdownForSpeech } = require('./voiceGenerate');

const AKSEL_VOICE_MODEL = process.env.AKSEL_VOICE_MODEL || 'aura-orion-en';
const VERA_VOICE_MODEL  = process.env.VERA_VOICE_MODEL  || 'aura-amalthea-en';
const VOICE_MODEL_MAP   = { Aksel: AKSEL_VOICE_MODEL, Vera: VERA_VOICE_MODEL };

const GOOGLE_VOICE_AKSEL_ID = process.env.GOOGLE_VOICE_AKSEL_ID || 'id-ID-Standard-B';
const GOOGLE_VOICE_VERA_ID  = process.env.GOOGLE_VOICE_VERA_ID  || 'id-ID-Standard-A';
const GOOGLE_VOICE_MODEL_MAP = { Aksel: GOOGLE_VOICE_AKSEL_ID, Vera: GOOGLE_VOICE_VERA_ID };

const detectSpokenAgent = (transcript, gender, lastAgent) => {
  const mentionsAksel = /\baksel\b/i.test(transcript);
  const mentionsVera  = /\bvera\b/i.test(transcript);
  if (mentionsAksel && !mentionsVera) return 'Aksel';
  if (mentionsVera && !mentionsAksel) return 'Vera';
  if (lastAgent) return lastAgent;
  return gender === 'male' ? 'Aksel' : 'Vera';
};

const sendJSON = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

// Bug fixed (13 Sep 2026): confirmed via careful review after enabling
// real barge-in (client-side mic-gating removed — see VoiceCallMobile.tsx)
// — a cancellation flag being checked only BEFORE and AFTER this whole
// function call (in the caller's loop) leaves a real gap: if the
// interrupt happens WHILE the network call to Deepgram/Google TTS below
// is already in flight, that call can't be aborted mid-flight, and its
// resulting audio would previously still get sent to the client after
// the 'interrupted' signal already went out — the agent audibly
// finishing a fragment of a sentence it was told to stop. `isCancelled`
// is an optional callback checked AFTER the (potentially slow) TTS
// generation completes, right before actually sending — closing that
// exact gap without needing to abort the TTS network call itself.
const ttsAndSend = async (ws, text, agent, language, isCancelled) => {
  try {
    let buf;
    if (language === 'id') {
      buf = await googleSynthesize(text, GOOGLE_VOICE_MODEL_MAP[agent]);
    } else {
      const response = await deepgram.speak.v1.audio.generate({
        text,
        model:     VOICE_MODEL_MAP[agent],
        encoding:  'linear16',
        container: 'wav',
      });
      buf = Buffer.from(await response.arrayBuffer());
    }
    if (isCancelled && isCancelled()) return;
    if (ws.readyState === ws.OPEN) ws.send(buf);
  } catch (err) {
    console.error('[VoiceMobile] TTS error:', err.message);
  }
};

async function upsertVoiceSessionRow(session) {
  const { userId } = session;
  const exchangeCount = session.transcript.filter((t) => t.speaker === 'User').length;
  const label = exchangeCount === 1 ? '1 exchange' : `${exchangeCount} exchanges`;
  const content = `🎙 Voice call — ${label}`;

  if (!session.voiceRowId) {
    const { data } = await supabase
      .from('messages')
      .insert({ user_id: userId, sender: session.lastAgent, content, voice_transcript: [...session.transcript] })
      .select('id')
      .single();
    if (data) session.voiceRowId = data.id;
    return;
  }

  await supabase
    .from('messages')
    .update({ sender: session.lastAgent, content, voice_transcript: [...session.transcript] })
    .eq('id', session.voiceRowId);
}

const MIN_INTERRUPT_PATTERN = /\w{2,}/;

// Bug fixed (13 Sep 2026): confirmed via real testing — this file forked
// from the 21 Agu baseline, which PREDATES the echo-detection layer built
// later for the desktop path. Without it, ANY stray mic audio that leaks
// past client-side gating during agent speech (mobile's audio pipeline
// has proven less reliable than desktop's throughout today's whole
// investigation) gets treated as a genuine barge-in by the check below —
// the agent ends up "hearing" and replying to its own voice, producing
// exactly the back-and-forth self-conversation loop reported. Deliberately
// written fresh here rather than reconstructed from an earlier, similarly-
// named function that's known to have had its own "reset every turn" bug
// — recentAgentSpeech below ACCUMULATES through a turn instead of getting
// overwritten, specifically avoiding that class of gap.
const normalizeForEchoCheck = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();

const isLikelyEcho = (transcript, recentAgentSpeech) => {
  if (!recentAgentSpeech) return false;
  const normTranscript = normalizeForEchoCheck(transcript);
  if (!normTranscript) return false;
  const normAgent = normalizeForEchoCheck(recentAgentSpeech);

  // Most common case: the mic picked up a clean fragment of exactly what
  // the agent just said.
  if (normAgent.includes(normTranscript)) return true;

  // Fallback for a slightly garbled echo: what fraction of the
  // transcript's own words also appear anywhere in the agent's recent
  // speech. 70% threshold matches the historical value documented for
  // this project's earlier (desktop-side) echo work.
  const transcriptWords = normTranscript.split(/\s+/).filter(Boolean);
  if (transcriptWords.length === 0) return false;
  const agentWords = new Set(normAgent.split(/\s+/).filter(Boolean));
  const overlapCount = transcriptWords.filter((w) => agentWords.has(w)).length;
  return (overlapCount / transcriptWords.length) >= 0.7;
};

async function handleUtterance(ws, session, transcript) {
  if (!transcript || !transcript.trim()) return;

  // Bug fixed (13 Sep 2026): confirmed via real testing — echo was still
  // reaching a genuine response cycle even with the check below, because
  // it used to be nested inside `if (session.speaking)`. On some mobile
  // devices, TTS audio can keep audibly playing through the speaker for
  // LONGER than the 500ms client-side gating grace period — by the time
  // that trailing echo reaches the mic, session.speaking has ALREADY
  // flipped back to false server-side, so the old nested check never ran
  // at all, and the echo got treated as a genuine brand-new utterance.
  // Running this FIRST and unconditionally — before anything else,
  // regardless of current speaking state — closes that gap: it only ever
  // discards something that actually resembles what was just said
  // (recentAgentSpeech persists between turns until the NEXT response
  // starts, so this still works correctly even after speaking has
  // ended), never touches genuinely new speech.
  if (isLikelyEcho(transcript, session.recentAgentSpeech)) {
    console.log('[VoiceMobile] Discarding likely echo of agent\'s own speech:', JSON.stringify(transcript));
    return;
  }

  // NOTE (13 Sep 2026): real barge-in (audio flowing to the server even
  // while speaking) was tried and reverted the same day — echo was still
  // getting through often enough in practice to be genuinely disruptive.
  // Client-side mic-gating (VoiceCallMobile.tsx) is back, which means
  // audio simply never arrives here while session.speaking is true, so
  // this whole block is — same as in voiceSession.js (desktop) — present
  // but structurally unreachable. Left in rather than deleted in case a
  // properly-calibrated real-VAD attempt revisits this later.
  if (session.speaking) {
    if (!MIN_INTERRUPT_PATTERN.test(transcript)) {
      console.log('[VoiceMobile] Ignoring likely-noise fragment during active speech:', JSON.stringify(transcript));
      return;
    }
    if (session.activeGeneration) session.activeGeneration.cancelled = true;
    sendJSON(ws, { type: 'interrupted', agent: session.lastAgent });
  }

  const { userId, profile } = session;
  const agent = detectSpokenAgent(transcript, profile.gender, session.lastAgent);
  session.lastAgent = agent;

  sendJSON(ws, { type: 'transcript', text: transcript, agent });

  let safetyDirective = null;
  try {
    const detectorResult = await detectRisk(transcript, userId);
    if (detectorResult.risk === 'high') {
      const result = await handleHighRisk(userId, agent, detectorResult);
      if (result.action === 'intervene' && detectorResult.category === 'crisis') {
        safetyDirective = CRISIS_DIRECTIVE;
      }
      if (result.safetySupport) sendJSON(ws, { type: 'safety_support' });
    } else if (detectorResult.risk === 'needs_review') {
      const result = await escalateToTheOnes(userId, agent, transcript, detectorResult);
      if (result.action === 'intervene' && detectorResult.category === 'crisis') {
        safetyDirective = CRISIS_DIRECTIVE;
      }
      if (result.safetySupport) sendJSON(ws, { type: 'safety_support' });
    }
  } catch (err) {
    console.error('[VoiceMobile] Safety check error:', err.message);
  }

  const systemPrompt = await buildSystemPrompt(userId, agent, profile, safetyDirective);

  const { data: dbHistory } = await supabase
    .from('messages')
    .select('sender, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  const sessionHistoryAsMessages = session.transcript.map((t) => ({
    sender:  t.speaker === 'User' ? 'User' : t.speaker,
    content: t.text,
  }));

  const aiHistory = buildHistory(
    [...(dbHistory || []).reverse(), ...sessionHistoryAsMessages],
    agent
  );

  session.transcript.push({ speaker: 'User', text: transcript });
  await upsertVoiceSessionRow(session);

  const generator = agent === 'Aksel'
    ? generateAkselVoice(systemPrompt, aiHistory, transcript, userId)
    : generateVeraVoice(systemPrompt, aiHistory, transcript, userId);

  const myGeneration = { cancelled: false };
  session.activeGeneration = myGeneration;
  session.speaking = true;
  session.recentAgentSpeech = ''; // fresh for this turn — accumulates below as each sentence is actually spoken

  sendJSON(ws, { type: 'speaking_start', agent });

  let fullResponse  = '';
  let wasCancelled  = false;
  try {
    for await (const sentence of generator) {
      if (myGeneration.cancelled) { wasCancelled = true; break; }
      // Bug fixed (13 Sep 2026): confirmed via real testing — same gap
      // as voiceSession.js (desktop), see that file's own comment on this
      // exact line for the full history. Stripped once here so the
      // visible transcript, the TTS audio, AND recentAgentSpeech (used by
      // isLikelyEcho() above) all stay consistent with each other.
      const cleanSentence = stripMarkdownForSpeech(sentence);
      fullResponse += (fullResponse ? ' ' : '') + cleanSentence;
      session.recentAgentSpeech = fullResponse; // kept in sync with everything ACTUALLY spoken so far this turn
      sendJSON(ws, { type: 'agent_text', text: cleanSentence, agent });
      await ttsAndSend(ws, cleanSentence, agent, profile.language, () => myGeneration.cancelled);
      if (myGeneration.cancelled) { wasCancelled = true; break; }
    }
  } catch (err) {
    console.error(`[VoiceMobile] ${agent} generation error:`, err.message);
    if (!myGeneration.cancelled) {
      sendJSON(ws, { type: 'error', message: 'Sorry, I ran into an issue.' });
      try {
        const fallbackText = profile.language === 'id'
          ? 'Maaf, lagi ada gangguan koneksi. Coba lagi sebentar ya.'
          : "Sorry, I'm having some connection trouble. Give me a moment and try again.";
        sendJSON(ws, { type: 'agent_text', text: fallbackText, agent });
        await ttsAndSend(ws, fallbackText, agent, profile.language, () => myGeneration.cancelled);
        fullResponse = fallbackText;
      } catch (fallbackErr) {
        console.error(`[VoiceMobile] ${agent} fallback TTS also failed:`, fallbackErr.message);
      }
    }
  }

  if (session.activeGeneration === myGeneration) {
    session.speaking        = false;
    session.activeGeneration = null;
  }

  if (!wasCancelled) sendJSON(ws, { type: 'speaking_end', agent });

  if (fullResponse) {
    session.transcript.push({ speaker: agent, text: fullResponse });
    await upsertVoiceSessionRow(session);
  }

  if (!wasCancelled) {
    setImmediate(() => {
      extractLayer1(userId, transcript, [{ agent, content: fullResponse }]).catch(() => {});
      extractLayer2(userId).catch(() => {});
    });
  }
}

async function verifySession(token) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (!profile || !profile.is_active) return null;
  return { userId: data.user.id, profile };
}

// ── Attach the voice WebSocket server to the existing HTTP server ────────
// MOBILE-ONLY (13 Sep 2026): separate file, separate WebSocket path
// (/ws/voice-mobile), completely isolated from voiceSession.js (desktop,
// /ws/voice — confirmed stable via real multi-minute testing and now
// intentionally frozen). Mobile browsers hit a still-unresolved failure
// NOT reproducible on desktop under identical conditions (same backend
// code, same "no tab switching/no screen lock" constraints) — the exact
// mechanism is still unconfirmed (leading candidates from earlier
// investigation: Android's own audio-session mode management, which is
// outside what a web page can observe or control). This file starts from
// the SAME proven-stable core as voiceSession.js (original implementation
// + KeepAlive) plus two additional, self-contained layers worth having on
// mobile specifically — a ping/pong liveness check and Deepgram auto-
// reconnect-on-unexpected-close — without the open/close-per-turn
// restructuring from earlier today, which added complexity without
// confirmed benefit and is not carried over here. Safe to keep
// modifying/experimenting in THIS file — it cannot affect the desktop
// path no matter what changes here.
// See voiceSession.js's own comment on this exact same pattern for the
// full reasoning — noServer + shared 'upgrade' dispatch in server.js is
// required for two WS paths to coexist on one httpServer with the `ws`
// library.
function attachVoiceServerMobile() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const auth  = await verifySession(token);

    if (!auth) {
      sendJSON(ws, { type: 'error', message: 'Unauthorized' });
      ws.close();
      return;
    }

    const session = {
      userId: auth.userId, profile: auth.profile, lastAgent: null,
      transcript: [], voiceRowId: null,
      speaking: false, activeGeneration: null,
      recentAgentSpeech: '', // accumulates through a turn — see isLikelyEcho's own comment above
      finalizedTranscriptBuffer: '', // accumulates is_final segments until speech_final flushes them — see socket.on('message')'s own comment
    };

    let dgSocket;
    let dgUrl; // declared here (not `const` inside the try block below) so
               // the reconnect logic in dgSocket.on('close', ...) further
               // down — which is OUTSIDE that try block's scope — can
               // still see it. Confirmed via real testing: this exact
               // scoping mistake caused "dgUrl is not defined" to crash
               // every reconnect attempt.
    try {
      const MISHEARD_TERMS = [
        ['feta',  'Vera'],  ['Feta',  'Vera'],
        ['fair',  'Vera'],  ['Fair',  'Vera'],
        ['farrah', 'Vera'], ['Farrah', 'Vera'],
        ['fairah', 'Vera'], ['Fairah', 'Vera'],
        ['minos', 'news'],  ['Minos', 'News'],
        ['meals', 'news'],  ['Meals', 'News'],
      ];

      const language = session.profile.language === 'id' ? 'id' : 'en';
      console.log(`[VoiceMobile] STT language: profile.language="${session.profile.language}" -> sending language="${language}" to Deepgram`);
      const params = new URLSearchParams({
        model:            'nova-3',
        language,
        punctuate:        'true',
        smart_format:     'true',
        interim_results:  'true',
        utterance_end_ms: '1000',
        vad_events:       'true',
      });
      params.append('keyterm', 'Vera');
      params.append('keyterm', 'Aksel');
      params.append('keyterm', 'news');
      for (const [wrong, right] of MISHEARD_TERMS) {
        params.append('replace', `${wrong}:${right}`);
      }
      dgUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      dgSocket = await sttRotator.callWithRotation((apiKey) => new Promise((resolve, reject) => {
        const socket = new WebSocket(dgUrl, { headers: { Authorization: `Token ${apiKey}` } });
        socket.once('open', () => resolve(socket));
        socket.once('error', (err) => reject(err));
        socket.once('unexpected-response', (req, res) => {
          reject(new Error(`Deepgram rejected the connection: HTTP ${res.statusCode}`));
        });
      }));

      console.log(`[VoiceMobile] Deepgram STT connected for user ${session.userId}`);
    } catch (err) {
      console.error('[VoiceMobile] Deepgram STT connect error:', err instanceof Error ? err.message : err);
      sendJSON(ws, { type: 'error', message: 'Could not start voice session' });
      ws.close();
      return;
    }

    // Bug fixed (9 Sep 2026, RE-CONFIRMED stable 13 Sep 2026 via real
    // multi-minute desktop testing): Deepgram's STT WebSocket closes
    // itself (code 1011, NET-0001) if nothing arrives on it for 10
    // seconds straight. Sent unconditionally for the connection's whole
    // lifetime — harmless overhead when real audio is ALSO flowing.
    const dgKeepAliveTimer = setInterval(() => {
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 5000);

    let dgReconnectAttempts = 0;
    const MAX_DG_RECONNECT_ATTEMPTS = 3;

    // Bug fixed (13 Sep 2026): confirmed via real testing — the
    // close-with-reconnect handler was previously only attached to the
    // INITIAL Deepgram socket. Once a reconnection succeeded ONCE, the
    // new socket had message/error handlers re-attached (via the old
    // attachDgHandlers) but NOT this close-with-reconnect capability —
    // so a SECOND disconnection (confirmed common in real-world testing)
    // had nothing listening for it at all. The pipeline then died
    // silently and permanently: the main browser WebSocket stayed
    // completely healthy (heartbeat ping/pong kept working, proven via
    // real logs showing pong every 8s forever afterward), but dgSocket
    // pointed at a dead, closed socket forever, and audio forwarding
    // (`if (dgSocket.readyState === OPEN)`) silently dropped everything
    // from that point on, with zero error anywhere. This function is now
    // RECURSIVE — it calls itself on every successful reconnect — so
    // EVERY Deepgram socket, no matter how many times this session has
    // already reconnected, gets the full set of handlers including
    // reconnect-on-close, not just the very first one.
    const setupDeepgramSocket = (socket) => {
      socket.on('close', (code, reason) => {
        clearInterval(dgKeepAliveTimer);
        console.warn(`[VoiceMobile] Deepgram STT socket closed for user ${session.userId}: code=${code} reason=${reason.toString()}`);

        // Guards against a stale/old socket's close event arriving after
        // a NEWER reconnection has already taken over (dgSocket would no
        // longer === this specific socket in that case) — prevents a
        // duplicate/conflicting reconnect attempt.
        if (dgSocket !== socket || ws.readyState !== WebSocket.OPEN) return;

        dgReconnectAttempts++;
        if (dgReconnectAttempts > MAX_DG_RECONNECT_ATTEMPTS) {
          console.error(`[VoiceMobile] Deepgram reconnect exhausted (${dgReconnectAttempts} attempts) for user ${session.userId}`);
          sendJSON(ws, { type: 'error', message: 'Voice connection lost. Please try again.' });
          return;
        }

        console.warn(`[VoiceMobile] Reconnecting to Deepgram for user ${session.userId} (attempt ${dgReconnectAttempts}/${MAX_DG_RECONNECT_ATTEMPTS})...`);
        sttRotator.callWithRotation((apiKey) => new Promise((resolve, reject) => {
          const newSocket = new WebSocket(dgUrl, { headers: { Authorization: `Token ${apiKey}` } });
          newSocket.once('open', () => resolve(newSocket));
          newSocket.once('error', (err) => reject(err));
          newSocket.once('unexpected-response', (req, res) => {
            reject(new Error(`Deepgram rejected the connection: HTTP ${res.statusCode}`));
          });
        })).then((newSocket) => {
          dgSocket = newSocket;
          dgReconnectAttempts = 0;
          setupDeepgramSocket(newSocket); // recursive — this new socket ALSO gets full close+reconnect handling
          console.log(`[VoiceMobile] Deepgram STT reconnected for user ${session.userId}`);
        }).catch((err) => {
          console.error(`[VoiceMobile] Deepgram reconnect failed for user ${session.userId}:`, err.message);
          sendJSON(ws, { type: 'error', message: 'Voice connection lost. Please try again.' });
        });
      });

      socket.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type !== 'Results') return;
        const transcript = message.channel?.alternatives?.[0]?.transcript || '';

        // Bug fixed (14 Sep 2026): confirmed via research (Deepgram's own
        // docs, explicitly) — "Long utterances may have multiple is_final:
        // true responses before speech_final: true is returned." This used
        // to call handleUtterance() on EVERY is_final segment
        // individually, meaning a single spoken sentence internally split
        // into several segments got processed as several SEPARATE,
        // incomplete utterances — very likely the actual cause behind
        // seemingly nonsensical transcripts (a mid-sentence fragment out
        // of context, not a genuine mishearing). Now accumulates every
        // is_final segment into a running buffer and only calls
        // handleUtterance() once, with the FULL accumulated text, when
        // speech_final (an actual detected pause) arrives — the correct
        // pattern per Deepgram's own documented guidance.
        if (message.is_final) {
          if (transcript.trim()) {
            session.finalizedTranscriptBuffer =
              (session.finalizedTranscriptBuffer ? session.finalizedTranscriptBuffer + ' ' : '') + transcript.trim();
          }
          if (message.speech_final) {
            const fullTranscript = session.finalizedTranscriptBuffer;
            session.finalizedTranscriptBuffer = '';
            if (fullTranscript.trim()) {
              handleUtterance(ws, session, fullTranscript).catch((err) => {
                console.error('[VoiceMobile] handleUtterance error:', err.message);
              });
            }
          }
        } else if (transcript.trim()) {
          sendJSON(ws, { type: 'interim_transcript', text: transcript });
        }
      });

      socket.on('error', (err) => {
        console.error('[VoiceMobile] Deepgram STT error:', err.message);
      });
    };

    setupDeepgramSocket(dgSocket);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(data);
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'stop') ws.close();
          // Heartbeat liveness check — independent of conversation content
          // on purpose (a real, silent, thinking user looks identical to a
          // dead pipe from a "did we get a transcript" angle; an instant
          // pong regardless of speech content proves the transport itself
          // is alive).
          if (msg.type === 'ping') sendJSON(ws, { type: 'pong' });
        } catch {
        }
      }
    });

    ws.on('close', () => {
      clearInterval(dgKeepAliveTimer);
      try { dgSocket.close(); } catch {}
    });

    sendJSON(ws, {
      type:  'ready',
      agent: session.lastAgent || (auth.profile.gender === 'male' ? 'Aksel' : 'Vera'),
    });
  });

  return wss;
}

module.exports = { attachVoiceServerMobile, detectSpokenAgent, handleUtterance };
