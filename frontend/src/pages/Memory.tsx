import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './Memory.css';

interface Memory {
  id:           string;
  content:      string;
  layer:        number;
  category:     string;
  agent_target: string;
  created_at:   string;
}

interface Props {
  onPendingCountChange?: (count: number) => void;
  lang?: string | null; // drives translated UI text (Fase 8) — passed down from MainShell/MainShellMobile
}

const timeAgo = (iso: string, lang?: string | null): string => {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return t('memSecAgo', lang, { n: diff });
  if (diff < 3600)  return t('memMinAgo', lang, { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('memHourAgo', lang, { n: Math.floor(diff / 3600) });
  return t('memDayAgo', lang, { n: Math.floor(diff / 86400) });
};

export default function Memory({ onPendingCountChange, lang }: Props) {
  const [pending,       setPending]       = useState<Memory[]>([]);
  const [approved,      setApproved]      = useState<Memory[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [actioning,     setActioning]     = useState<Record<string, boolean>>({});
  const [dismissing,    setDismissing]    = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pendRes, appRes] = await Promise.all([
        apiFetch('/api/memories/pending'),
        apiFetch('/api/memories/approved'),
      ]);
      const pendData = await pendRes.json();
      const appData  = await appRes.json();
      if (pendData.status === 'success') {
        setPending(pendData.memories);
        onPendingCountChange?.(pendData.memories.length);
      }
      if (appData.status === 'success') setApproved(appData.memories);
    } catch {} finally { setLoading(false); }
  }, [onPendingCountChange]);

  useEffect(() => { load(); }, [load]);

  const triggerDismiss = (id: string, action: 'approve' | 'reject' | 'delete') => {
    setDismissing(prev => ({ ...prev, [id]: true }));
    setTimeout(() => {
      if (action === 'delete') {
        setApproved(prev => prev.filter(m => m.id !== id));
      } else {
        setPending(prev => {
          const updated = prev.filter(m => m.id !== id);
          onPendingCountChange?.(updated.length);
          return updated;
        });
        if (action === 'approve') {
          const mem = pending.find(m => m.id === id);
          if (mem) setApproved(prev => [{ ...mem }, ...prev]);
        }
      }
      setDismissing(prev => { const n = { ...prev }; delete n[id]; return n; });
      setActioning(prev => { const n = { ...prev }; delete n[id]; return n; });
    }, 220);
  };

  const handleApprove = async (id: string) => {
    if (actioning[id]) return;
    setActioning(prev => ({ ...prev, [id]: true }));
    try {
      await apiFetch(`/api/memories/${id}/approve`, { method: 'PATCH' });
      triggerDismiss(id, 'approve');
    } catch { setActioning(prev => { const n = { ...prev }; delete n[id]; return n; }); }
  };

  const handleReject = async (id: string) => {
    if (actioning[id]) return;
    setActioning(prev => ({ ...prev, [id]: true }));
    try {
      await apiFetch(`/api/memories/${id}/reject`, { method: 'PATCH' });
      triggerDismiss(id, 'reject');
    } catch { setActioning(prev => { const n = { ...prev }; delete n[id]; return n; }); }
  };

  const handleDelete = async (id: string) => {
    if (actioning[id]) return;
    setActioning(prev => ({ ...prev, [id]: true }));
    try {
      await apiFetch(`/api/memories/${id}`, { method: 'DELETE' });
      triggerDismiss(id, 'delete');
    } catch { setActioning(prev => { const n = { ...prev }; delete n[id]; return n; }); }
  };

  const handleApproveAll = async () => {
    const ids = pending.map(m => m.id);
    for (const id of ids) await handleApprove(id);
  };

  if (loading) return (
    <div className="mem-loading">
      <span className="mem-loading-dot"/>
      <span className="mem-loading-dot"/>
      <span className="mem-loading-dot"/>
    </div>
  );

  return (
    <div className="mem-root">

      {/* ── Pending section ── */}
      <div className="mem-section">
        <div className="mem-section-label">
          {t('memPendingReview', lang)}
          <span className="mem-section-count">{pending.length}</span>
        </div>

        {pending.length === 0 ? (
          <div className="mem-empty">
            <span className="mem-empty-icon">◈</span>
            <span className="mem-empty-text">{t('memAllReviewed', lang)}</span>
          </div>
        ) : (
          <>
            <div className="mem-cards">
              {pending.map(mem => (
                <div
                  key={mem.id}
                  className={`mem-card ${dismissing[mem.id] ? (actioning[mem.id] ? 'mem-card-exit-right' : 'mem-card-exit-left') : ''}`}
                >
                  <div className="mem-card-content">{mem.content}</div>
                  <div className="mem-card-meta">
                    <span className={`mem-tag mem-tag-layer${mem.layer}`}>
                      {t('memLayerTag', lang, { n: mem.layer })}
                    </span>
                    <span className="mem-tag mem-tag-cat">{mem.category}</span>
                    <span className="mem-time">{timeAgo(mem.created_at, lang)}</span>
                  </div>
                  <div className="mem-card-actions">
                    <button
                      className="mem-btn-approve"
                      onClick={() => handleApprove(mem.id)}
                      disabled={!!actioning[mem.id]}
                    >
                      {actioning[mem.id] ? '···' : t('memApproveBtn', lang)}
                    </button>
                    <button
                      className="mem-btn-reject"
                      onClick={() => handleReject(mem.id)}
                      disabled={!!actioning[mem.id]}
                    >
                      {actioning[mem.id] ? '···' : t('memRejectBtn', lang)}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {pending.length > 1 && (
              <button className="mem-approve-all" onClick={handleApproveAll}>
                {t('memApproveAllBtn', lang, { n: pending.length })}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Approved section ── */}
      <div className="mem-section">
        <div className="mem-section-label">
          {t('memApproved', lang)}
          <span className="mem-section-count">{approved.length}</span>
        </div>

        {approved.length === 0 ? (
          <div className="mem-empty">
            <span className="mem-empty-icon">◈</span>
            <span className="mem-empty-text">{t('memNoApprovedYet', lang)}</span>
          </div>
        ) : (
          <div className="mem-approved-list">
            {approved.map(mem => (
              <div
                key={mem.id}
                className={`mem-approved-row ${dismissing[mem.id] ? 'mem-card-exit-left' : ''}`}
              >
                <div className="mem-approved-bar"/>
                <div className="mem-approved-body">
                  <div className="mem-approved-content">{mem.content}</div>
                  <div className="mem-card-meta">
                    <span className={`mem-tag mem-tag-layer${mem.layer}`}>
                      {t('memLayerTag', lang, { n: mem.layer })}
                    </span>
                    <span className="mem-tag mem-tag-cat">{mem.category}</span>
                    <span className="mem-time">{timeAgo(mem.created_at, lang)}</span>
                  </div>
                </div>
                <button
                  className="mem-btn-delete"
                  onClick={() => handleDelete(mem.id)}
                  disabled={!!actioning[mem.id]}
                  title={t('memRemoveTooltip', lang)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
