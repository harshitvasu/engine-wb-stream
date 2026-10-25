import React from 'react';
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
  Menu,
} from 'lucide-react';
import { MIN_ZOOM, NETWORK_BATCH_INTERVALS, AUTOSAVE_OPTIONS } from '../config/constants';

export function TopToolbar({
  isConnected = true,
  viewersCount = 0,
  currentZoom = 1.0,
  onZoomIn,
  onResetZoom,
  isStream = false,
  onExportJson,
  onToggleFullscreen,
  onToggleControls,
  isControlsOpen = false,
  onToggleExcalidrawMenu,
  isExcalidrawMenuVisible = false,
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
}) {
  return (
    <header className="app-top-toolbar unified-toolbar">
      {/* =========================================================================
          LINE 1: CONTROLS & SELECTORS ROW
          ========================================================================= */}
      <div className="toolbar-row-main">
        {/* 1. Left Section: Brand & Navigation */}
        <div className="toolbar-section toolbar-left">
          <div className="brand-badge">
            <div className="brand-dot-pulse" />
            <span className="brand-name">ExcaliStream</span>
          </div>

          <nav className="nav-pills">
            <NavLink
              to="/"
              end
              className={({ isActive }) => `pill-link ${isActive ? 'active' : ''}`}
            >
              <PenTool size={13} />
              <span>Write</span>
            </NavLink>
            <NavLink
              to="/stream"
              className={({ isActive }) => `pill-link ${isActive ? 'active' : ''}`}
            >
              <Radio size={13} />
              <span>Stream</span>
            </NavLink>
          </nav>

          <div className="ratio-indicator">
            <span>16:9</span>
          </div>

          {onToggleExcalidrawMenu && (
            <button
              type="button"
              onClick={onToggleExcalidrawMenu}
              className={`excalidraw-menu-toggle ${isExcalidrawMenuVisible ? 'active' : ''}`}
              title={isExcalidrawMenuVisible ? 'Hide Excalidraw Menu' : 'Show Excalidraw Menu'}
            >
              <Menu size={12} />
              <span>Menu</span>
            </button>
          )}
        </div>

        {/* 2. Center Section: Selectors Only */}
        <div className="toolbar-section toolbar-center">
          {!isStream ? (
            <div className="center-selectors-cluster">
              {/* Zoom Selector */}
              <div className="control-group">
                <span className="group-label">
                  Zoom: <strong>{Math.round(currentZoom * 100)}%</strong>
                </span>
                {onZoomIn && (
                  <button
                    type="button"
                    onClick={onZoomIn}
                    className="tool-btn-xs"
                    title="Zoom In (up to 500%)"
                  >
                    <ZoomIn size={12} />
                  </button>
                )}
                {onResetZoom && currentZoom > MIN_ZOOM && (
                  <button
                    type="button"
                    onClick={onResetZoom}
                    className="tool-btn-xs reset-btn"
                    title="Reset to 100%"
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>

              <span className="toolbar-divider" />

              {/* Network Batch Interval Selector with Live Value Badge & Slider */}
              <div className="control-group">
                <Clock size={12} className="text-slate-500" />
                <span className="group-label">Batch:</span>
                <div className="segmented-pill-box">
                  <button
                    type="button"
                    className={`seg-btn-xs ${batchIntervalMs === NETWORK_BATCH_INTERVALS.FAST ? 'active' : ''}`}
                    onClick={() => setBatchIntervalMs?.(NETWORK_BATCH_INTERVALS.FAST)}
                    title="Recommended: 16ms (~60 updates/sec)"
                  >
                    16ms
                  </button>
                  <button
                    type="button"
                    className={`seg-btn-xs ${batchIntervalMs === NETWORK_BATCH_INTERVALS.RELAXED ? 'active' : ''}`}
                    onClick={() => setBatchIntervalMs?.(NETWORK_BATCH_INTERVALS.RELAXED)}
                    title="Relaxed: 33ms (~30 updates/sec)"
                  >
                    33ms
                  </button>
                </div>

                <input
                  type="range"
                  min="8"
                  max="100"
                  step="1"
                  value={batchIntervalMs ?? 16}
                  onChange={(e) => setBatchIntervalMs?.(e.target.value)}
                  onInput={(e) => setBatchIntervalMs?.(e.target.value)}
                  className="mini-slider"
                  title={`Batch Interval: ${batchIntervalMs}ms`}
                />

                <span className="batch-value-badge" title="Current Batch Interval">
                  <strong>{batchIntervalMs}ms</strong>
                </span>
              </div>

              <span className="toolbar-divider" />

              {/* Autosave Interval Selector */}
              <div className="control-group">
                <HardDrive size={12} className="text-slate-500" />
                <span className="group-label">Save:</span>
                <div className="segmented-pill-box">
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
            </div>
          ) : (
            /* Stream: Follow Presenter (Default & Permanent) */
            <div className="center-selectors-cluster">
              <div className="telemetry-pill-compact" title="Synchronized with presenter zoom, pan, and strokes in real-time">
                <Eye size={12} className="text-blue-600" />
                <span>Follow Presenter</span>
              </div>
            </div>
          )}
        </div>

        {/* 3. Right Section: Actions & Connection Badge */}
        <div className="toolbar-section toolbar-right">
          {!isStream ? (
            <>
              {setIsStreamingPaused && (
                <button
                  type="button"
                  onClick={() => setIsStreamingPaused(!isStreamingPaused)}
                  className={`action-btn-sm ${isStreamingPaused ? 'paused' : ''}`}
                  title={isStreamingPaused ? 'Resume live streaming' : 'Pause live streaming'}
                >
                  {isStreamingPaused ? <Play size={12} /> : <Pause size={12} />}
                  <span>{isStreamingPaused ? 'Resume' : 'Pause'}</span>
                </button>
              )}

              {clearCanvas && (
                <button
                  type="button"
                  onClick={clearCanvas}
                  className="action-btn-sm clear-btn"
                  title="Clear canvas"
                >
                  <Trash2 size={12} />
                  <span>Clear</span>
                </button>
              )}

              <span className="toolbar-divider" />
            </>
          ) : (
            <>
              {onToggleControls && (
                <button
                  type="button"
                  onClick={onToggleControls}
                  className={`action-btn-sm controls-toggle-btn ${isControlsOpen ? 'active' : ''}`}
                  title={isControlsOpen ? 'Collapse Stream Controls' : 'Open Stream Controls'}
                >
                  <Sliders size={12} />
                  <span>Controls</span>
                  {metrics.isAutoThrottlingActive && (
                    <span className="control-pulse-dot" title="Auto-throttling active" />
                  )}
                </button>
              )}
              {onExportJson && (
                <button
                  type="button"
                  onClick={onExportJson}
                  className="tool-btn-sm"
                  title="Download current whiteboard snapshot as JSON"
                >
                  <Download size={12} />
                  <span>Export JSON</span>
                </button>
              )}
              {onToggleFullscreen && (
                <button
                  type="button"
                  onClick={onToggleFullscreen}
                  className="tool-btn-sm icon-only"
                  title="Toggle Fullscreen"
                >
                  <Maximize2 size={13} />
                </button>
              )}
              <span className="toolbar-divider" />
            </>
          )}

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

          {/* New Tab Stream link (on Write page) */}
          {!isStream && (
            <a
              href="/stream"
              target="_blank"
              rel="noopener noreferrer"
              className="tool-btn-sm new-tab-btn"
              title="Open /stream in a new tab"
            >
              <span>/stream</span>
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>

      {/* =========================================================================
          LINE 2: DEDICATED TELEMETRY STATUS ROW
          ========================================================================= */}
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
    </header>
  );
}
