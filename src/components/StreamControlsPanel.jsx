import React from 'react';
import {
  Sliders,
  X,
  RotateCcw,
  Zap,
  ShieldCheck,
  Gauge,
  HardDrive,
  Play,
  CheckCircle2,
} from 'lucide-react';
import {
  STREAM_PROFILES,
  MANUAL_RATE_PRESETS,
  MANUAL_BUFFER_PRESETS,
} from '../config/streamControlsConfig';

export function StreamControlsPanel({
  isOpen,
  onClose,
  controls,
  updateControl,
  setProfile,
  flushManualBuffer,
  resetControlsToDefaults,
  metrics,
}) {
  if (!isOpen) return null;

  const currentProfileId = controls.profile || 'smooth';
  const isManualMode = currentProfileId === 'manual';
  const manualRate = controls.manualRateFps || 30;
  const manualBuffer = controls.manualBufferSize || 20;
  const bufferedCount = metrics.bufferedEvents || 0;
  const isBuffering = metrics.isManualBuffering || (isManualMode && !metrics.isPlaybackActive && bufferedCount > 0);
  const isStreaming = isManualMode && metrics.isPlaybackActive && bufferedCount > 0;
  const bufferPercent = Math.min(100, Math.round((bufferedCount / manualBuffer) * 100));

  const healthBadgeStyle = {
    Optimal: { bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'Optimal' },
    Buffering: { bg: 'bg-amber-50 text-amber-700 border-amber-200', text: 'Buffering' },
    Streaming: { bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', text: 'Constant Streaming' },
    Throttling: { bg: 'bg-amber-50 text-amber-700 border-amber-200', text: 'Auto-Smoothing' },
    Recovering: { bg: 'bg-rose-50 text-rose-700 border-rose-200', text: 'Recovering' },
    Ready: { bg: 'bg-slate-50 text-slate-700 border-slate-200', text: 'Buffer Ready' },
  }[metrics.healthStatus || 'Optimal'] || { bg: 'bg-slate-50 text-slate-700 border-slate-200', text: 'Idle' };

  return (
    <aside className="stream-controls-compact-panel" aria-label="Stream Controls">
      {/* Header */}
      <div className="compact-panel-header">
        <div className="compact-panel-title-group">
          <Sliders size={14} className="text-slate-700" />
          <h2 className="compact-panel-title">Stream Performance</h2>
          <span className={`compact-status-badge ${isManualMode ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : healthBadgeStyle.bg}`}>
            {isManualMode ? (isBuffering ? 'Buffering Events' : isStreaming ? 'Streaming' : 'Buffer Ready') : healthBadgeStyle.text}
          </span>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="compact-close-btn"
          title="Close panel"
          aria-label="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="compact-panel-body">
        {/* 1. Mode / Performance Profile Selector */}
        <section className="compact-section">
          <label className="compact-section-label">
            <Zap size={12} className="text-slate-500" />
            <span>Playback Mode</span>
          </label>
          <div className="profile-selector-group">
            {STREAM_PROFILES.map((profile) => {
              const isSelected = currentProfileId === profile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`profile-card-btn ${isSelected ? 'selected' : ''} ${profile.id === 'manual' ? 'manual-card' : ''}`}
                  onClick={() => setProfile ? setProfile(profile.id) : updateControl('profile', profile.id)}
                >
                  <div className="profile-card-top">
                    <span className="profile-name">{profile.label}</span>
                    <span className="profile-fps">{profile.sublabel}</span>
                  </div>
                  <span className="profile-desc">{profile.description}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 2. Manual Stream Control Dedicated Parameter Section */}
        {isManualMode ? (
          <div className="manual-controls-box">
            {/* Live Buffer Status Card */}
            <div className="manual-status-card">
              <div className="manual-status-header">
                <span className="status-title-text">
                  {isBuffering ? 'Buffering events...' : isStreaming ? 'Streaming at constant rate' : 'Buffer Ready'}
                </span>
                {isBuffering && flushManualBuffer && (
                  <button
                    type="button"
                    onClick={flushManualBuffer}
                    className="play-now-btn"
                    title="Start streaming now without waiting for buffer to fill"
                  >
                    <Play size={10} fill="currentColor" />
                    <span>Play Now</span>
                  </button>
                )}
              </div>

              {/* Progress Bar */}
              <div className="meter-track-sm">
                <div
                  className="meter-fill-sm"
                  style={{
                    width: `${bufferPercent}%`,
                    backgroundColor: isBuffering ? '#f59e0b' : '#4f46e5',
                  }}
                />
              </div>

              <div className="meter-info-row">
                <span>
                  {isBuffering
                    ? `Accumulating: ${bufferedCount} / ${manualBuffer} events`
                    : `Buffer Queue: ${bufferedCount} events`}
                </span>
                <span className="meter-val-text">{bufferPercent}%</span>
              </div>
            </div>

            {/* A. Buffer Size Threshold */}
            <section className="compact-section">
              <div className="manual-section-header">
                <label className="compact-section-label" htmlFor="manual-buffer-slider">
                  <HardDrive size={12} className="text-indigo-600" />
                  <span>Target Buffer Size</span>
                </label>
                <span className="manual-badge">
                  <strong>{manualBuffer}</strong> events
                </span>
              </div>

              {/* Buffer Size Presets */}
              <div className="manual-presets-row">
                {MANUAL_BUFFER_PRESETS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`manual-preset-btn ${manualBuffer === size ? 'active' : ''}`}
                    onClick={() => updateControl('manualBufferSize', size)}
                  >
                    {size}
                  </button>
                ))}
              </div>

              <input
                id="manual-buffer-slider"
                type="range"
                min="5"
                max="150"
                step="5"
                value={manualBuffer}
                onChange={(e) => updateControl('manualBufferSize', parseInt(e.target.value, 10))}
                className="manual-slider"
                title={`Buffer Size: ${manualBuffer} events`}
              />
              <p className="compact-hint">Stores events until reaching this buffer size, then unlocks playback.</p>
            </section>

            {/* B. Constant Render Rate */}
            <section className="compact-section">
              <div className="manual-section-header">
                <label className="compact-section-label" htmlFor="manual-rate-slider">
                  <Gauge size={12} className="text-indigo-600" />
                  <span>Constant Render Rate</span>
                </label>
                <span className="manual-badge">
                  <strong>{manualRate}</strong> ev/s ({Math.round(1000 / manualRate)}ms)
                </span>
              </div>

              {/* Rate Presets */}
              <div className="manual-presets-row">
                {MANUAL_RATE_PRESETS.map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`manual-preset-btn ${manualRate === fps ? 'active' : ''}`}
                    onClick={() => updateControl('manualRateFps', fps)}
                  >
                    {fps}/s
                  </button>
                ))}
              </div>

              <input
                id="manual-rate-slider"
                type="range"
                min="5"
                max="60"
                step="1"
                value={manualRate}
                onChange={(e) => updateControl('manualRateFps', parseInt(e.target.value, 10))}
                className="manual-slider"
                title={`Constant Render Rate: ${manualRate} updates/sec`}
              />
              <p className="compact-hint">Streams buffered updates onto the whiteboard at a steady rate.</p>
            </section>
          </div>
        ) : (
          /* Preset Mode: Adaptive Lag Smoothing Toggle */
          <section className="compact-section">
            <div className="compact-toggle-row">
              <div className="compact-toggle-text">
                <div className="toggle-title-with-icon">
                  <ShieldCheck size={12} className="text-blue-600" />
                  <span className="compact-toggle-title">Lag Protection</span>
                </div>
                <p className="compact-toggle-desc">
                  Automatically smooths rendering during rapid drawing bursts.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={controls.autoThrottling}
                onClick={() => updateControl('autoThrottling', !controls.autoThrottling)}
                className={`toggle-switch-sm ${controls.autoThrottling ? 'on' : 'off'}`}
                title="Toggle adaptive lag protection"
              >
                <span className="toggle-handle-sm" />
              </button>
            </div>
          </section>
        )}

        {/* 3. Live Stream Telemetry Summary */}
        <section className="compact-section telemetry-summary-section">
          <div className="compact-telemetry-row">
            <div className="compact-stat-item">
              <span className="stat-label">Latency</span>
              <span className="stat-val">{metrics.receiveToApplyLatencyMs || metrics.latencyMs || 0}ms</span>
            </div>
            <span className="stat-divider" />
            <div className="compact-stat-item">
              <span className="stat-label">Playback</span>
              <span className="stat-val">
                {isManualMode ? `${manualRate} ev/s` : `${metrics.incomingEventsPerSec || metrics.fps || 0} ev/s`}
              </span>
            </div>
            <span className="stat-divider" />
            <div className="compact-stat-item">
              <span className="stat-label">Buffer</span>
              <span className="stat-val">{bufferedCount} queued</span>
            </div>
          </div>
        </section>
      </div>

      {/* Footer */}
      <div className="compact-panel-footer">
        <button
          type="button"
          onClick={resetControlsToDefaults}
          className="compact-reset-btn"
          title="Reset to default settings"
        >
          <RotateCcw size={11} />
          <span>Reset Defaults</span>
        </button>
        <span className="compact-footer-hint">
          {isManualMode
            ? `Constant: ${Math.round(1000 / manualRate)}ms`
            : `Cadence: ${controls.processingIntervalMs}ms`}
        </span>
      </div>
    </aside>
  );
}