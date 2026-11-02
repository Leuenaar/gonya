import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, type UserProfile } from '../lib/supabase';
import { t, type Lang } from '../lib/i18n';

interface CalendarEvent {
  id:    string;
  title: string;
  date:  string;
  time?: string;
  color: string;
  note?: string;
}

interface GlobalEvent {
  id:       string;
  title:    string;
  date:     string;
  summary:  string;
  category: string;
  tags:     string[];
}

interface MonthCache {
  events:       CalendarEvent[];
  globalEvents: GlobalEvent[];
}

interface Props {
  profile?: UserProfile;
}

const COLOR_MAP: Record<string, string> = {
  cyan:  'var(--cyan)',
  amber: 'var(--amber)',
  vera:  'var(--vera)',
  red:   'var(--red)',
  green: 'var(--green)',
};

const CATEGORY_COLOR_MAP: Record<string, string> = {
  business:      'var(--amber)',
  technology:    'var(--cyan)',
  science:       'var(--green)',
  health:        'var(--green)',
  politics:      'var(--red)',
  world:         'var(--vera)',
  marketing:     'var(--amber)',
  finance:       'var(--amber)',
  education:     'var(--cyan)',
  environment:   'var(--green)',
  culture:       'var(--vera)',
  entertainment: 'var(--vera)',
  other:         'var(--text-muted)',
};

// Position-indexed lookup tables (0-11 / 0-6) — kept local rather than moved
// into i18n.ts, same reasoning as the legal SECTIONS arrays in
// PrivacyPolicy/TermsOfService: t() is a scalar key/value lookup, not an
// array index, so migrating these would add awkward key-per-index entries
// for no real benefit.
const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAY_LABELS_EN  = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_LABELS_ID  = ['M', 'S', 'S', 'R', 'K', 'J', 'S'];

export function CalendarWidget(props: Props) {
  const lang: Lang = props.profile?.language === 'id' ? 'id' : 'en';
  const MONTH_NAMES = lang === 'id' ? MONTH_NAMES_ID : MONTH_NAMES_EN;
  const DAY_LABELS  = lang === 'id' ? DAY_LABELS_ID : DAY_LABELS_EN;

  const now = new Date();
  const [year,         setYear]         = useState(now.getFullYear());
  const [month,        setMonth]        = useState(now.getMonth());
  const [events,       setEvents]       = useState<CalendarEvent[]>([]);
  const [globalEvents, setGlobalEvents] = useState<GlobalEvent[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [selected,     setSelected]     = useState<string | null>(null);
  const [showForm,     setShowForm]     = useState(false);
  const [formTitle,    setFormTitle]    = useState('');
  const [formTime,     setFormTime]     = useState('');
  const [formColor,    setFormColor]    = useState('cyan');
  const [saving,       setSaving]       = useState(false);
  const [globalPopup,  setGlobalPopup]  = useState<GlobalEvent | null>(null);

  // Per-instance month cache so switching back to an already-loaded month is instant
  const cacheRef = useRef<Record<string, MonthCache>>({});

  const monthKey = year + '-' + String(month + 1).padStart(2, '0');

  const load = useCallback(async (key: string) => {
    const cached = cacheRef.current[key];
    if (cached) {
      // Instant display from cache, no loading flicker
      setEvents(cached.events);
      setGlobalEvents(cached.globalEvents);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const personalReq = apiFetch('/api/calendar/events?month=' + key);
      const globalReq    = apiFetch('/api/calendar/global-events?month=' + key);

      const [personalRes, globalRes] = await Promise.all([personalReq, globalReq]);
      const [personalData, globalData] = await Promise.all([
        personalRes.json(),
        globalRes.json(),
      ]);

      const nextEvents       = personalData.status === 'success' ? personalData.events : [];
      const nextGlobalEvents = globalData.status === 'success' ? globalData.events : [];

      cacheRef.current[key] = { events: nextEvents, globalEvents: nextGlobalEvents };

      setEvents(nextEvents);
      setGlobalEvents(nextGlobalEvents);
    } catch (err) {
      // swallow
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(monthKey); }, [monthKey, load]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGlobalPopup(null);
        setShowForm(false);
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, []);

  const invalidateAndReload = useCallback(() => {
    delete cacheRef.current[monthKey];
    load(monthKey);
  }, [monthKey, load]);

  const daysInMonth    = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const todayStr        = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

  const eventsOnDay = (day: number) => {
    const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    return events.filter(function (e) { return e.date === dateStr; });
  };

  const globalEventsOnDay = (day: number) => {
    const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    return globalEvents.filter(function (e) { return e.date === dateStr; });
  };

  const handleDayClick = (day: number) => {
    const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    setSelected(dateStr);
    setShowForm(true);
    setFormTitle('');
    setFormTime('');
    setFormColor('cyan');
  };

  const handleGlobalEventClick = (e: React.MouseEvent, ev: GlobalEvent) => {
    e.stopPropagation();
    setGlobalPopup(ev);
  };

  const handleSearchNews = (title: string) => {
    const query = encodeURIComponent(title);
    window.open('https://www.google.com/search?q=' + query, '_blank', 'noopener,noreferrer');
  };

  const handleSave = async () => {
    if (!formTitle.trim() || !selected) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/calendar/events', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          title: formTitle.trim(),
          date:  selected,
          time:  formTime || null,
          color: formColor,
        }),
      });
      const d = await res.json();
      if (d.status === 'success') {
        setEvents(function (prev) {
          const next = prev.concat([d.event]);
          next.sort(function (a, b) { return a.date.localeCompare(b.date); });
          return next;
        });
        invalidateAndReload();
        setShowForm(false);
      }
    } catch (err) {
      // swallow
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch('/api/calendar/events/' + id, { method: 'DELETE' });
      setEvents(function (prev) { return prev.filter(function (e) { return e.id !== id; }); });
      invalidateAndReload();
    } catch (err) {
      // swallow
    }
  };

  const prevMonth = () => {
    if (month === 0) {
      setMonth(11);
      setYear(function (y) { return y - 1; });
    } else {
      setMonth(function (m) { return m - 1; });
    }
  };

  const nextMonth = () => {
    if (month === 11) {
      setMonth(0);
      setYear(function (y) { return y + 1; });
    } else {
      setMonth(function (m) { return m + 1; });
    }
  };

  const dayCells = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    dayCells.push(
      <div key={'empty-' + i} className="wgt-cal-cell wgt-cal-cell-empty"/>
    );
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr     = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const dayEvents   = eventsOnDay(day);
    const dayGlobals  = globalEventsOnDay(day);
    const isToday     = dateStr === todayStr;

    let cellClass = 'wgt-cal-cell';
    if (dayEvents.length > 0) cellClass += ' has-event';
    if (dayGlobals.length > 0) cellClass += ' has-global';

    const dots = [];
    const dotsToShow = dayEvents.slice(0, 2);
    for (let i = 0; i < dotsToShow.length; i++) {
      dots.push(
        <div
          key={'dot-' + i}
          className="wgt-cal-dot"
          style={{ background: COLOR_MAP[dotsToShow[i].color] || 'var(--cyan)' }}
        />
      );
    }

    const globalBlock = dayGlobals.length > 0 ? (
      <div
        className="wgt-cal-global-block"
        style={{ background: CATEGORY_COLOR_MAP[dayGlobals[0].category] || 'var(--text-muted)' }}
        onClick={(e) => handleGlobalEventClick(e, dayGlobals[0])}
        title={dayGlobals[0].title}
      />
    ) : null;

    dayCells.push(
      <div key={day} className={cellClass} onClick={() => handleDayClick(day)}>
        {globalBlock}
        <span className={'wgt-cal-day-num' + (isToday ? ' wgt-cal-day-today' : '')}>{day}</span>
        <div className="wgt-cal-dots-row">{dots}</div>
      </div>
    );
  }

  const selectedDayEvents = selected
    ? events.filter(function (e) { return e.date === selected; })
    : [];

  return (
    <div className="wgt-root">
      <div className="wgt-cal-nav">
        <button className="wgt-btn-ghost wgt-cal-nav-btn" onClick={prevMonth}>‹</button>
        <span className="wgt-cal-month">{MONTH_NAMES[month]} {year}</span>
        <button className="wgt-btn-ghost wgt-cal-nav-btn" onClick={nextMonth}>›</button>
      </div>

      <div className="wgt-cal-grid">
        {DAY_LABELS.map(function (d, i) {
          return <div key={'label-' + i} className="wgt-cal-day-label">{d}</div>;
        })}
        {dayCells}
      </div>

      {showForm && selected ? (
        <div className="wgt-cal-form">
          <div className="wgt-cal-form-date">{selected}</div>
          <input
            className="wgt-task-input"
            placeholder={t('wcalEventTitlePlaceholder', lang)}
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            autoFocus
          />
          <input
            className="wgt-task-input"
            placeholder={t('wcalTimePlaceholder', lang)}
            value={formTime}
            onChange={(e) => setFormTime(e.target.value)}
            style={{ marginTop: '5px' }}
          />
          <div className="wgt-cal-colors">
            {Object.keys(COLOR_MAP).map(function (key) {
              const val = COLOR_MAP[key];
              const dotClass = 'wgt-cal-color-dot' + (formColor === key ? ' selected' : '');
              return (
                <div
                  key={key}
                  className={dotClass}
                  style={{ background: val }}
                  onClick={() => setFormColor(key)}
                />
              );
            })}
          </div>
          <div className="wgt-timer-actions" style={{ marginTop: '6px' }}>
            <button className="wgt-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '···' : t('wcalSave', lang)}
            </button>
            <button className="wgt-btn-ghost" onClick={() => setShowForm(false)}>
              {t('wcalCancel', lang)}
            </button>
          </div>
        </div>
      ) : null}

      {selected && !showForm && selectedDayEvents.length > 0 ? (
        <div className="wgt-cal-event-list">
          {selectedDayEvents.map(function (ev) {
            return (
              <div key={ev.id} className="wgt-cal-event-row">
                <div className="wgt-cal-event-bar" style={{ background: COLOR_MAP[ev.color] || 'var(--cyan)' }}/>
                <div className="wgt-cal-event-body">
                  <span className="wgt-cal-event-title">{ev.title}</span>
                  {ev.time ? <span className="wgt-cal-event-time">{ev.time}</span> : null}
                </div>
                <button className="wgt-task-del" onClick={() => handleDelete(ev.id)}>×</button>
              </div>
            );
          })}
        </div>
      ) : null}

      {globalPopup ? (
        <div className="wgt-cal-global-popup-backdrop" onClick={() => setGlobalPopup(null)}>
          <div className="wgt-cal-global-popup" onClick={(e) => e.stopPropagation()}>
            <div className="wgt-cal-global-popup-header">
              <span
                className="wgt-cal-global-popup-cat"
                style={{ color: CATEGORY_COLOR_MAP[globalPopup.category] || 'var(--text-muted)' }}
              >
                {globalPopup.category}
              </span>
              <button className="wgt-task-del" onClick={() => setGlobalPopup(null)}>×</button>
            </div>
            <div className="wgt-cal-global-popup-title">{globalPopup.title}</div>
            <div className="wgt-cal-global-popup-date">{globalPopup.date}</div>
            <div className="wgt-cal-global-popup-summary">{globalPopup.summary}</div>
            <button
              className="wgt-btn-primary"
              style={{ marginTop: '10px' }}
              onClick={() => handleSearchNews(globalPopup.title)}
            >
              {t('wcalSearchNews', lang)}
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="wgt-loading">
          <span/><span/><span/>
        </div>
      ) : null}
    </div>
  );
}
