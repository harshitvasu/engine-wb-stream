import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { TopToolbar } from '../components/TopToolbar';
import { WhiteboardCanvas } from '../components/WhiteboardCanvas';
import { useWhiteboardStreamer } from '../hooks/useWhiteboardStreamer';
import { ShieldAlert, RotateCcw, Radio } from 'lucide-react';

export function WritePage() {
  const [isExcalidrawMenuVisible, setIsExcalidrawMenuVisible] = useState(false);
  const toggleExcalidrawMenu = useCallback(() => {
    setIsExcalidrawMenuVisible((prev) => !prev);
  }, []);

  const {
    setExcalidrawAPI,
    isConnected,
    writeError,
    retryConnection,
    batchIntervalMs,
    setBatchIntervalMs,
    autosaveIntervalSec,
    setAutosaveIntervalSec,
    isStreamingPaused,
    setIsStreamingPaused,
    currentZoom,
    zoomIn,
    resetZoom,
    clearCanvas,
    metrics,
    handleExcalidrawChange,
    handlePointerDown,
    handlePointerUp,
  } = useWhiteboardStreamer({ roomId: 'default' });

  return (
    <div className="page-layout">
      {/* 1. Single Unified Top Toolbar (Contains all navigation, cadence parameters, telemetry, and actions) */}
      <TopToolbar
        isConnected={isConnected && !writeError}
        viewersCount={metrics.viewersCount}
        currentZoom={currentZoom}
        onZoomIn={zoomIn}
        onResetZoom={resetZoom}
        isStream={false}
        batchIntervalMs={batchIntervalMs}
        setBatchIntervalMs={setBatchIntervalMs}
        autosaveIntervalSec={autosaveIntervalSec}
        setAutosaveIntervalSec={setAutosaveIntervalSec}
        isStreamingPaused={isStreamingPaused}
        setIsStreamingPaused={setIsStreamingPaused}
        clearCanvas={clearCanvas}
        onToggleExcalidrawMenu={toggleExcalidrawMenu}
        isExcalidrawMenuVisible={isExcalidrawMenuVisible}
        metrics={metrics}
      />

      {/* 2. Error Screen when 2nd write window tries to open, or Whiteboard Canvas */}
      {writeError ? (
        <main className="canvas-viewport-wrapper">
          <div className="canvas-outer-wrapper stream-error-wrapper">
            <div className="stream-error-box">
              <div className="error-icon-circle">
                <ShieldAlert size={36} className="text-rose-600" />
              </div>
              <h2 className="error-title">Write Window Limit Reached</h2>
              <p className="error-message">
                Only <strong>one write window</strong> is allowed to be open at a time. Another write window is already active and broadcasting.
              </p>
              <div className="error-tips">
                <span>To edit the whiteboard here, please close the other write window first, then click below. Multiple stream viewers can watch at <strong>/stream</strong>.</span>
              </div>
              <div className="error-actions">
                <button onClick={retryConnection} className="error-btn-primary">
                  <RotateCcw size={14} />
                  <span>Retry Connection</span>
                </button>
                <Link to="/stream" className="error-btn-secondary">
                  <Radio size={14} />
                  <span>Watch Stream Instead</span>
                </Link>
              </div>
            </div>
          </div>
        </main>
      ) : (
        /* Isolated & Memoized Whiteboard Canvas (Zero re-renders; covers screen all the way down to bottom) */
        <WhiteboardCanvas
          onMount={setExcalidrawAPI}
          onChange={handleExcalidrawChange}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          zoom={currentZoom}
          isExcalidrawMenuVisible={isExcalidrawMenuVisible}
        />
      )}
    </div>
  );
}
