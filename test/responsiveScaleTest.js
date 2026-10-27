import assert from 'assert';
import {
  FIXED_CANVAS_WIDTH,
  FIXED_CANVAS_HEIGHT,
  MIN_VIEWER_ZOOM,
} from '../src/config/constants.js';

function computeScaledSceneAppState(rawAppState, viewerWidth, viewerHeight) {
  if (!rawAppState) return null;

  const presenterWidth = rawAppState.width || FIXED_CANVAS_WIDTH;
  const presenterHeight = rawAppState.height || FIXED_CANVAS_HEIGHT;

  let scaleFactor = 1.0;
  let extraSceneX = 0;
  let extraSceneY = 0;

  if (viewerWidth > 0 && viewerHeight > 0 && presenterWidth > 0 && presenterHeight > 0) {
    const scaleX = viewerWidth / presenterWidth;
    const scaleY = viewerHeight / presenterHeight;
    scaleFactor = Math.min(scaleX, scaleY);

    const presenterZoom = rawAppState.zoom?.value || 1.0;
    if (scaleFactor > 0 && presenterZoom > 0) {
      extraSceneX = (viewerWidth / scaleFactor - presenterWidth) / (2 * presenterZoom);
      extraSceneY = (viewerHeight / scaleFactor - presenterHeight) / (2 * presenterZoom);
    }
  }

  const presenterZoom = rawAppState.zoom?.value || 1.0;
  const effectiveZoom = Math.max(MIN_VIEWER_ZOOM, presenterZoom * scaleFactor);

  const effectiveScrollX = (rawAppState.scrollX !== undefined ? rawAppState.scrollX : 0) + extraSceneX;
  const effectiveScrollY = (rawAppState.scrollY !== undefined ? rawAppState.scrollY : 0) + extraSceneY;

  return {
    zoom: { value: effectiveZoom },
    scrollX: effectiveScrollX,
    scrollY: effectiveScrollY,
    scaleFactor,
  };
}

console.log('--- Running Responsive Whiteboard Scaling Invariant Tests ---');

// Test Case 1: Standard Desktop 1600x900
{
  const presenter = { width: 1600, height: 900, zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 };
  const res = computeScaledSceneAppState(presenter, 1600, 900);
  assert.strictEqual(res.scaleFactor, 1.0, 'Scale factor on 1600x900 desktop must be 1.0');
  assert.strictEqual(res.zoom.value, 1.0, 'Effective zoom on 1600x900 desktop must be 1.0');
  assert.strictEqual(res.scrollX, 0, 'ScrollX must be 0');
  assert.strictEqual(res.scrollY, 0, 'ScrollY must be 0');
  console.log('✓ Desktop 1600x900: 1:1 scale verified');
}

// Test Case 2: iPhone 13 (Portrait: 390px wide, container 390x219.375)
{
  const presenter = { width: 1600, height: 900, zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 };
  const res = computeScaledSceneAppState(presenter, 390, 219.375);
  const expectedScale = 390 / 1600; // 0.24375
  assert(Math.abs(res.scaleFactor - expectedScale) < 1e-6, 'Scale factor on mobile portrait must match 390/1600');
  assert(Math.abs(res.zoom.value - expectedScale) < 1e-6, 'Zoom must scale down from 1.0 to 0.24375');
  assert(Math.abs(res.scrollX) < 1e-6, 'ScrollX must be aligned');
  assert(Math.abs(res.scrollY) < 1e-6, 'ScrollY must be aligned');

  // Verify that scene coordinate (1600, 900) maps within screen pixels (390, 219.375)
  const screenX = (1600 + res.scrollX) * res.zoom.value;
  const screenY = (900 + res.scrollY) * res.zoom.value;
  assert(Math.abs(screenX - 390) < 1e-4, 'Right edge (1600) must land exactly on 390px');
  assert(Math.abs(screenY - 219.375) < 1e-4, 'Bottom edge (900) must land exactly on 219.375px');
  console.log('✓ iPhone 13 Portrait (390x219.375): Full 1600x900 board fits without cropping or zooming in');
}

// Test Case 3: Mobile Landscape Fullscreen (844px wide x 390px high)
{
  const presenter = { width: 1600, height: 900, zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 };
  const res = computeScaledSceneAppState(presenter, 844, 390);
  const expectedScale = 390 / 900; // 0.43333333333333335 (height-constrained)
  assert(Math.abs(res.scaleFactor - expectedScale) < 1e-6, 'Scale factor in landscape must be constrained by height (390/900)');
  assert(res.scrollX > 0, 'Pillarbox extraSceneX must center board horizontally');
  assert.strictEqual(res.scrollY, 0, 'Vertical scroll must be zero when height fits exactly');

  // Verify horizontal centering
  const screenLeft = (0 + res.scrollX) * res.zoom.value;
  const screenRight = (1600 + res.scrollX) * res.zoom.value;
  const boardWidthOnScreen = screenRight - screenLeft;
  const leftMargin = screenLeft;
  const rightMargin = 844 - screenRight;
  assert(Math.abs(leftMargin - rightMargin) < 1e-4, 'Left and right pillarbox margins must be identical for perfect centering');
  console.log(`✓ Mobile Landscape Fullscreen (844x390): Centered horizontally with equal ${leftMargin.toFixed(1)}px margins`);
}

// Test Case 4: iPad Portrait (768px wide x 1024px high)
{
  const presenter = { width: 1600, height: 900, zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 };
  const res = computeScaledSceneAppState(presenter, 768, 1024);
  const expectedScale = 768 / 1600; // 0.48 (width-constrained)
  assert(Math.abs(res.scaleFactor - expectedScale) < 1e-6, 'Scale factor on iPad portrait must be width-constrained (768/1600)');
  assert.strictEqual(res.scrollX, 0, 'Horizontal scroll must be 0 when width matches');
  assert(res.scrollY > 0, 'Letterbox extraSceneY must center board vertically');

  // Verify vertical centering
  const screenTop = (0 + res.scrollY) * res.zoom.value;
  const screenBottom = (900 + res.scrollY) * res.zoom.value;
  const topMargin = screenTop;
  const bottomMargin = 1024 - screenBottom;
  assert(Math.abs(topMargin - bottomMargin) < 1e-4, 'Top and bottom letterbox margins must be identical for perfect centering');
  console.log(`✓ iPad Portrait (768x1024): Centered vertically with equal ${topMargin.toFixed(1)}px margins`);
}

// Test Case 5: Presenter Zoom Synchronized Scaling
{
  // Presenter zooms to 2.5x
  const presenter = { width: 1600, height: 900, zoom: { value: 2.5 }, scrollX: -200, scrollY: -100 };
  const res = computeScaledSceneAppState(presenter, 390, 219.375);
  const baseScale = 390 / 1600;
  const expectedEffectiveZoom = 2.5 * baseScale;
  assert(Math.abs(res.zoom.value - expectedEffectiveZoom) < 1e-6, 'Effective zoom on mobile must track presenter 2.5x zoom proportionally');
  assert.strictEqual(res.scrollX, -200, 'ScrollX must match presenter focal coordinate');
  assert.strictEqual(res.scrollY, -100, 'ScrollY must match presenter focal coordinate');
  console.log('✓ Presenter Zoom Synchronization: 2.5x presenter zoom scaled proportionally on mobile');
}

console.log('\nAll 5 Responsive Whiteboard Scaling Tests Passed Successfully! ✓');
