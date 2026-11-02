import { useState, useEffect } from 'react';
import { remoteLog } from '../lib/remoteLog';

const QUERY = '(max-width: 768px), (pointer: coarse)';

export const useIsMobile = (): boolean => {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined'
      ? window.matchMedia(QUERY).matches
      : false
  );

  useEffect(() => {
    const mq      = window.matchMedia(QUERY);
    // TEMPORARY diagnostic (12 Sep 2026) — remove once the mobile
    // voice-call-drops investigation is confirmed resolved. Suspected:
    // this hook's matchMedia flipping mid-call unmounts MainShellMobile
    // (and VoiceCall nested inside it) via App.tsx's isMobile-gated
    // conditional render — remoteLog() surfaces this in `pm2 logs`
    // directly, sidestepping mobile devtools access entirely.
    const handler = (e: MediaQueryListEvent) => {
      remoteLog(`[useIsMobile] value changed to ${e.matches} — if this fired during an active voice call, that call was just unmounted.`);
      setIsMobile(e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isMobile;
};
