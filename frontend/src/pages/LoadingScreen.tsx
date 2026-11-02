import { useState, useEffect, useRef } from 'react';
import { apiFetch, type UserProfile } from '../lib/supabase';
import GonyaMascot, { type GonyaState } from '../components/GonyaMascot';
import { t } from '../lib/i18n';
import './LoadingScreen.css';

interface Props {
  profile:    UserProfile;
  onComplete: () => void;
}

type LogType = 'normal' | 'success' | 'highlight';
interface LogEntry { text: string; type: LogType; }

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const GHOST_LEFT = [
  'AI deployment patterns shift across enterprise stacks',
  'Cloud-native SaaS migration frameworks gain traction',
  'Critical API vulnerabilities disclosed in major platforms',
  'Enterprise software consolidation trends accelerating',
  'B2B SaaS valuations under pressure amid enterprise cuts',
  'Agentic workflows redefine human-software interaction',
];

const GHOST_RIGHT = [
  'Stackwise — AI-powered SaaS audit platform',
  'Rippling HRIS 3.0 — unified workforce management',
  'Notion AI for Teams — collaborative intelligence',
  'Linear Enterprise Suite — engineering ops at scale',
  'Retool Workflows v2 — internal tool automation',
  'Hex raises $50M — collaborative data notebooks',
];

export default function LoadingScreen({ profile, onComplete }: Props) {
  const [logs,        setLogs]        = useState<LogEntry[]>([]);
  const [progress,    setProgress]    = useState(0);
  const [done,        setDone]        = useState(false);
  const [mascotState, setMascotState] = useState<GonyaState>('idle');
  const hasRun = useRef(false);

  const addLog = (text: string, type: LogType = 'normal') =>
    setLogs(prev => [...prev, { text, type }]);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const run = async () => {
      await delay(400);
      // Bug fixed (10 Sep 2026): confirmed via real testing — demo
      // (anonymous) users can have a null display_name (the
      // handle_new_user() DB trigger has no email/metadata to derive one
      // from for them), and .toLowerCase() on null threw uncaught right
      // here, silently killing this whole async chain before progress
      // ever left its initial 0% — matching the exact "stuck at 0%"
      // symptom reported. Same fallback ("Agent") already used for this
      // identical null case in middleware/auth.js, for consistency.
      addLog(t('lsAgentAuthenticated', profile.language, { name: (profile.display_name || 'Agent').toLowerCase() }));
      setProgress(12);

      await delay(500);
      addLog(t('lsVerifyingBackend', profile.language));
      setMascotState('focused');
      setProgress(22);

      let backendOk = false;
      try {
        const res  = await apiFetch('/api/health');
        const data = await res.json();
        backendOk  = data.status === 'success' && data.checks?.database === true;
      } catch {}

      await delay(350);
      addLog(
        backendOk ? t('lsBackendOnline', profile.language) : t('lsBackendDegraded', profile.language),
        backendOk ? 'success' : 'normal'
      );
      if (!backendOk) setMascotState('worried');
      setProgress(38);

      await delay(500);
      addLog(t('lsInitAgentLayer', profile.language));
      setProgress(50);

      await delay(450);
      addLog(t('lsAkselAuthorized', profile.language), 'success');
      setMascotState('happy');
      setProgress(62);

      await delay(400);
      addLog(t('lsVeraAuthorized', profile.language), 'success');
      setProgress(74);

      await delay(500);
      addLog(t('lsCalibratingMemory', profile.language));
      setProgress(83);

      await delay(400);
      addLog(t('lsKnowledgeLoaded', profile.language), 'success');
      setProgress(92);

      await delay(450);
      const role = profile.role?.toUpperCase() === 'ADMIN' ? 'ADMIN' : 'MEMBER';
      addLog(
        t('lsClearanceLevel', profile.language, { role, name: (profile.display_name || 'Agent').toUpperCase() }),
        'highlight'
      );
      setProgress(97);

      await delay(500);
      addLog(t('lsAllSystemsOnline', profile.language), 'success');
      setProgress(100);

      await delay(600);
      setMascotState('walking');
      await delay(900);
      setDone(true);
      await delay(500);
      onComplete();
    };

    run();
  }, []);

  return (
    <div className={`ls-root${done ? ' ls-done' : ''}`}>

      {/* ── Top bar ── */}
      <div className="ls-topbar">
        <div className="ls-topbar-title">Gonya</div>
        <div className="ls-topbar-bar">
          <span className="ls-topbar-left">Loading Session</span>
          <span className="ls-topbar-right">Please Wait</span>
        </div>
      </div>

      {/* ── Ghost left column ── */}
      <aside className="ls-side ls-side-l" aria-hidden="true">
        <h2 className="ls-side-title">MACRO INTEL</h2>
        {GHOST_LEFT.map((h, i) => (
          <div key={i} className="ls-side-item">
            <span className="ls-side-src">FEED // LOCKED</span>
            <p className="ls-side-headline">{h}</p>
          </div>
        ))}
        <div className="ls-side-footer">[ ENCRYPTED_STREAM_NODE_A ]</div>
      </aside>

      {/* ── Ghost right column ── */}
      <aside className="ls-side ls-side-r" aria-hidden="true">
        <h2 className="ls-side-title">MICRO RADAR</h2>
        {GHOST_RIGHT.map((h, i) => (
          <div key={i} className="ls-side-item">
            <span className="ls-side-src">FEED // LOCKED</span>
            <p className="ls-side-headline">{h}</p>
          </div>
        ))}
        <div className="ls-side-footer">[ ENCRYPTED_STREAM_NODE_B ]</div>
      </aside>

      {/* ── Body ── */}
      <div className="ls-body">
        <div className="ls-panel">
          <div className="ls-c ls-tl"/><div className="ls-c ls-tr"/>
          <div className="ls-c ls-bl"/><div className="ls-c ls-br"/>

          <div className="ls-panel-header">
            <span className="ls-panel-left">Setting Up Your Assistants</span>
            <span className="ls-panel-right">In Progress</span>
          </div>

          <div className="ls-spacer"/>

          <div className="ls-terminal">
            {logs.map((log, i) => (
              <div key={i} className={`ls-log ls-log-${log.type}`}>
                {log.text}
              </div>
            ))}
          </div>

          <div className="ls-progress-wrap">
            <span className="ls-progress-label">{t('lsSynchronizing', profile.language)}</span>
            <div className="ls-progress-bar-wrap">
              <div className="ls-progress-bar" style={{ width: `${progress}%` }}/>
            </div>
            <span className="ls-progress-pct">{progress}%</span>
          </div>

        </div>
      </div>

      {/* ── Footer ── */}
      <div className="ls-footer">
        <span>GONYA SECURITY PROTOCOLS V4.9</span>
        <div className="ls-mascot-footer">
          <GonyaMascot state={mascotState} size={64} />
        </div>
        <span>Thought, undivided.</span>
      </div>

    </div>
  );
}
