import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import { remoteLog } from '../lib/remoteLog';
import './VoiceCall.css';

// ── Backend WS origin ─────────────────────────────────────
// MOBILE-ONLY (13 Sep 2026): connects to /ws/voice-mobile instead of
// /ws/voice — see voiceSessionMobile.js's own comment for the full
// reasoning behind the split. Heartbeat is intentionally RE-ENABLED here
// (unlike the desktop VoiceCall.tsx, where it's commented out) because
// voiceSessionMobile.js actually answers ping with pong; the desktop
// backend deliberately doesn't.
const getVoiceWsUrl = (token: string): string => {
  const apiUrl = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
  const wsBase = apiUrl.replace(/^http/, 'ws');
  return `${wsBase}/ws/voice-mobile?token=${encodeURIComponent(token)}`;
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
// TEMPORARY diagnostic (13 Sep 2026) — see lastMicDataAtRef's own
// comment further down for the full reasoning.
const MIC_DATA_STALE_MS = 15000;

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

export default function VoiceCallMobile({ profile, onClose }: Props) {
  const lang = profile.language;

  // TEMPORARY diagnostic (12 Sep 2026) — see remoteLog's own comment.
  // Confirms exactly when this component mounts, as a timeline anchor
  // for whatever other remoteLog lines show up around it.
  useEffect(() => {
    remoteLog('[VoiceCall] component MOUNTED');
  }, []);

  // TEMPORARY diagnostic (13 Sep 2026) — genuinely NEW blind spot closed
  // here, not yet tried anywhere in this whole investigation: every prior
  // instrumentation attempt only reports from SPECIFIC, already-suspected
  // spots (mount/unmount/ws events/track events/AudioContext/
  // MediaRecorder). If there's an uncaught JS exception or unhandled
  // promise rejection happening somewhere ENTIRELY OUTSIDE those specific
  // spots — a place nobody has thought to suspect yet — none of that
  // instrumentation would ever see it. This catches literally anything
  // uncaught, anywhere on the page, for the whole lifetime of this
  // component, closing that gap regardless of where the real problem
  // turns out to be.
  useEffect(() => {
    const handleGlobalError = (event: ErrorEvent) => {
      remoteLog(`[VoiceCall] UNCAUGHT ERROR: ${event.message} at ${event.filename}:${event.lineno}:${event.colno} — stack: ${event.error?.stack || '(no stack)'}`);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const detail = reason instanceof Error ? `${reason.message} — stack: ${reason.stack}` : String(reason);
      remoteLog(`[VoiceCall] UNHANDLED PROMISE REJECTION: ${detail}`);
    };
    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
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

  // MOBILE-ONLY (13 Sep 2026): confirmed technique used in production by
  // Spotify Web/YouTube Music for exactly this class of problem — a
  // continuously-playing TRUE-SILENT audio element (genuinely silent PCM
  // data, deliberately NOT muted — muted media can be optimized away by
  // the browser and stops counting as "active audio") keeps the OS's
  // audio session bound/active for the whole call. The suspected root
  // cause behind today's whole investigation was Android resetting the
  // audio-session mode specifically during the "agent not speaking, no
  // real audio flowing" listening window — this keeps something audio-
  // shaped continuously flowing through that exact window instead.
  const silentAudioRef    = useRef<HTMLAudioElement | null>(null);
  const silentAudioUrlRef = useRef<string | null>(null);

  // Heartbeat (12 Sep 2026) — see HEARTBEAT_INTERVAL_MS's own comment
  // above for the full reasoning.
  const lastPongAtRef        = useRef(Date.now());
  // TEMPORARY diagnostic (13 Sep 2026) — confirmed via real testing that
  // a session can go unresponsive with ZERO ws.onclose, ZERO error, and
  // heartbeat never declaring the connection dead (ping/pong keeps
  // working fine) — meaning the CONNECTION itself stays alive while
  // something ELSE stops. This tracks whether MediaRecorder is still
  // actually firing ondataavailable AT ALL, updated at the very top of
  // that handler before any gating logic runs — if this goes stale while
  // the connection is otherwise healthy, that proves the mic capture
  // pipeline itself silently died at the OS/browser level, independent
  // of the WebSocket.
  const lastMicDataAtRef     = useRef(Date.now());
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

  // ── Mic gating (5 Sep 2026, briefly removed 13 Sep 2026, RESTORED same
  // day) ───────────────────────────────────────────────────────────────
  // Bug fixed: `echoCancellation: true` (30 Aug 2026 fix — NOTE: mobile
  // now uses `echoCancellation: false` instead, for an unrelated reason;
  // see getUserMedia's own comment below) confirmed via real testing to
  // not be enough on its own — particularly on Android speakerphone,
  // where the physical distance between speaker and mic is small enough
  // that AEC can reduce but not eliminate the agent's own voice leaking
  // back in. A second server-side layer (isLikelyEcho() in
  // voiceSessionMobile.js, comparing transcript similarity) also wasn't
  // reliable enough on its own.
  //
  // Researched fix (docs: Coval's Voice AI Echo Cancellation guide,
  // "Architectural Solutions for Echo"): stop trying to DETECT echo after
  // the fact and eliminate the path it travels instead — never send
  // microphone audio to the server while the agent is speaking, plus a
  // short grace window after.
  //
  // RE-REVERTED (13 Sep 2026, same day): briefly removed this gate
  // entirely to enable real barge-in, backed by isLikelyEcho() running
  // unconditionally PLUS a second, independent mic-volume signal
  // (loudness — see the removed mic_volume send that used to live in
  // startVisualizer's draw loop, and voiceSessionMobile.js's now-removed
  // MIN_INTERRUPT_VOLUME check). Confirmed via real testing that echo was
  // STILL getting through often enough to be genuinely disruptive despite
  // both signals — reverted back to this structural gate rather than
  // continuing to tune content/volume thresholds. Barge-in is disabled
  // again while this is in effect; a later attempt could explore proper
  // real-time RMS-based VAD with a dedicated calibration pass instead of
  // reusing the visualizer's analyser opportunistically, but that's a
  // separate, deliberate future effort, not a quick re-flip of this gate.
  const speakingEndedAtRef = useRef(0);
  const MIC_GATE_GRACE_MS  = 500;

  // Separately (kept as-is, independent of the gate above): a safety net
  // for `speaking` getting stuck `true` permanently if a 'speaking_end'
  // message never arrives for some turn — confirmed via real testing (a
  // real session logged this stuck for 16.4 seconds straight). Forces
  // speaking back to false after a max reasonable duration if the server
  // never sends the real signal. Cleared normally by the actual
  // 'speaking_end'/'interrupted' handlers below — this only ever fires as
  // a fallback.
  const speakingSafetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SPEAKING_SAFETY_TIMEOUT_MS = 15000;

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

  // See silentAudioRef's own comment above for the full reasoning. Builds
  // a minimal, valid WAV file in memory — 1 second of genuine 16-bit PCM
  // silence at 8kHz (all-zero samples; ArrayBuffer is zero-initialized by
  // default, so no explicit fill is needed) — rather than fetching a
  // static asset, so this has zero dependency on any file being deployed
  // alongside the app.
  const createSilentWavBlob = (): Blob => {
    const sampleRate  = 8000;
    const numSamples   = sampleRate; // 1 second
    const bytesPerSample = 2; // 16-bit
    const dataSize     = numSamples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view   = new DataView(buffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    // PCM samples themselves are left as-is (all zero = silence).

    return new Blob([buffer], { type: 'audio/wav' });
  };

  const startSilentAudioKeepAlive = () => {
    try {
      const url = URL.createObjectURL(createSilentWavBlob());
      silentAudioUrlRef.current = url;
      const audio = new Audio(url);
      audio.loop = true;
      // Deliberately NOT muted — see silentAudioRef's own comment above
      // for why muted playback doesn't achieve the same thing.
      audio.play().catch(() => {});
      silentAudioRef.current = audio;
    } catch {
      // Best-effort — the call still works without this specific
      // protection if it fails for any reason on a given device.
    }
  };

  const stopSilentAudioKeepAlive = () => {
    silentAudioRef.current?.pause();
    silentAudioRef.current = null;
    if (silentAudioUrlRef.current) {
      URL.revokeObjectURL(silentAudioUrlRef.current);
      silentAudioUrlRef.current = null;
    }
  };

  // Best practice matching the wake-lock re-request pattern above — if
  // the OS pauses this out from under us (e.g. briefly backgrounding),
  // retry playback once visibility returns, but only while a call is
  // actually still active.
  useEffect(() => {
    const handleVisibilityForAudio = () => {
      if (document.visibilityState === 'visible' && callState === 'active') {
        silentAudioRef.current?.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityForAudio);
    return () => document.removeEventListener('visibilitychange', handleVisibilityForAudio);
  }, [callState]);

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
    lastMicDataAtRef.current = Date.now(); // same baseline reset for the mic-data check below
    stopHeartbeat(); // guard against a stray double-start
    heartbeatIntervalRef.current = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'ping' }));

      // TEMPORARY diagnostic (13 Sep 2026) — see lastMicDataAtRef's own
      // comment. Piggybacks on this SAME interval (rather than a new
      // timer) purely to reuse its existing 8-second cadence — this
      // check is logically independent of the pong-timeout check right
      // below it. MIC_DATA_STALE_MS set well above MediaRecorder's own
      // 250ms timeslice so a single scheduling hiccup can't false-
      // positive this.
      const micSilentForMs = Date.now() - lastMicDataAtRef.current;
      if (micSilentForMs > MIC_DATA_STALE_MS) {
        remoteLog(`[VoiceCall] MediaRecorder has NOT fired ondataavailable in ${micSilentForMs}ms — mic pipeline appears dead while the WebSocket connection itself is still open (readyState=${socket.readyState}). This is independent of the ping/pong check below.`);
      }

      const silentForMs = Date.now() - lastPongAtRef.current;
      if (silentForMs > HEARTBEAT_TIMEOUT_MS) {
        remoteLog(`[VoiceCall] heartbeat timeout — no pong for ${silentForMs}ms, declaring the connection dead`);
        stopHeartbeat();
        setErrorMsg(t('errConnectionRetry', lang));
        setCallState('error');
        stopMic();
        stopVisualizer();
        releaseWakeLock();
        stopSilentAudioKeepAlive();
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

          // TEMPORARY diagnostic (13 Sep 2026) — confirmed via real
          // testing: the safety-net timeout DOES fire (server-confirmed
          // via its own log) and the backend visibly continues activity
          // afterward, but the UI shows ZERO visual change at all —
          // "Listening..." never updates, no error, nothing. This proves
          // or disproves the next most likely explanation without
          // needing browser devtools at all: does the CLIENT actually
          // ever RECEIVE another message after getting stuck? If this
          // line stops appearing entirely after the stuck point despite
          // server logs showing continued activity, the problem is
          // message DELIVERY (server thinks it sent something, client
          // never got it). If messages keep arriving here but the UI
          // still never changes, the problem is in React rendering
          // specifically, not the connection.
          remoteLog(`[VoiceCall] ws message received: type=${msg.type}`);

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
              // Re-enabled for mobile — see getVoiceWsUrl's own comment
              // above: voiceSessionMobile.js actually answers ping with
              // pong, unlike the desktop backend.
              startHeartbeat(ws);
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
              // See speakingSafetyTimeoutRef's own comment above.
              if (speakingSafetyTimeoutRef.current) clearTimeout(speakingSafetyTimeoutRef.current);
              speakingSafetyTimeoutRef.current = setTimeout(() => {
                remoteLog('[VoiceCall] Speaking safety-net timeout fired — forcing speaking back to false (no speaking_end arrived in time)');
                setSpeaking(false);
                speakingEndedAtRef.current = Date.now();
              }, SPEAKING_SAFETY_TIMEOUT_MS);
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
              if (speakingSafetyTimeoutRef.current) {
                clearTimeout(speakingSafetyTimeoutRef.current);
                speakingSafetyTimeoutRef.current = null;
              }
              setSpeaking(false);
              speakingEndedAtRef.current = Date.now();
              break;
            case 'interrupted':
              // Server confirmed the user barged in — stop the agent's
              // audio right now rather than letting the queued sentences
              // play out. `speaking_start` for the NEW response (already
              // being generated server-side) arrives right after this.
              if (speakingSafetyTimeoutRef.current) {
                clearTimeout(speakingSafetyTimeoutRef.current);
                speakingSafetyTimeoutRef.current = null;
              }
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
        if (speakingSafetyTimeoutRef.current) clearTimeout(speakingSafetyTimeoutRef.current);
        stopSilentAudioKeepAlive();
      };

      // ── Mic capture ──
      // UPDATED (13 Sep 2026) — supersedes the reasoning below. Real
      // testing found the whole mobile voice investigation's failure
      // pattern (Part of this project's history — see voiceSessionMobile.js
      // comments) reproduces on Chrome but NOT on Firefox on the exact
      // same device/network. Chrome's own internal WebRTC engine is
      // documented to request a special OS "communication" audio-session
      // mode specifically WHEN echoCancellation is requested via
      // getUserMedia — Firefox's media stack does not share this
      // behavior. Hypothesis: THIS is what destabilizes Chrome's audio
      // session on Android, not something inherently unfixable about
      // mobile browsers in general. Turning browser-level echo
      // cancellation off here removes the trigger for that request
      // entirely. This does NOT reopen the original 30 Agu problem this
      // setting was added for (the mic picking up the agent's own TTS
      // audio acoustically) — isLikelyEcho() on the server (added since,
      // see voiceSessionMobile.js) independently catches exactly that
      // same class of echo by comparing the transcript's CONTENT against
      // what the agent just said, regardless of how the audio signal
      // itself was captured. Deliberately mobile-only — VoiceCall.tsx
      // (desktop) is frozen and keeps echoCancellation: true, since
      // desktop was never observed to have this problem in the first
      // place and there's no reason to change a proven-stable file.
      //
      // ORIGINAL reasoning (30 Aug 2026), kept for context: without
      // explicit echoCancellation, the mic could pick up the agent's own
      // TTS audio playing back through the device's speakers, and
      // Deepgram would transcribe THAT as if it were the user talking —
      // surfacing as the agent seeming to "answer its own questions" or
      // respond to fragments of its own prior sentence.
      // Requested here alongside getUserMedia — both are naturally
      // gated behind the same user-gesture (the Start Call button),
      // and there's no reason to wait any longer than that to start
      // protecting against the screen locking mid-call.
      await requestWakeLock();
      startSilentAudioKeepAlive();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
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
        // Updated BEFORE the early-return below — see lastMicDataAtRef's
        // own comment above. This must fire even for an empty/unsent
        // chunk, since the question here is "is MediaRecorder still
        // producing data at all", not "did we send anything."
        lastMicDataAtRef.current = Date.now();
        if (e.data.size === 0 || ws.readyState !== WebSocket.OPEN) return;
        // See the "Mic gating" comment above (near speakingEndedAtRef)
        // for the full history — this is the actual gate: skip sending
        // this chunk entirely while the agent is speaking, or for a
        // short window right after.
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
    if (speakingSafetyTimeoutRef.current) clearTimeout(speakingSafetyTimeoutRef.current);
    stopSilentAudioKeepAlive();
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
      if (speakingSafetyTimeoutRef.current) clearTimeout(speakingSafetyTimeoutRef.current);
      stopSilentAudioKeepAlive();
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
