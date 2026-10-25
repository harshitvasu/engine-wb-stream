import React, { useMemo } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { WhiteboardFrame } from './WhiteboardFrame';
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
}) {
  // Load saved state once on initial mount for instant refresh-proofing
  const initialData = useMemo(() => {
    return getSavedWhiteboardData();
  }, []);

  return (
    <main
      className={`canvas-viewport-wrapper ${isExcalidrawMenuVisible ? 'excalidraw-menu-visible' : 'excalidraw-menu-hidden'}`}
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
    </main>
  );
});
