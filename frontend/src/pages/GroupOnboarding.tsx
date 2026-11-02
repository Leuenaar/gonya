import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../lib/supabase';
import { t } from '../lib/i18n';
import './GroupOnboarding.css';

interface Props {
  groupId:   string;
  groupName: string;
  onComplete: () => void;
  lang?:     string | null; // drives translated UI text (Fase 8)
  isAnonymous?: boolean;
}

interface Question {
  id:      string;
  text:    string;
  options: string[];
}

type Step = 'intro' | 'questions' | 'loading' | 'done';

const LOADING_LOGS = [
  '> TheOnes protocol initializing...',
  '> Analyzing group context...',
  '> Defining project scope [1/3]...',
  '> Mapping milestones [2/3]...',
  '> Building team context [3/3]...',
  '> Configuring Aksel for this group...',
  '> Configuring Vera for this group...',
  '> Finalizing agent architecture...',
  '> Group intelligence ready.',
];

export default function GroupOnboarding({ groupId, groupName, onComplete, lang, isAnonymous }: Props) {
  const [step,      setStep]      = useState<Step>('intro');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers,   setAnswers]   = useState<string[]>([]);
  const [loadIdx,   setLoadIdx]   = useState(0);
  const [loadLogs,  setLoadLogs]  = useState<string[]>([]);
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll loading log
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [loadLogs]);

  // Tick through loading logs while running
  useEffect(() => {
    if (step !== 'loading') return;
    setLoadLogs([LOADING_LOGS[0]]);
    let i = 1;
    const id = setInterval(() => {
      if (i < LOADING_LOGS.length) {
        setLoadLogs(prev => [...prev, LOADING_LOGS[i]]);
        i++;
      } else {
        clearInterval(id);
      }
    }, 1800);
    return () => clearInterval(id);
  }, [step]);

  const fetchQuestions = async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/onboard/questions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: groupName }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('goErrLoadQuestions', lang));
      setQuestions(data.questions);
      setAnswers(new Array(data.questions.length).fill(''));
      setStep('questions');
    } catch (err: any) {
      setError(err.message || t('errSomethingWrong', lang));
    } finally {
      setLoading(false);
    }
  };

  // Bug fixed/designed (10 Sep 2026): mirrors OnboardingShell.tsx's own
  // isAnonymous branch — a demo/anonymous owner skips straight from
  // 'intro' to the pre-built general group config (routes/groups.js's
  // /onboard-demo), bypassing the 3-question + Opus pipeline entirely.
  // There's no meaningful "quick step" to preserve here the way personal
  // onboarding kept gender/language-style — a group's whole point is the
  // specific project it's onboarded around, so for a demo group that
  // step is skipped outright rather than partially kept.
  const runDemoOnboarding = async () => {
    setError('');
    setLoading(true);
    setStep('loading');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/onboard-demo`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('goErrOnboardFailed', lang));
      setStep('done');
      setTimeout(onComplete, 2000);
    } catch (err: any) {
      setError(err.message || t('goErrOnboardRetry', lang));
      setStep('intro');
    } finally {
      setLoading(false);
    }
  };


  const runOnboarding = async () => {
    if (answers.some(a => !a)) {
      setError(t('goErrAnswerAll', lang));
      return;
    }
    setError('');
    setStep('loading');
    try {
      const res  = await apiFetch(`/api/groups/${groupId}/onboard`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ answers, name: groupName }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || t('goErrOnboardFailed', lang));
      setStep('done');
      setTimeout(onComplete, 2000);
    } catch (err: any) {
      setError(err.message || t('goErrOnboardRetry', lang));
      setStep('questions');
    }
  };

  const stepNum = step === 'intro' ? 1 : step === 'questions' ? 2 : 3;

  return (
    <div className="go-root">
      <div className="go-scanline" aria-hidden="true" />

      <header className="go-header">
        <span className="go-kicker">GONYA — GROUP PROTOCOL</span>
        <h1 className="go-title">{groupName}</h1>
        <div className="go-bar">
          <span className="go-step-label">{t('goStepOf', lang, { n: stepNum })}</span>
          <span className="go-motto">Thought, undivided.</span>
          <span className="go-sys">TheOnes // ACTIVE</span>
        </div>
        <div className="go-steps">
          {[1, 2, 3].map(n => (
            <div key={n} className={`go-step-dot ${n <= stepNum ? 'active' : ''}`} />
          ))}
        </div>
      </header>

      <main className="go-main">

        {/* ── Intro ── */}
        {step === 'intro' && (
          <div className="go-panel">
            <div className="go-corner go-tl" /><div className="go-corner go-tr" />
            <div className="go-corner go-bl" /><div className="go-corner go-br" />
            <span className="go-phase-label">{t('goPhaseLabel1', lang)}</span>
            <h2 className="go-phase-title">{t('goPhaseTitle1', lang)}</h2>
            <p className="go-desc">
              {t('goDesc1', lang)}
            </p>
            <p className="go-desc go-desc-muted">
              {t('goDesc2', lang)}
            </p>
            {error && <p className="go-error">&gt; {error}</p>}
            <button className="go-next-btn" onClick={isAnonymous ? runDemoOnboarding : fetchQuestions} disabled={loading}>
              {loading ? t('goLoadingBtn', lang) : t('goBeginBtn', lang)}
            </button>
          </div>
        )}

        {/* ── Questions ── */}
        {step === 'questions' && (
          <div className="go-panel go-panel-wide">
            <div className="go-corner go-tl" /><div className="go-corner go-tr" />
            <div className="go-corner go-bl" /><div className="go-corner go-br" />
            <span className="go-phase-label">{t('goPhaseLabel2', lang)}</span>
            <h2 className="go-phase-title">{t('goPhaseTitle2', lang)}</h2>

            {questions.map((q, qi) => (
              <div key={q.id} className="go-question">
                <p className="go-question-text">
                  <span className="go-q-num">{String(qi + 1).padStart(2, '0')}</span>
                  {q.text}
                </p>
                <div className="go-options">
                  {q.options.map((opt) => (
                    <button
                      key={opt}
                      className={`go-option-btn ${answers[qi] === opt ? 'selected' : ''}`}
                      onClick={() => setAnswers(prev => {
                        const next = [...prev];
                        next[qi] = opt;
                        return next;
                      })}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {error && <p className="go-error">&gt; {error}</p>}
            <div className="go-nav-row">
              <button className="go-back-btn" onClick={() => setStep('intro')}>{t('goBackBtn', lang)}</button>
              <button
                className="go-next-btn"
                onClick={runOnboarding}
                disabled={answers.some(a => !a)}
              >
                {t('goRunBtn', lang)}
              </button>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {(step === 'loading' || step === 'done') && (
          <div className="go-panel go-panel-terminal">
            <div className="go-corner go-tl" /><div className="go-corner go-tr" />
            <div className="go-corner go-bl" /><div className="go-corner go-br" />
            <span className="go-phase-label">{t('goPhaseLabel3', lang)}</span>
            <h2 className="go-phase-title">
              {step === 'done' ? t('goReadyTitle', lang) : t('goConfiguringTitle', lang)}
            </h2>
            <div className="go-log" ref={logRef}>
              {loadLogs.map((l, i) => (
                <div key={i} className={`go-log-line ${i === loadLogs.length - 1 && step !== 'done' ? 'go-log-active' : ''}`}>
                  {l}
                </div>
              ))}
              {step === 'done' && (
                <div className="go-log-line go-log-success">{t('goSuccessLog', lang)}</div>
              )}
            </div>
            {step === 'loading' && (
              <div className="go-spinner">
                <span /><span /><span />
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
