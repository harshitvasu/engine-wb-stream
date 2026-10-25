/**
 * Stream Controls Configuration & Defaults
 * Includes presets and custom "Manual Stream control" mode:
 * Stores events until they reach the configured buffer size, then streams them at a constant rate.
 */

export const STREAM_CONTROLS_STORAGE_KEY = 'excalistream_receiver_controls_v4';

export const MANUAL_RATE_PRESETS = [10, 20, 30, 45, 60];
export const MANUAL_BUFFER_PRESETS = [10, 20, 30, 50, 100];

export const STREAM_PROFILES = [
  {
    id: 'smooth',
    label: 'Smooth',
    sublabel: '60 fps',
    tag: 'Recommended',
    description: '16ms cadence for real-time fluid strokes.',
    intervalMs: 16,
    chunkSize: 10,
    budgetMs: 4,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    sublabel: '30 fps',
    tag: 'Standard',
    description: '33ms cadence for steady, low-CPU rendering.',
    intervalMs: 33,
    chunkSize: 15,
    budgetMs: 6,
  },
  {
    id: 'battery',
    label: 'Battery Saver',
    sublabel: '15 fps',
    tag: 'Eco',
    description: '66ms cadence to minimize CPU on laptops & iPads.',
    intervalMs: 66,
    chunkSize: 25,
    budgetMs: 8,
  },
  {
    id: 'manual',
    label: 'Manual Stream control',
    sublabel: 'Buffered Replay',
    tag: 'Custom',
    description: 'Stores events until buffer size is reached, then streams them at a constant rate.',
    intervalMs: 33,
    chunkSize: 1,
    budgetMs: 8,
  },
];

export const DEFAULT_STREAM_CONTROLS = {
  // Primary user-facing profile: 'smooth' | 'balanced' | 'battery' | 'manual'
  profile: 'smooth',

  // Manual Stream Control specific parameters:
  manualRateFps: 30,       // Constant render rate in updates per second (5 to 60)
  manualBufferSize: 20,    // Target buffer size threshold before streaming begins (5 to 150)
  manualEventsPerTick: 1,  // Fixed number of events processed per tick for constant pacing

  // Underlying scheduling & batch parameters
  processingIntervalMs: 16,
  chunkSize: 10,
  maxFrameBudgetMs: 4,
  maxBufferSize: 500,
  maxBufferBytes: 2 * 1024 * 1024,
  renderingMode: 'frame_synced',

  // Adaptive Lag Protection (bypassed in Manual Stream Control mode)
  autoThrottling: true,
};

/**
 * Loads persisted receiver controls from localStorage or falls back to defaults.
 */
export function getSavedStreamControls() {
  try {
    const raw = localStorage.getItem(STREAM_CONTROLS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_STREAM_CONTROLS,
        ...parsed,
      };
    }
  } catch (err) {
    console.warn('Failed to parse saved stream controls from localStorage', err);
  }
  return { ...DEFAULT_STREAM_CONTROLS };
}

/**
 * Persists receiver controls to localStorage.
 */
export function saveStreamControls(controls) {
  try {
    localStorage.setItem(STREAM_CONTROLS_STORAGE_KEY, JSON.stringify(controls));
  } catch (err) {
    console.warn('Failed to save stream controls to localStorage', err);
  }
}
