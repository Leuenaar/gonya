import { useState, useEffect, useRef } from 'react';
import { signIn, signUp, signInWithGoogle, getProfile, apiFetch, supabase, type UserProfile } from '../lib/supabase';
import './AuthScreen.css';
import GonyaMascot, { type GonyaState } from '../components/GonyaMascot';
import PrivacyPolicy from './PrivacyPolicy';
import TermsOfService from './TermsOfService';
import { t } from '../lib/i18n';

// No `profile` exists yet on this pre-login screen — no reliable language
// signal to read. Every t() call below passes null explicitly, resolving
// to English (the app-wide default for an unknown preference). The
// Interface Language toggle below only sets the NEW account's future
// preference — it deliberately does not loop back to change this
// screen's own text mid-signup.

interface Props {
  onSuccess: (profile: UserProfile) => void;
  // Set by App.tsx (24 Aug 2026) when its onAuthStateChange listener
  // determines a just-established session (from EITHER email/password
  // OR Google OAuth) needs device/OTP verification — see App.tsx's
  // resolveDeviceTrust() for why that check now lives there instead of
  // here. When present, this screen skips straight to the OTP-entry UI
  // with the email pre-filled, reusing the exact same verify/resend flow
  // that used to only be reachable from this file's own sign-in submit.
  initialOtpEmail?: string | null;
}

type Mode  = 'signin' | 'signup' | 'forgot' | 'otp';
type Stage = 'form' | 'verify_email';

const SPECIAL_CHARS = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;
const REMEMBER_KEY  = 'gonya_remember_me';
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000;

const getStrength = (pwd: string) => {
  if (!pwd) return { score: 0, label: '', cls: '' };
  let s = 0;
  if (pwd.length >= 8)         s++;
  if (/[A-Z]/.test(pwd))       s++;
  if (/[0-9]/.test(pwd))       s++;
  if (SPECIAL_CHARS.test(pwd)) s++;
  const map = ['', 'weak', 'fair', 'good', 'strong'] as const;
  const lbl = ['', t('asStrengthWeak', null), t('asStrengthFair', null), t('asStrengthGood', null), t('asStrengthStrong', null)];
  return { score: s, label: lbl[s], cls: map[s] };
};

const isValidPassword = (pwd: string) =>
  pwd.length >= 8 && SPECIAL_CHARS.test(pwd);

const getLockout = () => {
  try {
    const raw = localStorage.getItem('gonya_lockout');
    if (!raw) return null;
    const { until, count } = JSON.parse(raw);
    return { until, count };
  } catch { return null; }
};
const setLockout = (count: number) => {
  const until = count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
  localStorage.setItem('gonya_lockout', JSON.stringify({ until, count }));
};
const clearLockout = () => localStorage.removeItem('gonya_lockout');

const PLACEHOLDER_LEFT = [
  'AI deployment patterns shift across enterprise stacks',
  'Cloud-native SaaS migration frameworks gain traction',
  'Critical API vulnerabilities disclosed in major platforms',
  'Enterprise software consolidation trends accelerating',
  'B2B SaaS valuations under pressure amid enterprise cuts',
  'Agentic workflows redefine human-software interaction',
];

const PLACEHOLDER_RIGHT = [
  'Stackwise — AI-powered SaaS audit platform',
  'Rippling HRIS 3.0 — unified workforce management',
  'Notion AI for Teams — collaborative intelligence',
  'Linear Enterprise Suite — engineering ops at scale',
  'Retool Workflows v2 — internal tool automation',
  'Hex raises $50M — collaborative data notebooks',
];

const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const EyeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.66 3.79M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

export default function AuthScreen({ onSuccess, initialOtpEmail }: Props) {
  const [mode,           setMode]           = useState<Mode>(initialOtpEmail ? 'otp' : 'signin');
  const [privacyOpen,    setPrivacyOpen]    = useState(false);
  const [termsOpen,      setTermsOpen]      = useState(false);
  const [agreedToTerms,  setAgreedToTerms]  = useState(false);
  const [stage,          setStage]          = useState<Stage>('form');
  const [email,          setEmail]          = useState('');
  const [credential,     setCredential]     = useState('');
  const [username,       setUsername]       = useState('');
  const [password,       setPassword]       = useState('');
  const [confirmPwd,     setConfirmPwd]     = useState('');
  const [language,       setLanguage]       = useState<'id' | 'en'>('en');
  const [rememberMe,     setRememberMe]     = useState(false);
  const [error,          setError]          = useState('');
  const [info,           setInfo]           = useState('');
  const [loading,        setLoading]        = useState(false);
  const [googleLoad,     setGoogleLoad]     = useState(false);
  const [demoLoad,       setDemoLoad]       = useState(false);
  const [otpCode,        setOtpCode]        = useState(['', '', '', '']);
  const [otpEmail,       setOtpEmail]       = useState(initialOtpEmail || '');
  const [lockoutLeft,    setLockoutLeft]    = useState(0);
  const [clock,          setClock]          = useState('');
  const [showPassword,   setShowPassword]   = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [mascotEntry,    setMascotEntry]    = useState<'idle' | 'warp-in'>('idle');
  const prevModeRef = useRef<Mode>('signin');

  // If a new initialOtpEmail arrives after mount (e.g. App.tsx's listener
  // resolves a SECOND sign-in attempt while this component is already
  // showing), jump into the OTP screen for it too — mirrors the
  // useState initializer above, which only runs once on first mount.
  useEffect(() => {
    if (initialOtpEmail) {
      setOtpEmail(initialOtpEmail);
      setMode('otp');
    }
  }, [initialOtpEmail]);

  // ── Ambient mascot mood ──────────────────────────────────────────
  // No longer reacts to the password field at all. It just sits there
  // blinking (idle), drifts off to sleep after a stretch of no activity
  // (matches the app-wide "3min idle → sleeping" convention), and every
  // ~2 minutes fires off a random emotion for a few seconds.
  type AutoMood = 'idle' | 'sleeping' | 'happy' | 'worried' | 'sad' | 'focused' | 'muttering' | 'walking';
  const SLEEP_AFTER_MS    = 3 * 60 * 1000;
  const EMOTION_EVERY_MS  = 2 * 60 * 1000;
  const EMOTION_LASTS_MS  = 3600;
  const EMOTION_POOL: AutoMood[] = ['happy', 'worried', 'sad', 'focused', 'muttering', 'walking'];

  const [autoMood, setAutoMood] = useState<AutoMood>('idle');
  const lastActivityRef = useRef<number>(Date.now());

  // Track page activity to know when to fall asleep / wake up
  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
      setAutoMood(m => (m === 'sleeping' ? 'idle' : m));
    };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(ev => window.addEventListener(ev, markActive, { passive: true }));
    return () => events.forEach(ev => window.removeEventListener(ev, markActive));
  }, []);

  // Fall asleep after a stretch of no activity
  useEffect(() => {
    const id = setInterval(() => {
      if (mode === 'signup') return;
      if (Date.now() - lastActivityRef.current >= SLEEP_AFTER_MS) {
        setAutoMood(m => (m === 'idle' ? 'sleeping' : m));
      }
    }, 2000);
    return () => clearInterval(id);
  }, [mode]);

  // Random emotion every ~2 minutes, only while calmly idle (not asleep,
  // not already mid-emotion)
  useEffect(() => {
    const id = setInterval(() => {
      if (mode === 'signup') return;
      setAutoMood(prev => {
        if (prev !== 'idle') return prev;
        const next = EMOTION_POOL[Math.floor(Math.random() * EMOTION_POOL.length)];
        setTimeout(() => setAutoMood(m => (m === next ? 'idle' : m)), EMOTION_LASTS_MS);
        return next;
      });
    }, EMOTION_EVERY_MS);
    return () => clearInterval(id);
  }, [mode]);

  // Coming back from Sign Up to Sign In: mascot warps back in.
  useEffect(() => {
    if (prevModeRef.current === 'signup' && mode !== 'signup') {
      setMascotEntry('warp-in');
      const t = setTimeout(() => setMascotEntry('idle'), 700);
      prevModeRef.current = mode;
      return () => clearTimeout(t);
    }
    prevModeRef.current = mode;
  }, [mode]);

  // Mascot only lives on the Sign In flow. Sign Up warps it away entirely.
  const mascotFaceState: GonyaState = mode === 'signup' ? 'idle' : autoMood;

  const mascotPositionClass =
    mode === 'signup'           ? 'warp-out'
    : mascotEntry === 'warp-in' ? 'warp-in'
    : '';

  const otpRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  const strength   = getStrength(password);
  const req8chars  = password.length >= 8;
  const reqSpecial = SPECIAL_CHARS.test(password);
  const reqMatch   = password === confirmPwd && confirmPwd.length > 0;

  const reset = () => {
    setError(''); setInfo(''); setEmail(''); setCredential('');
    setUsername(''); setPassword(''); setConfirmPwd('');
    setOtpCode(['', '', '', '']);
    setShowPassword(false); setShowConfirmPwd(false);
  };
  const switchMode = (m: Mode) => { reset(); setMode(m); };

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const pad = (x: number) => String(x).padStart(2, '0');
      const days   = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      setClock(
        `${days[n.getUTCDay()]}, ${pad(n.getUTCDate())} ${months[n.getUTCMonth()]} ${n.getUTCFullYear()} · ${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())} UTC`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const lockout = getLockout();
    if (!lockout || lockout.count < MAX_ATTEMPTS) return;
    const check = () => {
      const remaining = Math.max(0, Math.ceil((lockout.until - Date.now()) / 1000));
      setLockoutLeft(remaining);
      if (remaining <= 0) clearLockout();
    };
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) { setCredential(saved); setRememberMe(true); }
    } catch {}
  }, []);

  useEffect(() => {
    if (mode === 'otp') setTimeout(() => otpRefs[0].current?.focus(), 100);
  }, [mode]);

  const handleGoogle = async () => {
    setGoogleLoad(true); setError('');
    try { await signInWithGoogle(); } catch { setError(t('asErrGoogleFailed', null)); setGoogleLoad(false); }
  };

  // Bug fixed/designed (9 Sep 2026): calls Supabase's own signInAnonymously()
  // directly — supabase (the raw client) is already imported above for
  // other auth calls, so this doesn't need a new wrapper in lib/supabase.ts.
  // Mirrors handleGoogle()'s pattern exactly: this function's job ends the
  // moment a session is established. App.tsx's onAuthStateChange listener
  // picks up the resulting SIGNED_IN event automatically from there (same
  // as it already does for Google/email sign-in) — no extra routing logic
  // needed here.
  const handleTryDemo = async () => {
    setDemoLoad(true); setError('');
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) { setError(error.message); setDemoLoad(false); }
    } catch {
      setError(t('asErrDemoFailed', null));
      setDemoLoad(false);
    }
  };

  const handleSubmit = async () => {
    setError(''); setInfo('');
    
    // --- TUKANG PUKUL BUAT BYPASS ENTER ---
    if (!agreedToTerms) {
      setError(t('asErrMustAgree', null));
      return;
    }
    // --------------------------------------

    const lockout = getLockout();
    if (lockout && lockout.count >= MAX_ATTEMPTS && lockout.until > Date.now()) {
      setError(t('asErrLockedMin', null, { n: Math.ceil((lockout.until - Date.now()) / 60000) }));
      return;
    }
    setLoading(true);
    try {
      if (mode === 'signup') {
        if (!username.trim()) { setError(t('asErrUsernameReq', null)); return; }
        if (!email.trim())    { setError(t('asErrEmailReq', null)); return; }
        if (!isValidPassword(password)) { setError(t('asErrPwdRequirements', null)); return; }
        if (password !== confirmPwd)    { setError(t('asErrPwdNoMatch', null)); return; }
        const { error: signUpErr } = await signUp(email, password, username.trim(), language);
        if (signUpErr) { setError(signUpErr.message); return; }
        setStage('verify_email'); return;
      }
      if (mode === 'signin') {
        const isEmail  = credential.includes('@');
        let loginEmail = credential.trim();
        if (!isEmail) {
          const res  = await apiFetch(`/api/user/find-email?handle=${encodeURIComponent(credential.trim())}`);
          const data = await res.json();
          if (data.status !== 'success') { setError(t('asErrUsernameNotFound', null)); return; }
          loginEmail = data.email;
        }
        const { error: signInErr } = await signIn(loginEmail, password);
        if (signInErr) {
          const lo = getLockout();
          const newCount = (lo?.count || 0) + 1;
          setLockout(newCount);
          setError(newCount >= MAX_ATTEMPTS ? t('asErrTooManyAttempts', null) : signInErr.message);
          return;
        }
        clearLockout();
        if (rememberMe) { try { localStorage.setItem(REMEMBER_KEY, credential); } catch {} }
        else            { try { localStorage.removeItem(REMEMBER_KEY); } catch {} }

        // Simplified (24 Aug 2026): device-check, getProfile(), and the
        // resulting screen transition all now happen centrally in
        // App.tsx's onAuthStateChange listener, which fires automatically
        // the moment signIn() above establishes a session — see that
        // file's resolveDeviceTrust() for why. This function's job ends
        // here; the listener takes it from here (including routing back
        // into this SAME screen's OTP UI via the initialOtpEmail prop,
        // if verification turns out to be needed).
      }
    } catch (err: any) {
      setError(err?.message || t('asErrUnexpected', null));
    } finally {
      setLoading(false);
    }
  };

  const handleOtpInput = (i: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...otpCode]; next[i] = val.slice(-1); setOtpCode(next);
    if (val && i < 3) otpRefs[i + 1].current?.focus();
  };

  const handleOtpKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpCode[i] && i > 0) otpRefs[i - 1].current?.focus();
  };

  const handleOtpVerify = async () => {
    const code = otpCode.join('');
    if (code.length < 4) { setError(t('asErrEnterCode', null)); return; }
    setLoading(true); setError('');
    try {
      const res  = await apiFetch('/api/user/verify-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ otp: code }),
      });
      const data = await res.json();
      if (data.status !== 'success') { setError(t('asErrInvalidCode', null)); return; }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError(t('asErrSessionExpired', null)); switchMode('signin'); return; }
      const profile = await getProfile(session.user.id);
      if (!profile) { setError(t('asErrLoadProfile', null)); return; }
      await apiFetch('/api/user/last-login', { method: 'POST' });
      onSuccess(profile);
    } catch { setError(t('asErrVerificationFail', null)); }
    finally { setLoading(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
  };

  const renderPasswordField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    show: boolean,
    setShow: (v: boolean) => void,
  ) => (
    <div className="auth-field-group">
      <label className="auth-field-label">{label}</label>
      <div className="auth-pwd-wrap">
        <input
          className="auth-input"
          type={show ? 'text' : 'password'}
          placeholder="••••••••••••"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          style={{ paddingRight: '40px' }}
        />
        <button
          type="button"
          className="auth-pwd-toggle"
          onMouseDown={e => e.preventDefault()}
          onClick={() => setShow(!show)}
          tabIndex={-1}
          disabled={loading}
          aria-label={show ? t('asHidePassword', null) : t('asShowPassword', null)}
        >
          {show ? <EyeOffIcon/> : <EyeIcon/>}
        </button>
      </div>
    </div>
  );

  const renderMasthead = (statusLabel = t('asControlLocked', null)) => (
    <header className="auth-masthead">
      <div className="auth-masthead-title">Gonya</div>
      <div className="auth-masthead-bar">
        <span className="auth-clock">{clock}</span>
        <span className="auth-motto">Thought, undivided.</span>
        <span className="auth-control-locked">[ {statusLabel} ]</span>
      </div>
    </header>
  );

  const renderLeftSide = () => (
    <aside className="auth-side auth-side-l" aria-hidden="true">
      <h2 className="auth-side-title">MACRO INTEL</h2>
      <div>
        {PLACEHOLDER_LEFT.map((h, i) => (
          <div key={i} className="auth-side-item">
            <span className="auth-side-src">FEED // ENCRYPTED</span>
            <p className="auth-side-headline">{h}</p>
          </div>
        ))}
      </div>
      <div className="auth-side-footer">[ ENCRYPTED_STREAM_NODE_A ]</div>
    </aside>
  );

  const renderRightSide = () => (
    <aside className="auth-side auth-side-r" aria-hidden="true">
      <h2 className="auth-side-title">MICRO RADAR</h2>
      <div>
        {PLACEHOLDER_RIGHT.map((h, i) => (
          <div key={i} className="auth-side-item">
            <span className="auth-side-src">FEED // ENCRYPTED</span>
            <p className="auth-side-headline">{h}</p>
          </div>
        ))}
      </div>
      <div className="auth-side-footer">[ ENCRYPTED_STREAM_NODE_B ]</div>
    </aside>
  );

  const renderFooter = () => (
    <footer className="auth-footer">
      <span>GONYA SECURITY PROTOCOLS V1.0</span>
      <span className="auth-footer-links">
        <button className="auth-footer-link" onClick={() => setTermsOpen(true)}>TERMS OF SERVICE</button>
        <button className="auth-footer-link" onClick={() => setPrivacyOpen(true)}>PRIVACY POLICY</button>
      </span>
      <span>RESTRICTED ACCESS ONLY</span>
    </footer>
  );

  const renderPanelCorners = () => (
    <>
      <div className="auth-panel-corner auth-panel-tl"/>
      <div className="auth-panel-corner auth-panel-tr"/>
      <div className="auth-panel-corner auth-panel-bl"/>
      <div className="auth-panel-corner auth-panel-br"/>
      <div className={`auth-panel-mascot ${mascotPositionClass}`}>
        <GonyaMascot state={mascotFaceState} size={90} />
      </div>
    </>
  );

  if (stage === 'verify_email') return (
    <div className="auth-root">
      <div className="auth-scanline" aria-hidden="true"/>
      {renderMasthead(t('asAwaitingVerif', null))}
      <main className="auth-main">
        {renderLeftSide()}
        <section className="auth-center">
          <div className="auth-panel">
            {renderPanelCorners()}
            <div className="auth-panel-header">
              <span className="auth-panel-label">{t('asVerificationRequired', null)}</span>
              <h1 className="auth-panel-title">{t('asCheckYourEmail', null)}</h1>
            </div>
            <div className="auth-verify-body">
              <div className="auth-verify-icon">✉</div>
              <p className="auth-verify-msg">{t('asConfirmLinkSent', null, { email: '' })}<strong>{email}</strong>.</p>
              <p className="auth-verify-sub">{t('asClickLinkActivate', null)}</p>
              <p className="auth-verify-hint">{t('asCheckSpam', null)}</p>
            </div>
            <button className="auth-submit" style={{ marginTop: 28 }} onClick={() => { reset(); setStage('form'); setMode('signin'); }}>
              {t('asGoToSignIn', null)}
            </button>
          </div>
        </section>
        {renderRightSide()}
      </main>
      {renderFooter()}
    </div>
  );

  if (mode === 'otp') return (
    <div className="auth-root">
      <div className="auth-scanline" aria-hidden="true"/>
      {renderMasthead(t('asDeviceCheck', null))}
      <main className="auth-main">
        {renderLeftSide()}
        <section className="auth-center">
          <div className="auth-panel">
            {renderPanelCorners()}
            <div className="auth-panel-header">
              <span className="auth-panel-label">{t('asDeviceVerification', null)}</span>
              <h1 className="auth-panel-title">{t('asEnterCode', null)}</h1>
            </div>
            <div className="auth-verify-body">
              <p className="auth-verify-msg">{t('asCodeSentTo', null, { email: '' })}<strong>{otpEmail}</strong>.</p>
              <p className="auth-verify-sub">{t('asEnterBelowContinue', null)}</p>
              <p className="auth-verify-hint">{t('asCheckSpam', null)}</p>
            </div>
            <div className="auth-otp-row">
              {otpCode.map((digit, i) => (
                <input key={i} ref={otpRefs[i]} className="auth-otp-input"
                  type="text" inputMode="numeric" maxLength={1} value={digit}
                  onChange={e => handleOtpInput(i, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(i, e)} disabled={loading}/>
              ))}
            </div>
            {error && <p className="auth-error">&gt; {error}</p>}
            <button className="auth-submit" onClick={handleOtpVerify} disabled={loading || otpCode.join('').length < 4}>
              {loading ? t('asVerifyingBtn', null) : t('asVerifyDeviceBtn', null)}
            </button>
            <div className="auth-mode-toggle">
              <button className="auth-link-btn" onClick={() => { reset(); setMode('signin'); }}>{t('asBackToSignIn', null)}</button>
            </div>
          </div>
        </section>
        {renderRightSide()}
      </main>
      {renderFooter()}
    </div>
  );

  if (mode === 'forgot') return (
    <div className="auth-root">
      <div className="auth-scanline" aria-hidden="true"/>
      {renderMasthead(t('asPasswordReset', null))}
      <main className="auth-main">
        {renderLeftSide()}
        <section className="auth-center">
          <div className="auth-panel">
            {renderPanelCorners()}
            <div className="auth-panel-header">
              <span className="auth-panel-label">{t('asAccountRecovery', null)}</span>
              <h1 className="auth-panel-title">{t('asResetPasswordTitle', null)}</h1>
            </div>
            <div className="auth-fields">
              <div className="auth-field-group">
                <label className="auth-field-label">Email</label>
                <input className="auth-input" type="email" placeholder="your@email.com"
                  value={email} onChange={e => setEmail(e.target.value)} autoFocus disabled={loading}/>
              </div>
            </div>
            {error && <p className="auth-error">&gt; {error}</p>}
            {info  && <p className="auth-info">&gt; {info}</p>}
            <button className="auth-submit" onClick={async () => {
              if (!email.trim()) { setError(t('asErrEmailReq', null)); return; }
              setLoading(true); setError('');
              try {
                const { error: e } = await supabase.auth.resetPasswordForEmail(email.trim());
                if (e) setError(e.message);
                else   setInfo(t('asInfoResetSent', null));
              } catch { setError(t('asErrResetLinkFailed', null)); }
              finally { setLoading(false); }
            }} disabled={loading}>
              {loading ? t('asSendingBtn', null) : t('asSendResetLinkBtn', null)}
            </button>
            <div className="auth-mode-toggle" style={{ marginTop: 20 }}>
              <button className="auth-link-btn" onClick={() => switchMode('signin')}>{t('asBackToSignIn', null)}</button>
            </div>
          </div>
        </section>
        {renderRightSide()}
      </main>
      {renderFooter()}
    </div>
  );

  if (privacyOpen) return <PrivacyPolicy onBack={() => setPrivacyOpen(false)} />;
  if (termsOpen)   return <TermsOfService onBack={() => setTermsOpen(false)} />;

  return (
    <div className="auth-root">
      <div className="auth-scanline" aria-hidden="true"/>
      {renderMasthead(mode === 'signin' ? t('asSignIn', null) : t('asRegister', null))}
      <main className="auth-main">
        {renderLeftSide()}
        <section className="auth-center">
          <div className="auth-panel auth-panel-accented">
            {renderPanelCorners()}
            <span className="auth-panel-label">AUTHENTICATION</span>
            <div className="auth-tabs">
              <button
                className={`auth-tab ${mode === 'signin' ? 'active' : ''}`}
                onClick={() => switchMode('signin')}
                disabled={loading || demoLoad}
              >
                {t('asSignIn', null)}
              </button>
              <button
                className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
                onClick={() => switchMode('signup')}
                disabled={loading || demoLoad}
              >
                {t('asSignUp', null)}
              </button>
            </div>

            {lockoutLeft > 0 && (
              <div className="auth-lockout-banner">
                {t('asAccountLocked', null, { mm: Math.floor(lockoutLeft / 60), ss: String(lockoutLeft % 60).padStart(2, '0') })}
              </div>
            )}

            <button
              type="button"
              onClick={handleTryDemo}
              disabled={loading || googleLoad || demoLoad || lockoutLeft > 0}
              style={{
                width: '100%', padding: '11px', marginBottom: '14px',
                background: 'var(--cyan-glow)', border: '1px solid var(--cyan)',
                color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              {demoLoad ? t('asStartingDemo', null) : t('asTryDemoBtn', null)}
            </button>

            <button className="auth-google-btn" onClick={handleGoogle}
              disabled={loading || googleLoad || demoLoad || lockoutLeft > 0}>
              <GoogleIcon />
              {googleLoad ? t('asRedirecting', null) : t('asContinueGoogle', null)}
            </button>

            <div className="auth-divider">
              <span className="auth-divider-line"/>
              <span className="auth-divider-text">{t('asOr', null)}</span>
              <span className="auth-divider-line"/>
            </div>

            <div className="auth-fields">
              {mode === 'signup' && (
                <div className="auth-field-group">
                  <label className="auth-field-label">{t('asUsername', null)}</label>
                  <input className="auth-input" type="text" placeholder={t('asYourDisplayName', null)}
                    value={username} onChange={e => setUsername(e.target.value)}
                    onKeyDown={handleKeyDown} autoFocus disabled={loading || demoLoad}/>
                </div>
              )}
              {mode === 'signup' && (
                <div className="auth-field-group">
                  <label className="auth-field-label">{t('asEmail', null)}</label>
                  <input className="auth-input" type="email" placeholder="your@email.com"
                    value={email} onChange={e => setEmail(e.target.value)}
                    onKeyDown={handleKeyDown} disabled={loading || demoLoad}/>
                </div>
              )}
              {mode === 'signin' && (
                <div className="auth-field-group">
                  <label className="auth-field-label">{t('asEmailOrUsername', null)}</label>
                  <input className="auth-input" type="text" placeholder={t('asEmailOrUsernamePh', null)}
                    value={credential} onChange={e => setCredential(e.target.value)}
                    onKeyDown={handleKeyDown} autoFocus disabled={loading || demoLoad}/>
                </div>
              )}

              {renderPasswordField(t('asPassword', null), password, setPassword, showPassword, setShowPassword)}

              {mode === 'signup' && password.length > 0 && (
                <div className="auth-strength-wrap">
                  <div className="auth-strength-bars">
                    {[1,2,3,4].map(i => (
                      <div key={i} className={`auth-strength-bar ${strength.score >= i ? strength.cls : ''}`}/>
                    ))}
                  </div>
                  <span className={`auth-strength-label ${strength.cls}`}>{strength.label}</span>
                </div>
              )}
              {mode === 'signup' && (
                <div className="auth-requirements">
                  <div className={`auth-req ${req8chars ? 'met' : ''}`}>
                    <div className="auth-req-dot"/>{t('asReq8Chars', null)}
                  </div>
                  <div className={`auth-req ${reqSpecial ? 'met' : ''}`}>
                    <div className="auth-req-dot"/>{t('asReqSpecial', null)}
                  </div>
                </div>
              )}

              {mode === 'signup' && (
                <>
                  {renderPasswordField(t('asConfirmPassword', null), confirmPwd, setConfirmPwd, showConfirmPwd, setShowConfirmPwd)}
                  {confirmPwd.length > 0 && (
                    <div className="auth-requirements">
                      <div className={`auth-req ${reqMatch ? 'met' : ''}`}>
                        <div className="auth-req-dot"/>
                        {reqMatch ? t('asPasswordsMatch', null) : t('asPasswordsNoMatch', null)}
                      </div>
                    </div>
                  )}
                </>
              )}

              {mode === 'signup' && (
                <div className="auth-field-group">
                  <label className="auth-field-label">{t('asInterfaceLanguage', null)}</label>
                  <div className="auth-lang-toggle">
                    <button type="button"
                      className={`auth-lang-btn ${language === 'id' ? 'selected' : ''}`}
                      onClick={() => setLanguage('id')} disabled={loading}>Indonesia</button>
                    <button type="button"
                      className={`auth-lang-btn ${language === 'en' ? 'selected' : ''}`}
                      onClick={() => setLanguage('en')} disabled={loading}>English</button>
                  </div>
                </div>
              )}

              <div className="auth-remember-row">
                <label className="auth-remember-label">
                  <input type="checkbox" className="auth-remember-check"
                    checked={rememberMe} onChange={e => setRememberMe(e.target.checked)}/>
                  {t('asRememberMe', null)}
                </label>
                {mode === 'signin' && (
                  <button className="auth-link-btn" onClick={() => switchMode('forgot')} style={{ fontSize: '11px' }}>
                    {t('asForgotPassword', null)}
                  </button>
                )}
              </div>
            </div>

            <div className="auth-terms-row">
              <label className="auth-terms-label">
                <input type="checkbox" className="auth-remember-check"
                  checked={agreedToTerms} onChange={e => setAgreedToTerms(e.target.checked)}/>
                <span className="auth-terms-text">
                  {t('asAgreeToThe', null)}{' '}
                  <button type="button" className="auth-inline-link" onClick={() => setTermsOpen(true)}>{t('asTermsOfService', null)}</button>
                  {' '}{t('asAnd', null)}{' '}
                  <button type="button" className="auth-inline-link" onClick={() => setPrivacyOpen(true)}>{t('asPrivacyPolicy', null)}</button>
                </span>
              </label>
            </div>

            {error && <p className="auth-error">&gt; {error}</p>}
            {info  && <p className="auth-info">&gt; {info}</p>}

            <button className="auth-submit" onClick={handleSubmit}
              disabled={loading || googleLoad || demoLoad || lockoutLeft > 0 || !agreedToTerms}>
              {loading ? t('asAuthenticating', null) : mode === 'signin' ? t('asLoginBtn', null) : t('asCreateAccountBtn', null)}
            </button>
          </div>
        </section>
        {renderRightSide()}
      </main>
      {renderFooter()}
    </div>
  );
}
