import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, type UserProfile } from '../lib/supabase';
import { t, type Lang, type TranslationKey } from '../lib/i18n';
import './Widgets.css';

// ── Widget Registry ────────────────────────────────────
export interface WidgetMeta {
  id:          string;
  title:       string;
  description: string;
}

// Static English-default registry — unchanged shape/values so any existing
// caller reading `.title`/`.description` directly keeps working as-is.
export const WIDGET_REGISTRY: WidgetMeta[] = [
  { id: 'agents',   title: 'Agent Status',  description: 'Live agent availability'       },
  { id: 'stats',    title: 'Session Stats', description: 'Messages and mode tracking'    },
  { id: 'memory',   title: 'Memory',        description: 'Pending and approved memories' },
  { id: 'usage',    title: 'Usage Stats',   description: 'Conversation analytics'        },
  { id: 'timer',    title: 'Focus Timer',   description: 'Pomodoro work sessions'        },
  { id: 'notes',    title: 'Quick Notes',   description: 'Scratch pad, auto-saves'       },
  { id: 'tasks',    title: 'Task List',     description: 'Daily to-dos'                  },
  { id: 'currency', title: 'USD / IDR',     description: 'Live exchange rate'            },
  { id: 'calendar', title: 'Calendar',      description: 'Personal event planner'        },
];

export const DEFAULT_WIDGET_IDS = ['agents', 'stats'];

// Locale-aware lookup for the widget manager popover (MainShell/
// MainShellMobile) to adopt when it's wired up — additive, doesn't change
// WIDGET_REGISTRY itself.
const WIDGET_I18N_KEYS: Record<string, { titleKey: TranslationKey; descKey: TranslationKey }> = {
  agents:   { titleKey: 'widAgentsTitle',   descKey: 'widAgentsDesc' },
  stats:    { titleKey: 'widStatsTitle',    descKey: 'widStatsDesc' },
  memory:   { titleKey: 'widMemoryTitle',   descKey: 'widMemoryDesc' },
  usage:    { titleKey: 'widUsageTitle',    descKey: 'widUsageDesc' },
  timer:    { titleKey: 'widTimerTitle',    descKey: 'widTimerDesc' },
  notes:    { titleKey: 'widNotesTitle',    descKey: 'widNotesDesc' },
  tasks:    { titleKey: 'widTasksTitle',    descKey: 'widTasksDesc' },
  currency: { titleKey: 'widCurrencyTitle', descKey: 'widCurrencyDesc' },
  calendar: { titleKey: 'widCalendarTitle', descKey: 'widCalendarDesc' },
};

export function getWidgetMeta(lang: Lang): WidgetMeta[] {
  return WIDGET_REGISTRY.map(w => {
    const keys = WIDGET_I18N_KEYS[w.id];
    return keys
      ? { ...w, title: t(keys.titleKey, lang), description: t(keys.descKey, lang) }
      : w;
  });
}

// ── Shared props ───────────────────────────────────────
export interface WidgetSharedProps {
  loading?:      boolean;
  profile?:      UserProfile;
  msgCount?:     number;
  chatMode?:     string;
  onOpenMemory?: () => void;
}

const langOf = (profile?: UserProfile): Lang => profile?.language === 'id' ? 'id' : 'en';

// ─────────────────────────────────────────────────────
// AGENT STATUS
// ─────────────────────────────────────────────────────
export function AgentStatusWidget(props: WidgetSharedProps) {
  const loading = props.loading;
  const lang = langOf(props.profile);
  const statusLabel = loading ? t('widThinking', lang) : t('widOnline', lang);
  return (
    <div className="wgt-root">
      <div className="wgt-row">
        <span className="wgt-agent-name aksel">Aksel</span>
        <span className={'wgt-agent-status' + (loading ? ' thinking' : '')}>
          {statusLabel}
        </span>
      </div>
      <div className="wgt-row">
        <span className="wgt-agent-name vera">Vera</span>
        <span className={'wgt-agent-status' + (loading ? ' thinking' : '')}>
          {statusLabel}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// SESSION STATS
// ─────────────────────────────────────────────────────
export function SessionStatsWidget(props: WidgetSharedProps) {
  const msgCount = props.msgCount;
  const chatMode = props.chatMode;
  const profile  = props.profile;
  const lang = langOf(profile);
  return (
    <div className="wgt-root">
      <div className="wgt-row">
        <span className="wgt-label">{t('widMessagesToday', lang)}</span>
        <span className="wgt-value">{msgCount ?? 0}</span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('widAgentLead', lang)}</span>
        <span className="wgt-value wgt-value-sm">
          {profile?.gender === 'male' ? 'Aksel' : 'Vera'}
        </span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('widMode', lang)}</span>
        <span className="wgt-value wgt-value-sm wgt-upper">{chatMode ?? 'quick'}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// MEMORY SUMMARY
// ─────────────────────────────────────────────────────
export function MemorySummaryWidget(props: WidgetSharedProps) {
  const onOpenMemory = props.onOpenMemory;
  const lang = langOf(props.profile);
  const [pending,  setPending]  = useState(0);
  const [approved, setApproved] = useState(0);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const pr = await apiFetch('/api/memories/pending');
        const ar = await apiFetch('/api/memories/approved');
        const pd = await pr.json();
        const ad = await ar.json();
        if (pd.status === 'success') setPending(pd.memories.length);
        if (ad.status === 'success') setApproved(ad.memories.length);
      } catch (err) {
        // swallow
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="wgt-loading">
        <span/><span/><span/>
      </div>
    );
  }

  return (
    <div className="wgt-root">
      <div className="wgt-row">
        <span className="wgt-label">{t('widPendingReview', lang)}</span>
        <span className={'wgt-value' + (pending > 0 ? ' wgt-amber' : '')}>{pending}</span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('memApproved', lang)}</span>
        <span className="wgt-value wgt-green">{approved}</span>
      </div>
      {pending > 0 ? (
        <button className="wgt-btn-accent" onClick={onOpenMemory}>
          {t('widReviewPendingBtn', lang, { n: pending })}
        </button>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────
// USAGE STATS
// ─────────────────────────────────────────────────────
interface UsageStatsData {
  messages: {
    total:    number;
    today:    number;
    aksel:    number;
    vera:     number;
    dominant: string;
  };
  files:        number;
  dossiers:     number;
  member_since: string | null;
}

interface LangOnlyProps {
  lang?: Lang;
}

export function UsageStatsWidget({ lang }: LangOnlyProps = {}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';
  const [data,    setData]    = useState<UsageStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiFetch('/api/user/stats');
        const d   = await res.json();
        if (d.status === 'success') setData(d.data);
      } catch (err) {
        // swallow
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="wgt-loading">
        <span/><span/><span/>
      </div>
    );
  }

  if (!data) {
    return <div className="wgt-empty">{t('widNoDataYet', activeLang)}</div>;
  }

  const total    = (data.messages.aksel + data.messages.vera) || 1;
  const akselPct = Math.round((data.messages.aksel / total) * 100);
  const veraPct  = 100 - akselPct;

  const memberSince = data.member_since
    ? new Date(data.member_since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '—';

  return (
    <div className="wgt-root">
      <div className="wgt-row">
        <span className="wgt-label">{t('widTotalMessages', activeLang)}</span>
        <span className="wgt-value">{data.messages.total}</span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('widToday', activeLang)}</span>
        <span className="wgt-value">{data.messages.today}</span>
      </div>
      <div className="wgt-agent-bar-wrap">
        <div className="wgt-agent-bar">
          <div className="wgt-agent-bar-aksel" style={{ width: akselPct + '%' }}/>
          <div className="wgt-agent-bar-vera"  style={{ width: veraPct + '%' }}/>
        </div>
        <div className="wgt-agent-bar-labels">
          <span className="wgt-amber">Aksel {akselPct}%</span>
          <span className="wgt-vera">Vera {veraPct}%</span>
        </div>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('widFiles', activeLang)}</span>
        <span className="wgt-value wgt-value-sm">{data.files}</span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('dosTitle', activeLang)}</span>
        <span className="wgt-value wgt-value-sm">{data.dossiers}</span>
      </div>
      <div className="wgt-row">
        <span className="wgt-label">{t('widMemberSince', activeLang)}</span>
        <span className="wgt-value wgt-value-sm">{memberSince}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// FOCUS TIMER
// ─────────────────────────────────────────────────────
const WORK_SECS  = 25 * 60;
const BREAK_SECS = 5  * 60;

export function FocusTimerWidget({ onFocus, onBreak, onDone, lang }: {
  onFocus?: () => void;
  onBreak?: () => void;
  onDone?:  () => void;
  lang?:    Lang;
}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';
  const [mode,    setMode]    = useState<'work' | 'break'>('work');
  const [secs,    setSecs]    = useState(WORK_SECS);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDoneRef   = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  const reset = useCallback(() => {
    setRunning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecs(mode === 'work' ? WORK_SECS : BREAK_SECS);
    onDoneRef.current?.();
  }, [mode]);

  const switchMode = (m: 'work' | 'break') => {
    setRunning(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
    setMode(m);
    setSecs(m === 'work' ? WORK_SECS : BREAK_SECS);
    onDoneRef.current?.();
  };

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSecs(function (s) {
          if (s <= 1) {
            setRunning(false);
            if (intervalRef.current) clearInterval(intervalRef.current);
            onDoneRef.current?.();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return function cleanup() {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const mm  = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss  = String(secs % 60).padStart(2, '0');
  const pct = mode === 'work'
    ? ((WORK_SECS  - secs) / WORK_SECS)  * 100
    : ((BREAK_SECS - secs) / BREAK_SECS) * 100;

  const startLabel = running
    ? t('widPause', activeLang)
    : (secs === 0 ? t('widDone', activeLang) : t('widStart', activeLang));

  const handleStartPause = () => {
    const next = !running;
    setRunning(next);
    if (next && mode === 'work')  onFocus?.();
    if (next && mode === 'break') onBreak?.();
    if (!next) onDone?.();
  };

  return (
    <div className="wgt-root">
      <div className="wgt-timer-mode-row">
        <button
          className={'wgt-timer-mode-btn' + (mode === 'work' ? ' active' : '')}
          onClick={() => switchMode('work')}
        >
          {t('widWork', activeLang)}
        </button>
        <button
          className={'wgt-timer-mode-btn' + (mode === 'break' ? ' active' : '')}
          onClick={() => switchMode('break')}
        >
          {t('widBreak', activeLang)}
        </button>
      </div>
      <div className="wgt-timer-display">
        <div className="wgt-timer-progress" style={{ width: pct + '%' }}/>
        <span className="wgt-timer-time">{mm}:{ss}</span>
      </div>
      <div className="wgt-timer-actions">
        <button className="wgt-btn-primary" onClick={handleStartPause}>
          {startLabel}
        </button>
        <button className="wgt-btn-ghost" onClick={reset}>{t('widReset', activeLang)}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────
// QUICK NOTES
// ─────────────────────────────────────────────────────
export function QuickNotesWidget({ lang }: LangOnlyProps = {}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';
  const [content, setContent] = useState('');
  const [saved,   setSaved]   = useState(true);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await apiFetch('/api/notes');
        const d   = await res.json();
        if (d.status === 'success') setContent(d.note.content || '');
      } catch (err) {
        // swallow
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleChange = (val: string) => {
    setContent(val);
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await apiFetch('/api/notes', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ content: val }),
        });
        setSaved(true);
      } catch (err) {
        // swallow
      }
    }, 1000);
  };

  if (loading) {
    return (
      <div className="wgt-loading">
        <span/><span/><span/>
      </div>
    );
  }

  return (
    <div className="wgt-root wgt-root-notes">
      <div className="wgt-notes-bar">
        <span className="wgt-label">{t('widNotesLabel', activeLang)}</span>
        <span className={'wgt-save-indicator ' + (saved ? 'saved' : 'unsaved')}>
          {saved ? t('widSaved', activeLang) : t('widSaving', activeLang)}
        </span>
      </div>
      <textarea
        className="wgt-notes-area"
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={t('widTypeAnything', activeLang)}
        spellCheck={false}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────
// TASK LIST
// ─────────────────────────────────────────────────────
interface Task {
  id:        string;
  content:   string;
  completed: boolean;
}

export function TaskListWidget({ lang }: LangOnlyProps = {}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';
  const [tasks,   setTasks]   = useState<Task[]>([]);
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tasks');
      const d   = await res.json();
      if (d.status === 'success') setTasks(d.tasks);
    } catch (err) {
      // swallow
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addTask = async () => {
    if (!input.trim()) return;
    try {
      const res = await apiFetch('/api/tasks', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content: input.trim() }),
      });
      const d = await res.json();
      if (d.status === 'success') {
        setTasks(function (prev) { return prev.concat([d.task]); });
        setInput('');
      }
    } catch (err) {
      // swallow
    }
  };

  const toggleTask = async (task: Task) => {
    try {
      const res = await apiFetch('/api/tasks/' + task.id, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ completed: !task.completed }),
      });
      const d = await res.json();
      if (d.status === 'success') {
        setTasks(function (prev) {
          return prev.map(function (t) { return t.id === task.id ? d.task : t; });
        });
      }
    } catch (err) {
      // swallow
    }
  };

  const deleteTask = async (id: string) => {
    try {
      await apiFetch('/api/tasks/' + id, { method: 'DELETE' });
      setTasks(function (prev) { return prev.filter(function (t) { return t.id !== id; }); });
    } catch (err) {
      // swallow
    }
  };

  const clearCompleted = async () => {
    try {
      await apiFetch('/api/tasks/completed/all', { method: 'DELETE' });
      setTasks(function (prev) { return prev.filter(function (t) { return !t.completed; }); });
    } catch (err) {
      // swallow
    }
  };

  const completedCount = tasks.filter(function (t) { return t.completed; }).length;

  if (loading) {
    return (
      <div className="wgt-loading">
        <span/><span/><span/>
      </div>
    );
  }

  return (
    <div className="wgt-root wgt-root-tasks">
      <div className="wgt-task-input-row">
        <input
          className="wgt-task-input"
          placeholder={t('widAddTaskPlaceholder', activeLang)}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
        />
        <button className="wgt-task-add-btn" onClick={addTask}>+</button>
      </div>

      {tasks.length === 0 ? (
        <div className="wgt-empty">{t('widNoTasksYet', activeLang)}</div>
      ) : (
        <div className="wgt-task-list">
          {tasks.map(function (task) {
            return (
              <div key={task.id} className={'wgt-task-row' + (task.completed ? ' done' : '')}>
                <button className="wgt-task-check" onClick={() => toggleTask(task)}>
                  {task.completed ? '✓' : ''}
                </button>
                <span className="wgt-task-content">{task.content}</span>
                <button className="wgt-task-del" onClick={() => deleteTask(task.id)}>×</button>
              </div>
            );
          })}
        </div>
      )}

      {completedCount > 0 ? (
        <button className="wgt-btn-ghost wgt-task-clear" onClick={clearCompleted}>
          {t('widClearCompleted', activeLang, { n: completedCount })}
        </button>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────
// CURRENCY USD/IDR
// ─────────────────────────────────────────────────────
export function CurrencyWidget({ lang }: LangOnlyProps = {}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';
  const [rate,      setRate]      = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [stale,     setStale]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/currency/usd-idr');
      const d   = await res.json();
      if (d.status === 'success') {
        setRate(d.rate);
        setUpdatedAt(d.updated_at);
        setStale(!!d.stale);
      }
    } catch (err) {
      // swallow
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const formatRate = (r: number) => new Intl.NumberFormat('id-ID').format(r);

  const updatedLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : null;

  if (loading) {
    return (
      <div className="wgt-loading">
        <span/><span/><span/>
      </div>
    );
  }

  return (
    <div className="wgt-root">
      <div className="wgt-currency-main">
        <span className="wgt-currency-label">1 USD</span>
        <span className="wgt-currency-equals">=</span>
        <span className="wgt-currency-rate">
          {rate ? 'Rp ' + formatRate(rate) : '—'}
        </span>
      </div>
      <div className="wgt-row" style={{ marginTop: '8px' }}>
        <span className="wgt-label">{stale ? t('widLastCached', activeLang) : t('widUpdatedLabel', activeLang)}</span>
        <span className="wgt-value wgt-value-sm">{updatedLabel ?? '—'}</span>
      </div>
      <button className="wgt-btn-ghost" onClick={load} style={{ marginTop: '8px' }}>
        ↻ {t('atRefresh', activeLang)}
      </button>
    </div>
  );
}
