'use strict';
const { supabase } = require('../lib/supabase');

// Fase 11 pre-demo security audit (23 Aug 2026): send-otp/verify-otp used
// to require verifyToken to even be CALLED — meaning a fully valid,
// USABLE session already existed before OTP could ever run (login itself
// is handled directly by Supabase Auth, which issues a token immediately
// on a correct password, with no hook to pause for OTP first). The OTP
// generate/verify plumbing worked correctly in isolation, but nothing
// was ever gating ACCESS on having actually completed it — "this device
// will be remembered" (already promised in AuthScreen.tsx's UI) wasn't
// actually true for anyone.
//
// Fix: verifyToken now ALSO checks trusted_devices for this user+device
// after confirming the JWT itself is valid. A request from an unrecognized
// device gets rejected with DEVICE_NOT_VERIFIED — EXCEPT for the OTP
// routes themselves, which must stay reachable or there'd be no way to
// ever become trusted in the first place.
// Checked against req.path, which Express keeps RELATIVE to wherever this
// router is mounted (e.g. a request to /api/user/send-otp arrives here as
// req.path === '/send-otp', not the full path) — confirmed directly
// rather than assumed, after an earlier version of this exempt-list used
// full paths and silently never matched.
const DEVICE_CHECK_EXEMPT_PATHS = ['/send-otp', '/verify-otp', '/register-first-device'];

const verifyToken = async (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing authorization token' });
  }

  const token = auth.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role, display_name, is_active, onboarding_complete, onboarding_step')
      .eq('id', user.id)
      .single();

    if (!profile?.is_active) {
      return res.status(403).json({ status: 'error', message: 'Account is inactive' });
    }

    // ── Device trust gate ────────────────────────────────────────────────
    // Skipped entirely for the OTP routes themselves (see comment above),
    // AND for anonymous (demo) users (added 9 Sep 2026) — an anonymous
    // Supabase user has no email at all, so there is structurally no way
    // for them to ever complete OTP verification, the ONLY path that
    // grants a trusted_devices entry. Without this exemption, a demo
    // visitor would sign in successfully via signInAnonymously() and then
    // be permanently blocked (403 DEVICE_NOT_VERIFIED) on every single
    // API call afterward, with no way to ever pass the gate. Demo
    // accounts are inherently lower-stakes — no persistent email/identity
    // to protect via device trust in the first place — so they're
    // exempted outright rather than routed through a verification flow
    // they cannot structurally complete.
    const isAnonymousUser = !!user.is_anonymous;
    if (!isAnonymousUser && !DEVICE_CHECK_EXEMPT_PATHS.includes(req.path)) {
      const deviceId = req.headers['x-device-id'];
      let deviceTrusted = false;
      let queryError = null;

      if (deviceId) {
        const { data: trusted, error } = await supabase
          .from('trusted_devices')
          .select('id')
          .eq('user_id', user.id)
          .eq('device_id', deviceId)
          .maybeSingle();
        deviceTrusted = !!trusted;
        queryError = error;
      }

      // TEMPORARY diagnostic logging (24 Aug 2026) — remove once the
      // empty-panels regression is confirmed resolved. auth.js previously
      // rejected silently with zero server-side trace, making this exact
      // class of bug invisible from the terminal.
      if (!deviceTrusted) {
        console.warn(
          `[Auth] Device gate REJECTED — path=${req.path} userId=${user.id} ` +
          `deviceId=${deviceId || '(none sent)'} queryError=${queryError?.message || '(none)'}`
        );
      }

      if (!deviceTrusted) {
        return res.status(403).json({
          status:  'error',
          code:    'DEVICE_NOT_VERIFIED',
          message: 'This device needs to be verified before continuing.',
        });
      }
    }

    req.userId             = user.id;
    req.userEmail          = user.email;
    req.userRole           = profile.role;
    req.userDisplayName    = profile.display_name || 'Agent';
    req.onboardingComplete = profile.onboarding_complete;
    req.onboardingStep     = profile.onboarding_step || 0;
    req.isAnonymous        = isAnonymousUser;

    next();
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Token verification failed' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Admin access required' });
  }
  next();
};

module.exports = { verifyToken, requireAdmin };