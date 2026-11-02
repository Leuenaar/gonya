// TEMPORARY diagnostic utility (12 Sep 2026) — remove once the mobile
// voice-call-drops investigation concludes. See server.js's own comment
// on /api/debug-log for the full reasoning. Uses sendBeacon specifically
// (not fetch) because the moment being debugged is often a component
// UNMOUNTING — a regular fetch() call started right as the page/component
// tears down risks being cancelled before it completes, while sendBeacon
// is purpose-built by the browser to survive exactly that.
const getApiUrl = (): string =>
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';

export const remoteLog = (message: string): void => {
  try {
    const blob = new Blob([JSON.stringify({ message })], { type: 'application/json' });
    const sent = navigator.sendBeacon(`${getApiUrl()}/api/debug-log`, blob);
    if (!sent) throw new Error('sendBeacon returned false');
  } catch {
    // Fallback for browsers/situations where sendBeacon isn't available
    // or refuses the payload — best-effort only, matches this whole
    // utility's "never break the app" spirit.
    fetch(`${getApiUrl()}/api/debug-log`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message }),
      keepalive: true,
    }).catch(() => {});
  }
};
