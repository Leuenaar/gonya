import { useState } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './CreateGroupModal.css';

interface Props {
  onClose:   () => void;
  onCreated: (groupId: string, groupName: string) => void;
  lang?:     string | null; // drives translated UI text (Fase 8)
}

export default function CreateGroupModal({ onClose, onCreated, lang }: Props) {
  const [name,    setName]    = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(t('cgmErrNameRequired', lang)); return; }
    if (trimmed.length > 60) { setError(t('cgmErrNameTooLong', lang)); return; }

    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/groups', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('cgmErrCreateFailed', lang));
      onCreated(data.group.id, data.group.name);
    } catch (err: any) {
      setError(err.message || t('errSomethingWrong', lang));
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="cgm-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cgm-modal">
        <div className="cgm-corner cgm-tl" /><div className="cgm-corner cgm-tr" />
        <div className="cgm-corner cgm-bl" /><div className="cgm-corner cgm-br" />

        <div className="cgm-header">
          <span className="cgm-label">{t('cgmNewGroupLabel', lang)}</span>
          <button className="cgm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <h2 className="cgm-title">{t('cgmTitle', lang)}</h2>
        <p className="cgm-desc">
          {t('cgmDesc', lang)}
        </p>

        <div className="cgm-field">
          <label className="cgm-field-label">{t('cgmFieldGroupName', lang)}</label>
          <input
            className="cgm-input"
            value={name}
            onChange={e => { setName(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            placeholder={t('cgmPlaceholder', lang)}
            maxLength={60}
            autoFocus
            disabled={loading}
          />
          <span className="cgm-char-count">{name.length}/60</span>
        </div>

        {error && <p className="cgm-error">&gt; {error}</p>}

        <div className="cgm-footer">
          <button className="cgm-btn-ghost" onClick={onClose} disabled={loading}>{t('btnCancel', lang)}</button>
          <button className="cgm-btn-primary" onClick={handleCreate} disabled={loading || !name.trim()}>
            {loading ? t('cgmCreating', lang) : t('cgmCreateBtn', lang)}
          </button>
        </div>
      </div>
    </div>
  );
}
