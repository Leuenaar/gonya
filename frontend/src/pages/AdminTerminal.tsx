import { useState, useEffect, useCallback } from 'react';
import { apiFetch, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
type TranslationKeyLike = Parameters<typeof t>[0];
import './AdminTerminal.css';

interface Props {
  profile: UserProfile;
  onBack:  () => void;
}

interface ApiPing {
  label:     string;
  status:    'ok' | 'slow' | 'error' | 'timeout';
  latencyMs: number;
  error?:    string;
}

interface HealthData {
  flagCount:        number;
  pendingMemories:  number;
  pendingProposals: number;
  pendingFlags:     number;
  confirmedFlags:   number;
  opusCallsToday:   number;
  apiPings:         ApiPing[];
  checkedAt:        string;
}

interface ModelStat {
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
  calls:        number;
}

interface UsageStats {
  byModel:           Record<string, ModelStat>;
  totalCostUsd:      number;
  totalInputTokens:  number;
  totalOutputTokens: number;
}

interface AuditEntry {
  id:         string;
  event_type: string;
  message:    string;
  metadata:   Record<string, unknown> | null;
  created_at: string;
}

interface SafetyFlag {
  id:              string;
  agent:           string;
  risk_tier:       string;
  category:        string;
  theones_verdict: string | null;
  created_at:      string;
}

interface FlagStats {
  confirmed:   number;
  falseAlarms: number;
  pending:     number;
}

interface ProposalSection {
  observations:    string[];
  recommendations: string[];
  priority:        'high' | 'medium' | 'low';
}

interface Proposal {
  id:              string;
  quarter:         string;
  status:          string;
  safety_conduct:  ProposalSection | null;
  api_news:        ProposalSection | null;
  bug_function:    ProposalSection | null;
  user_feedback:   ProposalSection | null;
  theones_summary: string;
  created_at:      string;
  reviewed_at:     string | null;
}

interface Memory {
  id:           string;
  agent_target: string;
  layer:        number;
  category:     string;
  content:      string;
  confidence:   number;
  created_at:   string;
}

interface AgentConfig {
  agent:          string;
  domain:         string;
  persona_prompt: string;
  is_dominant:    boolean;
  updated_at:     string;
}

interface AgentStats {
  akselFlags: number;
  veraFlags:  number;
}

interface NewsSource {
  id:           string;
  name:         string;
  type:         string;
  language:     string;
  requires_key: boolean;
  note?:        string;
  url?:         string;
}

interface NewsSourceHealth {
  id:        string;
  status:    'ok' | 'slow' | 'error' | 'timeout' | 'api';
  latencyMs: number | null;
  error?:    string;
}

type Section = 'health' | 'cost' | 'alerts' | 'tokens' | 'users' | 'proposals' | 'flags' | 'govlog' | 'memory' | 'agents' | 'news' | 'tickets' | 'agesignals';

interface AgeEvidence {
  at:                string;
  category:           string;
  delta:              number;
  reason:             string;
  confidence_after:   number;
}

interface AgeSignal {
  user_id:            string;
  minor_confidence:   number;
  check_count:        number;
  status:             'monitoring' | 'flagged' | 'adult_confirmed' | 'inconclusive';
  last_category:      string | null;
  evidence_log:       AgeEvidence[];
  admin_reviewed_at:  string | null;
  admin_verdict:      'adult_confirmed' | 'resolved_minor' | null;
  created_at:         string;
  updated_at:         string;
}

interface TicketMessage {
  sender:  string;
  content: string;
}

interface Ticket {
  id:         string;
  ticket_no:  string;
  user_id:    string;
  type:       'feedback' | 'support';
  subject:    string;
  transcript: TicketMessage[];
  status:     'new' | 'reviewed' | 'resolved';
  created_at: string;
  updated_at: string;
}

interface GuestToken {
  id: string;
  token: string;
  personal_onboard_used: boolean;
  group_onboard_used: boolean;
  chat_quota: number;
  assigned_user_id: string | null;
  created_at: string;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8':           'claude-opus-4-8 (TheOnes + escalation)',
  'claude-sonnet-4-6':         'claude-sonnet-4-6 (Vera responses)',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5 (Safety Core)',
  'llama-3.3-70b-versatile':   'llama-3.3-70b (Aksel)',
};

const SECTION_KEYS   = ['safety_conduct', 'api_news', 'bug_function', 'user_feedback'] as const;
const SECTION_TITLE_KEYS: Record<string, TranslationKeyLike> = {
  safety_conduct: 'atSecSafetyConduct',
  api_news:       'atSecApiNews',
  bug_function:   'atSecBugFunction',
  user_feedback:  'atSecUserFeedback',
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

const pingDotClass = (status: string) => {
  if (status === 'ok')  return 'at-nd-ok';
  if (status === 'slow') return 'at-nd-wn';
  return 'at-nd-rd';
};

const pingSpClass = (status: string) => {
  if (status === 'ok')  return 'at-sp-ok';
  if (status === 'slow') return 'at-sp-wn';
  return 'at-sp-rd';
};

const pingLabel = (ping: ApiPing, lang?: string | null) => {
  if (ping.status === 'ok')      return t('atPingOnline', lang, { ms: ping.latencyMs });
  if (ping.status === 'slow')    return t('atPingSlow', lang, { ms: ping.latencyMs });
  if (ping.status === 'timeout') return t('atPingTimeout', lang);
  return t('atPingError', lang, { err: ping.error || 'unknown' });
};

const pingWarnClass = (status: string) => {
  if (status === 'ok')  return 'at-aw-ok';
  if (status === 'slow') return 'at-aw-wn';
  return 'at-aw-rd';
};

const pingWarnMsg = (ping: ApiPing, lang?: string | null) => {
  if (ping.status === 'ok')      return t('atPingRespondingOk', lang, { ms: ping.latencyMs });
  if (ping.status === 'slow')    return t('atPingSlowWarn', lang, { ms: ping.latencyMs });
  if (ping.status === 'timeout') return t('atPingTimeoutWarn', lang);
  return t('atPingErrorWarn', lang, { err: ping.error || 'unknown' });
};

export default function AdminTerminal({ profile, onBack }: Props) {
  const lang = profile.language;
  const [section,      setSection]      = useState<Section>('health');
  const [health,       setHealth]       = useState<HealthData | null>(null);
  const [usage,        setUsage]        = useState<UsageStats | null>(null);
  const [auditLog,     setAuditLog]     = useState<AuditEntry[]>([]);
  const [flags,        setFlags]        = useState<SafetyFlag[]>([]);
  const [flagStats,    setFlagStats]    = useState<FlagStats>({ confirmed: 0, falseAlarms: 0, pending: 0 });
  const [proposals,    setProposals]    = useState<Proposal[]>([]);
  const [memories,     setMemories]     = useState<Memory[]>([]);
  const [agents,       setAgents]       = useState<AgentConfig[]>([]);
  const [agentStats,   setAgentStats]   = useState<AgentStats>({ akselFlags: 0, veraFlags: 0 });
  const [newsSources,  setNewsSources]  = useState<NewsSource[]>([]);
  const [newsHealth,   setNewsHealth]   = useState<NewsSourceHealth[]>([]);
  const [tickets,      setTickets]      = useState<Ticket[]>([]);
  const [tokens,       setTokens]       = useState<GuestToken[]>([]);
  const [usersList,    setUsersList]    = useState<UserProfile[]>([]);
  const [ticketFilter, setTicketFilter] = useState('all');
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  const [ageSignals,     setAgeSignals]     = useState<AgeSignal[]>([]);
  const [ageFilter,      setAgeFilter]      = useState('all');
  const [expandedAgeSig, setExpandedAgeSig] = useState<string | null>(null);
  const [loading,      setLoading]      = useState<Record<string, boolean>>({});
  const [flagFilter,   setFlagFilter]   = useState('all');
  const [newsLang,     setNewsLang]     = useState('all');
  const [sectionApprovals, setSectionApprovals] = useState<Record<string, Record<string, string>>>({});
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState<string | null>(null);

  const [showTokenModal, setShowTokenModal] = useState(false);
  const [selectedTokenUser, setSelectedTokenUser] = useState<string>('');

  const setLoad = (key: string, val: boolean) =>
    setLoading(prev => ({ ...prev, [key]: val }));

  const fetchHealth = useCallback(async () => {
    setLoad('health', true);
    try {
      const res  = await apiFetch('/api/admin/health');
      const data = await res.json();
      if (data.status === 'success') setHealth(data.data);
    } catch {} finally { setLoad('health', false); }
  }, []);

  const fetchCost = useCallback(async () => {
    setLoad('cost', true);
    try {
      const res  = await apiFetch('/api/admin/cost?period=month');
      const data = await res.json();
      if (data.status === 'success') setUsage(data.data);
    } catch {} finally { setLoad('cost', false); }
  }, []);

  const fetchAudit = useCallback(async () => {
    setLoad('audit', true);
    try {
      const res  = await apiFetch('/api/admin/audit?limit=30');
      const data = await res.json();
      if (data.status === 'success') setAuditLog(data.data || []);
    } catch {} finally { setLoad('audit', false); }
  }, []);

  const fetchFlags = useCallback(async () => {
    setLoad('flags', true);
    try {
      const res  = await apiFetch('/api/admin/flags?limit=50');
      const data = await res.json();
      if (data.status === 'success') {
        setFlags(data.data || []);
        setFlagStats(data.stats || { confirmed: 0, falseAlarms: 0, pending: 0 });
      }
    } catch {} finally { setLoad('flags', false); }
  }, []);

  const fetchProposals = useCallback(async () => {
    setLoad('proposals', true);
    try {
      const res  = await apiFetch('/api/admin/proposals');
      const data = await res.json();
      if (data.status === 'success') setProposals(data.data || []);
    } catch {} finally { setLoad('proposals', false); }
  }, []);

  const fetchMemories = useCallback(async () => {
    setLoad('memories', true);
    try {
      const res  = await apiFetch('/api/admin/memories');
      const data = await res.json();
      if (data.status === 'success') setMemories(data.data || []);
    } catch {} finally { setLoad('memories', false); }
  }, []);

  const fetchAgents = useCallback(async () => {
    setLoad('agents', true);
    try {
      const res  = await apiFetch('/api/admin/agents');
      const data = await res.json();
      if (data.status === 'success') {
        setAgents(data.data || []);
        if (data.stats) setAgentStats(data.stats);
      }
    } catch {} finally { setLoad('agents', false); }
  }, []);

  const fetchNews = useCallback(async (lang: string) => {
    setLoad('news', true);
    try {
      const q    = lang === 'all' ? '' : `?lang=${lang}`;
      const res  = await apiFetch(`/api/admin/news${q}`);
      const data = await res.json();
      if (data.status === 'success') setNewsSources(data.data || []);
    } catch {} finally { setLoad('news', false); }
  }, []);

  const fetchNewsHealth = useCallback(async () => {
    setLoad('newsHealth', true);
    try {
      const res  = await apiFetch('/api/admin/news/health');
      const data = await res.json();
      if (data.status === 'success') setNewsHealth(data.data || []);
    } catch {} finally { setLoad('newsHealth', false); }
  }, []);

  const fetchTickets = useCallback(async () => {
    setLoad('tickets', true);
    try {
      const res  = await apiFetch('/api/feedback');
      const data = await res.json();
      if (data.status === 'success') setTickets(data.tickets || []);
    } catch {} finally { setLoad('tickets', false); }
  }, []);

  const fetchAgeSignals = useCallback(async () => {
    setLoad('agesignals', true);
    try {
      const res  = await apiFetch('/api/age-patterns');
      const data = await res.json();
      if (data.status === 'success') setAgeSignals(data.signals || []);
    } catch {} finally { setLoad('agesignals', false); }
  }, []);

  const fetchTokens = useCallback(async () => {
    setLoad('tokens', true);
    try {
      const res  = await apiFetch('/api/admin/tokens');
      const data = await res.json();
      if (data.status === 'success') setTokens(data.data);
    } catch {} finally { setLoad('tokens', false); }
  }, []);

  const fetchUsersList = useCallback(async () => {
    setLoad('users', true);
    try {
      const res  = await apiFetch('/api/admin/users');
      const data = await res.json();
      if (data.status === 'success') setUsersList(data.data as UserProfile[]);
    } catch {} finally { setLoad('users', false); }
  }, []);

  useEffect(() => { fetchHealth(); fetchCost(); fetchTickets(); fetchAgeSignals(); }, []);

  useEffect(() => {
    if (section === 'health' || section === 'alerts') fetchHealth();
    if (section === 'cost')      fetchCost();
    if (section === 'govlog')    fetchAudit();
    if (section === 'flags')     fetchFlags();
    if (section === 'proposals') fetchProposals();
    if (section === 'memory')    fetchMemories();
    if (section === 'agents')    { fetchAgents(); fetchCost(); }
    if (section === 'news')      { fetchNews('all'); fetchNewsHealth(); }
    if (section === 'tickets')   fetchTickets();
    if (section === 'agesignals') fetchAgeSignals();
    if (section === 'tokens')    { fetchTokens(); fetchUsersList(); }
    if (section === 'users')     fetchUsersList();
  }, [section]);

  useEffect(() => {
    if (section === 'news') fetchNews(newsLang);
  }, [newsLang]);

  const generateToken = async () => {
    if (!selectedTokenUser) {
      alert('Please select a user first.');
      return;
    }
    setLoad('genToken', true);
    try {
      const res  = await apiFetch('/api/admin/tokens', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assignedUserId: selectedTokenUser }),
      });
      const data = await res.json();
      if (data.status !== 'success') {
        alert('Failed to generate token: ' + data.message);
      } else {
        setShowTokenModal(false);
        setSelectedTokenUser('');
        fetchTokens();
      }
    } catch {} finally {
      setLoad('genToken', false);
    }
  };

  const revokeToken = async (id: string) => {
    if (!window.confirm('Are you sure you want to revoke and delete this token?')) return;
    try {
      await apiFetch(`/api/admin/tokens/${id}`, { method: 'DELETE' });
      fetchTokens();
    } catch {}
  };

  const updateUserRole = async (id: string, newRole: string) => {
    if (!window.confirm(`Change this user's role to ${newRole.toUpperCase()}?`)) return;
    try {
      const res  = await apiFetch(`/api/admin/users/${id}/role`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (data.status !== 'success') {
        alert('Failed to update role: ' + data.message);
      } else {
        fetchUsersList();
      }
    } catch {}
  };

  const approveMemory = async (id: string, action: 'approved' | 'rejected') => {
    try {
      await apiFetch(`/api/admin/memories/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      });
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch {}
  };

  const updateTicketStatus = async (id: string, status: 'reviewed' | 'resolved') => {
    try {
      const res  = await apiFetch(`/api/feedback/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status }),
      });
      const data = await res.json();
      if (data.status === 'success' && data.ticket) {
        setTickets(prev => prev.map(t => t.id === id ? data.ticket : t));
      }
    } catch {}
  };

  const updateAgeVerdict = async (userId: string, verdict: 'adult_confirmed' | 'resolved_minor') => {
    try {
      const res  = await apiFetch(`/api/age-patterns/${userId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ verdict }),
      });
      const data = await res.json();
      if (data.status === 'success' && data.signal) {
        setAgeSignals(prev => prev.map(s => s.user_id === userId ? data.signal : s));
      }
    } catch {}
  };

  const handleSectionApproval = (proposalId: string, key: string, verdict: string) => {
    setSectionApprovals(prev => ({
      ...prev,
      [proposalId]: { ...(prev[proposalId] || {}), [key]: verdict },
    }));
  };

  const submitProposalReview = async (proposalId: string) => {
    const approvals = sectionApprovals[proposalId];
    if (!approvals) return;
    try {
      await apiFetch(`/api/admin/proposals/${proposalId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sectionApprovals: approvals }),
      });
      fetchProposals();
      fetchAudit();
    } catch {}
  };

  const sendEmail = async (proposalId: string) => {
    try {
      await apiFetch(`/api/admin/proposals/${proposalId}/email`, { method: 'POST' });
      alert('PDF sent to owner email.');
      fetchAudit();
    } catch {}
  };

  const generateProposal = async () => {
    setLoad('generate', true);
    try {
      const res  = await apiFetch('/api/admin/proposals/generate', { method: 'POST' });
      const data = await res.json();
      if (data.data?.status === 'skipped') {
        alert('Proposal for this quarter already exists.');
      } else {
        fetchProposals();
        fetchAudit();
      }
    } catch {} finally { setLoad('generate', false); }
  };

  const filteredFlags = flags.filter(f =>
    flagFilter === 'all'     ? true
    : flagFilter === 'high'  ? f.risk_tier === 'high'
    : f.category === flagFilter
  );

  const pendingProposal = proposals.find(p => p.status === 'pending');
  const prevProposals   = proposals.filter(p => p.status !== 'pending');
  const totalPending    = (health?.pendingFlags ?? 0) + (health?.pendingMemories ?? 0) + (health?.pendingProposals ?? 0);
  const anthropicCost   = Object.entries(usage?.byModel || {})
    .filter(([m]) => m.includes('claude'))
    .reduce((sum, [, d]) => sum + d.costUsd, 0);

  const getNewsSourceHealth = (id: string): NewsSourceHealth | null =>
    newsHealth.find(h => h.id === id) || null;

  // Bug fix (27 Jul 2026): guest_access_tokens only ever stored
  // assigned_user_id (a raw UUID) — it was never meant to duplicate the
  // user's name on the token record itself. The Guest Tokens table was
  // displaying that raw, truncated UUID directly, which is what actually
  // caused "no username shown" for assigned tokens. Fix reuses usersList
  // (now also fetched when viewing this section) via a lookup map.
  const userById = new Map(usersList.map(u => [u.id, u]));

  const ticketCounts = {
    new:      tickets.filter(t => t.status === 'new').length,
    reviewed: tickets.filter(t => t.status === 'reviewed').length,
    resolved: tickets.filter(t => t.status === 'resolved').length,
  };
  const filteredTickets = tickets.filter(tk =>
    ticketFilter === 'all' ? true
    : ['new', 'reviewed', 'resolved'].includes(ticketFilter) ? tk.status === ticketFilter
    : tk.type === ticketFilter
  );

  const filteredAgeSignals = ageSignals.filter(s => ageFilter === 'all' ? true : s.status === ageFilter);
  const pendingAgeFlags = ageSignals.filter(s => s.status === 'flagged' && !s.admin_verdict).length;

  const navItems = [
    { id: 'health',    label: t('atNavHealth', lang),    group: t('atGroupOverview', lang),   badge: null },
    { id: 'cost',      label: t('atNavCost', lang),      group: t('atGroupOverview', lang),   badge: null },
    { id: 'alerts',    label: t('atNavAlerts', lang),    group: t('atGroupOverview', lang),   badge: totalPending > 0 ? String(totalPending) : null },
    { id: 'tokens',    label: t('atNavTokens', lang),    group: t('atGroupOverview', lang),   badge: null },
    { id: 'users',     label: t('atNavUsers', lang),     group: t('atGroupGovernance', lang), badge: null },
    { id: 'proposals', label: t('atNavProposals', lang), group: t('atGroupGovernance', lang), badge: health?.pendingProposals ? String(health.pendingProposals) : null },
    { id: 'flags',     label: t('atNavFlags', lang),     group: t('atGroupGovernance', lang), badge: health?.pendingFlags ? String(health.pendingFlags) : null },
    { id: 'agesignals',label: t('atNavAgeSignals', lang),group: t('atGroupGovernance', lang), badge: pendingAgeFlags > 0 ? String(pendingAgeFlags) : null },
    { id: 'govlog',    label: t('atNavGovLog', lang),    group: t('atGroupGovernance', lang), badge: null },
    { id: 'memory',    label: t('atNavMemory', lang),    group: t('atGroupAgents', lang),     badge: health?.pendingMemories ? String(health.pendingMemories) : null },
    { id: 'agents',    label: t('atNavAgents', lang),    group: t('atGroupAgents', lang),     badge: null },
    { id: 'tickets',   label: t('atNavTickets', lang),   group: t('atGroupSupport', lang),    badge: ticketCounts.new > 0 ? String(ticketCounts.new) : null },
    { id: 'news',      label: t('atNavNews', lang),      group: t('atGroupContent', lang),    badge: null },
  ];

  const groups = [t('atGroupOverview', lang), t('atGroupGovernance', lang), t('atGroupAgents', lang), t('atGroupSupport', lang), t('atGroupContent', lang)];

  const renderPriTag = (pri: string) => (
    <span className={`at-pri at-pri-${pri === 'high' ? 'h' : pri === 'medium' ? 'm' : 'l'}`}>
      {pri.charAt(0).toUpperCase() + pri.slice(1)}
    </span>
  );

  const renderProposalSection = (proposal: Proposal, key: typeof SECTION_KEYS[number]) => {
    const sec     = proposal[key] as ProposalSection | null;
    if (!sec) return null;
    const verdict = sectionApprovals[proposal.id]?.[key];
    return (
      <div className="at-psec" key={key}>
        <div className="at-psec-header">
          <span className="at-psec-title">{t(SECTION_TITLE_KEYS[key], lang)}</span>
          {renderPriTag(sec.priority)}
        </div>
        {(sec.observations || []).map((o, i) => <div key={i} className="at-psec-obs">{o}</div>)}
        <div className="at-divider" />
        {(sec.recommendations || []).map((r, i) => <div key={i} className="at-psec-rec">{r}</div>)}
        <div className="at-btn-group">
          {verdict ? (
            <span style={{ fontSize: 11, fontWeight: 500, color: verdict === 'approved' ? 'var(--at-green)' : 'var(--at-red)' }}>
              {verdict === 'approved' ? t('atApprovedTag', lang) : t('atRejectedTag', lang)}
            </span>
          ) : (
            <>
              <button className="at-btn at-btn-danger"  onClick={() => handleSectionApproval(proposal.id, key, 'rejected')}>{t('atReject', lang)}</button>
              <button className="at-btn at-btn-success" onClick={() => handleSectionApproval(proposal.id, key, 'approved')}>{t('atApprove', lang)}</button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="at-root">

      <div className="at-topbar">
        <button className="at-hamburger" onClick={() => setMobileNavOpen(p => !p)} aria-label="Menu">☰</button>
        <div className="at-logo">
          <svg className="at-logo-icon" viewBox="0 0 22 22" fill="none">
            <path d="M11 2L20 18H2L11 2Z" stroke="#00e5ff" strokeWidth="1.5" strokeLinejoin="round" fill="rgba(0,229,255,0.06)"/>
          </svg>
          <div>
            <div className="at-logo-text">Gonya</div>
            <div className="at-logo-sub">{t('msNavAdminTerminal', lang)}</div>
          </div>
        </div>
        <div className="at-pills">
          {health?.apiPings?.every(p => p.status === 'ok')
            ? <span className="at-pill at-pill-ok"><span className="at-pill-dot" />{t('atAllSystemsOnline', lang)}</span>
            : health?.apiPings?.some(p => p.status === 'error' || p.status === 'timeout')
              ? <span className="at-pill at-pill-rd"><span className="at-pill-dot" />{t('atServiceIssue', lang)}</span>
              : health?.apiPings
                ? <span className="at-pill at-pill-wn"><span className="at-pill-dot" />{t('atDegradedPerf', lang)}</span>
                : <span className="at-pill at-pill-ok"><span className="at-pill-dot" />{t('atOnline', lang)}</span>
          }
          {(health?.pendingFlags ?? 0) > 0     && <span className="at-pill at-pill-wn">{t('atPendingFlagsPill', lang, { n: health!.pendingFlags })}</span>}
          {(health?.pendingMemories ?? 0) > 0  && <span className="at-pill at-pill-cy">{t('atPendingMemPill', lang, { n: health!.pendingMemories })}</span>}
          {(health?.pendingProposals ?? 0) > 0 && <span className="at-pill at-pill-wn">{t('atProposalPendingPill', lang, { n: health!.pendingProposals })}</span>}
          {usage && usage.totalCostUsd > 0     && <span className="at-pill at-pill-wn">{t('atMtdPill', lang, { cost: fmtUsd(usage.totalCostUsd) })}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="at-btn at-btn-ghost" onClick={onBack} style={{ fontSize: 11 }}>{t('atBackToChat', lang)}</button>
          <span className="at-user">{profile.display_name} // {profile.role ? profile.role.charAt(0).toUpperCase() + profile.role.slice(1) : 'Admin'}</span>
        </div>
      </div>

      <div className="at-shell">

        {mobileNavOpen && <div className="at-nav-backdrop" onClick={() => setMobileNavOpen(false)} />}

        <nav className={`at-sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
          {groups.map(group => (
            <div className="at-sidebar-group" key={group}>
              <span className="at-sidebar-label">{group}</span>
              {navItems.filter(n => n.group === group).map(n => (
                <button
                  key={n.id}
                  className={`at-nav-item ${section === n.id ? 'active' : ''}`}
                  onClick={() => { setSection(n.id as Section); setMobileNavOpen(false); }}
                >
                  {n.label}
                  {n.badge && <span className="at-nav-badge">{n.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="at-main">

          <div className={`at-section ${section === 'health' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavHealth', lang)}</div>
            <div className="at-section-meta">
              {health ? t('atLastChecked', lang, { time: fmtTime(health.checkedAt) }) : t('atLoadingGeneric', lang)}
              {health && <button className="at-btn at-btn-ghost" style={{ fontSize: 10, padding: '2px 8px', marginLeft: 10 }} onClick={fetchHealth}>{t('atRefresh', lang)}</button>}
            </div>

            <div className="at-g4" style={{ marginBottom: 20 }}>
              <div className="at-stat"><div className="at-stat-label">{t('atSafetyFlags90d', lang)}</div><div className="at-stat-value at-v-am">{loading.health ? '...' : health?.flagCount ?? 0}</div><div className="at-stat-sub">{t('atConfirmedCount', lang, { n: health?.confirmedFlags ?? 0 })}</div></div>
              <div className="at-stat"><div className="at-stat-label">{t('atOpusCallsToday', lang)}</div><div className="at-stat-value at-v-cy">{loading.health ? '...' : health?.opusCallsToday ?? 0}</div><div className="at-stat-sub">{t('atLimitPerHour', lang)}</div></div>
              <div className="at-stat"><div className="at-stat-label">{t('atPendingMemories', lang)}</div><div className="at-stat-value at-v-rd">{loading.health ? '...' : health?.pendingMemories ?? 0}</div><div className="at-stat-sub">{t('atAwaitingApproval', lang)}</div></div>
              <div className="at-stat"><div className="at-stat-label">{t('atCostThisMonth', lang)}</div><div className="at-stat-value at-v-gn">{usage ? fmtUsd(usage.totalCostUsd) : '...'}</div><div className="at-stat-sub">{t('atFromUsageLogs', lang)}</div></div>
            </div>

            {loading.health && <div className="at-loading">{t('atPingingServices', lang)}</div>}

            {!loading.health && health?.apiPings && (
              <div className="at-g2">
                {health.apiPings.map(ping => (
                  <div key={ping.label} className="at-api-card">
                    <div className="at-api-header">
                      <span className="at-api-name">{ping.label}</span>
                      <span className={`at-sp ${pingSpClass(ping.status)}`}>
                        {ping.status === 'ok' ? t('atStatusOk', lang) : ping.status === 'slow' ? t('atStatusSlow', lang) : ping.status === 'timeout' ? t('atStatusTimeout', lang) : t('atStatusError', lang)}
                      </span>
                    </div>
                    <div className="at-api-rows">
                      <div className="at-api-row">
                        <span className="at-api-key">{t('atLatency', lang)}</span>
                        <span className={`at-api-val ${ping.status === 'ok' ? 'at-av-ok' : ping.status === 'slow' ? 'at-av-wn' : 'at-av-rd'}`}>
                          {ping.latencyMs != null ? `${ping.latencyMs}ms` : t('atNA', lang)}
                        </span>
                      </div>
                      <div className="at-api-row">
                        <span className="at-api-key">{t('atStatus', lang)}</span>
                        <span className="at-api-val at-av-nt">{pingLabel(ping, lang)}</span>
                      </div>
                    </div>
                    <div className="at-quota-track">
                      <div
                        className={`at-quota-fill ${ping.status === 'ok' ? 'at-qf-ok' : ping.status === 'slow' ? 'at-qf-wn' : 'at-qf-rd'}`}
                        style={{ width: ping.status === 'ok' ? '100%' : ping.status === 'slow' ? '60%' : '20%' }}
                      />
                    </div>
                    <div className={`at-api-warn ${pingWarnClass(ping.status)}`}>{pingWarnMsg(ping, lang)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`at-section ${section === 'cost' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavCost', lang)}</div>
            <div className="at-section-meta">
              {t('atCostMeta', lang)}
            </div>
            {loading.cost && <div className="at-loading">{t('atLoadingCost', lang)}</div>}
            {!loading.cost && usage && (
              <>
                <div className="at-summary-bar" style={{ marginBottom: 20 }}>
                  <div className="at-sb-item"><div className="at-sb-label">{t('atAnthropicMtd', lang)}</div><div className="at-sb-value at-v-am">{fmtUsd(anthropicCost)}</div></div>
                  <div className="at-sb-sep" />
                  <div className="at-sb-item"><div className="at-sb-label">{t('atGroqMtd', lang)}</div><div className="at-sb-value at-v-gn">$0.00</div></div>
                  <div className="at-sb-sep" />
                  <div className="at-sb-item"><div className="at-sb-label">{t('atTotalMtd', lang)}</div><div className="at-sb-value at-v-am">{fmtUsd(usage.totalCostUsd)}</div></div>
                  <div className="at-sb-sep" />
                  <div className="at-sb-item"><div className="at-sb-label">{t('atInputTokens', lang)}</div><div className="at-sb-value at-v-wt">{usage.totalInputTokens.toLocaleString()}</div></div>
                  <div className="at-sb-sep" />
                  <div className="at-sb-item"><div className="at-sb-label">{t('atOutputTokens', lang)}</div><div className="at-sb-value at-v-wt">{usage.totalOutputTokens.toLocaleString()}</div></div>
                </div>
                <div className="at-card">
                  <div className="at-card-title">{t('atBreakdownByModel', lang)}</div>
                  <div className="at-tbl-wrap">
                    <table className="at-tbl">
                      <thead>
                        <tr><th>{t('atColModel', lang)}</th><th>{t('atColCalls', lang)}</th><th>{t('atInputTokens', lang)}</th><th>{t('atOutputTokens', lang)}</th><th>{t('atColCostUsd', lang)}</th></tr>
                      </thead>
                      <tbody>
                        {Object.entries(usage.byModel).length === 0 ? (
                          <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--at-t3)', padding: 16 }}>{t('atNoUsageDataStart', lang)}</td></tr>
                        ) : Object.entries(usage.byModel).map(([model, stat]) => (
                          <tr key={model}>
                            <td style={{ fontSize: 11 }}>{MODEL_LABELS[model] || model}</td>
                            <td className="at-td-mono">{stat.calls}</td>
                            <td className="at-td-mono">{stat.inputTokens.toLocaleString()}</td>
                            <td className="at-td-mono">{stat.outputTokens.toLocaleString()}</td>
                            <td className="at-td-mono" style={{ color: stat.costUsd > 0 ? 'var(--at-amber)' : 'var(--at-green)' }}>{fmtUsd(stat.costUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--at-t3)', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--at-b1)', lineHeight: 1.6 }}>
                    {t('atPricingNote', lang)}
                  </div>
                </div>
              </>
            )}
            {!loading.cost && !usage && (
              <div className="at-empty">{t('atNoUsageDataFirst', lang)}</div>
            )}
          </div>

          <div className={`at-section ${section === 'alerts' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavAlerts', lang)}</div>
            <div className="at-section-meta">{t('atAlertsMeta', lang)}</div>
            <div className="at-gap-12">
              {health?.apiPings?.filter(p => p.status !== 'ok').map(ping => (
                <div key={ping.label} className={`at-alert ${ping.status === 'slow' ? 'at-alert-wn' : 'at-alert-rd'}`}>
                  <div className="at-alert-header">
                    <span className="at-alert-icon">{ping.status === 'slow' ? '🟡' : '🔴'}</span>
                    <span className={`at-alert-title ${ping.status === 'slow' ? 'at-at-wn' : 'at-at-rd'}`}>
                      {ping.status === 'slow' ? t('atWarningLabel', lang) : t('atErrorLabel', lang)} — {ping.label}
                    </span>
                    <span className="at-alert-time">{health ? fmtTime(health.checkedAt) : ''}</span>
                  </div>
                  <div className="at-alert-msg">{pingWarnMsg(ping, lang)}</div>
                  <button className="at-alert-action" onClick={() => setSection('health')}>{t('atViewSystemHealth', lang)}</button>
                </div>
              ))}
              {(health?.pendingFlags ?? 0) > 0 && (
                <div className="at-alert at-alert-wn">
                  <div className="at-alert-header"><span className="at-alert-icon">🟡</span><span className="at-alert-title at-at-wn">{t('atWarnPendingSafety', lang)}</span></div>
                  <div className="at-alert-msg">{t('atSafetyFlagsNoVerdict', lang, { n: health!.pendingFlags })}</div>
                  <button className="at-alert-action" onClick={() => setSection('flags')}>{t('atViewSafetyFlags', lang)}</button>
                </div>
              )}
              {(health?.pendingMemories ?? 0) > 0 && (
                <div className="at-alert at-alert-ok">
                  <div className="at-alert-header"><span className="at-alert-icon">🟢</span><span className="at-alert-title at-at-ok">{t('atInfoMemoriesPending', lang)}</span></div>
                  <div className="at-alert-msg">{t('atMemoriesPendingMsg', lang, { n: health!.pendingMemories })}</div>
                  <button className="at-alert-action" onClick={() => setSection('memory')}>{t('atReviewMemoryControl', lang)}</button>
                </div>
              )}
              {(health?.pendingProposals ?? 0) > 0 && (
                <div className="at-alert at-alert-ok">
                  <div className="at-alert-header"><span className="at-alert-icon">🟢</span><span className="at-alert-title at-at-ok">{t('atInfoProposalPending', lang)}</span></div>
                  <div className="at-alert-msg">{t('atProposalPendingMsg', lang)}</div>
                  <button className="at-alert-action" onClick={() => setSection('proposals')}>{t('atOpenProposalReview', lang)}</button>
                </div>
              )}
              {!loading.health && totalPending === 0 && !health?.apiPings?.some(p => p.status !== 'ok') && (
                <div className="at-alert at-alert-ok">
                  <div className="at-alert-header"><span className="at-alert-icon">🟢</span><span className="at-alert-title at-at-ok">{t('atAllClear', lang)}</span></div>
                  <div className="at-alert-msg">{t('atAllClearMsg', lang)}</div>
                </div>
              )}
            </div>
          </div>

          <div className={`at-section ${section === 'tokens' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atTokensTitle', lang)}</div>
            <div className="at-section-meta">
              {t('atTokensMeta', lang)}
            </div>
            
            <div className="at-card" style={{ marginBottom: 16 }}>
              <div className="at-card-title-row">
                <span className="at-ctl">{t('atAccessControl', lang)}</span>
                <button className="at-btn at-btn-primary" onClick={() => setShowTokenModal(true)}>
                  {t('atGenerateNewToken', lang)}
                </button>
              </div>

              {showTokenModal && (
                <div className="at-card-sm" style={{ marginBottom: 16, border: '1px solid var(--at-cyan)' }}>
                  <div style={{ fontSize: 11, color: 'var(--at-cyan)', marginBottom: 8, fontWeight: 600 }}>{t('atGenTokenForUser', lang)}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select 
                      style={{ flex: 1, padding: '6px 10px', fontSize: 11, background: 'var(--at-s2)', color: 'var(--at-t1)', border: '1px solid var(--at-b2)', outline: 'none', borderRadius: '4px' }}
                      value={selectedTokenUser}
                      onChange={e => setSelectedTokenUser(e.target.value)}
                    >
                      <option value="">{t('atSelectGuestUser', lang)}</option>
                      {usersList.filter(u => u.role === 'guest').map(u => (
                        <option key={u.id} value={u.id}>{u.display_name || u.id.slice(0,8)} ({u.id.slice(0,8)})</option>
                      ))}
                    </select>
                    <button className="at-btn at-btn-primary" onClick={generateToken} disabled={loading.genToken || !selectedTokenUser}>
                      {loading.genToken ? t('atGenerating', lang) : t('atConfirm', lang)}
                    </button>
                    <button className="at-btn at-btn-ghost" onClick={() => { setShowTokenModal(false); setSelectedTokenUser(''); }}>{t('atCancel', lang)}</button>
                  </div>
                </div>
              )}
              
              {loading.tokens ? <div className="at-loading">{t('atLoadingTokens', lang)}</div> : (
                <div className="at-tbl-wrap">
                  <table className="at-tbl">
                    <thead>
                      <tr>
                        <th>{t('atColTokenCode', lang)}</th>
                        <th>{t('atColPersonalOnb', lang)}</th>
                        <th>{t('atColGroupOnb', lang)}</th>
                        <th>{t('atColChatQuota', lang)}</th>
                        <th>{t('atColAssignedUser', lang)}</th>
                        <th>{t('atColCreated', lang)}</th>
                        <th>{t('atColAction', lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tokens.length === 0 ? (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--at-t3)', padding: 16 }}>{t('atNoTokensYet', lang)}</td></tr>
                      ) : tokens.map(tok => (
                        <tr key={tok.id}>
                          <td className="at-td-mono" style={{ color: 'var(--at-cyan)', fontWeight: 600 }}>{tok.token}</td>
                          <td>
                            <span className={`at-tag ${tok.personal_onboard_used ? 'at-tag-rd' : 'at-tag-gn'}`}>
                              {tok.personal_onboard_used ? t('atUsed', lang) : t('atAvailable', lang)}
                            </span>
                          </td>
                          <td>
                            <span className={`at-tag ${tok.group_onboard_used ? 'at-tag-rd' : 'at-tag-gn'}`}>
                              {tok.group_onboard_used ? t('atUsed', lang) : t('atAvailable', lang)}
                            </span>
                          </td>
                          <td className="at-td-mono">
                            <span style={{ color: tok.chat_quota > 0 ? 'var(--at-amber)' : 'var(--at-red)' }}>
                              {t('atQuotaLeft', lang, { n: tok.chat_quota })}
                            </span>
                          </td>
                          <td className="at-td-mono">
                            {tok.assigned_user_id
                              ? (() => {
                                  const u = userById.get(tok.assigned_user_id);
                                  if (!u) return tok.assigned_user_id.slice(0, 8) + '...';
                                  return u.username ? `${u.display_name} (@${u.username})` : u.display_name;
                                })()
                              : <span style={{ color: 'var(--at-t3)' }}>{t('atUnclaimed', lang)}</span>}
                          </td>
                          <td className="at-td-mono">{fmtDate(tok.created_at)}</td>
                          <td>
                            <button 
                              className="at-btn at-btn-ghost" 
                              style={{ padding: '3px 8px', fontSize: 10, color: 'var(--at-red)' }} 
                              onClick={() => revokeToken(tok.id)}
                            >
                              {t('atRevoke', lang)}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className={`at-section ${section === 'users' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atUsersTitle', lang)}</div>
            <div className="at-section-meta">
              {t('atUsersMeta', lang)}
            </div>
            
            <div className="at-card" style={{ marginBottom: 16 }}>
              {loading.users ? <div className="at-loading">{t('atLoadingUsers', lang)}</div> : (
                <div className="at-tbl-wrap">
                  <table className="at-tbl">
                    <thead>
                      <tr>
                        <th>{t('atColUserDisplayName', lang)}</th>
                        <th>{t('atColRole', lang)}</th>
                        <th>{t('atColJoined', lang)}</th>
                        <th>{t('atColActions', lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usersList.length === 0 ? (
                        <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--at-t3)', padding: 16 }}>{t('atNoUsersFound', lang)}</td></tr>
                      ) : usersList.map(u => (
                        <tr key={u.id}>
                          <td style={{ fontWeight: 500, color: 'var(--at-t1)' }}>{u.display_name || u.id.slice(0, 8)}</td>
                          <td>
                            <span className={`at-tag ${u.role === 'owner' ? 'at-tag-pu' : u.role === 'admin' ? 'at-tag-am' : 'at-tag-gn'}`}>
                              {u.role || 'guest'}
                            </span>
                          </td>
                          <td className="at-td-mono">{u.created_at ? fmtDate(u.created_at) : t('atNA', lang)}</td>
                          <td>
                            {(profile.role === 'owner' || profile.role === 'admin') && (
                              <div style={{ position: 'relative', display: 'inline-block' }}>
                                <button 
                                  className="at-btn at-btn-ghost" 
                                  style={{ padding: '3px 8px', fontSize: 11 }} 
                                  onClick={() => setRoleDropdownOpen(roleDropdownOpen === u.id ? null : u.id)}
                                >
                                  {t('atChangeRole', lang)}
                                </button>
                                {roleDropdownOpen === u.id && (
                                  <>
                                    <div className="at-dropdown-overlay" onClick={() => setRoleDropdownOpen(null)} />
                                    <div className="at-role-dropdown">
                                      <div className="at-rd-header">{t('atSelectRole', lang)}</div>
                                      {u.role !== 'owner' && profile.role === 'owner' && (
                                        <div className="at-rd-item at-v-pu" onClick={() => { updateUserRole(u.id, 'owner'); setRoleDropdownOpen(null); }}>Owner</div>
                                      )}
                                      {u.role !== 'admin' && (
                                        <div className="at-rd-item at-v-am" onClick={() => { updateUserRole(u.id, 'admin'); setRoleDropdownOpen(null); }}>Admin</div>
                                      )}
                                      {u.role !== 'guest' && (profile.role === 'owner' || (profile.role === 'admin' && u.role !== 'owner')) && (
                                        <div className="at-rd-item at-v-gn" onClick={() => { updateUserRole(u.id, 'guest'); setRoleDropdownOpen(null); }}>Guest</div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className={`at-section ${section === 'proposals' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavProposals', lang)}</div>
            <div className="at-section-meta">{t('atGeneratedByTheOnes', lang)}</div>
            {loading.proposals && <div className="at-loading">{t('atLoadingProposals', lang)}</div>}
            {!loading.proposals && proposals.length === 0 && (
              <div className="at-card" style={{ marginBottom: 12 }}>
                <div className="at-empty">{t('atNoProposalsYet', lang)}</div>
                <div className="at-btn-group">
                  <button className="at-btn at-btn-primary" onClick={generateProposal} disabled={loading.generate}>
                    {loading.generate ? t('atGenerating', lang) : t('atGenerateQuarterly', lang)}
                  </button>
                </div>
              </div>
            )}
            {pendingProposal && (
              <div className="at-card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--at-mono)', color: 'var(--at-t1)' }}>{pendingProposal.quarter}</span>
                  <span className="at-tag at-tag-am">{t('atPendingReview', lang)}</span>
                  <span style={{ fontSize: 11, color: 'var(--at-t3)', marginLeft: 'auto' }}>{t('atGeneratedDate', lang, { date: fmtDate(pendingProposal.created_at) })}</span>
                </div>
                {pendingProposal.theones_summary && <div className="at-psum">{pendingProposal.theones_summary}</div>}
                <div className="at-g2" style={{ marginBottom: 12 }}>
                  {SECTION_KEYS.map(k => renderProposalSection(pendingProposal, k))}
                </div>
                <div className="at-btn-row">
                  <span style={{ fontSize: 11, color: 'var(--at-t3)' }}>{t('atAll4SectionsNote', lang)}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="at-btn at-btn-ghost" onClick={generateProposal} disabled={loading.generate}>{t('atRegenerate', lang)}</button>
                    <button className="at-btn at-btn-ghost" onClick={() => sendEmail(pendingProposal.id)}>{t('atSendPdfEmail', lang)}</button>
                    <button className="at-btn at-btn-primary" onClick={() => submitProposalReview(pendingProposal.id)}>{t('atSubmitReview', lang)}</button>
                  </div>
                </div>
              </div>
            )}
            {prevProposals.map(p => (
              <div key={p.id} className="at-prev-prop">
                <span className="at-prev-q">{p.quarter}</span>
                <span className={`at-tag ${p.status === 'approved' ? 'at-tag-gn' : p.status === 'partially_approved' ? 'at-tag-am' : 'at-tag-nt'}`}>{p.status}</span>
                <span className="at-prev-note">{p.theones_summary?.slice(0, 80)}...</span>
                <span className="at-prev-date">{fmtDate(p.created_at)}</span>
              </div>
            ))}
            {!loading.proposals && proposals.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="at-btn at-btn-ghost" onClick={generateProposal} disabled={loading.generate}>
                  {loading.generate ? t('atGenerating', lang) : t('atGenerateNewProposal', lang)}
                </button>
              </div>
            )}
          </div>

          <div className={`at-section ${section === 'flags' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavFlags', lang)}</div>
            <div className="at-section-meta">{t('at90dWindow', lang)}</div>
            <div className="at-summary-bar">
              <div className="at-sb-item"><div className="at-sb-label">{t('atTotal', lang)}</div><div className="at-sb-value at-v-wt">{flags.length}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atConfirmed', lang)}</div><div className="at-sb-value at-v-rd">{flagStats.confirmed}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atFalseAlarm', lang)}</div><div className="at-sb-value at-v-gn">{flagStats.falseAlarms}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atPending', lang)}</div><div className="at-sb-value at-v-am">{flagStats.pending}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item">
                <div className="at-sb-label">{t('atFalseAlarmRate', lang)}</div>
                <div className="at-sb-value at-v-wt" style={{ fontSize: 14 }}>
                  {flags.length > 0 ? Math.round((flagStats.falseAlarms / flags.length) * 100) : 0}%
                </div>
              </div>
            </div>
            <div className="at-filter-bar">
              {['all', 'crisis', 'adversarial', 'romantic_pressure', 'dependency', 'reality_distortion', 'high'].map(f => (
                <button key={f} className={`at-fb ${flagFilter === f ? 'active' : ''}`} onClick={() => setFlagFilter(f)}>
                  {f === 'all' ? t('atFilterAll', lang) : f === 'high' ? t('atFilterHighRisk', lang) : f.replace('_', ' ')}
                </button>
              ))}
            </div>
            {loading.flags ? <div className="at-loading">{t('atLoadingFlags', lang)}</div> : (
              <div className="at-card">
                <div className="at-tbl-wrap">
                  <table className="at-tbl">
                    <thead><tr><th>{t('atColTime', lang)}</th><th>{t('atColAgent', lang)}</th><th>{t('atColCategory', lang)}</th><th>{t('atColRisk', lang)}</th><th>{t('atColVerdict', lang)}</th></tr></thead>
                    <tbody>
                      {filteredFlags.length === 0 ? (
                        <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--at-t3)', padding: 16 }}>
                          {flags.length === 0 ? t('atNoFlagsYet', lang) : t('atNoFlagsFilter', lang)}
                        </td></tr>
                      ) : filteredFlags.map(f => (
                        <tr key={f.id}>
                          <td className="at-td-mono">{fmtTime(f.created_at)}</td>
                          <td style={{ color: f.agent === 'Aksel' ? 'var(--at-amber)' : 'var(--at-purple)', fontWeight: 500 }}>{f.agent}</td>
                          <td><span className={`at-tag ${f.category === 'crisis' ? 'at-tag-rd' : f.category === 'adversarial' ? 'at-tag-am' : f.category === 'romantic_pressure' ? 'at-tag-pu' : 'at-tag-cy'}`}>{f.category}</span></td>
                          <td><span className={`at-tag ${f.risk_tier === 'high' ? 'at-tag-rd' : 'at-tag-nt'}`}>{f.risk_tier}</span></td>
                          <td><span className={`at-tag ${!f.theones_verdict ? 'at-tag-am' : f.theones_verdict === 'confirmed' ? 'at-tag-rd' : 'at-tag-gn'}`}>{f.theones_verdict ?? 'pending'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className={`at-section ${section === 'govlog' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavGovLog', lang)}</div>
            <div className="at-section-meta">{t('atAuditMeta', lang)}</div>
            {loading.audit && <div className="at-loading">{t('atLoadingAudit', lang)}</div>}
            {!loading.audit && auditLog.length === 0 && (
              <div className="at-empty">{t('atNoAuditYet', lang)}</div>
            )}
            {!loading.audit && auditLog.length > 0 && (
              <div className="at-card">
                {auditLog.map(entry => (
                  <div key={entry.id} className="at-log-item">
                    <span className="at-log-time">{fmtTime(entry.created_at)}</span>
                    <span className={`at-log-type at-lt-${entry.event_type}`}>
                      {entry.event_type.charAt(0).toUpperCase() + entry.event_type.slice(1)}
                    </span>
                    <span className="at-log-msg">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`at-section ${section === 'memory' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavMemory', lang)}</div>
            <div className="at-section-meta">{t('atMemoryMeta', lang)}</div>
            {loading.memories && <div className="at-loading">{t('atLoadingMemories', lang)}</div>}
            {!loading.memories && memories.length === 0 && (
              <div className="at-empty">{t('atNoPendingMemories', lang)}</div>
            )}
            <div className="at-gap-12">
              {memories.map(m => (
                <div key={m.id} className="at-mem-card">
                  <div className="at-mem-header">
                    <span className="at-mem-layer">{t('atLayerCategory', lang, { n: m.layer, category: m.category })}</span>
                    <span className="at-mem-agent">{m.agent_target}</span>
                    <span className={`at-tag ${m.confidence >= 0.8 ? 'at-tag-gn' : m.confidence >= 0.65 ? 'at-tag-am' : 'at-tag-rd'}`} style={{ fontSize: 9 }}>
                      {t('atConfShort', lang, { n: m.confidence.toFixed(2) })}
                    </span>
                    <span className="at-mem-date">{fmtDate(m.created_at)}</span>
                  </div>
                  <div className="at-mem-text">{m.content}</div>
                  <div className="at-mem-footer">
                    <span className="at-mem-meta" style={{ color: m.confidence >= 0.8 ? 'var(--at-green)' : m.confidence >= 0.65 ? 'var(--at-amber)' : 'var(--at-red)' }}>
                      {m.confidence >= 0.8 ? t('atHighConfidence', lang) : m.confidence >= 0.65 ? t('atMediumConfidence', lang) : t('atLowConfidence', lang)}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="at-btn at-btn-danger"  onClick={() => approveMemory(m.id, 'rejected')}>{t('atReject', lang)}</button>
                      <button className="at-btn at-btn-success" onClick={() => approveMemory(m.id, 'approved')}>{t('atApprove', lang)}</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={`at-section ${section === 'agents' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavAgents', lang)}</div>
            <div className="at-section-meta">{t('atAgentConfigMeta', lang)}</div>
            {loading.agents && <div className="at-loading">{t('atLoadingAgentConfigs', lang)}</div>}
            <div className="at-g2">
              {(['Aksel', 'Vera'] as const).map(name => {
                const cfg     = agents.find(a => a.agent === name);
                const isAksel = name === 'Aksel';
                const modelKey = isAksel ? 'llama-3.3-70b-versatile' : 'claude-sonnet-4-6';
                const flagCount = isAksel ? agentStats.akselFlags : agentStats.veraFlags;
                const modelStat = usage?.byModel?.[modelKey];
                return (
                  <div key={name} className="at-agent-card">
                    <div className={`at-agent-name ${isAksel ? 'at-agent-ak' : 'at-agent-ve'}`}>{name}</div>
                    <div className="at-agent-model">{isAksel ? 'Groq — llama-3.3-70b-versatile' : 'Anthropic — claude-sonnet-4-6'}</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                      <span className={`at-tag ${isAksel ? 'at-tag-am' : 'at-tag-pu'}`}>{isAksel ? t('atDominantMale', lang) : t('atDominantFemale', lang)}</span>
                      <span className="at-tag at-tag-nt">{cfg?.domain || t('atNoDomainSet', lang)}</span>
                    </div>
                    <div className="at-agent-stats">
                      <div className="at-astat"><div className={`at-astat-v ${isAksel ? 'at-v-am' : 'at-v-pu'}`}>{modelStat?.calls ?? 0}</div><div className="at-astat-l">{t('atCallsMtd', lang)}</div></div>
                      <div className="at-astat"><div className="at-astat-v at-v-rd">{flagCount}</div><div className="at-astat-l">{t('atSafetyFlagsShort', lang)}</div></div>
                      <div className="at-astat"><div className="at-astat-v at-v-am">{modelStat ? fmtUsd(modelStat.costUsd) : '$0.00'}</div><div className="at-astat-l">{t('atCostMtd', lang)}</div></div>
                    </div>
                    {cfg?.persona_prompt && (
                      <div className="at-agent-persona">{cfg.persona_prompt.slice(0, 220)}{cfg.persona_prompt.length > 220 ? '...' : ''}</div>
                    )}
                    <div className="at-agent-footer">
                      <span className="at-agent-footer-note">{t('atLastUpdate', lang, { date: cfg ? fmtDate(cfg.updated_at) : t('atNA', lang) })}</span>
                      <button className="at-btn at-btn-ghost">{t('atViewFullPersona', lang)}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, gap: 6 }}>
              <button className="at-btn at-btn-primary">{t('atRerunOnboarding', lang)}</button>
            </div>
          </div>

          <div className={`at-section ${section === 'tickets' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavTickets', lang)}</div>
            <div className="at-section-meta">{t('atTicketsMeta', lang)}</div>
            <div className="at-summary-bar">
              <div className="at-sb-item"><div className="at-sb-label">{t('atTotal', lang)}</div><div className="at-sb-value at-v-wt">{tickets.length}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atColNew', lang)}</div><div className="at-sb-value at-v-am">{ticketCounts.new}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atColReviewed', lang)}</div><div className="at-sb-value at-v-cy">{ticketCounts.reviewed}</div></div>
              <div className="at-sb-sep" />
              <div className="at-sb-item"><div className="at-sb-label">{t('atColResolved', lang)}</div><div className="at-sb-value at-v-gn">{ticketCounts.resolved}</div></div>
            </div>
            <div className="at-filter-bar">
              {['all', 'new', 'reviewed', 'resolved', 'feedback', 'support'].map(f => (
                <button key={f} className={`at-fb ${ticketFilter === f ? 'active' : ''}`} onClick={() => setTicketFilter(f)}>
                  {f === 'all' ? t('atFilterAll', lang) : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            {loading.tickets ? <div className="at-loading">{t('atLoadingTickets', lang)}</div> : (
              filteredTickets.length === 0 ? (
                <div className="at-empty">
                  {tickets.length === 0
                    ? t('atNoTicketsYet', lang)
                    : t('atNoTicketsFilter', lang)}
                </div>
              ) : (
                <div className="at-gap-12">
                  {filteredTickets.map(tk => (
                    <div key={tk.id} className="at-mem-card">
                      <div className="at-mem-header">
                        <span className="at-mem-layer">{tk.ticket_no}</span>
                        <span className={`at-tag ${tk.type === 'support' ? 'at-tag-pu' : 'at-tag-cy'}`}>{tk.type}</span>
                        <span className={`at-tag ${tk.status === 'new' ? 'at-tag-am' : tk.status === 'reviewed' ? 'at-tag-cy' : 'at-tag-gn'}`}>{tk.status}</span>
                        <span className="at-mem-date">{fmtTime(tk.created_at)}</span>
                      </div>
                      <div className="at-mem-text" style={{ fontWeight: 600, color: 'var(--at-t1)' }}>{tk.subject}</div>

                      {expandedTicket === tk.id && (
                        <div className="at-ticket-transcript">
                          {Array.isArray(tk.transcript) && tk.transcript.length > 0 ? tk.transcript.map((m, i) => (
                            <div key={i} className="at-ticket-msg">
                              <span className="at-ticket-msg-sender">{m.sender}</span>
                              <span className="at-ticket-msg-content">{m.content}</span>
                            </div>
                          )) : (
                            <span className="at-mem-meta">{t('atNoTranscript', lang)}</span>
                          )}
                        </div>
                      )}

                      <div className="at-mem-footer">
                        <button className="at-btn at-btn-ghost" onClick={() => setExpandedTicket(expandedTicket === tk.id ? null : tk.id)}>
                          {expandedTicket === tk.id ? t('atHideConversation', lang) : t('atViewConversation', lang)}
                        </button>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {tk.status !== 'reviewed' && tk.status !== 'resolved' && (
                            <button className="at-btn at-btn-ghost" onClick={() => updateTicketStatus(tk.id, 'reviewed')}>{t('atMarkReviewed', lang)}</button>
                          )}
                          {tk.status !== 'resolved' && (
                            <button className="at-btn at-btn-success" onClick={() => updateTicketStatus(tk.id, 'resolved')}>{t('atResolve', lang)}</button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          <div className={`at-section ${section === 'agesignals' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavAgeSignals', lang)}</div>
            <div className="at-section-meta">
              {t('atAgeSignalsMeta', lang)}
            </div>
            <div className="at-filter-bar">
              {['all', 'monitoring', 'flagged', 'adult_confirmed', 'inconclusive'].map(f => (
                <button key={f} className={`at-fb ${ageFilter === f ? 'active' : ''}`} onClick={() => setAgeFilter(f)}>
                  {f === 'all' ? t('atFilterAll', lang) : f.charAt(0).toUpperCase() + f.slice(1).replace('_', ' ')}
                </button>
              ))}
            </div>
            {loading.agesignals ? <div className="at-loading">{t('atLoadingAgeSignals', lang)}</div> : (
              filteredAgeSignals.length === 0 ? (
                <div className="at-empty">
                  {ageSignals.length === 0
                    ? t('atNoAgeSignalsYet', lang)
                    : t('atNoAgeSignalsFilter', lang)}
                </div>
              ) : (
                <div className="at-gap-12">
                  {filteredAgeSignals.map(sig => (
                    <div key={sig.user_id} className="at-mem-card">
                      <div className="at-mem-header">
                        <span className="at-mem-layer">{sig.user_id.slice(0, 8)}…</span>
                        <span className={`at-tag ${sig.status === 'flagged' ? 'at-tag-am' : sig.status === 'adult_confirmed' ? 'at-tag-gn' : sig.status === 'inconclusive' ? 'at-tag-pu' : 'at-tag-cy'}`}>
                          {sig.status}
                        </span>
                        {sig.admin_verdict && (
                          <span className="at-tag at-tag-gn">{t('atReviewedVerdict', lang, { verdict: sig.admin_verdict.replace('_', ' ') })}</span>
                        )}
                        <span className="at-mem-date">{fmtTime(sig.updated_at)}</span>
                      </div>
                      <div className="at-mem-text">
                        {t('atConfidenceToward', lang, { n: sig.minor_confidence })}
                        &nbsp;·&nbsp; {t('atChecksUsed', lang, { n: sig.check_count })}
                        &nbsp;·&nbsp; {t('atLastCategory', lang, { cat: sig.last_category || '—' })}
                      </div>

                      {expandedAgeSig === sig.user_id && (
                        <div className="at-ticket-transcript">
                          {(sig.evidence_log || []).length > 0 ? sig.evidence_log.map((ev, i) => (
                            <div key={i} className="at-ticket-msg">
                              <span className="at-ticket-msg-sender">
                                {fmtTime(ev.at)} · {ev.category} · delta {ev.delta > 0 ? '+' : ''}{ev.delta} → {ev.confidence_after}
                              </span>
                              <span className="at-ticket-msg-content">{ev.reason}</span>
                            </div>
                          )) : (
                            <span className="at-mem-meta">{t('atNoEvidenceLog', lang)}</span>
                          )}
                        </div>
                      )}

                      <div className="at-mem-footer">
                        <button className="at-btn at-btn-ghost" onClick={() => setExpandedAgeSig(expandedAgeSig === sig.user_id ? null : sig.user_id)}>
                          {expandedAgeSig === sig.user_id ? t('atHideEvidence', lang) : t('atViewEvidence', lang)}
                        </button>
                        {!sig.admin_verdict && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="at-btn at-btn-success" onClick={() => updateAgeVerdict(sig.user_id, 'adult_confirmed')}>{t('atConfirmAdult', lang)}</button>
                            <button className="at-btn at-btn-danger" onClick={() => updateAgeVerdict(sig.user_id, 'resolved_minor')}>{t('atConfirmMinor', lang)}</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          <div className={`at-section ${section === 'news' ? 'active' : ''}`}>
            <div className="at-section-title">{t('atNavNews', lang)}</div>
            <div className="at-section-meta">
              {t('atNewsMeta', lang)}
              {loading.newsHealth && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--at-t3)' }}>{t('atPingingSources', lang)}</span>}
              {!loading.newsHealth && newsHealth.length > 0 && (
                <button className="at-btn at-btn-ghost" style={{ fontSize: 10, padding: '2px 8px', marginLeft: 10 }} onClick={fetchNewsHealth}>{t('atRePing', lang)}</button>
              )}
            </div>
            <div className="at-row">
              <div className="at-col-l">
                <div className="at-card">
                  <div className="at-card-title-row">
                    <span className="at-ctl">{t('atActiveSources', lang)}</span>
                    <span className="at-ctr">{t('atSourcesCount', lang, { n: newsSources.length })}</span>
                  </div>
                  <div className="at-filter-bar">
                    {[
                      { val: 'all', label: t('atFilterAll', lang) },
                      { val: 'id',  label: 'Bahasa Indonesia' },
                      { val: 'en',  label: 'English' },
                    ].map(({ val, label }) => (
                      <button key={val} className={`at-fb ${newsLang === val ? 'active' : ''}`} onClick={() => setNewsLang(val)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {loading.news ? <div className="at-loading">{t('atLoadingSources', lang)}</div> : (
                    <div className="at-news-list">
                      {newsSources.map(ns => {
                        const h = getNewsSourceHealth(ns.id);
                        const dotClass = h
                          ? h.status === 'api' ? 'at-nd-ok'
                          : pingDotClass(h.status)
                          : loading.newsHealth ? '' : 'at-nd-ok';
                        return (
                          <div key={ns.id} className="at-news-item">
                            <span className={`at-ns-dot ${dotClass}`} title={h ? (h.status === 'api' ? t('atApiSource', lang) : `${h.status}${h.latencyMs != null ? ` — ${h.latencyMs}ms` : ''}`) : t('atCheckingStatus', lang)} />
                            <span className="at-ns-id">{ns.id}</span>
                            <span className="at-ns-name">{ns.name}</span>
                            <div className="at-ns-right">
                              {h && h.status !== 'ok' && h.status !== 'api' && (
                                <span className="at-ns-err" style={{ fontSize: 9 }}>
                                  {h.status === 'slow' ? `${h.latencyMs}ms` : h.status}
                                </span>
                              )}
                              {h && h.status === 'ok' && h.latencyMs != null && (
                                <span className="at-ns-time">{h.latencyMs}ms</span>
                              )}
                              {ns.requires_key && <span style={{ fontSize: 9, color: 'var(--at-amber)' }}>key</span>}
                              <span className="at-ns-type">{ns.type}</span>
                              <span className={`at-ns-lang ${ns.language === 'id' ? 'at-nl-id' : 'at-nl-en'}`}>{ns.language.toUpperCase()}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="at-ns-footer">{t('atTheOnesCannotModify', lang)}</div>
                </div>
              </div>
              <div className="at-col-r">
                <div className="at-card">
                  <div className="at-card-title">{t('atSourceHealthSummary', lang)}</div>
                  <div className="at-gap-8">
                    {[
                      { label: t('atTotalSources', lang),     val: String(newsSources.length),                                             color: 'at-v-gn' },
                      { label: t('atOnlineOk', lang),        val: String(newsHealth.filter(h => h.status === 'ok').length),              color: 'at-v-gn' },
                      { label: t('atSlowThreshold', lang),       val: String(newsHealth.filter(h => h.status === 'slow').length),            color: 'at-v-am' },
                      { label: t('atErrorsTimeout', lang),  val: String(newsHealth.filter(h => h.status === 'error' || h.status === 'timeout').length), color: 'at-v-rd' },
                      { label: t('atApiSources', lang),        val: String(newsHealth.filter(h => h.status === 'api').length),             color: 'at-v-wt' },
                      { label: t('atIdSources', lang),         val: String(newsSources.filter(n => n.language === 'id').length),           color: 'at-v-wt' },
                      { label: t('atEnSources', lang),         val: String(newsSources.filter(n => n.language === 'en').length),           color: 'at-v-wt' },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                        <span style={{ color: 'var(--at-t3)' }}>{label}</span>
                        <span className={color} style={{ fontFamily: 'var(--at-mono)', fontWeight: 600 }}>{val}</span>
                      </div>
                    ))}
                  </div>
                  {newsHealth.some(h => h.status !== 'ok' && h.status !== 'api') && (
                    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 4, background: 'var(--at-amber-bg)', borderLeft: '2px solid var(--at-amber)', fontSize: 11, color: 'var(--at-amber)', lineHeight: 1.6 }}>
                      {newsHealth.filter(h => h.status !== 'ok' && h.status !== 'api').map(h => (
                        <div key={h.id}>{h.id}: {h.status}{h.latencyMs ? ` (${h.latencyMs}ms)` : ''}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}