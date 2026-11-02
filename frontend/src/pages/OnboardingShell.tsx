import { useState, useEffect, useRef } from 'react';
import { supabase, apiFetch, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import './OnboardingShell.css';

interface Props {
  profile:     UserProfile;
  isAnonymous: boolean;
  onComplete:  (p: UserProfile) => void;
}

type Gender    = 'male' | 'female';
type LangStyle = 'casual' | 'formal';
type Language  = 'id' | 'en';
type Step      = 1 | 2 | 'questions' | 'loading' | 3;

interface Question {
  id:      string;
  text:    string;
  options: string[];
}

// Checkpoint snapshot (29 Aug 2026): stores all onboarding progress in
// user_profiles.onboarding_state (JSONB), so a refresh mid-flow resumes
// from the last step instead of starting over. onboardSucceeded is the
// most important flag: once true it stays true, and it forces a resume
// at step 3 whatever `step` says, so the expensive generative call to
// /api/theones/onboard is never repeated because of a refresh.
interface OnboardingState {
  ageVerified:      boolean;
  step:             Step;
  gender:           Gender | null;
  langStyle:        LangStyle | null;
  language:         Language;
  domain:           string;
  selCategory:      string | null;
  selSub:           string | null;
  questions:        Question[];
  answers:          Record<string, string>;
  radarSel:         string[];
  onboardSucceeded: boolean;
}

const TAXONOMY: Record<string, string[]> = {
  'Research':   ['Thesis', 'Dissertation', 'Academic Journal', 'Research Report', 'Paper'],
  'Business':   ['Startup', 'F&B', 'E-commerce', 'Consulting', 'SME'],
  'Technology': ['Software Dev', 'Data Science', 'Cybersecurity', 'AI/ML', 'DevOps'],
  'Career':     ['Marketing', 'Finance', 'HR', 'Product Management', 'Biz Dev'],
  'Creative':   ['Content Creator', 'Graphic Design', 'Copywriting', 'Photography', 'Video'],
};

const RADAR_CATEGORIES = [
  'Business', 'Technology', 'Science', 'Health',
  'Politics', 'World', 'Marketing', 'Finance',
  'Education', 'Environment', 'Culture', 'Entertainment',
];

const LOADING_LOGS = [
  '> Initializing TheOnes protocol...',
  '> Analyzing domain context...',
  '> Searching knowledge registry...',
  '> Running deep research [1/4]...',
  '> Running deep research [2/4]...',
  '> Running deep research [3/4]...',
  '> Running deep research [4/4]...',
  '> Generating Aksel configuration...',
  '> Generating Vera configuration...',
  '> Architecting agent dynamics...',
  '> Seeding memory layer...',
  '> Finalizing knowledge base...',
];

const MaleIcon = ({ active }: { active: boolean }) => (
  <svg width="52" height="52" viewBox="0 0 52 52">
    <circle cx="22" cy="30" r="14" fill="none"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5"/>
    <line x1="32" y1="20" x2="46" y2="6"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5" strokeLinecap="round"/>
    <polyline points="36,6 46,6 46,16"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5"
      fill="none" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FemaleIcon = ({ active }: { active: boolean }) => (
  <svg width="52" height="52" viewBox="0 0 52 52">
    <circle cx="26" cy="20" r="14" fill="none"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5"/>
    <line x1="26" y1="34" x2="26" y2="48"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5" strokeLinecap="round"/>
    <line x1="18" y1="42" x2="34" y2="42"
      stroke={active ? '#00e5ff' : 'rgba(255,255,255,0.25)'} strokeWidth="2.5" strokeLinecap="round"/>
  </svg>
);

const StepBar = ({ step }: { step: Step }) => {
  const current = step === 'questions' || step === 'loading' ? 2 : step as number;
  return (
    <div className="ob-steps">
      {[1, 2, 3].map((s, i) => (
        <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && <div className={`ob-step-dot ${current >= s ? 'done' : ''}`}/>}
          <div className={`ob-step-node ${current === s ? 'active' : current > s ? 'done' : ''}`}/>
        </div>
      ))}
    </div>
  );
};

export default function OnboardingShell({ profile, isAnonymous, onComplete }: Props) {
  const lang = profile.language;

  // Checkpoint (29 Aug 2026): if progress was saved in an earlier
  // session, hydrate ALL state from it through a lazy initializer rather
  // than a useEffect, so there is no flash back to step 1 before
  // hydration runs. onboardSucceeded forces step 3 whatever `step` was
  // saved, which prevents regenerating the expensive generative call.
  const savedState = (profile.onboarding_state as OnboardingState | null) || null;

  const [ageVerified, setAgeVerified] = useState(savedState?.ageVerified ?? false);
  const [dob,         setDob]         = useState('');
  const [ageError,    setAgeError]    = useState('');
  const [underAge,    setUnderAge]    = useState(false);
  const [savingDob,   setSavingDob]   = useState(false);
  
  const [tokenVerified,  setTokenVerified]  = useState<boolean | null>(null);
  const [tokenCode,      setTokenCode]      = useState('');
  const [tokenError,     setTokenError]     = useState('');
  const [verifyingToken, setVerifyingToken] = useState(false);

  const [step,        setStep]        = useState<Step>(
    savedState?.onboardSucceeded ? 3 : (savedState?.step ?? 1)
  );
  const [gender,      setGender]      = useState<Gender | null>(savedState?.gender ?? null);
  const [langStyle,   setLangStyle]   = useState<LangStyle | null>(savedState?.langStyle ?? null);
  const [language,    setLanguage]    = useState<Language>(savedState?.language ?? 'id');
  const [domain,      setDomain]      = useState(savedState?.domain ?? '');
  const [selCategory, setSelCategory] = useState<string | null>(savedState?.selCategory ?? null);
  const [selSub,      setSelSub]      = useState<string | null>(savedState?.selSub ?? null);
  const [questions,   setQuestions]   = useState<Question[]>(savedState?.questions ?? []);
  const [answers,     setAnswers]     = useState<Record<string, string>>(savedState?.answers ?? {});
  const [analyzingQ,  setAnalyzingQ]  = useState(false);
  const [radarSel,    setRadarSel]    = useState<string[]>(savedState?.radarSel ?? []);
  const [error,       setError]       = useState('');
  const [logs,        setLogs]        = useState<string[]>([]);
  const [logProgress, setLogProgress] = useState(0);
  const termRef = useRef<HTMLDivElement>(null);

  // Sticky flag: once true it stays true, even if a later checkpoint
  // forgets to include the field. A ref (not state) because it is only
  // read synchronously inside saveCheckpoint() and needs no re-render.
  const onboardSucceededRef = useRef(savedState?.onboardSucceeded ?? false);

  // Saves ONE complete JSON blob on every meaningful progress step.
  // Fire-and-forget: a failed save must never block onboarding (worst
  // case a refresh loses one increment of progress, not all of it).
  const saveCheckpoint = (overrides: Partial<OnboardingState>) => {
    if (overrides.onboardSucceeded) onboardSucceededRef.current = true;
    const fullState: OnboardingState = {
      ageVerified: true, step, gender, langStyle, language, domain,
      selCategory, selSub, questions, answers, radarSel,
      onboardSucceeded: onboardSucceededRef.current,
      ...overrides,
    };
    apiFetch('/api/user/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ onboarding_state: fullState }),
    }).catch(() => {});
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  useEffect(() => {
    const checkAccess = async () => {
      // Bug fixed/designed (9 Sep 2026): demo (anonymous) users never
      // have — and structurally can never claim — a guest_access_token,
      // since skipping that exact gate is the whole point of the
      // anonymous entry path. Same treatment as admin/owner below.
      if (isAnonymous) {
        setTokenVerified(true);
        return;
      }

      if (profile.role === 'admin' || profile.role === 'owner') {
        setTokenVerified(true);
        return;
      }

      const { data } = await supabase
        .from('guest_access_tokens')
        .select('*')
        .eq('assigned_user_id', profile.id)
        .eq('personal_onboard_used', true)
        .single();

      if (data) {
        setTokenVerified(true);
      } else {
        setTokenVerified(false);
      }
    };
    
    checkAccess();
  }, [profile, isAnonymous]);

  useEffect(() => {
    if (selSub)           setDomain(selSub);
    else if (selCategory) setDomain(selCategory);
  }, [selSub, selCategory]);

  useEffect(() => {
    if (step !== 'loading') return;
    setLogs([]);
    setLogProgress(0);
    let i = 0;
    const interval = setInterval(() => {
      if (i < LOADING_LOGS.length) {
        setLogs(prev => [...prev, LOADING_LOGS[i]]);
        setLogProgress(Math.round(((i + 1) / LOADING_LOGS.length) * 88));
        i++;
        if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
      } else {
        clearInterval(interval);
      }
    }, 700);
    return () => clearInterval(interval);
  }, [step]);

  const calculateAge = (dobStr: string): number => {
    const birth = new Date(dobStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  };

  const handleAgeSubmit = async () => {
    if (!dob) { setAgeError(t('obErrDobRequired', lang)); return; }
    const birth = new Date(dob);
    if (isNaN(birth.getTime())) { setAgeError(t('obErrDobInvalid', lang)); return; }

    const age = calculateAge(dob);
    if (age < 18) {
      setUnderAge(true);
      return;
    }

    setAgeError('');
    setSavingDob(true);
    try {
      await apiFetch('/api/user/profile', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date_of_birth: dob }),
      });
    } catch {
    } finally {
      setSavingDob(false);
      setAgeVerified(true);
      saveCheckpoint({ ageVerified: true });
    }
  };

  const handleTokenSubmit = async () => {
    if (!tokenCode.trim()) { setTokenError(t('obErrTokenRequired', lang)); return; }
    setTokenError('');
    setVerifyingToken(true);

    try {
      const res = await apiFetch('/api/theones/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenCode: tokenCode.trim() })
      });
      const data = await res.json();
      
      if (data.status === 'success') {
        setTokenVerified(true);
      } else {
        setTokenError(data.message || t('obErrTokenInvalid', lang));
      }
    } catch (err) {
      setTokenError(t('errConnectionRetry', lang));
    } finally {
      setVerifyingToken(false);
    }
  };

  const handleFase1Next = async () => {
    if (!gender)    { setError(t('obErrSelectGender', lang)); return; }
    if (!langStyle) { setError(t('obErrSelectLangStyle', lang)); return; }
    setError('');

    // Bug fixed/designed (9 Sep 2026): demo (anonymous) users skip Fase 2
    // (domain input + the real Opus-driven persona generation) entirely —
    // straight from Fase 1 to a pre-built general persona via
    // /onboard-demo, landing on Fase 3 same as everyone else afterward.
    // Reuses the SAME 'loading' step visual/timing as the real flow
    // (the useEffect above already drives it purely off a fixed timer,
    // independent of how long the actual API call takes) for a
    // consistent feel, even though this call resolves almost instantly.
    if (isAnonymous) {
      setStep('loading');
      try {
        const res = await apiFetch('/api/theones/onboard-demo', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ gender }),
        });
        const result = await res.json();
        if (result.status !== 'success') {
          setStep(1);
          setError(t('obErrTheOnesError', lang));
          return;
        }
        setLogProgress(100);
        onboardSucceededRef.current = true;
        saveCheckpoint({ step: 3, gender, langStyle, language, onboardSucceeded: true });
        setTimeout(() => setStep(3), 800);
      } catch {
        setStep(1);
        setError(t('errConnectionBackend', lang));
      }
      return;
    }

    setStep(2);
    saveCheckpoint({ step: 2, gender, langStyle, language });
  };

  const handleAnalyzeDomain = async () => {
    if (!domain.trim())           { setError(t('obErrGoalRequired', lang)); return; }
    if (domain.trim().length < 3) { setError(t('obErrGoalTooShort', lang)); return; }
    setError('');
    setAnalyzingQ(true);
    try {
      const res = await apiFetch('/api/theones/questions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ domain: domain.trim(), gender, language_style: langStyle }),
      });
      const result = await res.json();
      if (result.status !== 'success' || !result.questions?.length) {
        setError(t('obErrDomainFailed', lang));
        return;
      }
      setQuestions(result.questions);
      setAnswers({});
      setStep('questions');
      saveCheckpoint({ step: 'questions', domain: domain.trim(), selCategory, selSub, questions: result.questions, answers: {} });
    } catch {
      setError(t('errConnectionBackend', lang));
    } finally {
      setAnalyzingQ(false);
    }
  };

  const handleInitializeAgents = async () => {
    const allAnswered = questions.every(q => answers[q.id]);
    if (!allAnswered) { setError(t('obErrAnswerAllShort', lang)); return; }
    setError('');
    setStep('loading');
    try {
      const res = await apiFetch('/api/theones/onboard', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          domain:             domain.trim(),
          gender,
          language_style:     langStyle,
          taxonomy_path:      selCategory ? { category: selCategory, subcategory: selSub || selCategory } : null,
          clarifying_answers: answers,
        }),
      });
      const result = await res.json();
      if (result.status === 'rejected') {
        setStep('questions');
        setError(t('obErrNotRecognized', lang));
        return;
      }
      if (result.status !== 'success') {
        setStep('questions');
        setError(t('obErrTheOnesError', lang));
        return;
      }
      setLogProgress(100);
      saveCheckpoint({ step: 3, onboardSucceeded: true, domain: domain.trim(), selCategory, selSub, questions, answers });
      setTimeout(() => setStep(3), 800);
    } catch {
      setStep('questions');
      setError(t('errConnectionBackend', lang));
    }
  };

  const handleFase3Complete = async () => {
    if (radarSel.length === 0) { setError(t('obErrSelectCategory', lang)); return; }
    setError('');
    try {
      await apiFetch('/api/user/profile', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          gender,
          language_style:      langStyle,
          language,
          radar_categories:    radarSel,
          onboarding_complete: true,
          onboarding_step:     3,
        }),
      });
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { data: updated } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();
      if (updated) onComplete(updated as UserProfile);
    } catch {
      setError(t('obErrSaveFailed', lang));
    }
  };

  const toggleRadar = (cat: string) => {
    setRadarSel(prev => {
      const next = prev.includes(cat) ? prev.filter(c => c !== cat)
        : prev.length < 3 ? [...prev, cat] : prev;
      saveCheckpoint({ radarSel: next });
      return next;
    });
  };

  const allAnswered = questions.length > 0 && questions.every(q => answers[q.id]);

  return (
    <div className="ob-root">
      <header className="ob-header">
        <div className="ob-title">Gonya</div>
        <div className="ob-bar">
          <span className="ob-step-label">
            {!ageVerified               ? t('obStepAccessVerif', lang)
              : !tokenVerified          ? t('obStepPortfolioAccess', lang)
              : step === 1              ? t('obStepFase1', lang)
              : step === 2              ? t('obStepFase2Domain', lang)
              : step === 'questions'    ? t('obStepFase2Context', lang)
              : step === 'loading'      ? 'THEONES // INITIALIZING'
              : t('obStepFase3', lang)}
          </span>
          <span className="ob-motto">AGENT CALIBRATION PROTOCOL</span>
          <span className="ob-sys">SYS. STATUS: CONFIGURING</span>
          <button
            onClick={handleLogout}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-dim)', fontSize: 10, letterSpacing: '0.08em',
              fontFamily: 'var(--font-mono)', padding: '4px 10px', cursor: 'pointer',
              textTransform: 'uppercase', marginLeft: 12,
            }}
          >
            {t('obSignOutBtn', lang)}
          </button>
        </div>
        {ageVerified && tokenVerified && <StepBar step={step}/>}
      </header>

      <main className="ob-content">

        {!ageVerified && !underAge && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obStepAccessVerif', lang)}</span>
            <h2 className="ob-phase-title">{t('obAgeTitle', lang)}</h2>
            <p className="ob-age-desc">
              {t('obAgeDesc', lang)}
            </p>
            <span className="ob-input-label">{t('obDobLabel', lang)}</span>
            <input
              className="ob-domain-input"
              type="date"
              value={dob}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => { setDob(e.target.value); setAgeError(''); }}
            />
            {ageError && <p className="ob-error">&gt; {ageError}</p>}
            <div className="ob-age-actions">
              <button className="ob-next-btn" onClick={handleAgeSubmit} disabled={!dob || savingDob}>
                {savingDob ? t('obCheckingBtn', lang) : t('obContinueBtn', lang)}
              </button>
            </div>
            <p className="ob-age-note">
              {t('obAgeNote', lang)}
            </p>
          </div>
        )}

        {underAge && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obStepAccessVerif', lang)}</span>
            <h2 className="ob-phase-title">{t('obUnderAgeTitle', lang)}</h2>
            <p className="ob-age-desc">
              {t('obUnderAgeDesc', lang)}
            </p>
            <div className="ob-age-actions">
              <button className="ob-age-deny-btn" onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}>
                {t('obSignOutBtn', lang)}
              </button>
            </div>
          </div>
        )}

        {ageVerified && tokenVerified === false && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obAccessControlLabel', lang)}</span>
            <h2 className="ob-phase-title">{t('obTokenTitle', lang)}</h2>
            <p className="ob-age-desc">
              {t('obTokenDesc', lang)}
            </p>
            <span className="ob-input-label" style={{ textAlign: 'center' }}>{t('obTokenLabel', lang)}</span>
            <input
              className="ob-domain-input"
              type="text"
              placeholder="GNY-XXXXXX"
              value={tokenCode}
              onChange={e => { setTokenCode(e.target.value.toUpperCase()); setTokenError(''); }}
              style={{ textAlign: 'center', letterSpacing: '0.1em' }}
            />
            {tokenError && <p className="ob-error" style={{ textAlign: 'center' }}>&gt; {tokenError}</p>}
            <div className="ob-age-actions">
              <button className="ob-next-btn" onClick={handleTokenSubmit} disabled={!tokenCode || verifyingToken}>
                {verifyingToken ? t('obVerifyingBtn', lang) : t('obUnlockBtn', lang)}
              </button>
            </div>
            
            <div style={{ marginTop: 24, textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <p style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.06em', margin: '0 0 10px 0' }}>
                {t('obNoTokenYet', lang)}
              </p>
              <a 
                href={`mailto:harvaheru123@gmail.com?subject=${t('obMailSubject', lang)}&body=${t('obMailBody', lang)}%0D%0AMy Account ID is: ${profile.id}`}
                style={{ fontSize: 11, color: 'var(--cyan)', textDecoration: 'none', fontFamily: 'var(--font-mono)' }}
              >
                {t('obRequestAccessBtn', lang)}
              </a>
            </div>
          </div>
        )}

        {ageVerified && tokenVerified === true && step === 1 && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obFase1Label', lang)}</span>
            <h2 className="ob-phase-title">{t('obFase1Title', lang)}</h2>

            <span className="ob-lang-label">{t('obGenderLabel', lang)}</span>
            <div className="ob-gender-grid">
              <button className={`ob-gender-card ${gender === 'male' ? 'selected' : ''}`}
                onClick={() => setGender('male')}>
                <MaleIcon active={gender === 'male'}/>
                <span className="ob-gender-label">{t('optMale', lang)}</span>
              </button>
              <button className={`ob-gender-card ${gender === 'female' ? 'selected' : ''}`}
                onClick={() => setGender('female')}>
                <FemaleIcon active={gender === 'female'}/>
                <span className="ob-gender-label">{t('optFemale', lang)}</span>
              </button>
            </div>

            <span className="ob-lang-label">{t('obLangStyleLabel', lang)}</span>
            <div className="ob-lang-grid">
              <button className={`ob-lang-btn ${langStyle === 'casual' ? 'selected' : ''}`}
                onClick={() => setLangStyle('casual')}>{t('optCasual', lang)}</button>
              <button className={`ob-lang-btn ${langStyle === 'formal' ? 'selected' : ''}`}
                onClick={() => setLangStyle('formal')}>{t('optFormal', lang)}</button>
            </div>

            <span className="ob-lang-label">{t('obInterfaceLangLabel', lang)}</span>
            <div className="ob-lang-grid">
              <button className={`ob-lang-btn ${language === 'id' ? 'selected' : ''}`}
                onClick={() => setLanguage('id')}>Bahasa Indonesia</button>
              <button className={`ob-lang-btn ${language === 'en' ? 'selected' : ''}`}
                onClick={() => setLanguage('en')}>English</button>
            </div>

            {error && <p className="ob-error">&gt; {error}</p>}
            <button className="ob-next-btn" onClick={handleFase1Next}
              disabled={!gender || !langStyle}>{t('obContinueBtn', lang)}</button>
          </div>
        )}

        {ageVerified && tokenVerified === true && step === 2 && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obFase2Label', lang)}</span>
            <h2 className="ob-phase-title">{t('obFase2Title', lang)}</h2>
            <span className="ob-input-label">{t('obGoalLabel', lang)}</span>
            <input className="ob-domain-input" type="text"
              placeholder={t('obGoalPlaceholder', lang)}
              value={domain}
              onChange={e => { setDomain(e.target.value); setSelCategory(null); setSelSub(null); }}
              autoFocus/>
            <span className="ob-tax-label">{t('obOrSelectCategory', lang)}</span>
            <div className="ob-tax-grid">
              {Object.keys(TAXONOMY).map(cat => (
                <button key={cat}
                  className={`ob-tax-cat ${selCategory === cat ? 'selected' : ''}`}
                  onClick={() => { setSelCategory(prev => prev === cat ? null : cat); setSelSub(null); }}>
                  {cat}
                </button>
              ))}
            </div>
            {selCategory && (
              <div className="ob-tax-subs">
                {TAXONOMY[selCategory].map(sub => (
                  <button key={sub}
                    className={`ob-tax-sub ${selSub === sub ? 'selected' : ''}`}
                    onClick={() => setSelSub(prev => prev === sub ? null : sub)}>
                    {sub}
                  </button>
                ))}
              </div>
            )}
            {analyzingQ && (
              <div className="ob-analyzing">
                <span className="ob-analyzing-text">{t('obAnalyzingDomain', lang)}</span>
              </div>
            )}
            {error && <p className="ob-error">&gt; {error}</p>}
            <button className="ob-next-btn" onClick={handleAnalyzeDomain}
              disabled={!domain.trim() || analyzingQ}>
              {analyzingQ ? t('obAnalyzingBtn', lang) : t('obAnalyzeDomainBtn', lang)}
            </button>
          </div>
        )}

        {ageVerified && tokenVerified === true && step === 'questions' && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obFase2ContextLabel', lang)}</span>
            <h2 className="ob-phase-title">{t('obFase2ContextTitle', lang)}</h2>
            <div className="ob-questions-wrap">
              {questions.map((q, idx) => (
                <div key={q.id}>
                  <span className="ob-question-num">{t('obQuestionOf', lang, { n: idx + 1, total: questions.length })}</span>
                  <p className="ob-question-text">{q.text}</p>
                  <div className="ob-question-options">
                    {q.options.map(opt => (
                      <button key={opt}
                        className={`ob-question-opt ${answers[q.id] === opt ? 'selected' : ''}`}
                        onClick={() => setAnswers(prev => ({ ...prev, [q.id]: opt }))}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="ob-error">&gt; {error}</p>}
            <button className="ob-next-btn" onClick={handleInitializeAgents}
              disabled={!allAnswered}>
              {t('obInitAgentsBtn', lang)}
            </button>
          </div>
        )}

        {ageVerified && tokenVerified === true && step === 'loading' && (
          <div className="ob-loading-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <p className="ob-loading-title">THEONES // AGENT INITIALIZATION</p>
            <p className="ob-loading-sub">{t('obDoNotClose', lang)}</p>
            <div className="ob-loading-terminal" ref={termRef}>
              {logs.map((log, i) => (
                <p key={i} className={`ob-log-line ${i < logs.length - 1 ? 'done' : ''}`}>{log}</p>
              ))}
            </div>
            <div className="ob-loading-bar-wrap">
              <div className="ob-loading-bar" style={{ width: `${logProgress}%` }}/>
            </div>
            <p className="ob-loading-pct">{logProgress}%</p>
          </div>
        )}

        {ageVerified && tokenVerified === true && step === 3 && (
          <div className="ob-panel">
            <div className="ob-corner ob-tl"/><div className="ob-corner ob-tr"/>
            <div className="ob-corner ob-bl"/><div className="ob-corner ob-br"/>
            <span className="ob-phase-label">{t('obFase3Label', lang)}</span>
            <h2 className="ob-phase-title">{t('obFase3Title', lang)}</h2>
            <p className="ob-radar-hint">{t('obSelectUpTo3', lang, { n: radarSel.length })}</p>
            <div className="ob-radar-grid">
              {RADAR_CATEGORIES.map(cat => (
                <button key={cat}
                  className={`ob-radar-cat ${radarSel.includes(cat) ? 'selected' : ''} ${radarSel.length >= 3 && !radarSel.includes(cat) ? 'disabled' : ''}`}
                  onClick={() => toggleRadar(cat)}>
                  {cat}
                </button>
              ))}
            </div>
            {error && <p className="ob-error">&gt; {error}</p>}
            <button className="ob-next-btn" onClick={handleFase3Complete}
              disabled={radarSel.length === 0}>{t('obEnterGonyaBtn', lang)}</button>
          </div>
        )}

      </main>

      <footer className="ob-footer">
        <span>GONYA SECURITY PROTOCOLS V4.9</span>
        <span>AGENT CALIBRATION IN PROGRESS</span>
      </footer>
    </div>
  );
}