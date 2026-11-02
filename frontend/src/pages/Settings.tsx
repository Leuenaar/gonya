import { useState, useEffect } from 'react';
import { apiFetch, signOut, type UserProfile } from '../lib/supabase';
import { t } from '../lib/i18n';
import './Settings.css';

interface Props {
  profile:   UserProfile;
  onSignOut: () => void;
  onUpdate:  (updated: Partial<UserProfile>) => void;
}

export default function Settings({ profile, onSignOut, onUpdate }: Props) {
  const [displayName,   setDisplayName]   = useState(profile.display_name || '');
  const [language,      setLanguage]      = useState(profile.language || 'id');
  const [languageStyle, setLanguageStyle] = useState(profile.language_style || 'casual');
  const [gender,        setGender]        = useState(profile.gender || 'male');
  const [newPassword,   setNewPassword]   = useState('');
  const [confirmPass,   setConfirmPass]   = useState('');

  // Instagram-style unique usernames (24 Aug 2026) — separate save flow
  // from the main profile fields, since a username conflict (someone else
  // already has it) shouldn't block saving display_name/language/etc, and
  // vice versa.
  const [username,          setUsername]          = useState(profile.username || '');
  const [usernameAvailable, setUsernameAvailable]  = useState<boolean | null>(null);
  const [checkingUsername,  setCheckingUsername]   = useState(false);
  const [savingUsername,    setSavingUsername]     = useState(false);
  const [usernameMsg,       setUsernameMsg]        = useState('');

  const [savingProfile,  setSavingProfile]  = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [exporting,      setExporting]      = useState(false);
  const [deleting,       setDeleting]       = useState(false);

  const [profileMsg,  setProfileMsg]  = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');

  const showMsg = (setter: (m: string) => void, msg: string) => {
    setter(msg);
    setTimeout(() => setter(''), 3000);
  };

  // ── Save profile ───────────────────────────────────────
  const handleSaveProfile = async () => {
    if (!displayName.trim()) return;
    setSavingProfile(true);
    try {
      const res  = await apiFetch('/api/user/profile', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ display_name: displayName.trim(), language, language_style: languageStyle, gender }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        onUpdate(data.data);
        showMsg(setProfileMsg, t('msgProfileUpdated', profile.language));
      } else {
        showMsg(setProfileMsg, t('msgUpdateFailed', profile.language));
      }
    } catch {
      showMsg(setProfileMsg, t('msgConnectionError', profile.language));
    } finally {
      setSavingProfile(false);
    }
  };

  // ── Live username availability check (debounced, Instagram-style) ─────
  // Skips the check entirely when the field matches what's already saved
  // (re-typing your own current username shouldn't show a "checking..."
  // flicker), and when it's below the minimum length the backend accepts
  // anyway — no point calling the API for an input that will fail format
  // validation regardless.
  useEffect(() => {
    const trimmed = username.trim().toLowerCase();
    const current  = (profile.username || '').toLowerCase();

    if (trimmed === current || trimmed.length < 3) {
      setUsernameAvailable(null);
      setCheckingUsername(false);
      return;
    }

    setCheckingUsername(true);
    const timer = setTimeout(async () => {
      try {
        const res  = await apiFetch(`/api/user/check-username?username=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        setUsernameAvailable(data.status === 'success' ? data.available : null);
      } catch {
        setUsernameAvailable(null);
      } finally {
        setCheckingUsername(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [username, profile.username]);

  const handleSaveUsername = async () => {
    setSavingUsername(true);
    try {
      const res  = await apiFetch('/api/user/profile', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username.trim() }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        onUpdate(data.data);
        showMsg(setUsernameMsg, t('msgProfileUpdated', profile.language));
      } else {
        // Surfaces the backend's specific message when there is one (e.g.
        // "That username is already taken.") rather than a generic fallback.
        showMsg(setUsernameMsg, data.message || t('msgUpdateFailed', profile.language));
      }
    } catch {
      showMsg(setUsernameMsg, t('msgConnectionError', profile.language));
    } finally {
      setSavingUsername(false);
    }
  };

  // ── Change password ────────────────────────────────────
  const handleChangePassword = async () => {
    if (newPassword.length < 8) { showMsg(setPasswordMsg, t('msgMinChars', profile.language)); return; }
    if (newPassword !== confirmPass) { showMsg(setPasswordMsg, t('msgPasswordMismatch', profile.language)); return; }
    setSavingPassword(true);
    try {
      const res  = await apiFetch('/api/user/change-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        setNewPassword(''); setConfirmPass('');
        showMsg(setPasswordMsg, t('msgPasswordChanged', profile.language));
      } else {
        showMsg(setPasswordMsg, t('msgPasswordFailed', profile.language));
      }
    } catch {
      showMsg(setPasswordMsg, t('msgConnectionError', profile.language));
    } finally {
      setSavingPassword(false);
    }
  };

  // ── Export data ────────────────────────────────────────
  const handleExport = async () => {
    setExporting(true);
    try {
      const res  = await apiFetch('/api/user/export');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `triangle-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {} finally {
      setExporting(false);
    }
  };

  // ── Delete account ─────────────────────────────────────
  const handleDelete = async () => {
    const confirmed = window.confirm(
      'This will permanently delete your account, all messages, memories, files, and dossiers. This cannot be undone. Type DELETE to confirm.'
    );
    if (!confirmed) return;
    const input = window.prompt('Type DELETE to confirm:');
    if (input !== 'DELETE') return;

    setDeleting(true);
    try {
      await apiFetch('/api/user/account', { method: 'DELETE' });
      await signOut();
      onSignOut();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div className="st-root">
      <div className="st-header">
        <span className="st-title">{t('settingsTitle', profile.language)}</span>
        <span className="st-sub">{t('settingsSub', profile.language)}</span>
      </div>

      <div className="st-sections">

        {/* ── Profile ── */}
        <div className="st-section">
          <div className="st-section-label">{t('sectionProfile', profile.language)}</div>
          <div className="st-fields">
            <div className="st-field">
              <label className="st-label">{t('fieldDisplayName', profile.language)}</label>
              <input className="st-input" value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder={t('placeholderYourName', profile.language)}/>
            </div>

            <div className="st-field">
              <label className="st-label">{t('fieldLanguage', profile.language)}</label>
              <div className="st-toggle-group">
                {[
                  { val: 'id', label: 'Bahasa Indonesia' },
                  { val: 'en', label: 'English' },
                ].map(({ val, label }) => (
                  <button key={val}
                    className={`st-toggle ${language === val ? 'active' : ''}`}
                    onClick={() => setLanguage(val)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="st-field">
              <label className="st-label">{t('fieldCommStyle', profile.language)}</label>
              <div className="st-toggle-group">
                {([
                  { val: 'casual', label: t('optCasual', profile.language) },
                  { val: 'formal', label: t('optFormal', profile.language) },
                ] as const).map(({ val, label }) => (
                  <button key={val}
                    className={`st-toggle ${languageStyle === val ? 'active' : ''}`}
                    onClick={() => setLanguageStyle(val)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="st-hint">
                {language === 'id'
                  ? languageStyle === 'casual' ? 'Aksel and Vera will use gw/lu or aku/kamu based on your relationship with each.' : 'Aksel and Vera will use polished aku/kamu register.'
                  : 'Aksel and Vera will adjust their tone based on this preference.'}
              </span>
            </div>

            <div className="st-field">
              <label className="st-label">{t('fieldGender', profile.language)}</label>
              <div className="st-toggle-group">
                {[
                  { val: 'male',   label: t('optMale', profile.language)   },
                  { val: 'female', label: t('optFemale', profile.language) },
                  { val: 'other',  label: t('optOther', profile.language)  },
                ].map(({ val, label }) => (
                  <button key={val}
                    className={`st-toggle ${gender === val ? 'active' : ''}`}
                    onClick={() => setGender(val)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="st-hint">{t('genderHint', profile.language)}</span>
            </div>

            <div className="st-field-footer">
              {profileMsg && <span className={`st-msg ${profileMsg.startsWith('✓') ? 'ok' : 'err'}`}>{profileMsg}</span>}
              <button className="st-btn st-btn-primary" onClick={handleSaveProfile} disabled={savingProfile || !displayName.trim()}>
                {savingProfile ? t('btnSaving', profile.language) : t('btnSaveProfile', profile.language)}
              </button>
            </div>

            <div className="st-field st-field-identity">
              <label className="st-label">{t('yourUsername', profile.language)}</label>
              <div className="st-identity-row">
                <span className="st-username-at">@</span>
                <input
                  className="st-input st-username-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder={t('placeholderUsername', profile.language)}
                  maxLength={20}
                  disabled={savingUsername}
                />
                {profile.username && (
                  <button
                    className="st-btn st-btn-ghost st-btn-copy"
                    onClick={() => navigator.clipboard.writeText(profile.username!)}
                  >
                    {t('btnCopy', profile.language)}
                  </button>
                )}
              </div>
              {username.trim().toLowerCase() !== (profile.username || '').toLowerCase() && username.trim().length >= 3 && (
                <span className={`st-username-status ${usernameAvailable === true ? 'ok' : usernameAvailable === false ? 'err' : ''}`}>
                  {checkingUsername ? t('checkingUsername', profile.language)
                    : usernameAvailable === true ? t('usernameAvailable', profile.language)
                    : usernameAvailable === false ? t('usernameTaken', profile.language)
                    : ''}
                </span>
              )}
              <span className="st-hint">{t('usernameHint', profile.language)}</span>
              <div className="st-field-footer">
                {usernameMsg && <span className={`st-msg ${usernameMsg.startsWith('✓') ? 'ok' : 'err'}`}>{usernameMsg}</span>}
                <button
                  className="st-btn st-btn-primary"
                  onClick={handleSaveUsername}
                  disabled={
                    savingUsername || checkingUsername ||
                    username.trim().toLowerCase() === (profile.username || '').toLowerCase() ||
                    usernameAvailable === false
                  }
                >
                  {savingUsername ? t('btnSaving', profile.language) : t('btnSave', profile.language)}
                </button>
              </div>
            </div>

            {profile.short_id && (
              <div className="st-field st-field-identity">
                <label className="st-label">{t('yourShortId', profile.language)}</label>
                <div className="st-identity-row">
                  <span className="st-identity-value">{profile.short_id}</span>
                  <button
                    className="st-btn st-btn-ghost st-btn-copy"
                    onClick={() => {
                      navigator.clipboard.writeText(profile.short_id!);
                    }}
                  >
                    {t('btnCopy', profile.language)}
                  </button>
                </div>
                <span className="st-hint">{t('shortIdHint', profile.language)}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Security ── */}
        <div className="st-section">
          <div className="st-section-label">{t('sectionSecurity', profile.language)}</div>
          <div className="st-fields">
            <div className="st-field">
              <label className="st-label">{t('fieldNewPassword', profile.language)}</label>
              <input className="st-input" type="password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t('placeholderMinChars', profile.language)}/>
            </div>
            <div className="st-field">
              <label className="st-label">{t('fieldConfirmPassword', profile.language)}</label>
              <input className="st-input" type="password" value={confirmPass}
                onChange={e => setConfirmPass(e.target.value)}
                placeholder={t('placeholderRepeatPw', profile.language)}/>
            </div>
            <div className="st-field-footer">
              {passwordMsg && <span className={`st-msg ${passwordMsg.startsWith('✓') ? 'ok' : 'err'}`}>{passwordMsg}</span>}
              <button className="st-btn st-btn-primary" onClick={handleChangePassword} disabled={savingPassword || !newPassword || !confirmPass}>
                {savingPassword ? t('btnChanging', profile.language) : t('btnChangePassword', profile.language)}
              </button>
            </div>
          </div>
        </div>

        {/* ── Data ── */}
        <div className="st-section">
          <div className="st-section-label">{t('sectionData', profile.language)}</div>
          <div className="st-fields">
            <div className="st-data-row">
              <div>
                <div className="st-data-title">{t('exportDataTitle', profile.language)}</div>
                <div className="st-data-desc">{t('exportDataDesc', profile.language)}</div>
              </div>
              <button className="st-btn st-btn-ghost" onClick={handleExport} disabled={exporting}>
                {exporting ? t('btnExporting', profile.language) : t('btnExport', profile.language)}
              </button>
            </div>
          </div>
        </div>

        {/* ── Danger zone ── */}
        <div className="st-section st-section-danger">
          <div className="st-section-label st-section-label-danger">{t('sectionDanger', profile.language)}</div>
          <div className="st-fields">
            <div className="st-data-row">
              <div>
                <div className="st-data-title st-danger-title">{t('deleteAccountTitle', profile.language)}</div>
                <div className="st-data-desc">{t('deleteAccountDesc', profile.language)}</div>
              </div>
              <button className="st-btn st-btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? t('btnDeleting', profile.language) : t('btnDeleteAccount', profile.language)}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
