import React, { useState, useCallback, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Radio,
  PenTool,
  ExternalLink,
  ZoomIn,
  RotateCcw,
  WifiOff,
  Maximize2,
  Download,
  Eye,
  Clock,
  HardDrive,
  Activity,
  Zap,
  CheckCircle2,
  Trash2,
  Pause,
  Play,
  Layers,
  Sparkles,
  Sliders,
  Scan,
  ChevronDown,
  ChevronUp,
  Monitor,
  Video as VideoIcon,
  Share2,
  Check,
  Home,
  Hash,
  Settings,
  X,
} from 'lucide-react';
import { MIN_ZOOM, NETWORK_BATCH_INTERVALS, AUTOSAVE_OPTIONS } from '../config/constants';

export function TopToolbar({
  roomId = 'default',
  isConnected = true,
  viewersCount = 0,
  currentZoom = 1.0,
  onZoomIn,
  onResetZoom,
  isStream = false,
  onFitToScreen,
  onExportJson,
  onToggleFullscreen,
  isFullscreen = false,
  onToggleControls,
  isControlsOpen = false,
  // Telemetry Visibility Controls
  isTelemetryVisible: externalIsTelemetryVisible,
  onToggleTelemetry: externalOnToggleTelemetry,
  defaultTelemetryVisible = true,
  // Stream Parameters (for Write page)
  batchIntervalMs = 16,
  setBatchIntervalMs,
  autosaveIntervalSec = 3,
  setAutosaveIntervalSec,
  isStreamingPaused = false,
  setIsStreamingPaused,
  clearCanvas,
  // Telemetry Metrics
  metrics = {},
  broadcasterOnline = true,
  // Presentation & Stream Sharing Modes
  activeShareMode = 'whiteboard',
  onSelectShareMode,
  isScreenSharing = false,
  currentViewMode = 'whiteboard',
  onSelectViewMode,
  isFollowingPresenter = true,
  onToggleFollowPresenter,
  hasScreenTrack = false,
  hasVideoTrack = false,
}) {
  // Internal state for toggling telemetry visibility with localStorage persistence
  const [internalIsTelemetryVisible, setInternalIsTelemetryVisible] = useState(() => {
    try {
      const saved = localStorage.getItem('excalistream_telemetry_visible');
      return saved !== null ? JSON.parse(saved) : defaultTelemetryVisible;
    } catch {
      return defaultTelemetryVisible;
    }
  });

  const isTelemetryVisible = externalIsTelemetryVisible !== undefined
    ? externalIsTelemetryVisible
    : internalIsTelemetryVisible;

  const handleToggleTelemetry = useCallback(() => {
    if (externalOnToggleTelemetry) {
      externalOnToggleTelemetry();
    } else {
      setInternalIsTelemetryVisible((prev) => {
        const next = !prev;
        try {
          localStorage.setItem('excalistream_telemetry_visible', JSON.stringify(next));
        } catch {}
        return next;
      });
    }
  }, [externalOnToggleTelemetry]);
  const [hasCopiedLink, setHasCopiedLink] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsRef = useRef(null);

  // Close Settings popover on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setIsSettingsOpen(false);
      }
    }
    if (isSettingsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isSettingsOpen]);

  // Close Settings popover on Escape key
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsSettingsOpen(false);
      }
    }
    if (isSettingsOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isSettingsOpen]);

  const handleCopyStreamLink = useCallback(() => {
    const streamUrl = `${window.location.origin}/stream/${roomId}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(streamUrl).then(() => {
        setHasCopiedLink(true);
        setTimeout(() => setHasCopiedLink(false), 2500);
      }).catch(() => {
        setHasCopiedLink(true);
        setTimeout(() => setHasCopiedLink(false), 2500);
      });
    } else {
      try {
        const input = document.createElement('input');
        input.value = streamUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        setHasCopiedLink(true);
        setTimeout(() => setHasCopiedLink(false), 2500);
      } catch {}
    }
  }, [roomId]);

  return (
    <header className="app-top-toolbar unified-toolbar">
      {/* =========================================================================
          LINE 1: CONTROLS & SELECTORS ROW
          ========================================================================= */}
      <div className="toolbar-row-main">
        {/* 1. Left Section: Brand & Navigation */}
        <div className="toolbar-section toolbar-left">
          <NavLink to="/" className="brand-badge-link" title="Return to Room Lobby">
            <div className="brand-badge">
              <div className="brand-dot-pulse" />
              <span className="brand-name">ExcaliStream</span>
            </div>
          </NavLink>

          <nav className="nav-pills">
            <NavLink
              to={`/write/${roomId}`}
              className={({ isActive }) => `pill-link ${isActive ? 'active' : ''}`}
              title={`Broadcaster view for room ${roomId}`}
            >
              <PenTool size={13} />
              <span>Write</span>
            </NavLink>
            <NavLink
              to={`/stream/${roomId}`}
              className={({ isActive }) => `pill-link ${isActive ? 'active' : ''}`}
              title={`Viewer stream link for room ${roomId}`}
            >
              <Radio size={13} />
              <span>Stream</span>
            </NavLink>
          </nav>

          {/* Room ID Badge */}
          <div className="room-id-chip" title={`Current Room: ${roomId}`}>
            <span className="room-chip-label">Room:</span>
            <span className="room-chip-id">{roomId}</span>
          </div>

          {/* Share Stream Button (Copies direct viewer link) */}
          <button
            type="button"
            onClick={handleCopyStreamLink}
            className={`share-stream-btn ${hasCopiedLink ? 'copied' : ''}`}
            title={`Copy direct stream link: ${typeof window !== 'undefined' ? window.location.origin : ''}/stream/${roomId}`}
          >
            {hasCopiedLink ? (
              <>
                <Check size={12} className="text-emerald-400" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Share2 size={12} />
                <span>Share Stream</span>
              </>
            )}
          </button>

          <NavLink to="/" className="pill-link lobby-return-btn" title="Leave room and return to Lobby">
            <Home size={13} />
            <span>Lobby</span>
          </NavLink>

          <div className="ratio-indicator">
            <span>16:9</span>
          </div>
        </div>

        {/* 2. Center Section: Broadcast Selector Only */}
        <div className="toolbar-section toolbar-center">
          {!isStream && onSelectShareMode ? (
            <div className="center-selectors-cluster">
              <div className="control-group">
                <span className="group-label">Broadcast:</span>
                <div className="segmented-pill-box mode-switcher">
                  <button
                    type="button"
                    className={`seg-btn-xs ${activeShareMode === 'whiteboard' ? 'active' : ''}`}
                    onClick={() => onSelectShareMode('whiteboard')}
                    title="Broadcast Whiteboard Canvas"
                  >
                    <PenTool size={11} />
                    <span>Board</span>
                  </button>
                  <button
                    type="button"
                    className={`seg-btn-xs ${activeShareMode === 'screen' ? 'active' : ''} ${isScreenSharing ? 'live-border' : ''}`}
                    onClick={() => onSelectShareMode('screen')}
                    title="Broadcast Screen Share (WebRTC SFU)"
                  >
                    <Monitor size={11} className={isScreenSharing ? 'text-blue-400' : ''} />
                    <span>Screen</span>
                    {isScreenSharing && <span className="mini-live-dot" />}
                  </button>
                  <button
                    type="button"
                    className={`seg-btn-xs ${activeShareMode === 'video' ? 'active' : ''}`}
                    onClick={() => onSelectShareMode('video')}
                    title="Broadcast Full-Resolution Presenter Video (720p WebRTC SFU)"
                  >
                    <VideoIcon size={11} />
                    <span>Video</span>
                  </button>
                </div>
              </div>
            </div>
          ) : isStream ? (
            /* Stream: Presenter Broadcast Status Display */
            <div className="center-selectors-cluster">
              <div
                className={`stream-mode-indicator ${
                  currentViewMode === 'screen'
                    ? 'mode-screen'
                    : currentViewMode === 'video'
                    ? 'mode-video'
                    : 'mode-whiteboard'
                }`}
                title={`Presenter is broadcasting ${
                  currentViewMode === 'screen'
                    ? 'Screen Share'
                    : currentViewMode === 'video'
                    ? 'High-Resolution Video'
                    : 'Whiteboard'
                }`}
              >
                {currentViewMode === 'screen' ? (
                  <>
                    <Monitor size={12} className="text-blue-400" />
                    <span>Presenter: <strong>Screen Share</strong></span>
                    <span className="mini-live-dot" />
                  </>
                ) : currentViewMode === 'video' ? (
                  <>
                    <VideoIcon size={12} className="text-emerald-400" />
                    <span>Presenter: <strong>Live Video (HD)</strong></span>
                    <span className="mini-live-dot" />
                  </>
                ) : (
                  <>
                    <PenTool size={12} className="text-indigo-400" />
                    <span>Presenter: <strong>Whiteboard</strong></span>
                    <span className="mini-live-dot" />
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* 3. Right Section: Live Status, Viewers Count, /stream Link, & Settings Popup */}
        <div className="toolbar-section toolbar-right">
          {/* Connection Status Badge */}
          <div className="status-indicator">
            {isConnected ? (
              <span className={`status-badge ${isStream ? 'stream-live' : 'connected'}`}>
                <span className="live-dot" />
                <span>{isStream ? 'LIVE STREAM' : 'LIVE'}</span>
              </span>
            ) : (
              <span className="status-badge disconnected">
                <WifiOff size={12} />
                <span>Offline</span>
              </span>
            )}
          </div>

          {/* Viewers Count */}
          <div className="viewers-count" title="Active viewers connected">
            <span>👥 {viewersCount}</span>
          </div>

          {/* New Tab Stream link (pointing to /stream/:roomId) */}
          {!isStream && (
            <a
              href={`/stream/${roomId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="tool-btn-sm new-tab-btn"
              title={`Open stream in a new tab: /stream/${roomId}`}
            >
              <span>/stream</span>
              <ExternalLink size={12} />
            </a>
          )}

          {/* Dedicated Settings Pop Up Trigger & Dropdown */}
          <div className="settings-trigger-wrapper" ref={settingsRef}>
            <button
              type="button"
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              className={`tool-btn-sm settings-btn ${isSettingsOpen ? 'active' : ''}`}
              title="Studio Settings (Zoom, Batch, Save, Telemetry)"
              aria-label="Studio Settings"
              aria-expanded={isSettingsOpen}
            >
              <Settings size={13} className={isSettingsOpen ? 'text-indigo-400' : 'text-slate-400'} />
              <span className="btn-label-responsive">Settings</span>
            </button>

            {isSettingsOpen && (
              <>
                <div
                  className="settings-backdrop"
                  onClick={() => setIsSettingsOpen(false)}
                />
                <div className="settings-popover-dropdown">
                <div className="settings-popover-header">
                  <div className="settings-popover-title">
                    <Settings size={14} className="text-indigo-400" />
                    <span>{isStream ? 'Stream Settings' : 'Studio Settings'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="settings-close-btn"
                    title="Close Settings"
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="settings-popover-body">
                  {/* 1. Zoom Controls */}
                  <div className="settings-item">
                    <div className="settings-label-row">
                      <span className="settings-label">
                        <ZoomIn size={12} className="text-slate-400" />
                        <span>Canvas Zoom</span>
                      </span>
                      <span className="settings-value-pill">
                        {Math.round(currentZoom * 100)}%
                      </span>
                    </div>
                    <div className="settings-controls-row">
                      {onZoomIn && (
                        <button
                          type="button"
                          onClick={onZoomIn}
                          className="settings-action-btn flex-1"
                          title="Zoom In (up to 500%)"
                        >
                          <ZoomIn size={12} />
                          <span>Zoom In</span>
                        </button>
                      )}
                      {onResetZoom && currentZoom > MIN_ZOOM && (
                        <button
                          type="button"
                          onClick={onResetZoom}
                          className="settings-action-btn flex-1 reset-btn"
                          title="Reset to 100%"
                        >
                          <RotateCcw size={12} />
                          <span>Reset 100%</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 2. Network Batch Interval (Write mode only) */}
                  {!isStream && (
                    <div className="settings-item">
                      <div className="settings-label-row">
                        <span className="settings-label">
                          <Clock size={12} className="text-slate-400" />
                          <span>Batch Interval</span>
                        </span>
                        <span className="settings-value-pill">
                          {batchIntervalMs}ms
                        </span>
                      </div>
                      <div className="segmented-pill-box w-full-box">
                        <button
                          type="button"
                          className={`seg-btn-xs ${batchIntervalMs === NETWORK_BATCH_INTERVALS.FAST ? 'active' : ''}`}
                          onClick={() => setBatchIntervalMs?.(NETWORK_BATCH_INTERVALS.FAST)}
                          title="Recommended: 16ms (~60 updates/sec)"
                        >
                          16ms (Fast)
                        </button>
                        <button
                          type="button"
                          className={`seg-btn-xs ${batchIntervalMs === NETWORK_BATCH_INTERVALS.RELAXED ? 'active' : ''}`}
                          onClick={() => setBatchIntervalMs?.(NETWORK_BATCH_INTERVALS.RELAXED)}
                          title="Relaxed: 33ms (~30 updates/sec)"
                        >
                          33ms (Relaxed)
                        </button>
                      </div>
                      <div className="settings-slider-row">
                        <input
                          type="range"
                          min="8"
                          max="100"
                          step="1"
                          value={batchIntervalMs ?? 16}
                          onChange={(e) => setBatchIntervalMs?.(Number(e.target.value))}
                          className="mini-slider flex-1"
                          title={`Batch Interval: ${batchIntervalMs}ms`}
                        />
                      </div>
                    </div>
                  )}

                  {/* 3. Autosave Frequency (Write mode only) */}
                  {!isStream && (
                    <div className="settings-item">
                      <div className="settings-label-row">
                        <span className="settings-label">
                          <HardDrive size={12} className="text-slate-400" />
                          <span>Autosave Interval</span>
                        </span>
                        <span className="settings-value-pill">
                          {autosaveIntervalSec}s
                        </span>
                      </div>
                      <div className="segmented-pill-box w-full-box">
                        {AUTOSAVE_OPTIONS.map((sec) => (
                          <button
                            type="button"
                            key={sec}
                            className={`seg-btn-xs ${autosaveIntervalSec === sec ? 'active' : ''}`}
                            onClick={() => setAutosaveIntervalSec?.(sec)}
                            title={`Autosave every ${sec}s`}
                          >
                            {sec}s
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 4. Canvas Wipe (Write mode only) */}
                  {!isStream && clearCanvas && (
                    <div className="settings-item">
                      <div className="settings-label-row">
                        <span className="settings-label">
                          <Trash2 size={12} className="text-rose-400" />
                          <span>Clear Canvas</span>
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('Are you sure you want to clear the whiteboard canvas for all viewers?')) {
                            clearCanvas();
                            setIsSettingsOpen(false);
                          }
                        }}
                        className="settings-action-btn btn-danger-action w-full-btn"
                        title="Clear all elements on whiteboard"
                      >
                        <Trash2 size={12} />
                        <span>Wipe Entire Whiteboard</span>
                      </button>
                    </div>
                  )}

                  {/* 5. Telemetry Banner Toggle */}
                  <div className="settings-item">
                    <div className="settings-label-row">
                      <span className="settings-label">
                        <Activity size={12} className="text-blue-400" />
                        <span>Telemetry Metrics Bar</span>
                      </span>
                      <button
                        type="button"
                        onClick={handleToggleTelemetry}
                        className={`settings-toggle-btn ${isTelemetryVisible ? 'active' : ''}`}
                        title="Toggle live metrics banner row"
                      >
                        {isTelemetryVisible ? 'Visible' : 'Hidden'}
                      </button>
                    </div>
                  </div>

                  {/* WebRTC SFU Telemetry Dashboard Link */}
                  <div className="settings-item">
                    <div className="settings-label-row">
                      <span className="settings-label">
                        <Radio size={12} className="text-emerald-400" />
                        <span>WebRTC SFU Dashboard</span>
                      </span>
                    </div>
                    <a
                      href="/sfu-dashboard"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-action-btn w-full-btn"
                      style={{
                        textDecoration: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                        background: 'rgba(56, 189, 248, 0.12)',
                        color: '#38bdf8',
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: '500',
                        marginTop: '4px',
                      }}
                      title="Inspect all active rooms, publishers, subscribers, and WebRTC SFU telemetry"
                    >
                      <span>Open SFU Dashboard</span>
                      <ExternalLink size={12} />
                    </a>
                  </div>

                  {/* 6. Viewer Controls (Stream mode only) */}
                  {isStream && (
                    <div className="settings-item">
                      <div className="settings-label-row">
                        <span className="settings-label">
                          <Sliders size={12} className="text-emerald-400" />
                          <span>Viewer Actions</span>
                        </span>
                      </div>
                      <div className="settings-controls-row">
                        {onFitToScreen && (
                          <button
                            type="button"
                            onClick={() => {
                              onFitToScreen();
                              setIsSettingsOpen(false);
                            }}
                            className="settings-action-btn flex-1"
                            title="Fit whiteboard to screen"
                          >
                            <Scan size={12} />
                            <span>Fit Canvas</span>
                          </button>
                        )}
                        {onExportJson && (
                          <button
                            type="button"
                            onClick={() => {
                              onExportJson();
                              setIsSettingsOpen(false);
                            }}
                            className="settings-action-btn flex-1"
                            title="Download snapshot JSON"
                          >
                            <Download size={12} />
                            <span>Export JSON</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          </div>

          {/* Fullscreen Button (if on Stream page) */}
          {isStream && onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className={`tool-btn-sm icon-only ${isFullscreen ? 'active' : ''}`}
              title={isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen'}
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* =========================================================================
          LINE 2: DEDICATED TELEMETRY STATUS ROW (Collapsible)
          ========================================================================= */}
      {isTelemetryVisible && (
        <div className="toolbar-row-telemetry">
          {!isStream ? (
            <div className="telemetry-track">
              <div className="telemetry-pill-compact" title="Local Rendering Latency">
                <Zap size={11} className="text-amber-500" />
                <span>Local GPU: <strong>0ms</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Outgoing Network Transmission Rate">
                <Activity size={11} className="text-blue-600" />
                <span>Transmit: <strong>{metrics.packetsSentPerSec || 0} pps</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Active Batch Cadence Setting">
                <Clock size={11} className="text-slate-600" />
                <span>Cadence: <strong>{batchIntervalMs}ms</strong> (~{Math.round(1000 / (batchIntervalMs || 16))} fps)</span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Round-trip Ping Latency">
                <Sparkles size={11} className="text-indigo-600" />
                <span>Latency: <strong>{metrics.latencyMs || 0}ms</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div
                className={`telemetry-pill-compact ${metrics.lastStrokeFlushedImmediately ? 'pulse-green' : ''}`}
                title="Immediate Stroke Completion Flush on pointer release"
              >
                <CheckCircle2 size={11} className="text-emerald-600" />
                <span>Stroke Flush: <strong>0ms delay</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Total Elements on Board">
                <Layers size={11} className="text-slate-500" />
                <span>Elements: <strong>{metrics.elementCount || 0}</strong></span>
              </div>
            </div>
          ) : (
            <div className="telemetry-track">
              <div className="telemetry-pill-compact" title="Presenter Status">
                <span className={`pill-dot ${broadcasterOnline ? 'green' : 'amber'}`} />
                <span>Status: <strong>{broadcasterOnline ? 'Broadcaster Active' : 'Waiting for Broadcaster...'}</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Incoming Stream Frame Frequency">
                <Activity size={11} className="text-blue-600" />
                <span>Stream: <strong>{metrics.incomingEventsPerSec || metrics.fps || 0} ev/s</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="End-to-End Receive-to-Apply Latency">
                <Sparkles size={11} className="text-emerald-600" />
                <span>Latency: <strong>{metrics.receiveToApplyLatencyMs || metrics.latencyMs || 0}ms</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Receiver Buffer Queue Backlog">
                <Clock size={11} className="text-slate-500" />
                <span>Queue: <strong>{metrics.bufferedEvents || 0} buffered</strong></span>
              </div>

              <span className="telemetry-sep">•</span>

              <div className="telemetry-pill-compact" title="Total Elements Rendered">
                <Layers size={11} className="text-slate-500" />
                <span>Elements: <strong>{metrics.elementCount || 0}</strong></span>
              </div>

              {metrics.healthStatus && metrics.healthStatus !== 'Optimal' && (
                <>
                  <span className="telemetry-sep">•</span>
                  <div
                    className={`telemetry-pill-compact health-${metrics.healthStatus.toLowerCase()}`}
                    title={`Receiver State: ${metrics.healthStatus}`}
                  >
                    <span className="pill-dot amber" />
                    <span>State: <strong>{metrics.healthStatus}</strong></span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
