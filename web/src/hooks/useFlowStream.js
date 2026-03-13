import { useState, useEffect, useRef, useCallback } from 'react';

const VIEW_MODES = Object.freeze({
  service: 'service',
  pod: 'pod',
});

const TRAFFIC_LAYERS = Object.freeze({
  l4: 'l4',
  l7: 'l7',
});

const LAYOUT_MODES = Object.freeze({
  default: 'default',
  k8sNode: 'k8sNode',
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
const NODE_GROUP_CIRCLE_MIN_RADIUS = 220;
const NODE_GROUP_CIRCLE_CHORD_SPACING = 360;
const NODE_GROUP_CIRCLE_MIN_COUNT_FOR_SPACING = 5;
const NODE_GROUP_CIRCLE_START_ANGLE = -Math.PI / 2;
const NODE_GROUP_SLOT_CAPACITY = 12;
const NODE_GROUP_BASE_RADIUS = 26;
const NODE_GROUP_RING_STEP = 18;
const NODE_GROUP_BOX_PADDING = 52;
const NODE_GROUP_BOX_MIN_HALF_SIZE = 132;
const NODE_GROUP_INNER_PADDING = NODE_RADIUS + 10;
const NODE_GROUP_FREE_NODE_GAP = 150;
const NODE_GROUP_FREE_NODE_EXTERNAL_OFFSET = 64;
const NODE_GROUP_FREE_SLOT_CAPACITY = 8;
const NODE_GROUP_FREE_BASE_RADIUS = 22;
const NODE_GROUP_FREE_RING_STEP = 16;

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

function normalizeK8sNodeKey(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : 'unknown';
}

function concreteK8sNodeKey(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length === 0 || normalized === 'unknown') {
    return '';
  }
  return normalized;
}

function nodeGroupKeyForNode(node) {
  return concreteK8sNodeKey(node?.k8sNode);
}

function normalizeKnownK8sNodes(...sources) {
  const merged = new Set();

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const raw of source) {
      if (typeof raw !== 'string') {
        continue;
      }
      const value = raw.trim();
      if (value.length === 0) {
        continue;
      }
      merged.add(value);
    }
  }

  return [...merged].sort((a, b) => a.localeCompare(b));
}

function collectKnownK8sNodesFromGraph(nodes) {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const keys = [];
  for (const node of nodes) {
    const key = concreteK8sNodeKey(node?.k8sNode);
    if (key.length === 0) {
      continue;
    }
    keys.push(key);
  }
  return normalizeKnownK8sNodes(keys);
}

function nodeGroupCenters(keys) {
  const centers = new Map();
  if (!Array.isArray(keys) || keys.length === 0) {
    return centers;
  }

  if (keys.length === 1) {
    centers.set(keys[0], { x: 0, y: 0 });
    return centers;
  }

  const count = keys.length;
  const spacingCount = Math.max(count, NODE_GROUP_CIRCLE_MIN_COUNT_FOR_SPACING);
  const denominator = 2 * Math.sin(Math.PI / spacingCount);
  const requiredRadius = denominator > 0
    ? NODE_GROUP_CIRCLE_CHORD_SPACING / denominator
    : NODE_GROUP_CIRCLE_MIN_RADIUS;
  const radius = Math.max(NODE_GROUP_CIRCLE_MIN_RADIUS, requiredRadius);

  keys.forEach((key, index) => {
    const angle = NODE_GROUP_CIRCLE_START_ANGLE + ((index / count) * Math.PI * 2);
    centers.set(key, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  });
  return centers;
}

function groupedLayoutOuterRadius(boxes) {
  let maxRadius = NODE_GROUP_CIRCLE_MIN_RADIUS + NODE_GROUP_BOX_MIN_HALF_SIZE;

  for (const box of boxes || []) {
    if (!box) {
      continue;
    }
    const halfWidth = Math.max(0, (Number(box.maxX) - Number(box.minX)) / 2);
    const halfHeight = Math.max(0, (Number(box.maxY) - Number(box.minY)) / 2);
    const halfSize = Math.max(halfWidth, halfHeight);
    const radius = Math.hypot(Number(box.centerX) || 0, Number(box.centerY) || 0) + halfSize;
    if (Number.isFinite(radius)) {
      maxRadius = Math.max(maxRadius, radius);
    }
  }

  return maxRadius;
}

function freeNodeOrbitAngle(node) {
  if (node?.kind === 'external') {
    return -Math.PI / 2;
  }

  const namespace = node?.namespace || '';
  const center = NAMESPACE_CENTERS[namespace] || { x: 0, y: 240 };
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || (center.x === 0 && center.y === 0)) {
    return Math.PI / 2;
  }
  return Math.atan2(center.y, center.x);
}

function freeNodeAnchorForGroupedLayout(node, outerRadius) {
  const baseAngle = freeNodeOrbitAngle(node);
  const offset = node?.kind === 'external' ? NODE_GROUP_FREE_NODE_EXTERNAL_OFFSET : 0;
  const radius = Math.max(outerRadius + NODE_GROUP_FREE_NODE_GAP + offset, NODE_GROUP_CIRCLE_MIN_RADIUS);

  return {
    x: Math.cos(baseAngle) * radius,
    y: Math.sin(baseAngle) * radius,
  };
}

function freeNodePositionForGroupedLayout(node, outerRadius) {
  const anchor = freeNodeAnchorForGroupedLayout(node, outerRadius);
  const label = typeof node?.label === 'string' && node.label.length > 0
    ? node.label
    : (typeof node?.id === 'string' ? node.id : 'unknown');
  const { base, replica } = parseReplicaIdentity(label);
  const fallbackSeed = hashString(node?.id || label);
  const ordinal = Number.isInteger(replica) ? replica : (fallbackSeed % NODE_GROUP_FREE_SLOT_CAPACITY);
  const ring = Math.floor(ordinal / NODE_GROUP_FREE_SLOT_CAPACITY);
  const slot = ordinal % NODE_GROUP_FREE_SLOT_CAPACITY;
  const rotation = (hashString(`free-node:${node?.namespace || ''}/${base}/${node?.kind || 'node'}`) % 360) * (Math.PI / 180);
  const angle = rotation + ((slot / NODE_GROUP_FREE_SLOT_CAPACITY) * (Math.PI * 2));
  const radius = NODE_GROUP_FREE_BASE_RADIUS + (ring * NODE_GROUP_FREE_RING_STEP);

  return {
    x: anchor.x + (Math.cos(angle) * radius),
    y: anchor.y + (Math.sin(angle) * radius),
  };
}

function buildNodeGroupLayoutPlan(nodes, knownNodeKeys = []) {
  const groups = new Map();
  for (const key of normalizeKnownK8sNodes(knownNodeKeys).map((value) => concreteK8sNodeKey(value)).filter(Boolean)) {
    if (!groups.has(key)) {
      groups.set(key, []);
    }
  }
  const freeNodes = [];

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const key = nodeGroupKeyForNode(node);
    if (key.length === 0) {
      freeNodes.push(node);
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(node);
  }

  const orderedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const centers = nodeGroupCenters(orderedKeys);
  const boxes = [];
  const targetsByID = new Map();

  for (const key of orderedKeys) {
    const cluster = groups.get(key);
    if (!Array.isArray(cluster)) {
      continue;
    }

    if (cluster.length > 0) {
      cluster.sort((a, b) => {
        const aID = typeof a.id === 'string' ? a.id : '';
        const bID = typeof b.id === 'string' ? b.id : '';
        return aID.localeCompare(bID);
      });
    }

    const center = centers.get(key) || { x: 0, y: 0 };
    const rotation = (hashString(`node-group:${key}`) % 360) * (Math.PI / 180);
    const maxRing = Math.floor(Math.max(0, cluster.length - 1) / NODE_GROUP_SLOT_CAPACITY);
    const maxRadius = NODE_GROUP_BASE_RADIUS + (maxRing * NODE_GROUP_RING_STEP);
    const halfSize = Math.max(NODE_GROUP_BOX_MIN_HALF_SIZE, maxRadius + NODE_GROUP_BOX_PADDING);
    const box = {
      key,
      label: key,
      centerX: center.x,
      centerY: center.y,
      minX: center.x - halfSize,
      maxX: center.x + halfSize,
      minY: center.y - halfSize,
      maxY: center.y + halfSize,
      innerMinX: (center.x - halfSize) + NODE_GROUP_INNER_PADDING,
      innerMaxX: (center.x + halfSize) - NODE_GROUP_INNER_PADDING,
      innerMinY: (center.y - halfSize) + NODE_GROUP_INNER_PADDING,
      innerMaxY: (center.y + halfSize) - NODE_GROUP_INNER_PADDING,
    };
    boxes.push(box);

    for (let i = 0; i < cluster.length; i++) {
      const node = cluster[i];
      const ring = Math.floor(i / NODE_GROUP_SLOT_CAPACITY);
      const slot = i % NODE_GROUP_SLOT_CAPACITY;
      const angle = rotation + ((slot / NODE_GROUP_SLOT_CAPACITY) * (Math.PI * 2));
      const radius = NODE_GROUP_BASE_RADIUS + (ring * NODE_GROUP_RING_STEP);
      targetsByID.set(node.id, {
        x: center.x + (Math.cos(angle) * radius),
        y: center.y + (Math.sin(angle) * radius),
        key,
      });
    }
  }

  const freeNodeRadius = groupedLayoutOuterRadius(boxes);
  freeNodes.sort((a, b) => {
    const aID = typeof a.id === 'string' ? a.id : '';
    const bID = typeof b.id === 'string' ? b.id : '';
    return aID.localeCompare(bID);
  });
  for (const node of freeNodes) {
    const position = freeNodePositionForGroupedLayout(node, freeNodeRadius);
    targetsByID.set(node.id, position);
  }

  return { boxes, targetsByID };
}

function nodeGroupBoxMap(boxes) {
  const byKey = new Map();
  for (const box of boxes || []) {
    if (!box || typeof box.key !== 'string') {
      continue;
    }
    byKey.set(box.key, box);
  }
  return byKey;
}

function clampPointToGroupBox(boxesByKey, node, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x, y };
  }

  const key = nodeGroupKeyForNode(node);
  const box = boxesByKey.get(key);
  if (!box) {
    return { x, y };
  }

  return {
    x: Math.min(box.innerMaxX, Math.max(box.innerMinX, x)),
    y: Math.min(box.innerMaxY, Math.max(box.innerMinY, y)),
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

function cloneL7Details(l7) {
  if (!l7 || typeof l7 !== 'object') {
    return undefined;
  }

  const cloned = {
    requestCount: Number.isFinite(Number(l7.requestCount)) ? Number(l7.requestCount) : 0,
    responseCount: Number.isFinite(Number(l7.responseCount)) ? Number(l7.responseCount) : 0,
  };

  if (l7.http && typeof l7.http === 'object') {
    cloned.http = {};
    const statusClassMix = cloneProtocolMix(l7.http.statusClassMix);
    const methodMix = cloneProtocolMix(l7.http.methodMix);
    if (statusClassMix) {
      cloned.http.statusClassMix = statusClassMix;
    }
    if (methodMix) {
      cloned.http.methodMix = methodMix;
    }
    if (Number.isFinite(Number(l7.http.p50LatencyMs))) {
      cloned.http.p50LatencyMs = Number(l7.http.p50LatencyMs);
    }
    if (Number.isFinite(Number(l7.http.p95LatencyMs))) {
      cloned.http.p95LatencyMs = Number(l7.http.p95LatencyMs);
    }
    if (Object.keys(cloned.http).length === 0) {
      delete cloned.http;
    }
  }

  return cloned;
}

function clonePodSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const liveNodes = Number(summary.liveNodes);
  const terminatedNodes = Number(summary.terminatedNodes);
  const unresolvedNodes = Number(summary.unresolvedNodes);
  const unresolvedFlows = Number(summary.unresolvedFlows);

  return {
    liveNodes: Number.isFinite(liveNodes) && liveNodes >= 0 ? liveNodes : 0,
    terminatedNodes: Number.isFinite(terminatedNodes) && terminatedNodes >= 0 ? terminatedNodes : 0,
    unresolvedNodes: Number.isFinite(unresolvedNodes) && unresolvedNodes >= 0 ? unresolvedNodes : 0,
    unresolvedFlows: Number.isFinite(unresolvedFlows) && unresolvedFlows >= 0 ? unresolvedFlows : 0,
  };
}

function createEmptyGraph(trafficLayer = TRAFFIC_LAYERS.l4) {
  return { nodes: [], links: [], trafficLayer, podSummary: null };
}

function createInitialModeState(trafficLayer = TRAFFIC_LAYERS.l4) {
  return {
    graphData: createEmptyGraph(trafficLayer),
    connected: false,
    refreshing: false,
    truncation: null,
    layoutMode: LAYOUT_MODES.default,
    nodeGroupBoxes: [],
    k8sNodes: [],
  };
}

function prepareModeStateForStreamRefresh(modeState, trafficLayer = TRAFFIC_LAYERS.l4) {
  const currentModeState = modeState || createInitialModeState(trafficLayer);
  const graphData = currentModeState.graphData && typeof currentModeState.graphData === 'object'
    ? currentModeState.graphData
    : createEmptyGraph(trafficLayer);

  return {
    ...currentModeState,
    connected: false,
    refreshing: true,
    graphData,
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

function resolveTrafficLayer(trafficLayer) {
  return trafficLayer === TRAFFIC_LAYERS.l7 ? TRAFFIC_LAYERS.l7 : TRAFFIC_LAYERS.l4;
}

function buildFlowStreamPath(namespace, viewMode, trafficLayer) {
  const search = new URLSearchParams();
  search.set('view', resolveViewMode(viewMode));
  search.set('layer', resolveTrafficLayer(trafficLayer));
  if (namespace) {
    search.set('namespace', namespace);
  }
  return `/api/flows?${search.toString()}`;
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

function stableNodePosition(node) {
  const targetX = Number(node?.layoutTargetX);
  const targetY = Number(node?.layoutTargetY);
  if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
    return { x: targetX, y: targetY };
  }

  const x = Number(node?.x);
  const y = Number(node?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }

  return null;
}

function snapshotTransitionPositions(nodes) {
  const positions = new Map();
  if (!Array.isArray(nodes)) {
    return positions;
  }

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      continue;
    }
    const position = stableNodePosition(node);
    if (!position) {
      continue;
    }
    positions.set(node.id, {
      x: position.x,
      y: position.y,
      k8sNode: normalizeK8sNodeKey(node?.k8sNode),
    });
  }

  return positions;
}

function buildPositionSeedMap(incomingNodes, persistedPositions, transitionPositions = null) {
  const positions = new Map();

  if (persistedPositions instanceof Map) {
    for (const [id, position] of persistedPositions.entries()) {
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        continue;
      }
      positions.set(id, { x: position.x, y: position.y });
    }
  }

  if (!(transitionPositions instanceof Map) || !Array.isArray(incomingNodes)) {
    return positions;
  }

  for (const node of incomingNodes) {
    if (!node || typeof node.id !== 'string' || node.id.length === 0 || positions.has(node.id)) {
      continue;
    }
    const transitionPosition = transitionPositions.get(node.id);
    if (!transitionPosition) {
      continue;
    }
    if (!Number.isFinite(transitionPosition.x) || !Number.isFinite(transitionPosition.y)) {
      continue;
    }
    if (transitionPosition.k8sNode !== normalizeK8sNodeKey(node?.k8sNode)) {
      continue;
    }

    positions.set(node.id, {
      x: transitionPosition.x,
      y: transitionPosition.y,
    });
  }

  return positions;
}

function snapshotModeTransitionPositions(modeStateByMode) {
  return {
    [VIEW_MODES.service]: snapshotTransitionPositions(modeStateByMode?.[VIEW_MODES.service]?.graphData?.nodes),
    [VIEW_MODES.pod]: snapshotTransitionPositions(modeStateByMode?.[VIEW_MODES.pod]?.graphData?.nodes),
  };
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

function applyGroupedLayoutTargetsInPlace(nodes) {
  if (!Array.isArray(nodes)) {
    return nodes;
  }

  const targetNodes = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const pos = groupedPositionForNode(node);
    targetNodes.push({
      id: node.id,
      x: pos.x,
      y: pos.y,
    });
  }

  resolveLayoutOverlapsInPlace(targetNodes);

  const targetById = new Map();
  for (const target of targetNodes) {
    targetById.set(target.id, target);
  }

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const target = targetById.get(node.id);
    if (!target) {
      continue;
    }

    node.layoutTargetX = target.x;
    node.layoutTargetY = target.y;

    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      setNodeFixedPosition(node, target.x, target.y);
      continue;
    }

    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
  }

  return nodes;
}

function applyNodeGroupedLayoutInPlace(nodes, pinnedPositions = null, immobileNodeIds = null, knownNodeKeys = []) {
  if (!Array.isArray(nodes)) {
    return [];
  }

  const plan = buildNodeGroupLayoutPlan(nodes, knownNodeKeys);
  const boxesByKey = nodeGroupBoxMap(plan.boxes);
  const nodesById = new Map();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    nodesById.set(node.id, node);
  }
  const targetNodes = [];
  const pinnedNodeIds = new Set();
  for (const [id, target] of plan.targetsByID.entries()) {
    let x = target.x;
    let y = target.y;

    if (pinnedPositions instanceof Map) {
      const pinned = pinnedPositions.get(id);
      if (pinned && Number.isFinite(pinned.x) && Number.isFinite(pinned.y)) {
        const node = nodesById.get(id) || { id };
        const clampedPinned = clampPointToGroupBox(boxesByKey, node, pinned.x, pinned.y);
        x = clampedPinned.x;
        y = clampedPinned.y;
        pinnedNodeIds.add(id);
      }
    }

    targetNodes.push({ id, x, y });
  }
  const immobile = new Set(immobileNodeIds || []);
  for (const id of pinnedNodeIds) {
    immobile.add(id);
  }

  resolveLayoutOverlapsInPlace(targetNodes, immobile.size > 0 ? immobile : null);
  const targetById = new Map();
  for (const target of targetNodes) {
    targetById.set(target.id, target);
  }

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') {
      continue;
    }
    const target = targetById.get(node.id);
    if (!target) {
      continue;
    }
    const clampedTarget = clampPointToGroupBox(boxesByKey, node, target.x, target.y);
    node.layoutTargetX = clampedTarget.x;
    node.layoutTargetY = clampedTarget.y;

    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      setNodeFixedPosition(node, clampedTarget.x, clampedTarget.y);
      continue;
    }
    node.fx = node.x;
    node.fy = node.y;
    node.vx = 0;
    node.vy = 0;
  }
  return plan.boxes;
}

function buildDefaultLayoutModeState(currentModeState) {
  const graphData = currentModeState.graphData;

  if (graphData.nodes.length === 0) {
    return {
      ...currentModeState,
      layoutMode: LAYOUT_MODES.default,
      nodeGroupBoxes: [],
    };
  }

  applyGroupedLayoutTargetsInPlace(graphData.nodes);

  return {
    ...currentModeState,
    layoutMode: LAYOUT_MODES.default,
    nodeGroupBoxes: [],
    graphData: {
      ...graphData,
      nodes: [...graphData.nodes],
      links: [...graphData.links],
    },
  };
}

function updateExistingNode(existingNode, nodePatch, pinnedPosition, isDragging) {
  existingNode.label = nodePatch.label;
  existingNode.namespace = nodePatch.namespace;
  existingNode.k8sNode = nodePatch.k8sNode;
  existingNode.kind = nodePatch.kind;
  existingNode.lifecycle = nodePatch.lifecycle;
  existingNode.traffic = nodePatch.traffic;

  if (isDragging && Number.isFinite(existingNode.x) && Number.isFinite(existingNode.y)) {
    setNodeFixedPosition(existingNode, existingNode.x, existingNode.y);
    return;
  }

  // Preserve current in-memory coordinates to avoid snapping when overlap animation is in progress.
  if (Number.isFinite(existingNode.x) && Number.isFinite(existingNode.y)) {
    setNodeFixedPosition(existingNode, existingNode.x, existingNode.y);
    return;
  }

  if (pinnedPosition) {
    setNodeFixedPosition(existingNode, pinnedPosition.x, pinnedPosition.y);
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
    existingLink.l7 = cloneL7Details(patch.l7);
    nextLinks.push(existingLink);
    incomingLinkByKey.delete(key);
  }

  for (const patch of incomingLinkByKey.values()) {
    nextLinks.push({
      ...patch,
      protocolMix: cloneProtocolMix(patch.protocolMix),
      l7: cloneL7Details(patch.l7),
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

  return {
    nodes: nextNodes,
    links: nextLinks,
    trafficLayer: resolveTrafficLayer(incomingGraph?.trafficLayer),
    podSummary: clonePodSummary(incomingGraph?.podSummary),
  };
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

export function useFlowStream(
  namespace,
  activeViewMode = VIEW_MODES.service,
  activeTrafficLayer = TRAFFIC_LAYERS.l4,
) {
  const resolvedActiveMode = resolveViewMode(activeViewMode);
  const resolvedActiveLayer = resolveTrafficLayer(activeTrafficLayer);
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
  const modeTransitionPositionsRef = useRef(snapshotModeTransitionPositions());
  const activeModeRef = useRef(resolvedActiveMode);

  useEffect(() => {
    activeModeRef.current = resolvedActiveMode;
  }, [resolvedActiveMode]);

  const trackNodePosition = useCallback((nodeId, x, y) => {
    if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    const mode = activeModeRef.current;
    draggingNodeIdsRef.current[mode].add(nodeId);
    nodePositionsRef.current[mode].set(nodeId, { x, y });
  }, []);

  const persistNodePosition = useCallback((nodeId, x, y) => {
    const mode = activeModeRef.current;
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
      const virtualNodes = graphData.nodes.map((candidate) => ({
        id: candidate?.id,
        traffic: candidate?.traffic,
        x: candidate?.id === nodeId ? x : candidate?.x,
        y: candidate?.id === nodeId ? y : candidate?.y,
      }));
      let resolved = resolveDraggedNodeOverlap(virtualNodes, nodeId) || { x, y };
      if (currentModeState.layoutMode === LAYOUT_MODES.k8sNode) {
        const boxesByKey = nodeGroupBoxMap(currentModeState.nodeGroupBoxes);
        resolved = clampPointToGroupBox(boxesByKey, node, resolved.x, resolved.y);
      }
      node.layoutTargetX = resolved.x;
      node.layoutTargetY = resolved.y;
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
  }, []);

  const resetLayout = useCallback(() => {
    const mode = resolvedActiveMode;
    draggingNodeIdsRef.current[mode].clear();
    nodePositionsRef.current[mode].clear();
    clearPositionsFromStorage(mode);

    setModeState((prev) => {
      const currentModeState = prev[mode];
      const graphData = currentModeState.graphData;
      const isNodeGroupedPodLayout = mode === VIEW_MODES.pod && currentModeState.layoutMode === LAYOUT_MODES.k8sNode;

      if (graphData.nodes.length === 0) {
        return {
          ...prev,
          [mode]: {
            ...currentModeState,
            layoutMode: isNodeGroupedPodLayout ? LAYOUT_MODES.k8sNode : LAYOUT_MODES.default,
            nodeGroupBoxes: isNodeGroupedPodLayout ? currentModeState.nodeGroupBoxes : [],
          },
        };
      }

      if (isNodeGroupedPodLayout) {
        const knownNodeKeys = normalizeKnownK8sNodes(
          currentModeState.k8sNodes,
          collectKnownK8sNodesFromGraph(graphData.nodes),
        );
        const nodeGroupBoxes = applyNodeGroupedLayoutInPlace(
          graphData.nodes,
          nodePositionsRef.current[mode],
          draggingNodeIdsRef.current[mode],
          knownNodeKeys,
        );

        return {
          ...prev,
          [mode]: {
            ...currentModeState,
            layoutMode: LAYOUT_MODES.k8sNode,
            nodeGroupBoxes,
            graphData: {
              ...graphData,
              nodes: [...graphData.nodes],
              links: [...graphData.links],
            },
          },
        };
      }

      return {
        ...prev,
        [mode]: buildDefaultLayoutModeState(currentModeState),
      };
    });
  }, [resolvedActiveMode]);

  const showPodsUngrouped = useCallback(() => {
    const mode = VIEW_MODES.pod;
    draggingNodeIdsRef.current[mode].clear();
    nodePositionsRef.current[mode].clear();
    clearPositionsFromStorage(mode);

    setModeState((prev) => {
      const currentModeState = prev[mode];
      return {
        ...prev,
        [mode]: buildDefaultLayoutModeState(currentModeState),
      };
    });
  }, []);

  const groupByK8sNode = useCallback(() => {
    const mode = VIEW_MODES.pod;

    draggingNodeIdsRef.current[mode].clear();
    nodePositionsRef.current[mode].clear();
    clearPositionsFromStorage(mode);

    setModeState((prev) => {
      const currentModeState = prev[mode];
      const graphData = currentModeState.graphData;
      const knownNodeKeys = normalizeKnownK8sNodes(
        currentModeState.k8sNodes,
        collectKnownK8sNodesFromGraph(graphData.nodes),
      );
      const nodeGroupBoxes = applyNodeGroupedLayoutInPlace(
        graphData.nodes,
        nodePositionsRef.current[mode],
        draggingNodeIdsRef.current[mode],
        knownNodeKeys,
      );

      return {
        ...prev,
        [mode]: {
          ...currentModeState,
          layoutMode: LAYOUT_MODES.k8sNode,
          nodeGroupBoxes,
          graphData: {
            ...graphData,
            nodes: [...graphData.nodes],
            links: [...graphData.links],
          },
        },
      };
    });
  }, []);

  useEffect(() => {
    for (const mode of MODES) {
      const source = sourcesRef.current[mode];
      if (source) {
        source.close();
        sourcesRef.current[mode] = null;
      }
    }

    setModeState((prev) => {
      modeTransitionPositionsRef.current = snapshotModeTransitionPositions(prev);

      let next = prev;
      for (const mode of MODES) {
        const currentModeState = next[mode] || createInitialModeState(resolvedActiveLayer);
        next = {
          ...next,
          [mode]: prepareModeStateForStreamRefresh(currentModeState, resolvedActiveLayer),
        };
      }
      return next;
    });

    for (const mode of MODES) {
      const source = new EventSource(buildFlowStreamPath(namespace, mode, resolvedActiveLayer));
      sourcesRef.current[mode] = source;

      source.onopen = () => {
        setModeState((prev) => updateModeConnected(prev, mode, true));
      };

      source.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data);
          setModeState((prev) => {
            const currentModeState = prev[mode];
            const incomingNodes = Array.isArray(incoming?.nodes) ? incoming.nodes : [];
            const transitionPositions = modeTransitionPositionsRef.current[mode];
            const positionSeedMap = buildPositionSeedMap(
              incomingNodes,
              nodePositionsRef.current[mode],
              transitionPositions,
            );
            const graphData = mergeGraphUpdate(
              currentModeState.graphData,
              incoming,
              positionSeedMap,
              draggingNodeIdsRef.current[mode],
            );
            const k8sNodes = mode === VIEW_MODES.pod
              ? normalizeKnownK8sNodes(
                incoming?.k8sNodes,
                collectKnownK8sNodesFromGraph(graphData.nodes),
              )
              : currentModeState.k8sNodes;
            let nodeGroupBoxes = currentModeState.nodeGroupBoxes;
            if (mode === VIEW_MODES.pod && currentModeState.layoutMode === LAYOUT_MODES.k8sNode) {
              nodeGroupBoxes = applyNodeGroupedLayoutInPlace(
                graphData.nodes,
                positionSeedMap,
                draggingNodeIdsRef.current[mode],
                k8sNodes,
              );
            }
            if (transitionPositions) {
              modeTransitionPositionsRef.current[mode] = null;
            }

            return {
              ...prev,
              [mode]: {
                ...currentModeState,
                connected: true,
                refreshing: false,
                graphData: {
                  ...graphData,
                },
                truncation: normalizeTruncation(incoming?.truncation),
                nodeGroupBoxes,
                k8sNodes,
              },
            };
          });
        } catch {
          // Ignore malformed messages
        }
      };

      source.onerror = () => {
        setModeState((prev) => {
          const currentModeState = prev[mode];
          if (!currentModeState) {
            return prev;
          }
          if (!currentModeState.connected && !currentModeState.refreshing) {
            return prev;
          }
          return {
            ...prev,
            [mode]: {
              ...currentModeState,
              connected: false,
              refreshing: false,
            },
          };
        });
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
  }, [namespace, resolvedActiveLayer]);

  const activeModeState = modeState[resolvedActiveMode] || createInitialModeState(resolvedActiveLayer);
  return {
    graphData: activeModeState.graphData,
    trafficLayer: activeModeState.graphData.trafficLayer || resolvedActiveLayer,
    connected: activeModeState.connected,
    refreshing: activeModeState.refreshing,
    truncation: activeModeState.truncation,
    layoutMode: activeModeState.layoutMode,
    nodeGroupBoxes: activeModeState.nodeGroupBoxes,
    trackNodePosition,
    persistNodePosition,
    resetLayout,
    groupByK8sNode,
    showPodsUngrouped,
  };
}

export const __TEST_ONLY__ = {
  TRAFFIC_LAYERS,
  buildFlowStreamPath,
  nodeRadius,
  setNodeFixedPosition,
  resolveDraggedNodeOverlap,
  mergeGraphUpdate,
  applyGroupedLayoutInPlace,
  applyGroupedLayoutTargetsInPlace,
  applyNodeGroupedLayoutInPlace,
  buildDefaultLayoutModeState,
  normalizeK8sNodeKey,
  stableNodePosition,
  snapshotTransitionPositions,
  snapshotModeTransitionPositions,
  buildPositionSeedMap,
  prepareModeStateForStreamRefresh,
};
