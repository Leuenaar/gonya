'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }             = require('../lib/supabase');
const { verifyToken }          = require('../middleware/auth');
const { generateSupportReply } = require('../lib/supportAgent');
const { generateUniqueTicketNo } = require('../lib/ticketNumber');
const { sendEmail, NOTIFY_EMAIL } = require('../lib/notifyEmail');

router.use(verifyToken);

const escapeHtml = (str = '') =>
  String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Bilingual ticket confirmation copy, shown after a feedback or support
// ticket is submitted
const confirmationMessage = (lang, ticketNo) => {
  if (lang === 'en') {
    return `Thanks — we've got it. Reference number: ${ticketNo}. We'll follow up by email if we need anything else.`;
  }
  return `Terima kasih — pesanmu sudah kami terima. Nomor referensi: ${ticketNo}. Kami akan menghubungi lewat email kalau ada yang perlu ditindaklanjuti.`;
};

const fetchProfile = async (userId) => {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('display_name, language, gender')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
};

// Fire-and-forget notification to Leuenaar on every new ticket — mirrors
// the fire-and-forget pattern used for memory extraction after chat turns.
// Intentionally minimal: just enough to know a ticket landed. The full
// transcript lives in the feedback table for review in Admin Terminal,
// not in the email body. Styled to match the Gonya confirm-email template.
const ticketEmailHtml = (ticket) => {
  const typeLabel = ticket.type === 'support' ? 'Live Support' : 'Feedback';
  return `
<div style="font-family: 'Courier New', monospace; background-color: #080b11; padding: 48px 20px;">
  <div style="max-width: 440px; margin: 0 auto; background-color: #0d1117; border: 1px solid #1b2433;">

    <div style="height: 3px; background: #00e5ff;"></div>

    <div style="padding: 40px;">
      <p style="font-size: 10px; letter-spacing: 0.28em; color: #00e5ff; margin: 0 0 6px; text-transform: uppercase;">
        Gonya
      </p>
      <p style="font-size: 9px; letter-spacing: 0.2em; color: #5d6b7d; margin: 0 0 32px; text-transform: uppercase;">
        Support Notification
      </p>

      <h1 style="font-size: 19px; font-weight: 700; color: #ffffff; margin: 0 0 20px; letter-spacing: 0.01em;">
        New ${escapeHtml(typeLabel)} ticket
      </h1>

      <div style="display: inline-block; border: 1px solid #00e5ff; color: #00e5ff; padding: 10px 18px; font-size: 15px; font-weight: 700; letter-spacing: 0.08em; margin: 0 0 28px;">
        ${escapeHtml(ticket.ticket_no)}
      </div>

      <p style="font-size: 9px; letter-spacing: 0.18em; color: #5d6b7d; margin: 0 0 6px; text-transform: uppercase;">
        Subject
      </p>
      <p style="font-size: 13px; color: #c3cbd6; line-height: 1.6; margin: 0 0 32px;">
        ${escapeHtml(ticket.subject || '(no subject)')}
      </p>

      <p style="font-size: 11px; color: #5d6b7d; margin: 0; line-height: 1.6;">
        Full conversation is in Admin Terminal.
      </p>
    </div>

    <div style="border-top: 1px solid #1b2433; padding: 18px 40px;">
      <p style="font-size: 9px; letter-spacing: 0.16em; color: #344858; margin: 0; text-transform: uppercase;">
        Thought, undivided.
      </p>
    </div>

  </div>
</div>`;
};

const notifyNewTicket = (ticket) => {
  if (!NOTIFY_EMAIL) return;
  sendEmail({
    to:      NOTIFY_EMAIL,
    subject: `[Gonya] New ${ticket.type} ticket ${ticket.ticket_no}`,
    html:    ticketEmailHtml(ticket),
  }).catch(err => console.error('[feedback] notify email failed:', err));
};

const requireAdmin = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', req.userId)
      .single();
    if (error) throw error;
    if (data?.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/feedback — Feedback card submission (subject + message, one shot)
router.post('/', async (req, res) => {
  const { subject, message } = req.body;
  if (!subject?.trim() || !message?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Subject and message are required' });
  }
  try {
    const profile = await fetchProfile(req.userId);
    const lang     = profile?.language || 'id';
    const ticketNo = await generateUniqueTicketNo(supabase);
    const transcript = [
      { sender: 'User', content: message.trim(), timestamp: new Date().toISOString() },
    ];

    const { data, error } = await supabase
      .from('feedback')
      .insert({
        user_id:   req.userId,
        ticket_no: ticketNo,
        type:      'feedback',
        subject:   subject.trim(),
        transcript,
        status:    'new',
      })
      .select()
      .single();
    if (error) throw error;

    notifyNewTicket(data);

    res.json({ status: 'success', ticket_no: ticketNo, confirmation: confirmationMessage(lang, ticketNo) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/feedback/support/chat — one turn with Thea/Theo. Ephemeral —
// nothing is persisted until the user submits the conversation as a ticket.
// Pass { greeting: true } with no message to get the agent's opening line
// (used when the user first opens Live Chat, before they've typed anything).
router.post('/support/chat', async (req, res) => {
  const { history, message, greeting } = req.body;
  if (!greeting && !message?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message is required' });
  }
  try {
    const profile = await fetchProfile(req.userId);
    const lang     = profile?.language || 'id';
    const effectiveMessage = greeting
      ? (lang === 'en'
          ? '(The user just opened this chat window. Greet them warmly in one or two short sentences and ask what brought them here or how you can help.)'
          : '(User baru saja membuka jendela chat ini. Sapa dengan hangat dalam satu atau dua kalimat singkat, lalu tanyakan apa yang membawanya ke sini atau apa yang bisa dibantu.)')
      : message.trim();

    const reply = await generateSupportReply(
      Array.isArray(history) ? history : [],
      effectiveMessage,
      profile,
      req.userId
    );
    res.json({ status: 'success', reply: reply.content, agentName: reply.agentName, shouldEnd: !!reply.shouldEnd });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/feedback/support/submit — turn the client-side transcript from
// a Live Support chat into a real ticket
router.post('/support/submit', async (req, res) => {
  const { subject, transcript } = req.body;
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Transcript is required' });
  }
  try {
    const profile = await fetchProfile(req.userId);
    const lang     = profile?.language || 'id';
    const ticketNo = await generateUniqueTicketNo(supabase);
    const finalSubject = subject?.trim() ||
      (lang === 'en' ? 'Live support conversation' : 'Percakapan dukungan langsung');

    const { data, error } = await supabase
      .from('feedback')
      .insert({
        user_id:   req.userId,
        ticket_no: ticketNo,
        type:      'support',
        subject:   finalSubject,
        transcript,
        status:    'new',
      })
      .select()
      .single();
    if (error) throw error;

    notifyNewTicket(data);

    res.json({ status: 'success', ticket_no: ticketNo, confirmation: confirmationMessage(lang, ticketNo) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/feedback/mine — the current user's own ticket history
router.get('/mine', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('id, ticket_no, type, subject, status, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ status: 'success', tickets: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Admin ────────────────────────────────────────────
// Scaffolded but not wired into AdminTerminal yet — a tickets tab there
// is a small follow-up rather than a new backend build.

// GET /api/feedback?status=new
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('feedback')
      .select('id, ticket_no, user_id, type, subject, transcript, status, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ status: 'success', tickets: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PATCH /api/feedback/:id  { status: 'new' | 'reviewed' | 'resolved' }
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['new', 'reviewed', 'resolved'].includes(status)) {
    return res.status(400).json({ status: 'error', message: 'Invalid status' });
  }
  try {
    const { data, error } = await supabase
      .from('feedback')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ status: 'error', message: 'Ticket not found' });
    res.json({ status: 'success', ticket: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;