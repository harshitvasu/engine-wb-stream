// Fixed Canvas Dimensions & Aspect Ratio (16:9)
export const FIXED_CANVAS_WIDTH = 1600;
export const FIXED_CANVAS_HEIGHT = 900;
export const FIXED_ASPECT_RATIO = 16 / 9;

// Zoom Constraints: Zoom-in ONLY on initial pixels
export const MIN_ZOOM = 1.0; // 100% - Cannot zoom out past initial full canvas
export const MAX_ZOOM = 5.0; // 500% - Zoom in up to 5x for fine details
export const INITIAL_ZOOM = 1.0;

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
  const loc = window.location;
  if (loc.protocol === 'https:') {
    return `wss://${loc.host}/ws`;
  }
  // In development, port 3001 hosts backend
  if (loc.port === '5173') {
    return `ws://${loc.hostname}:3001/ws`;
  }
  return `ws://${loc.host}/ws`;
}
