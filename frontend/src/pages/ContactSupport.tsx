import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import './ContactSupport.css';

interface Props {
  profile: UserProfile;
  onClose: () => void;
}

interface ChatMessage {
  sender:  'User' | 'Agent';
  content: string;
}

interface TicketResult {
  ticket_no:    string;
  confirmation: string;
}

type CardMode = 'feedback' | 'chat';

const POPUP_WIDTH  = 380;
const POPUP_HEIGHT = 520;

const getPopupWidth = () => Math.min(POPUP_WIDTH, window.innerWidth - 32);

export default function ContactSupport({ profile, onClose }: Props) {
  const lang = profile.language;

  const [mode, setMode] = useState<CardMode>('feedback');
  const [popupWidth] = useState(getPopupWidth);

  // ── Draggable popup position ────────────────────────────
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, window.innerWidth  - popupWidth   - 32),
    y: Math.max(70, window.innerHeight - POPUP_HEIGHT - 32),
  }));
  const dragRef = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false, offsetX: 0, offsetY: 0,
  });

  const clampPos = useCallback((x: number, y: number) => ({
    x: Math.min(Math.max(8, x), window.innerWidth  - 60),
    y: Math.min(Math.max(8, y), window.innerHeight - 40),
  }), []);

  const startDrag = (clientX: number, clientY: number) => {
    dragRef.current = { dragging: true, offsetX: clientX - pos.x, offsetY: clientY - pos.y };
  };
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cs-popup-close')) return;
    startDrag(e.clientX, e.clientY);
  };
  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('.cs-popup-close')) return;
    const touch = e.touches[0];
    startDrag(touch.clientX, touch.clientY);
  };

  useEffect(() => {
    const onMove = (clientX: number, clientY: number) => {
      if (!dragRef.current.dragging) return;
      setPos(clampPos(clientX - dragRef.current.offsetX, clientY - dragRef.current.offsetY));
    };
    const onMouseMove  = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const onTouchMove  = (e: TouchEvent) => { if (dragRef.current.dragging) onMove(e.touches[0].clientX, e.touches[0].clientY); };
    const stopDragging = () => { dragRef.current.dragging = false; };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', stopDragging);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', stopDragging);
    };
  }, [clampPos]);

  // ── Feedback form ──────────────────────────────────────
  const [fbSubject, setFbSubject] = useState('');
  const [fbMessage, setFbMessage] = useState('');
  const [fbLoading, setFbLoading] = useState(false);
  const [fbError,   setFbError]   = useState('');
  const [fbTicket,  setFbTicket]  = useState<TicketResult | null>(null);

  const handleFeedbackSubmit = async () => {
    if (!fbSubject.trim() || !fbMessage.trim()) {
      setFbError(t('csSubjectRequired', lang));
      return;
    }
    setFbLoading(true);
    setFbError('');
    try {
      const res = await apiFetch('/api/feedback', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ subject: fbSubject.trim(), message: fbMessage.trim() }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed to send');
      setFbTicket({ ticket_no: data.ticket_no, confirmation: data.confirmation });
      setFbSubject('');
      setFbMessage('');
    } catch (err: any) {
      setFbError(err?.message || t('csFailedToSend', lang));
    } finally {
      setFbLoading(false);
    }
  };

  // ── Live chat with AI ───────────────────────────────────
  const [chatMessages,  setChatMessages]  = useState<ChatMessage[]>([]);
  const [chatInput,     setChatInput]     = useState('');
  const [chatLoading,   setChatLoading]   = useState(false);
  const [agentName,     setAgentName]     = useState<string | null>(null);
  const [chatTicket,    setChatTicket]    = useState<TicketResult | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const greetedRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages, chatLoading]);

  // Agent opens the conversation, live-support-widget style — fires once,
  // the first time Live Chat is opened.
  const fetchGreeting = async () => {
    if (greetedRef.current) return;
    greetedRef.current = true;
    setChatLoading(true);
    try {
      const res = await apiFetch('/api/feedback/support/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ history: [], greeting: true }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed');
      setAgentName(data.agentName);
      setChatMessages([{ sender: 'Agent', content: data.reply }]);
    } catch {
      // Silent — the input box still works, user can just type first
      greetedRef.current = false;
    } finally {
      setChatLoading(false);
    }
  };

  const enterChat = () => {
    setMode('chat');
    fetchGreeting();
  };

  const handleChatSend = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    const history    = chatMessages.map(m => ({ sender: m.sender, content: m.content }));
    const withUser   = [...chatMessages, { sender: 'User' as const, content: msg }];
    setChatMessages(withUser);
    setChatInput('');
    setChatLoading(true);
    try {
      const res = await apiFetch('/api/feedback/support/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ history, message: msg }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed');
      setAgentName(data.agentName);
      const withAgent = [...withUser, { sender: 'Agent' as const, content: data.reply }];
      setChatMessages(withAgent);
      // Thea/Theo decided the conversation is wrapping up — save it as a
      // ticket automatically, a beat after the closing message lands so
      // it's readable first.
      if (data.shouldEnd) {
        setTimeout(() => submitTranscript(withAgent), 1100);
      }
    } catch {
      setChatMessages(prev => [...prev, {
        sender:  'Agent',
        content: t('csChatError', lang),
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(); }
  };

  // Ending the chat isn't "sending it to a team" — it just wraps the
  // conversation into a ticket (random ticket number) that lands in Admin
  // Terminal, with a short email nudge (ticket number + subject only).
  // Takes the transcript explicitly rather than reading state, so it works
  // safely from a setTimeout (auto-close) without any stale-closure risk.
  const submitTranscript = async (transcript: ChatMessage[]) => {
    if (transcript.length === 0 || submitLoading) return;
    setSubmitLoading(true);
    try {
      const res = await apiFetch('/api/feedback/support/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Failed');
      setChatTicket({ ticket_no: data.ticket_no, confirmation: data.confirmation });
    } catch {
      setChatMessages(prev => [...prev, {
        sender:  'Agent',
        content: t('csFailedToSaveChat', lang),
      }]);
    } finally {
      setSubmitLoading(false);
    }
  };

  // Closing the popup mid-chat also saves it as a ticket — fire-and-forget,
  // doesn't block the close.
  const handlePopupClose = () => {
    if (mode === 'chat' && chatMessages.length > 0 && !chatTicket) {
      apiFetch('/api/feedback/support/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript: chatMessages }),
      }).catch(() => {});
    }
    onClose();
  };

  const startNewChat = () => {
    setChatTicket(null);
    setChatMessages([]);
    setAgentName(null);
    greetedRef.current = false;
    fetchGreeting();
  };

  return createPortal(
    <div className="cs-popup" style={{ left: pos.x, top: pos.y, width: popupWidth }}>
      <div
        className="cs-popup-header"
        onMouseDown={handleHeaderMouseDown}
        onTouchStart={handleHeaderTouchStart}
      >
        <span className="cs-popup-title-row">
          {mode === 'chat' && (
            <button className="cs-popup-back" onClick={() => setMode('feedback')} aria-label="Back">‹</button>
          )}
          <span className="cs-popup-title">{t('csTitle', lang)}</span>
        </span>
        <button className="cs-popup-close" onClick={handlePopupClose} aria-label="Close">×</button>
      </div>

      <div className="cs-popup-body">
        {mode === 'feedback' ? (
          fbTicket ? (
            <div className="cs-ticket-confirm">
              <span className="cs-ticket-no">{fbTicket.ticket_no}</span>
              <p className="cs-ticket-msg">{fbTicket.confirmation}</p>
              <button className="cs-link-btn" onClick={() => setFbTicket(null)}>
                {t('csSendAnother', lang)}
              </button>
            </div>
          ) : (
            <div className="cs-form">
              <div className="cs-field-group">
                <label className="cs-field-label">{t('csFieldSubject', lang)}</label>
                <input
                  className="cs-input"
                  value={fbSubject}
                  onChange={e => setFbSubject(e.target.value)}
                  placeholder={t('csPlaceholderSummary', lang)}
                  disabled={fbLoading}
                />
              </div>
              <div className="cs-field-group">
                <label className="cs-field-label">{t('csFieldMessage', lang)}</label>
                <textarea
                  className="cs-textarea"
                  value={fbMessage}
                  onChange={e => setFbMessage(e.target.value)}
                  placeholder={t('csPlaceholderDetail', lang)}
                  rows={5}
                  disabled={fbLoading}
                />
              </div>
              {fbError && <p className="cs-error">{fbError}</p>}
              <button className="cs-submit-btn" onClick={handleFeedbackSubmit} disabled={fbLoading}>
                {fbLoading ? t('csSending', lang) : t('csSendBtn', lang)}
              </button>

              <div className="cs-or-divider">
                <span className="cs-or-divider-line"/>
                <span className="cs-or-divider-text">{t('csOr', lang)}</span>
                <span className="cs-or-divider-line"/>
              </div>

              <button className="cs-live-chat-btn" onClick={enterChat}>
                <span className="cs-live-chat-icon">💬</span>
                {t('csLiveChatBtn', lang)}
              </button>
            </div>
          )
        ) : (
          chatTicket ? (
            <div className="cs-ticket-confirm">
              <span className="cs-ticket-no">{chatTicket.ticket_no}</span>
              <p className="cs-ticket-msg">{chatTicket.confirmation}</p>
              <button className="cs-link-btn" onClick={startNewChat}>
                {t('csStartNewChat', lang)}
              </button>
            </div>
          ) : (
            <>
              <div className="cs-chat-log">
                {chatMessages.map((m, i) => (
                  <div key={i} className={`cs-chat-msg ${m.sender === 'User' ? 'user' : 'agent'}`}>
                    <span className="cs-chat-sender">
                      {m.sender === 'User' ? t('csYou', lang) : (agentName || t('csAgent', lang))}
                    </span>
                    <p className="cs-chat-bubble">{m.content}</p>
                  </div>
                ))}
                {chatLoading && (
                  <div className="cs-chat-msg agent">
                    <span className="cs-chat-sender">{agentName || t('csAgent', lang)}</span>
                    <p className="cs-chat-bubble cs-chat-typing"><span/><span/><span/></p>
                  </div>
                )}
                <div ref={chatEndRef}/>
              </div>
              <div className="cs-chat-input-row">
                <textarea
                  className="cs-chat-input"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  placeholder={t('csWritePlaceholder', lang)}
                  rows={1}
                  disabled={chatLoading}
                />
                <button
                  className="cs-chat-send-btn"
                  onClick={handleChatSend}
                  disabled={chatLoading || !chatInput.trim()}
                >
                  {t('csSendBtn', lang)}
                </button>
              </div>
            </>
          )
        )}
      </div>
    </div>,
    document.body
  );
}
