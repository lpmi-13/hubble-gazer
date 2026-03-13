import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsExceedViewport,
  collectViewportBounds,
  fitRequiresZoomOut,
  fitViewportToBounds,
  hasViewportPosition,
  viewportFitChanged,
} from '../src/components/graphViewport.js';

test('hasViewportPosition accepts layout targets before nodes finish animating', () => {
  assert.equal(
    hasViewportPosition({ layoutTargetX: -120, layoutTargetY: 64 }),
    true,
  );
  assert.equal(hasViewportPosition({ x: 14 }), false);
});

test('collectViewportBounds prefers layout targets over stale current positions', () => {
  const bounds = collectViewportBounds(
    [
      { id: 'a', x: 0, y: 0, layoutTargetX: -320, layoutTargetY: -180 },
      { id: 'b', x: 20, y: 12, layoutTargetX: 380, layoutTargetY: 220 },
    ],
    { includeLayoutTargets: true, nodeRadius: 10 },
  );

  assert.deepEqual(bounds, {
    minX: -330,
    maxX: 390,
    minY: -190,
    maxY: 230,
    width: 720,
    height: 420,
  });
});

test('collectViewportBounds includes node group boxes in grouped mode', () => {
  const bounds = collectViewportBounds(
    [{ id: 'pod-a', layoutTargetX: 0, layoutTargetY: 0 }],
    {
      includeLayoutTargets: true,
      nodeRadius: 10,
      nodeGroupBoxes: [
        { minX: -540, maxX: -180, minY: -240, maxY: 120 },
        { minX: 180, maxX: 540, minY: -120, maxY: 240 },
      ],
    },
  );

  assert.equal(bounds.minX, -540);
  assert.equal(bounds.maxX, 540);
  assert.equal(bounds.minY, -240);
  assert.equal(bounds.maxY, 240);
});

test('fitViewportToBounds zooms out for grouped target bounds instead of stale clustered positions', () => {
  const clusteredBounds = collectViewportBounds(
    [
      { id: 'a', x: -20, y: -12 },
      { id: 'b', x: 24, y: 16 },
    ],
    { includeLayoutTargets: false, nodeRadius: 10 },
  );
  const groupedBounds = collectViewportBounds(
    [
      { id: 'a', x: -20, y: -12, layoutTargetX: -420, layoutTargetY: -240 },
      { id: 'b', x: 24, y: 16, layoutTargetX: 420, layoutTargetY: 240 },
    ],
    {
      includeLayoutTargets: true,
      nodeRadius: 10,
      nodeGroupBoxes: [
        { minX: -560, maxX: -200, minY: -360, maxY: 0 },
        { minX: 200, maxX: 560, minY: 0, maxY: 360 },
      ],
    },
  );

  const clusteredFit = fitViewportToBounds(clusteredBounds, { width: 1200, height: 800 }, 80, {
    minZoom: 0.1,
    maxZoom: 8,
  });
  const groupedFit = fitViewportToBounds(groupedBounds, { width: 1200, height: 800 }, 80, {
    minZoom: 0.1,
    maxZoom: 8,
  });

  assert.ok(groupedFit.zoom < clusteredFit.zoom);
  assert.equal(groupedFit.centerX, 0);
  assert.equal(groupedFit.centerY, 0);
});

test('boundsExceedViewport detects when graph content falls outside the current viewport', () => {
  assert.equal(
    boundsExceedViewport(
      { minX: -80, maxX: 80, minY: -60, maxY: 60 },
      { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    ),
    false,
  );

  assert.equal(
    boundsExceedViewport(
      { minX: -140, maxX: 80, minY: -60, maxY: 60 },
      { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    ),
    true,
  );
});

test('fitRequiresZoomOut only flags genuine zoom-out changes', () => {
  assert.equal(fitRequiresZoomOut(1.2, 0.9, 0.01), true);
  assert.equal(fitRequiresZoomOut(1.2, 1.19, 0.02), false);
  assert.equal(fitRequiresZoomOut(1.2, 1.24, 0.01), false);
});

test('viewportFitChanged ignores tiny fit drift but catches real recentering changes', () => {
  assert.equal(
    viewportFitChanged(
      { centerX: 100, centerY: 200, zoom: 1.25 },
      { centerX: 103, centerY: 203, zoom: 1.27 },
      { centerEpsilon: 6, zoomEpsilon: 0.05 },
    ),
    false,
  );

  assert.equal(
    viewportFitChanged(
      { centerX: 100, centerY: 200, zoom: 1.25 },
      { centerX: 120, centerY: 220, zoom: 1.25 },
      { centerEpsilon: 6, zoomEpsilon: 0.05 },
    ),
    true,
  );
});
