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

const NAMESPACE_COLORS = {
  'demo': '#58a6ff',
  'kube-system': '#bc8cff',
  'default': '#79c0ff',
};

const DEFAULT_COLOR = '#8b949e';

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
const INITIAL_VIEW_SETTLE_DELAY_MS = 280;
const INITIAL_VIEW_SETTLE_DURATION_MS = 420;
const INITIAL_VIEW_MAX_WAIT_FRAMES = 24;

function isCoarsePointer() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function getNodeRadius() {
  return NODE_RADIUS;
}

function getNodeColor(node) {
  return NAMESPACE_COLORS[node.namespace] || DEFAULT_COLOR;
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

function isPositionedNode(node) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.y);
}

function autoFitPadding(dimensions) {
  const shortestSide = Math.max(0, Math.min(dimensions.width, dimensions.height));
  const coarsePadding = shortestSide * 0.18;
  const finePadding = shortestSide * 0.12;
  return Math.round(Math.max(isCoarsePointer() ? 52 : 72, isCoarsePointer() ? coarsePadding : finePadding));
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
  groupingMode = '',
  nodeGroupBoxes = [],
  viewportResetKey = 'default',
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
  const groupBoxesByKeyRef = useRef(new Map());
  const lastAutoFitKeyRef = useRef('');
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
    if (!viewportResetKey || dimensions.width <= 0 || dimensions.height <= 0 || data.nodes.length === 0) {
      return undefined;
    }
    if (lastAutoFitKeyRef.current === viewportResetKey) {
      return undefined;
    }

    let frameCount = 0;
    let rafId = 0;
    let settleTimeout = 0;
    let cancelled = false;
    const padding = autoFitPadding(dimensions);
    const fitNodeFilter = (node) => isPositionedNode(node);

    const runAutoFit = () => {
      if (cancelled) {
        return;
      }

      const graph = graphRef.current;
      const nodes = graphNodesRef.current;
      if (!graph || nodes.length === 0) {
        rafId = window.requestAnimationFrame(runAutoFit);
        return;
      }

      const positionedNodeCount = nodes.filter(isPositionedNode).length;
      if (positionedNodeCount === 0) {
        rafId = window.requestAnimationFrame(runAutoFit);
        return;
      }

      if (positionedNodeCount < nodes.length && frameCount < INITIAL_VIEW_MAX_WAIT_FRAMES) {
        frameCount += 1;
        rafId = window.requestAnimationFrame(runAutoFit);
        return;
      }

      lastAutoFitKeyRef.current = viewportResetKey;
      graph.zoomToFit(INITIAL_VIEW_FIT_DURATION_MS, padding, fitNodeFilter);
      settleTimeout = window.setTimeout(() => {
        if (cancelled || lastAutoFitKeyRef.current !== viewportResetKey) {
          return;
        }
        graph.zoomToFit(INITIAL_VIEW_SETTLE_DURATION_MS, padding, fitNodeFilter);
      }, INITIAL_VIEW_SETTLE_DELAY_MS);
    };

    rafId = window.requestAnimationFrame(runAutoFit);
    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (settleTimeout) {
        window.clearTimeout(settleTimeout);
      }
    };
  }, [data.nodes.length, dimensions.height, dimensions.width, viewportResetKey]);

  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    const label = node.label || node.id;
    const fontSize = Math.max(12 / globalScale, 3);
    const nodeSize = getNodeRadius(node);
    const color = getNodeColor(node);

    // Draw node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Draw glow
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize + 2, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Draw label
    ctx.font = `${fontSize}px "IBM Plex Sans", "Space Grotesk", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#dbf2ff';
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
