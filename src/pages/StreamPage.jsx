import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { Sliders, Minimize2 } from 'lucide-react';
import { TopToolbar } from '../components/TopToolbar';
import { WhiteboardFrame } from '../components/WhiteboardFrame';
import { StreamControlsPanel } from '../components/StreamControlsPanel';
import { PublisherVideoThumbnail } from '../components/PublisherVideoThumbnail';
import { useWhiteboardViewer } from '../hooks/useWhiteboardViewer';
import { useWebRTCViewer } from '../hooks/useWebRTCViewer';
import { MIN_VIEWER_ZOOM } from '../config/constants';

// Memoized Viewer Canvas to completely isolate Excalidraw from toolbar telemetry updates
const MemoizedStreamCanvas = React.memo(function MemoizedStreamCanvas({ onMount, isFullscreen }) {
  return (
    <main className={`canvas-viewport-wrapper stream-canvas excalidraw-menu-hidden ${isFullscreen ? 'stream-fullscreen-viewport' : ''}`}>
      <WhiteboardFrame zoom={1.0} minZoom={MIN_VIEWER_ZOOM} isStream={true}>
        <Excalidraw
          excalidrawAPI={onMount}
          viewModeEnabled={true}
          zenModeEnabled={true}
          gridModeEnabled={false}
          theme="light"
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              loadScene: false,
              saveToActiveFile: false,
              theme: false,
              export: false,
              toggleTheme: false,
            },
            tools: {
              image: false,
            },
          }}
        />
      </WhiteboardFrame>
    </main>
  );
});

export function StreamPage() {
  const {
    setExcalidrawAPI,
    isConnected,
    broadcasterOnline,
    metrics,
    excalidrawAPI,
    fitToScreen,
    controls,
    updateControl,
    setProfile,
    flushManualBuffer,
    resetControlsToDefaults,
  } = useWhiteboardViewer({ roomId: 'default' });

  const {
    remoteStream,
    isRtcConnected,
    hasAudioTrack,
    hasVideoTrack,
    isAudioMuted,
    volume,
    rtcError,
    toggleAudioMute,
    setVolume,
    requestKeyframe,
  } = useWebRTCViewer({ roomId: 'default' });

  const [isControlsOpen, setIsControlsOpen] = useState(false);
  // Default load in fullscreen mode as requested (R2)
  const [isFullscreen, setIsFullscreen] = useState(true);
  const containerRef = useRef(null);

  const toggleControls = useCallback(() => {
    setIsControlsOpen((prev) => !prev);
  }, []);

  // Listen to native fullscreen changes (via Esc, browser UI, or API)
  useEffect(() => {
    let hadNativeFs = false;
    const handleFsChange = () => {
      const isNativeFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
      if (isNativeFs) {
        hadNativeFs = true;
        setIsFullscreen(true);
      } else if (hadNativeFs) {
        hadNativeFs = false;
        setIsFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    document.addEventListener('mozfullscreenchange', handleFsChange);
    document.addEventListener('MSFullscreenChange', handleFsChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
      document.removeEventListener('mozfullscreenchange', handleFsChange);
      document.removeEventListener('MSFullscreenChange', handleFsChange);
    };
  }, []);

  // Trigger canvas resize recalculation when entering / exiting fullscreen or on initial mount
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 80);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    const isNativeFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );

    if (isNativeFs) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
      setIsFullscreen(false);
    } else if (isFullscreen) {
      // Fallback CSS fullscreen exit
      setIsFullscreen(false);
    } else if (el) {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
          // Native fullscreen failed (common on iOS Safari) -> use bulletproof CSS fullscreen
          setIsFullscreen(true);
        });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else if (el.msRequestFullscreen) {
        el.msRequestFullscreen();
      } else {
        // iOS Safari and mobile browsers without Fullscreen API
        setIsFullscreen(true);
      }
    }
  }, [isFullscreen]);

  const downloadSnapshotJson = useCallback(() => {
    if (!excalidrawAPI) return;
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const data = {
      type: 'excalidraw',
      version: 2,
      source: 'ExcaliStream',
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor || '#ffffff',
      },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `excalistream-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [excalidrawAPI]);

  return (
    <div className={`page-layout ${isFullscreen ? 'stream-fullscreen' : ''}`} ref={containerRef}>
      {/* 1. Single Unified Top Toolbar (Contains all stream navigation, telemetry, and actions) */}
      <TopToolbar
        isConnected={isConnected}
        viewersCount={metrics.viewersCount}
        isStream={true}
        onFitToScreen={fitToScreen}
        onExportJson={downloadSnapshotJson}
        onToggleFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
        onToggleControls={toggleControls}
        isControlsOpen={isControlsOpen}
        metrics={metrics}
        broadcasterOnline={broadcasterOnline}
      />

      {/* 2. Whiteboard Canvas (Zero re-renders; covers screen all the way down to bottom) */}
      <MemoizedStreamCanvas onMount={setExcalidrawAPI} isFullscreen={isFullscreen} />

      {/* 3. Collapsible Stream Controls Panel */}
      <StreamControlsPanel
        isOpen={isControlsOpen}
        onClose={() => setIsControlsOpen(false)}
        controls={controls}
        updateControl={updateControl}
        setProfile={setProfile}
        flushManualBuffer={flushManualBuffer}
        resetControlsToDefaults={resetControlsToDefaults}
        metrics={metrics}
      />

      {/* Floating Exit Fullscreen Button when in Fullscreen */}
      {isFullscreen && (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="floating-exit-fullscreen-btn"
          title="Exit Fullscreen"
          aria-label="Exit Fullscreen"
        >
          <Minimize2 size={14} />
          <span>Exit Fullscreen</span>
        </button>
      )}

      {/* Floating WebRTC Viewer Audio/Video Thumbnail */}
      <PublisherVideoThumbnail
        stream={remoteStream}
        isPublisher={false}
        isConnected={isRtcConnected}
        hasAudioTrack={hasAudioTrack}
        hasVideoTrack={hasVideoTrack}
        isAudioMuted={isAudioMuted}
        onToggleAudioMute={toggleAudioMute}
        volume={volume}
        onVolumeChange={setVolume}
        onRequestKeyframe={requestKeyframe}
        error={rtcError}
      />
    </div>
  );
}