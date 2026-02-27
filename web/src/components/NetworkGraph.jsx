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

export default function NetworkGraph({ data, onLinkClick }) {
  const graphRef = useRef();
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    function handleResize() {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight - 52, // header height
      });
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
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
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#c9d1d9';
    ctx.fillText(label, node.x, node.y + nodeSize + 3);
  }, []);

  const nodePointerAreaPaint = useCallback((node, color, ctx) => {
    const nodeSize = Math.max(4, Math.sqrt(node.traffic || 1) * 2);
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize + 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={data}
      width={dimensions.width}
      height={dimensions.height}
      backgroundColor="#0d1117"
      nodeId="id"
      nodeCanvasObject={nodeCanvasObject}
      nodePointerAreaPaint={nodePointerAreaPaint}
      linkColor={() => '#30363d'}
      linkWidth={(link) => Math.max(1, Math.log2((link.flowRate || 0) + 1) * 2)}
      linkDirectionalParticles={(link) => Math.ceil(link.flowRate || 0)}
      linkDirectionalParticleWidth={(link) =>
        Math.max(2, Math.sqrt(link.flowRate || 0) * 3)
      }
      linkDirectionalParticleSpeed={0.005}
      linkDirectionalParticleColor={getParticleColor}
      linkCurvature={0.1}
      onLinkClick={onLinkClick}
      d3AlphaDecay={0.02}
      d3VelocityDecay={0.3}
      cooldownTicks={100}
      warmupTicks={50}
    />
  );
}
