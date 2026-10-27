import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Maximize2, Minimize2, Pause, Play, Trash2, Menu } from 'lucide-react';

/**
 * ExcalidrawFullscreenButton (Excalidraw Action Island)
 * Renders tool buttons (Menu toggle, Pause/Resume, Clear Canvas, and Fullscreen toggle)
 * directly inside Excalidraw's top-left menu container ("App-menu_top__left").
 *
 * When active, only the Excalidraw canvas is visible from the Write page
 * (top toolbar is hidden, fixed 16:9 ratio is preserved, presenter cam floats on top).
 */
export function ExcalidrawFullscreenButton({
  isFullscreen = false,
  onToggleFullscreen,
  isStreamingPaused = false,
  onToggleStreamingPause,
  onClearCanvas,
  isExcalidrawMenuVisible = false,
  onToggleExcalidrawMenu,
  containerRef,
}) {
  const [targetEl, setTargetEl] = useState(null);
  const [portalKey, setPortalKey] = useState(0);
  const targetRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
    let rafId = null;
    const root = containerRef?.current || document;

    const syncTarget = () => {
      if (!isMounted) return;
      const currentEl = root.querySelector('.App-menu_top__left');
      if (!currentEl) {
        if (targetRef.current) {
          targetRef.current = null;
          setTargetEl(null);
        }
        return;
      }

      const hasIsland = Boolean(currentEl.querySelector('.excalidraw-actions-island'));

      // If Excalidraw recreated the menu container (e.g. after backgrounding Safari or tool switch)
      // or if Excalidraw's React reconciliation removed our portal children, re-mount cleanly.
      if (currentEl !== targetRef.current || !hasIsland) {
        targetRef.current = currentEl;
        setTargetEl(currentEl);
        setPortalKey((prev) => prev + 1);
      }
    };

    // Initial immediate scan
    syncTarget();

    // Persistent observer: continuously watches DOM mutations inside Excalidraw
    // so our buttons are never wiped when Excalidraw re-renders.
    const observer = new MutationObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        syncTarget();
      });
    });

    observer.observe(root, { childList: true, subtree: true });

    // When returning to Safari from another app or switching tabs,
    // immediately re-sync and restore the action buttons.
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        syncTarget();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('pageshow', handleVisibilityOrFocus);

    // Heartbeat check: safeguards against mobile Safari background freezing
    const heartbeat = setInterval(syncTarget, 600);

    return () => {
      isMounted = false;
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('pageshow', handleVisibilityOrFocus);
      clearInterval(heartbeat);
    };
  }, [containerRef]);

  if (!targetEl) return null;

  return ReactDOM.createPortal(
    <div key={portalKey} className="Island excalidraw-actions-island">
      {/* Excalidraw Menu Toggle Button */}
      {onToggleExcalidrawMenu && (
        <button
          type="button"
          className={`dropdown-menu-button excalidraw-action-btn excalidraw-menu-btn ${
            isExcalidrawMenuVisible ? 'active' : ''
          }`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggleExcalidrawMenu();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          title={isExcalidrawMenuVisible ? 'Hide Excalidraw Menu' : 'Show Excalidraw Menu'}
          aria-label={isExcalidrawMenuVisible ? 'Hide Excalidraw Menu' : 'Show Excalidraw Menu'}
        >
          <Menu size={16} />
        </button>
      )}

      {/* Pause / Resume Live Streaming Button */}
      {onToggleStreamingPause && (
        <button
          type="button"
          className={`dropdown-menu-button excalidraw-action-btn excalidraw-pause-btn ${
            isStreamingPaused ? 'paused' : ''
          }`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggleStreamingPause();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          title={isStreamingPaused ? 'Resume live streaming' : 'Pause live streaming'}
          aria-label={isStreamingPaused ? 'Resume live streaming' : 'Pause live streaming'}
        >
          {isStreamingPaused ? <Play size={16} /> : <Pause size={16} />}
        </button>
      )}

      {/* Clear Canvas Button */}
      {onClearCanvas && (
        <button
          type="button"
          className="dropdown-menu-button excalidraw-action-btn excalidraw-clear-btn"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClearCanvas();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          title="Clear canvas"
          aria-label="Clear canvas"
        >
          <Trash2 size={16} />
        </button>
      )}

      {/* Fullscreen Toggle Button */}
      {onToggleFullscreen && (
        <button
          type="button"
          className={`dropdown-menu-button excalidraw-action-btn excalidraw-fullscreen-button ${
            isFullscreen ? 'active' : ''
          }`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggleFullscreen?.();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          title={
            isFullscreen
              ? 'Exit Fullscreen'
              : 'Toggle Fullscreen (Excalidraw only)'
          }
          aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
    </div>,
    targetEl
  );
}
