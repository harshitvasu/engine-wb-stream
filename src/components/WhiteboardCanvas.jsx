import React, { useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { WhiteboardFrame } from './WhiteboardFrame';
import { ExcalidrawFullscreenButton } from './ExcalidrawFullscreenButton';
import { getSavedWhiteboardData } from '../hooks/useWhiteboardStreamer';

/**
 * WhiteboardCanvas
 * Memoized canvas wrapper to guarantee the whiteboard never re-renders
 * when parent toolbars, metrics, or telemetry state update.
 */
export const WhiteboardCanvas = React.memo(function WhiteboardCanvas({
  onMount,
  onChange,
  onPointerDown,
  onPointerUp,
  zoom = 1.0,
  isExcalidrawMenuVisible = false,
  onToggleExcalidrawMenu,
  isFullscreen = false,
  onToggleFullscreen,
  isStreamingPaused = false,
  onToggleStreamingPause,
  onClearCanvas,
}) {
  const canvasWrapperRef = useRef(null);

  // Load saved state once on initial mount for instant refresh-proofing
  const initialData = useMemo(() => {
    return getSavedWhiteboardData();
  }, []);

  return (
    <main
      ref={canvasWrapperRef}
      className={`canvas-viewport-wrapper ${
        isExcalidrawMenuVisible
          ? 'excalidraw-menu-visible'
          : 'excalidraw-menu-hidden'
      } ${isFullscreen ? 'write-fullscreen-viewport' : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onTouchStart={onPointerDown}
      onTouchEnd={onPointerUp}
    >
      <WhiteboardFrame zoom={zoom}>
        <Excalidraw
          excalidrawAPI={onMount}
          onChange={onChange}
          initialData={initialData}
          theme="light"
          gridModeEnabled={false}
          zenModeEnabled={false}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: true,
              clearCanvas: false,
              loadScene: true,
              saveToActiveFile: false,
              theme: false,
              export: { saveFileToDisk: true },
            },
          }}
        />
      </WhiteboardFrame>

      {/* Action buttons (Menu, Pause/Resume, Clear, Fullscreen) rendered next to App-menu_top__left inside Excalidraw */}
      <ExcalidrawFullscreenButton
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        isStreamingPaused={isStreamingPaused}
        onToggleStreamingPause={onToggleStreamingPause}
        onClearCanvas={onClearCanvas}
        isExcalidrawMenuVisible={isExcalidrawMenuVisible}
        onToggleExcalidrawMenu={onToggleExcalidrawMenu}
        containerRef={canvasWrapperRef}
      />
    </main>
  );
});
