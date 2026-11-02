import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase, apiFetch } from '../lib/supabase';

export interface Reaction {
  id:          string;
  sender_id:   string | null;
  sender_type: 'user' | 'aksel' | 'vera';
  sender_name: string | null;
  emoji:       string;
}

export interface Attachment {
  id:               string;
  file_name:        string;
  file_type:        string;
  storage_provider: string;
  storage_path:     string;
  size_bytes:       number;
  url?:             string | null; // resolved server-side (signed for Supabase, direct for Cloudinary)
}

export interface GroupMessage {
  id:          string;
  group_id:    string;
  sender_id:   string | null;
  sender_type: 'user' | 'aksel' | 'vera';
  sender_name: string | null;
  content:     string;
  reply_to:    string | null;
  created_at:  string;
  group_message_reactions?: Reaction[]; // embedded by the GET /messages backend query
  deleted_at?: string | null; // set + content cleared server-side when deleted (Phase 8.9)
  group_message_attachments?: Attachment[]; // embedded by the GET /messages backend query (Phase 8.11)
  pendingAttachment?: boolean; // true briefly between optimistic send and the attachment_added broadcast catching up
}

// Strips the "data:image/jpeg;base64," prefix FileReader adds — the backend
// expects raw base64 only (matches personal chat's files.js upload contract).
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve((reader.result as string).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

interface UseGroupMessagesOptions {
  groupId: string;
  enabled?: boolean; // pause subscription when not viewing the chat
}

// ── Tuning constants ─────────────────────────────────────────────────────────
const MAX_BACKOFF_MS          = 15000; // reconnect delay ceiling
const BACKOFF_JITTER_RATIO    = 0.3;   // ±30% randomization, prevents thundering herd
const AUTH_ERROR_GIVEUP_AFTER = 3;     // consecutive Unauthorized-type errors before we stop retrying
const TYPING_EMIT_THROTTLE_MS = 2000;  // how often WE broadcast "typing" while actively typing
const TYPING_STOP_DEBOUNCE_MS = 3000;  // how long after the last keystroke we broadcast "stopped_typing"
const TYPING_RECEIVER_TTL_MS  = 5000;  // if a stopped_typing event is lost, we self-expire on the receiving end

// ── Helpers ────────────────────────────────────────────────────────────────

// Broadcast events are not guaranteed to arrive in send order (agent
// pipeline delays, batching, reconnect refetches), so every insert goes
// through this instead of a blind append.
function insertSorted(list: GroupMessage[], msg: GroupMessage): GroupMessage[] {
  let i = list.length;
  while (i > 0 && list[i - 1].created_at > msg.created_at) i--;
  return [...list.slice(0, i), msg, ...list.slice(i)];
}

function sortByCreatedAt(list: GroupMessage[]): GroupMessage[] {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

const isOptimistic = (m: GroupMessage) => m.id.startsWith('optimistic-');

// A CHANNEL_ERROR whose message mentions "Unauthorized" signals a permission
// problem (RLS denial, kicked from group) rather than a network blip. Those
// two failure classes need different treatment: network errors should retry
// forever, permission errors should give up and tell the user why.
function isAuthError(err: any): boolean {
  const msg = typeof err === 'string' ? err : err?.message;
  return typeof msg === 'string' && /unauthorized/i.test(msg);
}

function backoffDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = base * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

export function useGroupMessages({ groupId, enabled = true }: UseGroupMessagesOptions) {
  const [messages,        setMessages]        = useState<GroupMessage[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState('');
  const [connectionError, setConnectionError] = useState(''); // fatal (non-retryable) realtime failure
  const [typingUserIds,   setTypingUserIds]   = useState<string[]>([]);
  const [onlineUserIds,   setOnlineUserIds]   = useState<string[]>([]);

  const channelRef       = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const selfIdRef         = useRef<string | null>(null);
  const lastTypingEmitRef = useRef(0);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingExpiryRef    = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Initial fetch ────────────────────────────────────────────────────────
  // Reusable message fetch — used for the initial load AND as a resync
  // point whenever the 'attachment_added' broadcast fires (see below): the
  // broadcast payload carries only the raw DB row (storage_path/provider),
  // not a resolved display URL (that resolution — signed URL for Supabase,
  // direct for Cloudinary — is backend logic, deliberately not duplicated
  // here), so the simplest correct move is to re-fetch via the same,
  // already-tested GET endpoint rather than inventing a second way to
  // resolve URLs client-side.
  const refetchMessages = useCallback(async () => {
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/messages`);
      const data = await res.json();
      if (data.status === 'success') {
        setMessages(sortByCreatedAt(data.messages || []));
      } else {
        setError(data.message || 'Failed to load messages');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load messages');
    }
  }, [groupId]);

  useEffect(() => {
    if (!groupId || !enabled) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    refetchMessages().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId, enabled, refetchMessages]);

  // ── Realtime subscription (Broadcast-from-Database + typing + presence) ──
  useEffect(() => {
    if (!groupId || !enabled) return;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled       = false;
    let retryCount      = 0; // drives backoff delay growth — never capped, only the DELAY is capped
    let authErrorStreak = 0; // consecutive Unauthorized-type failures — THIS is what we cap
    let droppedWhileUp  = false;
    let currentChannel: ReturnType<typeof supabase.channel> | null = null;

    const clearAllTypingTimers = () => {
      typingExpiryRef.current.forEach(t => clearTimeout(t));
      typingExpiryRef.current.clear();
    };

    const refetchGap = async () => {
      try {
        const res  = await apiFetch(`/api/groups/${groupId}/messages`);
        const data = await res.json();
        if (cancelled || data.status !== 'success') return;
        setMessages(prev => {
          const server = sortByCreatedAt(data.messages || []);
          return prev.filter(isOptimistic).reduce(insertSorted, server);
        });
      } catch {
        // Keep what we have; the next reconnect will retry the catch-up.
      }
    };

    const deriveOnlineIds = (channel: any) => {
      const state = channel.presenceState() as Record<string, any[]>;
      const ids = new Set<string>();
      Object.values(state).forEach(entries => {
        entries.forEach((e: any) => { if (e?.user_id) ids.add(e.user_id); });
      });
      if (selfIdRef.current) ids.delete(selfIdRef.current);
      setOnlineUserIds(Array.from(ids));
    };

    const connect = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      selfIdRef.current = session?.user?.id ?? null;
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }

      const channel = supabase
        .channel(`group:${groupId}`, { config: { private: true } })
        .on('broadcast', { event: 'INSERT' }, (message) => {
          const rec = message?.payload?.record as GroupMessage | undefined;
          if (!rec || !rec.id || rec.group_id !== groupId) return;
          console.log(`[GroupRealtime] group:${groupId} received broadcast INSERT:`, rec.id);

          setMessages(prev => {
            if (prev.some(m => m.id === rec.id)) return prev;
            const optIdx = prev.findIndex(
              m => isOptimistic(m) && m.sender_type === 'user' && m.content === rec.content
            );
            if (optIdx !== -1) {
              const next = [...prev];
              next[optIdx] = rec;
              return next;
            }
            return insertSorted(prev, rec);
          });
        })
        .on('broadcast', { event: 'reaction_added' }, (message) => {
          // Source of truth for reactions is this broadcast (fired by the
          // broadcast_group_reaction trigger, Phase 8.7) — the API call in
          // sendReaction() below deliberately does no local state mutation
          // of its own, same "server confirms via broadcast" pattern as
          // message sends.
          const rec = message?.payload?.record as Reaction & { message_id?: string } | undefined;
          if (!rec?.message_id) return;
          setMessages(prev => prev.map(m => {
            if (m.id !== rec.message_id) return m;
            const others = (m.group_message_reactions || []).filter(r => r.id !== rec.id);
            return { ...m, group_message_reactions: [...others, rec] };
          }));
        })
        .on('broadcast', { event: 'reaction_removed' }, (message) => {
          const rec = message?.payload?.old_record as Reaction & { message_id?: string } | undefined;
          if (!rec?.message_id) return;
          setMessages(prev => prev.map(m => {
            if (m.id !== rec.message_id) return m;
            return { ...m, group_message_reactions: (m.group_message_reactions || []).filter(r => r.id !== rec.id) };
          }));
        })
        .on('broadcast', { event: 'message_deleted' }, (message) => {
          // Fired by broadcast_group_message_deleted (Phase 8.9), scoped to
          // the exact moment deleted_at transitions from null to set. The
          // row's content already arrives cleared — just merge it in, same
          // "server confirms via broadcast" pattern as everything else.
          const rec = message?.payload?.record as GroupMessage | undefined;
          if (!rec?.id) return;
          setMessages(prev => prev.map(m => (m.id === rec.id ? { ...m, ...rec } : m)));
        })
        .on('broadcast', { event: 'attachment_added' }, () => {
          // The broadcast payload only carries the raw DB row (storage_path/
          // provider) — resolving a display URL is backend logic (signed for
          // Supabase, direct for Cloudinary), deliberately not duplicated
          // client-side. Simplest correct move: resync via the same,
          // already-tested GET endpoint. Attachments are infrequent enough
          // (only on an actual file send) that this refetch cost is
          // negligible at this app's scale.
          refetchMessages();
        })
        .on('broadcast', { event: 'typing' }, (message) => {
          const uid = message?.payload?.user_id;
          if (!uid || uid === selfIdRef.current) return; // ignore our own echo

          const existing = typingExpiryRef.current.get(uid);
          if (existing) clearTimeout(existing);
          typingExpiryRef.current.set(uid, setTimeout(() => {
            // Predecessor mistake we're deliberately avoiding: if the sender's
            // stopped_typing event is lost (disconnect mid-type, dropped
            // frame), this self-expiry is what prevents "X is typing..."
            // from being stuck on screen forever.
            typingExpiryRef.current.delete(uid);
            setTypingUserIds(prev => prev.filter(id => id !== uid));
          }, TYPING_RECEIVER_TTL_MS));

          setTypingUserIds(prev => (prev.includes(uid) ? prev : [...prev, uid]));
        })
        .on('broadcast', { event: 'stopped_typing' }, (message) => {
          const uid = message?.payload?.user_id;
          if (!uid) return;
          const existing = typingExpiryRef.current.get(uid);
          if (existing) { clearTimeout(existing); typingExpiryRef.current.delete(uid); }
          setTypingUserIds(prev => prev.filter(id => id !== uid));
        })
        .on('presence', { event: 'sync' }, () => deriveOnlineIds(channel))
        .subscribe((status, err) => {
          console.log(`[GroupRealtime] group:${groupId} status: ${status}`, err || '');

          if (status === 'SUBSCRIBED') {
            retryCount = 0;
            authErrorStreak = 0;
            setConnectionError('');
            if (selfIdRef.current) {
              channel.track({ user_id: selfIdRef.current, online_at: new Date().toISOString() });
            }
            if (droppedWhileUp) {
              droppedWhileUp = false;
              refetchGap();
            }
            return;
          }

          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !cancelled) {
            droppedWhileUp = true;

            if (isAuthError(err)) {
              authErrorStreak++;
              if (authErrorStreak >= AUTH_ERROR_GIVEUP_AFTER) {
                console.error(`[GroupRealtime] group:${groupId} — giving up, repeated authorization failure`);
                setConnectionError('Kamu tidak lagi punya akses ke chat ini.');
                return; // do NOT schedule a retry — this is not a network problem
              }
            } else {
              authErrorStreak = 0; // a non-auth error breaks the auth-failure streak
            }

            // Network-class errors retry indefinitely — being offline is the
            // normal case, not an edge case, so there is no attempt ceiling
            // here. Only the DELAY between attempts is capped.
            const delay = backoffDelay(retryCount);
            retryCount++;
            console.warn(`[GroupRealtime] group:${groupId} connection lost (${status}), retry ${retryCount} in ${Math.round(delay)}ms...`);
            retryTimer = setTimeout(async () => {
              // Must fully await teardown before reconnecting — the new
              // channel below is created with the EXACT SAME topic name
              // (`group:${groupId}`). Firing connect() immediately after a
              // fire-and-forget removeChannel() call left old and new
              // channel setup racing each other: Supabase's client still
              // had the old, already-subscribed channel registered under
              // that topic when the new one tried to attach its own
              // presence listener, which is what actually produced "cannot
              // add presence callbacks after subscribe()" — not a real
              // ordering mistake in this file, but a leftover channel that
              // hadn't finished going away yet.
              await supabase.removeChannel(channel);
              connect();
            }, delay);
          }
        });

      currentChannel      = channel;
      channelRef.current  = channel;
    };

    // Reconnect immediately the moment the browser regains connectivity,
    // instead of waiting for the current backoff timer to elapse.
    const onOnline = async () => {
      if (cancelled) return;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      // Same fix as the retry path above: must await teardown of the old
      // channel before reconnecting under the same topic name.
      if (currentChannel) await supabase.removeChannel(currentChannel);
      connect();
    };
    window.addEventListener('online', onOnline);

    connect();

    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      if (retryTimer) clearTimeout(retryTimer);
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      clearAllTypingTimers();
      if (currentChannel) supabase.removeChannel(currentChannel);
      channelRef.current = null;
      setTypingUserIds([]);
      setOnlineUserIds([]);
    };
  }, [groupId, enabled, refetchMessages]);

  // ── Typing signal (call on every keystroke in the composer) ───────────────
  const notifyTyping = useCallback(() => {
    const channel = channelRef.current as any;
    if (!channel || !selfIdRef.current) return;

    const now = Date.now();
    if (now - lastTypingEmitRef.current > TYPING_EMIT_THROTTLE_MS) {
      channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: selfIdRef.current } });
      lastTypingEmitRef.current = now;
    }

    if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
    stopTypingTimerRef.current = setTimeout(() => {
      channel.send({ type: 'broadcast', event: 'stopped_typing', payload: { user_id: selfIdRef.current } });
    }, TYPING_STOP_DEBOUNCE_MS);
  }, []);

  // ── Send a user message ───────────────────────────────────────────────────
  const sendMessage = async (content: string, replyTo?: string, file?: File) => {
    const trimmed = content.trim();
    if (!trimmed && !file) return;

    const optimisticId = `optimistic-${Date.now()}`;
    const optimistic: GroupMessage = {
      id:          optimisticId,
      group_id:    groupId,
      sender_id:   selfIdRef.current, // was `null` — made isOwn (sender_id === profile.id) always
                                       // false on the optimistic render, so a sender's own bubble
                                       // briefly appeared on the LEFT before the real broadcast
                                       // (with the correct sender_id) swapped it to the right.
      sender_type: 'user',
      sender_name: null,
      content:     trimmed,
      reply_to:    replyTo || null,
      created_at:  new Date().toISOString(),
      pendingAttachment: !!file,
    };

    setMessages(prev => [...prev, optimistic]);

    try {
      const fileFields = file
        ? { file_name: file.name, file_type: file.type, file_base64: await fileToBase64(file) }
        : {};

      const res  = await apiFetch(`/api/groups/${groupId}/messages`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content: trimmed, reply_to: replyTo, ...fileFields }),
      });
      const data = await res.json();

      if (data.status !== 'success') throw new Error(data.message);

      // The POST response doesn't carry attachment info (that lands
      // separately via the 'attachment_added' broadcast + refetch above) —
      // keep the pending flag on until that catches up, so the UI can show
      // an "uploading..." placeholder instead of a brief empty gap.
      const real: GroupMessage = { ...data.message, pendingAttachment: !!file };
      setMessages(prev => {
        const withoutOptimistic = prev.filter(m => m.id !== optimisticId);
        if (withoutOptimistic.some(m => m.id === real.id)) return withoutOptimistic;
        return insertSorted(withoutOptimistic, real);
      });
    } catch (err: any) {
      setMessages(prev => prev.filter(m => m.id !== optimisticId));
      throw err;
    }
  };

  // ── React to a message (set / replace / toggle-off) ───────────────────────
  // The backend endpoint owns the toggle logic (same emoji again = remove,
  // different emoji = replace) — this just calls it. No optimistic local
  // update: the actual add/remove arrives moments later via the
  // 'reaction_added'/'reaction_removed' broadcast handlers above, which is
  // the single source of truth. Reactions are low-stakes enough that the
  // small round-trip delay isn't worth the extra complexity of predicting
  // server-side toggle behavior optimistically.
  const sendReaction = async (messageId: string, emoji: string) => {
    const res  = await apiFetch(`/api/groups/${groupId}/messages/${messageId}/reactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ emoji }),
    });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message);
  };

  // ── Delete a message (Phase 8.9) ──────────────────────────────────────────
  // Same no-optimistic-update reasoning as sendReaction — the tombstone
  // state arrives via the 'message_deleted' broadcast handler above.
  const deleteMessage = async (messageId: string) => {
    const res  = await apiFetch(`/api/groups/${groupId}/messages/${messageId}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message);
  };

  // ── Catch-Me-Up (item 6) ──────────────────────────────────────────────────
  // User-initiated, ephemeral — the summary is just returned to the caller,
  // never merged into `messages` state (it isn't a real group_messages row;
  // the backend never saves or broadcasts it, see groups.js).
  const catchUp = async (): Promise<string> => {
    const res  = await apiFetch(`/api/groups/${groupId}/catchup`, { method: 'POST' });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message);
    return data.summary as string;
  };

  return {
    messages, loading, error, sendMessage,
    connectionError,
    typingUserIds, notifyTyping,
    onlineUserIds,
    sendReaction,
    deleteMessage,
    catchUp,
  };
}