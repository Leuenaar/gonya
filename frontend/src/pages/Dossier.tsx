import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './Dossier.css';

interface DossierItem {
  id:          string;
  name:        string;
  description: string | null;
  color:       string;
  created_at:  string;
  updated_at:  string;
}

interface DossierMessage {
  id:         string;
  sender:     string;
  content:    string;
  created_at: string;
}

interface DossierFile {
  id:               string;
  file_name:        string;
  file_type:        string;
  storage_provider: string;
  size_bytes:       number;
  created_at:       string;
  expires_at:       string | null;
}

const COLORS = ['#00e5ff', '#f59e0b', '#a78bfa', '#34d399', '#f87171', '#60a5fa'];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const fmtSize = (bytes: number) => {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function Dossier({ lang }: { lang?: string | null } = {}) {
  const [dossiers,     setDossiers]     = useState<DossierItem[]>([]);
  const [selected,     setSelected]     = useState<DossierItem | null>(null);
  const [messages,     setMessages]     = useState<DossierMessage[]>([]);
  const [files,        setFiles]        = useState<DossierFile[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [creating,     setCreating]     = useState(false);
  const [newName,      setNewName]      = useState('');
  const [newDesc,      setNewDesc]      = useState('');
  const [newColor,     setNewColor]     = useState('#00e5ff');
  const [saving,       setSaving]       = useState(false);
  const [contentsTab,  setContentsTab]  = useState<'messages' | 'files'>('messages');

  // ── Load all dossiers ──────────────────────────────────
  const loadDossiers = async () => {
    setLoading(true);
    try {
      const res  = await apiFetch('/api/dossiers');
      const data = await res.json();
      if (data.status === 'success') setDossiers(data.data || []);
    } catch {} finally { setLoading(false); }
  };

  // ── Load contents of selected dossier ─────────────────
  const loadContents = async (id: string) => {
    try {
      const res  = await apiFetch(`/api/dossiers/${id}/contents`);
      const data = await res.json();
      if (data.status === 'success') {
        setMessages(data.data.messages || []);
        setFiles(data.data.files || []);
      }
    } catch {}
  };

  useEffect(() => { loadDossiers(); }, []);

  useEffect(() => {
    if (selected) loadContents(selected.id);
    else { setMessages([]); setFiles([]); }
  }, [selected]);

  // ── Create dossier ─────────────────────────────────────
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const res  = await apiFetch('/api/dossiers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null, color: newColor }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setDossiers(prev => [data.data, ...prev]);
        setNewName(''); setNewDesc(''); setNewColor('#00e5ff');
        setCreating(false);
        setSelected(data.data);
      }
    } catch {} finally { setSaving(false); }
  };

  // ── Delete dossier ─────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (!confirm(t('dosConfirmDelete', lang))) return;
    try {
      await apiFetch(`/api/dossiers/${id}`, { method: 'DELETE' });
      setDossiers(prev => prev.filter(d => d.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch {}
  };

  const fileIcon = (type: string) => {
    if (type.startsWith('image/'))                     return '🖼';
    if (type === 'application/pdf')                    return '📄';
    if (type.includes('spreadsheet') || type.includes('excel')) return '📊';
    if (type.includes('word') || type.includes('document'))     return '📝';
    return '📎';
  };

  return (
    <div className="dos-root">

      {/* ── Sidebar ── */}
      <div className="dos-sidebar">
        <div className="dos-sidebar-header">
          <span className="dos-sidebar-title">{t('dosTitle', lang)}</span>
          <button className="dos-new-btn" onClick={() => setCreating(p => !p)}>
            {creating ? '×' : t('dosNewBtn', lang)}
          </button>
        </div>

        {creating && (
          <div className="dos-create-form">
            <input
              className="dos-input"
              placeholder={t('dosPlaceholderName', lang)}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <input
              className="dos-input"
              placeholder={t('dosPlaceholderDesc', lang)}
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
            <div className="dos-color-row">
              {COLORS.map(c => (
                <button
                  key={c}
                  className={`dos-color-dot ${newColor === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
            <div className="dos-create-actions">
              <button className="dos-btn dos-btn-ghost" onClick={() => setCreating(false)}>{t('btnCancel', lang)}</button>
              <button className="dos-btn dos-btn-primary" onClick={handleCreate} disabled={!newName.trim() || saving}>
                {saving ? t('dosCreating', lang) : t('dosCreateBtn', lang)}
              </button>
            </div>
          </div>
        )}

        <div className="dos-list">
          {loading && <div className="dos-empty">{t('loadingDots', lang)}</div>}
          {!loading && dossiers.length === 0 && (
            <div className="dos-empty">{t('dosNoDossiers', lang)}</div>
          )}
          {dossiers.map(d => (
            <div
              key={d.id}
              className={`dos-item ${selected?.id === d.id ? 'active' : ''}`}
              onClick={() => setSelected(prev => prev?.id === d.id ? null : d)}
            >
              <div className="dos-item-accent" style={{ background: d.color }} />
              <div className="dos-item-body">
                <div className="dos-item-name">{d.name}</div>
                {d.description && <div className="dos-item-desc">{d.description}</div>}
                <div className="dos-item-meta">{fmtDate(d.updated_at)}</div>
              </div>
              <button
                className="dos-item-del"
                onClick={e => { e.stopPropagation(); handleDelete(d.id); }}
                title={t('deleteAction', lang)}>×</button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="dos-main">
        {!selected ? (
          <div className="dos-empty-state">
            <div className="dos-empty-icon">⬡</div>
            <div className="dos-empty-title">{t('dosSelectTitle', lang)}</div>
            <div className="dos-empty-sub">
              {t('dosSelectDesc1', lang)}<br/>
              {t('dosSelectDesc2', lang)}
            </div>
          </div>
        ) : (
          <>
            <div className="dos-header">
              <div className="dos-header-dot" style={{ background: selected.color }} />
              <div>
                <div className="dos-header-name">{selected.name}</div>
                {selected.description && <div className="dos-header-desc">{selected.description}</div>}
              </div>
              <div className="dos-header-meta">
                <span>{t('dosMessagesCount', lang, { n: messages.length })}</span>
                <span>·</span>
                <span>{t('dosFilesCount', lang, { n: files.length })}</span>
                <span>·</span>
                <span>{t('dosUpdated', lang, { date: fmtDate(selected.updated_at) })}</span>
              </div>
            </div>

            <div className="dos-tabs">
              <button
                className={`dos-tab ${contentsTab === 'messages' ? 'active' : ''}`}
                onClick={() => setContentsTab('messages')}>
                {t('dosTabMessages', lang, { n: messages.length })}
              </button>
              <button
                className={`dos-tab ${contentsTab === 'files' ? 'active' : ''}`}
                onClick={() => setContentsTab('files')}>
                {t('dosTabFiles', lang, { n: files.length })}
              </button>
            </div>

            <div className="dos-contents">
              {contentsTab === 'messages' && (
                messages.length === 0 ? (
                  <div className="dos-empty">{t('dosNoMessages', lang)}</div>
                ) : (
                  messages.map(m => (
                    <div key={m.id} className={`dos-msg dos-msg-${m.sender.toLowerCase()}`}>
                      <span className="dos-msg-sender">{m.sender}</span>
                      <div className="dos-msg-content">{m.content}</div>
                      <span className="dos-msg-time">{fmtDate(m.created_at)}</span>
                    </div>
                  ))
                )
              )}

              {contentsTab === 'files' && (
                files.length === 0 ? (
                  <div className="dos-empty">{t('dosNoFiles', lang)}</div>
                ) : (
                  <div className="dos-file-grid">
                    {files.map(f => (
                      <div key={f.id} className="dos-file-card">
                        <div className="dos-file-icon">{fileIcon(f.file_type)}</div>
                        <div className="dos-file-name" title={f.file_name}>{f.file_name}</div>
                        <div className="dos-file-meta">
                          <span>{fmtSize(f.size_bytes)}</span>
                          {f.expires_at && (
                            <span className="dos-file-expiry">
                              {t('dosExpires', lang, { date: fmtDate(f.expires_at) })}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}