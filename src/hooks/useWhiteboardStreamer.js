import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DEFAULT_BATCH_INTERVAL_MS,
  DEFAULT_AUTOSAVE_INTERVAL_SEC,
  getWebSocketUrl,
  MIN_ZOOM,
  MAX_ZOOM,
  FIXED_CANVAS_WIDTH,
  FIXED_CANVAS_HEIGHT,
} from '../config/constants';
import { clampZoom } from '../utils/canvasBounds';

const LOCAL_STORAGE_KEY = 'excalistream_canvas_backup_v1';

/**
 * Loads locally persisted whiteboard state to make the canvas 100% refresh-proof.
 */
export function getSavedWhiteboardData() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          elements: parsed,
          appState: {
            viewBackgroundColor: '#ffffff',
            zoom: { value: MIN_ZOOM },
            scrollX: 0,
            scrollY: 0,
          },
        };
      }
    }
  } catch (err) {
    console.warn('Failed to read local whiteboard backup', err);
  }
  return null;
}

export function useWhiteboardStreamer({ roomId = 'default', initialBatchInterval = DEFAULT_BATCH_INTERVAL_MS } = {}) {
  const [excalidrawAPI, setExcalidrawAPIRaw] = useState(null);
  const excalidrawAPIRef = useRef(null);

  const [isConnected, setIsConnected] = useState(false);
  const [writeError, setWriteError] = useState(null);
  const [batchIntervalMs, setBatchIntervalMs] = useState(initialBatchInterval);
  const [autosaveIntervalSec, setAutosaveIntervalSec] = useState(DEFAULT_AUTOSAVE_INTERVAL_SEC);
  const [isStreamingPaused, setIsStreamingPaused] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(MIN_ZOOM);

  // Safe setter for batch interval to ensure valid numeric values from slider or presets
  const handleSetBatchIntervalMs = useCallback((val) => {
    const num = Math.round(Number(val));
    if (!isNaN(num) && num >= 5 && num <= 500) {
      setBatchIntervalMs(num);
    }
  }, []);

  const currentZoomRef = useRef(MIN_ZOOM);
  const isLimitExceededRef = useRef(false);

  // Performance telemetry counters kept in refs to avoid triggering React re-renders during 16ms drawing
  const batchesSentRef = useRef(0);
  const packetsSentRef = useRef(0);
  const strokesCompletedRef = useRef(0);
  const bytesSentRef = useRef(0);
  const latencyRef = useRef(0);
  const viewersCountRef = useRef(0);
  const lastAutosaveTimeRef = useRef(null);
  const lastStrokeFlushedRef = useRef(false);

  // Throttled UI metrics state (updated only once per second)
  const [metrics, setMetrics] = useState({
    packetsSentPerSec: 0,
    batchesSent: 0,
    strokesCompleted: 0,
    autosavesCount: 0,
    lastAutosaveTime: null,
    latencyMs: 0,
    elementCount: 0,
    viewersCount: 0,
    bytesSent: 0,
    lastStrokeFlushedImmediately: false,
  });

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const sequenceRef = useRef(0);
  const isDirtyRef = useRef(false);
  const latestElementsRef = useRef([]);
  const latestAppStateRef = useRef(null);
  const prevElementVersionsRef = useRef(new Map()); // Tracks element versions for incremental updates
  const activeStrokeRef = useRef(false);
  const pingStartRef = useRef(0);

  // Stable API setter
  const setExcalidrawAPI = useCallback((api) => {
    excalidrawAPIRef.current = api;
    setExcalidrawAPIRaw(api);
  }, []);

  // 1. Maintain WebSocket connection with Single-Write Window enforcement
  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setWriteError(null);
    isLimitExceededRef.current = false;

    const url = getWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setWriteError(null);
      // Join room as broadcaster (writer)
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'broadcaster',
          roomId,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Catch Single-Write Window Limit rejection from backend
        if (msg.type === 'error') {
          if (msg.code === 'BROADCASTER_LIMIT_EXCEEDED') {
            isLimitExceededRef.current = true;
            setIsConnected(false);
            setWriteError({
              code: msg.code,
              message: msg.message || 'Only one write window can be open at a time. Another write window is already active.',
            });
          }
          return;
        }

        if (msg.type === 'init') {
          viewersCountRef.current = msg.stats?.viewersCount || 0;
          // If server has elements and client has none, restore them
          if (msg.elements && msg.elements.length > 0 && latestElementsRef.current.length === 0) {
            latestElementsRef.current = msg.elements;
            if (excalidrawAPIRef.current) {
              excalidrawAPIRef.current.updateScene({ elements: msg.elements, commitToHistory: false });
            }
            try {
              localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(msg.elements));
            } catch (e) {}
          }
        } else if (msg.type === 'presence') {
          viewersCountRef.current = msg.viewersCount || 0;
        } else if (msg.type === 'pong') {
          latencyRef.current = Math.max(0, Date.now() - pingStartRef.current);
        } else if (msg.type === 'autosave_ack') {
          lastAutosaveTimeRef.current = Date.now();
        }
      } catch (e) {
        console.error('Streamer error parsing incoming ws message', e);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);

      if (event.code === 4002 || isLimitExceededRef.current) {
        // Write window limit reached: do not auto-reconnect!
        if (!isLimitExceededRef.current) {
          isLimitExceededRef.current = true;
          setWriteError({
            code: 'BROADCASTER_LIMIT_EXCEEDED',
            message: 'Only one write window can be open at a time. Another write window is already active.',
          });
        }
        return;
      }

      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        if (!isLimitExceededRef.current) {
          connect();
        }
      }, 1500);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [roomId]);

  useEffect(() => {
    connect();

    // Ping interval to measure network latency (every 2.5s)
    const pingTimer = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        pingStartRef.current = Date.now();
        wsRef.current.send(JSON.stringify({ type: 'ping', clientTime: Date.now(), roomId }));
      }
    }, 2500);

    // Metrics sampler timer (runs strictly once per second to avoid drawing re-renders)
    const metricsTimer = setInterval(() => {
      setMetrics((prev) => ({
        ...prev,
        packetsSentPerSec: packetsSentRef.current,
        batchesSent: batchesSentRef.current,
        strokesCompleted: strokesCompletedRef.current,
        bytesSent: bytesSentRef.current,
        elementCount: latestElementsRef.current.length,
        latencyMs: latencyRef.current,
        viewersCount: viewersCountRef.current,
        lastAutosaveTime: lastAutosaveTimeRef.current,
        lastStrokeFlushedImmediately: lastStrokeFlushedRef.current,
      }));
      packetsSentRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(pingTimer);
      clearInterval(metricsTimer);
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        try {
          if (wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'leave',
                role: 'broadcaster',
                roomId,
              })
            );
          }
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    };
  }, [connect, roomId]);

  // Retry write connection handler
  const retryConnection = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    isLimitExceededRef.current = false;
    setWriteError(null);
    connect();
  }, [connect]);

  // 2. Prevent accidental browser reload data loss (Refresh-proof prompt)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (latestElementsRef.current.length > 0) {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(latestElementsRef.current));
        } catch (err) {}
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // 3. Network Batch Interval loop (16ms default / 33ms relaxed)
  useEffect(() => {
    if (isStreamingPaused) return;

    const intervalTimer = setInterval(() => {
      if (
        isDirtyRef.current &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        latestElementsRef.current
      ) {
        isDirtyRef.current = false;
        sequenceRef.current += 1;
        packetsSentRef.current += 1;
        batchesSentRef.current += 1;

        // Extract only changed elements (incremental updates)
        const changedElements = [];
        for (const el of latestElementsRef.current) {
          if (!el || !el.id) continue;
          if (prevElementVersionsRef.current.get(el.id) !== el.version) {
            changedElements.push(el);
            prevElementVersionsRef.current.set(el.id, el.version);
          }
        }

        const payload = {
          type: 'batch_update',
          roomId,
          elements: changedElements.length > 0 ? changedElements : latestElementsRef.current,
          appState: {
            viewBackgroundColor: latestAppStateRef.current?.viewBackgroundColor || '#ffffff',
            zoom: latestAppStateRef.current?.zoom,
            scrollX: latestAppStateRef.current?.scrollX,
            scrollY: latestAppStateRef.current?.scrollY,
            width: latestAppStateRef.current?.width || FIXED_CANVAS_WIDTH,
            height: latestAppStateRef.current?.height || FIXED_CANVAS_HEIGHT,
          },
          sequence: sequenceRef.current,
          timestamp: Date.now(),
          broadcasterStats: {
            batchIntervalMs,
          },
        };

        const serialized = JSON.stringify(payload);
        bytesSentRef.current += serialized.length;
        wsRef.current.send(serialized);
      }
    }, batchIntervalMs);

    return () => clearInterval(intervalTimer);
  }, [batchIntervalMs, isStreamingPaused, roomId]);

  // 4. Stroke Completion: Send immediate final event when stroke ends
  const flushStrokeImmediately = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (isStreamingPaused) return;

    isDirtyRef.current = false;
    sequenceRef.current += 1;
    packetsSentRef.current += 1;
    strokesCompletedRef.current += 1;
    lastStrokeFlushedRef.current = true;

    // Track completed stroke versions
    const changedElements = [];
    for (const el of latestElementsRef.current) {
      if (!el || !el.id) continue;
      if (prevElementVersionsRef.current.get(el.id) !== el.version) {
        changedElements.push(el);
        prevElementVersionsRef.current.set(el.id, el.version);
      }
    }

    const finalPayload = {
      type: 'stroke_complete',
      roomId,
      elements: changedElements.length > 0 ? changedElements : latestElementsRef.current,
      appState: {
        viewBackgroundColor: latestAppStateRef.current?.viewBackgroundColor || '#ffffff',
        zoom: latestAppStateRef.current?.zoom,
        scrollX: latestAppStateRef.current?.scrollX,
        scrollY: latestAppStateRef.current?.scrollY,
        width: latestAppStateRef.current?.width || FIXED_CANVAS_WIDTH,
        height: latestAppStateRef.current?.height || FIXED_CANVAS_HEIGHT,
      },
      sequence: sequenceRef.current,
      timestamp: Date.now(),
      isFinal: true,
    };

    const serialized = JSON.stringify(finalPayload);
    bytesSentRef.current += serialized.length;
    wsRef.current.send(serialized);

    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(latestElementsRef.current));
    } catch (e) {}

    setTimeout(() => {
      lastStrokeFlushedRef.current = false;
    }, 400);
  }, [isStreamingPaused, roomId]);

  // 5. Full-document autosave (every 1-5 seconds)
  useEffect(() => {
    if (isStreamingPaused) return;

    const autosaveTimer = setInterval(() => {
      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        latestElementsRef.current.length > 0
      ) {
        wsRef.current.send(
          JSON.stringify({
            type: 'autosave',
            roomId,
            elements: latestElementsRef.current,
            appState: latestAppStateRef.current,
            timestamp: Date.now(),
          })
        );
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(latestElementsRef.current));
        } catch (e) {}
      }
    }, autosaveIntervalSec * 1000);

    return () => clearInterval(autosaveTimer);
  }, [autosaveIntervalSec, isStreamingPaused, roomId]);

  // 6. Handle local drawing changes from Excalidraw
  const handleExcalidrawChange = useCallback(
    (elements, appState) => {
      if (appState.zoom && appState.zoom.value < MIN_ZOOM) {
        if (excalidrawAPIRef.current) {
          excalidrawAPIRef.current.updateScene({
            appState: {
              zoom: { value: MIN_ZOOM },
            },
          });
        }
      }

      const newZoom = clampZoom(appState.zoom?.value || MIN_ZOOM);
      if (Math.abs(currentZoomRef.current - newZoom) >= 0.02) {
        currentZoomRef.current = newZoom;
        setCurrentZoom(newZoom);
      }

      latestElementsRef.current = elements;
      latestAppStateRef.current = appState;
      isDirtyRef.current = true;
    },
    []
  );

  const handlePointerDown = useCallback(() => {
    activeStrokeRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (activeStrokeRef.current) {
      activeStrokeRef.current = false;
      flushStrokeImmediately();
    }
  }, [flushStrokeImmediately]);

  const zoomIn = useCallback(() => {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    const current = api.getAppState().zoom.value;
    const next = clampZoom(Math.min(current + 0.25, MAX_ZOOM));
    api.updateScene({ appState: { zoom: { value: next } } });
    currentZoomRef.current = next;
    setCurrentZoom(next);
  }, []);

  const resetZoom = useCallback(() => {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    api.updateScene({
      appState: {
        zoom: { value: MIN_ZOOM },
        scrollX: 0,
        scrollY: 0,
      },
    });
    currentZoomRef.current = MIN_ZOOM;
    setCurrentZoom(MIN_ZOOM);
  }, []);

  const clearCanvas = useCallback(() => {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    api.updateScene({
      elements: [],
      commitToHistory: true,
    });
    latestElementsRef.current = [];
    prevElementVersionsRef.current.clear();
    isDirtyRef.current = false;

    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch (e) {}

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'clear',
          roomId,
          timestamp: Date.now(),
        })
      );
    }
  }, [roomId]);

  const [activeShareMode, setActiveShareModeState] = useState('whiteboard');

  const broadcastShareMode = useCallback((mode) => {
    setActiveShareModeState(mode);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'share_mode',
          roomId,
          activeShare: mode,
          timestamp: Date.now(),
        })
      );
    }
  }, [roomId]);

  const broadcastVideoRotation = useCallback((rotation) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'video_rotation',
          roomId,
          videoRotation: rotation,
          timestamp: Date.now(),
        })
      );
    }
  }, [roomId]);

  return {
    excalidrawAPI,
    setExcalidrawAPI,
    isConnected,
    writeError,
    retryConnection,
    batchIntervalMs,
    setBatchIntervalMs: handleSetBatchIntervalMs,
    autosaveIntervalSec,
    setAutosaveIntervalSec,
    isStreamingPaused,
    setIsStreamingPaused,
    currentZoom,
    zoomIn,
    resetZoom,
    clearCanvas,
    activeShareMode,
    broadcastShareMode,
    broadcastVideoRotation,
    metrics,
    handleExcalidrawChange,
    handlePointerDown,
    handlePointerUp,
    flushStrokeImmediately,
  };
}
