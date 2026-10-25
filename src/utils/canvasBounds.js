import { FIXED_CANVAS_WIDTH, FIXED_CANVAS_HEIGHT, MIN_ZOOM, MAX_ZOOM } from '../config/constants';

/**
 * Clamps zoom value strictly between MIN_ZOOM (1.0) and MAX_ZOOM (5.0).
 * Prevents zoom-out past the initial 100% canvas frame.
 */
export function clampZoom(zoomValue) {
  if (typeof zoomValue !== 'number' || isNaN(zoomValue)) return MIN_ZOOM;
  return Math.min(Math.max(zoomValue, MIN_ZOOM), MAX_ZOOM);
}

/**
 * Clamps pan coordinates (scrollX, scrollY) within the fixed canvas bounds.
 * When zoom = 1.0, panning is locked so the full 1600x900 canvas remains in view.
 * When zoom > 1.0, panning is allowed only within the magnified 1600x900 coordinate region.
 */
export function clampPan(scrollX, scrollY, zoomValue, viewportWidth = FIXED_CANVAS_WIDTH, viewportHeight = FIXED_CANVAS_HEIGHT) {
  const zoom = clampZoom(zoomValue);

  // If at 100% (initial full view), keep scene centered / locked
  if (zoom <= 1.001) {
    // Initial centered offset
    const targetScrollX = (viewportWidth - FIXED_CANVAS_WIDTH) / 2;
    const targetScrollY = (viewportHeight - FIXED_CANVAS_HEIGHT) / 2;
    return {
      scrollX: targetScrollX,
      scrollY: targetScrollY,
    };
  }

  // When zoomed in, allowable panning range in coordinate space:
  // Visible coordinate width: viewportWidth / zoom
  const visibleWidth = viewportWidth / zoom;
  const visibleHeight = viewportHeight / zoom;

  // Coordinate min/max
  const minCoordX = 0;
  const maxCoordX = Math.max(0, FIXED_CANVAS_WIDTH - visibleWidth);
  const minCoordY = 0;
  const maxCoordY = Math.max(0, FIXED_CANVAS_HEIGHT - visibleHeight);

  // Clamped coordinate position
  // In Excalidraw: screenX = (sceneX + scrollX) * zoom
  // sceneX = screenX / zoom - scrollX
  // So scrollX = -clampedSceneOriginX
  const currentOriginX = -scrollX;
  const currentOriginY = -scrollY;

  const clampedOriginX = Math.min(Math.max(currentOriginX, minCoordX), maxCoordX);
  const clampedOriginY = Math.min(Math.max(currentOriginY, minCoordY), maxCoordY);

  return {
    scrollX: -clampedOriginX,
    scrollY: -clampedOriginY,
  };
}
