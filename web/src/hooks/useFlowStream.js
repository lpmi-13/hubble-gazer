import { useState, useEffect, useRef, useCallback } from 'react';

const EMPTY_GRAPH = { nodes: [], links: [] };

const NAMESPACE_CENTERS = {
  'demo': { x: -280, y: -40 },
  'kube-system': { x: 280, y: -40 },
  'default': { x: 0, y: 240 },
  '': { x: 0, y: -250 },
};

const NODE_RADIUS = 10;
const OVERLAP_PADDING = 8;
const OVERLAP_MAX_ITERATIONS = 24;

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
  return { x, y };
}

function nodeRadius(node) {
  return NODE_RADIUS;
}

function getEndpointId(endpoint) {
  if (endpoint && typeof endpoint === 'object') {
    return endpoint.id || endpoint.label;
  }
  return endpoint;
}

function getLinkKey(link) {
  if (!link) {
    return null;
  }
  const source = getEndpointId(link.source);
  const target = getEndpointId(link.target);
  if (!source || !target) {
    return null;
  }
  return `${source}->${target}`;
}

function cloneProtocolMix(protocolMix) {
  if (!protocolMix || typeof protocolMix !== 'object') {
    return undefined;
  }
  const copied = {};
  for (const [protocol, count] of Object.entries(protocolMix)) {
    const numeric = Number(count);
    if (Number.isFinite(numeric) && numeric > 0) {
      copied[protocol] = numeric;
    }
  }
  return Object.keys(copied).length > 0 ? copied : undefined;
}

const STORAGE_KEY = 'hubble-gazer-node-positions';

function loadPositionsFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const entries = JSON.parse(saved);
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        return new Map();
      }
      const validated = new Map();
      for (const [key, val] of Object.entries(entries)) {
        if (key.length > 256) continue;
        if (val && typeof val === 'object' && Number.isFinite(val.x) && Number.isFinite(val.y)) {
          validated.set(key, { x: val.x, y: val.y });
        }
      }
      return validated;
    }
  } catch {
    // Ignore corrupted storage
  }
  return new Map();
}

function savePositionsToStorage(positionsMap) {
  try {
    const obj = {};
    for (const [id, pos] of positionsMap) {
      obj[id] = { x: pos.x, y: pos.y };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Ignore storage errors (quota, etc.)
  }
}

function clearPositionsFromStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors (quota, etc.)
  }
}

function setNodeFixedPosition(node, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  node.x = x;
  node.y = y;
  node.fx = x;
  node.fy = y;
  node.vx = 0;
  node.vy = 0;
}

function overlapEscapeDirection(targetId, otherId) {
  const seed = hashString(`${targetId || ''}->${otherId || ''}`);
  const angle = (seed % 360) * (Math.PI / 180);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function resolveDraggedNodeOverlap(nodes, draggedNodeId) {
  if (!Array.isArray(nodes) || nodes.length < 2 || !draggedNodeId) {
    return null;
  }

  const draggedNode = nodes.find((node) => node.id === draggedNodeId);
  if (!draggedNode || !Number.isFinite(draggedNode.x) || !Number.isFinite(draggedNode.y)) {
    return null;
  }

  for (let i = 0; i < OVERLAP_MAX_ITERATIONS; i++) {
    let collisions = 0;
    let pushX = 0;
    let pushY = 0;
    const draggedRadius = nodeRadius(draggedNode);

    for (const node of nodes) {
      if (!node || node.id === draggedNodeId || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        continue;
      }

      const minDistance = draggedRadius + nodeRadius(node) + OVERLAP_PADDING;
      let dx = draggedNode.x - node.x;
      let dy = draggedNode.y - node.y;
      let distance = Math.hypot(dx, dy);

      if (distance >= minDistance) {
        continue;
      }

      if (distance === 0) {
        const escape = overlapEscapeDirection(draggedNode.id, node.id);
        dx = escape.x;
        dy = escape.y;
        distance = 1;
      }

      const overlap = minDistance - distance;
      collisions += 1;
      pushX += (dx / distance) * overlap;
      pushY += (dy / distance) * overlap;
    }

    if (collisions === 0) {
      break;
    }

    // Damp the corrective movement to avoid large jumps when the node intersects multiple neighbors.
    draggedNode.x += pushX * 0.55;
    draggedNode.y += pushY * 0.55;
  }

  setNodeFixedPosition(draggedNode, draggedNode.x, draggedNode.y);
  return { x: draggedNode.x, y: draggedNode.y };
}

function applyGroupedLayoutInPlace(nodes) {
  if (!Array.isArray(nodes)) {
    return nodes;
  }
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const pos = groupedPositionForNode(node.id, node.namespace || '');
    setNodeFixedPosition(node, pos.x, pos.y);
  }
  return nodes;
}

function updateExistingNode(existingNode, nodePatch, pinnedPosition, isDragging) {
  existingNode.label = nodePatch.label;
  existingNode.namespace = nodePatch.namespace;
  existingNode.traffic = nodePatch.traffic;

  if (isDragging && Number.isFinite(existingNode.x) && Number.isFinite(existingNode.y)) {
    setNodeFixedPosition(existingNode, existingNode.x, existingNode.y);
    return;
  }

  if (pinnedPosition) {
    setNodeFixedPosition(existingNode, pinnedPosition.x, pinnedPosition.y);
    return;
  }

  if (Number.isFinite(existingNode.x) && Number.isFinite(existingNode.y)) {
    setNodeFixedPosition(existingNode, existingNode.x, existingNode.y);
    return;
  }

  const fallback = groupedPositionForNode(existingNode.id, nodePatch.namespace || '');
  setNodeFixedPosition(existingNode, fallback.x, fallback.y);
}

function mergeGraphUpdate(prevGraphData, incomingGraph, nodePositions, draggingNodeIds) {
  const incomingNodes = Array.isArray(incomingGraph?.nodes) ? incomingGraph.nodes : [];
  const incomingLinks = Array.isArray(incomingGraph?.links) ? incomingGraph.links : [];
  const visibleNodeIds = new Set();

  const incomingNodeById = new Map();
  for (const node of incomingNodes) {
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      continue;
    }
    incomingNodeById.set(node.id, node);
    visibleNodeIds.add(node.id);
  }

  // Keep existing node object references so d3 simulation state (x/y/vx/vy/fx/fy) survives telemetry updates.
  const nextNodes = [];
  for (const existingNode of prevGraphData.nodes) {
    const nodePatch = incomingNodeById.get(existingNode.id);
    if (!nodePatch) {
      continue;
    }
    updateExistingNode(
      existingNode,
      nodePatch,
      nodePositions.get(existingNode.id),
      draggingNodeIds.has(existingNode.id),
    );
    nextNodes.push(existingNode);
    incomingNodeById.delete(existingNode.id);
  }

  for (const nodePatch of incomingNodeById.values()) {
    const pinnedPosition = nodePositions.get(nodePatch.id);
    const startPosition = pinnedPosition || groupedPositionForNode(nodePatch.id, nodePatch.namespace || '');
    const nextNode = { ...nodePatch };
    setNodeFixedPosition(nextNode, startPosition.x, startPosition.y);
    nextNodes.push(nextNode);
  }

  for (const draggingId of draggingNodeIds) {
    if (!visibleNodeIds.has(draggingId)) {
      draggingNodeIds.delete(draggingId);
    }
  }

  const incomingLinkByKey = new Map();
  for (const link of incomingLinks) {
    const key = getLinkKey(link);
    if (key) {
      incomingLinkByKey.set(key, link);
    }
  }

  // Preserve link object references to keep graph internals stable while refreshing flow metrics.
  const nextLinks = [];
  for (const existingLink of prevGraphData.links) {
    const key = getLinkKey(existingLink);
    if (!key) {
      continue;
    }
    const patch = incomingLinkByKey.get(key);
    if (!patch) {
      continue;
    }
    existingLink.flowRate = patch.flowRate;
    existingLink.flowCount = patch.flowCount;
    existingLink.successRate = patch.successRate;
    existingLink.protocol = patch.protocol;
    existingLink.protocolMix = cloneProtocolMix(patch.protocolMix);
    existingLink.verdict = patch.verdict;
    nextLinks.push(existingLink);
    incomingLinkByKey.delete(key);
  }

  for (const patch of incomingLinkByKey.values()) {
    nextLinks.push({
      ...patch,
      protocolMix: cloneProtocolMix(patch.protocolMix),
    });
  }

  return { nodes: nextNodes, links: nextLinks };
}

export function useFlowStream(namespace) {
  const [graphData, setGraphData] = useState(EMPTY_GRAPH);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef(null);
  const nodePositionsRef = useRef(loadPositionsFromStorage());
  const draggingNodeIdsRef = useRef(new Set());

  const trackNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    draggingNodeIdsRef.current.add(nodeId);
    nodePositionsRef.current.set(nodeId, { x, y });
  }, []);

  const persistNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      draggingNodeIdsRef.current.delete(nodeId);
      return;
    }
    draggingNodeIdsRef.current.delete(nodeId);
    setGraphData((prev) => {
      const idx = prev.nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) {
        return prev;
      }
      const node = prev.nodes[idx];
      setNodeFixedPosition(node, x, y);
      const resolved = resolveDraggedNodeOverlap(prev.nodes, nodeId) || { x: node.x, y: node.y };
      nodePositionsRef.current.set(nodeId, resolved);
      savePositionsToStorage(nodePositionsRef.current);
      return {
        ...prev,
        nodes: [...prev.nodes],
      };
    });
  }, []);

  const resetLayout = useCallback(() => {
    draggingNodeIdsRef.current.clear();
    nodePositionsRef.current.clear();
    clearPositionsFromStorage();

    setGraphData((prev) => {
      if (prev.nodes.length === 0) {
        return prev;
      }
      applyGroupedLayoutInPlace(prev.nodes);

      return {
        ...prev,
        nodes: [...prev.nodes],
        links: [...prev.links],
      };
    });
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
        setGraphData((prev) => mergeGraphUpdate(
          prev,
          graph,
          nodePositionsRef.current,
          draggingNodeIdsRef.current,
        ));
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

  return {
    graphData,
    connected,
    trackNodePosition,
    persistNodePosition,
    resetLayout,
  };
}

export const __TEST_ONLY__ = {
  nodeRadius,
  setNodeFixedPosition,
  resolveDraggedNodeOverlap,
  mergeGraphUpdate,
  applyGroupedLayoutInPlace,
};
