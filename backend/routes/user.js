'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { perUserLimiter, perIpLimiter } = require('../middleware/rateLimit');
const { ensureShortId } = require('../lib/shortId');

// /find-email runs before login exists, so it's keyed by IP — generous
// enough for a real "forgot my username" retry, tight enough to block
// enumeration scripts.
const findEmailLimiter = perIpLimiter(
  15 * 60 * 1000, 10,
  'Too many lookups — please try again later.'
);

// OTP is only 4 digits (10,000 possibilities) — needs a tight per-user cap
// so it can't be brute-forced within its own 10-minute expiry window.
const verifyOtpLimiter = perUserLimiter(
  10 * 60 * 1000, 5,
  'Too many attempts — please request a new code.'
);

// Each call sends a real email via Resend — cap it so an authenticated
// user can't OTP-bomb an inbox (their own or, since the target email
// comes from the request body, potentially someone else's).
const sendOtpLimiter = perUserLimiter(
  10 * 60 * 1000, 3,
  'Too many code requests — please wait before requesting another.'
);

// Instagram-style unique usernames (24 Aug 2026) — always normalized to
// lowercase before validation/storage (matches the unique constraint on
// user_profiles.username, which assumes lowercase-only values).
const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

// GET /api/user/profile
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (error) throw error;

    // Lazily assign a Short ID if this user doesn't have one yet —
    // previously this only happened when creating a group, so anyone
    // who was only ever invited (or never touched groups) had none.
    if (data && !data.short_id) {
      try {
        data.short_id = await ensureShortId(supabase, req.userId);
      } catch (err) {
        console.error('[User] Failed to lazily assign short_id:', err.message);
        // Don't fail the whole profile fetch over this — just leave it null.
      }
    }

    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/user/profile
router.patch('/profile', verifyToken, async (req, res) => {
  const allowed = ['display_name', 'language_style', 'gender', 'username',
                   'radar_categories', 'onboarding_complete', 'onboarding_step',
                   'language', 'onboarding_state'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ status: 'error', message: 'No valid fields to update' });
  }

  // Instagram-style unique usernames (24 Aug 2026) — validated + normalized
  // to lowercase BEFORE ever hitting the database (the unique constraint
  // on user_profiles.username assumes lowercase-only values).
  if (updates.username !== undefined) {
    const normalized = String(updates.username).trim().toLowerCase();
    if (!USERNAME_REGEX.test(normalized)) {
      return res.status(400).json({
        status:  'error',
        message: 'Username must be 3-20 characters: lowercase letters, numbers, and underscores only.',
      });
    }
    updates.username = normalized;
  }

  updates.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .update(updates)
      .eq('id', req.userId)
      .select()
      .single();

    if (error) {
      // Postgres unique_violation (23505) — surface a clear, specific
      // message for this expected user-facing case instead of a generic
      // 500 falling through to the catch block below.
      if (error.code === '23505') {
        return res.status(409).json({ status: 'error', message: 'That username is already taken.' });
      }
      throw error;
    }
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/user/last-login
router.post('/last-login', verifyToken, async (req, res) => {
  try {
    await supabase
      .from('user_profiles')
      .update({ last_login: new Date().toISOString() })
      .eq('id', req.userId);

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/user/check-username?username=xxx
// Live availability check (Instagram-style, as the user types in
// Settings.tsx). Read-only, no side effects.
router.get('/check-username', verifyToken, async (req, res) => {
  const raw = req.query.username;
  if (!raw?.trim()) {
    return res.status(400).json({ status: 'error', message: 'username query param required' });
  }
  const normalized = String(raw).trim().toLowerCase();

  if (!USERNAME_REGEX.test(normalized)) {
    return res.json({ status: 'success', available: false, reason: 'invalid_format' });
  }

  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('username', normalized)
      .maybeSingle();

    // Available if nobody has it — OR the only match is the CALLER's own
    // current username, so re-checking your own existing username never
    // falsely shows as "taken".
    const available = !data || data.id === req.userId;
    res.json({ status: 'success', available });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/user/find-email?handle=username
router.get('/find-email', findEmailLimiter, async (req, res) => {
  const { handle } = req.query;

  if (!handle?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Handle required' });
  }

  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      // Instagram-style unique usernames (24 Aug 2026) — now looks up by
      // the actual unique `username` column instead of `display_name`
      // (which was never unique and never meant to double as a handle).
      // Exact match on the normalized-lowercase value, not ilike — a
      // username lookup should be exact, not a partial/pattern match.
      .eq('username', handle.trim().toLowerCase())
      .single();

    if (!profile) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const { data: { user }, error } = await supabase.auth.admin.getUserById(profile.id);

    if (error || !user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    return res.json({ status: 'success', email: user.email });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/user/change-password
router.post('/change-password', verifyToken, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ status: 'error', message: 'Password min 8 characters' });
  }
  try {
    const { error } = await supabase.auth.admin.updateUserById(req.userId, { password });
    if (error) throw error;
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/user/export
router.get('/export', verifyToken, async (req, res) => {
  try {
    const [
      { data: profile },
      { data: messages },
      { data: memories },
      { data: files },
      { data: dossiers },
    ] = await Promise.all([
      supabase.from('user_profiles').select('*').eq('id', req.userId).single(),
      supabase.from('messages').select('sender, content, created_at').eq('user_id', req.userId).order('created_at'),
      supabase.from('memories').select('content, layer, category, status, created_at').eq('user_id', req.userId),
      supabase.from('conversation_files').select('file_name, file_type, size_bytes, created_at').eq('user_id', req.userId),
      supabase.from('dossiers').select('name, description, created_at').eq('user_id', req.userId),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      profile:     profile || {},
      messages:    messages || [],
      memories:    memories || [],
      files:       files || [],
      dossiers:    dossiers || [],
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="gonya-export.json"');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/user/account
router.delete('/account', verifyToken, async (req, res) => {
  try {
    await Promise.all([
      supabase.from('messages').delete().eq('user_id', req.userId),
      supabase.from('memories').delete().eq('user_id', req.userId),
      supabase.from('conversation_files').delete().eq('user_id', req.userId),
      supabase.from('dossiers').delete().eq('user_id', req.userId),
    ]);

    await supabase.from('user_profiles').delete().eq('id', req.userId);
    await supabase.auth.admin.deleteUser(req.userId);

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/user/register-first-device
// Fase 11 pre-demo audit follow-up (24 Aug 2026) — closes a gap the OTP
// fix (23 Agu) missed: it only added device-verification to the SIGN-IN
// flow, never SIGN-UP. A brand-new account had zero path to ever get a
// trusted device, so every request post-signup (including onboarding
// itself) hit the device gate and failed with no way out.
//
// Auto-trusts the CURRENT device WITHOUT requiring OTP — but ONLY if
// this account has ZERO trusted devices so far, i.e. genuinely the very
// first device for a fresh signup (which already proved email ownership
// via Supabase's own signup/verification flow). The moment an account
// has ANY trusted device, this endpoint refuses to add another one —
// adding a SECOND device is exactly what OTP verification exists to gate,
// and this must never become a way to bypass that.
router.post('/register-first-device', verifyToken, async (req, res) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing device identifier' });
  }

  try {
    const { count, error: countError } = await supabase
      .from('trusted_devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    if (countError) throw countError;

    if (count > 0) {
      return res.status(403).json({
        status:  'error',
        message: 'This account already has a verified device — use OTP verification to add another.',
      });
    }

    const { error: insertError } = await supabase
      .from('trusted_devices')
      .insert({ user_id: req.userId, device_id: deviceId });

    if (insertError) throw insertError;

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[User] Failed to register first device:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to register device' });
  }
});

// POST /api/user/send-otp
router.post('/send-otp', verifyToken, sendOtpLimiter, async (req, res) => {
  const otp       = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  const { redis } = require('../lib/redis');
  await redis.set(`otp:${req.userId}`, JSON.stringify({ otp, expiresAt }), 'EX', 600);

  const { Resend } = require('resend');
  const resend     = new Resend(process.env.RESEND_API_KEY);

  const otpDigits = otp.split('').map(d =>
    `<td style="width:48px;height:56px;text-align:center;vertical-align:middle;background:#0d1117;border:1px solid #00e5ff;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:0">${d}</td>
     <td style="width:8px;"></td>`
  ).join('');

  await resend.emails.send({
    from:    'Gonya <noreply@leuenaar.my.id>',
    to:      req.body.email,
    subject: 'Your verification code — Gonya',
    html:    `
      <div style="font-family:'Courier New',monospace;background:#080b11;padding:48px 20px;">
        <div style="max-width:440px;margin:0 auto;background:#0d1117;border:1px solid #1b2433;">

          <div style="height:3px;background:#00e5ff;"></div>

          <div style="padding:40px;">
            <p style="font-size:10px;letter-spacing:0.28em;color:#00e5ff;margin:0 0 6px;text-transform:uppercase;">
              Gonya
            </p>
            <p style="font-size:9px;letter-spacing:0.2em;color:#5d6b7d;margin:0 0 32px;text-transform:uppercase;">
              Access Verification
            </p>

            <p style="font-size:12px;color:#8b96a5;line-height:1.7;margin:0 0 24px;">
              A new device is requesting access to your account. Enter the code below to continue.
            </p>

            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>${otpDigits}</tr>
            </table>

            <p style="font-size:11px;color:#5d6b7d;margin:0 0 4px;letter-spacing:0.04em;">
              This code expires in <span style="color:#8b96a5;">10 minutes</span>.
            </p>
            <p style="font-size:11px;color:#5d6b7d;margin:0;letter-spacing:0.04em;">
              Do not share this code with anyone, including Gonya support.
            </p>
          </div>

          <div style="border-top:1px solid #1b2433;padding:18px 40px;">
            <p style="font-size:9px;letter-spacing:0.16em;color:#344858;margin:0;text-transform:uppercase;">
              Thought, undivided.
            </p>
          </div>

        </div>
      </div>
    `,
  });

  res.json({ status: 'success' });
});

// POST /api/user/verify-otp
router.post('/verify-otp', verifyToken, verifyOtpLimiter, async (req, res) => {
  const { otp } = req.body;
  const { redis } = require('../lib/redis');
  const raw = await redis.get(`otp:${req.userId}`);
  if (!raw) return res.status(400).json({ status: 'error', message: 'OTP expired or not found' });

  const { otp: stored, expiresAt } = JSON.parse(raw);
  if (Date.now() > expiresAt) return res.status(400).json({ status: 'error', message: 'OTP expired' });
  if (otp !== stored)         return res.status(400).json({ status: 'error', message: 'Invalid OTP' });

  await redis.del(`otp:${req.userId}`);

  // Fase 11 pre-demo security audit (23 Aug 2026) — this is what makes
  // "this device will be remembered" (AuthScreen.tsx's own UI promise)
  // actually true. Reads the SAME X-Device-Id header middleware/auth.js's
  // device gate checks — one consistent source of "which device is this"
  // across the app, rather than a separate value from the request body
  // that could drift out of sync with what the gate actually reads.
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing device identifier' });
  }

  const { error: trustError } = await supabase
    .from('trusted_devices')
    .upsert(
      { user_id: req.userId, device_id: deviceId, last_seen_at: new Date().toISOString() },
      { onConflict: 'user_id,device_id' }
    );

  if (trustError) {
    console.error('[User] Failed to record trusted device:', trustError.message);
    return res.status(500).json({ status: 'error', message: 'Verified, but failed to remember this device' });
  }

  res.json({ status: 'success' });
});

// GET /api/user/stats
// Returns usage statistics for the Ledger widget
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const [
      { data: messages },
      { data: memories },
      { data: files },
      { data: dossiers },
      { data: profile },
    ] = await Promise.all([
      supabase
        .from('messages')
        .select('sender, created_at')
        .eq('user_id', req.userId),
      supabase
        .from('memories')
        .select('status')
        .eq('user_id', req.userId),
      supabase
        .from('conversation_files')
        .select('id')
        .eq('user_id', req.userId),
      supabase
        .from('dossiers')
        .select('id')
        .eq('user_id', req.userId),
      supabase
        .from('user_profiles')
        .select('last_login, created_at')
        .eq('id', req.userId)
        .single(),
    ]);

    const allMessages = messages || [];

    // Message totals
    const totalMessages = allMessages.filter(m => m.sender === 'User').length;
    const akselMessages = allMessages.filter(m => m.sender === 'Aksel').length;
    const veraMessages  = allMessages.filter(m => m.sender === 'Vera').length;

    // Messages today (WIB = UTC+7)
    const now     = new Date();
    const wibNow  = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const todayWib = wibNow.toISOString().slice(0, 10);

    const messagesToday = allMessages.filter(m => {
      if (m.sender !== 'User') return false;
      const wibTime = new Date(new Date(m.created_at).getTime() + 7 * 60 * 60 * 1000);
      return wibTime.toISOString().slice(0, 10) === todayWib;
    }).length;

    // Memory counts
    const allMemories     = memories || [];
    const pendingMemories  = allMemories.filter(m => m.status === 'pending').length;
    const approvedMemories = allMemories.filter(m => m.status === 'approved').length;

    // Most used agent
    const dominantAgent = akselMessages >= veraMessages ? 'Aksel' : 'Vera';

    res.json({
      status: 'success',
      data: {
        messages: {
          total:   totalMessages,
          today:   messagesToday,
          aksel:   akselMessages,
          vera:    veraMessages,
          dominant: dominantAgent,
        },
        memories: {
          pending:  pendingMemories,
          approved: approvedMemories,
          total:    allMemories.length,
        },
        files:      (files    || []).length,
        dossiers:   (dossiers || []).length,
        last_login: profile?.last_login || null,
        member_since: profile?.created_at || null,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;