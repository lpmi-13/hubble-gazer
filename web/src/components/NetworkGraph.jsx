import React, { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const NAMESPACE_COLORS = {
  'demo': '#58a6ff',
  'kube-system': '#bc8cff',
  'default': '#79c0ff',
};

const DEFAULT_COLOR = '#8b949e';

function getNodeColor(node) {
  return NAMESPACE_COLORS[node.namespace] || DEFAULT_COLOR;
}

function getParticleColor(link) {
  if (link.verdict === 'DROPPED') return '#f85149';
  if (link.protocol === 'UDP') return '#79c0ff';
  return '#3fb950';
}

export default function NetworkGraph({ data, onLinkClick, onNodeDrag, onNodePositionChange }) {
  const graphRef = useRef();
  const containerRef = useRef();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);

  useEffect(() => {
    if (data.nodes.length > 0 && !hasReceivedData) {
      setHasReceivedData(true);
    }
  }, [data.nodes.length, hasReceivedData]);

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
    const nodeSize = Math.max(4, Math.sqrt(node.traffic || 1) * 2);
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
    const nodeSize = Math.max(4, Math.sqrt(node.traffic || 1) * 2);
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize + 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  const handleNodeDrag = useCallback((node) => {
    if (!node) {
      return;
    }
    setIsDragging(true);
    node.fx = node.x;
    node.fy = node.y;
    if (onNodeDrag) {
      onNodeDrag(node.id, node.x, node.y);
    }
  }, [onNodeDrag]);

  const handleNodeDragEnd = useCallback((node) => {
    setIsDragging(false);
    if (!node) {
      return;
    }
    node.fx = node.x;
    node.fy = node.y;
    if (onNodePositionChange) {
      onNodePositionChange(node.id, node.x, node.y);
    }
  }, [onNodePositionChange]);

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
          linkColor={() => '#2f4c65'}
          linkWidth={(link) => Math.max(1, Math.log2((link.flowRate || 0) + 1) * 2)}
          linkDirectionalParticles={(link) => Math.ceil(link.flowRate || 0)}
          linkDirectionalParticleWidth={(link) =>
            Math.max(2, Math.sqrt(link.flowRate || 0) * 3)
          }
          linkDirectionalParticleSpeed={0.005}
          linkDirectionalParticleColor={getParticleColor}
          linkCurvature={0.1}
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
