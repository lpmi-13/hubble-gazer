function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function preferredNodeCoordinate(node, axis, includeLayoutTargets) {
  const current = finiteCoordinate(node?.[axis]);
  const targetAxis = axis === 'x' ? 'layoutTargetX' : 'layoutTargetY';
  const target = finiteCoordinate(node?.[targetAxis]);

  if (includeLayoutTargets && target !== null) {
    return target;
  }
  if (current !== null) {
    return current;
  }
  return target;
}

export function hasViewportPosition(node, includeLayoutTargets = true) {
  return preferredNodeCoordinate(node, 'x', includeLayoutTargets) !== null
    && preferredNodeCoordinate(node, 'y', includeLayoutTargets) !== null;
}

export function collectViewportBounds(
  nodes,
  {
    includeLayoutTargets = true,
    nodeGroupBoxes = [],
    nodeRadius = 0,
  } = {},
) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let hasBounds = false;
  const radius = Math.max(0, Number(nodeRadius) || 0);

  for (const node of nodes || []) {
    const x = preferredNodeCoordinate(node, 'x', includeLayoutTargets);
    const y = preferredNodeCoordinate(node, 'y', includeLayoutTargets);
    if (x === null || y === null) {
      continue;
    }

    minX = Math.min(minX, x - radius);
    maxX = Math.max(maxX, x + radius);
    minY = Math.min(minY, y - radius);
    maxY = Math.max(maxY, y + radius);
    hasBounds = true;
  }

  for (const box of nodeGroupBoxes || []) {
    const boxMinX = finiteCoordinate(box?.minX);
    const boxMaxX = finiteCoordinate(box?.maxX);
    const boxMinY = finiteCoordinate(box?.minY);
    const boxMaxY = finiteCoordinate(box?.maxY);
    if (boxMinX === null || boxMaxX === null || boxMinY === null || boxMaxY === null) {
      continue;
    }

    minX = Math.min(minX, boxMinX);
    maxX = Math.max(maxX, boxMaxX);
    minY = Math.min(minY, boxMinY);
    maxY = Math.max(maxY, boxMaxY);
    hasBounds = true;
  }

  if (!hasBounds) {
    return null;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function fitViewportToBounds(bounds, dimensions, padding, { minZoom = 0, maxZoom = Number.POSITIVE_INFINITY } = {}) {
  if (!bounds) {
    return null;
  }

  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const inset = Math.max(0, Number(padding) || 0);
  const availableWidth = Math.max(1, width - (inset * 2));
  const availableHeight = Math.max(1, height - (inset * 2));
  const contentWidth = Math.max(1, Number(bounds.width) || 0);
  const contentHeight = Math.max(1, Number(bounds.height) || 0);
  let zoom = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);

  if (Number.isFinite(maxZoom)) {
    zoom = Math.min(zoom, maxZoom);
  }
  if (Number.isFinite(minZoom)) {
    zoom = Math.max(zoom, minZoom);
  }

  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    zoom,
  };
}

export function boundsExceedViewport(bounds, viewportBounds) {
  if (!bounds || !viewportBounds) {
    return false;
  }

  return bounds.minX < viewportBounds.minX
    || bounds.maxX > viewportBounds.maxX
    || bounds.minY < viewportBounds.minY
    || bounds.maxY > viewportBounds.maxY;
}

export function fitRequiresZoomOut(currentZoom, nextZoom, zoomEpsilon = 0.01) {
  const current = Number(currentZoom);
  const next = Number(nextZoom);
  const threshold = Math.max(0, Number(zoomEpsilon) || 0);

  if (!Number.isFinite(current) || !Number.isFinite(next)) {
    return false;
  }

  return next < (current - threshold);
}

export function viewportFitChanged(
  previousFit,
  nextFit,
  {
    centerEpsilon = 1,
    zoomEpsilon = 0.01,
  } = {},
) {
  if (!nextFit) {
    return false;
  }
  if (!previousFit) {
    return true;
  }

  const centerThreshold = Math.max(0, Number(centerEpsilon) || 0);
  const zoomThreshold = Math.max(0, Number(zoomEpsilon) || 0);
  const centerShift = Math.hypot(
    Number(nextFit.centerX) - Number(previousFit.centerX),
    Number(nextFit.centerY) - Number(previousFit.centerY),
  );
  const zoomShift = Math.abs(Number(nextFit.zoom) - Number(previousFit.zoom));

  return centerShift > centerThreshold || zoomShift > zoomThreshold;
}
