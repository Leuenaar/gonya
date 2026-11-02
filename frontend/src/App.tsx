import { useState, useEffect, useRef } from 'react';
import { supabase, getProfile, apiFetch, type UserProfile } from './lib/supabase';
import AuthScreen      from './pages/AuthScreen';
import OnboardingShell from './pages/OnboardingShell';
import LoadingScreen   from './pages/LoadingScreen';
import JoinGroup       from './pages/JoinGroup';
import MainShell       from './pages/MainShell';
import MainShellMobile from './pages/MainShellMobile';
import { useIsMobile } from './hooks/useIsMobile';
import './App.css';

type AppState = 'loading' | 'auth' | 'onboarding' | 'join' | 'initializing' | 'app';
type PendingGroup = { id: string; name: string; myRole: string } | null;

const already   = () => sessionStorage.getItem('tt_init') === '1';
const markInit  = () => sessionStorage.setItem('tt_init', '1');
const clearInit = () => sessionStorage.removeItem('tt_init');

// Extracted once, synchronously, on first render — before any auth check
// runs, so it's available no matter which path (already logged in, or
// needs to sign in first) the user takes to get here.
const extractJoinToken = (): string | null => {
  const match = window.location.pathname.match(/^\/join\/([a-zA-Z0-9_-]+)$/);
  return match ? match[1] : null;
};

// Device-trust check (24 Aug 2026 — moved here from AuthScreen.tsx's
// handleSubmit(), where it ONLY ever ran for the email/password sign-in
// path). onAuthStateChange's SIGNED_IN event below fires for EVERY
// successful sign-in regardless of method (email/password, Google OAuth,
// session restore) — this is the one true convergence point, so this is
// the only place this check needs to exist now. Previously, OAuth sign-
// ins skipped this entirely (confirmed in production: a Google-login
// user's brand-new device was never registered, and every subsequent API
// call silently failed the gate with no recovery path) — and even for
// email/password, AuthScreen's own inline copy of this logic was racing
// against this SAME listener firing independently, since signIn()
// establishes a session that triggers SIGNED_IN here regardless of
// whether AuthScreen ALSO tries to handle it manually afterward.
//
// Returns { needsOtp: true } if the caller should route to AuthScreen's
// OTP-entry screen instead of proceeding — otherwise the caller is clear
// to fetch the profile and continue normally.
const resolveDeviceTrust = async (userEmail: string | null | undefined): Promise<{ needsOtp: boolean }> => {
  const deviceCheckRes = await apiFetch('/api/user/profile');
  if (deviceCheckRes.status !== 403) return { needsOtp: false };

  const errBody = await deviceCheckRes.json().catch(() => ({}));
  if (errBody.code !== 'DEVICE_NOT_VERIFIED') return { needsOtp: false };

  // Try auto-trusting as a first device — the endpoint itself safely
  // refuses (403) if this account already HAS a trusted device
  // elsewhere, in which case we fall through to real OTP verification.
  const registerRes = await apiFetch('/api/user/register-first-device', { method: 'POST' });
  if (registerRes.status === 200) return { needsOtp: false };

  try {
    await apiFetch('/api/user/send-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ email: userEmail }),
    });
  } catch {}
  return { needsOtp: true };
};

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [profile,  setProfile]  = useState<UserProfile | null>(null);
  const [joinToken, setJoinToken] = useState<string | null>(() => extractJoinToken());
  const [pendingGroup, setPendingGroup] = useState<PendingGroup>(null);
  // Set when resolveDeviceTrust() determines OTP verification is needed
  // (any sign-in method) — passed to AuthScreen so it can jump straight
  // into its existing OTP-entry UI instead of the normal sign-in form.
  const [authOtpEmail, setAuthOtpEmail] = useState<string | null>(null);
  // Bug fixed/designed (9 Sep 2026): OnboardingShell needs to know
  // whether this is a demo (anonymous) session to skip Fase 2 and the
  // legacy guest-token gate — session.user.is_anonymous is only
  // available here (where the raw auth session lives), not on the
  // UserProfile row itself, so it's tracked separately and passed down.
  const [isAnonymous, setIsAnonymous] = useState(false);
  const isMobile = useIsMobile();
  // Guard against onAuthStateChange's SIGNED_IN event firing more than
  // once for the SAME underlying session — a known Supabase behavior.
  // FIXED (29 Aug 2026, v2): the first version of this guard only
  // blocked two invocations firing near-simultaneously (a simple
  // in-flight boolean reset in `finally`) — but confirmed in testing,
  // the SECOND SIGNED_IN re-fire can land tens of SECONDS after the
  // first, well after the first invocation already finished and reset
  // the boolean. That meant a completely fresh device-check ran again
  // for the SAME session, which — since resolveDeviceTrust() calls
  // send-otp() whenever OTP is needed — silently fired a SECOND OTP
  // email that invalidated the code from the first one, right as the
  // user was about to type it in ("Invalid or expired code").
  //
  // Now keyed on the session's own access_token instead of a simple
  // in-flight flag: once a given token has been processed ONCE (whatever
  // the outcome), any further SIGNED_IN firing for that EXACT SAME
  // token is skipped outright, regardless of how much time has passed.
  // A genuinely NEW sign-in later gets a genuinely new access_token, so
  // it's never blocked from being processed correctly.
  const processedSessionTokenRef = useRef<string | null>(null);

  // Single source of truth for "what screen comes after we know the
  // profile" — used from initial load, auth-state-change, and the
  // post-sign-in callback, so the three can't drift out of sync.
  const decideNextState = (p: UserProfile, hasJoinToken: boolean): AppState => {
    if (!p.onboarding_complete) return 'onboarding';
    if (hasJoinToken)            return 'join';
    return already() ? 'app' : 'initializing';
  };

  // Single shared path for "we have a session, now what" — used by BOTH
  // init() (on first mount, whenever a session ALREADY exists — this is
  // EXACTLY what's true right after an OAuth redirect completes, or on
  // any page refresh while already signed in) AND the onAuthStateChange
  // SIGNED_IN handler below.
  //
  // Bug fixed (29 Aug 2026): previously, init() had its OWN separate
  // "getProfile then decide state" logic that never called
  // resolveDeviceTrust() at all — meaning right after a Google OAuth
  // redirect (where a session already exists the INSTANT this component
  // mounts), init() raced ahead and briefly rendered the full main app
  // (all its panels immediately hammering device-gated endpoints, all
  // rejected) BEFORE the slower, correct onAuthStateChange listener
  // caught up and corrected course back to the OTP screen — the exact
  // "10-15 second flicker" reported in testing. The extra rejected panel
  // requests competing for the browser's limited concurrent connections
  // is also the likely reason resolveDeviceTrust() itself felt so slow
  // in that window. Routing BOTH entry points through this ONE function
  // closes that gap structurally, rather than patching one path at a
  // time — device verification can no longer be skipped by whichever
  // path happens to run first.
  const handleAuthenticatedSession = async (session: NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>) => {
    if (processedSessionTokenRef.current === session.access_token) return; // already handled — see the ref's own comment below
    processedSessionTokenRef.current = session.access_token;
    // Defensive cast: is_anonymous is a real field Supabase returns for
    // anonymous sessions, but depending on the installed @supabase/
    // supabase-js version, it may not yet be reflected in the User type
    // definition. Verify against your installed version if this ever
    // reports incorrectly — the cast exists so a missing TYPE doesn't
    // break the build even if the field itself is present at runtime.
    setIsAnonymous(!!(session.user as unknown as { is_anonymous?: boolean }).is_anonymous);

    const { needsOtp } = await resolveDeviceTrust(session.user.email);
    if (needsOtp) {
      setAuthOtpEmail(session.user.email || '');
      setAppState('auth');
      return;
    }

    const p = await getProfile(session.user.id);
    if (!p || !p.is_active) {
      await supabase.auth.signOut();
      setAppState('auth');
      return;
    }

    setAuthOtpEmail(null);
    setProfile(p);
    setAppState(decideNextState(p, !!joinToken));
  };

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setAppState('auth'); return; }
      await handleAuthenticatedSession(session);
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_OUT' || !session) {
          processedSessionTokenRef.current = null;
          setProfile(null);
          setAuthOtpEmail(null);
          setIsAnonymous(false);
          setAppState('auth');
          return;
        }
        if (event === 'SIGNED_IN' && session) {
          await handleAuthenticatedSession(session);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const handleAuthSuccess = (p: UserProfile) => {
    setAuthOtpEmail(null);
    setProfile(p);
    setAppState(decideNextState(p, !!joinToken));
  };

  const handleOnboardingComplete = (p: UserProfile) => {
    setProfile(p);
    // Still respect a pending join token even for a brand-new user —
    // they signed up specifically because they clicked an invite link.
    setAppState(joinToken ? 'join' : 'initializing');
  };

  const handleJoinDone = (result: { joined: boolean; groupId?: string; groupName?: string }) => {
    // Clean the /join/:token path out of the URL so a refresh doesn't
    // re-trigger this screen.
    window.history.replaceState({}, '', '/');
    setJoinToken(null);

    if (result.joined && result.groupId && result.groupName) {
      setPendingGroup({ id: result.groupId, name: result.groupName, myRole: 'member' });
    }

    setAppState(already() ? 'app' : 'initializing');
  };

  const handleLoadingComplete = () => {
    markInit();
    setAppState('app');
  };

  const handleSignOut = async () => {
    clearInit();
    await supabase.auth.signOut();
    setProfile(null);
    setPendingGroup(null);
    setAuthOtpEmail(null);
    setIsAnonymous(false);
    setAppState('auth');
  };

  return (
    <>
      {appState === 'loading'                   && <BootScreen />}
      {appState === 'auth'                      && <AuthScreen onSuccess={handleAuthSuccess} initialOtpEmail={authOtpEmail} />}
      {appState === 'onboarding'  && profile    && <OnboardingShell profile={profile} isAnonymous={isAnonymous} onComplete={handleOnboardingComplete} />}
      {appState === 'join'        && joinToken  && <JoinGroup token={joinToken} onDone={handleJoinDone} />}
      {appState === 'initializing' && profile   && <LoadingScreen profile={profile} onComplete={handleLoadingComplete} />}
      {appState === 'app' && profile && isMobile  && <MainShellMobile profile={profile} isAnonymous={isAnonymous} onSignOut={handleSignOut} pendingGroup={pendingGroup} />}
      {appState === 'app' && profile && !isMobile && <MainShell       profile={profile} isAnonymous={isAnonymous} onSignOut={handleSignOut} pendingGroup={pendingGroup} />}
      {!['loading','auth','onboarding','join','initializing','app'].includes(appState) && <BootScreen />}
    </>
  );
}

function BootScreen() {
  return (
    <div className="boot-screen">
      <svg width="48" height="48" viewBox="0 0 100 100">
        <polygon points="50,8 94,90 6,90" fill="none"
          stroke="rgba(0,229,255,0.7)" strokeWidth="1.5"/>
        <polygon points="50,26 82,84 18,84" fill="none"
          stroke="rgba(0,229,255,0.2)" strokeWidth="1"/>
        <path id="tri" d="M50,8 L94,90 L6,90 Z" fill="none"/>
        <circle r="2.5" fill="#00e5ff"
          style={{ filter: 'drop-shadow(0 0 5px #00e5ff)' }}>
          <animateMotion dur="2s" repeatCount="indefinite">
            <mpath href="#tri"/>
          </animateMotion>
        </circle>
      </svg>
      <span className="boot-label">INITIALIZING SYSTEM...</span>
    </div>
  );
}
