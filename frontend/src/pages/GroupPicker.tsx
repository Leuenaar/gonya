import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './GroupPicker.css';

interface GroupSummary {
  id:               string;
  name:             string;
  onboarding_done:  boolean;
  my_role:          string;
}

interface InviteItem {
  id:         string;
  group_id:   string;
  created_at: string;
  group:      { name: string; purpose: string | null } | null;
}

interface Props {
  groups:     GroupSummary[];
  onSelect:   (group: GroupSummary) => void;
  onCreateNew: () => void;
  onClose:    () => void;
  lang?:      string | null; // drives translated UI text (Fase 8)
}

export default function GroupPicker({ groups: initialGroups, onSelect, onCreateNew, onClose, lang }: Props) {
  const [groups,     setGroups]     = useState(initialGroups);
  const [confirmId,  setConfirmId]  = useState<string | null>(null);
  const [deleting,   setDeleting]   = useState(false);
  const [error,      setError]      = useState('');

  // Fixes "invited by username but no way to discover it" more durably
  // than a header badge alone: a badge is easy to miss entirely if you
  // invite someone today and they don't open the app until tomorrow.
  // This is the ONE place invites live now — the same screen you land on
  // via burger nav → Group Chat, right alongside your existing groups and
  // "create new," so there's nowhere else to look for it.
  const [invites,      setInvites]      = useState<InviteItem[]>([]);
  const [loadingInv,   setLoadingInv]   = useState(true);
  const [actingInvite, setActingInvite] = useState<Record<string, boolean>>({});

  useEffect(() => {
    apiFetch('/api/invites/mine')
      .then(r => r.json())
      .then(data => { if (data.status === 'success') setInvites(data.invites); })
      .finally(() => setLoadingInv(false));
  }, []);

  const handleAcceptInvite = async (inv: InviteItem) => {
    setActingInvite(prev => ({ ...prev, [inv.id]: true }));
    try {
      const res  = await apiFetch(`/api/groups/${inv.group_id}/invites/accept`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setInvites(prev => prev.filter(i => i.id !== inv.id));
      // Land the user straight in the group they just joined — it's
      // already been onboarded (that's a one-time, per-group setup done
      // by the owner), so onboarding_done is always true from a joining
      // member's point of view.
      onSelect({ id: inv.group_id, name: inv.group?.name || data.group_name || '', onboarding_done: true, my_role: 'member' });
    } catch {
      setActingInvite(prev => { const n = { ...prev }; delete n[inv.id]; return n; });
    }
  };

  const handleDeclineInvite = async (inv: InviteItem) => {
    setActingInvite(prev => ({ ...prev, [inv.id]: true }));
    try {
      await apiFetch(`/api/groups/${inv.group_id}/invites/decline`, { method: 'POST' });
      setInvites(prev => prev.filter(i => i.id !== inv.id));
    } catch {
      setActingInvite(prev => { const n = { ...prev }; delete n[inv.id]; return n; });
    }
  };

  const handleDelete = async (groupId: string) => {
    setDeleting(true);
    setError('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('gpErrDeleteFailed', lang));
      setGroups(prev => prev.filter(g => g.id !== groupId));
      setConfirmId(null);
    } catch (err: any) {
      setError(err.message || t('errSomethingWrong', lang));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="gp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gp-modal">
        <div className="gp-corner gp-tl" /><div className="gp-corner gp-tr" />
        <div className="gp-corner gp-bl" /><div className="gp-corner gp-br" />

        <div className="gp-header">
          <span className="gp-label">{t('gpYourGroupsLabel', lang)}</span>
          <button className="gp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <h2 className="gp-title">{t('gpTitle', lang)}</h2>

        {error && <p className="gp-error">&gt; {error}</p>}

        {!loadingInv && invites.length > 0 && (
          <div className="gp-invites-section">
            <span className="gp-invites-label">{t('gpInvitesLabel', lang, { n: invites.length })}</span>
            {invites.map(inv => (
              <div key={inv.id} className="gp-invite-row">
                <div className="gp-invite-info">
                  <span className="gp-invite-name">{inv.group?.name || '—'}</span>
                  {inv.group?.purpose && <span className="gp-invite-purpose">{inv.group.purpose}</span>}
                </div>
                <div className="gp-invite-actions">
                  <button
                    className="gp-invite-decline"
                    onClick={() => handleDeclineInvite(inv)}
                    disabled={!!actingInvite[inv.id]}
                  >
                    {t('jgDecline', lang)}
                  </button>
                  <button
                    className="gp-invite-accept"
                    onClick={() => handleAcceptInvite(inv)}
                    disabled={!!actingInvite[inv.id]}
                  >
                    {actingInvite[inv.id] ? '···' : t('piAccept', lang)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="gp-list">
          {groups.map(g => (
            <div key={g.id} className="gp-item-row">
              {confirmId === g.id ? (
                <div className="gp-confirm-row">
                  <span className="gp-confirm-text">{t('gpConfirmDelete', lang, { name: g.name })}</span>
                  <div className="gp-confirm-actions">
                    <button className="gp-confirm-yes" onClick={() => handleDelete(g.id)} disabled={deleting}>
                      {deleting ? '...' : t('deleteConfirmYes', lang)}
                    </button>
                    <button className="gp-confirm-no" onClick={() => setConfirmId(null)} disabled={deleting}>
                      {t('btnCancel', lang)}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="gp-item" onClick={() => onSelect(g)}>
                    <span className="gp-item-name">{g.name}</span>
                    <span className="gp-item-meta">
                      {g.onboarding_done ? g.my_role : t('gpSetupIncomplete', lang)}
                    </span>
                  </button>
                  {g.my_role === 'owner' && (
                    <button
                      className="gp-item-delete"
                      onClick={() => setConfirmId(g.id)}
                      aria-label={`Delete ${g.name}`}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        <button className="gp-new-btn" onClick={onCreateNew}>{t('gpNewGroupBtn', lang)}</button>
      </div>
    </div>
  );
}
