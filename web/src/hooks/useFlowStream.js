import { useState, useEffect, useRef, useCallback } from 'react';

const EMPTY_GRAPH = { nodes: [], links: [] };

const NAMESPACE_CENTERS = {
  'demo': { x: -280, y: -40 },
  'kube-system': { x: 280, y: -40 },
  'default': { x: 0, y: 240 },
  '': { x: 0, y: -250 },
};

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function groupedPositionForNode(id, namespace) {
  const seed = hashString(id || 'unknown');
  const center = NAMESPACE_CENTERS[namespace] || { x: 0, y: 0 };
  const angle = (seed % 360) * (Math.PI / 180);
  const radius = 40 + (seed % 90);

  const x = center.x + Math.cos(angle) * radius;
  const y = center.y + Math.sin(angle) * radius;
  return { x, y, fx: x, fy: y };
}

export function useFlowStream(namespace) {
  const [graphData, setGraphData] = useState(EMPTY_GRAPH);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef(null);
  const nodePositionsRef = useRef(new Map());
  const draggingNodeIdsRef = useRef(new Set());

  const trackNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    draggingNodeIdsRef.current.add(nodeId);
    nodePositionsRef.current.set(nodeId, { x, y, fx: x, fy: y });
  }, []);

  const persistNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      draggingNodeIdsRef.current.delete(nodeId);
      return;
    }
    draggingNodeIdsRef.current.delete(nodeId);
    const nextPos = { x, y, fx: x, fy: y };
    nodePositionsRef.current.set(nodeId, nextPos);
    setGraphData((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...nextPos } : n)),
    }));
  }, []);

  useEffect(() => {
    setConnected(false);

    const url = namespace
      ? `/api/flows?namespace=${encodeURIComponent(namespace)}`
      : '/api/flows';

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
    };

    source.onmessage = (event) => {
      try {
        const graph = JSON.parse(event.data);
        const links = graph.links || [];
        const visibleNodeIds = new Set();

        const nodes = (graph.nodes || []).map((node) => {
          visibleNodeIds.add(node.id);
          const prev = nodePositionsRef.current.get(node.id);
          const pos = prev || groupedPositionForNode(node.id, node.namespace || '');
          const isDragging = draggingNodeIdsRef.current.has(node.id);
          const nextPos = isDragging ? pos : { ...pos, fx: pos.x, fy: pos.y };
          const next = { ...node, ...nextPos };
          nodePositionsRef.current.set(node.id, pos);
          return next;
        });

        for (const draggingId of draggingNodeIdsRef.current) {
          if (!visibleNodeIds.has(draggingId)) {
            draggingNodeIdsRef.current.delete(draggingId);
          }
        }

        setGraphData({
          nodes,
          links,
        });
      } catch {
        // Ignore malformed messages
      }
    };

    source.onerror = () => {
      setConnected(false);
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [namespace]);

  return { graphData, connected, trackNodePosition, persistNodePosition };
}
