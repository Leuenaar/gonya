import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './GroupMemoriesPanel.css';

interface GroupMemoryItem {
  id:         string;
  content:    string;
  category:   string | null;
  status:     string;
  created_at: string;
}

interface Props {
  groupId: string;
  onClose: () => void;
  lang?:   string | null;
}

// Minimal v1 (Fase 11 item #2, 22 Aug 2026) — owner/co-admin review queue
// for pending group_memories. Deliberately simple: no editing, no bulk
// actions, no filtering beyond "pending". A more complete version lives
// alongside "Group settings lengkap" later; this just needs to let an
// owner/co-admin actually clear the approval queue that's been
// accumulating since group memory extraction went live.
export default function GroupMemoriesPanel({ groupId, onClose, lang }: Props) {
  const [memories,   setMemories]   = useState<GroupMemoryItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [loadError,  setLoadError]  = useState('');
  const [actioningId, setActioningId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/api/groups/${groupId}/memories?status=pending`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') setMemories(data.memories || []);
        else setLoadError(data.message || t('failedToLoadGroupMemories', lang));
      })
      .catch(() => setLoadError(t('connErrorLoadingGroupMemories', lang)))
      .finally(() => setLoading(false));
  }, [groupId]);

  const handleAction = async (memoryId: string, status: 'approved' | 'rejected') => {
    setActioningId(memoryId);
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/memories/${memoryId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      // Either action means it's no longer pending — drop it from this
      // review-queue list either way, no separate success/fail branch
      // needed for a v1 this simple.
      setMemories(prev => prev.filter(m => m.id !== memoryId));
    } catch (err: any) {
      // Kept intentionally minimal for v1 — a failed action just leaves
      // the item in the list so the owner/co-admin can retry. Polished
      // per-item error surfacing is a "Group settings lengkap" follow-up.
      console.error('[GroupMemoriesPanel] action failed:', err.message);
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="gmemp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gmemp-panel">
        <div className="gmemp-header">
          <span className="gmemp-label">{t('groupMemoriesLabel', lang)}</span>
          <button className="gmemp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="gmemp-body">
          {loading ? (
            <p className="gmemp-loading">{t('loadingDots', lang)}</p>
          ) : loadError ? (
            <p className="gmemp-msg err">✗ {loadError}</p>
          ) : memories.length === 0 ? (
            <p className="gmemp-empty">{t('noGroupMemoriesPending', lang)}</p>
          ) : (
            <div className="gmemp-list">
              {memories.map(m => (
                <div key={m.id} className="gmemp-item">
                  {m.category && <span className="gmemp-item-category">{m.category}</span>}
                  <p className="gmemp-item-content">{m.content}</p>
                  <div className="gmemp-item-actions">
                    <button
                      className="gmemp-approve-btn"
                      onClick={() => handleAction(m.id, 'approved')}
                      disabled={actioningId === m.id}
                    >
                      {actioningId === m.id ? '...' : t('btnApprove', lang)}
                    </button>
                    <button
                      className="gmemp-reject-btn"
                      onClick={() => handleAction(m.id, 'rejected')}
                      disabled={actioningId === m.id}
                    >
                      {actioningId === m.id ? '...' : t('btnReject', lang)}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
