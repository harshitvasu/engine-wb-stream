/**
 * Remote Client Logger
 * Sends structured log events from browser (especially mobile/iPad/iPhone) to the Vite dev server
 * so they appear live in the terminal console where `npm run client` is running and get saved to client_debug.log.
 */

export function getDeviceInfo() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { device: 'Unknown', browser: 'Unknown', os: 'Unknown', ua: '' };
  }
  const ua = navigator.userAgent || '';
  const isIpad =
    /iPad/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIphone = !isIpad && /iPhone|iPod/i.test(ua);
  const isMac = !isIpad && !isIphone && /Macintosh/i.test(ua);
  const isWindows = /Windows/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isLinux = !isAndroid && /Linux/i.test(ua);

  let os = 'UnknownOS';
  if (isIpad) os = 'iPad';
  else if (isIphone) os = 'iPhone';
  else if (isMac) os = 'macOS';
  else if (isWindows) os = 'Windows';
  else if (isAndroid) os = 'Android';
  else if (isLinux) os = 'Linux';

  let browser = 'Browser';
  if (/CriOS/i.test(ua)) browser = 'Chrome iOS';
  else if (/FxiOS/i.test(ua)) browser = 'Firefox iOS';
  else if (/EdgiOS/i.test(ua)) browser = 'Edge iOS';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua) && !/CriOS/i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Edg\//i.test(ua)) browser = 'Edge';

  const device = `${os} ${browser}`.trim();
  return { device, browser, os, ua };
}

/**
 * Extracts all audio/video m= lines, a=rtpmap, and a=fmtp lines into an easily readable object
 */
export function parseSdpCodecSummary(sdp) {
  if (!sdp || typeof sdp !== 'string') return [];
  const lines = sdp.split(/\r?\n/);
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('m=')) {
      currentSection = { media: trimmed, codecs: [] };
      sections.push(currentSection);
    } else if (currentSection) {
      if (trimmed.startsWith('a=rtpmap:') || trimmed.startsWith('a=fmtp:')) {
        currentSection.codecs.push(trimmed);
      }
    }
  }
  return sections;
}

export function logToServer(tag, msg, details = {}) {
  // Always log to local browser console
  try {
    console.log(`[${tag}] ${msg}`, details);
  } catch {}

  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    const info = getDeviceInfo();

    const payload = JSON.stringify({
      tag,
      msg,
      details,
      ua: info.device,
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
