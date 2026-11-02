import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import { remoteLog } from '../lib/remoteLog';
import './VoiceCall.css';

// ── Backend WS origin ─────────────────────────────────────
// ASSUMPTION: no existing frontend constant for the backend's base URL was
// available when this was written — adjust VITE_API_URL below if your
// project already defines this differently (e.g. in lib/supabase.ts).
const getVoiceWsUrl = (token: string): string => {
  const apiUrl = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
  const wsBase = apiUrl.replace(/^http/, 'ws');
  return `${wsBase}/ws/voice?token=${encodeURIComponent(token)}`;
};

const CONNECTION_TIMEOUT_MS = 12000;
// Heartbeat (12 Sep 2026) — see the ping/pong handler's own comment in
// voiceSession.js for the full reasoning. Interval is how often a ping
// goes out; timeout is how long without a pong before the connection is
// declared dead — set well above 2x the interval so one dropped packet
// on a flaky mobile connection doesn't false-positive a real, still-
// working call.
const HEARTBEAT_INTERVAL_MS = 8000;
const HEARTBEAT_TIMEOUT_MS  = 20000;

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';
type Agent = 'Aksel' | 'Vera';

interface TranscriptLine {
  id:      string;
  speaker: 'You' | Agent;
  text:    string;
}

interface Props {
  profile: UserProfile;
  onClose: () => void;
}

export default function VoiceCall({ profile, onClose }: Props) {
  const lang = profile.language;

  // TEMPORARY diagnostic (12 Sep 2026) — see remoteLog's own comment.
  // Confirms exactly when this component mounts, as a timeline anchor
  // for whatever other remoteLog lines show up around it.
  useEffect(() => {
    remoteLog('[VoiceCall] component MOUNTED');
  }, []);

  const [callState,    setCallState]    = useState<CallState>('idle');
  const [agent,        setAgent]        = useState<Agent | null>(null);
  const [speaking,     setSpeaking]     = useState(false);
  const [interimText,  setInterimText]  = useState('');
  const [transcript,   setTranscript]   = useState<TranscriptLine[]>([]);
  const [safetyBanner, setSafetyBanner] = useState(false);
  const [errorMsg,     setErrorMsg]     = useState('');
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Esc closes the transcript panel — previously the ONLY way to dismiss
  // it was ending the whole call, since the panel covers the End Call
  // button while open (bottom-sheet layout).
  useEffect(() => {
    if (!transcriptOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTranscriptOpen(false);
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [transcriptOpen]);

  const wsRef              = useRef<WebSocket | null>(null);
  const recorderRef        = useRef<MediaRecorder | null>(null);
  // Two independent readiness signals — server confirming it's attached to
  // Deepgram, and the mic/MediaRecorder finishing setup — can complete in
  // EITHER order. First-time mic permission prompts are slow (user has to
  // actually click "Allow"), so the server side can easily win the race;
  // recording must start once BOTH are true, regardless of which one
  // finished first, or it silently never starts at all.
  const serverReadyRef     = useRef(false);
  const streamRef          = useRef<MediaStream | null>(null);
  const audioQueueRef      = useRef<Blob[]>([]);
  const audioPlayerRef     = useRef<HTMLAudioElement | null>(null);
  const playingRef         = useRef(false);
  const connectTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bug fixed (12 Sep 2026): confirmed via real testing (3 mobile
  // devices — 2 phones, 1 tablet — all reproduced it, desktop never
  // did) that a voice call would silently go dead after 1-2 exchanges
  // with a completely clean browser console AND clean server logs (just
  // a normal-code WebSocket closure, no error anywhere). Researched the
  // pattern that combination points to: mobile OS/browser background
  // throttling — Android's Doze mode suspends WebSocket connections once
  // the screen locks and idles, and Safari on iOS closes background-tab
  // WebSockets outright around the 5-minute mark. A voice call, unlike a
  // dedicated calling app, has no "foreground service" exemption from
  // this, and a person just listening without touching the screen is
  // exactly the scenario that lets the screen auto-lock mid-call. This
  // is OS-level suspension, not a JS exception, which is exactly why
  // neither the console nor the server logged anything. The Screen Wake
  // Lock API (now supported in ~94%+ of browsers globally, including
  // Safari 16.4+) directly addresses the actual trigger — the screen
  // locking — rather than working around its symptoms after the fact.
  const wakeLockRef = useRef<any>(null);

  // Heartbeat (12 Sep 2026) — see HEARTBEAT_INTERVAL_MS's own comment
  // above for the full reasoning.
  const lastPongAtRef        = useRef(Date.now());
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Audio-reactive visualizer plumbing ──
  const canvasRef      = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsSourceRef   = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef         = useRef<number | null>(null);
  const speakingRef    = useRef(false); // mirrors `speaking` state for the draw loop, which
                                          // runs outside React's render cycle

  // ── Mic gating (5 Sep 2026) ────────────────────────────────────────────
  // Bug fixed: `echoCancellation: true` (30 Aug 2026 fix, above in
  // getUserMedia) confirmed via real testing to NOT be enough on its own —
  // particularly on Android speakerphone, where the physical distance
  // between speaker and mic is small enough that the browser's own AEC
  // can reduce but not eliminate the agent's own voice leaking back in.
  // A second server-side layer (isLikelyEcho() in voiceSession.js,
  // comparing transcript similarity) ALSO wasn't reliable enough — it
  // resets its comparison buffer every new turn, so a SINGLE echo chunk
  // slipping through with just-below-threshold similarity was enough to
  // trigger a new turn, wiping the buffer and letting every SUBSEQUENT
  // echo chunk through uncontested (confirmed from real transcripts: one
  // early miss cascaded into a self-conversation "You: For example, / You:
  // are you looking" — the agent's own prior sentence, fragmented).
  //
  // Researched fix (docs: Coval's Voice AI Echo Cancellation guide,
  // "Architectural Solutions for Echo"): stop trying to DETECT echo after
  // the fact and eliminate the path it travels instead — simply never
  // send microphone audio to the server while the agent is speaking, plus
  // a short grace window after, to let the physical echo tail decay. This
  // is a deliberate trade-off: barge-in (interrupting the agent mid-
  // sentence) is disabled while this is in effect. Given barge-in was
  // ALSO not working correctly before (it was misfiring on echo, not
  // genuine interruptions), trading a broken feature for a working call
  // is the right call for Phase 1 — a later phase can reintroduce
  // barge-in via real audio-energy (RMS) detection instead of transcript
  // similarity, which does not have this same failure mode.
  const speakingEndedAtRef = useRef(0);
  const MIC_GATE_GRACE_MS  = 500;

  useEffect(() => { speakingRef.current = speaking; }, [speaking]);

  // See wakeLockRef's own comment above for the full diagnosis. Wrapped
  // in try/catch per the API's own convention — it fails gracefully
  // (unsupported browser, low battery, etc.) without breaking the call
  // itself; a person just loses this specific protection on that device.
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      }
    } catch {
      // Intentionally silent — see comment above.
    }
  };

  const releaseWakeLock = () => {
    wakeLockRef.current?.release?.().catch(() => {});
    wakeLockRef.current = null;
  };

  // Heartbeat (12 Sep 2026) — see HEARTBEAT_INTERVAL_MS's own comment
  // and voiceSession.js's ping/pong handler for the full reasoning.
  // Deliberately declares the call dead and surfaces that to the person
  // rather than leaving them stuck on a "Listening..." status that will
  // never resolve on its own — a clear "connection lost, try again" is
  // strictly better than silence that looks identical to the agent just
  // waiting for them to speak.
  const stopHeartbeat = () => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  };

  const startHeartbeat = (socket: WebSocket) => {
    lastPongAtRef.current = Date.now(); // baseline reset right as the call goes active
    stopHeartbeat(); // guard against a stray double-start
    heartbeatIntervalRef.current = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'ping' }));

      const silentForMs = Date.now() - lastPongAtRef.current;
      if (silentForMs > HEARTBEAT_TIMEOUT_MS) {
        remoteLog(`[VoiceCall] heartbeat timeout — no pong for ${silentForMs}ms, declaring the connection dead`);
        stopHeartbeat();
        setErrorMsg(t('errConnectionRetry', lang));
        setCallState('error');
        stopMic();
        stopVisualizer();
        releaseWakeLock();
        try { socket.close(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  // Best practice per MDN/web.dev: a held wake lock is automatically
  // released by the OS the moment the tab/page becomes hidden for ANY
  // reason (briefly checking a notification, an incoming call banner,
  // etc.) — even if the user comes right back. Re-requesting it here
  // when the page becomes visible again, but only while a call is
  // actually still active, closes that gap without holding a lock the
  // whole time the app is open.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && callState === 'active') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [callState]);

  const clearConnectTimeout = () => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  };

  // ── Playback: queue TTS chunks and play strictly one at a time ──
  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) return;

    playingRef.current = true;
    const url = URL.createObjectURL(next);

    let audioEl = audioPlayerRef.current;
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.crossOrigin = 'anonymous';
      audioPlayerRef.current = audioEl;
      // Wire this element into the analyser graph exactly once — an
      // HTMLMediaElement can only ever be adopted by ONE
      // MediaElementAudioSourceNode for its whole lifetime, so this has to
      // happen on first creation, not on every chunk.
      try {
        const ctx = audioCtxRef.current;
        if (ctx) {
          const source = ctx.createMediaElementSource(audioEl);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 128;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          ttsSourceRef.current = source;
          ttsAnalyserRef.current = analyser;
        }
      } catch {
        // Visualizer is cosmetic — if this fails for any reason, playback
        // itself still works fine without it.
      }
    }

    audioEl.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      playingRef.current = false;
      playNext();
    };
    audioEl.onended = cleanup;
    audioEl.onerror = cleanup;
    audioEl.play().catch(cleanup);
  }, []);

  // Barge-in: drop everything queued and stop whatever's playing RIGHT
  // NOW — called the instant the server confirms the user interrupted the
  // agent. Letting the current chunk finish "naturally" before stopping
  // would defeat the point; the whole reason barge-in exists is so the
  // agent shuts up immediately, not after it finishes its sentence.
  // Starts the recorder once BOTH readiness signals are in, no matter
  // which order they arrived in — called from both the 'ready' message
  // handler and right after the recorder itself is created. Whichever of
  // the two happens second is the one that actually triggers start().
  const tryStartRecording = useCallback(() => {
    if (serverReadyRef.current && recorderRef.current && recorderRef.current.state === 'inactive') {
      recorderRef.current.start(250);
    }
  }, []);

  const stopAudioImmediately = useCallback(() => {
    audioQueueRef.current = [];
    const audioEl = audioPlayerRef.current;
    if (audioEl) {
      audioEl.onended = null; // prevent the pending cleanup->playNext chain from firing after this
      audioEl.onerror = null;
      audioEl.pause();
      audioEl.currentTime = 0;
    }
    playingRef.current = false;
  }, []);

  const enqueueAudio = useCallback((blob: Blob) => {
    audioQueueRef.current.push(blob);
    playNext();
  }, [playNext]);

  // ── Visualizer draw loop ──
  // Radial spectrum around a glowing core. Reacts to the mic while
  // listening, to TTS playback while the agent is speaking, and falls back
  // to a slow ambient "breathing" pulse when neither is active yet (idle /
  // connecting) so it never looks like a dead, static circle.
  const startVisualizer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const BAR_COUNT = 56;
    const size = canvas.width; // canvas is always drawn square
    const cx = size / 2;
    const cy = size / 2;
    const innerRadius = size * 0.16;
    const maxBarLen   = size * 0.13;

    let t0 = 0;

    const draw = (time: number) => {
      if (!t0) t0 = time;
      const elapsed = (time - t0) / 1000;

      ctx2d.clearRect(0, 0, size, size);

      const activeAnalyser = speakingRef.current ? ttsAnalyserRef.current : micAnalyserRef.current;
      let data: Uint8Array<ArrayBuffer> | null = null;
      if (activeAnalyser) {
        data = new Uint8Array(new ArrayBuffer(activeAnalyser.frequencyBinCount));
        activeAnalyser.getByteFrequencyData(data);
      }

      // Average amplitude (0..1) drives the core glow's intensity.
      let avg = 0;
      if (data && data.length) {
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        avg = sum / data.length / 255;
      } else {
        // Ambient idle pulse — gentle sine wave, never fully flat.
        avg = 0.12 + Math.sin(elapsed * 1.4) * 0.06;
      }

      // Core glow
      const glowRadius = innerRadius * (1.15 + avg * 0.5);
      const gradient = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
      gradient.addColorStop(0,   `rgba(0,229,255,${0.30 + avg * 0.35})`);
      gradient.addColorStop(0.7, `rgba(0,229,255,${0.10 + avg * 0.15})`);
      gradient.addColorStop(1,   'rgba(0,229,255,0)');
      ctx2d.fillStyle = gradient;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx2d.fill();

      // Core ring
      ctx2d.strokeStyle = `rgba(0,229,255,${0.55 + avg * 0.35})`;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, innerRadius, 0, Math.PI * 2);
      ctx2d.stroke();

      // Radial spectrum bars
      for (let i = 0; i < BAR_COUNT; i++) {
        const angle = (i / BAR_COUNT) * Math.PI * 2;
        let value: number;
        if (data && data.length) {
          const idx = Math.floor((i / BAR_COUNT) * data.length);
          value = data[idx] / 255;
        } else {
          // Idle: a slow rotating ripple rather than uniform bars.
          value = 0.08 + Math.max(0, Math.sin(angle * 3 + elapsed * 1.6)) * 0.1;
        }
        const barLen = 4 + value * maxBarLen;
        const x1 = cx + Math.cos(angle) * innerRadius;
        const y1 = cy + Math.sin(angle) * innerRadius;
        const x2 = cx + Math.cos(angle) * (innerRadius + barLen);
        const y2 = cy + Math.sin(angle) * (innerRadius + barLen);

        ctx2d.strokeStyle = `rgba(0,229,255,${0.35 + value * 0.55})`;
        ctx2d.lineWidth = 2;
        ctx2d.shadowBlur = 6;
        ctx2d.shadowColor = 'rgba(0,229,255,0.5)';
        ctx2d.beginPath();
        ctx2d.moveTo(x1, y1);
        ctx2d.lineTo(x2, y2);
        ctx2d.stroke();
      }
      ctx2d.shadowBlur = 0;

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  const stopVisualizer = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // ── WebSocket + mic lifecycle ──
  const startCall = useCallback(async () => {
    setCallState('connecting');
    setErrorMsg('');
    serverReadyRef.current = false; // fresh for this call — a previous call's leftover true would skip the wait entirely

    connectTimeoutRef.current = setTimeout(() => {
      setErrorMsg(t('vcTimeout', lang));
      setCallState('error');
      wsRef.current?.close();
    }, CONNECTION_TIMEOUT_MS);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        clearConnectTimeout();
        setErrorMsg(t('vcNoSession', lang));
        setCallState('error');
        return;
      }

      const ws = new WebSocket(getVoiceWsUrl(token));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let msg: any;
          try { msg = JSON.parse(event.data); } catch { return; }

          switch (msg.type) {
            case 'ready':
              clearConnectTimeout();
              setAgent(msg.agent);
              setCallState('active');
              // Only now does the server guarantee it's actually attached
              // to Deepgram and listening for audio — starting the
              // recorder any earlier risked the first chunk(s) arriving
              // before the server had wired up its forwarding, silently
              // dropped. Whether the recorder itself is ALREADY created at
              // this point depends on how fast getUserMedia() resolved —
              // tryStartRecording() only actually starts it once both
              // sides are ready, so this is safe to call unconditionally
              // even if the recorder isn't built yet (that side will
              // trigger the actual start() itself, once it's ready).
              serverReadyRef.current = true;
              tryStartRecording();
              // TEMPORARY (13 Sep 2026): disabled ONLY for testing against
              // checkpoint-A backend (voiceSession.js from 21 Agu, before
              // ping/pong existed) — that backend never answers a ping, so
              // leaving this on would make the heartbeat itself kill the
              // call ~20s in and contaminate the test. Re-enable once back
              // on a backend that actually answers ping with pong.
              // startHeartbeat(ws);
              break;
            case 'pong':
              lastPongAtRef.current = Date.now();
              break;
            case 'transcript':
              setAgent(msg.agent);
              setInterimText('');
              setTranscript((prev) => [...prev, { id: crypto.randomUUID(), speaker: 'You', text: msg.text }]);
              break;
            case 'interim_transcript':
              setInterimText(msg.text);
              break;
            case 'speaking_start':
              setAgent(msg.agent);
              setSpeaking(true);
              setTranscript((prev) => [...prev, { id: crypto.randomUUID(), speaker: msg.agent, text: '' }]);
              break;
            case 'agent_text':
              setTranscript((prev) => {
                if (prev.length === 0) return prev;
                const last = prev[prev.length - 1];
                if (last.speaker !== msg.agent) return prev;
                const updated = { ...last, text: (last.text ? last.text + ' ' : '') + msg.text };
                return [...prev.slice(0, -1), updated];
              });
              break;
            case 'speaking_end':
              setSpeaking(false);
              speakingEndedAtRef.current = Date.now();
              break;
            case 'interrupted':
              // Server confirmed the user barged in — stop the agent's
              // audio right now rather than letting the queued sentences
              // play out. `speaking_start` for the NEW response (already
              // being generated server-side) arrives right after this.
              stopAudioImmediately();
              setSpeaking(false);
              break;
            case 'safety_support':
              setSafetyBanner(true);
              break;
            case 'error':
              clearConnectTimeout();
              setErrorMsg(msg.message || t('vcGenericError', lang));
              setCallState('error');
              break;
            default:
              break;
          }
        } else {
          // Binary frame = one sentence of TTS audio (WAV). The matching
          // text already arrived via the 'agent_text' event just before this.
          const blob = new Blob([event.data], { type: 'audio/wav' });
          enqueueAudio(blob);
        }
      };

      ws.onerror = () => {
        remoteLog('[VoiceCall] ws.onerror fired');
        clearConnectTimeout();
        setErrorMsg(t('errConnectionRetry', lang));
        setCallState('error');
      };

      ws.onclose = (event) => {
        remoteLog(`[VoiceCall] ws.onclose fired — code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`);
        clearConnectTimeout();
        setCallState((prev) => (prev === 'error' ? prev : 'ended'));
        stopMic();
        stopVisualizer();
        releaseWakeLock();
        stopHeartbeat();
      };

      // ── Mic capture ──
      // Bug fixed (30 Aug 2026): confirmed via real testing — without
      // explicit echoCancellation, the mic could pick up the agent's own
      // TTS audio playing back through the device's speakers, and
      // Deepgram would transcribe THAT as if it were the user talking —
      // surfacing as the agent seeming to "answer its own questions" or
      // respond to fragments of its own prior sentence. A bare
      // `{ audio: true }` leaves this up to the browser's own default,
      // which isn't reliably strong enough on its own (especially
      // without headphones) — requesting it explicitly, along with noise
      // suppression and auto gain (standard companions for a voice-call
      // use case), is the more robust setup.
      // Requested here alongside getUserMedia — both are naturally
      // gated behind the same user-gesture (the Start Call button),
      // and there's no reason to wait any longer than that to start
      // protecting against the screen locking mid-call.
      await requestWakeLock();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // TEMPORARY diagnostic (12 Sep 2026) — see remoteLog's own
      // comment. User's own hypothesis: Android can silently reset the
      // audio session from "communication mode" (routes audio through
      // the voice-call stream — what the OS volume control affects
      // while this is active) back to normal "media" mode mid-session,
      // which can invalidate an in-flight mic/audio session at the OS
      // level without the browser surfacing any JS error. JavaScript
      // can't directly ask Android which mode it's in, but an audio
      // track getting force-muted or ended, or the AudioContext getting
      // interrupted, are the closest observable symptoms of exactly
      // that kind of OS-level reset — instrumenting all three here.
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.onmute   = () => remoteLog('[VoiceCall] mic audio track MUTED by the browser/OS (not by user code)');
        audioTrack.onunmute = () => remoteLog('[VoiceCall] mic audio track unmuted again');
        audioTrack.onended  = () => remoteLog('[VoiceCall] mic audio track ENDED unexpectedly (not via our own stopMic())');
      }

      // AudioContext must be created/resumed from within a user-gesture
      // handler (this function only ever runs from the Start Call button's
      // onClick) — creating it any earlier would get suspended by the
      // browser's autoplay policy.
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx: AudioContext = new AudioContextCtor();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      audioCtx.onstatechange = () => remoteLog(`[VoiceCall] AudioContext state changed to "${audioCtx.state}"`);

      const micSource = audioCtx.createMediaStreamSource(stream);
      const micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 128;
      micSource.connect(micAnalyser);
      micAnalyserRef.current = micAnalyser;

      startVisualizer();

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorderRef.current = recorder;
      recorder.onerror = (e: any) => remoteLog(`[VoiceCall] MediaRecorder error: ${e?.error?.name || 'unknown'} ${e?.error?.message || ''}`);
      recorder.onstop  = () => remoteLog('[VoiceCall] MediaRecorder stopped (via our own stopMic(), or forced by the browser/OS)');
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || ws.readyState !== WebSocket.OPEN) return;
        // See speakingEndedAtRef's own comment above for the full
        // reasoning — this is the actual gate: skip sending this chunk
        // entirely while the agent is speaking, or for a short window
        // right after, rather than sending it and hoping something
        // downstream correctly recognizes it as echo.
        const withinGraceWindow = Date.now() - speakingEndedAtRef.current < MIC_GATE_GRACE_MS;
        if (speakingRef.current || withinGraceWindow) return;
        ws.send(e.data);
      };
      // Covers the OTHER ordering of the race: if 'ready' already arrived
      // while getUserMedia() was still waiting on the permission prompt,
      // serverReadyRef is already true by the time we get here — this is
      // what actually starts the recorder in that case, since the 'ready'
      // handler's own call earlier found no recorder yet and no-op'd.
      tryStartRecording();
    } catch (err) {
      clearConnectTimeout();
      setErrorMsg(t('vcMicDenied', lang));
      setCallState('error');
    }
  }, [lang, enqueueAudio, startVisualizer, stopAudioImmediately, tryStartRecording]);

  const stopMic = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    recorderRef.current = null;
    streamRef.current = null;
  };

  const endCall = useCallback(() => {
    clearConnectTimeout();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
    wsRef.current?.close();
    stopMic();
    stopVisualizer();
    releaseWakeLock();
    stopHeartbeat();
    setCallState('ended');
  }, []);

  // Clean up on unmount no matter how the call ended.
  useEffect(() => {
    return () => {
      // TEMPORARY diagnostic (12 Sep 2026) — see remoteLog's own
      // comment. Placed FIRST in this cleanup, before anything else
      // runs, so it fires even if a later cleanup step were to somehow
      // throw. This is the single most important log line in this
      // whole investigation — it fires if and only if this component
      // is being torn down, telling us definitively whether that's
      // happening at all, independent of WHY.
      remoteLog('[VoiceCall] component UNMOUNTING');
      clearConnectTimeout();
      wsRef.current?.close();
      stopMic();
      stopVisualizer();
      releaseWakeLock();
      stopHeartbeat();
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const agentLabel = agent === 'Aksel' ? 'Aksel' : agent === 'Vera' ? 'Vera' : t('vcVoiceCall', lang);

  return (
    <div className="vc-overlay">
      <button className="vc-close-btn" onClick={onClose}>×</button>

      <div className="vc-center">
        <div className="vc-agent-name">{agentLabel}</div>

        <canvas ref={canvasRef} className="vc-canvas" width={340} height={340} />

        <div className="vc-status">
          {callState === 'idle'       && t('vcIdleHint', lang)}
          {callState === 'connecting' && t('vcConnecting', lang)}
          {callState === 'active' && speaking && t('vcAgentSpeaking', lang, { agent: agentLabel })}
          {callState === 'active' && !speaking && t('vcListening', lang)}
          {callState === 'ended'      && t('vcCallEnded', lang)}
          {callState === 'error'      && errorMsg}
        </div>

        {interimText && callState === 'active' && (
          <div className="vc-interim">{interimText}</div>
        )}

        {safetyBanner && (
          <div className="vc-safety-banner">{t('vcSafetySupportShown', lang)}</div>
        )}

        <div className="vc-controls">
          {(callState === 'idle' || callState === 'ended' || callState === 'error') && (
            <button className="vc-btn-start" onClick={startCall}>{t('vcStartCall', lang)}</button>
          )}
          {(callState === 'connecting' || callState === 'active') && (
            <button className="vc-btn-end" onClick={endCall}>{t('vcEndCall', lang)}</button>
          )}
        </div>

        {transcript.length > 0 && (
          <button className="vc-transcript-toggle" onClick={() => setTranscriptOpen((p) => !p)}>
            {transcriptOpen ? t('vcHideTranscript', lang) : t('vcShowTranscript', lang)}
          </button>
        )}
      </div>

      {transcriptOpen && (
        <>
          <div className="vc-transcript-backdrop" onClick={() => setTranscriptOpen(false)} />
          <div className="vc-transcript" onClick={(e) => e.stopPropagation()}>
            {transcript.map((line) => (
              <div key={line.id} className={`vc-line ${line.speaker === 'You' ? 'you' : 'agent'}`}>
                <span className="vc-line-speaker">{line.speaker}</span>
                <span className="vc-line-text">{line.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
