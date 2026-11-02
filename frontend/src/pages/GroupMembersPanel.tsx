import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './GroupMembersPanel.css';

interface Member {
  user_id: string;
  role:    'owner' | 'co_admin' | 'member';
  profile: { display_name: string; username: string | null; short_id: string } | null;
}

interface Props {
  groupId:        string;
  myRole:         string;
  onClose:        () => void;
  onGroupDeleted?: () => void; // called after a successful hard delete — parent should navigate away
  lang?:          string | null; // drives translated UI text (Fase 8) — profile.language, passed down from GroupChat
}

export default function GroupMembersPanel({ groupId, myRole, onClose, onGroupDeleted, lang }: Props) {
  const [members,      setMembers]      = useState<Member[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [shortIdInput, setShortIdInput] = useState('');
  const [inviting,     setInviting]     = useState(false);
  const [inviteMsg,    setInviteMsg]    = useState('');
  const [linkResult,   setLinkResult]   = useState<{ token: string; expires_at: string } | null>(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [deletingGroup, setDeletingGroup]   = useState(false);
  const [deleteError,   setDeleteError]     = useState('');
  const [leavingGroup,  setLeavingGroup]    = useState(false);
  const [leaveError,    setLeaveError]      = useState('');

  const canInvite = myRole === 'owner' || myRole === 'co_admin';
  const isOwner    = myRole === 'owner';

  const [membersError, setMembersError] = useState('');

  useEffect(() => {
    apiFetch(`/api/groups/${groupId}`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') setMembers(data.group.members || []);
        else setMembersError(data.message || t('failedToLoadMembers', lang));
      })
      .catch(() => setMembersError(t('connErrorLoadingMembers', lang)))
      .finally(() => setLoading(false));
  }, [groupId]);

  const handleInviteByShortId = async () => {
    const trimmed = shortIdInput.trim().toUpperCase();
    if (!trimmed) return;
    setInviting(true);
    setInviteMsg('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/invites/short-id`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ short_id: trimmed }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setInviteMsg(`✓ Invited ${data.invitee?.display_name || trimmed}`);
      setShortIdInput('');
    } catch (err: any) {
      setInviteMsg(`✗ ${err.message || t('failedToInvite', lang)}`);
    } finally {
      setInviting(false);
    }
  };

  const handleGenerateLink = async () => {
    setGeneratingLink(true);
    setInviteMsg('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/invites/link`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setLinkResult({ token: data.token, expires_at: data.expires_at });
    } catch (err: any) {
      setInviteMsg(`✗ ${err.message || t('failedToGenerateLink', lang)}`);
    } finally {
      setGeneratingLink(false);
    }
  };

  // Same reasoning as handleDeleteGroup below, minus the typed-DELETE
  // step — leaving is reversible (can be re-invited), deleting isn't.
  const handleLeaveGroup = async () => {
    const confirmed = window.confirm(t('leaveGroupConfirm', lang));
    if (!confirmed) return;

    setLeavingGroup(true);
    setLeaveError('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/leave`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      onGroupDeleted?.(); // same "navigate away" callback — the member is out either way
    } catch (err: any) {
      setLeaveError(err.message || t('failedToLeaveGroup', lang));
      setLeavingGroup(false);
    }
  };

  // Same confirm pattern as Settings.tsx's account deletion — a plain
  // window.confirm followed by a typed "DELETE" prompt, kept consistent
  // rather than inventing a different confirm UI just for this.
  const handleDeleteGroup = async () => {
    const confirmed = window.confirm(
      'This will permanently delete the group, all messages, and remove all members. This cannot be undone.'
    );
    if (!confirmed) return;
    const input = window.prompt('Type DELETE to confirm:');
    if (input !== 'DELETE') return;

    setDeletingGroup(true);
    setDeleteError('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      onGroupDeleted?.();
    } catch (err: any) {
      setDeleteError(err.message || t('failedToDeleteGroup', lang));
      setDeletingGroup(false);
    }
  };

  const inviteUrl = linkResult ? `${window.location.origin}/join/${linkResult.token}` : '';

  return (
    <div className="gmp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gmp-panel">
        <div className="gmp-header">
          <span className="gmp-label">{t('membersLabel', lang)}</span>
          <button className="gmp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="gmp-body">
          {loading ? (
            <p className="gmp-loading">{t('loadingDots', lang)}</p>
          ) : membersError ? (
            <p className="gmp-invite-msg err">✗ {membersError}</p>
          ) : (
            <div className="gmp-member-list">
              {members.map(m => (
                <div key={m.user_id} className="gmp-member-row">
                  <div className="gmp-member-info">
                    <span className="gmp-member-name">{m.profile?.display_name || 'Unknown'}</span>
                    {m.profile?.username && <span className="gmp-member-username">@{m.profile.username}</span>}
                    {m.profile?.short_id && <span className="gmp-member-shortid">{m.profile.short_id}</span>}
                  </div>
                  <span className={`gmp-member-role gmp-role-${m.role}`}>{m.role.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          )}

          {canInvite && (
            <div className="gmp-invite-section">
              <span className="gmp-invite-label">{t('inviteByShortId', lang)}</span>
              <div className="gmp-invite-row">
                <input
                  className="gmp-invite-input"
                  value={shortIdInput}
                  onChange={e => setShortIdInput(e.target.value)}
                  placeholder="GNY-XXXXXX"
                  maxLength={10}
                  disabled={inviting}
                />
                <button className="gmp-invite-btn" onClick={handleInviteByShortId} disabled={inviting || !shortIdInput.trim()}>
                  {inviting ? '...' : t('btnInvite', lang)}
                </button>
              </div>

              <span className="gmp-invite-label gmp-invite-label-spaced">{t('orShareLink', lang)}</span>
              {linkResult ? (
                <div className="gmp-link-result">
                  <input className="gmp-link-value" value={inviteUrl} readOnly onClick={e => (e.target as HTMLInputElement).select()} />
                  <button
                    className="gmp-invite-btn"
                    onClick={() => navigator.clipboard.writeText(inviteUrl)}
                  >
                    {t('btnCopy', lang)}
                  </button>
                </div>
              ) : (
                <button className="gmp-link-btn" onClick={handleGenerateLink} disabled={generatingLink}>
                  {generatingLink ? t('generatingLink', lang) : t('generateLinkBtn', lang)}
                </button>
              )}

              {inviteMsg && <p className={`gmp-invite-msg ${inviteMsg.startsWith('✓') ? 'ok' : 'err'}`}>{inviteMsg}</p>}
            </div>
          )}

          {isOwner && (
            <div className="gmp-danger-section">
              <span className="gmp-invite-label gmp-invite-label-danger">{t('dangerZoneLabel', lang)}</span>
              <button className="gmp-delete-group-btn" onClick={handleDeleteGroup} disabled={deletingGroup}>
                {deletingGroup ? t('deletingGroup', lang) : t('btnDeleteGroup', lang)}
              </button>
              {deleteError && <p className="gmp-invite-msg err">✗ {deleteError}</p>}
            </div>
          )}

          {!isOwner && (
            <div className="gmp-danger-section">
              <button className="gmp-leave-group-btn" onClick={handleLeaveGroup} disabled={leavingGroup}>
                {leavingGroup ? t('leavingGroup', lang) : t('btnLeaveGroup', lang)}
              </button>
              {leaveError && <p className="gmp-invite-msg err">✗ {leaveError}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
