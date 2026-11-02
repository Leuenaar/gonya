import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './JoinGroup.css';

interface Props {
  token:  string;
  onDone: (result: { joined: boolean; groupId?: string; groupName?: string }) => void;
  lang?:  string | null; // drives translated UI text (Fase 8) — no profile exists at this point, optional
}

type Status = 'loading' | 'preview' | 'joining' | 'error';

export default function JoinGroup({ token, onDone, lang }: Props) {
  const [status,    setStatus]    = useState<Status>('loading');
  const [groupName, setGroupName] = useState('');
  const [purpose,   setPurpose]   = useState('');
  const [error,     setError]     = useState('');

  useEffect(() => {
    apiFetch(`/api/invites/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.status !== 'success') throw new Error(data.message || t('jgErrInviteNotFound', lang));
        setGroupName(data.group.name);
        setPurpose(data.group.purpose || '');
        setStatus('preview');
      })
      .catch(err => {
        setError(err.message || t('jgErrInviteCouldNotFind', lang));
        setStatus('error');
      });
  }, [token]);

  const handleAccept = async () => {
    setStatus('joining');
    setError('');
    try {
      const res  = await apiFetch(`/api/invites/${token}/accept`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('jgErrJoinFailed', lang));
      onDone({ joined: true, groupId: data.group_id, groupName: data.group_name });
    } catch (err: any) {
      setError(err.message || t('jgErrJoinFailedPeriod', lang));
      setStatus('preview');
    }
  };

  return (
    <div className="jg-root">
      <div className="jg-panel">
        <div className="jg-corner jg-tl" /><div className="jg-corner jg-tr" />
        <div className="jg-corner jg-bl" /><div className="jg-corner jg-br" />

        <span className="jg-kicker">GONYA — GROUP INVITE</span>

        {status === 'loading' && <p className="jg-status">{t('jgCheckingInvite', lang)}</p>}

        {status === 'error' && (
          <>
            <h2 className="jg-title">{t('jgInviteUnavailable', lang)}</h2>
            <p className="jg-desc">&gt; {error}</p>
            <button className="jg-btn-secondary" onClick={() => onDone({ joined: false })}>
              {t('jgContinueToGonya', lang)}
            </button>
          </>
        )}

        {(status === 'preview' || status === 'joining') && (
          <>
            <h2 className="jg-title">{groupName}</h2>
            {purpose && <p className="jg-purpose">{purpose}</p>}
            <p className="jg-desc">{t('jgInvitedDesc', lang)}</p>
            {error && <p className="jg-error">&gt; {error}</p>}
            <div className="jg-actions">
              <button className="jg-btn-secondary" onClick={() => onDone({ joined: false })} disabled={status === 'joining'}>
                {t('jgDecline', lang)}
              </button>
              <button className="jg-btn-primary" onClick={handleAccept} disabled={status === 'joining'}>
                {status === 'joining' ? t('jgJoiningBtn', lang) : t('jgAcceptJoinBtn', lang)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
