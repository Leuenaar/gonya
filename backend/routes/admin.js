'use strict';
const express = require('express');
const router  = express.Router();
const { supabase }    = require('../lib/supabase');
const { verifyToken } = require('../middleware/auth');
const { generateQuarterlyProposal, updateProposalStatus } = require('../safety/quarterlyAudit');
const { sendProposalEmail }           = require('../safety/proposalDelivery');
const { getUsageStats }               = require('../lib/usageLogger');
const { logAudit, getAuditLog }       = require('../lib/auditLogger');
const { getAllSourcesForLanguage }     = require('../lib/newsLibrary');

// ── Admin role check middleware ───────────────────────────
const verifyAdmin = async (req, res, next) => {
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', req.userId)
      .single();
      
    // GW UBAH DI SINI: Izinkan 'admin' ATAU 'owner' buat masuk
    if (!profile || !['admin', 'owner'].includes(profile.role)) {
      return res.status(403).json({ status: 'error', message: 'Admin access required' });
    }
    
    next();
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};

// ── Health ping helper ────────────────────────────────────
const ping = async (label, fn, timeoutMs = 6000) => {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      ),
    ]);
    const latencyMs = Date.now() - start;
    return { label, status: latencyMs > 2500 ? 'slow' : 'ok', latencyMs };
  } catch (err) {
    return {
      label,
      status:    err.message === 'timeout' ? 'timeout' : 'error',
      latencyMs: Date.now() - start,
      error:     err.message,
    };
  }
};

// ── GET /api/admin/health ─────────────────────────────────
router.get('/health', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [
      { count: flagCount },
      { count: pendingMemories },
      { count: pendingProposals },
      { count: pendingFlags },
      { count: confirmedFlags },
      usageStats,
    ] = await Promise.all([
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }),
      supabase.from('memories').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('proposals').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).is('theones_verdict', null),
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).eq('theones_verdict', 'confirmed'),
      getUsageStats('day'),
    ]);

    const opusCallsToday = Object.entries(usageStats.byModel || {})
      .filter(([model]) => model.includes('opus'))
      .reduce((sum, [, data]) => sum + (data.calls || 0), 0);

    const apiPings = await Promise.all([
      ping('Anthropic API', async () => {
        const r = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key':         process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
        });
        if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      }),
      ping('Groq API', async () => {
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
      ping('Supabase DB', async () => {
        const { error } = await supabase.from('user_profiles').select('id').limit(1);
        if (error) throw new Error(error.message);
      }),
      ping('Guardian News API', async () => {
        const r = await fetch(
          `https://content.guardianapis.com/search?api-key=${process.env.GUARDIAN_API_KEY}&page-size=1`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
      ping('Resend Email', async () => {
        const r = await fetch('https://api.resend.com/domains', {
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
    ]);

    res.json({
      status: 'success',
      data: {
        flagCount:        flagCount        || 0,
        pendingMemories:  pendingMemories  || 0,
        pendingProposals: pendingProposals || 0,
        pendingFlags:     pendingFlags     || 0,
        confirmedFlags:   confirmedFlags   || 0,
        opusCallsToday,
        apiPings,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/cost?period=month ──────────────────────
router.get('/cost', verifyToken, verifyAdmin, async (req, res) => {
  const period = req.query.period || 'month';
  try {
    const stats = await getUsageStats(period);
    res.json({ status: 'success', data: stats });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/audit?limit=50 ────────────────────────
router.get('/audit', verifyToken, verifyAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  try {
    const entries = await getAuditLog(limit);
    res.json({ status: 'success', data: entries });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/flags ──────────────────────────────────
router.get('/flags', verifyToken, verifyAdmin, async (req, res) => {
  const limit    = Math.min(parseInt(req.query.limit) || 50, 100);
  const category = req.query.category;
  const risk     = req.query.risk;
  try {
    let query = supabase
      .from('safety_flags')
      .select('id, user_id, agent, risk_tier, category, theones_verdict, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (category && category !== 'all') query = query.eq('category', category);
    if (risk && risk !== 'all')         query = query.eq('risk_tier', risk);
    const { data, error } = await query;
    if (error) throw error;
    const [
      { count: confirmed },
      { count: falseAlarms },
      { count: pending },
    ] = await Promise.all([
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).eq('theones_verdict', 'confirmed'),
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).eq('theones_verdict', 'false_alarm'),
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).is('theones_verdict', null),
    ]);
    res.json({
      status: 'success',
      data:   data || [],
      stats:  { confirmed: confirmed || 0, falseAlarms: falseAlarms || 0, pending: pending || 0 },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/proposals ──────────────────────────────
router.get('/proposals', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('proposals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/admin/proposals/generate ───────────────────
router.post('/proposals/generate', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await generateQuarterlyProposal();
    if (result.status === 'success') {
      await logAudit('proposal',
        `Quarterly proposal generated by TheOnes — quarter: ${result.quarter}`,
        { proposalId: result.proposalId, quarter: result.quarter }
      );
    }
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/admin/proposals/:id ───────────────────────
router.patch('/proposals/:id', verifyToken, verifyAdmin, async (req, res) => {
  const { sectionApprovals } = req.body;
  if (!sectionApprovals) {
    return res.status(400).json({ status: 'error', message: 'sectionApprovals required' });
  }
  try {
    const result = await updateProposalStatus(req.params.id, sectionApprovals);
    await logAudit('proposal',
      `Proposal ${req.params.id} reviewed — status: ${result.overallStatus}`,
      { proposalId: req.params.id, sectionApprovals, overallStatus: result.overallStatus }
    );
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/admin/proposals/:id/email ──────────────────
router.post('/proposals/:id/email', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data: proposal } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (!proposal) return res.status(404).json({ status: 'error', message: 'Proposal not found' });
    const result = await sendProposalEmail(proposal);
    if (result.status === 'success') {
      await logAudit('proposal',
        `Proposal PDF emailed to owner — quarter: ${proposal.quarter}`,
        { proposalId: req.params.id, emailId: result.emailId }
      );
    }
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/memories ───────────────────────────────
router.get('/memories', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('id, user_id, agent_target, layer, category, content, confidence, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/admin/memories/:id ────────────────────────
router.patch('/memories/:id', verifyToken, verifyAdmin, async (req, res) => {
  const { action } = req.body;
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ status: 'error', message: 'action must be approved or rejected' });
  }
  try {
    const { error } = await supabase
      .from('memories')
      .update({ status: action })
      .eq('id', req.params.id);
    if (error) throw error;
    await logAudit('memory',
      `Memory ${req.params.id} ${action} by admin`,
      { memoryId: req.params.id, action }
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/agents ─────────────────────────────────
router.get('/agents', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agent_configs')
      .select('agent, domain, persona_prompt, is_dominant, created_at, updated_at');
    if (error) throw error;
    const [
      { count: akselFlags },
      { count: veraFlags },
    ] = await Promise.all([
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).eq('agent', 'Aksel'),
      supabase.from('safety_flags').select('*', { count: 'exact', head: true }).eq('agent', 'Vera'),
    ]);
    res.json({
      status: 'success',
      data:   data || [],
      stats:  { akselFlags: akselFlags || 0, veraFlags: veraFlags || 0 },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/news?lang=id|en ───────────────────────
router.get('/news', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const lang    = req.query.lang;
    const sources = lang
      ? getAllSourcesForLanguage(lang)
      : [
          ...getAllSourcesForLanguage('id'),
          ...getAllSourcesForLanguage('en'),
        ];
    res.json({ status: 'success', data: sources });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/news/health ────────────────────────────
router.get('/news/health', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const allSources = [
      ...getAllSourcesForLanguage('id'),
      ...getAllSourcesForLanguage('en'),
    ];

    const results = await Promise.all(
      allSources.map(async (source) => {
        if (source.type === 'api' || !source.url) {
          return { id: source.id, status: 'api', latencyMs: null };
        }

        const start      = Date.now();
        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), 7000);

        try {
          await fetch(source.url, {
            method: 'GET',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HealthCheck/1.0)' },
          });
          clearTimeout(timeout);
          const latencyMs = Date.now() - start;
          return {
            id:       source.id,
            status:   latencyMs > 3000 ? 'slow' : 'ok',
            latencyMs,
          };
        } catch (err) {
          clearTimeout(timeout);
          return {
            id:        source.id,
            status:    err.name === 'AbortError' ? 'timeout' : 'error',
            latencyMs: Date.now() - start,
            error:     err.message,
          };
        }
      })
    );

    res.json({ status: 'success', data: results });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/tokens ──────────────────────────────────
router.get('/tokens', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('guest_access_tokens')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── POST /api/admin/tokens — generate a guest access token ─
router.post('/tokens', verifyToken, verifyAdmin, async (req, res) => {
  const { assignedUserId } = req.body;
  if (!assignedUserId) {
    return res.status(400).json({ status: 'error', message: 'assignedUserId is required' });
  }
  try {
    const code = 'GNY-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const { data, error } = await supabase
      .from('guest_access_tokens')
      .insert([{ token: code, chat_quota: 20, assigned_user_id: assignedUserId }])
      .select()
      .single();
    if (error) throw error;
    await logAudit('token',
      `Guest token generated for user ${assignedUserId}`,
      { tokenId: data.id, token: code, assignedUserId }
    );
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── DELETE /api/admin/tokens/:id — revoke a guest access token ─
router.delete('/tokens/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('guest_access_tokens')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    await logAudit('token',
      `Guest token ${req.params.id} revoked`,
      { tokenId: req.params.id }
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── PATCH /api/admin/users/:id/role — change a user's role ─
router.patch('/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
  const { role: newRole } = req.body;
  if (!['owner', 'admin', 'guest'].includes(newRole)) {
    return res.status(400).json({ status: 'error', message: 'Invalid role' });
  }
  try {
    const [{ data: actor }, { data: target }] = await Promise.all([
      supabase.from('user_profiles').select('role').eq('id', req.userId).single(),
      supabase.from('user_profiles').select('role').eq('id', req.params.id).single(),
    ]);
    if (!target) return res.status(404).json({ status: 'error', message: 'User not found' });

    if (newRole === 'owner' && actor.role !== 'owner') {
      return res.status(403).json({ status: 'error', message: 'Only an owner can grant owner role' });
    }
    if (target.role === 'owner' && actor.role !== 'owner') {
      return res.status(403).json({ status: 'error', message: "Only an owner can change another owner's role" });
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({ role: newRole })
      .eq('id', req.params.id);
    if (error) throw error;
    await logAudit('user_role',
      `User ${req.params.id} role changed to ${newRole} by ${req.userId}`,
      { userId: req.params.id, newRole, changedBy: req.userId }
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── GET /api/admin/users ───────────────────────────────────
router.get('/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ status: 'success', data: data || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;