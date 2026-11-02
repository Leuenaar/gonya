import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './GroupSettingsPanel.css';

interface AgentConfig {
  idle_trigger_enabled?: boolean;
  idle_trigger_minutes?: number;
  aksel_focus?:    string;
  vera_focus?:     string;
  aksel_triggers?: string[];
  vera_triggers?:  string[];
}

interface Props {
  groupId: string;
  onClose: () => void;
  lang?:   string | null;
}

// Fase 11 item #3 (22 Aug 2026) — exposes agent_config fields that were
// ALREADY live in the backend (groupJudge.js reads aksel_focus/
// vera_focus/aksel_triggers/vera_triggers, groupIdleTrigger.js reads
// idle_trigger_enabled/idle_trigger_minutes) but had no UI to edit them —
// only a raw DB edit could change them before this.
//
// IMPORTANT correctness note: agent_config is ONE jsonb column, and the
// backend's PATCH /api/groups/:id REPLACES it wholesale, it does not
// merge. Every save below therefore spreads `agentConfig` (the full
// object kept in state from the initial fetch) before layering this
// section's own changes on top — saving one section must never silently
// wipe out what another section already has stored there.
export default function GroupSettingsPanel({ groupId, onClose, lang }: Props) {
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');

  // Section 1 — Info Grup
  const [name,       setName]       = useState('');
  const [purpose,    setPurpose]    = useState('');
  const [milestones, setMilestones] = useState('');
  const [savingInfo, setSavingInfo] = useState(false);
  const [infoMsg,    setInfoMsg]    = useState('');

  // Full agent_config, kept in sync after every successful save so the
  // NEXT section's save merges against the latest known state, not a
  // stale snapshot from page load.
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({});

  // Section 2 — Perilaku Agent
  const [akselFocus,       setAkselFocus]       = useState('');
  const [veraFocus,        setVeraFocus]        = useState('');
  const [akselTriggers,    setAkselTriggers]    = useState<string[]>([]);
  const [veraTriggers,     setVeraTriggers]     = useState<string[]>([]);
  const [akselTriggerInput, setAkselTriggerInput] = useState('');
  const [veraTriggerInput,  setVeraTriggerInput]  = useState('');
  const [savingBehavior,   setSavingBehavior]   = useState(false);
  const [behaviorMsg,      setBehaviorMsg]      = useState('');

  // Section 3 — Check-in Otomatis
  const [idleEnabled, setIdleEnabled] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState('');
  const [savingIdle,  setSavingIdle]  = useState(false);
  const [idleMsg,     setIdleMsg]     = useState('');

  useEffect(() => {
    apiFetch(`/api/groups/${groupId}`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          const g = data.group;
          setName(g.name || '');
          setPurpose(g.purpose || '');
          setMilestones(g.milestones || '');
          const cfg: AgentConfig = g.agent_config || {};
          setAgentConfig(cfg);
          setAkselFocus(cfg.aksel_focus || '');
          setVeraFocus(cfg.vera_focus || '');
          setAkselTriggers(cfg.aksel_triggers || []);
          setVeraTriggers(cfg.vera_triggers || []);
          setIdleEnabled(cfg.idle_trigger_enabled !== false); // default ON, matches groupIdleTrigger.js's own default
          setIdleMinutes(typeof cfg.idle_trigger_minutes === 'number' ? String(cfg.idle_trigger_minutes) : '');
        } else {
          setLoadError(data.message || t('failedToLoadGroupSettings', lang));
        }
      })
      .catch(() => setLoadError(t('connErrorLoadingGroupSettings', lang)))
      .finally(() => setLoading(false));
  }, [groupId]);

  const showMsg = (setter: (m: string) => void, msg: string) => {
    setter(msg);
    setTimeout(() => setter(''), 3000);
  };

  const handleSaveInfo = async () => {
    setSavingInfo(true);
    try {
      const res  = await apiFetch(`/api/groups/${groupId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), purpose: purpose.trim(), milestones: milestones.trim() }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      showMsg(setInfoMsg, `✓ ${t('savedMsg', lang)}`);
    } catch (err: any) {
      showMsg(setInfoMsg, `✗ ${err.message || t('saveFailed', lang)}`);
    } finally {
      setSavingInfo(false);
    }
  };

  const handleSaveBehavior = async () => {
    setSavingBehavior(true);
    try {
      const merged: AgentConfig = {
        ...agentConfig, // preserve idle_trigger_* from the other section
        aksel_focus:    akselFocus.trim(),
        vera_focus:     veraFocus.trim(),
        aksel_triggers: akselTriggers,
        vera_triggers:  veraTriggers,
      };
      const res  = await apiFetch(`/api/groups/${groupId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ agent_config: merged }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setAgentConfig(merged);
      showMsg(setBehaviorMsg, `✓ ${t('savedMsg', lang)}`);
    } catch (err: any) {
      showMsg(setBehaviorMsg, `✗ ${err.message || t('saveFailed', lang)}`);
    } finally {
      setSavingBehavior(false);
    }
  };

  const handleSaveIdle = async () => {
    setSavingIdle(true);
    try {
      const trimmedMinutes = idleMinutes.trim();
      const parsedMinutes  = trimmedMinutes === '' ? undefined : parseInt(trimmedMinutes, 10);
      const merged: AgentConfig = {
        ...agentConfig, // preserve aksel_focus/vera_focus/*_triggers from the other section
        idle_trigger_enabled: idleEnabled,
        ...(parsedMinutes !== undefined && !isNaN(parsedMinutes) ? { idle_trigger_minutes: parsedMinutes } : {}),
      };
      const res  = await apiFetch(`/api/groups/${groupId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ agent_config: merged }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message);
      setAgentConfig(merged);
      showMsg(setIdleMsg, `✓ ${t('savedMsg', lang)}`);
    } catch (err: any) {
      showMsg(setIdleMsg, `✗ ${err.message || t('saveFailed', lang)}`);
    } finally {
      setSavingIdle(false);
    }
  };

  // ── Tag-input helpers (trigger keyword chips) ──────────────────────────
  const addTrigger = (
    list: string[], setList: (v: string[]) => void,
    input: string, setInput: (v: string) => void
  ) => {
    const trimmed = input.trim();
    if (!trimmed || list.includes(trimmed)) { setInput(''); return; }
    setList([...list, trimmed]);
    setInput('');
  };
  const removeTrigger = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.filter(x => x !== item));
  };
  const handleTriggerKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    list: string[], setList: (v: string[]) => void,
    input: string, setInput: (v: string) => void
  ) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTrigger(list, setList, input, setInput);
    }
  };

  return (
    <div className="gsp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gsp-panel">
        <div className="gsp-header">
          <span className="gsp-label">{t('groupSettingsLabel', lang)}</span>
          <button className="gsp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="gsp-body">
          {loading ? (
            <p className="gsp-loading">{t('loadingDots', lang)}</p>
          ) : loadError ? (
            <p className="gsp-msg err">✗ {loadError}</p>
          ) : (
            <>
              {/* ── Section 1: Info Grup ── */}
              <div className="gsp-section">
                <span className="gsp-section-label">{t('groupInfoSectionLabel', lang)}</span>
                <div className="gsp-field">
                  <label className="gsp-field-label">{t('fieldGroupName', lang)}</label>
                  <input className="gsp-input" value={name} onChange={e => setName(e.target.value)} disabled={savingInfo} />
                </div>
                <div className="gsp-field">
                  <label className="gsp-field-label">{t('fieldGroupPurpose', lang)}</label>
                  <textarea className="gsp-textarea" value={purpose} onChange={e => setPurpose(e.target.value)} disabled={savingInfo} rows={2} />
                </div>
                <div className="gsp-field">
                  <label className="gsp-field-label">{t('fieldGroupMilestones', lang)}</label>
                  <textarea className="gsp-textarea" value={milestones} onChange={e => setMilestones(e.target.value)} disabled={savingInfo} rows={2} />
                </div>
                <div className="gsp-section-footer">
                  {infoMsg && <span className={`gsp-msg ${infoMsg.startsWith('✓') ? 'ok' : 'err'}`}>{infoMsg}</span>}
                  <button className="gsp-save-btn" onClick={handleSaveInfo} disabled={savingInfo || !name.trim()}>
                    {savingInfo ? t('savingBtn', lang) : t('btnSave', lang)}
                  </button>
                </div>
              </div>

              {/* ── Section 2: Perilaku Agent ── */}
              <div className="gsp-section">
                <span className="gsp-section-label">{t('agentBehaviorSectionLabel', lang)}</span>

                <div className="gsp-field">
                  <label className="gsp-field-label gsp-field-label-aksel">{t('fieldAkselFocus', lang)}</label>
                  <textarea className="gsp-textarea" value={akselFocus} onChange={e => setAkselFocus(e.target.value)} disabled={savingBehavior} rows={2} />
                </div>
                <div className="gsp-field">
                  <label className="gsp-field-label gsp-field-label-aksel">{t('fieldAkselTriggers', lang)}</label>
                  <div className="gsp-tag-input">
                    {akselTriggers.map(tag => (
                      <span key={tag} className="gsp-tag">
                        {tag}
                        <button type="button" onClick={() => removeTrigger(akselTriggers, setAkselTriggers, tag)} disabled={savingBehavior} aria-label={`Remove ${tag}`}>×</button>
                      </span>
                    ))}
                    <input
                      className="gsp-tag-input-field"
                      value={akselTriggerInput}
                      onChange={e => setAkselTriggerInput(e.target.value)}
                      onKeyDown={e => handleTriggerKeyDown(e, akselTriggers, setAkselTriggers, akselTriggerInput, setAkselTriggerInput)}
                      onBlur={() => addTrigger(akselTriggers, setAkselTriggers, akselTriggerInput, setAkselTriggerInput)}
                      placeholder={t('triggerInputPlaceholder', lang)}
                      disabled={savingBehavior}
                    />
                  </div>
                </div>

                <div className="gsp-field">
                  <label className="gsp-field-label gsp-field-label-vera">{t('fieldVeraFocus', lang)}</label>
                  <textarea className="gsp-textarea" value={veraFocus} onChange={e => setVeraFocus(e.target.value)} disabled={savingBehavior} rows={2} />
                </div>
                <div className="gsp-field">
                  <label className="gsp-field-label gsp-field-label-vera">{t('fieldVeraTriggers', lang)}</label>
                  <div className="gsp-tag-input">
                    {veraTriggers.map(tag => (
                      <span key={tag} className="gsp-tag">
                        {tag}
                        <button type="button" onClick={() => removeTrigger(veraTriggers, setVeraTriggers, tag)} disabled={savingBehavior} aria-label={`Remove ${tag}`}>×</button>
                      </span>
                    ))}
                    <input
                      className="gsp-tag-input-field"
                      value={veraTriggerInput}
                      onChange={e => setVeraTriggerInput(e.target.value)}
                      onKeyDown={e => handleTriggerKeyDown(e, veraTriggers, setVeraTriggers, veraTriggerInput, setVeraTriggerInput)}
                      onBlur={() => addTrigger(veraTriggers, setVeraTriggers, veraTriggerInput, setVeraTriggerInput)}
                      placeholder={t('triggerInputPlaceholder', lang)}
                      disabled={savingBehavior}
                    />
                  </div>
                </div>

                <div className="gsp-section-footer">
                  {behaviorMsg && <span className={`gsp-msg ${behaviorMsg.startsWith('✓') ? 'ok' : 'err'}`}>{behaviorMsg}</span>}
                  <button className="gsp-save-btn" onClick={handleSaveBehavior} disabled={savingBehavior}>
                    {savingBehavior ? t('savingBtn', lang) : t('btnSave', lang)}
                  </button>
                </div>
              </div>

              {/* ── Section 3: Check-in Otomatis ── */}
              <div className="gsp-section">
                <span className="gsp-section-label">{t('idleCheckinSectionLabel', lang)}</span>

                <div className="gsp-field">
                  <label className="gsp-field-label">{t('fieldIdleEnabled', lang)}</label>
                  <div className="gsp-toggle-group">
                    <button
                      className={`gsp-toggle-btn ${idleEnabled ? 'active' : ''}`}
                      onClick={() => setIdleEnabled(true)}
                      disabled={savingIdle}
                    >
                      {t('optOn', lang)}
                    </button>
                    <button
                      className={`gsp-toggle-btn ${!idleEnabled ? 'active' : ''}`}
                      onClick={() => setIdleEnabled(false)}
                      disabled={savingIdle}
                    >
                      {t('optOff', lang)}
                    </button>
                  </div>
                </div>

                <div className="gsp-field">
                  <label className="gsp-field-label">{t('fieldIdleMinutes', lang)}</label>
                  <input
                    className="gsp-input"
                    type="number"
                    min={0}
                    value={idleMinutes}
                    onChange={e => setIdleMinutes(e.target.value)}
                    placeholder={t('idleMinutesPlaceholder', lang)}
                    disabled={savingIdle || !idleEnabled}
                  />
                </div>

                <div className="gsp-section-footer">
                  {idleMsg && <span className={`gsp-msg ${idleMsg.startsWith('✓') ? 'ok' : 'err'}`}>{idleMsg}</span>}
                  <button className="gsp-save-btn" onClick={handleSaveIdle} disabled={savingIdle}>
                    {savingIdle ? t('savingBtn', lang) : t('btnSave', lang)}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
