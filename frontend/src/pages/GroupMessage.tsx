import { forwardRef, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { type GroupMessage as GroupMessageType } from '../hooks/useGroupMessages';
import { t } from '../lib/i18n';
import './GroupMessage.css';

// Fixed quick-reaction set (WhatsApp-style, not a free picker) — matches the
// CHECK constraint on group_message_reactions.emoji (Phase 8.7) and the
// backend's ALLOWED_EMOJI list, so a tap here is always accepted server-side.
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// How long a touch has to hold before it counts as a long-press, matching
// the interaction WhatsApp actually uses (confirmed via research, 25 Jul
// 2026) — long-press opens the SAME action menu on mobile that hovering +
// tapping the "⋮" dot opens on desktop, replacing the old three
// separately-hovered buttons (reply/react/delete), which only ever worked
// on mouse-based devices and had no real mobile equivalent.
const LONG_PRESS_MS = 500;

interface Props {
  message:        GroupMessageType;
  isOwn:          boolean;
  replyTarget?:   GroupMessageType | null;
  onReply:        (msg: GroupMessageType) => void;
  onJumpToReply?: (id: string) => void; // jump to the message this one is replying to
  highlighted?:   boolean;               // briefly true right after being jumped to
  onReact?:       (messageId: string, emoji: string) => void;
  currentUserId?: string;                // used to highlight "my" reaction and detect toggle-off
  onDelete?:      (messageId: string) => void; // only ever shown for the sender's own message
  lang?:          string | null;         // drives translated UI text (Fase 8) — profile.language, passed down from GroupChat
}

const AGENT_COLORS: Record<string, string> = {
  aksel: 'var(--amber)',
  vera:  'var(--purple)',
};

const GroupMessage = forwardRef<HTMLDivElement, Props>(function GroupMessage(
  { message, isOwn, replyTarget, onReply, onJumpToReply, highlighted, onReact, currentUserId, onDelete, lang },
  ref
) {
  const [menuOpen, setMenuOpen]             = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isDeleted = !!message.deleted_at;

  // ── Menu positioning (portal-based, 22 Aug 2026) ───────────────────────
  // The menu used to be `position: absolute` inside .gm-row, which lives
  // inside the scrollable message list — so a message near the top/bottom
  // edge of that scroll container had its menu visibly clipped. Rendering
  // it into a portal at document.body with `position: fixed`, positioned
  // from real screen coordinates, fixes that regardless of where the
  // triggering message sits in the scroll area. menuReady stays false
  // until the menu's actual rendered size is measured (useLayoutEffect
  // below), so the very first frame doesn't flash at an unclamped
  // position before flip/clamp math has run.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [menuReady, setMenuReady] = useState(false);
  const portalMenuRef = useRef<HTMLDivElement>(null);

  const openMenuAt = (x: number, y: number) => {
    setMenuPos({ x, y });
    setMenuReady(false);
    setMenuOpen(true);
  };

  // ── Swipe-to-reply (touch only) ────────────────────────────────────────
  // Reuses the SAME onReply(message) call the "⋮ → Reply" menu item
  // already triggers — this is just a second way to reach an action that
  // already fully works end-to-end (data model, backend, preview
  // rendering), not a new reply system.
  const SWIPE_COMMIT_PX = 56;         // horizontal distance that counts as "committed" to reply
  const SWIPE_MAX_PX    = 80;         // visual cap so the bubble can't be dragged off-screen
  const SWIPE_MOVE_THRESHOLD_PX = 10; // below this, a touch is still an undecided tap/long-press candidate
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [dragging,    setDragging]    = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipingRef    = useRef(false); // true once THIS touch sequence has committed to being a swipe, not a tap/long-press/scroll

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAgent  = message.sender_type !== 'user';
  const color    = isAgent ? AGENT_COLORS[message.sender_type] : undefined;
  const name     = message.sender_name || (isAgent ? message.sender_type : 'Member');

  const fmtTime  = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Attachment (Phase 8.11) — one per message for now, matching the
  // one-attachment-per-bubble convention most chat apps use. Image-vs-file
  // and caption-vs-no-caption presentation follows researched WhatsApp/
  // Telegram behavior: an image with no caption fills the bubble (time
  // overlaid), an image WITH a caption shows the text below it, and a
  // non-image file always renders as an icon+filename card, never an
  // inline preview.
  const attachment  = message.group_message_attachments?.[0];
  const isImage     = attachment?.file_type?.startsWith('image/') ?? false;
  const hasCaption  = message.content.trim().length > 0;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Group individual reaction rows by emoji for the chip display — several
  // people can share the same emoji on one message (each still capped at
  // ONE active reaction per person, enforced server-side).
  const reactionGroups: Record<string, { count: number; mine: boolean; names: string[] }> = {};
  (message.group_message_reactions || []).forEach(r => {
    const g = reactionGroups[r.emoji] || { count: 0, mine: false, names: [] };
    g.count += 1;
    g.names.push(r.sender_name || r.sender_type);
    if (currentUserId && r.sender_id === currentUserId) g.mine = true;
    reactionGroups[r.emoji] = g;
  });
  const reactionEntries = Object.entries(reactionGroups);

  const closeMenu = () => { setMenuOpen(false); setConfirmingDelete(false); };

  const handleReactPick = (emoji: string) => {
    onReact?.(message.id, emoji);
    closeMenu();
  };
  const handleReplyPick = () => {
    onReply(message);
    closeMenu();
  };
  const handleDeleteConfirm = () => {
    onDelete?.(message.id);
    closeMenu();
  };

  const handleJumpKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && replyTarget && onJumpToReply) {
      e.preventDefault();
      onJumpToReply(replyTarget.id);
    }
  };

  // ── Long-press detection (mobile) ─────────────────────────────────────────
  // Starts a timer on touch-down; a move or early lift cancels it (so
  // scrolling the log never accidentally opens the menu). Firing the timer
  // opens the exact same menu the desktop "⋮" dot opens.
  const clearLongPressTimer = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const handleTouchStart = (e: React.TouchEvent) => {
    if (isDeleted) return;
    clearLongPressTimer();
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    swipingRef.current = false;
    longPressTimer.current = setTimeout(
      () => openMenuAt(touch.clientX, touch.clientY),
      LONG_PRESS_MS
    );
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    if (!swipingRef.current) {
      // Undecided so far — the first clear movement decides whether this
      // touch sequence is a rightward reply-swipe, or something else
      // (vertical scroll, leftward drag, or a stationary long-press that
      // should keep counting down).
      if (Math.abs(dx) > SWIPE_MOVE_THRESHOLD_PX || Math.abs(dy) > SWIPE_MOVE_THRESHOLD_PX) {
        if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          swipingRef.current = true;
          setDragging(true);
          clearLongPressTimer(); // a swipe and a long-press can't both be happening at once
        } else {
          // Vertical scroll or a leftward move — not a reply swipe. Stop
          // tracking this touch sequence entirely (matches the previous
          // behavior: any non-swipe movement cancels the long-press too).
          clearLongPressTimer();
          touchStartRef.current = null;
        }
      }
      return;
    }

    setSwipeOffset(Math.max(0, Math.min(dx, SWIPE_MAX_PX)));
  };

  const handleTouchEnd = () => {
    clearLongPressTimer();
    if (swipingRef.current && swipeOffset >= SWIPE_COMMIT_PX) {
      onReply(message);
    }
    setDragging(false);
    setSwipeOffset(0);
    swipingRef.current = false;
    touchStartRef.current = null;
  };

  // ── Right-click (desktop) ───────────────────────────────────────────────
  // Opens the SAME menu the "⋮" dot and long-press already open — added
  // per explicit request (22 Aug 2026) as the primary desktop trigger,
  // since hunting for the small hover-only dot wasn't great. The dot stays
  // too, both as a visible affordance for people who don't know to
  // right-click and as the touch fallback's visual hint.
  const handleContextMenu = (e: React.MouseEvent) => {
    if (isDeleted) return;
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY);
  };

  // Click-outside closes the menu, matching standard menu/popover behavior.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (portalMenuRef.current && !portalMenuRef.current.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Measures the menu's actual rendered size (varies with confirm-delete
  // state, so this re-runs whenever that toggles too) and clamps it to
  // stay inside the viewport — shifted left/right horizontally, flipped
  // to open ABOVE the anchor point instead of below if there isn't room
  // underneath. Runs synchronously before paint (useLayoutEffect) so
  // there's no visible jump from an initial guess to the final spot.
  useLayoutEffect(() => {
    if (!menuOpen || !menuPos || !portalMenuRef.current) return;
    const menuEl = portalMenuRef.current;
    const rect = menuEl.getBoundingClientRect();
    const PADDING = 8;

    let x = menuPos.x;
    let y = menuPos.y;

    if (x + rect.width > window.innerWidth - PADDING) x = window.innerWidth - rect.width - PADDING;
    if (x < PADDING) x = PADDING;

    if (y + rect.height > window.innerHeight - PADDING) {
      const flippedY = y - rect.height;
      y = flippedY >= PADDING ? flippedY : PADDING;
    }
    if (y < PADDING) y = PADDING;

    menuEl.style.left = `${x}px`;
    menuEl.style.top  = `${y}px`;
    setMenuReady(true);
  }, [menuOpen, menuPos, confirmingDelete]);

  return (
    <div
      ref={ref}
      className={`gm-row ${isOwn ? 'gm-own' : ''} ${isAgent ? 'gm-agent' : ''} ${highlighted ? 'gm-highlight' : ''}`}
    >

      {/* Sender badge */}
      <div className="gm-badge" style={color ? { color, borderColor: color } : undefined}>
        {name.charAt(0).toUpperCase()}
      </div>

      <div className="gm-body">
        <div className="gm-meta">
          <span className="gm-name" style={color ? { color } : undefined}>{name}</span>
          <span className="gm-time">{fmtTime(message.created_at)}</span>
        </div>

        {/* Reply preview — clicking it jumps to (and briefly highlights) the
            original message. A reply target that isn't currently loaded
            (e.g. paginated out) is a silent no-op — see jumpToMessage in
            GroupChat.tsx. */}
        {replyTarget && (
          <div
            className="gm-reply-preview"
            onClick={() => onJumpToReply?.(replyTarget.id)}
            onKeyDown={handleJumpKeyDown}
            role={onJumpToReply ? 'button' : undefined}
            tabIndex={onJumpToReply ? 0 : undefined}
          >
            <span className="gm-reply-name">{replyTarget.sender_name || 'Member'}</span>
            <span className="gm-reply-content">
              {replyTarget.deleted_at
                ? t('messageDeleted', lang)
                : `${replyTarget.content.slice(0, 80)}${replyTarget.content.length > 80 ? '…' : ''}`}
            </span>
          </div>
        )}

        {isDeleted ? (
          <p className="gm-content gm-content-deleted">{t('messageDeleted', lang)}</p>
        ) : (
          <div
            className="gm-content-wrap"
            style={{ transform: `translateX(${swipeOffset}px)`, transition: dragging ? 'none' : undefined }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
            onContextMenu={handleContextMenu}
          >
            {swipeOffset > 0 && (
              <span
                className="gm-swipe-reply-icon"
                style={{ opacity: Math.min(swipeOffset / SWIPE_COMMIT_PX, 1) }}
              >
                ↩
              </span>
            )}
            {message.pendingAttachment && !attachment && (
              <div className="gm-attachment-uploading">📎 Uploading...</div>
            )}

            {attachment && isImage && (
              <div className={`gm-image-attachment ${hasCaption ? '' : 'gm-image-only'}`}>
                <img src={attachment.url || ''} alt={attachment.file_name} className="gm-image-attachment-img" />
                {!hasCaption && <span className="gm-image-overlay-time">{fmtTime(message.created_at)}</span>}
              </div>
            )}

            {attachment && !isImage && (
              <a
                href={attachment.url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="gm-file-attachment"
              >
                <span className="gm-file-attachment-icon">📄</span>
                <div className="gm-file-attachment-info">
                  <span className="gm-file-attachment-name">{attachment.file_name}</span>
                  <span className="gm-file-attachment-size">{formatSize(attachment.size_bytes)}</span>
                </div>
              </a>
            )}

            {(hasCaption || !attachment) && (
              <p className="gm-content">{message.content}</p>
            )}

            {reactionEntries.length > 0 && (
              <div className="gm-reactions-row">
                {reactionEntries.map(([emoji, info]) => (
                  <button
                    key={emoji}
                    className={`gm-reaction-chip ${info.mine ? 'gm-reaction-mine' : ''}`}
                    onClick={() => onReact?.(message.id, emoji)}
                    title={info.names.join(', ')}
                  >
                    {emoji} {info.count}
                  </button>
                ))}
              </div>
            )}

            {/* Single trigger for the whole action menu — hover-revealed on
                desktop, always-present-at-low-opacity on touch screens
                where hover doesn't exist (long-pressing the bubble above
                does the same job without needing to find this dot at all).
                Right-click (handleContextMenu above) is the primary
                desktop trigger now; this dot remains as a visible,
                discoverable fallback. */}
            <button
              className="gm-more-btn"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                openMenuAt(rect.left, rect.bottom + 4);
              }}
              aria-label="More options"
              aria-expanded={menuOpen}
            >
              ⋮
            </button>

            {menuOpen && createPortal(
              <div
                className="gm-action-menu"
                role="menu"
                ref={portalMenuRef}
                style={{ visibility: menuReady ? 'visible' : 'hidden' }}
              >
                {!confirmingDelete ? (
                  <>
                    <div className="gm-action-menu-emojis">
                      {REACTION_EMOJI.map(e => (
                        <button
                          key={e}
                          className="gm-action-emoji-btn"
                          onClick={() => handleReactPick(e)}
                          aria-label={`React with ${e}`}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                    <button className="gm-action-menu-item" onClick={handleReplyPick}>
                      ↩ {t('replyAction', lang)}
                    </button>
                    {isOwn && onDelete && (
                      <button
                        className="gm-action-menu-item gm-action-menu-danger"
                        onClick={() => setConfirmingDelete(true)}
                      >
                        🗑 {t('deleteAction', lang)}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="gm-action-menu-confirm">
                    <span className="gm-delete-confirm-text">{t('deleteConfirmText', lang)}</span>
                    <button className="gm-delete-confirm-yes" onClick={handleDeleteConfirm}>{t('deleteConfirmYes', lang)}</button>
                    <button className="gm-delete-confirm-no" onClick={closeMenu}>{t('deleteConfirmNo', lang)}</button>
                  </div>
                )}
              </div>,
              document.body
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default GroupMessage;
