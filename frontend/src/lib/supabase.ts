import { createClient } from '@supabase/supabase-js';

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:     true,
    storageKey:         'triangle_auth',
    autoRefreshToken:   true,
    detectSessionInUrl: true,
  },
});

export type UserRole  = 'admin' | 'member';
export type Gender    = 'male' | 'female';
export type LangStyle = 'casual' | 'formal';

export interface UserProfile {
  id:                  string;
  display_name:        string;
  role:                UserRole;
  gender:              Gender | null;
  language:            string | null;
  language_style:      LangStyle | null;
  username:            string | null; // Phase 8.4/8.5 — was already in the DB, just never declared here
  short_id:            string | null; // used by Settings.tsx / GroupMembersPanel.tsx, same gap
  radar_categories:    string[];
  onboarding_complete: boolean;
  onboarding_step:     number;
  onboarding_state:    unknown | null; // checkpoint resumable onboarding (29 Aug 2026), shape-nya dari OnboardingShell.tsx
  is_active:           boolean;
  last_login:          string | null;
  created_at:          string;
  updated_at:          string;
}

export const getProfile = async (userId: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data as UserProfile;
};

export const signIn = (email: string, password: string) =>
  supabase.auth.signInWithPassword({ email: email.trim(), password });

export const signUp = (email: string, password: string, displayName: string, language: 'id' | 'en' = 'en') =>
  supabase.auth.signUp({
    email:   email.trim(),
    password,
    options: { data: { display_name: displayName.trim(), language } },
  });

export const signInWithGoogle = async () => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: window.location.origin },
  });
  return { data, error };
};

export const signOut = () => supabase.auth.signOut();

// Fase 11 pre-demo security audit (23 Aug 2026) — replaces the old
// AuthScreen-only isKnownDevice()/markKnownDevice() localStorage boolean,
// which never proved anything server-side and was trivially bypassable.
// A real per-browser UUID, generated once and reused, sent on EVERY
// apiFetch call — middleware/auth.js's device-trust gate checks this same
// header against the trusted_devices table on the backend.
const DEVICE_ID_KEY = 'gonya_device_id';

// Doesn't depend on crypto.randomUUID at all — reasonably unique for a
// device-tracking id (doesn't need cryptographic strength for this use),
// and safe even if the browser/context genuinely lacks the Web Crypto
// API (older browsers, or a non-"localhost" hostname over plain HTTP not
// being treated as a secure context by some browsers).
const generateFallbackId = (): string =>
  `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const getDeviceId = (): string => {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      // Bug fixed (24 Aug 2026): the original fallback ALSO called
      // crypto.randomUUID() — if that API is genuinely unavailable, both
      // the primary path AND the fallback failed the same way, throwing
      // out of getDeviceId() entirely and crashing every apiFetch() call
      // app-wide (confirmed via user's Network tab — every request
      // showing supabase.ts as the failure point). Checked for existence
      // before calling it now, with a fallback that never touches crypto.
      id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : generateFallbackId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private/incognito edge cases) — fall back
    // to a fresh id per call. Device verification just gets asked again
    // each time in that case, an acceptable degrade rather than breaking
    // every authenticated request over a missing header.
    return generateFallbackId();
  }
};

// Bug fixed (29 Aug 2026): confirmed via testing — right after a user
// clicks an email-confirmation link (a fresh page load, session hydrated
// from the URL hash via detectSessionInUrl above), an apiFetch() call
// firing very soon after mount could catch getSession() in the brief
// window before that hydration fully lands, getting back a null session
// and silently sending the request with no Authorization header —
// surfacing as a confusing "Missing authorization token" 400 from the
// backend, even though the user WAS genuinely logged in moments later.
// A single short-delay retry is enough to clear this window without
// adding any noticeable delay to the overwhelmingly common case where
// the session is already available on the first try.
const SESSION_RETRY_DELAY_MS = 400;

export const apiFetch = async (path: string, options: RequestInit = {}): Promise<Response> => {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    await new Promise(resolve => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
    ({ data: { session } } = await supabase.auth.getSession());
  }
  const token = session?.access_token;
  return fetch(path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Device-Id': getDeviceId(),
      ...(options.headers ?? {}),
    },
  });
};