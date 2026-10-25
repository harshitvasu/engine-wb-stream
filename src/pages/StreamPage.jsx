import React, { useState, useRef, useCallback } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { Sliders } from 'lucide-react';
import { TopToolbar } from '../components/TopToolbar';
import { WhiteboardFrame } from '../components/WhiteboardFrame';
import { StreamControlsPanel } from '../components/StreamControlsPanel';
import { useWhiteboardViewer } from '../hooks/useWhiteboardViewer';

// Memoized Viewer Canvas to completely isolate Excalidraw from toolbar telemetry updates
const MemoizedStreamCanvas = React.memo(function MemoizedStreamCanvas({ onMount }) {
  return (
    <main className="canvas-viewport-wrapper stream-canvas excalidraw-menu-hidden">
      <WhiteboardFrame zoom={1.0}>
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
    controls,
    updateControl,
    setProfile,
    flushManualBuffer,
    resetControlsToDefaults,
  } = useWhiteboardViewer({ roomId: 'default' });

  const [isControlsOpen, setIsControlsOpen] = useState(false);
  const containerRef = useRef(null);

  const toggleControls = useCallback(() => {
    setIsControlsOpen((prev) => !prev);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }, []);

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
    <div className="page-layout" ref={containerRef}>
      {/* 1. Single Unified Top Toolbar (Contains all stream navigation, telemetry, and actions) */}
      <TopToolbar
        isConnected={isConnected}
        viewersCount={metrics.viewersCount}
        isStream={true}
        onExportJson={downloadSnapshotJson}
        onToggleFullscreen={toggleFullscreen}
        onToggleControls={toggleControls}
        isControlsOpen={isControlsOpen}
        metrics={metrics}
        broadcasterOnline={broadcasterOnline}
      />

      {/* 2. Whiteboard Canvas (Zero re-renders; covers screen all the way down to bottom) */}
      <MemoizedStreamCanvas onMount={setExcalidrawAPI} />

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

      {/* Floating Re-Open Button when panel is collapsed */}
      {!isControlsOpen && (
        <button
          type="button"
          onClick={() => setIsControlsOpen(true)}
          className="floating-controls-trigger"
          title="Open Stream Controls"
          aria-label="Open Stream Controls"
        >
          <Sliders size={14} />
          <span className="trigger-label">Stream Controls</span>
          {metrics.isAutoThrottlingActive && (
            <span className="trigger-pulse-dot" title="Auto-throttling active" />
          )}
        </button>
      )}
    </div>
  );
}