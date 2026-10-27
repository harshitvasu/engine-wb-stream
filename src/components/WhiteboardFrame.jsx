import React, { useRef, useEffect } from 'react';
import { MIN_ZOOM } from '../config/constants';

/**
 * WhiteboardFrame
 * Strictly holds the Excalidraw whiteboard in a fixed 16:9 aspect ratio container.
 * Intercepts zoom-out events at container level to prevent zooming out below initial 100% canvas bounds.
 */
export function WhiteboardFrame({
  children,
  zoom = 1.0,
  minZoom = MIN_ZOOM,
  isStream = false,
  className = '',
}) {
  const containerRef = useRef(null);

  // Prevent zoom out past minZoom on mouse wheel / trackpad pinch
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e) => {
      // If user holds Ctrl/Cmd to zoom or pinch-zooms
      if (e.ctrlKey || e.metaKey) {
        // e.deltaY > 0 represents zooming out
        if (e.deltaY > 0 && zoom <= minZoom) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    el.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [zoom, minZoom]);

  return (
    <div className={`canvas-outer-wrapper ${isStream ? 'stream-outer-wrapper' : ''} ${className}`}>
      <div ref={containerRef} className="fixed-aspect-container">
        <div className="excalidraw-mount-point">
          {children}
        </div>
      </div>
    </div>
  );
}
