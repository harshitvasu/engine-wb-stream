// Fixed Canvas Dimensions & Aspect Ratio (16:9)
export const FIXED_CANVAS_WIDTH = 1600;
export const FIXED_CANVAS_HEIGHT = 900;
export const FIXED_ASPECT_RATIO = 16 / 9;

// Zoom Constraints: Zoom-in ONLY on initial pixels for writer
export const MIN_ZOOM = 1.0; // 100% - Cannot zoom out past initial full canvas for writer
export const MAX_ZOOM = 5.0; // 500% - Zoom in up to 5x for fine details
export const INITIAL_ZOOM = 1.0;
// Viewer minimum zoom allows responsive down-scaling to fit mobile and small displays
export const MIN_VIEWER_ZOOM = 0.05; // 5% - Supports full responsive fit on small screens

// Network & Streaming Cadence Settings
export const NETWORK_BATCH_INTERVALS = {
  FAST: 16,     // 16 ms: ~60 updates/sec (Recommended starting value)
  RELAXED: 33,  // 33 ms: ~30 updates/sec (Acceptable relaxed interval)
  ULTRA: 8,     // 8 ms: ~120 updates/sec (High refresh displays)
};

export const DEFAULT_BATCH_INTERVAL_MS = 16;
export const DEFAULT_AUTOSAVE_INTERVAL_SEC = 3; // 1-5 seconds autosave
export const AUTOSAVE_OPTIONS = [1, 2, 3, 5];

// Helper to determine WebSocket URL
export function getWebSocketUrl() {
  // 1. Explicit override via Vite environment variable (e.g. VITE_WS_URL=ws://51.21.14.17:3001/ws)
  if (import.meta.env?.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  const loc = window.location;
  const isSecure = loc.protocol === 'https:';
  const protocol = isSecure ? 'wss:' : 'ws:';

  // 2. In Vite development server (port 5173), route through Vite dev proxy
  if (loc.port === '5173') {
    return `${protocol}//${loc.host}/ws`;
  }

  // 3. In production (served from remote IP, domain, or Express server)
  //    Automatically resolves to ws://<IP>:<PORT>/ws without hardcoding
  return `${protocol}//${loc.host}/ws`;
}
