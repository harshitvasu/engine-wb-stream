import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getWebSocketUrl,
  MIN_ZOOM,
  MIN_VIEWER_ZOOM,
  FIXED_CANVAS_WIDTH,
  FIXED_CANVAS_HEIGHT,
} from '../config/constants';
import {
  DEFAULT_STREAM_CONTROLS,
  STREAM_PROFILES,
  getSavedStreamControls,
  saveStreamControls,
} from '../config/streamControlsConfig';

export function useWhiteboardViewer({ roomId = 'default' } = {}) {
  const [excalidrawAPI, setExcalidrawAPIRaw] = useState(null);
  const excalidrawAPIRef = useRef(null);

  const [isConnected, setIsConnected] = useState(false);
  const [broadcasterOnline, setBroadcasterOnline] = useState(false);
  const [streamError, setStreamError] = useState(null);
  const [videoRotation, setVideoRotation] = useState(0);

  // Stream controls state with persistence
  const [controls, setControlsState] = useState(() => getSavedStreamControls());
  const controlsRef = useRef(controls);

  useEffect(() => {
    controlsRef.current = controls;
    saveStreamControls(controls);
  }, [controls]);

  const updateControl = useCallback((key, value) => {
    setControlsState((prev) => {
      const next = { ...prev, [key]: value };
      controlsRef.current = next;
      saveStreamControls(next);
      return next;
    });
  }, []);

  const setProfile = useCallback((profileId) => {
    const profile = STREAM_PROFILES.find((p) => p.id === profileId);
    if (!profile) return;

    if (profile.id !== 'manual') {
      isPlaybackActiveRef.current = true; // immediately render in non-manual modes
    } else {
      isPlaybackActiveRef.current = false; // re-enter buffering mode
    }

    setControlsState((prev) => {
      const next = {
        ...prev,
        profile: profile.id,
        processingIntervalMs: profile.id === 'manual'
          ? Math.max(Math.round(1000 / (prev.manualRateFps || 30)), 8)
          : profile.intervalMs,
        chunkSize: profile.id === 'manual'
          ? (prev.manualEventsPerTick || 1)
          : profile.chunkSize,
        maxFrameBudgetMs: profile.budgetMs,
      };
      controlsRef.current = next;
      saveStreamControls(next);
      return next;
    });
  }, []);

  const resetControlsToDefaults = useCallback(() => {
    const defaults = { ...DEFAULT_STREAM_CONTROLS };
    controlsRef.current = defaults;
    saveStreamControls(defaults);
    setControlsState(defaults);
  }, []);

  // Canonical scene store for incremental element patches and snapshots
  const elementsMapRef = useRef(new Map());
  const revisionRef = useRef(0);

  // Receiver-side processing queue
  const incomingQueueRef = useRef([]);
  const queuedBytesRef = useRef(0);

  // Performance telemetry counters kept in refs to avoid triggering React re-renders
  const incomingEventsCounterRef = useRef(0);
  const incomingBytesCounterRef = useRef(0);
  const totalPacketsRef = useRef(0);
  const recentProcessingTimesRef = useRef([]);
  const lastReceiveToApplyLatencyRef = useRef(0);
  const lastNetworkLatencyRef = useRef(0);
  const lastQueueLatencyRef = useRef(0);
  const snapshotResyncCountRef = useRef(0);
  const isAutoThrottlingActiveRef = useRef(false);
  const isRecoveringRef = useRef(false);

  // Manual Stream Control pre-buffering state
  const isPlaybackActiveRef = useRef(false);
  const lastIncomingEventTimeRef = useRef(Date.now());

  const flushManualBuffer = useCallback(() => {
    isPlaybackActiveRef.current = true;
  }, []);

  const elementCountRef = useRef(0);
  const viewersCountRef = useRef(1);
  const broadcastersCountRef = useRef(0);
  const isLimitExceededRef = useRef(false);

  // Throttled UI metrics state (sampled periodically to avoid excessive React rerenders)
  const [metrics, setMetrics] = useState({
    // Diagnostic metrics requested
    incomingEventsPerSec: 0,
    incomingBytesPerSec: 0,
    bufferedEvents: 0,
    bufferedBytes: 0,
    oldestQueuedAgeMs: 0,
    avgProcessingTimeMs: 0,
    receiveToApplyLatencyMs: 0,
    networkLatencyMs: 0,
    queueLatencyMs: 0,
    lastProcessedRevision: 0,
    snapshotResyncCount: 0,
    waitingUpdatesCount: 0,
    isAutoThrottlingActive: false,
    healthStatus: 'Optimal',

    // Backwards-compatible toolbar telemetry fields
    fps: 0,
    packetsReceived: 0,
    latencyMs: 0,
    elementCount: 0,
    viewersCount: 1,
    broadcastersCount: 0,
  });

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const tabIdRef = useRef(Math.random().toString(36).substring(2, 9));
  const lastBroadcasterAppStateRef = useRef({
    zoom: { value: 1.0 },
    scrollX: 0,
    scrollY: 0,
    width: FIXED_CANVAS_WIDTH,
    height: FIXED_CANVAS_HEIGHT,
  });

  /**
   * Computes responsive scale and centered pan for any viewer screen dimension.
   * Compares the presenter's logical coordinate space (default 1600x900)
   * to the current viewer canvas container dimensions, maintaining aspect ratio.
   */
  const computeScaledSceneAppState = useCallback((rawAppState) => {
    if (!rawAppState) return null;

    const api = excalidrawAPIRef.current;
    const currentApp = api?.getAppState?.();

    // 1. Get current viewer canvas viewport dimensions
    let viewerWidth = currentApp?.width || 0;
    let viewerHeight = currentApp?.height || 0;

    if (!viewerWidth || !viewerHeight) {
      const el = document.querySelector('.fixed-aspect-container') ||
                 document.querySelector('.canvas-outer-wrapper') ||
                 document.querySelector('.canvas-viewport-wrapper');
      if (el) {
        const rect = el.getBoundingClientRect();
        viewerWidth = rect.width;
        viewerHeight = rect.height;
      }
    }

    if (!viewerWidth || !viewerHeight) {
      viewerWidth = window.innerWidth || FIXED_CANVAS_WIDTH;
      viewerHeight = window.innerHeight || FIXED_CANVAS_HEIGHT;
    }

    // 2. Presenter reference dimensions (from broadcaster appState or default 1600x900)
    const presenterWidth = rawAppState.width || FIXED_CANVAS_WIDTH;
    const presenterHeight = rawAppState.height || FIXED_CANVAS_HEIGHT;

    let scaleFactor = 1.0;
    let extraSceneX = 0;
    let extraSceneY = 0;

    if (viewerWidth > 0 && viewerHeight > 0 && presenterWidth > 0 && presenterHeight > 0) {
      const scaleX = viewerWidth / presenterWidth;
      const scaleY = viewerHeight / presenterHeight;
      scaleFactor = Math.min(scaleX, scaleY);

      const presenterZoom = rawAppState.zoom?.value || 1.0;
      if (scaleFactor > 0 && presenterZoom > 0) {
        extraSceneX = (viewerWidth / scaleFactor - presenterWidth) / (2 * presenterZoom);
        extraSceneY = (viewerHeight / scaleFactor - presenterHeight) / (2 * presenterZoom);
      }
    }

    const presenterZoom = rawAppState.zoom?.value || 1.0;
    const effectiveZoom = Math.max(MIN_VIEWER_ZOOM, presenterZoom * scaleFactor);

    const effectiveScrollX = (rawAppState.scrollX !== undefined ? rawAppState.scrollX : 0) + extraSceneX;
    const effectiveScrollY = (rawAppState.scrollY !== undefined ? rawAppState.scrollY : 0) + extraSceneY;

    return {
      zoom: { value: effectiveZoom },
      scrollX: effectiveScrollX,
      scrollY: effectiveScrollY,
      scaleFactor,
    };
  }, []);

  const fitToScreen = useCallback(() => {
    const api = excalidrawAPIRef.current;
    if (!api) return;
    const elements = Array.from(elementsMapRef.current.values());
    if (elements.length > 0) {
      api.scrollToContent(elements, {
        fitToViewport: true,
        viewportZoomFactor: 0.95,
        animate: false,
      });
    } else {
      const baseState = lastBroadcasterAppStateRef.current || {
        zoom: { value: 1.0 },
        scrollX: 0,
        scrollY: 0,
        width: FIXED_CANVAS_WIDTH,
        height: FIXED_CANVAS_HEIGHT,
      };
      const scaled = computeScaledSceneAppState(baseState);
      if (scaled) {
        api.updateScene({
          appState: {
            zoom: scaled.zoom,
            scrollX: scaled.scrollX,
            scrollY: scaled.scrollY,
          },
        });
      }
    }
  }, [computeScaledSceneAppState]);

  const setExcalidrawAPI = useCallback((api) => {
    excalidrawAPIRef.current = api;
    setExcalidrawAPIRaw(api);
    if (api && lastBroadcasterAppStateRef.current) {
      const scaled = computeScaledSceneAppState(lastBroadcasterAppStateRef.current);
      if (scaled) {
        api.updateScene({
          appState: {
            viewModeEnabled: true,
            zenModeEnabled: true,
            zoom: scaled.zoom,
            scrollX: scaled.scrollX,
            scrollY: scaled.scrollY,
          },
        });
      }
    }
  }, [computeScaledSceneAppState]);

  /**
   * Applies an incoming message to the canonical elementsMapRef and tracks revisions.
   * Returns metadata indicating what changed so scene updates can be coalesced.
   */
  const applyMessageToState = useCallback((msg) => {
    if (!msg) return null;

    if (msg.type === 'snapshot' || msg.type === 'init') {
      isRecoveringRef.current = false;
      revisionRef.current = msg.revision || 0;
      elementsMapRef.current.clear();
      if (Array.isArray(msg.elements)) {
        for (const el of msg.elements) {
          if (el && el.id) elementsMapRef.current.set(el.id, el);
        }
      }
      if (msg.stats?.viewersCount !== undefined) viewersCountRef.current = msg.stats.viewersCount;
      if (msg.stats?.broadcastersCount !== undefined) {
        broadcastersCountRef.current = msg.stats.broadcastersCount;
        setBroadcasterOnline(msg.stats.broadcastersCount > 0);
      }
      if (msg.appState) {
        lastBroadcasterAppStateRef.current = {
          ...lastBroadcasterAppStateRef.current,
          ...msg.appState,
        };
      }
      return { type: 'snapshot', appState: msg.appState };
    }

    if (msg.type === 'clear') {
      elementsMapRef.current.clear();
      revisionRef.current = msg.revision || (revisionRef.current + 1);
      return { type: 'clear', appState: msg.appState };
    }

    if (
      msg.type === 'patch' ||
      msg.type === 'batch_update' ||
      msg.type === 'stroke_complete' ||
      msg.type === 'full_sync'
    ) {
      // Gap Detection: check if any revision was skipped
      if (msg.revision && revisionRef.current > 0 && msg.revision > revisionRef.current + 1) {
        console.warn(`[Viewer] Revision gap detected (Expected: ${revisionRef.current + 1}, Got: ${msg.revision}). Requesting snapshot resync.`);
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          snapshotResyncCountRef.current += 1;
          isRecoveringRef.current = true;
          wsRef.current.send(
            JSON.stringify({
              type: 'request_resync',
              lastRevision: revisionRef.current,
              reason: 'revision_gap',
            })
          );
        }
      }
      if (msg.revision) {
        revisionRef.current = Math.max(revisionRef.current, msg.revision);
      }

      // Apply Incremental Element Updates
      if (Array.isArray(msg.elements)) {
        for (const el of msg.elements) {
          if (!el || !el.id) continue;
          if (el.isDeleted) {
            elementsMapRef.current.delete(el.id);
          } else {
            elementsMapRef.current.set(el.id, el);
          }
        }
      }

      if (Array.isArray(msg.deletedIds)) {
        for (const id of msg.deletedIds) {
          elementsMapRef.current.delete(id);
        }
      }

      return { type: 'patch', appState: msg.appState };
    }

    return null;
  }, []);

  /**
   * Coalesces and applies a batch of queued updates to the Excalidraw canvas
   * within the configured frame processing budget.
   */
  const processQueuedBatch = useCallback(() => {
    const queue = incomingQueueRef.current;
    if (queue.length === 0) {
      if (controlsRef.current.profile === 'manual') {
        isPlaybackActiveRef.current = false;
      }
      return;
    }

    const currentControls = controlsRef.current;
    const isManual = currentControls.profile === 'manual';
    let effectiveChunkSize;

    if (isManual) {
      const targetBuffer = currentControls.manualBufferSize || 20;

      // In Manual mode: store events until they reach the configured buffer size threshold
      if (!isPlaybackActiveRef.current) {
        const timeSinceLastEvent = Date.now() - lastIncomingEventTimeRef.current;
        if (queue.length >= targetBuffer) {
          // Reached buffer size threshold! Unlock streaming at constant rate
          isPlaybackActiveRef.current = true;
        } else if (queue.length > 0 && timeSinceLastEvent > 1200) {
          // Idle timeout: presenter paused or finished drawing, stream out buffered remainder
          isPlaybackActiveRef.current = true;
        } else {
          // Still buffering until reaching buffer size threshold
          return;
        }
      }

      // Render at exact constant rate (fixed events per tick)
      effectiveChunkSize = currentControls.manualEventsPerTick || 1;
      isAutoThrottlingActiveRef.current = false;
    } else {
      effectiveChunkSize = currentControls.chunkSize;
      const currentQueueLen = queue.length;

      // Automatic adaptive throttling engine
      if (currentControls.autoThrottling) {
        if (currentQueueLen > Math.max(currentControls.chunkSize * 2, 20)) {
          isAutoThrottlingActiveRef.current = true;
          // Dynamically scale batch size up to 4x to rapidly drain backlog without dropping updates
          effectiveChunkSize = Math.min(Math.max(currentControls.chunkSize * 2, 25), 100);
        } else if (currentQueueLen <= Math.max(Math.floor(currentControls.chunkSize / 2), 5)) {
          isAutoThrottlingActiveRef.current = false;
          effectiveChunkSize = currentControls.chunkSize;
        } else if (isAutoThrottlingActiveRef.current) {
          effectiveChunkSize = Math.min(Math.max(currentControls.chunkSize * 2, 25), 100);
        }
      } else {
        isAutoThrottlingActiveRef.current = false;
      }
    }

    const batchStart = performance.now();
    const maxBudget = currentControls.maxFrameBudgetMs;

    let itemsProcessed = 0;
    let hadChanges = false;
    let hadClear = false;
    let hadSnapshot = false;
    let mergedAppState = null;

    const latencies = [];
    const netLatencies = [];
    const queueLatencies = [];

    while (queue.length > 0 && itemsProcessed < effectiveChunkSize) {
      // C. Target frame budget: yield remaining work to later frames rather than freezing the UI
      if (itemsProcessed > 0 && (performance.now() - batchStart) >= maxBudget) {
        break;
      }

      const item = queue.shift();
      queuedBytesRef.current = Math.max(0, queuedBytesRef.current - item.byteLength);
      itemsProcessed += 1;

      const applyTime = performance.now();
      const qWait = Math.max(0, applyTime - item.receivedAt);
      const nWait = Math.max(0, Date.now() - item.wireTimestamp);
      latencies.push(qWait + nWait);
      netLatencies.push(nWait);
      queueLatencies.push(qWait);

      const result = applyMessageToState(item.msg);
      if (result) {
        hadChanges = true;
        if (result.type === 'clear') {
          hadClear = true;
        }
        if (result.type === 'snapshot') {
          hadSnapshot = true;
        }
        if (result.appState) {
          mergedAppState = { ...mergedAppState, ...result.appState };
        }
      }
    }

    // Apply single coalesced scene update to Excalidraw API
    const api = excalidrawAPIRef.current;
    if (hadChanges && api) {
      if (hadClear) {
        const scaled = computeScaledSceneAppState(
          lastBroadcasterAppStateRef.current || { zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 }
        );
        api.updateScene({
          elements: [],
          commitToHistory: false,
          appState: {
            viewModeEnabled: true,
            zenModeEnabled: true,
            zoom: scaled?.zoom || { value: MIN_VIEWER_ZOOM },
            scrollX: scaled?.scrollX || 0,
            scrollY: scaled?.scrollY || 0,
          },
        });
      } else {
        const sceneUpdate = {
          elements: Array.from(elementsMapRef.current.values()),
          commitToHistory: false,
          appState: {
            viewModeEnabled: true,
            zenModeEnabled: true,
          },
        };

        if (mergedAppState) {
          lastBroadcasterAppStateRef.current = {
            ...lastBroadcasterAppStateRef.current,
            ...mergedAppState,
          };
          if (mergedAppState.viewBackgroundColor && hadSnapshot) {
            sceneUpdate.appState.viewBackgroundColor = mergedAppState.viewBackgroundColor;
          }
        }

        const scaled = computeScaledSceneAppState(lastBroadcasterAppStateRef.current);
        if (scaled) {
          sceneUpdate.appState.zoom = scaled.zoom;
          sceneUpdate.appState.scrollX = scaled.scrollX;
          sceneUpdate.appState.scrollY = scaled.scrollY;
        }

        api.updateScene(sceneUpdate);
      }
      elementCountRef.current = elementsMapRef.current.size;
    }

    // Diagnostics & timing accounting
    const duration = performance.now() - batchStart;
    if (itemsProcessed > 0) {
      recentProcessingTimesRef.current.push(duration);
      if (recentProcessingTimesRef.current.length > 20) {
        recentProcessingTimesRef.current.shift();
      }
      if (latencies.length > 0) {
        lastReceiveToApplyLatencyRef.current = Math.round(
          latencies.reduce((a, b) => a + b, 0) / latencies.length
        );
        lastNetworkLatencyRef.current = Math.round(
          netLatencies.reduce((a, b) => a + b, 0) / netLatencies.length
        );
        lastQueueLatencyRef.current = Math.round(
          queueLatencies.reduce((a, b) => a + b, 0) / queueLatencies.length
        );
      }
    }

    if (isManual && queue.length === 0) {
      isPlaybackActiveRef.current = false;
    }
  }, [applyMessageToState]);

  // Scheduler Lifecycle: Frame-synchronized, Batched, or Immediate
  useEffect(() => {
    const mode = controls.renderingMode;
    const isManual = controls.profile === 'manual';
    const activeInterval = isManual
      ? Math.max(Math.round(1000 / (controls.manualRateFps || 30)), 8)
      : (controls.processingIntervalMs || 16);

    if (mode === 'frame_synced') {
      let rafId = null;
      let lastProcessTime = performance.now();

      const frameTick = (now) => {
        const interval = controlsRef.current.profile === 'manual'
          ? Math.max(Math.round(1000 / (controlsRef.current.manualRateFps || 30)), 8)
          : (controlsRef.current.processingIntervalMs || 16);

        if (now - lastProcessTime >= Math.max(interval - 1.5, 0)) {
          processQueuedBatch();
          lastProcessTime = now;
        }
        rafId = requestAnimationFrame(frameTick);
      };

      rafId = requestAnimationFrame(frameTick);
      return () => cancelAnimationFrame(rafId);
    }

    if (mode === 'batched') {
      const timer = setInterval(() => {
        processQueuedBatch();
      }, activeInterval);
      return () => clearInterval(timer);
    }

    // In immediate mode, any leftover items from switching modes are flushed
    if (mode === 'immediate') {
      while (incomingQueueRef.current.length > 0) {
        processQueuedBatch();
      }
    }
  }, [
    controls.renderingMode,
    controls.processingIntervalMs,
    controls.profile,
    controls.manualRateFps,
    processQueuedBatch,
  ]);

  // Connect function
  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setStreamError(null);
    isLimitExceededRef.current = false;

    const url = getWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setStreamError(null);
      ws.send(
        JSON.stringify({
          type: 'join',
          role: 'viewer',
          roomId,
          tabId: tabIdRef.current,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const rawData = event.data;
        const byteSize = typeof rawData === 'string' ? rawData.length : (rawData.byteLength || 0);
        const msg = JSON.parse(rawData);

        // Immediate check for error limits
        if (msg.type === 'error') {
          if (msg.code === 'STREAM_LIMIT_EXCEEDED') {
            isLimitExceededRef.current = true;
            setStreamError({
              code: msg.code,
              message: msg.message || 'Only one stream window can be open at a time. Another stream window is already open.',
            });
            setIsConnected(false);
          }
          return;
        }

        // Fast path for presence updates
        if (msg.type === 'presence') {
          viewersCountRef.current = msg.viewersCount;
          broadcastersCountRef.current = msg.broadcastersCount;
          setBroadcasterOnline(msg.broadcastersCount > 0);
          return;
        }

        // Live broadcaster video orientation updates
        if (msg.type === 'video_rotation') {
          if (typeof msg.videoRotation === 'number') {
            setVideoRotation(msg.videoRotation);
          }
          return;
        }

        if ((msg.type === 'init' || msg.type === 'snapshot') && typeof msg.videoRotation === 'number') {
          setVideoRotation(msg.videoRotation);
        }

        // Telemetry counters
        incomingEventsCounterRef.current += 1;
        incomingBytesCounterRef.current += byteSize;
        totalPacketsRef.current += 1;

        const currentControls = controlsRef.current;

        // Immediate Mode: bypass queue and apply right away
        if (currentControls.renderingMode === 'immediate') {
          const t0 = performance.now();
          const result = applyMessageToState(msg);
          const api = excalidrawAPIRef.current;

          if (result && api) {
            if (result.type === 'clear') {
              api.updateScene({
                elements: [],
                commitToHistory: false,
                appState: {
                  viewModeEnabled: true,
                  zenModeEnabled: true,
                  zoom: { value: MIN_ZOOM },
                  scrollX: 0,
                  scrollY: 0,
                },
              });
            } else {
              const sceneUpdate = {
                elements: Array.from(elementsMapRef.current.values()),
                commitToHistory: false,
                appState: {
                  viewModeEnabled: true,
                  zenModeEnabled: true,
                },
              };
              if (result.appState) {
                if (result.appState.viewBackgroundColor && result.type === 'snapshot') {
                  sceneUpdate.appState.viewBackgroundColor = result.appState.viewBackgroundColor;
                }
                if (result.appState.zoom) sceneUpdate.appState.zoom = result.appState.zoom;
                if (result.appState.scrollX !== undefined) sceneUpdate.appState.scrollX = result.appState.scrollX;
                if (result.appState.scrollY !== undefined) sceneUpdate.appState.scrollY = result.appState.scrollY;
              }
              api.updateScene(sceneUpdate);
            }
            elementCountRef.current = elementsMapRef.current.size;
          }

          const applyDuration = performance.now() - t0;
          recentProcessingTimesRef.current.push(applyDuration);
          if (recentProcessingTimesRef.current.length > 20) {
            recentProcessingTimesRef.current.shift();
          }
          const netWait = Math.max(0, Date.now() - (msg.timestamp || Date.now()));
          lastNetworkLatencyRef.current = netWait;
          lastQueueLatencyRef.current = 0;
          lastReceiveToApplyLatencyRef.current = netWait;
          return;
        }

        // Batched or Frame-Synchronized: Buffer into incoming queue
        // D. Maximum buffer capacity safety enforcement
        const queue = incomingQueueRef.current;
        const effectiveMaxBuffer = currentControls.profile === 'manual'
          ? Math.max((currentControls.manualBufferSize || 20) * 4, 300)
          : currentControls.maxBufferSize;

        const isCountExceeded = queue.length >= effectiveMaxBuffer;
        const isBytesExceeded = (queuedBytesRef.current + byteSize) > currentControls.maxBufferBytes;

        if (isCountExceeded || isBytesExceeded) {
          console.warn(
            `[Viewer] Maximum buffer size exceeded (Events: ${queue.length}/${effectiveMaxBuffer}, Bytes: ${queuedBytesRef.current}/${currentControls.maxBufferBytes}). Requesting snapshot resynchronization.`
          );
          snapshotResyncCountRef.current += 1;
          isRecoveringRef.current = true;
          incomingQueueRef.current = [];
          queuedBytesRef.current = 0;

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'request_resync',
                lastRevision: revisionRef.current,
                reason: isBytesExceeded ? 'buffer_bytes_overflow' : 'buffer_events_overflow',
              })
            );
          }
          return;
        }

        queue.push({
          msg,
          receivedAt: performance.now(),
          wireTimestamp: msg.timestamp || Date.now(),
          byteLength: byteSize,
        });
        queuedBytesRef.current += byteSize;
        lastIncomingEventTimeRef.current = Date.now();

        // In Manual Stream Control mode: check if buffer reached configured threshold
        if (currentControls.profile === 'manual') {
          const targetBuffer = currentControls.manualBufferSize || 20;
          if (!isPlaybackActiveRef.current) {
            if (queue.length >= targetBuffer || msg.type === 'stroke_complete') {
              isPlaybackActiveRef.current = true;
            }
          }
        }
      } catch (e) {
        console.error('Viewer error handling websocket message', e);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      setBroadcasterOnline(false);

      if (event.code === 4001 || isLimitExceededRef.current) {
        if (!isLimitExceededRef.current) {
          isLimitExceededRef.current = true;
          setStreamError({
            code: 'STREAM_LIMIT_EXCEEDED',
            message: 'Only one stream window can be open at a time. Another stream window is already open.',
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
  }, [roomId, applyMessageToState]);

  // Periodic Telemetry Diagnostics (Updated once per second to prevent React re-renders)
  useEffect(() => {
    connect();

    const intervalTimer = setInterval(() => {
      const queue = incomingQueueRef.current;
      const queueDepth = queue.length;
      const oldestAge = queueDepth > 0 ? Math.max(0, Math.round(performance.now() - queue[0].receivedAt)) : 0;

      const avgProcTime = recentProcessingTimesRef.current.length > 0
        ? Number((recentProcessingTimesRef.current.reduce((a, b) => a + b, 0) / recentProcessingTimesRef.current.length).toFixed(1))
        : 0;

      const isManual = controlsRef.current.profile === 'manual';
      const targetBuffer = controlsRef.current.manualBufferSize || 20;
      const isBuffering = isManual && !isPlaybackActiveRef.current && queueDepth > 0;

      let healthStatus = 'Optimal';
      if (isRecoveringRef.current) {
        healthStatus = 'Recovering';
      } else if (isManual) {
        healthStatus = isBuffering ? 'Buffering' : (queueDepth > 0 ? 'Streaming' : 'Ready');
      } else if (isAutoThrottlingActiveRef.current) {
        healthStatus = 'Throttling';
      } else if (queueDepth > 15) {
        healthStatus = 'Accumulating';
      }

      setMetrics({
        incomingEventsPerSec: incomingEventsCounterRef.current,
        incomingBytesPerSec: incomingBytesCounterRef.current,
        bufferedEvents: queueDepth,
        bufferedBytes: queuedBytesRef.current,
        oldestQueuedAgeMs: oldestAge,
        avgProcessingTimeMs: avgProcTime,
        receiveToApplyLatencyMs: lastReceiveToApplyLatencyRef.current,
        networkLatencyMs: lastNetworkLatencyRef.current,
        queueLatencyMs: lastQueueLatencyRef.current,
        lastProcessedRevision: revisionRef.current,
        snapshotResyncCount: snapshotResyncCountRef.current,
        waitingUpdatesCount: queueDepth,
        isAutoThrottlingActive: isAutoThrottlingActiveRef.current,
        profile: controlsRef.current.profile,
        isManualBuffering: isBuffering,
        isPlaybackActive: isPlaybackActiveRef.current,
        manualTargetBuffer: targetBuffer,
        healthStatus,

        // Backwards compatibility for existing UI
        fps: incomingEventsCounterRef.current,
        packetsReceived: totalPacketsRef.current,
        latencyMs: lastReceiveToApplyLatencyRef.current || lastNetworkLatencyRef.current,
        elementCount: elementCountRef.current,
        viewersCount: viewersCountRef.current,
        broadcastersCount: broadcastersCountRef.current,
      });

      incomingEventsCounterRef.current = 0;
      incomingBytesCounterRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(intervalTimer);
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Explicit retry connection handler
  const retryConnection = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    isLimitExceededRef.current = false;
    setStreamError(null);
    connect();
  }, [connect]);

  return {
    excalidrawAPI,
    setExcalidrawAPI,
    isConnected,
    broadcasterOnline,
    metrics,
    streamError,
    retryConnection,
    videoRotation,
    // Stream Controls
    controls,
    updateControl,
    setProfile,
    flushManualBuffer,
    resetControlsToDefaults,
  };
}