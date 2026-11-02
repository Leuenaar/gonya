import { useState, useRef, useEffect } from 'react';
import { type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import { useGroupMessages, type GroupMessage as GroupMessageType } from '../hooks/useGroupMessages';
import GroupMessage from './GroupMessage';
import GroupMembersPanel from './GroupMembersPanel';
import GroupMemoriesPanel from './GroupMemoriesPanel';
import GroupSettingsPanel from './GroupSettingsPanel';
import './GroupChat.css';

interface Props {
  groupId:   string;
  groupName: string;
  myRole:    string;
  profile:   UserProfile;
  onBack:    () => void;
}

export default function GroupChat({ groupId, groupName, myRole, profile, onBack }: Props) {
  const {
    messages, loading, error, sendMessage,
    connectionError,
    typingUserIds, notifyTyping,
    onlineUserIds,
    sendReaction,
    deleteMessage,
    catchUp,
  } = useGroupMessages({ groupId });

  const [input,        setInput]        = useState('');
  const [pendingFile,     setPendingFile]     = useState<File | null>(null);
  const [filePreviewUrl,  setFilePreviewUrl]  = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending,      setSending]      = useState(false);
  const [sendError,    setSendError]    = useState('');
  const [replyTo,      setReplyTo]      = useState<GroupMessageType | null>(null);
  const [membersOpen,  setMembersOpen]  = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [catchUpOpen,    setCatchUpOpen]    = useState(false);
  const [catchUpLoading, setCatchUpLoading] = useState(false);
  const [catchUpSummary, setCatchUpSummary] = useState('');
  const [catchUpError,   setCatchUpError]   = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);
  const messageRefs   = useRef<Record<string, HTMLDivElement | null>>({});
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Clear any pending highlight timer on unmount, so it never fires
  // setState after the component is gone.
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  // Scrolls to and briefly highlights the message a reply preview points
  // to. Silently does nothing if that message isn't currently rendered
  // (e.g. it's outside the loaded page of history) — jumping to content
  // that isn't on screen isn't possible without also building pagination
  // fetch-and-scroll, which is out of scope here.
  const jumpToMessage = (id: string) => {
    const el = messageRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedId(id);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 1500);
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !pendingFile) || sending) return;
    setSending(true);
    setSendError('');
    try {
      await sendMessage(text, replyTo?.id, pendingFile || undefined);
      setInput('');
      setReplyTo(null);
      clearPendingFile();
    } catch (err: any) {
      setSendError(err.message || t('sendFailed', profile.language));
    } finally {
      setSending(false);
    }
  };

  // ── Attachment picker ──────────────────────────────────────────────────
  // Preview-before-send with a remove option — standard chat-app convention
  // (confirmed via research, 27 Jul 2026), not a Gonya-specific invention.
  const clearPendingFile = () => {
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setPendingFile(null);
    setFilePreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setPendingFile(file);
    setFilePreviewUrl(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleCatchUp = async () => {
    setCatchUpOpen(true);
    setCatchUpLoading(true);
    setCatchUpError('');
    try {
      const summary = await catchUp();
      setCatchUpSummary(summary);
    } catch (err: any) {
      setCatchUpError(err.message || t('catchUpFailed', profile.language));
    } finally {
      setCatchUpLoading(false);
    }
  };

  // Build a map of id→message for reply preview lookup
  const msgMap = Object.fromEntries(messages.map(m => [m.id, m]));

  // Is the last message an agent still typing? Show typing dots if it
  // arrived < 100ms ago (optimistic — Realtime delivers fast enough).
  // This heuristic covers AGENTS specifically, since the backend doesn't
  // (yet) broadcast real typing events for Aksel/Vera — that's a natural
  // follow-up once the agent pipeline emits its own 'typing' broadcast.
  const lastMsg  = messages[messages.length - 1];
  const agentTyping = lastMsg?.sender_type !== 'user' &&
    (Date.now() - new Date(lastMsg?.created_at || 0).getTime()) < 800;

  // Best-effort id→name lookup for the HUMAN typing indicator, built from
  // messages we've already loaded — avoids a separate roster fetch just for
  // this. Falls back to "Someone" for a member who is typing but hasn't
  // sent a message in this group yet (e.g. right after joining).
  const nameById: Record<string, string> = { aksel: 'Aksel', vera: 'Vera' };
  messages.forEach(m => { if (m.sender_id && m.sender_name) nameById[m.sender_id] = m.sender_name; });
  const typingNames = typingUserIds.map(id => nameById[id] || 'Someone');
  const typingLabel =
    typingNames.length === 0 ? '' :
    typingNames.length === 1 ? t('typingOne', profile.language, { name: typingNames[0] }) :
    typingNames.length === 2 ? t('typingTwo', profile.language, { name1: typingNames[0], name2: typingNames[1] }) :
    t('typingMany', profile.language, { count: typingNames.length });

  return (
    <div className="gc-root">

      {/* ── Header ── */}
      <header className="gc-header">
        <button className="gc-back" onClick={onBack} aria-label="Back">‹</button>
        <div className="gc-header-info">
          <span className="gc-group-name">{groupName}</span>
          <span className="gc-group-status">
            {t('groupChatLabel', profile.language)}
            {onlineUserIds.length > 0 && (
              <span className="gc-online-badge">
                <span className="gc-online-dot" />
                {onlineUserIds.length} {t('onlineCount', profile.language)}
              </span>
            )}
          </span>
        </div>
        <button className="gc-catchup-btn" onClick={handleCatchUp}>{t('catchMeUpBtn', profile.language)}</button>
        {(myRole === 'owner' || myRole === 'co_admin') && (
          <button className="gc-memories-btn" onClick={() => setMemoriesOpen(true)}>{t('groupMemoriesBtn', profile.language)}</button>
        )}
        {(myRole === 'owner' || myRole === 'co_admin') && (
          <button className="gc-settings-btn" onClick={() => setSettingsOpen(true)}>{t('groupSettingsBtn', profile.language)}</button>
        )}
        <button className="gc-members-btn" onClick={() => setMembersOpen(true)}>{t('membersBtn', profile.language)}</button>
      </header>

      {catchUpOpen && (
        <div className="gc-catchup-overlay" onClick={() => setCatchUpOpen(false)}>
          <div className="gc-catchup-modal" onClick={e => e.stopPropagation()}>
            <div className="gc-catchup-modal-header">
              <span>{t('catchMeUpBtn', profile.language)}</span>
              <button className="gc-catchup-close" onClick={() => setCatchUpOpen(false)} aria-label="Close">×</button>
            </div>
            {catchUpLoading && <p className="gc-catchup-status">{t('catchUpReading', profile.language)}</p>}
            {catchUpError && <p className="gc-catchup-status gc-catchup-error">&gt; {catchUpError}</p>}
            {!catchUpLoading && !catchUpError && (
              <p className="gc-catchup-summary">{catchUpSummary}</p>
            )}
          </div>
        </div>
      )}

      {connectionError && (
        <div className="gc-connection-banner">&gt; {connectionError}</div>
      )}

      {membersOpen && (
        <GroupMembersPanel groupId={groupId} myRole={myRole} onClose={() => setMembersOpen(false)} onGroupDeleted={onBack} lang={profile.language} />
      )}

      {memoriesOpen && (
        <GroupMemoriesPanel groupId={groupId} onClose={() => setMemoriesOpen(false)} lang={profile.language} />
      )}

      {settingsOpen && (
        <GroupSettingsPanel groupId={groupId} onClose={() => setSettingsOpen(false)} lang={profile.language} />
      )}

      {/* ── Message log ── */}
      <main className="gc-log">
        {loading && <div className="gc-empty">{t('loadingMessages', profile.language)}</div>}
        {error   && <div className="gc-empty gc-empty-err">&gt; {error}</div>}
        {!loading && !error && messages.length === 0 && (
          <div className="gc-empty">{t('noMessagesYet', profile.language)}</div>
        )}

        {messages.map(msg => (
          <GroupMessage
            key={msg.id}
            ref={el => { messageRefs.current[msg.id] = el; }}
            message={msg}
            isOwn={msg.sender_id === profile.id}
            replyTarget={msg.reply_to ? msgMap[msg.reply_to] || null : null}
            onReply={setReplyTo}
            onJumpToReply={jumpToMessage}
            highlighted={highlightedId === msg.id}
            onReact={(messageId, emoji) => {
              // Fire-and-forget from the UI's perspective — the actual
              // add/replace/remove state comes back via the
              // reaction_added/reaction_removed broadcast the hook already
              // listens for, same "server confirms" pattern as sendMessage.
              sendReaction(messageId, emoji).catch(err => console.error('[GroupChat] reaction failed:', err.message));
            }}
            currentUserId={profile.id}
            lang={profile.language}
            onDelete={(messageId) => {
              // Same fire-and-forget pattern — the tombstone state comes
              // back via the 'message_deleted' broadcast the hook already
              // listens for.
              deleteMessage(messageId).catch(err => console.error('[GroupChat] delete failed:', err.message));
            }}
          />
        ))}

        {agentTyping && (
          <div className="gc-typing">
            <span /><span /><span />
          </div>
        )}

        {typingLabel && (
          <div className="gc-typing gc-typing-human">
            <span /><span /><span />
            <span className="gc-typing-label">{typingLabel}</span>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {/* ── Reply banner ── */}
      {replyTo && (
        <div className="gc-reply-bar">
          <span className="gc-reply-to-name">↩ {replyTo.sender_name || 'Member'}</span>
          <span className="gc-reply-to-content">{replyTo.content.slice(0, 60)}{replyTo.content.length > 60 ? '…' : ''}</span>
          <button className="gc-reply-cancel" onClick={() => setReplyTo(null)}>×</button>
        </div>
      )}

      {/* ── Input ── */}
      <footer className="gc-footer">
        {sendError && <p className="gc-send-err">&gt; {sendError}</p>}

        {pendingFile && (
          <div className="gc-file-preview">
            {filePreviewUrl ? (
              <img src={filePreviewUrl} alt={pendingFile.name} className="gc-file-preview-thumb" />
            ) : (
              <span className="gc-file-preview-icon">📄</span>
            )}
            <span className="gc-file-preview-name">{pendingFile.name}</span>
            <button className="gc-file-preview-remove" onClick={clearPendingFile} aria-label="Remove attachment">×</button>
          </div>
        )}

        <div className="gc-input-row">
          <input
            ref={fileInputRef}
            type="file"
            className="gc-file-input"
            onChange={handleFileSelect}
            disabled={sending}
          />
          <button
            className="gc-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Attach file"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            className="gc-input"
            value={input}
            onChange={e => { setInput(e.target.value); setSendError(''); notifyTyping(); }}
            onKeyDown={handleKeyDown}
            placeholder={t('messageInputPlaceholder', profile.language)}
            rows={1}
            disabled={sending}
          />
          <button
            className="gc-send-btn"
            onClick={handleSend}
            disabled={sending || (!input.trim() && !pendingFile)}
          >
            {sending ? '...' : '↑'}
          </button>
        </div>
        <span className="gc-hint">{t('inputHint', profile.language)}</span>
      </footer>
    </div>
  );
}
