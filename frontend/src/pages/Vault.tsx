import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/supabase';
import { t, type Lang } from '../lib/i18n';
import VoiceSessionModal from './VoiceSessionModal';
import './Vault.css';

interface VaultMessage {
  id:               string;
  sender:           'User' | 'Aksel' | 'Vera';
  content:          string;
  created_at:       string;
  voice_transcript?: { speaker: string; text: string }[] | null;
}

type SenderFilter = 'All' | 'User' | 'Aksel' | 'Vera';

interface Props {
  lang?: Lang;
}

const dateLabel = (iso: string, lang: Lang) => {
  const d     = new Date(iso);
  const today = new Date();
  const yest  = new Date();
  yest.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  if (sameDay(d, today)) return t('vltToday', lang);
  if (sameDay(d, yest))  return t('vltYesterday', lang);

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
};

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

export default function Vault({ lang }: Props = {}) {
  const activeLang: Lang = lang === 'id' ? 'id' : 'en';

  const [items,        setItems]        = useState<VaultMessage[]>([]);
  const [search,       setSearch]       = useState('');
  const [filter,       setFilter]       = useState<SenderFilter>('All');
  const [loading,      setLoading]      = useState(false);
  const [loadingMore,  setLoadingMore]  = useState(false);
  const [hasMore,       setHasMore]      = useState(false);
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [deletingId,   setDeletingId]   = useState<string | null>(null);
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [viewingVoiceMsg, setViewingVoiceMsg] = useState<VaultMessage | null>(null);

  const fetchVault = useCallback(async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setSelectedIds(new Set());
    } else {
      setLoadingMore(true);
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', '30');
      if (filter !== 'All')   params.set('sender', filter);
      if (search.trim())      params.set('search', search.trim());
      if (!reset && items.length > 0) {
        params.set('before', items[items.length - 1].created_at);
      }

      const res  = await apiFetch(`/api/chat/vault?${params.toString()}`);
      const data = await res.json();

      if (data.status === 'success') {
        setItems(prev => reset ? data.data : [...prev, ...data.data]);
        setHasMore(data.hasMore);
      }
    } catch {} finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filter, search, items]);

  // Refetch from scratch when filter or search changes
  useEffect(() => {
    fetchVault(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') fetchVault(true);
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(id);

    try {
      const res  = await apiFetch(`/api/chat/message/${id}`, { method: 'DELETE' });
      const data = await res.json();

      if (data.status === 'success') {
        setItems(prev => prev.filter(item => item.id !== id));
        setExpanded(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setSelectedIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    } catch {} finally {
      setDeletingId(null);
    }
  };

  const handleToggleSelectAll = () => {
    if (items.length === 0) return;
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map(i => i.id)));
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0 || bulkDeleting) return;
    setBulkDeleting(true);

    const ids = Array.from(selectedIds);

    try {
      const results = await Promise.allSettled(
        ids.map(id =>
          apiFetch(`/api/chat/message/${id}`, { method: 'DELETE' }).then(res => res.json())
        )
      );

      const succeededIds = ids.filter((id, i) => {
        const r = results[i];
        return r.status === 'fulfilled' && r.value?.status === 'success';
      });

      setItems(prev => prev.filter(item => !succeededIds.includes(item.id)));
      setSelectedIds(prev => {
        const next = new Set(prev);
        succeededIds.forEach(id => next.delete(id));
        return next;
      });
      setExpanded(prev => {
        const next = new Set(prev);
        succeededIds.forEach(id => next.delete(id));
        return next;
      });
    } catch {} finally {
      setBulkDeleting(false);
    }
  };

  // Group items by date label, preserving descending order
  const grouped: { label: string; items: VaultMessage[] }[] = [];
  for (const item of items) {
    const label = dateLabel(item.created_at, activeLang);
    const last  = grouped[grouped.length - 1];
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      grouped.push({ label, items: [item] });
    }
  }

  const allSelected = items.length > 0 && items.every(item => selectedIds.has(item.id));

  return (
    <div className="vlt-root">
      <div className="vlt-header">
        <span className="vlt-title">Vault</span>
        <input
          className="vlt-search"
          placeholder={t('vltSearchPlaceholder', activeLang)}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
      </div>

      <div className="vlt-filters">
        {(['All', 'User', 'Aksel', 'Vera'] as SenderFilter[]).map(f => (
          <button key={f}
            className={`vlt-filter-btn ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}>
            {f === 'All' ? t('atFilterAll', activeLang) : f === 'User' ? t('csYou', activeLang) : f}
          </button>
        ))}
      </div>

      <div className="vlt-bulk-bar">
        <div
          className={`vlt-select-all ${items.length === 0 ? 'disabled' : ''}`}
          onClick={handleToggleSelectAll}
        >
          <div className={`vlt-checkbox ${allSelected ? 'checked' : ''}`}>
            {allSelected ? '✓' : ''}
          </div>
          {t('vltSelectAll', activeLang)}
        </div>
        <span className="vlt-bulk-count">
          {selectedIds.size > 0 ? t('vltSelectedCount', activeLang, { n: selectedIds.size }) : ''}
        </span>
        <button
          className="vlt-bulk-delete"
          onClick={handleDeleteSelected}
          disabled={selectedIds.size === 0 || bulkDeleting}
        >
          {bulkDeleting ? t('btnDeleting', activeLang) : t('vltDeleteSelected', activeLang)}
        </button>
      </div>

      <div className="vlt-list">
        {loading && <div className="vlt-loading">{t('vltLoadingArchive', activeLang)}</div>}

        {!loading && grouped.length === 0 && (
          <div className="vlt-empty">{t('vltNoMessagesFound', activeLang)}</div>
        )}

        {!loading && grouped.map(group => (
          <div key={group.label}>
            <div className="vlt-date-header">{group.label}</div>
            {group.items.map(item => {
              const isVoice = !!(item.voice_transcript && item.voice_transcript.length > 0);
              return (
              <div key={item.id}
                className={`vlt-item ${expanded.has(item.id) ? 'expanded' : ''} ${isVoice ? 'voice' : ''}`}
                onClick={() => isVoice ? setViewingVoiceMsg(item) : toggleExpand(item.id)}>
                <div className="vlt-item-header">
                  <div
                    className={`vlt-checkbox ${selectedIds.has(item.id) ? 'checked' : ''}`}
                    onClick={e => { e.stopPropagation(); toggleSelect(item.id); }}
                  >
                    {selectedIds.has(item.id) ? '✓' : ''}
                  </div>
                  {isVoice && <span className="vlt-item-voice-icon">🎙</span>}
                  <span className={`vlt-item-sender ${item.sender.toLowerCase()}`}>
                    {item.sender === 'User' ? t('csYou', activeLang) : item.sender}
                  </span>
                  <span className="vlt-item-time">{timeLabel(item.created_at)}</span>
                  <button
                    className="vlt-item-delete"
                    onClick={e => handleDelete(e, item.id)}
                    disabled={deletingId === item.id}
                    title={t('vltDeleteMessageTitle', activeLang)}
                  >
                    {deletingId === item.id ? '···' : '×'}
                  </button>
                </div>
                <p className="vlt-item-content">{item.content}</p>
              </div>
              );
            })}
          </div>
        ))}

        {!loading && hasMore && (
          <button className="vlt-load-more"
            onClick={() => fetchVault(false)}
            disabled={loadingMore}>
            {loadingMore ? t('loadingDots', activeLang) : t('vltLoadMore', activeLang)}
          </button>
        )}
      </div>

      {viewingVoiceMsg && (
        <VoiceSessionModal
          content={viewingVoiceMsg.content}
          transcript={viewingVoiceMsg.voice_transcript || []}
          lang={activeLang}
          onClose={() => setViewingVoiceMsg(null)}
        />
      )}
    </div>
  );
}
