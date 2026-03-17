import React, { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  edgeWidth,
  errorRatio,
  particleColor,
  particleRadius,
  particleSpeed,
  protocolColor,
  protocolDistribution,
  protocolLegend,
  trafficParticleCount,
} from './graphEncoding';
import {
  boundsExceedViewport,
  collectViewportBounds,
  fitRequiresZoomOut,
  fitViewportToBounds,
  hasViewportPosition,
  viewportFitChanged,
} from './graphViewport';
import { namespaceColor } from './namespaceColors';
const TERMINATED_STROKE = '#ff7b72';
const TERMINATED_FILL = 'rgba(255, 123, 114, 0.16)';
const TERMINATED_GLOW = 'rgba(255, 123, 114, 0.24)';
const UNRESOLVED_STROKE = '#ffd166';
const UNRESOLVED_FILL = 'rgba(255, 209, 102, 0.16)';
const UNRESOLVED_GLOW = 'rgba(255, 209, 102, 0.22)';
const EXTERNAL_STROKE = '#79c0ff';
const EXTERNAL_FILL = 'rgba(121, 192, 255, 0.16)';
const EXTERNAL_GLOW = 'rgba(121, 192, 255, 0.22)';

const NODE_RADIUS = 10;
const MIN_POINTER_RADIUS = 24;
const MIN_POINTER_RADIUS_COARSE = 38;
const EDGE_CURVATURE = 0.1;
const EDGE_PARTICLE_PADDING = 0.06;
const LAYOUT_EASING = 0.32;
const LAYOUT_MAX_STEP = 20;
const LAYOUT_MIN_STEP = 0.35;
const LAYOUT_SNAP_EPSILON = 0.25;
const NODE_GROUP_MODE = 'k8sNode';
const NODE_GROUP_STROKE = 'rgba(110, 194, 242, 0.36)';
const NODE_GROUP_FILL = 'rgba(28, 77, 110, 0.14)';
const NODE_GROUP_LABEL_BG = 'rgba(22, 62, 90, 0.74)';
const NODE_GROUP_LABEL_TEXT = '#cdeeff';
const TOUCH_LABEL_WIDTH_PER_CHAR = 7.2;
const TOUCH_LABEL_MIN_WIDTH = 44;
const TOUCH_LABEL_MAX_WIDTH = 168;
const TOUCH_LABEL_HEIGHT = 18;
const TOUCH_LABEL_PADDING_X = 10;
const TOUCH_LABEL_GAP = 6;
const INITIAL_VIEW_FIT_DURATION_MS = 720;
const INITIAL_VIEW_SETTLE_DURATION_MS = 420;
const INITIAL_VIEW_MAX_WAIT_FRAMES = 24;
const INITIAL_VIEW_WAIT_FOR_DATA_MS = 5000;
const INITIAL_VIEW_FOLLOW_UP_MS = 1400;
const INITIAL_VIEW_CENTER_EPSILON = 6;
const INITIAL_VIEW_ZOOM_EPSILON = 0.035;
const CONDITIONAL_VIEWPORT_FIT_DURATION_MS = 260;

function isCoarsePointer() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function getNodeRadius() {
  return NODE_RADIUS;
}

function getNodeColor(node) {
  return namespaceColor(node?.namespace);
}

function nodeKind(node) {
  const value = typeof node?.kind === 'string' ? node.kind : '';
  return value.length > 0 ? value : 'pod';
}

function nodeLifecycle(node) {
  const value = typeof node?.lifecycle === 'string' ? node.lifecycle : '';
  if (value === 'terminated' || value === 'unresolved') {
    return value;
  }
  return 'live';
}

function colorWithAlpha(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) {
    return hex;
  }

  const full = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function diamondPath(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius, y);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - radius, y);
  ctx.closePath();
}

function nodeLabel(node) {
  return node?.label || node?.id || '';
}

function nodeGroupKey(node) {
  const value = typeof node?.k8sNode === 'string' ? node.k8sNode.trim() : '';
  return value.length > 0 ? value : 'unknown';
}

function clampToGroupBox(node, x, y, boxesByKey) {
  const box = boxesByKey.get(nodeGroupKey(node));
  if (!box || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { x, y };
  }
  return {
    x: Math.min(box.innerMaxX, Math.max(box.innerMinX, x)),
    y: Math.min(box.innerMaxY, Math.max(box.innerMinY, y)),
  };
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function getLinkEndpoints(link) {
  const source = link?.source;
  const target = link?.target;
  if (!source || !target) {
    return null;
  }
  const sourceX = Number(source.x);
  const sourceY = Number(source.y);
  const targetX = Number(target.x);
  const targetY = Number(target.y);

  if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY) || !Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return null;
  }

  return {
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
  };
}

function toCanvasPoint(clientX, clientY, rect) {
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function pointInBox(x, y, box) {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function touchLabelBox(node, pagePoint, zoom) {
  const label = nodeLabel(node);
  const width = Math.max(
    TOUCH_LABEL_MIN_WIDTH,
    Math.min(TOUCH_LABEL_MAX_WIDTH, label.length * TOUCH_LABEL_WIDTH_PER_CHAR),
  );
  const nodeRadiusPx = getNodeRadius(node) * zoom;
  const top = pagePoint.y + Math.max(TOUCH_LABEL_GAP, nodeRadiusPx + 4);
  return {
    left: pagePoint.x - (width / 2) - TOUCH_LABEL_PADDING_X,
    right: pagePoint.x + (width / 2) + TOUCH_LABEL_PADDING_X,
    top,
    bottom: top + TOUCH_LABEL_HEIGHT,
  };
}

function autoFitPadding(dimensions) {
  const shortestSide = Math.max(0, Math.min(dimensions.width, dimensions.height));
  const coarsePadding = shortestSide * 0.18;
  const finePadding = shortestSide * 0.12;
  return Math.round(Math.max(isCoarsePointer() ? 52 : 72, isCoarsePointer() ? coarsePadding : finePadding));
}

function scheduleViewportFitRequest({
  requestKey,
  viewportFitReady,
  dimensions,
  graphRef,
  graphNodesRef,
  groupingModeRef,
  nodeGroupBoxesRef,
  lastAppliedKeyRef,
  animated = false,
  fitMode = 'always',
}) {
  if (!requestKey || !viewportFitReady || dimensions.width <= 0 || dimensions.height <= 0) {
    return undefined;
  }
  if (lastAppliedKeyRef.current === requestKey) {
    return undefined;
  }

  let frameCount = 0;
  let rafId = 0;
  let cancelled = false;
  let startedAtMs = null;
  let firstFitAtMs = null;
  let lastAppliedFit = null;
  const padding = autoFitPadding(dimensions);

  const nextViewportFit = () => {
    const graph = graphRef.current;
    const nodes = graphNodesRef.current;
    if (!graph || nodes.length === 0) {
      return null;
    }

    const bounds = collectViewportBounds(nodes, {
      includeLayoutTargets: true,
      nodeGroupBoxes: groupingModeRef.current === NODE_GROUP_MODE ? nodeGroupBoxesRef.current : [],
      nodeRadius: NODE_RADIUS,
    });

    const fit = fitViewportToBounds(bounds, dimensions, padding, {
      minZoom: typeof graph.minZoom === 'function' ? graph.minZoom() : 0,
      maxZoom: typeof graph.maxZoom === 'function' ? graph.maxZoom() : Number.POSITIVE_INFINITY,
    });
    return { bounds, fit };
  };

  const currentViewportBounds = () => {
    const graph = graphRef.current;
    if (!graph || typeof graph.screen2GraphCoords !== 'function') {
      return null;
    }

    const left = Math.max(0, Math.min(dimensions.width, padding));
    const top = Math.max(0, Math.min(dimensions.height, padding));
    const right = Math.max(left + 1, dimensions.width - padding);
    const bottom = Math.max(top + 1, dimensions.height - padding);

    const topLeft = graph.screen2GraphCoords(left, top);
    const bottomRight = graph.screen2GraphCoords(right, bottom);
    if (!Number.isFinite(topLeft?.x) || !Number.isFinite(topLeft?.y) || !Number.isFinite(bottomRight?.x) || !Number.isFinite(bottomRight?.y)) {
      return null;
    }

    return {
      minX: Math.min(topLeft.x, bottomRight.x),
      maxX: Math.max(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y),
      maxY: Math.max(topLeft.y, bottomRight.y),
    };
  };

  const runViewportFit = (nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()) => {
    if (cancelled) {
      return;
    }
    if (startedAtMs === null) {
      startedAtMs = nowMs;
    }

    const graph = graphRef.current;
    const nodes = graphNodesRef.current;
    if (!graph || nodes.length === 0) {
      if (nowMs - startedAtMs < INITIAL_VIEW_WAIT_FOR_DATA_MS) {
        rafId = window.requestAnimationFrame(runViewportFit);
      }
      return;
    }

    const viewportNodeCount = nodes.filter((node) => hasViewportPosition(node, true)).length;
    if (viewportNodeCount === 0) {
      if (nowMs - startedAtMs < INITIAL_VIEW_WAIT_FOR_DATA_MS) {
        rafId = window.requestAnimationFrame(runViewportFit);
      }
      return;
    }

    if (viewportNodeCount < nodes.length && frameCount < INITIAL_VIEW_MAX_WAIT_FRAMES) {
      frameCount += 1;
      rafId = window.requestAnimationFrame(runViewportFit);
      return;
    }

    const nextFit = nextViewportFit();
    if (!nextFit?.fit || !nextFit?.bounds) {
      if (nowMs - startedAtMs < INITIAL_VIEW_WAIT_FOR_DATA_MS) {
        rafId = window.requestAnimationFrame(runViewportFit);
      }
      return;
    }

    const { bounds, fit } = nextFit;

    if (!animated && fitMode === 'if-needed') {
      const viewportBounds = currentViewportBounds();
      if (viewportBounds && !boundsExceedViewport(bounds, viewportBounds)) {
        lastAppliedKeyRef.current = requestKey;
        return;
      }

      const currentZoom = typeof graph.zoom === 'function' ? graph.zoom() : Number.NaN;
      const durationMs = fitRequiresZoomOut(currentZoom, fit.zoom, INITIAL_VIEW_ZOOM_EPSILON)
        ? CONDITIONAL_VIEWPORT_FIT_DURATION_MS
        : 0;
      graph.centerAt(fit.centerX, fit.centerY, durationMs);
      graph.zoom(fit.zoom, durationMs);
      lastAppliedKeyRef.current = requestKey;
      return;
    }

    if (!animated) {
      graph.centerAt(fit.centerX, fit.centerY, 0);
      graph.zoom(fit.zoom, 0);
      lastAppliedKeyRef.current = requestKey;
      return;
    }

    if (viewportFitChanged(lastAppliedFit, fit, {
      centerEpsilon: INITIAL_VIEW_CENTER_EPSILON,
      zoomEpsilon: INITIAL_VIEW_ZOOM_EPSILON,
    })) {
      const durationMs = firstFitAtMs === null
        ? INITIAL_VIEW_FIT_DURATION_MS
        : INITIAL_VIEW_SETTLE_DURATION_MS;
      graph.centerAt(fit.centerX, fit.centerY, durationMs);
      graph.zoom(fit.zoom, durationMs);
      lastAppliedFit = fit;
      if (firstFitAtMs === null) {
        firstFitAtMs = nowMs;
        lastAppliedKeyRef.current = requestKey;
      }
    }

    const deadlineMs = firstFitAtMs === null
      ? startedAtMs + INITIAL_VIEW_WAIT_FOR_DATA_MS
      : firstFitAtMs + INITIAL_VIEW_FOLLOW_UP_MS;
    if (nowMs < deadlineMs) {
      rafId = window.requestAnimationFrame(runViewportFit);
    }
  };

  rafId = window.requestAnimationFrame(runViewportFit);
  return () => {
    cancelled = true;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
  };
}

function controlPointForCurve(source, target, curvature) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const midpointX = (source.x + target.x) / 2;
  const midpointY = (source.y + target.y) / 2;
  const offset = distance * curvature;

  return {
    x: midpointX + normalX * offset,
    y: midpointY + normalY * offset,
  };
}

function pointOnQuadraticCurve(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
    y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
  };
}

function drawCurveSegment(ctx, start, control, end, t0, t1) {
  const delta = Math.max(0, t1 - t0);
  const steps = Math.max(6, Math.ceil(delta * 36));

  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = t0 + (delta * (i / steps));
    const point = pointOnQuadraticCurve(start, control, end, t);
    if (i === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.stroke();
}

function drawParticlesOnCurve(ctx, start, control, end, link, nowMs, trafficLayer) {
  const count = trafficParticleCount(link);
  if (count <= 0) {
    return;
  }

  const speed = particleSpeed(link);
  const offset = ((nowMs / 1000) * speed) % 1;
  const radius = particleRadius(link);
  const color = particleColor(link, trafficLayer);
  const span = 1 - (EDGE_PARTICLE_PADDING * 2);

  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const t = EDGE_PARTICLE_PADDING + (((offset + (i / count)) % 1) * span);
    const point = pointOnQuadraticCurve(start, control, end, t);

    ctx.globalAlpha = 0.26;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * 1.95, 0, 2 * Math.PI);
    ctx.fill();

    ctx.globalAlpha = 0.98;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export default function NetworkGraph({
  data,
  trafficLayer = 'l4',
  refreshing = false,
  groupingMode = '',
  nodeGroupBoxes = [],
  viewportResetKey = 'default',
  viewportFitKey = '',
  viewportFitIfNeededKey = '',
  viewportFitReady = true,
  layoutMotionEnabled = false,
  onLinkClick,
  onNodeDrag,
  onNodePositionChange,
}) {
  const graphRef = useRef();
  const containerRef = useRef();
  const graphNodesRef = useRef([]);
  const draggingNodeIdRef = useRef(null);
  const touchDragRef = useRef(null);
  const groupingModeRef = useRef(groupingMode);
  const nodeGroupBoxesRef = useRef(nodeGroupBoxes);
  const groupBoxesByKeyRef = useRef(new Map());
  const lastAutoFitKeyRef = useRef('');
  const lastViewportFitKeyRef = useRef('');
  const lastViewportFitIfNeededKeyRef = useRef('');
  const layoutMotionEnabledRef = useRef(layoutMotionEnabled);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);

  useEffect(() => {
    if (data.nodes.length > 0 && !hasReceivedData) {
      setHasReceivedData(true);
    }
  }, [data.nodes.length, hasReceivedData]);

  useEffect(() => {
    graphNodesRef.current = Array.isArray(data.nodes) ? data.nodes : [];
  }, [data.nodes]);

  useEffect(() => {
    groupingModeRef.current = groupingMode;
  }, [groupingMode]);

  useEffect(() => {
    nodeGroupBoxesRef.current = Array.isArray(nodeGroupBoxes) ? nodeGroupBoxes : [];
    const byKey = new Map();
    for (const box of nodeGroupBoxes || []) {
      if (!box || typeof box.key !== 'string') {
        continue;
      }
      byKey.set(box.key, box);
    }
    groupBoxesByKeyRef.current = byKey;
  }, [nodeGroupBoxes]);

  useEffect(() => {
    layoutMotionEnabledRef.current = layoutMotionEnabled;
  }, [layoutMotionEnabled]);

  useEffect(() => {
    let rafId = 0;

    const tick = () => {
      const nodes = graphNodesRef.current;
      const draggedId = draggingNodeIdRef.current;
      const isNodeGrouped = groupingModeRef.current === NODE_GROUP_MODE;
      const groupBoxesByKey = groupBoxesByKeyRef.current;
      let moved = false;

      for (const node of nodes) {
        if (!node || node.id === draggedId) {
          continue;
        }

        let targetX = Number(node.layoutTargetX);
        let targetY = Number(node.layoutTargetY);
        if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
          continue;
        }
        if (isNodeGrouped) {
          const clampedTarget = clampToGroupBox(node, targetX, targetY, groupBoxesByKey);
          targetX = clampedTarget.x;
          targetY = clampedTarget.y;
        }

        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
          const clamped = isNodeGrouped
            ? clampToGroupBox(node, targetX, targetY, groupBoxesByKey)
            : { x: targetX, y: targetY };
          node.x = clamped.x;
          node.y = clamped.y;
          node.fx = clamped.x;
          node.fy = clamped.y;
          node.vx = 0;
          node.vy = 0;
          moved = true;
          continue;
        }

        const dx = targetX - node.x;
        const dy = targetY - node.y;
        const distance = Math.hypot(dx, dy);
        if (distance <= LAYOUT_SNAP_EPSILON) {
          if (distance > 0) {
            const clamped = isNodeGrouped
              ? clampToGroupBox(node, targetX, targetY, groupBoxesByKey)
              : { x: targetX, y: targetY };
            node.x = clamped.x;
            node.y = clamped.y;
            node.fx = clamped.x;
            node.fy = clamped.y;
            node.vx = 0;
            node.vy = 0;
            moved = true;
          }
          continue;
        }

        if (!layoutMotionEnabledRef.current) {
          const clamped = isNodeGrouped
            ? clampToGroupBox(node, targetX, targetY, groupBoxesByKey)
            : { x: targetX, y: targetY };
          node.x = clamped.x;
          node.y = clamped.y;
          node.fx = clamped.x;
          node.fy = clamped.y;
          node.vx = 0;
          node.vy = 0;
          moved = true;
          continue;
        }

        const step = Math.min(LAYOUT_MAX_STEP, Math.max(LAYOUT_MIN_STEP, distance * LAYOUT_EASING));
        const ratio = step / distance;
        const nextX = node.x + (dx * ratio);
        const nextY = node.y + (dy * ratio);
        node.x = nextX;
        node.y = nextY;
        node.fx = node.x;
        node.fy = node.y;
        node.vx = 0;
        node.vy = 0;
        moved = true;
      }

      if (moved) {
        graphRef.current?.refresh?.();
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      setDimensions((prev) => {
        if (prev.width === width && prev.height === height) {
          return prev;
        }
        return { width, height };
      });
    };

    if (typeof ResizeObserver === 'undefined') {
      updateSize();
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }

    const observer = new ResizeObserver((entries) => {
      const next = entries[0];
      if (!next) {
        return;
      }
      const width = Math.floor(next.contentRect.width);
      const height = Math.floor(next.contentRect.height);
      setDimensions((prev) => {
        if (prev.width === width && prev.height === height) {
          return prev;
        }
        return { width, height };
      });
    });

    observer.observe(container);
    updateSize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return scheduleViewportFitRequest({
      requestKey: viewportResetKey,
      viewportFitReady,
      dimensions,
      graphRef,
      graphNodesRef,
      groupingModeRef,
      nodeGroupBoxesRef,
      lastAppliedKeyRef: lastAutoFitKeyRef,
      animated: true,
    });
  }, [dimensions.height, dimensions.width, viewportFitReady, viewportResetKey]);

  useEffect(() => {
    return scheduleViewportFitRequest({
      requestKey: viewportFitKey,
      viewportFitReady,
      dimensions,
      graphRef,
      graphNodesRef,
      groupingModeRef,
      nodeGroupBoxesRef,
      lastAppliedKeyRef: lastViewportFitKeyRef,
      animated: false,
    });
  }, [dimensions.height, dimensions.width, viewportFitKey, viewportFitReady]);

  useEffect(() => {
    return scheduleViewportFitRequest({
      requestKey: viewportFitIfNeededKey,
      viewportFitReady,
      dimensions,
      graphRef,
      graphNodesRef,
      groupingModeRef,
      nodeGroupBoxesRef,
      lastAppliedKeyRef: lastViewportFitIfNeededKeyRef,
      animated: false,
      fitMode: 'if-needed',
    });
  }, [dimensions.height, dimensions.width, viewportFitIfNeededKey, viewportFitReady]);

  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    const label = node.label || node.id;
    const fontSize = Math.max(12 / globalScale, 3);
    const nodeSize = getNodeRadius(node);
    const color = getNodeColor(node);
    const kind = nodeKind(node);
    const lifecycle = nodeLifecycle(node);
    const isTerminated = lifecycle === 'terminated';
    const isUnresolved = kind === 'unresolved';
    const isExternal = kind === 'external';

    if (isUnresolved) {
      diamondPath(ctx, node.x, node.y, nodeSize + 1);
      ctx.fillStyle = UNRESOLVED_FILL;
      ctx.fill();
      ctx.strokeStyle = UNRESOLVED_STROKE;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      diamondPath(ctx, node.x, node.y, nodeSize + 4);
      ctx.strokeStyle = UNRESOLVED_GLOW;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (isExternal) {
      roundedRectPath(ctx, node.x - nodeSize, node.y - nodeSize, nodeSize * 2, nodeSize * 2, 4);
      ctx.fillStyle = EXTERNAL_FILL;
      ctx.fill();
      ctx.strokeStyle = EXTERNAL_STROKE;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      roundedRectPath(ctx, node.x - (nodeSize + 3), node.y - (nodeSize + 3), (nodeSize + 3) * 2, (nodeSize + 3) * 2, 6);
      ctx.strokeStyle = EXTERNAL_GLOW;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeSize, 0, 2 * Math.PI);
      ctx.fillStyle = isTerminated ? colorWithAlpha(color, 0.24) : color;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeSize + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = isTerminated ? TERMINATED_GLOW : colorWithAlpha(color, 0.3);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeSize, 0, 2 * Math.PI);
      ctx.strokeStyle = isTerminated ? TERMINATED_STROKE : color;
      ctx.lineWidth = isTerminated ? 1.8 : 1.2;
      if (isTerminated) {
        ctx.setLineDash([4 / Math.max(globalScale, 0.001), 3 / Math.max(globalScale, 0.001)]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw label
    ctx.font = `${fontSize}px "IBM Plex Sans", "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isTerminated
      ? '#ffd6d1'
      : isUnresolved
        ? '#ffe8b5'
        : isExternal
          ? '#d5ebff'
          : '#dbf2ff';
    ctx.fillText(label, node.x, node.y + nodeSize + 3);
  }, []);

  const nodePointerAreaPaint = useCallback((node, color, ctx) => {
    const nodeSize = getNodeRadius(node);
    const minRadiusPx = isCoarsePointer() ? MIN_POINTER_RADIUS_COARSE : MIN_POINTER_RADIUS;
    const zoom = graphRef.current?.zoom?.() || 1;
    const pointerRadius = Math.max(nodeSize + 5, minRadiusPx / Math.max(zoom, 0.001));
    ctx.beginPath();
    ctx.arc(node.x, node.y, pointerRadius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const handleNodeDrag = useCallback((node) => {
    if (!node) {
      return;
    }
    setIsDragging(true);
    draggingNodeIdRef.current = node.id;
    if (groupingModeRef.current === NODE_GROUP_MODE) {
      const clamped = clampToGroupBox(node, node.x, node.y, groupBoxesByKeyRef.current);
      node.x = clamped.x;
      node.y = clamped.y;
    }
    node.layoutTargetX = node.x;
    node.layoutTargetY = node.y;
    node.fx = node.x;
    node.fy = node.y;
    if (onNodeDrag) {
      onNodeDrag(node.id, node.x, node.y);
    }
  }, [onNodeDrag]);

  const handleNodeDragEnd = useCallback((node) => {
    setIsDragging(false);
    if (!node) {
      draggingNodeIdRef.current = null;
      return;
    }
    draggingNodeIdRef.current = null;
    if (groupingModeRef.current === NODE_GROUP_MODE) {
      const clamped = clampToGroupBox(node, node.x, node.y, groupBoxesByKeyRef.current);
      node.x = clamped.x;
      node.y = clamped.y;
    }
    node.fx = node.x;
    node.fy = node.y;
    node.layoutTargetX = node.x;
    node.layoutTargetY = node.y;
    if (onNodePositionChange) {
      onNodePositionChange(node.id, node.x, node.y);
    }
  }, [onNodePositionChange]);

  const findTouchNode = useCallback((clientX, clientY) => {
    const graph = graphRef.current;
    const container = containerRef.current;
    if (!graph || !container) {
      return null;
    }

    const rect = container.getBoundingClientRect();
    const zoom = Math.max(graph.zoom?.() || 1, 0.001);
    let bestMatch = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const node of graphNodesRef.current) {
      if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        continue;
      }

      const canvasPoint = graph.graph2ScreenCoords(node.x, node.y);
      const pagePoint = {
        x: rect.left + canvasPoint.x,
        y: rect.top + canvasPoint.y,
      };
      const distance = Math.hypot(clientX - pagePoint.x, clientY - pagePoint.y);
      const nodeRadiusPx = Math.max(MIN_POINTER_RADIUS_COARSE, (getNodeRadius(node) + 5) * zoom);

      if (distance <= nodeRadiusPx && distance < bestScore) {
        bestMatch = node;
        bestScore = distance;
        continue;
      }

      if (!pointInBox(clientX, clientY, touchLabelBox(node, pagePoint, zoom))) {
        continue;
      }

      const labelScore = distance * 0.5;
      if (labelScore < bestScore) {
        bestMatch = node;
        bestScore = labelScore;
      }
    }

    return bestMatch;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const handleTouchStart = (event) => {
      if (event.touches.length !== 1 || touchDragRef.current) {
        return;
      }

      const touch = event.touches[0];
      const node = findTouchNode(touch.clientX, touch.clientY);
      if (!node) {
        return;
      }

      const graph = graphRef.current;
      const rect = container.getBoundingClientRect();
      if (!graph) {
        return;
      }

      const touchPoint = toCanvasPoint(touch.clientX, touch.clientY, rect);
      const graphPoint = graph.screen2GraphCoords(touchPoint.x, touchPoint.y);
      if (!Number.isFinite(graphPoint?.x) || !Number.isFinite(graphPoint?.y)) {
        return;
      }

      touchDragRef.current = {
        identifier: touch.identifier,
        node,
        offsetX: node.x - graphPoint.x,
        offsetY: node.y - graphPoint.y,
      };

      handleNodeDrag(node);
      event.preventDefault();
      event.stopPropagation();
    };

    const handleTouchMove = (event) => {
      const dragState = touchDragRef.current;
      if (!dragState) {
        return;
      }

      const touch = Array.from(event.touches).find((item) => item.identifier === dragState.identifier);
      if (!touch) {
        return;
      }

      const graph = graphRef.current;
      if (!graph) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const touchPoint = toCanvasPoint(touch.clientX, touch.clientY, rect);
      const graphPoint = graph.screen2GraphCoords(touchPoint.x, touchPoint.y);
      if (!Number.isFinite(graphPoint?.x) || !Number.isFinite(graphPoint?.y)) {
        return;
      }

      let nextX = graphPoint.x + dragState.offsetX;
      let nextY = graphPoint.y + dragState.offsetY;
      if (groupingModeRef.current === NODE_GROUP_MODE) {
        const clamped = clampToGroupBox(dragState.node, nextX, nextY, groupBoxesByKeyRef.current);
        nextX = clamped.x;
        nextY = clamped.y;
      }

      const node = dragState.node;
      node.x = nextX;
      node.y = nextY;
      node.fx = nextX;
      node.fy = nextY;
      node.vx = 0;
      node.vy = 0;
      node.layoutTargetX = nextX;
      node.layoutTargetY = nextY;

      if (onNodeDrag) {
        onNodeDrag(node.id, nextX, nextY);
      }
      graph.refresh?.();
      event.preventDefault();
      event.stopPropagation();
    };

    const finishTouchDrag = (event) => {
      const dragState = touchDragRef.current;
      if (!dragState) {
        return;
      }

      const changedTouches = Array.from(event.changedTouches || []);
      const isMatchingTouch = event.type === 'touchcancel'
        || changedTouches.some((touch) => touch.identifier === dragState.identifier);
      if (!isMatchingTouch) {
        return;
      }

      touchDragRef.current = null;
      handleNodeDragEnd(dragState.node);
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    window.addEventListener('touchend', finishTouchDrag, { passive: false, capture: true });
    window.addEventListener('touchcancel', finishTouchDrag, { passive: false, capture: true });

    return () => {
      touchDragRef.current = null;
      container.removeEventListener('touchstart', handleTouchStart, true);
      window.removeEventListener('touchmove', handleTouchMove, true);
      window.removeEventListener('touchend', finishTouchDrag, true);
      window.removeEventListener('touchcancel', finishTouchDrag, true);
    };
  }, [findTouchNode, handleNodeDrag, handleNodeDragEnd, onNodeDrag]);

  const renderFramePre = useCallback((ctx, globalScale) => {
    if (groupingMode !== NODE_GROUP_MODE || !Array.isArray(nodeGroupBoxes) || nodeGroupBoxes.length === 0) {
      return;
    }

    const strokeWidth = 1.3 / Math.max(globalScale, 0.001);
    const labelFontSize = Math.max(9 / Math.max(globalScale, 0.001), 5);

    ctx.save();
    ctx.lineWidth = strokeWidth;
    ctx.setLineDash([10 / Math.max(globalScale, 0.001), 7 / Math.max(globalScale, 0.001)]);

    for (const box of nodeGroupBoxes) {
      if (!box) {
        continue;
      }
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      const radius = 14 / Math.max(globalScale, 0.001);

      roundedRectPath(ctx, box.minX, box.minY, width, height, radius);
      ctx.fillStyle = NODE_GROUP_FILL;
      ctx.fill();
      ctx.strokeStyle = NODE_GROUP_STROKE;
      ctx.stroke();

      const label = typeof box.label === 'string' ? box.label : box.key;
      if (label) {
        ctx.font = `${labelFontSize}px "IBM Plex Sans", "Space Grotesk", sans-serif`;
        const textWidth = ctx.measureText(label).width;
        const labelPadX = 8 / Math.max(globalScale, 0.001);
        const labelPadY = 5 / Math.max(globalScale, 0.001);
        const labelHeight = labelFontSize + (labelPadY * 2);
        const labelWidth = textWidth + (labelPadX * 2);
        const labelX = box.minX + (10 / Math.max(globalScale, 0.001));
        const labelY = box.minY + (10 / Math.max(globalScale, 0.001));

        roundedRectPath(
          ctx,
          labelX,
          labelY,
          labelWidth,
          labelHeight,
          8 / Math.max(globalScale, 0.001),
        );
        ctx.setLineDash([]);
        ctx.fillStyle = NODE_GROUP_LABEL_BG;
        ctx.fill();
        ctx.strokeStyle = NODE_GROUP_STROKE;
        ctx.stroke();
        ctx.setLineDash([10 / Math.max(globalScale, 0.001), 7 / Math.max(globalScale, 0.001)]);

        ctx.fillStyle = NODE_GROUP_LABEL_TEXT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, labelX + labelPadX, labelY + (labelHeight / 2));
      }
    }

    ctx.setLineDash([]);
    ctx.restore();
  }, [groupingMode, nodeGroupBoxes]);

  const linkCanvasObject = useCallback((link, ctx) => {
    const endpoints = getLinkEndpoints(link);
    if (!endpoints) {
      return;
    }

    const { source, target } = endpoints;
    const width = edgeWidth(link);
    const control = controlPointForCurve(source, target, EDGE_CURVATURE);
    const distribution = protocolDistribution(link, trafficLayer);
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let startT = 0;
    const finalIndex = distribution.length - 1;
    for (let i = 0; i < distribution.length; i++) {
      const segment = distribution[i];
      const endT = i === finalIndex ? 1 : Math.min(1, startT + segment.share);
      if (endT <= startT) {
        continue;
      }

      ctx.strokeStyle = protocolColor(segment.protocol, trafficLayer);
      ctx.lineWidth = width;
      drawCurveSegment(ctx, source, control, target, startT, endT);
      startT = endT;
    }

    const dropRatio = errorRatio(link, trafficLayer);
    if (dropRatio > 0.001) {
      ctx.strokeStyle = `rgba(248, 81, 73, ${0.24 + (dropRatio * 0.5)})`;
      ctx.lineWidth = Math.max(1, width * 0.38);
      ctx.setLineDash([7, 5]);
      drawCurveSegment(ctx, source, control, target, 0, 1);
      ctx.setLineDash([]);
    }

    drawParticlesOnCurve(ctx, source, control, target, link, nowMs, trafficLayer);

    ctx.restore();
  }, [trafficLayer]);

  const showLoading = !hasReceivedData && data.nodes.length === 0;
  const showEmpty = hasReceivedData && data.nodes.length === 0;
  const showRefreshing = refreshing && !showLoading;
  const showNoL7Notice = trafficLayer === 'l7' && hasReceivedData && data.nodes.length > 0 && data.links.length === 0;
  const legendRows = trafficLayer === 'l7'
    ? [
      'More particles = more L7 events',
      'Particle motion = request direction',
      'Red dashed overlay = high HTTP 5xx ratio',
    ]
    : [
      'More particles = more traffic',
      'Particle motion = flow direction',
      'Red dashed overlay = dropped traffic',
    ];

  return (
    <div
      ref={containerRef}
      className={`network-graph ${isDragging ? 'network-graph-dragging' : ''}`}
    >
      {dimensions.width > 0 && dimensions.height > 0 && (
        <ForceGraph2D
          ref={graphRef}
          graphData={data}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor="transparent"
          nodeId="id"
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerAreaPaint}
          linkCanvasObject={linkCanvasObject}
          linkCanvasObjectMode={() => 'replace'}
          onRenderFramePre={renderFramePre}
          linkWidth={edgeWidth}
          linkCurvature={EDGE_CURVATURE}
          autoPauseRedraw={false}
          enableNodeDrag
          onLinkClick={onLinkClick}
          onNodeDrag={handleNodeDrag}
          onNodeDragEnd={handleNodeDragEnd}
          onBackgroundClick={() => setIsDragging(false)}
          d3AlphaDecay={1}
          d3VelocityDecay={1}
          cooldownTicks={0}
          warmupTicks={0}
        />
      )}
      <aside className="graph-legend" aria-label="Graph legend">
        <p className="graph-legend-title">Legend</p>
        <div className="graph-legend-row">
          <span className="graph-legend-swatch graph-legend-swatch-traffic" />
          {legendRows[0]}
        </div>
        <div className="graph-legend-row">
          <span className="graph-legend-swatch graph-legend-swatch-particle" />
          {legendRows[1]}
        </div>
        <div className="graph-legend-row">
          <span className="graph-legend-swatch graph-legend-swatch-drop" />
          {legendRows[2]}
        </div>
        <div className="graph-legend-row graph-legend-row-protocols">
          <span className="graph-legend-swatch graph-legend-swatch-mixed" />
          Protocol colors:
          <div className="graph-legend-protocol-list">
            {protocolLegend(trafficLayer).map((item) => (
              <span className="graph-legend-protocol-item" key={item.protocol}>
                <span className="graph-legend-protocol-dot" style={{ backgroundColor: item.color }} />
                {item.label || item.protocol}
              </span>
            ))}
          </div>
        </div>
      </aside>
      {showNoL7Notice && (
        <div className="graph-inline-notice" role="status" aria-live="polite">
          <div className="graph-inline-notice-title">No L7 traffic detected for current filters.</div>
          <div className="graph-inline-notice-text">L7 visibility must be enabled in Cilium/Hubble for application traffic to appear.</div>
        </div>
      )}
      <div
        className={`graph-refresh-indicator ${showRefreshing ? 'visible' : ''}`}
        role={showRefreshing ? 'status' : undefined}
        aria-live={showRefreshing ? 'polite' : undefined}
        aria-hidden={!showRefreshing}
      >
        <span className="graph-refresh-spinner" aria-hidden="true" />
        <span>Updating graph...</span>
      </div>
      {showLoading && (
        <div className="graph-overlay" aria-live="polite">
          <div className="graph-loading">
            <div className="graph-loading-spinner" />
            <div className="graph-loading-text">Waiting for network flows...</div>
          </div>
        </div>
      )}
      {showEmpty && (
        <div className="graph-overlay" aria-live="polite">
          <div className="graph-empty">
            <div className="graph-empty-icon" aria-hidden="true">&#8728;</div>
            <div className="graph-empty-text">{trafficLayer === 'l7' ? 'No L7 traffic detected for current filters.' : 'No network flows detected'}</div>
            <div className="graph-empty-hint">
              {trafficLayer === 'l7'
                ? 'L7 visibility must be enabled in Cilium/Hubble for application traffic to appear.'
                : 'Flows will appear when traffic is observed'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
