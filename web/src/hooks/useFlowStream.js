import { useState, useEffect, useRef, useCallback } from 'react';

const VIEW_MODES = Object.freeze({
  service: 'service',
  pod: 'pod',
});

const MODES = [VIEW_MODES.service, VIEW_MODES.pod];

const NAMESPACE_CENTERS = {
  'demo': { x: -280, y: -40 },
  'kube-system': { x: 280, y: -40 },
  'default': { x: 0, y: 240 },
  '': { x: 0, y: -250 },
};

const NODE_RADIUS = 10;
const OVERLAP_PADDING = 8;
const OVERLAP_MAX_ITERATIONS = 24;
const BASE_MIN_NODE_DISTANCE = (NODE_RADIUS * 2) + OVERLAP_PADDING;
const LAYOUT_MIN_NODE_DISTANCE = BASE_MIN_NODE_DISTANCE * 2;
const LAYOUT_OVERLAP_MAX_ITERATIONS = 40;
const LAYOUT_PUSH_START = 1.05;
const LAYOUT_PUSH_DECAY_POWER = 1.7;
const LAYOUT_PUSH_EPSILON = 0.001;
const LAYOUT_PUSH_MULTIPLIER = 2;

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function parseReplicaIdentity(label) {
  if (typeof label !== 'string') {
    return { base: 'unknown', replica: null };
  }
  const match = /^(.+)-([0-9]+)$/.exec(label);
  if (!match) {
    return { base: label || 'unknown', replica: null };
  }
  return {
    base: match[1] || 'unknown',
    replica: Number(match[2]),
  };
}

function groupedPositionForNode(node) {
  const namespace = node?.namespace || '';
  const label = typeof node?.label === 'string' && node.label.length > 0
    ? node.label
    : (typeof node?.id === 'string' ? node.id : 'unknown');
  const { base, replica } = parseReplicaIdentity(label);
  const namespaceCenter = NAMESPACE_CENTERS[namespace] || { x: 0, y: 0 };

  const clusterSeed = hashString(`${namespace}/${base}`);
  const clusterAngle = (clusterSeed % 360) * (Math.PI / 180);
  const clusterRadius = 70 + (clusterSeed % 160);
  const centerX = namespaceCenter.x + (Math.cos(clusterAngle) * clusterRadius);
  const centerY = namespaceCenter.y + (Math.sin(clusterAngle) * clusterRadius);

  const fallbackSeed = hashString(node?.id || label);
  const ordinal = Number.isInteger(replica) ? replica : (fallbackSeed % 12);
  const ring = Math.floor(ordinal / 10);
  const slot = ordinal % 10;
  const clusterRotation = (hashString(`${namespace}/${base}:pods`) % 360) * (Math.PI / 180);
  const angle = clusterRotation + ((slot / 10) * (Math.PI * 2));
  const radius = 18 + (ring * 14);

  return {
    x: centerX + (Math.cos(angle) * radius),
    y: centerY + (Math.sin(angle) * radius),
  };
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

function createEmptyGraph() {
  return { nodes: [], links: [] };
}

function createInitialModeState() {
  return {
    graphData: createEmptyGraph(),
    connected: false,
    truncation: null,
  };
}

function createInitialAllModeState() {
  return {
    [VIEW_MODES.service]: createInitialModeState(),
    [VIEW_MODES.pod]: createInitialModeState(),
  };
}

function resolveViewMode(viewMode) {
  return viewMode === VIEW_MODES.pod ? VIEW_MODES.pod : VIEW_MODES.service;
}

function storageKeyForMode(mode) {
  return `hubble-gazer-node-positions:v2:${mode}`;
}

function loadPositionsFromStorage(mode) {
  try {
    const saved = localStorage.getItem(storageKeyForMode(mode));
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

function savePositionsToStorage(mode, positionsMap) {
  try {
    const obj = {};
    for (const [id, pos] of positionsMap) {
      obj[id] = { x: pos.x, y: pos.y };
    }
    localStorage.setItem(storageKeyForMode(mode), JSON.stringify(obj));
  } catch {
    // Ignore storage errors (quota, etc.)
  }
}

function clearPositionsFromStorage(mode) {
  try {
    localStorage.removeItem(storageKeyForMode(mode));
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
  node.layoutTargetX = x;
  node.layoutTargetY = y;
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

function resolveLayoutOverlapsInPlace(nodes, immobileNodeIds = null) {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return;
  }

  for (let iter = 0; iter < LAYOUT_OVERLAP_MAX_ITERATIONS; iter++) {
    const progress = iter / Math.max(1, LAYOUT_OVERLAP_MAX_ITERATIONS - 1);
    const strength = LAYOUT_PUSH_START * Math.pow(1 - progress, LAYOUT_PUSH_DECAY_POWER);
    if (strength <= LAYOUT_PUSH_EPSILON) {
      break;
    }

    let moved = false;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) {
        continue;
      }
      const aImmobile = !!(immobileNodeIds && a.id && immobileNodeIds.has(a.id));

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
          continue;
        }
        const bImmobile = !!(immobileNodeIds && b.id && immobileNodeIds.has(b.id));

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= LAYOUT_MIN_NODE_DISTANCE) {
          continue;
        }

        moved = true;
        if (distance === 0) {
          const escape = overlapEscapeDirection(a.id, b.id);
          dx = escape.x;
          dy = escape.y;
          distance = 1;
        }

        const overlap = LAYOUT_MIN_NODE_DISTANCE - distance;
        const push = overlap * strength * LAYOUT_PUSH_MULTIPLIER;
        const unitX = dx / distance;
        const unitY = dy / distance;
        if (aImmobile && bImmobile) {
          continue;
        }
        if (aImmobile) {
          b.x += unitX * push;
          b.y += unitY * push;
          continue;
        }
        if (bImmobile) {
          a.x -= unitX * push;
          a.y -= unitY * push;
          continue;
        }

        const splitOverlap = push / 2;
        a.x -= unitX * splitOverlap;
        a.y -= unitY * splitOverlap;
        b.x += unitX * splitOverlap;
        b.y += unitY * splitOverlap;
      }
    }

    if (!moved) {
      break;
    }
  }
}

function applyGroupedLayoutInPlace(nodes) {
  if (!Array.isArray(nodes)) {
    return nodes;
  }

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const pos = groupedPositionForNode(node);
    node.x = pos.x;
    node.y = pos.y;
  }

  resolveLayoutOverlapsInPlace(nodes);

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      continue;
    }
    setNodeFixedPosition(node, node.x, node.y);
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

  const fallback = groupedPositionForNode(existingNode);
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
    const startPosition = pinnedPosition || groupedPositionForNode(nodePatch);
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

  const layoutNodes = nextNodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
  }));
  resolveLayoutOverlapsInPlace(layoutNodes, draggingNodeIds);

  const layoutById = new Map();
  for (const node of layoutNodes) {
    if (!node || typeof node.id !== 'string' || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      continue;
    }
    layoutById.set(node.id, { x: node.x, y: node.y });
  }

  for (const node of nextNodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const layoutTarget = layoutById.get(node.id);
    if (layoutTarget) {
      node.layoutTargetX = layoutTarget.x;
      node.layoutTargetY = layoutTarget.y;
      continue;
    }
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
      node.layoutTargetX = node.x;
      node.layoutTargetY = node.y;
    }
  }

  return { nodes: nextNodes, links: nextLinks };
}

function updateModeConnected(prev, mode, connected) {
  if (!prev[mode] || prev[mode].connected === connected) {
    return prev;
  }
  return {
    ...prev,
    [mode]: {
      ...prev[mode],
      connected,
    },
  };
}

function normalizeTruncation(truncation) {
  if (!truncation || typeof truncation !== 'object') {
    return null;
  }

  const limit = Number(truncation.limit);
  const totalNodes = Number(truncation.totalNodes);
  const shownNodes = Number(truncation.shownNodes);

  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(totalNodes) || totalNodes < 0 || !Number.isFinite(shownNodes) || shownNodes < 0) {
    return null;
  }

  return {
    reason: typeof truncation.reason === 'string' ? truncation.reason : '',
    limit,
    totalNodes,
    shownNodes,
  };
}

export function useFlowStream(namespace, activeViewMode = VIEW_MODES.service) {
  const resolvedActiveMode = resolveViewMode(activeViewMode);
  const [modeState, setModeState] = useState(createInitialAllModeState);
  const sourcesRef = useRef({
    [VIEW_MODES.service]: null,
    [VIEW_MODES.pod]: null,
  });
  const nodePositionsRef = useRef({
    [VIEW_MODES.service]: loadPositionsFromStorage(VIEW_MODES.service),
    [VIEW_MODES.pod]: loadPositionsFromStorage(VIEW_MODES.pod),
  });
  const draggingNodeIdsRef = useRef({
    [VIEW_MODES.service]: new Set(),
    [VIEW_MODES.pod]: new Set(),
  });

  const trackNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    const mode = resolvedActiveMode;
    draggingNodeIdsRef.current[mode].add(nodeId);
    nodePositionsRef.current[mode].set(nodeId, { x, y });
  }, [resolvedActiveMode]);

  const persistNodePosition = useCallback((nodeId, x, y) => {
    const mode = resolvedActiveMode;
    const draggingNodeIds = draggingNodeIdsRef.current[mode];
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      draggingNodeIds.delete(nodeId);
      return;
    }

    draggingNodeIds.delete(nodeId);
    setModeState((prev) => {
      const currentModeState = prev[mode];
      const graphData = currentModeState.graphData;
      const idx = graphData.nodes.findIndex((node) => node.id === nodeId);
      if (idx === -1) {
        return prev;
      }

      const node = graphData.nodes[idx];
      setNodeFixedPosition(node, x, y);
      const resolved = resolveDraggedNodeOverlap(graphData.nodes, nodeId) || { x: node.x, y: node.y };
      nodePositionsRef.current[mode].set(nodeId, resolved);
      savePositionsToStorage(mode, nodePositionsRef.current[mode]);

      return {
        ...prev,
        [mode]: {
          ...currentModeState,
          graphData: {
            ...graphData,
            nodes: [...graphData.nodes],
          },
        },
      };
    });
  }, [resolvedActiveMode]);

  const resetLayout = useCallback(() => {
    const mode = resolvedActiveMode;
    draggingNodeIdsRef.current[mode].clear();
    nodePositionsRef.current[mode].clear();
    clearPositionsFromStorage(mode);

    setModeState((prev) => {
      const currentModeState = prev[mode];
      const graphData = currentModeState.graphData;

      if (graphData.nodes.length === 0) {
        return prev;
      }

      applyGroupedLayoutInPlace(graphData.nodes);

      return {
        ...prev,
        [mode]: {
          ...currentModeState,
          graphData: {
            ...graphData,
            nodes: [...graphData.nodes],
            links: [...graphData.links],
          },
        },
      };
    });
  }, [resolvedActiveMode]);

  useEffect(() => {
    for (const mode of MODES) {
      const source = sourcesRef.current[mode];
      if (source) {
        source.close();
        sourcesRef.current[mode] = null;
      }
    }

    setModeState((prev) => {
      let next = prev;
      for (const mode of MODES) {
        next = updateModeConnected(next, mode, false);
      }
      return next;
    });

    for (const mode of MODES) {
      const search = new URLSearchParams();
      search.set('view', mode);
      if (namespace) {
        search.set('namespace', namespace);
      }

      const source = new EventSource(`/api/flows?${search.toString()}`);
      sourcesRef.current[mode] = source;

      source.onopen = () => {
        setModeState((prev) => updateModeConnected(prev, mode, true));
      };

      source.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data);
          setModeState((prev) => {
            const currentModeState = prev[mode];
            const graphData = mergeGraphUpdate(
              currentModeState.graphData,
              incoming,
              nodePositionsRef.current[mode],
              draggingNodeIdsRef.current[mode],
            );

            return {
              ...prev,
              [mode]: {
                ...currentModeState,
                graphData,
                truncation: normalizeTruncation(incoming?.truncation),
              },
            };
          });
        } catch {
          // Ignore malformed messages
        }
      };

      source.onerror = () => {
        setModeState((prev) => updateModeConnected(prev, mode, false));
      };
    }

    return () => {
      for (const mode of MODES) {
        const source = sourcesRef.current[mode];
        if (source) {
          source.close();
          sourcesRef.current[mode] = null;
        }
      }
    };
  }, [namespace]);

  const activeModeState = modeState[resolvedActiveMode] || createInitialModeState();

  return {
    graphData: activeModeState.graphData,
    connected: activeModeState.connected,
    truncation: activeModeState.truncation,
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
