import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch, signOut, supabase, type UserProfile } from '../lib/supabase';
import Vault from './Vault';
import AdminTerminal from './AdminTerminal';
import Dossier from './Dossier';
import Settings from './Settings';
import ContactSupport from './ContactSupport';
import CreateGroupModal from './CreateGroupModal';
import GroupOnboarding from './GroupOnboarding';
import GroupChat from './GroupChat';
import GroupPicker from './GroupPicker';
import Memory from './Memory';
import VoiceCall from './VoiceCall';
import VoiceSessionModal from './VoiceSessionModal';
import SourcesModal, { type SourceItem } from './SourcesModal';
import GonyaMascot, { type GonyaState } from '../components/GonyaMascot';
import IdleOverlay from '../components/IdleOverlay';
import {
  WIDGET_REGISTRY, DEFAULT_WIDGET_IDS, getWidgetMeta,
  AgentStatusWidget, SessionStatsWidget, MemorySummaryWidget,
  UsageStatsWidget, FocusTimerWidget, QuickNotesWidget,
  TaskListWidget, CurrencyWidget,
} from './Widgets';
import { CalendarWidget } from './WidgetCalendar';
import { t } from '../lib/i18n';
import './MainShell.css';

interface Props {
  profile:      UserProfile;
  isAnonymous:  boolean;
  onSignOut:    () => void;
  pendingGroup?: { id: string; name: string; myRole: string } | null;
}

interface Message {
  id:               string;
  sender:           'User' | 'Aksel' | 'Vera' | 'System';
  content:          string;
  created_at:       string;
  typing?:          boolean;
  voice_transcript?: { speaker: string; text: string }[] | null;
  sources?:         { index: number; title: string; snippet: string; url: string }[] | null;
}

interface NewsItem {
  source:   string;
  tag:      string;
  title:    string;
  excerpt?: string;
  url:      string;
  time:     string;
  category: string;
}

interface SafetyChannel {
  type:      string;
  label_id?: string;
  label_en?: string;
  value:     string;
  note?:     string;
}

interface SafetyResource {
  id:              string;
  name:            string;
  description_id?: string;
  description_en?: string;
  channels:        SafetyChannel[];
  note?:           string;
}

interface SafetyData {
  country_name:          string;
  emergency?:            SafetyResource;
  resources?:            SafetyResource[];
  professional_support?: SafetyResource[];
}

interface Attachment {
  name:        string;
  content:     string;
  fileId?:     string;
  type?:       string;
  previewUrl?: string;
  noTextExtracted?: boolean;
}

type MobileTab = 'intel' | 'chat' | 'radar' | 'ledger';
type ViewMode  = 'chat' | 'vault' | 'control' | 'admin' | 'dossier' | 'settings';

const ALL_CATEGORIES = [
  'Business', 'Technology', 'Science', 'Health',
  'Politics', 'World', 'Marketing', 'Finance',
  'Education', 'Environment', 'Culture', 'Entertainment',
];

const CHANNEL_ICONS: Record<string, string> = {
  call: '📞', whatsapp: '💬', web: '🔗', app: '📱',
};

const DOSSIER_INTRO_KEY  = 'gonya_dossier_intro_dismissed';
const WIDGET_STORAGE_KEY = 'gonya_widget_config';
const LEGACY_WIDGET_STORAGE_KEY = 'triangle_widget_config'; // pre-rebrand key, migrated below

const DISTRESS_KEYWORDS = [
  'sedih', 'nangis', 'capek', 'lelah', 'hopeless', 'menyerah',
  'give up', 'gak kuat', 'gak sanggup', 'stressed', 'anxious',
  'takut', 'sendiri', 'kesepian', 'lonely', 'down', 'depresi',
  'worthless', 'gak berguna', 'mati', 'hilang', 'hancur',
];

const getChannelHref = (ch: SafetyChannel): string => {
  if (ch.type === 'call')     return `tel:${ch.value.replace(/\s/g, '')}`;
  if (ch.type === 'whatsapp') return `https://wa.me/${ch.value.replace(/\D/g, '')}`;
  return ch.value;
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export default function MainShell({ profile, isAnonymous, onSignOut, pendingGroup }: Props) {
  const [messages,      setMessages]      = useState<Message[]>([]);
  // Synchronous double-send guard (24 Aug 2026) — `loading` state alone
  // can't reliably prevent a near-simultaneous second handleSend() call
  // within the same event tick, since React state updates are batched/
  // async, not immediate. A ref updates synchronously, closing that race
  // regardless of what exactly triggers the double invocation (a
  // bouncing key event, a duplicate listener, etc.) — this was producing
  // the duplicate "temp_" user bubble the user reported (visually fixed
  // by a refresh, since the server itself only ever had ONE real row).
  const sendingRef = useRef(false);
  const [input,         setInput]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [mobileTab,     setMobileTab]     = useState<MobileTab>('chat');
  const [msgCount,      setMsgCount]      = useState(0);
  const [chatMode,      setChatMode]      = useState<'quick' | 'deep'>('quick');
  const [popoverOpen,   setPopoverOpen]   = useState(false);
  const [attachment,    setAttachment]    = useState<Attachment | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [isDragging,    setIsDragging]    = useState(false);
  const [pastedContent, setPastedContent] = useState<{ preview: string; full: string } | null>(null);
  const [clock,         setClock]         = useState('');
  const [localProfile,  setLocalProfile]  = useState<UserProfile>(profile);
  // Derived from localProfile (not the profile PROP) — localProfile is the
  // live-updating copy Settings.tsx writes to via onUpdate, so this stays
  // correct immediately after a language change, not just on next mount.
  const lang = localProfile.language;

  const [view,    setView]    = useState<ViewMode>('chat');
  const [supportOpen, setSupportOpen] = useState(false);
  const [createGroupOpen,   setCreateGroupOpen]   = useState(false);
  const [groupOnboarding,   setGroupOnboarding]   = useState<{ id: string; name: string } | null>(null);
  const [activeGroup,       setActiveGroup]       = useState<{ id: string; name: string; myRole: string } | null>(pendingGroup ?? null);
  const [groupPickerOpen,   setGroupPickerOpen]   = useState(false);
  const [myGroups,          setMyGroups]          = useState<Array<{ id: string; name: string; onboarding_done: boolean; my_role: string }>>([]);
  const [navOpen, setNavOpen] = useState(false);

  const [macroNews,    setMacroNews]    = useState<NewsItem[]>([]);
  const [radarNews,    setRadarNews]    = useState<NewsItem[]>([]);
  const [macroLoading, setMacroLoading] = useState(false);
  const [radarLoading, setRadarLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState('All');

  const [editCatOpen, setEditCatOpen] = useState(false);
  const [editCats,    setEditCats]    = useState<string[]>(profile.radar_categories || []);
  const [savingCats,  setSavingCats]  = useState(false);

  const [showSourceForm, setShowSourceForm] = useState(false);
  const [sourceName,     setSourceName]     = useState('');
  const [sourceUrl,      setSourceUrl]      = useState('');
  const [savingSource,   setSavingSource]   = useState(false);

  // Widget manager
  const [activeWidgetIds, setActiveWidgetIds] = useState<string[]>(() => {
    const validIds = WIDGET_REGISTRY.map(w => w.id);
    try {
      let saved = localStorage.getItem(WIDGET_STORAGE_KEY);
      if (!saved) {
        // One-time migration: this file used to write under the
        // pre-rebrand key, so pick up anything stranded there.
        const legacy = localStorage.getItem(LEGACY_WIDGET_STORAGE_KEY);
        if (legacy) {
          saved = legacy;
          try {
            localStorage.setItem(WIDGET_STORAGE_KEY, legacy);
            localStorage.removeItem(LEGACY_WIDGET_STORAGE_KEY);
          } catch {}
        }
      }
      const parsed  = saved ? JSON.parse(saved) : DEFAULT_WIDGET_IDS;
      const filtered = parsed.filter((id: string) => validIds.includes(id));
      return filtered.length > 0 ? filtered : DEFAULT_WIDGET_IDS;
    } catch { return DEFAULT_WIDGET_IDS; }
  });
  const [widgetIdx,     setWidgetIdx]     = useState(0);
  const [widgetMgrOpen, setWidgetMgrOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText,  setEditText]  = useState('');

  const [safetyCardVisible, setSafetyCardVisible] = useState(false);
  const [safetyData,        setSafetyData]        = useState<SafetyData | null>(null);

  const [showDossierIntro,      setShowDossierIntro]      = useState(false);
  const [dossierIntroDismissed, setDossierIntroDismissed] = useState(false);

  // Memory drawer
  const [memDrawerOpen,   setMemDrawerOpen]   = useState(false);
  const [memPendingCount, setMemPendingCount] = useState(0);

  // Voice call overlay
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);
  const [viewingVoiceMsg, setViewingVoiceMsg] = useState<Message | null>(null);
  const [viewingSources, setViewingSources] = useState<SourceItem[] | null>(null);

  // Gonya mascot
  const [gonyaState,       setGonyaState]       = useState<GonyaState>('idle');
  const [gonyaFloatHidden, setGonyaFloatHidden] = useState(false);
  const [gonyaWarping,     setGonyaWarping]      = useState(false);
  const gonyaTimerRef                  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setGonyaTemporary = useCallback((state: GonyaState, durationMs: number) => {
    if (gonyaTimerRef.current) clearTimeout(gonyaTimerRef.current);
    setGonyaState(state);
    gonyaTimerRef.current = setTimeout(() => setGonyaState('idle'), durationMs);
  }, []);

  // ── Gonya reacts to the Focus Timer widget ────────────
  // Work session running: focused (determined squint, holds until the
  // session stops). Break running: walking (legs out, casual). Either
  // way stopping — paused or finished, FocusTimerWidget's onDone fires
  // for both — settles back to idle.
  const handleTimerFocus = useCallback(() => {
    if (gonyaTimerRef.current) clearTimeout(gonyaTimerRef.current);
    setGonyaState('focused');
  }, []);
  const handleTimerBreak = useCallback(() => {
    if (gonyaTimerRef.current) clearTimeout(gonyaTimerRef.current);
    setGonyaState('walking');
  }, []);
  const handleTimerDone = useCallback(() => {
    setGonyaState(prev => (prev === 'focused' || prev === 'walking') ? 'idle' : prev);
  }, []);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setGonyaState(prev => {
      if (prev === 'sleeping') {
        if (gonyaTimerRef.current) clearTimeout(gonyaTimerRef.current);
        gonyaTimerRef.current = setTimeout(() => setGonyaState('idle'), 2000);
        return 'happy';
      }
      return prev;
    });
    idleTimerRef.current = setTimeout(() => setGonyaState('sleeping'), 3 * 60 * 1000);
  }, []);

  const chatRef    = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const editCatRef = useRef<HTMLDivElement>(null);
  const navRef     = useRef<HTMLDivElement>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const dragCount  = useRef(0);

  // ── Gonya idle timer ──────────────────────────────────
  useEffect(() => {
    resetIdleTimer();
    const events  = ['mousemove', 'keydown', 'touchstart', 'click'];
    const handler = () => resetIdleTimer();
    events.forEach(e => document.addEventListener(e, handler));
    return () => {
      events.forEach(e => document.removeEventListener(e, handler));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (gonyaTimerRef.current) clearTimeout(gonyaTimerRef.current);
    };
  }, [resetIdleTimer]);

  // ── Gonya reacts to safety trigger ───────────────────
  useEffect(() => {
    if (safetyCardVisible) {
      setGonyaState('sad');
    } else if (gonyaState === 'sad') {
      setGonyaTemporary('worried', 8000);
    }
  }, [safetyCardVisible]);

  // ── Gonya reacts to distress keywords in input ───────
  useEffect(() => {
    if (!input.trim()) {
      if (gonyaState === 'worried') setGonyaState('idle');
      return;
    }
    const lower      = input.toLowerCase();
    const hasDistress = DISTRESS_KEYWORDS.some(kw => lower.includes(kw));
    if (hasDistress && gonyaState === 'idle') {
      setGonyaState('worried');
    } else if (!hasDistress && gonyaState === 'worried') {
      setGonyaState('idle');
    }
  }, [input]);

  // ── Gonya reacts to agent response ───────────────────
  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if ((last.sender === 'Aksel' || last.sender === 'Vera') && !last.typing) {
      if (gonyaState !== 'sad' && gonyaState !== 'worried') {
        setGonyaTemporary('happy', 3000);
      }
    }
  }, [messages]);

  // ── Clock ─────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      setClock(
        n.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()
        + ' AT '
        + n.toLocaleTimeString('en-US', { hour12: true }).toUpperCase()
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Load chat history ──────────────────────────────────
  useEffect(() => {
    if (view !== 'chat') return;
    const load = async () => {
      try {
        const res  = await apiFetch('/api/chat/history?limit=50');
        const data = await res.json();
        if (data.status === 'success') {
          setMessages(data.data);
          setMsgCount(data.data.filter((m: Message) => m.sender === 'User').length);
        }
      } catch {}
    };
    load();
  }, [view]);

  // ── Realtime: catch messages that arrive OUTSIDE the synchronous
  // chat/send + chat/edit flow (Phase 8.8). The normal reply from Aksel/
  // Vera already comes back in the same HTTP response above and needs no
  // help — this listener exists specifically for things that are
  // inserted asynchronously afterward, currently: the "here's your
  // file" follow-up message from the file-generation pipeline
  // (backend/chat/handler.js), which used to only ever appear after a
  // manual refresh because `messages` had zero broadcast trigger. Same
  // Broadcast-from-Database pattern already proven for Group Chat —
  // dedup by id so anything the synchronous flow already added is
  // simply ignored here, never duplicated.
  useEffect(() => {
    if (view !== 'chat') return;

    let cancelled       = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount      = 0;
    let currentChannel: ReturnType<typeof supabase.channel> | null = null;

    const connect = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) supabase.realtime.setAuth(session.access_token);

      const channel = supabase
        .channel(`personal:${profile.id}`, { config: { private: true } })
        .on('broadcast', { event: 'INSERT' }, (message: any) => {
          const rec = message?.payload?.record;
          if (!rec?.id) return;
          setMessages(prev => {
            if (prev.some(m => m.id === rec.id)) return prev; // already added synchronously (e.g. Aksel/Vera's reply)
            // This channel is private to this user, so any 'User'-sender
            // broadcast here IS this user's own just-sent message echoing
            // back. The broadcast can arrive BEFORE the /api/chat/send HTTP
            // response comes back (Aksel/Vera's reply generation takes
            // seconds; the DB insert + broadcast is near-instant), which
            // used to beat the response's own tempId->real-id swap and
            // show a duplicate bubble until refresh. Fix: replace the
            // matching still-optimistic (temp_-prefixed) entry here
            // instead of appending a second copy.
            // Fixed (24 Aug 2026): matching by exact content equality broke
            // whenever the send included pastedContent or an attachment —
            // the optimistic bubble shows the shortened `displayText`
            // ("...[Pasted content included]"), but the server echoes back
            // the FULL raw `content` actually sent, so the two never equal
            // each other and this fallback silently missed, appending a
            // second bubble instead of replacing the first (the exact
            // "needs a refresh to become 1" symptom reported). Matching the
            // OLDEST still-optimistic temp_ entry by id-prefix alone is
            // robust regardless of content — sends are one-at-a-time in
            // this UI (input+button disabled while `loading`), so there's
            // normally at most one outstanding temp_ entry; on the rare
            // case of more than one, FIFO (oldest first) resolves them in
            // the same order they were actually sent.
            if (rec.sender === 'User') {
              const optimisticIdx = prev.findIndex(m => typeof m.id === 'string' && m.id.startsWith('temp_'));
              if (optimisticIdx !== -1) {
                const next = [...prev];
                next[optimisticIdx] = { id: rec.id, sender: rec.sender, content: rec.content, created_at: rec.created_at, sources: rec.sources, voice_transcript: rec.voice_transcript };
                return next;
              }
            }
            return [...prev, { id: rec.id, sender: rec.sender, content: rec.content, created_at: rec.created_at, sources: rec.sources, voice_transcript: rec.voice_transcript }];
          });
        })
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') { retryCount = 0; return; }
          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !cancelled) {
            const delay = Math.min(1000 * 2 ** retryCount, 15000);
            retryCount++;
            retryTimer = setTimeout(() => {
              supabase.removeChannel(channel);
              connect();
            }, delay);
          }
        });

      currentChannel = channel;
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (currentChannel) supabase.removeChannel(currentChannel);
    };
  }, [view, profile.id]);

  // ── Dossier intro ──────────────────────────────────────
  useEffect(() => {
    const dismissed = localStorage.getItem(DOSSIER_INTRO_KEY) === 'true';
    setDossierIntroDismissed(dismissed);
  }, []);

  useEffect(() => {
    if (view === 'dossier' && !dossierIntroDismissed) setShowDossierIntro(true);
  }, [view, dossierIntroDismissed]);

  // ── Esc ───────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (memDrawerOpen)  { setMemDrawerOpen(false);  return; }
        if (widgetMgrOpen)  { setWidgetMgrOpen(false);  return; }
        if (view !== 'chat' && view !== 'admin') switchView('chat');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [view, memDrawerOpen, widgetMgrOpen]);

  // ── Load news ──────────────────────────────────────────
  const loadMacroNews = useCallback(async (cats?: string[]) => {
    setMacroLoading(true);
    try {
      const categories = cats || localProfile.radar_categories || [];
      const query      = categories.length > 0 ? `?categories=${categories.join(',')}` : '';
      const res        = await apiFetch(`/api/news/macro${query}`);
      const data       = await res.json();
      if (data.status === 'success') setMacroNews(data.data);
    } catch {} finally { setMacroLoading(false); }
  }, [localProfile.radar_categories]);

  const loadRadarNews = useCallback(async () => {
    setRadarLoading(true);
    try {
      const res  = await apiFetch('/api/news/radar');
      const data = await res.json();
      if (data.status === 'success') setRadarNews(data.data);
    } catch {} finally { setRadarLoading(false); }
  }, []);

  useEffect(() => { loadMacroNews(); loadRadarNews(); }, []);

  // Re-fetch Macro Intel whenever language or radar_categories change —
  // covers Settings saves, not just the inline category editor (which
  // already explicitly calls loadMacroNews(editCats) on its own).
  const didMountNewsRef = useRef(false);
  useEffect(() => {
    if (!didMountNewsRef.current) { didMountNewsRef.current = true; return; }
    loadMacroNews();
  }, [localProfile.language, loadMacroNews]);

  // ── Auto-scroll ────────────────────────────────────────
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, safetyCardVisible]);

  // ── Auto-grow textarea ─────────────────────────────────
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // ── Close popovers on outside click ───────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPopoverOpen(false);
      if (editCatRef.current && !editCatRef.current.contains(e.target as Node)) setEditCatOpen(false);
      if (navRef.current && !navRef.current.contains(e.target as Node)) setNavOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Cleanup blob URLs ──────────────────────────────────
  useEffect(() => {
    return () => {
      if (attachment?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment]);

  // ── Safety helper ──────────────────────────────────────
  const triggerSafetyHelper = async () => {
    try {
      const res  = await apiFetch('/api/safety/resources?country=ID');
      const data = await res.json();
      if (data.status === 'success') { setSafetyData(data.data); setSafetyCardVisible(true); }
    } catch { setSafetyCardVisible(true); }
  };

  // ── Dossier intro ──────────────────────────────────────
  const dismissDossierIntro = (permanent: boolean) => {
    setShowDossierIntro(false);
    if (permanent) {
      localStorage.setItem(DOSSIER_INTRO_KEY, 'true');
      setDossierIntroDismissed(true);
    }
  };

  // ── Widget helpers ─────────────────────────────────────
  const saveWidgetConfig = (ids: string[]) => {
    setActiveWidgetIds(ids);
    setWidgetIdx(0);
    try { localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(ids)); } catch {}
  };

  const toggleWidget = (id: string) => {
    const next = activeWidgetIds.includes(id)
      ? activeWidgetIds.filter(w => w !== id)
      : [...activeWidgetIds, id];
    saveWidgetConfig(next.length > 0 ? next : [id]);
  };

  const renderWidget = (id: string) => {
    switch (id) {
      case 'agents':   return <AgentStatusWidget   loading={loading} profile={localProfile} />;
      case 'stats':    return <SessionStatsWidget  msgCount={msgCount} chatMode={chatMode} profile={localProfile} />;
      case 'memory':   return <MemorySummaryWidget onOpenMemory={() => setMemDrawerOpen(true)} profile={localProfile} />;
      case 'usage':    return <UsageStatsWidget lang={lang} />;
      case 'timer':    return (
        <FocusTimerWidget
          onFocus={handleTimerFocus}
          onBreak={handleTimerBreak}
          onDone={handleTimerDone}
          lang={lang}
        />
      );
      case 'notes':    return <QuickNotesWidget lang={lang} />;
      case 'tasks':    return <TaskListWidget lang={lang} />;
      case 'currency': return <CurrencyWidget lang={lang} />;
      case 'calendar': return <CalendarWidget profile={localProfile} />;
      default:         return null;
    }
  };

  const userCategories = ['All', ...(localProfile.radar_categories || [])];
  const filteredMacro  = activeFilter === 'All'
    ? macroNews
    : macroNews.filter(i => i.category?.toLowerCase() === activeFilter.toLowerCase());

  // ── Save categories ────────────────────────────────────
  const handleSaveCategories = async () => {
    setSavingCats(true);
    try {
      await apiFetch('/api/news/categories', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ categories: editCats }),
      });
      setLocalProfile(prev => ({ ...prev, radar_categories: editCats }));
      setEditCatOpen(false);
      loadMacroNews(editCats);
    } catch {} finally { setSavingCats(false); }
  };

  const toggleCat = (cat: string) =>
    setEditCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);

  // ── Add source ─────────────────────────────────────────
  const handleAddSource = async () => {
    if (!sourceName.trim() || !sourceUrl.trim()) return;
    setSavingSource(true);
    try {
      const res  = await apiFetch('/api/news/sources', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: sourceName.trim(), url: sourceUrl.trim(), category: 'Custom' }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setSourceName(''); setSourceUrl(''); setShowSourceForm(false); loadRadarNews();
      }
    } catch {} finally { setSavingSource(false); }
  };

  // ── File upload ────────────────────────────────────────
  const processFileUpload = useCallback(async (file: File) => {
    const isImage  = file.type.startsWith('image/');
    const localUrl = isImage ? URL.createObjectURL(file) : undefined;
    if (localUrl) setAttachment({ name: file.name, content: '', type: file.type, previewUrl: localUrl });
    setUploadingFile(true);
    try {
      const base64 = await fileToBase64(file);
      const res    = await apiFetch('/api/files/upload', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          file_name:       file.name,
          file_type:       file.type || 'application/octet-stream',
          file_base64:     base64,
          conversation_id: 'main',
        }),
      });
      const data = await res.json();
      if (localUrl) URL.revokeObjectURL(localUrl);
      if (data.status === 'success') {
        setAttachment({
          name:       file.name,
          content:    data.data.url || `[File stored: ${file.name}]`,
          fileId:     data.data.id,
          type:       file.type,
          previewUrl: isImage ? data.data.url : undefined,
          noTextExtracted: data.data.noTextExtracted || false,
        });
      } else { setAttachment(null); }
    } catch {
      if (localUrl) URL.revokeObjectURL(localUrl);
      setAttachment(null);
    } finally { setUploadingFile(false); }
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await processFileUpload(file);
  };

  // ── Drag and drop ──────────────────────────────────────
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); dragCount.current += 1;
    if (dragCount.current === 1) setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); dragCount.current -= 1;
    if (dragCount.current === 0) setIsDragging(false);
  };
  const handleDragOver  = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const handleDrop      = async (e: React.DragEvent) => {
    e.preventDefault(); dragCount.current = 0; setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) await processFileUpload(file);
  };

  // ── Slash commands ─────────────────────────────────────
  const handleSlashCommand = async (cmd: string): Promise<boolean> => {
    const lower = cmd.trim().toLowerCase();
    if (lower !== '/mode bahasa' && lower !== '/english mode') return false;
    const newLang = lower === '/english mode' ? 'en' : 'id';
    const label   = newLang === 'en' ? 'English Mode activated.' : 'Mode Bahasa Indonesia diaktifkan.';
    try {
      await apiFetch('/api/user/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ language: newLang }),
      });
      setLocalProfile(prev => ({ ...prev, language: newLang }));
    } catch {}
    setMessages(prev => [...prev, { id: `sys_${Date.now()}`, sender: 'System', content: label, created_at: new Date().toISOString() }]);
    return true;
  };

  // ── Send message ───────────────────────────────────────
  const handleSend = async () => {
    if ((!input.trim() && !attachment && !pastedContent) || loading || uploadingFile) return;
    if (sendingRef.current) return; // synchronous guard — see the ref's own comment above for why `loading` state alone isn't enough
    sendingRef.current = true;
    setViewingSources(null); // continuing the conversation dismisses any open sources panel

    let content = input.trim(), displayText = input.trim();
    if (pastedContent) {
      content     += `\n\n${pastedContent.full}`;
      displayText += displayText ? `\n\n[Pasted content included]` : `[Pasted content included]`;
    }
    if (attachment) {
      content     += `\n\n[Attached: ${attachment.name}]\n${attachment.content}`;
      displayText += `\n\n📎 ${attachment.name}`;
    }
    if (!attachment && !pastedContent && content.startsWith('/')) {
      const handled = await handleSlashCommand(content);
      if (handled) { setInput(''); return; }
    }

    setInput(''); setAttachment(null); setPastedContent(null); setLoading(true);

    const tempId   = `temp_${Date.now()}`;
    const typingId = `typing_${Date.now()}`;
    setMessages(prev => [...prev,
      { id: tempId, sender: 'User', content: displayText, created_at: new Date().toISOString() },
    ]);
    setMsgCount(prev => prev + 1);
    setMessages(prev => [...prev, { id: typingId, sender: 'System', content: '', created_at: '', typing: true }]);

    try {
      const res  = await apiFetch('/api/chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ message: content, mode: chatMode }),
      });
      const data = await res.json();
      if (data.status === 'success' && data.userMessage && data.responses) {
        setMessages(prev => {
          const withoutTyping = prev.filter(m => m.id !== typingId);
          const withUserSwap  = withoutTyping.map(m => m.id === tempId ? { ...m, id: data.userMessage.id, created_at: data.userMessage.created_at } : m);
          // Fix (24 Aug 2026): guards against the SAME realtime-vs-HTTP
          // race already fixed for the user's own optimistic bubble
          // above, but for AGENT responses instead — if the realtime
          // broadcast for Aksel/Vera's reply arrived and got appended
          // BEFORE this HTTP response was processed, concat-ing it again
          // here produced two array entries sharing the identical id
          // (React's own "duplicate key" warning), which renders as
          // undefined behavior — an EMPTY-looking bubble being exactly
          // that, confirmed by the user's own screenshot.
          const existingIds = new Set(withUserSwap.map(m => m.id));
          const newResponses = data.responses
            .filter((r: { id: string }) => !existingIds.has(r.id))
            .map((r: { agent: string; content: string; id: string; created_at: string; sources?: SourceItem[] | null }) => ({
              id: r.id, sender: r.agent as 'Aksel' | 'Vera', content: r.content, created_at: r.created_at, sources: r.sources,
            }));
          return withUserSwap.concat(newResponses);
        });
        if (data.safetySupport) await triggerSafetyHelper();
      } else {
        setMessages(prev => prev.filter(m => m.id !== typingId));
      }
    } catch {
      setMessages(prev => prev.filter(m => m.id !== typingId));
      setMessages(prev => [...prev, { id: `err_${Date.now()}`, sender: 'System', content: t('msErrChatConnection', lang), created_at: new Date().toISOString() }]);
    } finally {
      setLoading(false);
      sendingRef.current = false;
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Threshold matches ChatGPT's current across-the-board setting (10,000
  // chars — researched 24 Aug 2026, after user feedback that the old
  // 80-char threshold was converting even a 1-2 sentence paste into a
  // heavy "PASTED" attachment card, which felt way too aggressive for
  // routine short pastes. Preview snippet length also raised (160 -> 300)
  // to match — a snippet sized for an 80-char threshold looked stingy
  // once pastes can genuinely run into the thousands of characters.
  const PASTE_ATTACHMENT_THRESHOLD = 10000;

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.length > PASTE_ATTACHMENT_THRESHOLD) { e.preventDefault(); setPastedContent({ preview: text.slice(0, 300), full: text }); }
  };

  const insertMention = (tag: string) => { setInput(prev => prev ? `${prev} ${tag} ` : `${tag} `); setPopoverOpen(false); inputRef.current?.focus(); };
  const selectMode    = (mode: 'quick' | 'deep') => { setChatMode(mode); setPopoverOpen(false); inputRef.current?.focus(); };
  const handleSignOut = async () => { await signOut(); onSignOut(); };
  const switchView    = (v: ViewMode) => { setView(v); setNavOpen(false); if (v === 'chat') setMobileTab('chat'); };

  // ── Edit message ───────────────────────────────────────
  const startEdit  = (msg: Message) => { if (loading) return; setEditingId(msg.id); setEditText(msg.content); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); };

  const handleEditSave = async (msg: Message) => {
    const edited = editText.trim();
    if (!edited || loading) return;
    const editedId = msg.id;
    setLoading(true); setEditingId(null); setEditText('');
    setMessages(prev => { const idx = prev.findIndex(m => m.id === editedId); return idx === -1 ? prev : prev.slice(0, idx); });
    const typingId = `typing_${Date.now()}`;
    setMessages(prev => [...prev, { id: typingId, sender: 'System', content: '', created_at: '', typing: true }]);
    try {
      const res  = await apiFetch('/api/chat/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ messageId: editedId, content: edited, mode: chatMode }),
      });
      const data = await res.json();
      if (data.status === 'success' && data.userMessage && data.responses) {
        // Fix (24 Aug 2026): same guard as handleSend() above — this edit
        // flow inserts data.userMessage and data.responses using their
        // REAL ids directly (no optimistic temp_ entry to swap here), so
        // BOTH are equally exposed to the realtime-vs-HTTP race if a
        // broadcast for either already landed first.
        setMessages(prev => {
          const withoutTyping = prev.filter(m => m.id !== typingId);
          const existingIds   = new Set(withoutTyping.map(m => m.id));
          const additions: Message[] = [];
          if (!existingIds.has(data.userMessage.id)) {
            additions.push({ id: data.userMessage.id, sender: 'User', content: data.userMessage.content, created_at: data.userMessage.created_at });
          }
          data.responses
            .filter((r: { id: string }) => !existingIds.has(r.id))
            .forEach((r: { agent: string; content: string; id: string; created_at: string; sources?: SourceItem[] | null }) => {
              additions.push({ id: r.id, sender: r.agent as 'Aksel' | 'Vera', content: r.content, created_at: r.created_at, sources: r.sources });
            });
          return withoutTyping.concat(additions);
        });
        if (data.safetySupport) await triggerSafetyHelper();
      } else { setMessages(prev => prev.filter(m => m.id !== typingId)); }
    } catch {
      setMessages(prev => prev.filter(m => m.id !== typingId));
      setMessages(prev => [...prev, { id: `err_${Date.now()}`, sender: 'System', content: t('msErrEditConnection', lang), created_at: new Date().toISOString() }]);
    } finally { setLoading(false); }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, msg: Message) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(msg); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };

  // ── Safety card ────────────────────────────────────────
  const renderSafetyCard = () => {
    if (!safetyCardVisible) return null;
    const lang = localProfile.language || 'id';
    return (
      <div className="ms-safety-card">
        <div className="ms-safety-card-header">
          <span className="ms-safety-card-icon">🤝</span>
          <span className="ms-safety-card-title">{lang === 'en' ? 'Real support is available right now.' : 'Ada bantuan nyata yang bisa dihubungi sekarang.'}</span>
          <button className="ms-safety-card-dismiss" onClick={() => setSafetyCardVisible(false)}>×</button>
        </div>
        {safetyData ? (
          <div className="ms-safety-card-body">
            {safetyData.emergency && (
              <div className="ms-safety-section">
                <p className="ms-safety-section-label">{safetyData.emergency.name}</p>
                {safetyData.emergency.channels.map((ch, i) => (
                  <a key={i} href={getChannelHref(ch)} className="ms-safety-btn ms-safety-btn-emergency"
                    target={ch.type === 'call' ? '_self' : '_blank'} rel="noopener noreferrer">
                    {CHANNEL_ICONS[ch.type] || '🔗'} {ch.value}{ch.note ? ` ${ch.note}` : ''}
                  </a>
                ))}
              </div>
            )}
            {(safetyData.resources || []).map((r, i) => (
              <div key={i} className="ms-safety-section">
                <p className="ms-safety-section-label">{r.name}</p>
                <p className="ms-safety-section-desc">{lang === 'en' ? r.description_en : r.description_id}</p>
                {r.channels.map((ch, j) => (
                  <a key={j} href={getChannelHref(ch)} className="ms-safety-btn"
                    target={ch.type === 'call' ? '_self' : '_blank'} rel="noopener noreferrer">
                    {CHANNEL_ICONS[ch.type] || '🔗'} {lang === 'en' ? (ch.label_en || ch.value) : (ch.label_id || ch.value)}{ch.note ? ` — ${ch.note}` : ''}
                  </a>
                ))}
              </div>
            ))}
            {(safetyData.professional_support || []).map((r, i) => (
              <div key={i} className="ms-safety-section ms-safety-section-secondary">
                <p className="ms-safety-section-label">{r.name}</p>
                {r.note && <p className="ms-safety-section-note">{r.note}</p>}
                {r.channels.map((ch, j) => (
                  <a key={j} href={getChannelHref(ch)} className="ms-safety-btn ms-safety-btn-secondary" target="_blank" rel="noopener noreferrer">
                    {CHANNEL_ICONS[ch.type] || '🔗'} {lang === 'en' ? (ch.label_en || ch.value) : (ch.label_id || ch.value)}
                  </a>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="ms-safety-card-body">
            <p className="ms-safety-section-desc">{lang === 'en' ? 'If you are in crisis, please reach out to someone you trust or a professional.' : 'Kalau kamu lagi dalam kondisi sulit, hubungi seseorang yang kamu percaya atau profesional.'}</p>
          </div>
        )}
      </div>
    );
  };

  // ── Dossier intro ──────────────────────────────────────
  const renderDossierIntro = () => {
    if (!showDossierIntro) return null;
    return (
      <div className="ms-dossier-intro-overlay">
        <div className="ms-dossier-intro-card">
          <div className="ms-dossier-intro-icon">⬡</div>
          <div className="ms-dossier-intro-title">{t('msDossierHelpTitle', lang)}</div>
          <div className="ms-dossier-intro-body">
            <p>{t('msDossierDesc1', lang)}</p>
            <p>{t('msDossierDesc2', lang)}</p>
            <p>{t('msDossierDesc3', lang)}</p>
          </div>
          <div className="ms-dossier-intro-features">
            <div className="ms-dossier-intro-feature"><span className="ms-dossier-intro-feature-icon">💬</span><span>{t('msDossierFeature1', lang)}</span></div>
            <div className="ms-dossier-intro-feature"><span className="ms-dossier-intro-feature-icon">📎</span><span>{t('msDossierFeature2', lang)}</span></div>
            <div className="ms-dossier-intro-feature"><span className="ms-dossier-intro-feature-icon">🧠</span><span>{t('msDossierFeature3', lang)}</span></div>
          </div>
          <div className="ms-dossier-intro-actions">
            <button className="ms-dossier-intro-dismiss-perm" onClick={() => dismissDossierIntro(true)}>{t('msDossierDismissPerm', lang)}</button>
            <button className="ms-dossier-intro-ok" onClick={() => dismissDossierIntro(false)}>{t('msGotIt', lang)}</button>
          </div>
        </div>
      </div>
    );
  };

  if (view === 'admin') return <AdminTerminal profile={localProfile} onBack={() => switchView('chat')} />;

  const handleGroupChatNavClick = async () => {
    setNavOpen(false);
    try {
      // Must check invites BEFORE deciding where to route — this logic
      // predates invites living inside GroupPicker, and only ever looked
      // at existing group count. A brand-new user with a pending invite
      // but zero groups yet (groups.length === 0) used to skip straight
      // to "Create a Group Chat" and never see GroupPicker at all, which
      // is the only place a pending invite is shown.
      const [groupsRes, invitesRes] = await Promise.all([
        apiFetch('/api/groups'),
        apiFetch('/api/invites/mine'),
      ]);
      const groupsData  = await groupsRes.json();
      const invitesData = await invitesRes.json();
      const groups  = groupsData.status  === 'success' ? groupsData.groups   : [];
      const invites = invitesData.status === 'success' ? invitesData.invites : [];
      setMyGroups(groups);

      if (invites.length > 0) {
        setGroupPickerOpen(true);
      } else if (groups.length === 0) {
        setCreateGroupOpen(true);
      } else if (groups.length === 1) {
        const g = groups[0];
        if (g.onboarding_done) setActiveGroup({ id: g.id, name: g.name, myRole: g.my_role });
        else                   setGroupOnboarding({ id: g.id, name: g.name });
      } else {
        setGroupPickerOpen(true);
      }
    } catch {
      // Fail open to the create flow rather than leaving the user stuck
      setCreateGroupOpen(true);
    }
  };

  if (groupOnboarding) return (
    <GroupOnboarding
      groupId={groupOnboarding.id}
      groupName={groupOnboarding.name}
      lang={lang}
      isAnonymous={isAnonymous}
      onComplete={() => {
        setActiveGroup({ id: groupOnboarding.id, name: groupOnboarding.name, myRole: 'owner' });
        setGroupOnboarding(null);
      }}
    />
  );

  if (activeGroup) return (
    <GroupChat
      groupId={activeGroup.id}
      groupName={activeGroup.name}
      myRole={activeGroup.myRole}
      profile={localProfile}
      onBack={() => setActiveGroup(null)}
    />
  );

  // ── Render messages ────────────────────────────────────
  // Splits agent reply text on "[N]" markers and turns each one that
  // matches a real source into a small clickable chip — plain text
  // elsewhere untouched. A "[N]" with no matching source (shouldn't
  // happen — the model's own directive tells it never to invent one, but
  // model output is still model output) just stays as literal text.
  // Renders markdown-style [text](url) links as real clickable <a> tags.
  // Added (24 Aug 2026) — file-delivery messages now embed a hyperlink
  // directly in the agent's own response text (Architecture redesign:
  // synchronous generation + inline link, replacing the old separate
  // "here's your file" follow-up message with a raw URL), so this needs
  // to actually render as a clickable link rather than literal
  // bracket-paren text.
  const renderMarkdownLinks = (text: string, keyPrefix: string | number) => {
    const linkParts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
    return linkParts.map((part, i) => {
      const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (match) {
        return (
          <a key={`${keyPrefix}-link-${i}`} href={match[2]} target="_blank" rel="noopener noreferrer" className="ms-file-link">
            {match[1]}
          </a>
        );
      }
      return part; // plain text fragment — React renders strings fine inline
    });
  };

  const renderContentWithCitations = (content: string, sources: Message['sources']) => {
    if (!sources || sources.length === 0) return renderMarkdownLinks(content, 'root');
    const parts = content.split(/(\[\d+\])/g);

    // Groups consecutive citation markers separated only by whitespace/
    // nothing (e.g. "[1][2]" or "[1] [2]") into ONE combined badge instead
    // of a separate box per number — several citations piled up right next
    // to each other reads as one footnote cluster, not a row of repeated
    // boxes. A citation with real text between it and the next one (i.e.
    // not just whitespace) starts its own separate cluster as before.
    type Segment = { type: 'text'; value: string } | { type: 'citations'; indices: number[] };
    const segments: Segment[] = [];
    let i = 0;
    while (i < parts.length) {
      const part = parts[i];
      const match = part.match(/^\[(\d+)\]$/);
      const cited = match ? sources.find(s => s.index === parseInt(match[1], 10)) : null;

      if (cited) {
        const indices = [cited.index];
        let j = i + 1;
        while (j + 1 < parts.length && parts[j].trim() === '') {
          const nextMatch = parts[j + 1].match(/^\[(\d+)\]$/);
          const nextCited = nextMatch ? sources.find(s => s.index === parseInt(nextMatch[1], 10)) : null;
          if (!nextCited) break;
          indices.push(nextCited.index);
          j += 2;
        }
        segments.push({ type: 'citations', indices });
        i = j;
      } else {
        segments.push({ type: 'text', value: part });
        i++;
      }
    }

    return segments.map((seg, idx) => {
      if (seg.type === 'citations') {
        return (
          <button key={idx} className="ms-citation-chip" onClick={() => setViewingSources(sources)}>
            {seg.indices.join(',')}
          </button>
        );
      }
      return <span key={idx}>{renderMarkdownLinks(seg.value, idx)}</span>;
    });
  };

  const renderMessage = (msg: Message) => {
    if (msg.typing) return (
      <div key={msg.id} className="ms-typing">
        <span className="ms-typing-label">{chatMode === 'deep' ? t('msAnalyzingDeeply', lang) : t('msThinking', lang)}</span>
        <div className="ms-typing-dots"><div className="ms-typing-dot"/><div className="ms-typing-dot"/><div className="ms-typing-dot"/></div>
      </div>
    );
    if (msg.sender === 'System') return <div key={msg.id} className="ms-system-msg">{msg.content}</div>;
    if (msg.voice_transcript && msg.voice_transcript.length > 0) return (
      <div key={msg.id} className="ms-voice-card" onClick={() => setViewingVoiceMsg(msg)}>
        <span className="ms-voice-card-icon">🎙</span>
        <span className="ms-voice-card-label">{msg.content}</span>
      </div>
    );
    if (msg.sender === 'User' && msg.id === editingId) return (
      <div key={msg.id} className="ms-msg ms-msg-user ms-msg-editing">
        <span className="ms-msg-label">User</span>
        <div className="ms-msg-edit-box">
          <textarea className="ms-msg-edit-textarea" value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => handleEditKeyDown(e, msg)}
            rows={Math.min(6, Math.max(2, editText.split('\n').length))} autoFocus/>
          <div className="ms-msg-edit-actions">
            <button className="ms-msg-edit-save" onClick={() => handleEditSave(msg)} disabled={!editText.trim()}>{t('msSaveRegenerate', lang)}</button>
            <button className="ms-msg-edit-cancel" onClick={cancelEdit}>{t('msCancel', lang)}</button>
          </div>
        </div>
      </div>
    );
    return (
      <div key={msg.id} className={`ms-msg ms-msg-${msg.sender.toLowerCase()}`}>
        <span className="ms-msg-label">{msg.sender}</span>
        <div className="ms-msg-bubble-wrap">
          <div className="ms-msg-bubble">{renderContentWithCitations(msg.content, msg.sources)}</div>
          {msg.sender === 'User' && !loading && <button className="ms-msg-edit-btn" onClick={() => startEdit(msg)} title="Edit">✎</button>}
        </div>
        {msg.sources && msg.sources.length > 0 && (
          <button className="ms-sources-chip" onClick={() => setViewingSources(msg.sources!)}>
            {msg.sources.length === 1 ? t('msSourcesChipOne', lang) : t('msSourcesChip', lang, { count: msg.sources.length })}
          </button>
        )}
      </div>
    );
  };

  const renderNewsItem = (item: NewsItem, i: number) => (
    <a key={i} className="ms-feed-item" href={item.url} target="_blank" rel="noopener noreferrer">
      <div className="ms-feed-source">{item.source}{item.tag && <span className="ms-feed-tag">{item.tag}</span>}</div>
      <p className="ms-feed-title">{item.title}</p>
      {item.excerpt && <p className="ms-feed-excerpt">{item.excerpt}</p>}
      <div className="ms-feed-meta"><span className="ms-feed-time">{item.time}</span><span className="ms-feed-cat">{item.category}</span></div>
    </a>
  );

  const leftVisible  = mobileTab === 'intel';
  const rightVisible = mobileTab === 'radar' || mobileTab === 'ledger';
  const hasPreview   = !!attachment || !!pastedContent;

  return (
    <div className="ms-root">

      {/* ── Masthead ── */}
      <header className="ms-masthead">
        <div className="ms-masthead-title">Gonya</div>
        <div className="ms-masthead-bar">
          <div className="ms-masthead-left">
            <div className="ms-nav-wrap" ref={navRef}>
              <button className={`ms-nav-btn ${navOpen ? 'active' : ''}`} onClick={() => setNavOpen(p => !p)}>☰</button>
              {navOpen && (
                <div className="ms-nav-popover">
                  <div className={`ms-nav-item ${view === 'chat' ? 'active' : ''}`} onClick={() => switchView('chat')}><span className="ms-nav-icon">◉</span> {t('msNavChat', lang)}</div>
                  <div className={`ms-nav-item ${view === 'vault' ? 'active' : ''}`} onClick={() => switchView('vault')}><span className="ms-nav-icon">🗄</span> {t('msNavVault', lang)}</div>
                  <div className={`ms-nav-item ${view === 'dossier' ? 'active' : ''}`} onClick={() => switchView('dossier')}><span className="ms-nav-icon">⬡</span> {t('msNavDossiers', lang)}</div>
                  <div className={`ms-nav-item ${supportOpen ? 'active' : ''}`} onClick={() => { setSupportOpen(p => !p); setNavOpen(false); }}><span className="ms-nav-icon">✉</span> {t('msNavContactSupport', lang)}</div>
                  <div className={`ms-nav-item ${view === 'control' ? 'active' : ''}`} onClick={() => switchView('control')}><span className="ms-nav-icon">⚙</span> {t('msNavControlPanel', lang)}</div>
                  {(localProfile.role === 'admin' || localProfile.role === 'owner') && (
                    <div className={`ms-nav-item ${view === 'admin' ? 'active' : ''}`} onClick={() => switchView('admin')}><span className="ms-nav-icon">⬡</span> {t('msNavAdminTerminal', lang)}</div>
                  )}
                  <div className={`ms-nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => switchView('settings')}><span className="ms-nav-icon">◈</span> Settings</div>
                  <div className={`ms-nav-item ${createGroupOpen || groupPickerOpen ? 'active' : ''}`} onClick={handleGroupChatNavClick}><span className="ms-nav-icon">⚏</span> Group Chat</div>
                  <div className={`ms-nav-item ${voiceCallOpen ? 'active' : ''}`} onClick={() => { setVoiceCallOpen(true); setNavOpen(false); }}><span className="ms-nav-icon">🎙</span> {t('msNavVoiceCall', lang)}</div>
                </div>
              )}
            </div>
            <span className="ms-masthead-clock">{clock}</span>
          </div>
          <span className="ms-masthead-motto">Thought, undivided.</span>
          <div className="ms-masthead-right">
            <button
              className={`ms-mem-trigger ${memPendingCount > 0 ? 'has-pending' : ''}`}
              onClick={() => setMemDrawerOpen(true)}
            >
              {memPendingCount > 0 ? t('msMemoryPending', lang, { n: memPendingCount }) : t('msMemoryLabel', lang)}
              {memPendingCount > 0 && <span className="ms-mem-notif-dot"/>}
            </button>
            {isAnonymous && (
              <span
                title={t('msDemoModeHint', lang)}
                style={{
                  fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--cyan)', border: '1px solid var(--cyan-dim)',
                  padding: '3px 8px', background: 'var(--cyan-glow)',
                }}
              >
                {t('msDemoModeBadge', lang)}
              </span>
            )}
            <span className="ms-status-dot">{t('msOnline', lang)}</span>
            <button className="ms-user-btn">{localProfile.display_name || 'Agent'}</button>
            <button className="ms-signout-btn" onClick={handleSignOut}>{t('msSignOut', lang)}</button>
          </div>
        </div>
      </header>

      <div className="ms-body">

        {/* ── Left ── */}
        <aside className={`ms-left ${leftVisible ? 'mobile-active' : ''}`} style={{ position: 'relative' }}>
          <div className="ms-panel-header" ref={editCatRef}>
            <span className="ms-panel-title">{t('msMacroIntelTitle', lang)}</span>
            <div className="ms-panel-actions">
              <button className="ms-refresh-btn" onClick={() => loadMacroNews()}>↻</button>
              <button className="ms-edit-btn" onClick={() => { setEditCatOpen(p => !p); setEditCats(localProfile.radar_categories || []); }}>✎</button>
            </div>
            {editCatOpen && (
              <div className="ms-cat-popover">
                <div className="ms-cat-popover-header">{t('msSelectCategories', lang)}</div>
                <div className="ms-cat-grid">
                  {ALL_CATEGORIES.map(cat => (
                    <div key={cat} className={`ms-cat-item ${editCats.includes(cat) ? 'checked' : ''}`} onClick={() => toggleCat(cat)}>
                      <div className="ms-cat-check">{editCats.includes(cat) ? '✓' : ''}</div>{cat}
                    </div>
                  ))}
                </div>
                <div className="ms-cat-popover-footer">
                  <button className="ms-cat-save-btn" onClick={handleSaveCategories} disabled={savingCats}>{savingCats ? t('msSaving', lang) : t('msSave', lang)}</button>
                </div>
              </div>
            )}
          </div>
          <div className="ms-filter-bar">
            {userCategories.map(cat => (
              <button key={cat} className={`ms-filter-btn ${activeFilter === cat ? 'active' : ''}`} onClick={() => setActiveFilter(cat)}>{cat}</button>
            ))}
          </div>
          <div className="ms-feed">
            {macroLoading ? <div className="ms-feed-loading">{t('msLoadingNews', lang)}</div>
              : filteredMacro.length > 0 ? filteredMacro.map(renderNewsItem)
              : <div className="ms-feed-loading">{t('msNoItemsCategory', lang)}</div>}
          </div>

          {/* ── Gonya mascot — floats at bottom of left column ── */}
          {(!gonyaFloatHidden || gonyaWarping) && (
            <div className={`gonya-float ${gonyaWarping ? 'gonya-float-warp' : ''}`}>
              <GonyaMascot state={gonyaState} size={110} />
            </div>
          )}
        </aside>

        {/* ── Center ── */}
        <main
          className={`ms-center ${isDragging ? 'ms-center-dragging' : ''}`}
          onDragEnter={view === 'chat' ? handleDragEnter : undefined}
          onDragLeave={view === 'chat' ? handleDragLeave : undefined}
          onDragOver={view === 'chat'  ? handleDragOver  : undefined}
          onDrop={view === 'chat'      ? handleDrop      : undefined}
        >
          {view === 'chat' && (
            <>
              {isDragging && (
                <div className="ms-drag-overlay">
                  <div className="ms-drag-overlay-box">
                    <div className="ms-drag-overlay-icon">⎙</div>
                    <div className="ms-drag-overlay-text">{t('msDropToAttach', lang)}</div>
                    <div className="ms-drag-overlay-sub">{t('msDropSubtext', lang)}</div>
                  </div>
                </div>
              )}
              <div className="ms-chat-area" ref={chatRef}>
                {messages.length === 0 && <div className="ms-system-msg">{t('msWelcomeBack', lang, { name: localProfile.display_name || 'Agent' })}</div>}
                {messages.map(renderMessage)}
                {renderSafetyCard()}
              </div>
              {hasPreview && (
                <div className="ms-paste-area">
                  {pastedContent && (
                    <div className="ms-paste-card">
                      <p className="ms-paste-preview">{pastedContent.preview}</p>
                      <span className="ms-paste-badge">{t('msPastedBadge', lang)}</span>
                      <button className="ms-paste-remove" onClick={() => setPastedContent(null)}>×</button>
                    </div>
                  )}
                  {attachment && (
                    attachment.previewUrl ? (
                      <div className="ms-attach-image-preview">
                        <div className="ms-attach-image-wrap">
                          <img src={attachment.previewUrl} alt={attachment.name} className="ms-attach-thumb"/>
                          {uploadingFile && <div className="ms-attach-uploading-overlay"><span>⏳</span></div>}
                          <button className="ms-attach-image-remove" onClick={() => setAttachment(null)}>×</button>
                        </div>
                        <span className="ms-attach-image-name">{attachment.name}</span>
                      </div>
                    ) : (
                      <div className="ms-attach-preview">
                        <span className="ms-attach-icon">{uploadingFile ? '⏳' : '📎'}</span>
                        <span className="ms-attach-preview-name">{attachment.name}</span>
                        {uploadingFile && <span className="ms-attach-uploading-label">{t('msUploadingLabel', lang)}</span>}
                        {!uploadingFile && attachment.noTextExtracted && (
                          <span className="ms-attach-no-text-warning" title={t('msFileNoTextWarning', lang)}>
                            ⚠ {t('msFileNoTextWarning', lang)}
                          </span>
                        )}
                        <button className="ms-attach-remove" onClick={() => setAttachment(null)}>×</button>
                      </div>
                    )
                  )}
                </div>
              )}
              <div className="ms-input-bar">
                <div className="ms-input-plus" ref={popoverRef}>
                  <button className={`ms-plus-btn ${popoverOpen ? 'active' : ''}`} onClick={() => setPopoverOpen(p => !p)}>+</button>
                  {popoverOpen && (
                    <div className="ms-popover">
                      <div className="ms-popover-section">
                        <div className="ms-popover-label">{t('msResponseMode', lang)}</div>
                        <div className={`ms-popover-item ${chatMode === 'quick' ? 'selected' : ''}`} onClick={() => selectMode('quick')}>{t('msQuick', lang)} {chatMode === 'quick' && <span className="ms-popover-item-check">✓</span>}</div>
                        <div className="ms-popover-desc">{t('msQuickDesc', lang)}</div>
                        <div className={`ms-popover-item ${chatMode === 'deep' ? 'selected' : ''}`} onClick={() => selectMode('deep')}>{t('msDeep', lang)} {chatMode === 'deep' && <span className="ms-popover-item-check">✓</span>}</div>
                        <div className="ms-popover-desc">{t('msDeepDesc', lang)}</div>
                      </div>
                      <div className="ms-popover-section">
                        <div className="ms-popover-label">{t('msDirectTo', lang)}</div>
                        <div className="ms-popover-item" onClick={() => insertMention('@Aksel')}>@Aksel</div>
                        <div className="ms-popover-item" onClick={() => insertMention('@Vera')}>@Vera</div>
                      </div>
                      <div className="ms-popover-section">
                        <div className="ms-popover-label">{t('msLanguagePopover', lang)}</div>
                        <div className="ms-popover-item" onClick={() => { setInput('/Mode Bahasa'); setPopoverOpen(false); inputRef.current?.focus(); }}>/Mode Bahasa</div>
                        <div className="ms-popover-item" onClick={() => { setInput('/English Mode'); setPopoverOpen(false); inputRef.current?.focus(); }}>/English Mode</div>
                      </div>
                    </div>
                  )}
                </div>
                <button className="ms-attach-btn" onClick={() => fileRef.current?.click()} disabled={uploadingFile} title="Attach file or drag & drop">
                  {uploadingFile ? '⏳' : '⎙'}
                </button>
                <input ref={fileRef} type="file"
                  accept=".txt,.md,.csv,.json,.js,.ts,.py,.pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp"
                  style={{ display: 'none' }} onChange={handleFileSelect}/>
                <span className={`ms-mode-badge ${chatMode}`}>{chatMode}</span>
                <textarea ref={inputRef} className="ms-input"
                  placeholder={t('msInputPlaceholder', lang)}
                  value={input} rows={1}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown} onPaste={handlePaste}
                  disabled={loading} autoFocus/>
                <button className="ms-voice-btn" onClick={() => setVoiceCallOpen(true)} title={t('vcVoiceCall', lang)}>
                  🎙
                </button>
                <button className="ms-send-btn" onClick={handleSend}
                  disabled={(!input.trim() && !attachment && !pastedContent) || loading || uploadingFile}>
                  {loading ? '···' : t('msSendBtn', lang)}
                </button>
              </div>
            </>
          )}

          {view === 'vault'    && <Vault lang={lang} />}
          {view === 'dossier'  && (
            <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' }}>
              <Dossier lang={lang} />
              {renderDossierIntro()}
              {dossierIntroDismissed && (
                <button className="ms-dossier-help-btn" onClick={() => setShowDossierIntro(true)} title="What is a Dossier?">?</button>
              )}
            </div>
          )}
          {view === 'settings' && (
            <Settings
              profile={localProfile}
              onSignOut={onSignOut}
              onUpdate={(updated) => setLocalProfile(prev => ({ ...prev, ...updated }))}
            />
          )}
          {view === 'control' && (
            <div className="ms-view-placeholder">
              <span className="ms-view-placeholder-title">{t('msNavControlPanel', lang)}</span>
              <p className="ms-view-placeholder-text">{t('msControlPanelDesc', lang)}</p>
            </div>
          )}
        </main>

        {/* ── Right ── */}
        <aside className={`ms-right ${rightVisible ? 'mobile-active' : ''}`}>
          <div className="ms-right-top">
            <div className="ms-panel-header">
              <span className="ms-panel-title">{t('msMicroRadarTitle', lang)}</span>
              <button className="ms-refresh-btn" onClick={loadRadarNews}>↻</button>
            </div>
            <div className="ms-feed">
              {radarLoading ? <div className="ms-feed-loading">{t('msLoadingRadar', lang)}</div> : radarNews.slice(0, 6).map(renderNewsItem)}
            </div>
            {!showSourceForm
              ? <button className="ms-add-source-btn" onClick={() => setShowSourceForm(true)}>{t('msAddRssSource', lang)}</button>
              : <div className="ms-source-form">
                  <input className="ms-source-input" placeholder={t('msSourceNamePh', lang)} value={sourceName} onChange={e => setSourceName(e.target.value)}/>
                  <input className="ms-source-input" placeholder={t('msRssUrlPh', lang)} value={sourceUrl} onChange={e => setSourceUrl(e.target.value)}/>
                  <div className="ms-source-actions">
                    <button className="ms-source-save" onClick={handleAddSource} disabled={savingSource}>{savingSource ? '...' : t('msAdd', lang)}</button>
                    <button className="ms-source-cancel" onClick={() => { setShowSourceForm(false); setSourceName(''); setSourceUrl(''); }}>{t('msCancel', lang)}</button>
                  </div>
                </div>
            }
          </div>

          {/* ── The Ledger ── */}
          <div className="ms-widget-carousel">
            <div className="ms-widget-carousel-header">
              <span className="ms-panel-title">{t('msLedgerTitle', lang)}</span>
              <div className="ms-widget-carousel-nav">
                <button className="ms-widget-nav-btn" onClick={() => setWidgetIdx(i => Math.max(0, i - 1))} disabled={widgetIdx === 0}>‹</button>
                <div className="ms-widget-dots">
                  {activeWidgetIds.map((_, i) => (
                    <div key={i} className={`ms-widget-dot ${widgetIdx === i ? 'active' : ''}`} onClick={() => setWidgetIdx(i)}/>
                  ))}
                </div>
                <button className="ms-widget-nav-btn" onClick={() => setWidgetIdx(i => Math.min(activeWidgetIds.length - 1, i + 1))} disabled={widgetIdx >= activeWidgetIds.length - 1}>›</button>
              </div>
            </div>
            <div className="ms-widget-body">
              {renderWidget(activeWidgetIds[widgetIdx])}
            </div>
            <div style={{ position: 'relative' }}>
              <button className="ms-add-widget" onClick={() => setWidgetMgrOpen(p => !p)}>
                {t('msManageWidgets', lang)}
              </button>
              {widgetMgrOpen && (
                <>
                  <div className="wgt-manager-overlay" onClick={() => setWidgetMgrOpen(false)}/>
                  <div className="wgt-manager-popover">
                    <div className="wgt-manager-header">{t('msWidgetsToggleHint', lang)}</div>
                    {getWidgetMeta(lang === 'id' ? 'id' : 'en').map(w => (
                      <div
                        key={w.id}
                        className={`wgt-manager-item ${activeWidgetIds.includes(w.id) ? 'active' : ''}`}
                        onClick={() => toggleWidget(w.id)}
                      >
                        <div className="wgt-manager-check">
                          {activeWidgetIds.includes(w.id) ? '✓' : ''}
                        </div>
                        <div className="wgt-manager-item-body">
                          <span className="wgt-manager-item-title">{w.title}</span>
                          <span className="wgt-manager-item-desc">{w.description}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>

        {/* ── Memory drawer backdrop ── */}
        <div className={`ms-mem-backdrop ${memDrawerOpen ? 'open' : ''}`} onClick={() => setMemDrawerOpen(false)}/>

        {/* ── Memory drawer ── */}
        <div className={`ms-mem-drawer ${memDrawerOpen ? 'open' : ''}`}>
          <div className="ms-mem-drawer-header">
            <div className="ms-mem-drawer-title-wrap">
              <span className="ms-mem-drawer-title">{t('msMemoryLabel', lang)}</span>
              {memPendingCount > 0 && <span className="ms-mem-drawer-badge">{memPendingCount} {lang === 'id' ? 'Tertunda' : 'Pending'}</span>}
            </div>
            <button className="ms-mem-drawer-close" onClick={() => setMemDrawerOpen(false)}>×</button>
          </div>
          <Memory onPendingCountChange={setMemPendingCount} lang={lang} />
        </div>

      </div>

      {/* ── Idle overlay ── */}
      <IdleOverlay
        timeout={5 * 60 * 1000}
        onShow={() => setGonyaFloatHidden(true)}
        onHide={() => {
          setGonyaWarping(true);
          setGonyaFloatHidden(false);
          setTimeout(() => setGonyaWarping(false), 600);
        }}
      />

      {/* ── Contact Support popup — floats above chat, doesn't replace it ── */}
      {supportOpen && (
        <ContactSupport profile={localProfile} onClose={() => setSupportOpen(false)} />
      )}

      {createGroupOpen && (
        <CreateGroupModal
          lang={lang}
          onClose={() => setCreateGroupOpen(false)}
          onCreated={(groupId, groupName) => {
            setCreateGroupOpen(false);
            setGroupOnboarding({ id: groupId, name: groupName });
          }}
        />
      )}

      {groupPickerOpen && (
        <GroupPicker
          groups={myGroups}
          lang={lang}
          onClose={() => setGroupPickerOpen(false)}
          onSelect={(g) => {
            setGroupPickerOpen(false);
            if (g.onboarding_done) setActiveGroup({ id: g.id, name: g.name, myRole: g.my_role });
            else                   setGroupOnboarding({ id: g.id, name: g.name });
          }}
          onCreateNew={() => {
            setGroupPickerOpen(false);
            setCreateGroupOpen(true);
          }}
        />
      )}

      {/* ── Mobile tabs ── */}
      <nav className="ms-mobile-tabs"></nav>

      {/* ── Mobile tabs ── */}
      <nav className="ms-mobile-tabs">
        {([
          { id: 'intel', icon: '◈', label: t('msTabIntel', lang) }, { id: 'chat', icon: '◉', label: t('msTabChat', lang) },
          { id: 'radar', icon: '◎', label: t('msTabRadar', lang) }, { id: 'ledger', icon: '◧', label: t('msTabLedger', lang) },
        ] as { id: MobileTab; icon: string; label: string }[]).map(tab => (
          <button key={tab.id} className={`ms-tab-btn ${mobileTab === tab.id ? 'active' : ''}`} onClick={() => setMobileTab(tab.id)}>
            <span className="ms-tab-icon">{tab.icon}</span>{tab.label}
          </button>
        ))}
      </nav>

      {voiceCallOpen && (
        <VoiceCall profile={localProfile} onClose={() => setVoiceCallOpen(false)} />
      )}

      {viewingVoiceMsg && (
        <VoiceSessionModal
          content={viewingVoiceMsg.content}
          transcript={viewingVoiceMsg.voice_transcript || []}
          lang={lang}
          onClose={() => setViewingVoiceMsg(null)}
        />
      )}

      {viewingSources && (
        <SourcesModal
          sources={viewingSources}
          lang={lang}
          onClose={() => setViewingSources(null)}
        />
      )}

    </div>
  );
}