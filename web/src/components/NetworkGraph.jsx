import React, { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  PROTOCOL_LEGEND,
  edgeWidth,
  errorRatio,
  particleColor,
  particleRadius,
  particleSpeed,
  protocolColor,
  protocolDistribution,
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

function drawParticlesOnCurve(ctx, start, control, end, link, nowMs) {
  const count = trafficParticleCount(link);
  if (count <= 0) {
    return;
  }

  const speed = particleSpeed(link);
  const offset = ((nowMs / 1000) * speed) % 1;
  const radius = particleRadius(link);
  const color = particleColor(link);
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

export default function NetworkGraph({ data, onLinkClick, onNodeDrag, onNodePositionChange }) {
  const graphRef = useRef();
  const containerRef = useRef();
  const graphNodesRef = useRef([]);
  const draggingNodeIdRef = useRef(null);
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
    let rafId = 0;

    const tick = () => {
      const nodes = graphNodesRef.current;
      const draggedId = draggingNodeIdRef.current;
      let moved = false;

      for (const node of nodes) {
        if (!node || node.id === draggedId) {
          continue;
        }

        const targetX = Number(node.layoutTargetX);
        const targetY = Number(node.layoutTargetY);
        if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
          continue;
        }

        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
          node.x = targetX;
          node.y = targetY;
          node.fx = targetX;
          node.fy = targetY;
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
            node.x = targetX;
            node.y = targetY;
            node.fx = targetX;
            node.fy = targetY;
            node.vx = 0;
            node.vy = 0;
            moved = true;
          }
          continue;
        }

        const step = Math.min(LAYOUT_MAX_STEP, Math.max(LAYOUT_MIN_STEP, distance * LAYOUT_EASING));
        const ratio = step / distance;
        node.x += dx * ratio;
        node.y += dy * ratio;
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
    node.layoutTargetX = node.x;
    node.layoutTargetY = node.y;
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
    node.fx = node.x;
    node.fy = node.y;
    node.layoutTargetX = node.x;
    node.layoutTargetY = node.y;
    if (onNodePositionChange) {
      onNodePositionChange(node.id, node.x, node.y);
    }
  }, [onNodePositionChange]);

  const linkCanvasObject = useCallback((link, ctx) => {
    const endpoints = getLinkEndpoints(link);
    if (!endpoints) {
      return;
    }

    const { source, target } = endpoints;
    const width = edgeWidth(link);
    const control = controlPointForCurve(source, target, EDGE_CURVATURE);
    const distribution = protocolDistribution(link);
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

      ctx.strokeStyle = protocolColor(segment.protocol);
      ctx.lineWidth = width;
      drawCurveSegment(ctx, source, control, target, startT, endT);
      startT = endT;
    }

    const dropRatio = errorRatio(link);
    if (dropRatio > 0.001) {
      ctx.strokeStyle = `rgba(248, 81, 73, ${0.24 + (dropRatio * 0.5)})`;
      ctx.lineWidth = Math.max(1, width * 0.38);
      ctx.setLineDash([7, 5]);
      drawCurveSegment(ctx, source, control, target, 0, 1);
      ctx.setLineDash([]);
    }

    drawParticlesOnCurve(ctx, source, control, target, link, nowMs);

    ctx.restore();
  }, []);

  const showLoading = !hasReceivedData && data.nodes.length === 0;
  const showEmpty = hasReceivedData && data.nodes.length === 0;

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
          More particles = more traffic
        </div>
        <div className="graph-legend-row">
          <span className="graph-legend-swatch graph-legend-swatch-particle" />
          Particle motion = flow direction
        </div>
        <div className="graph-legend-row">
          <span className="graph-legend-swatch graph-legend-swatch-drop" />
          Red dashed overlay = dropped traffic
        </div>
        <div className="graph-legend-row graph-legend-row-protocols">
          <span className="graph-legend-swatch graph-legend-swatch-mixed" />
          Protocol colors:
          <div className="graph-legend-protocol-list">
            {PROTOCOL_LEGEND.map((item) => (
              <span className="graph-legend-protocol-item" key={item.protocol}>
                <span className="graph-legend-protocol-dot" style={{ backgroundColor: item.color }} />
                {item.protocol}
              </span>
            ))}
          </div>
        </div>
      </aside>
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
            <div className="graph-empty-text">No network flows detected</div>
            <div className="graph-empty-hint">Flows will appear when traffic is observed</div>
          </div>
        </div>
      )}
    </div>
  );
}
