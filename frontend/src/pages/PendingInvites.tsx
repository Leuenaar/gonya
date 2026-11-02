import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './PendingInvites.css';

interface InviteItem {
  id:         string;
  group_id:   string;
  invite_type: string;
  created_at: string;
  group:      { name: string; purpose: string | null } | null;
}

interface Props {
  lang?:        string | null;
  onAccepted:   (groupId: string, groupName: string) => void; // parent navigates into the group
}

// This is the missing half of "invited by username but no way to accept" —
// backend/routes/invites.js's GET /mine supplies the list, and this
// component is the first (and only) place in the app that surfaces it.
// Accept/decline reuse the existing, already-working
// /api/groups/:id/invites/accept and /decline endpoints — this component
// only had to solve "how does the recipient find out an invite exists."
export default function PendingInvites({ lang, onAccepted }: Props) {
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [open,     setOpen]     = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [acting,   setActing]   = useState<Record<string, boolean>>({});
  const [error,    setError]    = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await apiFetch('/api/invites/mine');
      const data = await res.json();
      if (data.status === 'success') setInvites(data.invites);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAccept = async (invite: InviteItem) => {
    setActing(prev => ({ ...prev, [invite.id]: true }));
    setError('');
    try {
      const res  = await apiFetch(`/api/groups/${invite.group_id}/invites/accept`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setInvites(prev => prev.filter(i => i.id !== invite.id));
      onAccepted(invite.group_id, invite.group?.name || data.group_name || '');
      setOpen(false);
    } catch (err: any) {
      setError(err.message || t('piErrAccept', lang));
    } finally {
      setActing(prev => { const n = { ...prev }; delete n[invite.id]; return n; });
    }
  };

  const handleDecline = async (invite: InviteItem) => {
    setActing(prev => ({ ...prev, [invite.id]: true }));
    setError('');
    try {
      await apiFetch(`/api/groups/${invite.group_id}/invites/decline`, { method: 'POST' });
      setInvites(prev => prev.filter(i => i.id !== invite.id));
    } catch {
      setError(t('piErrDecline', lang));
    } finally {
      setActing(prev => { const n = { ...prev }; delete n[invite.id]; return n; });
    }
  };

  if (invites.length === 0 && !loading) return null; // nothing to show, don't clutter the header

  return (
    <div className="pi-root">
      <button className="pi-badge-btn" onClick={() => setOpen(v => !v)} aria-label={t('piBadgeLabel', lang)}>
        <span className="pi-badge-icon">✉</span>
        {invites.length > 0 && <span className="pi-badge-count">{invites.length}</span>}
      </button>

      {open && (
        <div className="pi-dropdown">
          <div className="pi-dropdown-header">{t('piTitle', lang)}</div>
          {loading && <div className="pi-loading">{t('piLoading', lang)}</div>}
          {error && <p className="pi-error">&gt; {error}</p>}
          {!loading && invites.length === 0 && (
            <div className="pi-empty">{t('piNoInvites', lang)}</div>
          )}
          {invites.map(inv => (
            <div key={inv.id} className="pi-item">
              <div className="pi-item-group">{inv.group?.name || '—'}</div>
              {inv.group?.purpose && <div className="pi-item-purpose">{inv.group.purpose}</div>}
              <div className="pi-item-actions">
                <button
                  className="pi-btn-decline"
                  onClick={() => handleDecline(inv)}
                  disabled={!!acting[inv.id]}
                >
                  {t('piDecline', lang)}
                </button>
                <button
                  className="pi-btn-accept"
                  onClick={() => handleAccept(inv)}
                  disabled={!!acting[inv.id]}
                >
                  {acting[inv.id] ? '···' : t('piAccept', lang)}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
