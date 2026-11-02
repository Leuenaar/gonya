import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch, signOut, supabase, type UserProfile } from '../lib/supabase';
import Vault    from './Vault';
import Dossier  from './Dossier';
import Settings from './Settings';
import ContactSupport from './ContactSupport';
import CreateGroupModal from './CreateGroupModal';
import GroupOnboarding from './GroupOnboarding';
import GroupChat from './GroupChat';
import GroupPicker from './GroupPicker';
import Memory   from './Memory';
import VoiceCallMobile from './VoiceCallMobile';
import VoiceSessionModal from './VoiceSessionModal';
import SourcesModal, { type SourceItem } from './SourcesModal';
import AdminTerminal from './AdminTerminal';
import IdleOverlay from '../components/IdleOverlay';
import {
  WIDGET_REGISTRY, DEFAULT_WIDGET_IDS, getWidgetMeta,
  AgentStatusWidget, SessionStatsWidget, MemorySummaryWidget,
  UsageStatsWidget, FocusTimerWidget, QuickNotesWidget,
  TaskListWidget, CurrencyWidget,
} from './Widgets';
import { CalendarWidget } from './WidgetCalendar';
import { t } from '../lib/i18n';
import './MainShellMobile.css';

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

type ActiveTab  = 'chat' | 'intel' | 'radar' | 'ledger';
type ActiveView = 'main' | 'archive' | 'vault' | 'dossier' | 'settings' | 'memory';

const ALL_CATEGORIES = [
  'All', 'Business', 'Technology', 'Science', 'Health',
  'Politics', 'World', 'Marketing', 'Finance',
];

const CHANNEL_ICONS: Record<string, string> = {
  call: '📞', whatsapp: '💬', web: '🔗', app: '📱',
};

const WIDGET_STORAGE_KEY = 'gonya_widget_config';

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

export default function MainShellMobile({ profile, isAnonymous, onSignOut, pendingGroup }: Props) {
  const [activeTab,    setActiveTab]    = useState<ActiveTab>('chat');
  const [activeView,   setActiveView]   = useState<ActiveView>('main');
  const [supportOpen,  setSupportOpen]  = useState(false);
  const [adminOpen,    setAdminOpen]    = useState(false);
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);
  const [viewingVoiceMsg, setViewingVoiceMsg] = useState<Message | null>(null);
  const [viewingSources, setViewingSources] = useState<SourceItem[] | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupOnboarding, setGroupOnboarding] = useState<{ id: string; name: string } | null>(null);
  const [activeGroup,     setActiveGroup]     = useState<{ id: string; name: string; myRole: string } | null>(pendingGroup ?? null);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [myGroups,        setMyGroups]        = useState<Array<{ id: string; name: string; onboarding_done: boolean; my_role: string }>>([]);
  const [menuOpen,     setMenuOpen]     = useState(false);
  const [popoverOpen,  setPopoverOpen]  = useState(false);
  const [localProfile, setLocalProfile] = useState<UserProfile>(profile);
  // Derived from localProfile (not the profile PROP) — same fix as
  // MainShell.tsx (desktop): localProfile is what Settings.onUpdate
  // actually writes to, so this stays correct immediately after a
  // language change instead of only on next mount.
  const lang = localProfile.language;

  // Chat state
  const [messages,      setMessages]      = useState<Message[]>([]);
  // Synchronous double-send guard (24 Aug 2026, same fix as MainShell.tsx/
  // desktop) — `loading` state alone can't reliably prevent a
  // near-simultaneous second handleSend() call within the same event
  // tick, since React state updates are batched/async, not immediate.
  const sendingRef = useRef(false);
  const [input,         setInput]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [chatMode,      setChatMode]      = useState<'quick' | 'deep'>('quick');
  const [attachment,    setAttachment]    = useState<Attachment | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [pastedContent, setPastedContent] = useState<{ preview: string; full: string } | null>(null);
  const [editingId,     setEditingId]     = useState<string | null>(null);
  const [editText,      setEditText]      = useState('');
  const [msgCount,      setMsgCount]      = useState(0);

  // News state
  const [macroNews,      setMacroNews]      = useState<NewsItem[]>([]);
  const [radarNews,      setRadarNews]      = useState<NewsItem[]>([]);
  const [macroLoading,   setMacroLoading]   = useState(false);
  const [radarLoading,   setRadarLoading]   = useState(false);
  const [activeFilter,   setActiveFilter]   = useState('All');
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [sourceName,     setSourceName]     = useState('');
  const [sourceUrl,      setSourceUrl]      = useState('');

  // Safety state
  const [safetyCardVisible, setSafetyCardVisible] = useState(false);
  const [safetyData,        setSafetyData]        = useState<SafetyData | null>(null);

  // Memory
  const [memPendingCount, setMemPendingCount] = useState(0);

  // Widget manager — shared localStorage key with desktop
  const [activeWidgetIds, setActiveWidgetIds] = useState<string[]>(() => {
    const validIds = WIDGET_REGISTRY.map(w => w.id);
    try {
      const saved    = localStorage.getItem(WIDGET_STORAGE_KEY);
      const parsed   = saved ? JSON.parse(saved) : DEFAULT_WIDGET_IDS;
      const filtered = parsed.filter((id: string) => validIds.includes(id));
      return filtered.length > 0 ? filtered : DEFAULT_WIDGET_IDS;
    } catch { return DEFAULT_WIDGET_IDS; }
  });
  const [widgetIdx,     setWidgetIdx]     = useState(0);
  const [widgetMgrOpen, setWidgetMgrOpen] = useState(false);

  const [clock, setClock] = useState('');

  const chatRef    = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileRef       = useRef<HTMLInputElement>(null);
  const touchStartX   = useRef(0);
  const touchStartY   = useRef(0);
  // ── Clock ─────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const pad    = (x: number) => String(x).padStart(2, '0');
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      setClock(`${pad(n.getUTCDate())} ${months[n.getUTCMonth()]} · ${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())} UTC`);
    };
    tick();
    // Minute-granularity display doesn't need a per-second tick like
    // AuthScreen's fuller clock does — 30s keeps it fresh without the
    // extra re-renders on a mobile device.
    const id = setInterval(tick, 30 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── Load chat history ──────────────────────────────────
  useEffect(() => {
    if (activeView !== 'main') return;
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
  }, [activeView]);

  // ── Realtime: catch messages that arrive OUTSIDE the synchronous
  // chat/send + chat/edit flow (Phase 8.8) — same fix as MainShell.tsx
  // (desktop), mirrored here since this file has its own independent copy
  // of the chat logic rather than reusing the desktop component. See the
  // desktop version's comment for the full rationale (file-generation
  // follow-up message was the one thing that needed a manual refresh).
  useEffect(() => {
    if (activeView !== 'main') return;

    let cancelled       = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount      = 0;
    let currentChannel: ReturnType<typeof supabase.channel> | null = null;

    const connect = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) supabase.realtime.setAuth(session.access_token);

      const channel = supabase
        .channel(`personal:${localProfile.id}`, { config: { private: true } })
        .on('broadcast', { event: 'INSERT' }, (message: any) => {
          const rec = message?.payload?.record;
          if (!rec?.id) return;
          setMessages(prev => {
            if (prev.some(m => m.id === rec.id)) return prev; // already added synchronously (e.g. Aksel/Vera's reply)
            // Same fix as MainShell.tsx (desktop) — this channel is private
            // to this user, so a 'User'-sender broadcast here is this
            // user's own just-sent message echoing back, which can arrive
            // before the HTTP response's own tempId->real-id reconciliation,
            // previously causing a duplicate bubble until refresh.
            // Fixed (24 Aug 2026, same fix as MainShell.tsx/desktop): the
            // old exact-content match broke whenever the send included
            // pastedContent or an attachment — the optimistic bubble shows
            // shortened `displayText`, the server echoes back the FULL raw
            // content, so they never equal each other and this silently
            // missed, appending a duplicate instead of replacing. Matching
            // the OLDEST temp_ entry by id-prefix alone (FIFO) is robust
            // regardless of content.
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
  }, [activeView, localProfile.id]);

  // ── Load news ──────────────────────────────────────────
  const loadMacroNews = useCallback(async (filter = 'All') => {
    setMacroLoading(true);
    try {
      const cats  = filter === 'All' ? (localProfile.radar_categories || []) : [filter];
      const query = cats.length > 0 ? `?categories=${cats.join(',')}` : '';
      const res   = await apiFetch(`/api/news/macro${query}`);
      const data  = await res.json();
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

  // ── Auto-scroll ────────────────────────────────────────
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, safetyCardVisible]);

  // ── Auto-grow textarea ─────────────────────────────────
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 100) + 'px';
    }
  }, [input]);

  // ── Close popover on outside click ────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPopoverOpen(false);
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
      case 'memory':   return <MemorySummaryWidget onOpenMemory={() => setActiveView('memory')} profile={localProfile} />;
      case 'usage':    return <UsageStatsWidget lang={lang} />;
      case 'timer':    return <FocusTimerWidget lang={lang} />;
      case 'notes':    return <QuickNotesWidget lang={lang} />;
      case 'tasks':    return <TaskListWidget lang={lang} />;
      case 'currency': return <CurrencyWidget lang={lang} />;
      case 'calendar': return <CalendarWidget profile={localProfile} />;
      default:         return null;
    }
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({
          file_name: file.name, file_type: file.type || 'application/octet-stream',
          file_base64: base64, conversation_id: 'main',
        }),
      });
      const data = await res.json();
      if (localUrl) URL.revokeObjectURL(localUrl);
      if (data.status === 'success') {
        setAttachment({
          name: file.name, content: data.data.url || `[File stored: ${file.name}]`,
          fileId: data.data.id, type: file.type,
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
    if (sendingRef.current) return; // synchronous guard — see the ref's own comment above
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
    setMessages(prev => [...prev, { id: tempId, sender: 'User', content: displayText, created_at: new Date().toISOString() }]);
    setMsgCount(prev => prev + 1);
    setMessages(prev => [...prev, { id: typingId, sender: 'System', content: '', created_at: '', typing: true }]);

    try {
      const res  = await apiFetch('/api/chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ message: content, mode: chatMode }),
      });
      const data = await res.json();
      if (data.status === 'success' && data.userMessage && data.responses) {
        // Fix (24 Aug 2026, same as MainShell.tsx/desktop) — guards
        // against the realtime-vs-HTTP race: if Aksel/Vera's reply
        // already arrived via broadcast before this HTTP response
        // processed, concat-ing it again produced two entries sharing
        // the identical id (React "duplicate key", renders as an
        // empty-looking bubble).
        setMessages(prev => {
          const withoutTyping = prev.filter(m => m.id !== typingId);
          const withUserSwap  = withoutTyping.map(m => m.id === tempId ? { ...m, id: data.userMessage.id, created_at: data.userMessage.created_at } : m);
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
    } finally { setLoading(false); sendingRef.current = false; inputRef.current?.focus(); }
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
        // Fix (24 Aug 2026, same as MainShell.tsx/desktop's edit flow).
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
    } finally { setLoading(false); }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, msg: Message) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(msg); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };
  
  // ── Swipe navigation ──────────────────────────────
  const TAB_ORDER: ActiveTab[] = ['chat', 'intel', 'radar', 'ledger'];

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;

    // Only fire on dominant horizontal swipe
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;

    const currentIdx = TAB_ORDER.indexOf(activeTab);
    if (deltaX < 0 && currentIdx < TAB_ORDER.length - 1) {
      setActiveTab(TAB_ORDER[currentIdx + 1]);
    } else if (deltaX > 0 && currentIdx > 0) {
      setActiveTab(TAB_ORDER[currentIdx - 1]);
    }
  };

  const insertMention = (tag: string) => { setInput(prev => prev ? `${prev} ${tag} ` : `${tag} `); setPopoverOpen(false); inputRef.current?.focus(); };
  const selectMode    = (mode: 'quick' | 'deep') => { setChatMode(mode); setPopoverOpen(false); inputRef.current?.focus(); };
  const handleSignOut = async () => { await signOut(); onSignOut(); };

  const handleAddSource = async () => {
    if (!sourceName.trim() || !sourceUrl.trim()) return;
    try {
      const res  = await apiFetch('/api/news/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ name: sourceName.trim(), url: sourceUrl.trim(), category: 'Custom' }),
      });
      const data = await res.json();
      if (data.status === 'success') { setSourceName(''); setSourceUrl(''); setShowSourceForm(false); loadRadarNews(); }
    } catch {}
  };

  // ── Safety card ────────────────────────────────────────
  const renderSafetyCard = () => {
    if (!safetyCardVisible) return null;
    const lang = localProfile.language || 'id';
    return (
      <div className="msm-safety-card">
        <div className="msm-safety-card-header">
          <span className="msm-safety-card-icon">🤝</span>
          <span className="msm-safety-card-title">{lang === 'en' ? 'Real support is available.' : 'Ada bantuan nyata yang bisa dihubungi.'}</span>
          <button className="msm-safety-card-dismiss" onClick={() => setSafetyCardVisible(false)}>×</button>
        </div>
        {safetyData ? (
          <div className="msm-safety-card-body">
            {safetyData.emergency && (
              <div className="msm-safety-section">
                <p className="msm-safety-section-label">{safetyData.emergency.name}</p>
                {safetyData.emergency.channels.map((ch, i) => (
                  <a key={i} href={getChannelHref(ch)} className="msm-safety-btn msm-safety-btn-emergency"
                    target={ch.type === 'call' ? '_self' : '_blank'} rel="noopener noreferrer">
                    {CHANNEL_ICONS[ch.type] || '🔗'} {ch.value}{ch.note ? ` ${ch.note}` : ''}
                  </a>
                ))}
              </div>
            )}
            {(safetyData.resources || []).map((r, i) => (
              <div key={i} className="msm-safety-section">
                <p className="msm-safety-section-label">{r.name}</p>
                {r.channels.map((ch, j) => (
                  <a key={j} href={getChannelHref(ch)} className="msm-safety-btn"
                    target={ch.type === 'call' ? '_self' : '_blank'} rel="noopener noreferrer">
                    {CHANNEL_ICONS[ch.type] || '🔗'} {lang === 'en' ? (ch.label_en || ch.value) : (ch.label_id || ch.value)}
                  </a>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="msm-safety-card-body">
            <p className="msm-safety-section-desc">{lang === 'en' ? 'If you are in crisis, please reach out to someone you trust.' : 'Kalau kamu lagi dalam kondisi sulit, hubungi seseorang yang kamu percaya.'}</p>
          </div>
        )}
      </div>
    );
  };

  // ── Message render ─────────────────────────────────────
  // Renders markdown-style [text](url) links as real clickable <a> tags
  // (24 Aug 2026, same fix as MainShell.tsx/desktop).
  const renderMarkdownLinks = (text: string, keyPrefix: string | number) => {
    const linkParts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
    return linkParts.map((part, i) => {
      const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (match) {
        return (
          <a key={`${keyPrefix}-link-${i}`} href={match[2]} target="_blank" rel="noopener noreferrer" className="msm-file-link">
            {match[1]}
          </a>
        );
      }
      return part;
    });
  };

  const renderContentWithCitations = (content: string, sources: Message['sources']) => {
    if (!sources || sources.length === 0) return renderMarkdownLinks(content, 'root');
    const parts = content.split(/(\[\d+\])/g);

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
          <button key={idx} className="msm-citation-chip" onClick={() => setViewingSources(sources)}>
            {seg.indices.join(',')}
          </button>
        );
      }
      return <span key={idx}>{renderMarkdownLinks(seg.value, idx)}</span>;
    });
  };

  const renderMessage = (msg: Message) => {
    if (msg.typing) return (
      <div key={msg.id} className="msm-typing">
        <span className="msm-typing-label">{chatMode === 'deep' ? t('msmAnalyzing', lang) : t('msmThinking', lang)}</span>
        <div className="msm-typing-dots">
          <div className="msm-typing-dot"/><div className="msm-typing-dot"/><div className="msm-typing-dot"/>
        </div>
      </div>
    );
    if (msg.sender === 'System') return <div key={msg.id} className="msm-system-msg">{msg.content}</div>;
    if (msg.voice_transcript && msg.voice_transcript.length > 0) return (
      <div key={msg.id} className="msm-voice-card" onClick={() => setViewingVoiceMsg(msg)}>
        <span className="msm-voice-card-icon">🎙</span>
        <span className="msm-voice-card-label">{msg.content}</span>
      </div>
    );
    if (msg.sender === 'User' && msg.id === editingId) return (
      <div key={msg.id} className="msm-msg msm-msg-user msm-msg-editing">
        <span className="msm-msg-label">User</span>
        <div className="msm-msg-edit-box">
          <textarea className="msm-msg-edit-textarea" value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => handleEditKeyDown(e, msg)}
            rows={Math.min(5, Math.max(2, editText.split('\n').length))} autoFocus/>
          <div className="msm-msg-edit-actions">
            <button className="msm-msg-edit-save" onClick={() => handleEditSave(msg)} disabled={!editText.trim()}>{t('msSaveRegenerate', lang)}</button>
            <button className="msm-msg-edit-cancel" onClick={cancelEdit}>{t('msCancel', lang)}</button>
          </div>
        </div>
      </div>
    );
    return (
      <div key={msg.id} className={`msm-msg msm-msg-${msg.sender.toLowerCase()}`}>
        <span className="msm-msg-label">{msg.sender}</span>
        <div className="msm-msg-bubble" onDoubleClick={() => msg.sender === 'User' && !loading && startEdit(msg)}>
          {renderContentWithCitations(msg.content, msg.sources)}
        </div>
        {msg.sources && msg.sources.length > 0 && (
          <button className="msm-sources-chip" onClick={() => setViewingSources(msg.sources!)}>
            {msg.sources.length === 1 ? t('msSourcesChipOne', lang) : t('msSourcesChip', lang, { count: msg.sources.length })}
          </button>
        )}
        {msg.sender === 'User' && !loading && (
          <button style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '10px', cursor: 'pointer', letterSpacing: '0.06em', marginTop: '2px', fontFamily: 'var(--font-mono)' }}
            onClick={() => startEdit(msg)}>{t('msmEditHint', lang)}</button>
        )}
      </div>
    );
  };

  const renderNewsItem = (item: NewsItem, i: number) => (
    <a key={i} className="msm-feed-item" href={item.url} target="_blank" rel="noopener noreferrer">
      <div className="msm-feed-source">{item.source}{item.tag && <span className="msm-feed-tag">{item.tag}</span>}</div>
      <p className="msm-feed-title">{item.title}</p>
      {item.excerpt && <p className="msm-feed-excerpt">{item.excerpt}</p>}
      <div className="msm-feed-meta"><span>{item.time}</span><span>{item.category}</span></div>
    </a>
  );

  const filteredMacro = activeFilter === 'All' ? macroNews : macroNews.filter(i => i.category?.toLowerCase() === activeFilter.toLowerCase());
  const hasPreview    = !!attachment || !!pastedContent;

  // ── Archive landing ────────────────────────────────────
  const renderArchiveLanding = () => (
    <div className="msm-archive-landing">
      <div className="msm-archive-card" onClick={() => setActiveView('vault')}>
        <div className="msm-archive-card-icon">🗄</div>
        <div className="msm-archive-card-body">
          <div className="msm-archive-card-title">{t('msNavVault', lang)}</div>
          <div className="msm-archive-card-desc">{t('msmVaultDesc', lang)}</div>
        </div>
        <div className="msm-archive-card-right">
          <span className="msm-archive-card-arrow">›</span>
        </div>
      </div>

      <div className="msm-archive-card" onClick={() => setActiveView('dossier')}>
        <div className="msm-archive-card-icon">⬡</div>
        <div className="msm-archive-card-body">
          <div className="msm-archive-card-title">{t('msNavDossiers', lang)}</div>
          <div className="msm-archive-card-desc">{t('msmDossierDesc', lang)}</div>
        </div>
        <div className="msm-archive-card-right">
          <span className="msm-archive-card-arrow">›</span>
        </div>
      </div>

      <div className="msm-archive-card" onClick={() => setActiveView('memory')}>
        <div className={`msm-archive-card-icon ${memPendingCount > 0 ? 'pending' : ''}`}>◈</div>
        <div className="msm-archive-card-body">
          <div className={`msm-archive-card-title ${memPendingCount > 0 ? 'pending' : ''}`}>{t('msMemoryLabel', lang)}</div>
          <div className="msm-archive-card-desc">
            {memPendingCount > 0 ? t('msmMemoryPendingDesc', lang, { n: memPendingCount }) : t('msmMemoryDesc', lang)}
          </div>
        </div>
        <div className="msm-archive-card-right">
          {memPendingCount > 0 && <span className="msm-archive-card-badge">{memPendingCount}</span>}
          <span className="msm-archive-card-arrow">›</span>
        </div>
      </div>
    </div>
  );

  // ── Admin Terminal — full takeover, same as desktop ────
  if (adminOpen) {
    return <AdminTerminal profile={localProfile} onBack={() => setAdminOpen(false)} />;
  }

  const handleGroupChatNavClick = async () => {
    setMenuOpen(false);
    try {
      // Same fix as MainShell.tsx (desktop) — must check invites before
      // routing, since a brand-new user with zero groups but a pending
      // invite used to skip straight past GroupPicker (the only place
      // invites are shown) to "Create a Group Chat".
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

  // ── Sub-view render ────────────────────────────────────
  if (activeView !== 'main') {
    if (activeView === 'archive') {
      return (
        <div className="msm-root">
          <div className="msm-subview">
            <div className="msm-subview-header">
              <button className="msm-back-btn" onClick={() => setActiveView('main')}>‹</button>
              <span className="msm-subview-title">{t('msmArchive', lang)}</span>
            </div>
            <div className="msm-subview-body">{renderArchiveLanding()}</div>
          </div>
        </div>
      );
    }

    const titles: Record<string, string> = {
      vault: t('msNavVault', lang), dossier: t('msNavDossiers', lang), memory: t('msMemoryLabel', lang), settings: t('msmSettings', lang),
    };
    const backDest: Record<string, ActiveView> = {
      vault: 'archive', dossier: 'archive', memory: 'archive', settings: 'main',
    };

    return (
      <div className="msm-root">
        <div className="msm-subview">
          <div className="msm-subview-header">
            <button className="msm-back-btn" onClick={() => setActiveView(backDest[activeView] || 'main')}>‹</button>
            <span className="msm-subview-title">{titles[activeView]}</span>
          </div>
          <div className="msm-subview-body">
            {activeView === 'vault'    && <Vault lang={lang} />}
            {activeView === 'dossier'  && <Dossier lang={lang} />}
            {activeView === 'memory'   && <Memory onPendingCountChange={setMemPendingCount} lang={lang} />}
            {activeView === 'settings' && (
              <Settings
                profile={localProfile}
                onSignOut={handleSignOut}
                onUpdate={(updated) => setLocalProfile(prev => ({ ...prev, ...updated }))}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────
  return (
    <div className="msm-root">

      <header className="msm-header">
        <div className="msm-header-top">
          <div className="msm-wordmark">Gonya</div>
          <div className="msm-header-right">
            {isAnonymous && (
              <span
                title={t('msDemoModeHint', lang)}
                style={{
                  fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--cyan)', border: '1px solid var(--cyan-dim)',
                  padding: '2px 6px', background: 'var(--cyan-glow)',
                }}
              >
                {t('msDemoModeBadge', lang)}
              </span>
            )}
            <span className="msm-status">{t('msOnline', lang)}</span>
            <span className="msm-clock">{clock}</span>
          </div>
        </div>
        {activeTab === 'chat' && (
          <div className="msm-agent-bar">
            <div className="msm-agent-pill"><div className="msm-agent-dot aksel"/>Aksel</div>
            <div className="msm-agent-pill"><div className="msm-agent-dot vera"/>Vera</div>
            <div style={{ marginLeft: 'auto', fontSize: '8px', letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
              {chatMode} mode
            </div>
          </div>
        )}
      </header>

      <div className="msm-content" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>

        {/* ── CHAT ── */}
        <div className={`msm-tab-pane ${activeTab === 'chat' ? 'active' : ''}`}>
          <div className="msm-chat-area" ref={chatRef}>
            {messages.length === 0 && <div className="msm-system-msg">{t('msWelcomeBack', lang, { name: localProfile.display_name || 'Agent' })}</div>}
            {messages.map(renderMessage)}
            {renderSafetyCard()}
          </div>

          {hasPreview && (
            <div className="msm-paste-area">
              {pastedContent && (
                <div className="msm-paste-card">
                  <p className="msm-paste-preview">{pastedContent.preview}</p>
                  <span className="msm-paste-badge">{t('msPastedBadge', lang)}</span>
                  <button className="msm-paste-remove" onClick={() => setPastedContent(null)}>×</button>
                </div>
              )}
              {attachment && (
                attachment.previewUrl ? (
                  <div className="msm-attach-image-preview">
                    <div className="msm-attach-image-wrap">
                      <img src={attachment.previewUrl} alt={attachment.name} className="msm-attach-thumb"/>
                      {uploadingFile && <div className="msm-attach-uploading-overlay"><span>⏳</span></div>}
                      <button className="msm-attach-image-remove" onClick={() => setAttachment(null)}>×</button>
                    </div>
                    <span className="msm-attach-image-name">{attachment.name}</span>
                  </div>
                ) : (
                  <div className="msm-attach-preview">
                    <span>{uploadingFile ? '⏳' : '📎'}</span>
                    <span className="msm-attach-preview-name">{attachment.name}</span>
                    {!uploadingFile && attachment.noTextExtracted && (
                      <span className="msm-attach-no-text-warning" title={t('msFileNoTextWarning', lang)}>
                        ⚠ {t('msFileNoTextWarning', lang)}
                      </span>
                    )}
                    <button className="msm-attach-remove" onClick={() => setAttachment(null)}>×</button>
                  </div>
                )
              )}
            </div>
          )}

          <div className="msm-input-bar">
            <div className="msm-input-plus" ref={popoverRef}>
              <button className={`msm-plus-btn ${popoverOpen ? 'active' : ''}`} onClick={() => setPopoverOpen(p => !p)}>+</button>
              {popoverOpen && (
                <div className="msm-popover">
                  <div className="msm-popover-section">
                    <div className="msm-popover-label">{t('msmModeLabel', lang)}</div>
                    <div className={`msm-popover-item ${chatMode === 'quick' ? 'selected' : ''}`} onClick={() => selectMode('quick')}>{t('msQuick', lang)} {chatMode === 'quick' && <span className="msm-popover-item-check">✓</span>}</div>
                    <div className="msm-popover-desc">{t('msmFastResponse', lang)}</div>
                    <div className={`msm-popover-item ${chatMode === 'deep' ? 'selected' : ''}`} onClick={() => selectMode('deep')}>{t('msDeep', lang)} {chatMode === 'deep' && <span className="msm-popover-item-check">✓</span>}</div>
                    <div className="msm-popover-desc">{t('msmDeepResearch', lang)}</div>
                  </div>
                  <div className="msm-popover-section">
                    <div className="msm-popover-label">{t('msDirectTo', lang)}</div>
                    <div className="msm-popover-item" onClick={() => insertMention('@Aksel')}>@Aksel</div>
                    <div className="msm-popover-item" onClick={() => insertMention('@Vera')}>@Vera</div>
                  </div>
                  <div className="msm-popover-section">
                    <div className="msm-popover-label">{t('msLanguagePopover', lang)}</div>
                    <div className="msm-popover-item" onClick={() => { setInput('/Mode Bahasa'); setPopoverOpen(false); inputRef.current?.focus(); }}>/Mode Bahasa</div>
                    <div className="msm-popover-item" onClick={() => { setInput('/English Mode'); setPopoverOpen(false); inputRef.current?.focus(); }}>/English Mode</div>
                  </div>
                </div>
              )}
            </div>
            <button className="msm-attach-btn" onClick={() => fileRef.current?.click()} disabled={uploadingFile}>
              {uploadingFile ? '⏳' : '⎙'}
            </button>
            <input ref={fileRef} type="file"
              accept=".txt,.md,.csv,.json,.js,.ts,.py,.pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp"
              style={{ display: 'none' }} onChange={handleFileSelect}/>
            <span className={`msm-mode-badge ${chatMode}`}>{chatMode}</span>
            <textarea ref={inputRef} className="msm-input"
              placeholder={t('msmInputPlaceholder', lang)}
              value={input} rows={1}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} onPaste={handlePaste}
              disabled={loading}/>
            <button className="msm-voice-btn" onClick={() => setVoiceCallOpen(true)}>
              🎙
            </button>
            <button className="msm-send-btn" onClick={handleSend}
              disabled={(!input.trim() && !attachment && !pastedContent) || loading || uploadingFile}>
              {loading ? '···' : '↑'}
            </button>
          </div>
        </div>

        {/* ── INTEL ── */}
        <div className={`msm-tab-pane ${activeTab === 'intel' ? 'active' : ''}`}>
          <div className="msm-filter-bar">
            {ALL_CATEGORIES.map(cat => (
              <button key={cat} className={`msm-filter-btn ${activeFilter === cat ? 'active' : ''}`}
                onClick={() => { setActiveFilter(cat); loadMacroNews(cat); }}>
                {cat}
              </button>
            ))}
          </div>
          <div className="msm-feed">
            {macroLoading
              ? <div className="msm-feed-loading">{t('msmLoadingShort', lang)}</div>
              : filteredMacro.length > 0 ? filteredMacro.map(renderNewsItem)
              : <div className="msm-feed-loading">{t('msmNoItemsShort', lang)}</div>}
          </div>
        </div>

        {/* ── RADAR ── */}
        <div className={`msm-tab-pane ${activeTab === 'radar' ? 'active' : ''}`}>
          <div className="msm-panel-header">
            <span className="msm-panel-title">{t('msMicroRadarTitle', lang)}</span>
            <button className="msm-refresh-btn" onClick={loadRadarNews}>↻</button>
          </div>
          <div className="msm-feed" style={{ flex: 'none' }}>
            {radarLoading
              ? <div className="msm-feed-loading">{t('msLoadingRadar', lang)}</div>
              : radarNews.slice(0, 6).map(renderNewsItem)}
          </div>
          {!showSourceForm
            ? <button className="msm-add-source-btn" onClick={() => setShowSourceForm(true)}>{t('msAddRssSource', lang)}</button>
            : <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <input style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12px', padding: '7px 10px', outline: 'none', fontFamily: 'var(--font-mono)' }}
                  placeholder={t('msSourceNamePh', lang)} value={sourceName} onChange={e => setSourceName(e.target.value)}/>
                <input style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '12px', padding: '7px 10px', outline: 'none', fontFamily: 'var(--font-mono)' }}
                  placeholder={t('msRssUrlPh', lang)} value={sourceUrl} onChange={e => setSourceUrl(e.target.value)}/>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={handleAddSource} style={{ flex: 1, padding: '6px', background: 'none', border: '1px solid var(--cyan)', color: 'var(--cyan)', fontSize: '10px', fontFamily: 'var(--font-mono)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{t('msAdd', lang)}</button>
                  <button onClick={() => { setShowSourceForm(false); setSourceName(''); setSourceUrl(''); }} style={{ padding: '6px 10px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '10px', fontFamily: 'var(--font-mono)', cursor: 'pointer', textTransform: 'uppercase' }}>{t('msCancel', lang)}</button>
                </div>
              </div>
          }
          <div style={{ height: '12px' }}/>
        </div>

        {/* ── LEDGER ── */}
        <div className={`msm-tab-pane ${activeTab === 'ledger' ? 'active' : ''}`}>
          <div className="msm-panel-header">
            <span className="msm-panel-title">{t('msLedgerTitle', lang)}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button className="msm-widget-nav-btn" onClick={() => setWidgetIdx(i => Math.max(0, i - 1))} disabled={widgetIdx === 0}>‹</button>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {activeWidgetIds.map((_, i) => (
                  <div key={i}
                    onClick={() => setWidgetIdx(i)}
                    style={{ width: '5px', height: '5px', background: widgetIdx === i ? 'var(--cyan)' : 'var(--border-strong)', cursor: 'pointer' }}
                  />
                ))}
              </div>
              <button className="msm-widget-nav-btn" onClick={() => setWidgetIdx(i => Math.min(activeWidgetIds.length - 1, i + 1))} disabled={widgetIdx >= activeWidgetIds.length - 1}>›</button>
            </div>
          </div>

          <div style={{ padding: '14px 14px 10px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {renderWidget(activeWidgetIds[widgetIdx])}
          </div>

          {/* Manage widgets */}
          <div style={{ position: 'relative', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <button
              className="msm-add-source-btn"
              onClick={() => setWidgetMgrOpen(p => !p)}
              style={{ width: '100%', textAlign: 'left' }}
            >
              {t('msManageWidgets', lang)}
            </button>
            {widgetMgrOpen && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 30 }}
                  onClick={() => setWidgetMgrOpen(false)}
                />
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0,
                  background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
                  zIndex: 31, boxShadow: '0 -8px 24px rgba(0,0,0,0.5)',
                }}>
                  <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: '8px', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    {t('msWidgetsToggleHint', lang)}
                  </div>
                  {getWidgetMeta(lang === 'id' ? 'id' : 'en').map(w => (
                    <div
                      key={w.id}
                      onClick={() => toggleWidget(w.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      <div style={{
                        width: '14px', height: '14px', border: `1px solid ${activeWidgetIds.includes(w.id) ? 'var(--cyan)' : 'var(--border-strong)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '9px', color: 'var(--cyan)', flexShrink: 0,
                      }}>
                        {activeWidgetIds.includes(w.id) ? '✓' : ''}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '10px', letterSpacing: '0.08em', color: 'var(--text-primary)', textTransform: 'uppercase' }}>{w.title}</div>
                        <div style={{ fontSize: '8px', color: 'var(--text-dim)', letterSpacing: '0.04em' }}>{w.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

      </div>

      {/* Bottom nav */}
      <nav className="msm-bottom-nav">
        <button className={`msm-nav-btn ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>
          <span className="msm-tab-icon">◉</span>{t('msTabChat', lang)}
        </button>
        <button className={`msm-nav-btn ${activeTab === 'intel' ? 'active' : ''}`} onClick={() => setActiveTab('intel')}>
          <span className="msm-tab-icon">◈</span>{t('msTabIntel', lang)}
        </button>
        <button className={`msm-nav-btn ${activeTab === 'radar' ? 'active' : ''}`} onClick={() => setActiveTab('radar')}>
          <span className="msm-tab-icon">◎</span>{t('msTabRadar', lang)}
        </button>
        <button className={`msm-nav-btn ${activeTab === 'ledger' ? 'active' : ''}`} onClick={() => setActiveTab('ledger')}>
          <span className="msm-tab-icon">◧</span>{t('msTabLedger', lang)}
        </button>
        <button className="msm-nav-btn" onClick={() => setMenuOpen(true)}>
          <span className="msm-tab-icon">≡</span>{t('msmMenuTab', lang)}
        </button>
      </nav>

      {/* Menu sheet backdrop */}
      <div className={`msm-sheet-backdrop ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}/>

      {/* Menu sheet */}
      <div className={`msm-menu-sheet ${menuOpen ? 'open' : ''}`}>
        <div className="msm-sheet-handle"><div className="msm-sheet-handle-bar"/></div>
        <div className="msm-sheet-label">{t('msmNavigation', lang)}</div>
        <div className="msm-sheet-items">

          <div className="msm-sheet-item" onClick={() => { setActiveView('archive'); setMenuOpen(false); }}>
            <div className="msm-sheet-item-icon" style={{ borderColor: memPendingCount > 0 ? 'var(--amber)' : undefined }}>◫</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name" style={{ color: memPendingCount > 0 ? 'var(--amber)' : undefined }}>{t('msmArchive', lang)}</div>
              <div className="msm-sheet-item-desc">
                {memPendingCount > 0 ? t('msmArchiveDescPending', lang, { n: memPendingCount }) : t('msmArchiveDesc', lang)}
              </div>
            </div>
            {memPendingCount > 0
              ? <div className="msm-mem-pending-dot"/>
              : <span className="msm-sheet-item-arrow">›</span>
            }
          </div>

          <div className="msm-sheet-item" onClick={() => { setActiveView('settings'); setMenuOpen(false); }}>
            <div className="msm-sheet-item-icon">◈</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name">{t('msmSettings', lang)}</div>
              <div className="msm-sheet-item-desc">{t('msmSettingsDesc', lang)}</div>
            </div>
            <span className="msm-sheet-item-arrow">›</span>
          </div>

          <div className="msm-sheet-item" onClick={() => { setSupportOpen(true); setMenuOpen(false); }}>
            <div className="msm-sheet-item-icon">✉</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name">{t('msNavContactSupport', lang)}</div>
              <div className="msm-sheet-item-desc">{t('msmContactDesc', lang)}</div>
            </div>
            <span className="msm-sheet-item-arrow">›</span>
          </div>

          <div className="msm-sheet-item" onClick={handleGroupChatNavClick}>
            <div className="msm-sheet-item-icon">⚏</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name">{t('msmGroupChat', lang)}</div>
              <div className="msm-sheet-item-desc">{t('msmGroupChatDesc', lang)}</div>
            </div>
            <span className="msm-sheet-item-arrow">›</span>
          </div>

          <div className="msm-sheet-item" onClick={() => { setVoiceCallOpen(true); setMenuOpen(false); }}>
            <div className="msm-sheet-item-icon">🎙</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name">{t('msmVoiceCall', lang)}</div>
              <div className="msm-sheet-item-desc">{t('msmVoiceCallDesc', lang)}</div>
            </div>
            <span className="msm-sheet-item-arrow">›</span>
          </div>

          {(localProfile.role === 'admin' || localProfile.role === 'owner') && (
            <div className="msm-sheet-item" onClick={() => { setAdminOpen(true); setMenuOpen(false); }}>
              <div className="msm-sheet-item-icon" style={{ borderColor: 'var(--cyan-dim)' }}>⬡</div>
              <div className="msm-sheet-item-text">
                <div className="msm-sheet-item-name" style={{ color: 'var(--cyan)' }}>{t('msNavAdminTerminal', lang)}</div>
                <div className="msm-sheet-item-desc">{t('msmAdminDesc', lang)}</div>
              </div>
              <span className="msm-sheet-item-arrow" style={{ color: 'var(--cyan)' }}>›</span>
            </div>
          )}

          <div className="msm-sheet-item" onClick={async () => { setMenuOpen(false); await handleSignOut(); }}>
            <div className="msm-sheet-item-icon">↩</div>
            <div className="msm-sheet-item-text">
              <div className="msm-sheet-item-name" style={{ color: 'var(--red)' }}>{t('msSignOut', lang)}</div>
              <div className="msm-sheet-item-desc">{localProfile.display_name || 'Agent'}</div>
            </div>
          </div>

        </div>
        <div style={{ height: '12px' }}/>
      </div>

        {/* ── Idle overlay ── */}
        <IdleOverlay timeout={5 * 60 * 1000} />

        {/* ── Contact Support popup — floats above whatever tab is open ── */}
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

        {voiceCallOpen && (
          <VoiceCallMobile profile={localProfile} onClose={() => setVoiceCallOpen(false)} />
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