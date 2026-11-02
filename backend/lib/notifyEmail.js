'use strict';

// Thin wrapper around the Resend API for transactional/notification emails
// that don't go through Supabase Auth's SMTP (which only handles auth
// emails — OTP, password reset, signup confirmation).
//
// Needs RESEND_API_KEY (already in use for leuenaar.com's verified domain).
// Recipient reuses the existing OWNER_EMAIL — no new var required. If you
// ever want ticket alerts to land somewhere different from general owner
// notifications, set SUPPORT_NOTIFY_EMAIL to override it.
// FROM address defaults to noreply@leuenaar.com; override with SUPPORT_FROM_EMAIL.

const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL       = process.env.SUPPORT_FROM_EMAIL   || 'noreply@leuenaar.com';
const NOTIFY_EMAIL     = process.env.SUPPORT_NOTIFY_EMAIL || process.env.OWNER_EMAIL || null;

const sendEmail = async ({ to, subject, html }) => {
  if (!RESEND_API_KEY) {
    console.warn('[notifyEmail] RESEND_API_KEY not set — skipping send:', subject);
    return { skipped: true };
  }
  if (!to) {
    console.warn('[notifyEmail] no recipient — skipping send:', subject);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${errText}`);
  }

  return res.json();
};

module.exports = { sendEmail, NOTIFY_EMAIL, FROM_EMAIL };