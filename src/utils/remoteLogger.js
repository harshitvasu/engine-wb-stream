/**
 * Remote Client Logger
 * Sends structured log events from browser (especially mobile/iPad Safari) to the Vite dev server
 * so they appear live in the terminal console where `npm run client` is running.
 */

export function logToServer(tag, msg, details = {}) {
  // Always log to local browser console
  try {
    console.log(`[${tag}] ${msg}`, details);
  } catch {}

  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    // Detect device type cleanly
    const isIpad =
      /iPad/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isMac = !isIpad && /Macintosh/i.test(navigator.userAgent);
    const device = isIpad ? 'iPad Safari' : isMac ? 'macOS' : 'Browser';

    const payload = JSON.stringify({
      tag,
      msg,
      details,
      ua: device,
      url: window.location.pathname,
      time: new Date().toISOString().slice(11, 23),
    });

    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/__client_log', blob);
    } else if (typeof fetch === 'function') {
      fetch('/__client_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch (err) {
    // Non-blocking
  }
}
