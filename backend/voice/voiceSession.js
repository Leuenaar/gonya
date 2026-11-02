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
  throw new Error('[Voice] Missing DEEPGRAM_API_KEY or DEEPGRAM_API_KEYS in .env');
}

const sttRotator = createRotator(
  DEEPGRAM_STT_KEYS,
  (key) => key,
  (err) => /\b429\b/.test(err?.message || '') || /rate.?limit/i.test(err?.message || ''),
  () => 30000,
  { perAttemptTimeoutMs: 5000 }
);

console.log(`[Voice] ${DEEPGRAM_STT_KEYS.length} Deepgram API key(s) configured${DEEPGRAM_STT_KEYS.length > 1 ? ' for rotation' : ''} (STT).`);
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

// Bug fixed (13 Sep 2026): confirmed while reviewing mobile's barge-in
// enablement (see voiceSessionMobile.js's own comment on this exact same
// fix) — a cancellation flag checked only before/after this whole
// function leaves a gap: if cancellation happens WHILE the TTS network
// call below is already in flight, that call can't be aborted, and its
// audio would previously still reach the client after an 'interrupted'
// signal already went out. `isCancelled` closes that gap. Kept here for
// consistency even though desktop's own mic-gating currently prevents
// interrupt from being reachable at all — if that ever changes, this is
// already correct.
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
    console.error('[Voice] TTS error:', err.message);
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

async function handleUtterance(ws, session, transcript) {
  if (!transcript || !transcript.trim()) return;

  if (session.speaking) {
    if (!MIN_INTERRUPT_PATTERN.test(transcript)) {
      console.log('[Voice] Ignoring likely-noise fragment during active speech:', JSON.stringify(transcript));
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
    console.error('[Voice] Safety check error:', err.message);
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

  sendJSON(ws, { type: 'speaking_start', agent });

  let fullResponse  = '';
  let wasCancelled  = false;
  try {
    for await (const sentence of generator) {
      if (myGeneration.cancelled) { wasCancelled = true; break; }
      fullResponse += (fullResponse ? ' ' : '') + sentence;
      // Bug fixed (13 Sep 2026): confirmed via real testing — this call
      // was NEVER actually wired in here. stripMarkdownForSpeech() itself
      // was written correctly back on 30 Aug 2026 (see its own comment
      // in voiceGenerate.js) and exported, but nothing downstream ever
      // called it — Aksel in particular kept audibly reading out
      // "asterisk asterisk" etc. Stripped once here, reused for both the
      // visible transcript AND the TTS audio, so the two stay consistent
      // with each other rather than the transcript showing raw markdown
      // the audio doesn't.
      const cleanSentence = stripMarkdownForSpeech(sentence);
      sendJSON(ws, { type: 'agent_text', text: cleanSentence, agent });
      await ttsAndSend(ws, cleanSentence, agent, profile.language, () => myGeneration.cancelled);
      if (myGeneration.cancelled) { wasCancelled = true; break; }
    }
  } catch (err) {
    console.error(`[Voice] ${agent} generation error:`, err.message);
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
        console.error(`[Voice] ${agent} fallback TTS also failed:`, fallbackErr.message);
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
// DESKTOP-ONLY (13 Sep 2026): confirmed via extensive real-device bisection
// testing that this exact shape — the original 21 Agu implementation plus
// ONLY the KeepAlive timer below — runs a stable, multi-minute, multi-
// exchange voice call on desktop with zero drops. Mobile browsers hit a
// DIFFERENT, still-unresolved failure (confirmed NOT reproducible on
// desktop even under identical conditions: same backend, same "no tab
// switching/no screen lock" constraints) — rather than risk destabilizing
// this now-proven-stable desktop path by continuing to layer mobile-
// specific protections onto it, mobile gets its OWN separate WebSocket
// path and backend file (voiceSessionMobile.js, attached at /ws/voice-
// mobile in server.js) to iterate on freely. This file is intentionally
// left at its simplest proven-good state — please don't add heartbeat/
// reconnect/open-close-per-turn complexity back in here; that
// experimentation belongs in voiceSessionMobile.js instead.
// Bug fixed (13 Sep 2026): confirmed via research — the `ws` library does
// NOT support attaching multiple WebSocketServer instances to the SAME
// underlying HTTP server via the `server:` option, even with different
// `path` values (well-documented, longstanding limitation — connections
// to the second path get misrouted to the first, breaking BOTH). Since
// this file and voiceSessionMobile.js both need to share one httpServer,
// each now uses `noServer: true` and returns its own `wss` instance;
// server.js owns ONE shared 'upgrade' listener that inspects the request
// path and dispatches to the correct instance's handleUpgrade().
function attachVoiceServer() {
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
      finalizedTranscriptBuffer: '', // accumulates is_final segments until speech_final flushes them — see dgSocket.on('message')'s own comment
    };

    let dgSocket;
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
      console.log(`[Voice] STT language: profile.language="${session.profile.language}" -> sending language="${language}" to Deepgram`);
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
      const dgUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      dgSocket = await sttRotator.callWithRotation((apiKey) => new Promise((resolve, reject) => {
        const socket = new WebSocket(dgUrl, { headers: { Authorization: `Token ${apiKey}` } });
        socket.once('open', () => resolve(socket));
        socket.once('error', (err) => reject(err));
        socket.once('unexpected-response', (req, res) => {
          reject(new Error(`Deepgram rejected the connection: HTTP ${res.statusCode}`));
        });
      }));

      console.log(`[Voice] Deepgram STT connected for user ${session.userId}`);
    } catch (err) {
      console.error('[Voice] Deepgram STT connect error:', err instanceof Error ? err.message : err);
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

    dgSocket.on('close', (code, reason) => {
      clearInterval(dgKeepAliveTimer);
      console.warn(`[Voice] Deepgram STT socket closed for user ${session.userId}: code=${code} reason=${reason.toString()}`);
    });

    dgSocket.on('message', (data) => {
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
      // to call handleUtterance() on EVERY is_final segment individually,
      // meaning a single spoken sentence internally split into several
      // segments got processed as several SEPARATE, incomplete utterances
      // — very likely the actual cause behind seemingly nonsensical
      // transcripts (a mid-sentence fragment out of context, not a
      // genuine mishearing). Now accumulates every is_final segment into
      // a running buffer and only calls handleUtterance() once,  with the
      // FULL accumulated text, when speech_final (an actual detected
      // pause) arrives — the correct pattern per Deepgram's own
      // documented guidance.
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
              console.error('[Voice] handleUtterance error:', err.message);
            });
          }
        }
      } else if (transcript.trim()) {
        sendJSON(ws, { type: 'interim_transcript', text: transcript });
      }
    });

    dgSocket.on('error', (err) => {
      console.error('[Voice] Deepgram STT error:', err.message);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(data);
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'stop') ws.close();
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

module.exports = { attachVoiceServer, detectSpokenAgent, handleUtterance };
