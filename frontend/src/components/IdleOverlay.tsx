import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import GonyaMascot from './GonyaMascot';
import './IdleOverlay.css';

interface Props {
  timeout?: number;
  onShow?: () => void;
  onHide?: () => void;
}

export default function IdleOverlay({ timeout = 5 * 60 * 1000, onShow, onHide }: Props) {
  const [visible,  setVisible]  = useState(false);
  const [entering, setEntering] = useState(false);
  const [waking,   setWaking]   = useState(false);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  const onShowRef  = useRef(onShow);
  const onHideRef  = useRef(onHide);

  // Keep refs current without triggering re-renders or effect re-runs
  useEffect(() => { onShowRef.current = onShow; }, [onShow]);
  useEffect(() => { onHideRef.current = onHide; }, [onHide]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (visibleRef.current) return;
      setEntering(true);
      setVisible(true);
      visibleRef.current = true;
      onShowRef.current?.();
      setTimeout(() => setEntering(false), 800);
    }, timeout);
  }, [timeout]); // timeout only — onShow/onHide via ref

  useEffect(() => {
    const events = ['mousemove', 'keydown', 'touchstart'];
    const handler = () => {
      if (!visibleRef.current) resetTimer();
    };
    events.forEach(e => document.addEventListener(e, handler, { passive: true }));
    resetTimer();
    return () => {
      events.forEach(e => document.removeEventListener(e, handler));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [resetTimer]);

  const handleUnlock = () => {
    if (waking) return;
    setWaking(true);
    setTimeout(() => {
      setVisible(false);
      setWaking(false);
      visibleRef.current = false;
      onHideRef.current?.();
      resetTimer();
    }, 600);
  };

  if (!visible) return null;

  return createPortal(
    <div
      className={`idle-overlay ${entering ? 'entering' : ''} ${waking ? 'waking' : ''}`}
      onClick={handleUnlock}
    >
      <div className="idle-backdrop"/>
      <div className="idle-lock-label">
        <span className="idle-lock-icon">⬡</span>
        <span className="idle-lock-text">GONYA LOCKED</span>
      </div>
      <div className="idle-mascot-wrap">
        <GonyaMascot
          state={waking ? 'happy' : 'sleeping'}
          size={180}
          className="idle-mascot"
        />
        <p className="idle-hint">
          {waking ? 'Waking up...' : 'Click anywhere to continue'}
        </p>
      </div>
      <div className="idle-tagline">Thought, undivided.</div>
    </div>,
    document.body
  );
}