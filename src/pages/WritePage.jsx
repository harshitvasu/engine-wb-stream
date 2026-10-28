import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { TopToolbar } from '../components/TopToolbar';
import { WhiteboardCanvas } from '../components/WhiteboardCanvas';
import { ScreenShareView } from '../components/ScreenShareView';
import { FullVideoView } from '../components/FullVideoView';
import { PublisherVideoThumbnail } from '../components/PublisherVideoThumbnail';
import { useWhiteboardStreamer } from '../hooks/useWhiteboardStreamer';
import { useWebRTCStreamer } from '../hooks/useWebRTCStreamer';
import { ShieldAlert, RotateCcw, Radio } from 'lucide-react';

export function WritePage() {
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExcalidrawMenuVisible, setIsExcalidrawMenuVisible] = useState(false);
  const toggleExcalidrawMenu = useCallback(() => {
    setIsExcalidrawMenuVisible((prev) => !prev);
  }, []);

  // App-level locked fullscreen: only the fullscreen button controls entering/exiting fullscreen.
  const toggleFullscreen = useCallback(() => {
    const isNativeFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    if (isNativeFs) {
      try {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch {}
    }

    setIsFullscreen((prev) => !prev);
  }, []);

  // Trigger canvas resize recalculation when entering / exiting fullscreen
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 80);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

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
    activeShareMode,
    broadcastShareMode,
    broadcastVideoRotation,
    metrics,
    handleExcalidrawChange,
    handlePointerDown,
    handlePointerUp,
  } = useWhiteboardStreamer({ roomId: 'default' });

  const handleScreenShareEnded = useCallback(() => {
    broadcastShareMode('whiteboard');
  }, [broadcastShareMode]);

  const {
    localStream,
    screenStream,
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
    toggleScreenShare,
    isMicMuted,
    isVideoDisabled,
    isRtcConnected,
    rtcError,
    permissionError,
    videoRotation,
    setVideoRotation,
    toggleMic,
    toggleVideo,
    retryWebRTC,
  } = useWebRTCStreamer({
    roomId: 'default',
    autoStart: !writeError,
    activeShareMode,
    onScreenShareEnded: handleScreenShareEnded,
  });

  // Handle switching presentation share mode (Whiteboard, Screen Share, Full Video)
  const handleSelectShareMode = useCallback(async (mode) => {
    if (mode === 'screen') {
      if (!isScreenSharing) {
        const stream = await startScreenShare();
        if (!stream) return; // User cancelled or permission denied
      }
      broadcastShareMode('screen');
    } else if (mode === 'video') {
      if (isScreenSharing) {
        stopScreenShare();
      }
      broadcastShareMode('video');
    } else {
      if (isScreenSharing) {
        stopScreenShare();
      }
      broadcastShareMode('whiteboard');
    }
  }, [isScreenSharing, startScreenShare, stopScreenShare, broadcastShareMode]);

  const handleRotateVideo = useCallback(() => {
    setVideoRotation((prev) => {
      const next = prev + 90;
      broadcastVideoRotation(next % 360);
      return next;
    });
  }, [setVideoRotation, broadcastVideoRotation]);

  return (
    <div
      ref={containerRef}
      className={`page-layout ${isFullscreen ? 'write-fullscreen' : ''}`}
    >
      {/* 1. Single Unified Top Toolbar with Presentation Mode Selector */}
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
        metrics={metrics}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        activeShareMode={activeShareMode}
        onSelectShareMode={handleSelectShareMode}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={toggleScreenShare}
      />

      {/* 2. Error Screen when 2nd write window tries to open, or Active Presentation Stage */}
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
      ) : activeShareMode === 'screen' ? (
        /* Screen Share Presentation Stage (Presenter Screen Preview - Muted) */
        <ScreenShareView
          stream={screenStream}
          isLive={isScreenSharing}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          isPublisher={true}
        />
      ) : activeShareMode === 'video' ? (
        /* Full Resolution Presenter Video Stage (Broadcaster Preview - Muted) */
        <FullVideoView
          stream={localStream}
          isLive={!isVideoDisabled}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          rotation={videoRotation}
          isPublisher={true}
        />
      ) : (
        /* Isolated & Memoized Whiteboard Canvas */
        <WhiteboardCanvas
          onMount={setExcalidrawAPI}
          onChange={handleExcalidrawChange}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          zoom={currentZoom}
          isExcalidrawMenuVisible={isExcalidrawMenuVisible}
          onToggleExcalidrawMenu={toggleExcalidrawMenu}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          isStreamingPaused={isStreamingPaused}
          onToggleStreamingPause={() => setIsStreamingPaused((prev) => !prev)}
          onClearCanvas={clearCanvas}
        />
      )}

      {/* Floating WebRTC Broadcaster Audio/Video Thumbnail (Always visible in Whiteboard and Screen Share modes) */}
      {!writeError && activeShareMode !== 'video' && (
        <PublisherVideoThumbnail
          stream={localStream}
          isPublisher={true}
          isConnected={isRtcConnected}
          isMicMuted={isMicMuted}
          isVideoDisabled={isVideoDisabled}
          isScreenSharing={isScreenSharing}
          onToggleScreenShare={toggleScreenShare}
          rotation={videoRotation}
          onRotate={handleRotateVideo}
          onToggleMic={toggleMic}
          onToggleVideo={toggleVideo}
          onRetryMedia={retryWebRTC}
          error={permissionError || rtcError}
        />
      )}
    </div>
  );
}