import test from 'node:test';
import assert from 'node:assert/strict';

import { __TEST_ONLY__ } from '../src/hooks/useFlowStream.js';

const {
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
  stableNodePosition,
  snapshotTransitionPositions,
  snapshotModeTransitionPositions,
  buildPositionSeedMap,
  prepareModeStateForStreamRefresh,
} = __TEST_ONLY__;

test('buildFlowStreamPath includes view namespace and traffic layer', () => {
  assert.equal(
    buildFlowStreamPath('demo', 'pod', TRAFFIC_LAYERS.l7),
    '/api/flows?view=pod&layer=l7&namespace=demo',
  );
  assert.equal(
    buildFlowStreamPath('', 'service', 'bogus'),
    '/api/flows?view=service&layer=l4',
  );
});

test('setNodeFixedPosition pins node and clears velocity', () => {
  const node = { id: 'n1', x: 4, y: 9, vx: 10, vy: -6 };

  setNodeFixedPosition(node, 120, -44);

  assert.equal(node.x, 120);
  assert.equal(node.y, -44);
  assert.equal(node.fx, 120);
  assert.equal(node.fy, -44);
  assert.equal(node.vx, 0);
  assert.equal(node.vy, 0);
});

test('nodeRadius is fixed regardless of traffic', () => {
  const low = nodeRadius({ traffic: 1 });
  const high = nodeRadius({ traffic: 5000 });

  assert.equal(low, high);
  assert.equal(low, 10);
});

test('stableNodePosition prefers layout targets over current coordinates', () => {
  assert.deepEqual(
    stableNodePosition({ x: 120, y: -40, layoutTargetX: 8, layoutTargetY: 16 }),
    { x: 8, y: 16 },
  );
  assert.deepEqual(
    stableNodePosition({ x: 120, y: -40 }),
    { x: 120, y: -40 },
  );
  assert.equal(stableNodePosition({ x: 120 }), null);
});

test('snapshotTransitionPositions captures stable grouped positions with node identity', () => {
  const positions = snapshotTransitionPositions([
    {
      id: 'demo/reviews-0',
      x: 300,
      y: 180,
      layoutTargetX: -24,
      layoutTargetY: 44,
      k8sNode: 'worker-a',
    },
    {
      id: 'demo/reviews-1',
      x: 12,
      y: -8,
    },
  ]);

  assert.deepEqual(positions.get('demo/reviews-0'), {
    x: -24,
    y: 44,
    k8sNode: 'worker-a',
  });
  assert.deepEqual(positions.get('demo/reviews-1'), {
    x: 12,
    y: -8,
    k8sNode: 'unknown',
  });
});

test('buildPositionSeedMap reuses layer-transition positions only for same-node pods', () => {
  const persisted = new Map([
    ['demo/details-0', { x: 400, y: -220 }],
  ]);
  const carryover = new Map([
    ['demo/reviews-0', { x: 18, y: 32, k8sNode: 'worker-a' }],
    ['demo/reviews-1', { x: 90, y: 120, k8sNode: 'worker-a' }],
  ]);

  const seeds = buildPositionSeedMap(
    [
      { id: 'demo/details-0', k8sNode: 'worker-z' },
      { id: 'demo/reviews-0', k8sNode: 'worker-a' },
      { id: 'demo/reviews-1', k8sNode: 'worker-b' },
      { id: 'demo/new-0', k8sNode: 'worker-a' },
    ],
    persisted,
    carryover,
  );

  assert.deepEqual(seeds.get('demo/details-0'), { x: 400, y: -220 });
  assert.deepEqual(seeds.get('demo/reviews-0'), { x: 18, y: 32 });
  assert.equal(seeds.has('demo/reviews-1'), false);
  assert.equal(seeds.has('demo/new-0'), false);
});

test('snapshotModeTransitionPositions captures current positions for each mode', () => {
  const snapshots = snapshotModeTransitionPositions({
    service: {
      graphData: {
        nodes: [
          { id: 'default/frontend', x: 42, y: -18 },
        ],
      },
    },
    pod: {
      graphData: {
        nodes: [
          {
            id: 'demo/reviews-0',
            x: 100,
            y: 120,
            layoutTargetX: -12,
            layoutTargetY: 28,
            k8sNode: 'worker-a',
          },
        ],
      },
    },
  });

  assert.deepEqual(snapshots.service.get('default/frontend'), {
    x: 42,
    y: -18,
    k8sNode: 'unknown',
  });
  assert.deepEqual(snapshots.pod.get('demo/reviews-0'), {
    x: -12,
    y: 28,
    k8sNode: 'worker-a',
  });
});

test('applyNodeGroupedLayoutInPlace preserves carried positions for surviving nodes after refresh', () => {
  const initialNodes = [
    { id: 'demo/reviews-0', label: 'reviews-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 3 },
    { id: 'demo/reviews-1', label: 'reviews-1', namespace: 'demo', k8sNode: 'worker-a', traffic: 3 },
    { id: 'demo/details-0', label: 'details-0', namespace: 'demo', k8sNode: 'worker-b', traffic: 3 },
  ];

  applyNodeGroupedLayoutInPlace(initialNodes, null, null, ['worker-a', 'worker-b']);
  const carryover = snapshotTransitionPositions(initialNodes);

  const nextNodes = initialNodes
    .filter((node) => node.id !== 'demo/reviews-1')
    .map((node) => ({ ...node }));
  const seeds = buildPositionSeedMap(nextNodes, new Map(), carryover);

  applyNodeGroupedLayoutInPlace(nextNodes, seeds, null, ['worker-a', 'worker-b']);

  for (const node of nextNodes) {
    const carried = carryover.get(node.id);
    assert.ok(carried);
    assert.ok(Math.abs(node.layoutTargetX - carried.x) < 0.001);
    assert.ok(Math.abs(node.layoutTargetY - carried.y) < 0.001);
  }
});

test('buildDefaultLayoutModeState clears worker node boxes for plain pod layout', () => {
  const modeState = {
    layoutMode: 'k8sNode',
    nodeGroupBoxes: [{ key: 'worker-a', minX: -10, maxX: 10, minY: -10, maxY: 10 }],
    graphData: {
      nodes: [
        {
          id: 'demo/reviews-0',
          label: 'reviews-0',
          namespace: 'demo',
          k8sNode: 'worker-a',
          traffic: 3,
          x: 120,
          y: 60,
          layoutTargetX: 120,
          layoutTargetY: 60,
        },
      ],
      links: [],
    },
  };

  const next = buildDefaultLayoutModeState(modeState);

  assert.equal(next.layoutMode, 'default');
  assert.deepEqual(next.nodeGroupBoxes, []);
  assert.equal(next.graphData.nodes.length, 1);
  assert.ok(Number.isFinite(next.graphData.nodes[0].layoutTargetX));
  assert.ok(Number.isFinite(next.graphData.nodes[0].layoutTargetY));
});

test('prepareModeStateForStreamRefresh keeps graph and layout state while reconnecting', () => {
  const modeState = {
    connected: true,
    truncation: { reason: 'topN', limit: 10, totalNodes: 22, shownNodes: 10 },
    layoutMode: 'k8sNode',
    nodeGroupBoxes: [{ key: 'worker-a', minX: -10, maxX: 10, minY: -10, maxY: 10 }],
    k8sNodes: ['worker-a'],
    graphData: {
      nodes: [{ id: 'demo/productpage', x: 10, y: 20 }],
      links: [{ source: 'demo/productpage', target: 'world', flowRate: 1 }],
      trafficLayer: TRAFFIC_LAYERS.l4,
      podSummary: { liveNodes: 1, terminatedNodes: 0, unresolvedNodes: 0, unresolvedFlows: 0 },
    },
  };

  const next = prepareModeStateForStreamRefresh(modeState, TRAFFIC_LAYERS.l7);

  assert.equal(next.connected, false);
  assert.equal(next.refreshing, true);
  assert.equal(next.truncation, modeState.truncation);
  assert.equal(next.layoutMode, 'k8sNode');
  assert.equal(next.nodeGroupBoxes, modeState.nodeGroupBoxes);
  assert.equal(next.k8sNodes, modeState.k8sNodes);
  assert.equal(next.graphData.nodes, modeState.graphData.nodes);
  assert.equal(next.graphData.links, modeState.graphData.links);
  assert.equal(next.graphData.trafficLayer, TRAFFIC_LAYERS.l4);
});

test('mergeGraphUpdate preserves existing node position and pins it', () => {
  const existing = {
    id: 'demo/productpage',
    label: 'productpage',
    namespace: 'demo',
    traffic: 3,
    x: 32,
    y: -18,
  };

  const prev = { nodes: [existing], links: [] };
  const incoming = {
    nodes: [{ id: 'demo/productpage', label: 'productpage', namespace: 'demo', k8sNode: 'worker-a', traffic: 11 }],
    links: [],
  };

  const next = mergeGraphUpdate(prev, incoming, new Map(), new Set());

  assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0], existing);
  assert.equal(existing.x, 32);
  assert.equal(existing.y, -18);
  assert.equal(existing.fx, 32);
  assert.equal(existing.fy, -18);
  assert.equal(existing.vx, 0);
  assert.equal(existing.vy, 0);
  assert.equal(existing.traffic, 11);
  assert.equal(existing.k8sNode, 'worker-a');
});

test('mergeGraphUpdate keeps in-memory position when a stored pinned fallback exists', () => {
  const existing = {
    id: 'demo/details',
    label: 'details',
    namespace: 'demo',
    traffic: 5,
    x: 96,
    y: -42,
    fx: 96,
    fy: -42,
    vx: 0,
    vy: 0,
  };

  const prev = { nodes: [existing], links: [] };
  const incoming = {
    nodes: [{ id: existing.id, label: existing.label, namespace: existing.namespace, traffic: 9 }],
    links: [],
  };
  const pinnedFallbacks = new Map([[existing.id, { x: 0, y: 0 }]]);

  const next = mergeGraphUpdate(prev, incoming, pinnedFallbacks, new Set());

  assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0], existing);
  assert.equal(existing.x, 96);
  assert.equal(existing.y, -42);
  assert.equal(existing.layoutTargetX, 96);
  assert.equal(existing.layoutTargetY, -42);
});

test('mergeGraphUpdate updates live link metrics in place', () => {
  const incomingMix = { TCP: 2, UDP: 8 };
  const link = {
    source: 'default/frontend',
    target: 'default/api',
    flowRate: 0.5,
    flowCount: 2,
    successRate: 1,
    protocol: 'TCP',
    protocolMix: { TCP: 2 },
    verdict: 'FORWARDED',
  };

  const prev = { nodes: [], links: [link] };
  const incoming = {
    nodes: [],
    links: [{
      source: 'default/frontend',
      target: 'default/api',
      flowRate: 2.5,
      flowCount: 10,
      successRate: 0.7,
      protocol: 'UDP',
      protocolMix: incomingMix,
      verdict: 'DROPPED',
    }],
  };

  const next = mergeGraphUpdate(prev, incoming, new Map(), new Set());

  assert.equal(next.links.length, 1);
  assert.equal(next.links[0], link);
  assert.equal(link.flowRate, 2.5);
  assert.equal(link.flowCount, 10);
  assert.equal(link.successRate, 0.7);
  assert.equal(link.protocol, 'UDP');
  assert.deepEqual(link.protocolMix, incomingMix);
  assert.notEqual(link.protocolMix, incomingMix);
  assert.equal(link.verdict, 'DROPPED');
});

test('mergeGraphUpdate refreshes nested l7 metrics in place', () => {
  const link = {
    source: 'default/frontend',
    target: 'default/api',
    flowRate: 1.2,
    flowCount: 4,
    successRate: 1,
    protocol: 'HTTP',
    protocolMix: { HTTP: 4 },
    verdict: 'FORWARDED',
    l7: {
      requestCount: 2,
      responseCount: 2,
      http: {
        statusClassMix: { '2xx': 2 },
        methodMix: { GET: 2 },
        p50LatencyMs: 12,
        p95LatencyMs: 22,
      },
    },
  };

  const prev = { nodes: [], links: [link] };
  const incoming = {
    nodes: [],
    links: [{
      source: 'default/frontend',
      target: 'default/api',
      flowRate: 2.8,
      flowCount: 8,
      successRate: 0.75,
      protocol: 'HTTP',
      protocolMix: { HTTP: 6, DNS: 2 },
      verdict: 'FORWARDED',
      l7: {
        requestCount: 4,
        responseCount: 4,
        http: {
          statusClassMix: { '2xx': 3, '5xx': 1 },
          methodMix: { GET: 3, POST: 1 },
          p50LatencyMs: 18,
          p95LatencyMs: 80,
        },
      },
    }],
  };

  const next = mergeGraphUpdate(prev, incoming, new Map(), new Set());

  assert.equal(next.links[0], link);
  assert.equal(link.l7.requestCount, 4);
  assert.equal(link.l7.responseCount, 4);
  assert.deepEqual(link.l7.http.statusClassMix, { '2xx': 3, '5xx': 1 });
  assert.deepEqual(link.l7.http.methodMix, { GET: 3, POST: 1 });
  assert.equal(link.l7.http.p50LatencyMs, 18);
  assert.equal(link.l7.http.p95LatencyMs, 80);
});

test('mergeGraphUpdate computes separated layout targets during live updates', () => {
  const left = {
    id: 'demo/reviews-0',
    label: 'reviews-0',
    namespace: 'demo',
    traffic: 2,
    x: 0,
    y: 0,
    fx: 0,
    fy: 0,
    vx: 0,
    vy: 0,
  };
  const right = {
    id: 'demo/reviews-1',
    label: 'reviews-1',
    namespace: 'demo',
    traffic: 2,
    x: 0,
    y: 0,
    fx: 0,
    fy: 0,
    vx: 0,
    vy: 0,
  };

  const prev = {
    nodes: [left, right],
    links: [],
  };
  const incoming = {
    nodes: [
      { id: left.id, label: left.label, namespace: left.namespace, traffic: 3 },
      { id: right.id, label: right.label, namespace: right.namespace, traffic: 3 },
    ],
    links: [],
  };

  const next = mergeGraphUpdate(prev, incoming, new Map(), new Set());
  assert.equal(next.nodes.length, 2);
  const minDistance = nodeRadius(left) + nodeRadius(right) + 8;
  const targetDistance = Math.hypot(
    left.layoutTargetX - right.layoutTargetX,
    left.layoutTargetY - right.layoutTargetY,
  );

  assert.ok(targetDistance >= minDistance - 0.15);
  assert.equal(left.x, 0);
  assert.equal(left.y, 0);
  assert.equal(right.x, 0);
  assert.equal(right.y, 0);
});

test('resolveDraggedNodeOverlap nudges dragged node away without moving neighbors', () => {
  const neighbor = { id: 'demo/reviews', traffic: 100, x: 0, y: 0, fx: 0, fy: 0, vx: 0, vy: 0 };
  const dragged = { id: 'demo/details', traffic: 100, x: 0, y: 0, fx: 0, fy: 0, vx: 0, vy: 0 };
  const nodes = [dragged, neighbor];

  const result = resolveDraggedNodeOverlap(nodes, dragged.id);

  assert.ok(result);
  const minDistance = nodeRadius(dragged) + nodeRadius(neighbor) + 8;
  const distance = Math.hypot(dragged.x - neighbor.x, dragged.y - neighbor.y);

  assert.ok(distance >= minDistance - 0.15);
  assert.equal(neighbor.x, 0);
  assert.equal(neighbor.y, 0);
  assert.equal(dragged.fx, dragged.x);
  assert.equal(dragged.fy, dragged.y);
});

test('applyGroupedLayoutInPlace preserves node object identity for link references', () => {
  const sourceNode = {
    id: 'demo/reviews',
    label: 'reviews',
    namespace: 'demo',
    traffic: 25,
    x: 500,
    y: 500,
    fx: 500,
    fy: 500,
    vx: 2,
    vy: -1,
  };
  const targetNode = {
    id: 'demo/productpage',
    label: 'productpage',
    namespace: 'demo',
    traffic: 12,
    x: -500,
    y: -500,
    fx: -500,
    fy: -500,
    vx: -2,
    vy: 1,
  };
  const nodes = [sourceNode, targetNode];
  const link = { source: sourceNode, target: targetNode };

  const result = applyGroupedLayoutInPlace(nodes);

  assert.equal(result, nodes);
  assert.equal(result[0], sourceNode);
  assert.equal(result[1], targetNode);
  assert.equal(link.source, result[0]);
  assert.equal(link.target, result[1]);

  assert.equal(sourceNode.fx, sourceNode.x);
  assert.equal(sourceNode.fy, sourceNode.y);
  assert.equal(sourceNode.vx, 0);
  assert.equal(sourceNode.vy, 0);
  assert.equal(targetNode.fx, targetNode.x);
  assert.equal(targetNode.fy, targetNode.y);
  assert.equal(targetNode.vx, 0);
  assert.equal(targetNode.vy, 0);
});

test('applyGroupedLayoutTargetsInPlace preserves positioned nodes and updates targets', () => {
  const nodes = [
    {
      id: 'demo/reviews-0',
      label: 'reviews-0',
      namespace: 'demo',
      traffic: 25,
      x: 520,
      y: -240,
      fx: 520,
      fy: -240,
      vx: 0,
      vy: 0,
    },
    {
      id: 'demo/productpage-0',
      label: 'productpage-0',
      namespace: 'demo',
      traffic: 12,
      x: -460,
      y: 280,
      fx: -460,
      fy: 280,
      vx: 0,
      vy: 0,
    },
  ];

  const before = nodes.map((node) => ({
    id: node.id,
    x: node.x,
    y: node.y,
  }));

  const result = applyGroupedLayoutTargetsInPlace(nodes);
  assert.equal(result, nodes);

  for (const node of nodes) {
    const initial = before.find((entry) => entry.id === node.id);
    assert.equal(node.x, initial.x);
    assert.equal(node.y, initial.y);
    assert.equal(node.fx, initial.x);
    assert.equal(node.fy, initial.y);
    assert.equal(node.vx, 0);
    assert.equal(node.vy, 0);
    assert.ok(Number.isFinite(node.layoutTargetX));
    assert.ok(Number.isFinite(node.layoutTargetY));
  }
});

test('applyNodeGroupedLayoutInPlace clusters pods by Kubernetes node', () => {
  const nodes = [
    { id: 'demo/reviews-0', label: 'reviews-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 2 },
    { id: 'demo/reviews-1', label: 'reviews-1', namespace: 'demo', k8sNode: 'worker-a', traffic: 2 },
    { id: 'demo/api-0', label: 'api-0', namespace: 'demo', k8sNode: 'worker-b', traffic: 2 },
    { id: 'demo/api-1', label: 'api-1', namespace: 'demo', k8sNode: 'worker-b', traffic: 2 },
  ];

  const boxes = applyNodeGroupedLayoutInPlace(nodes);
  assert.equal(Array.isArray(boxes), true);
  assert.equal(boxes.length, 2);

  const workerA = nodes.filter((node) => node.k8sNode === 'worker-a');
  const workerB = nodes.filter((node) => node.k8sNode === 'worker-b');

  const centerA = {
    x: (workerA[0].x + workerA[1].x) / 2,
    y: (workerA[0].y + workerA[1].y) / 2,
  };
  const centerB = {
    x: (workerB[0].x + workerB[1].x) / 2,
    y: (workerB[0].y + workerB[1].y) / 2,
  };

  const betweenCenters = Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
  assert.ok(betweenCenters >= 200);

  const boxesByKey = new Map(boxes.map((box) => [box.key, box]));

  for (const node of nodes) {
    const box = boxesByKey.get(node.k8sNode);
    assert.ok(box);
    assert.ok(node.x >= box.innerMinX - 0.01 && node.x <= box.innerMaxX + 0.01);
    assert.ok(node.y >= box.innerMinY - 0.01 && node.y <= box.innerMaxY + 0.01);
    assert.equal(node.fx, node.x);
    assert.equal(node.fy, node.y);
    assert.equal(node.vx, 0);
    assert.equal(node.vy, 0);
  }
});

test('applyNodeGroupedLayoutInPlace includes empty boxes for known Kubernetes nodes', () => {
  const nodes = [
    { id: 'demo/reviews-0', label: 'reviews-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 2 },
  ];

  const boxes = applyNodeGroupedLayoutInPlace(
    nodes,
    null,
    null,
    ['worker-a', 'worker-b', 'worker-c', 'unknown'],
  );
  assert.equal(boxes.length, 3);

  const keys = boxes.map((box) => box.key).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(keys, ['worker-a', 'worker-b', 'worker-c']);
});

test('applyNodeGroupedLayoutInPlace leaves unresolved and external endpoints outside worker boxes', () => {
  const nodes = [
    { id: 'demo/reviews-0', label: 'reviews-0', namespace: 'demo', k8sNode: 'worker-a', kind: 'pod', traffic: 2 },
    { id: 'unresolved/demo/reviews', label: 'Unresolved reviews', namespace: 'demo', kind: 'unresolved', traffic: 1 },
    { id: 'external/world', label: 'world', namespace: '', kind: 'external', traffic: 1 },
  ];

  const boxes = applyNodeGroupedLayoutInPlace(nodes);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].key, 'worker-a');

  const workerBox = boxes[0];
  const unresolved = nodes.find((node) => node.id === 'unresolved/demo/reviews');
  const external = nodes.find((node) => node.id === 'external/world');

  assert.ok(unresolved);
  assert.ok(external);
  assert.ok(Number.isFinite(unresolved.layoutTargetX));
  assert.ok(Number.isFinite(unresolved.layoutTargetY));
  assert.ok(Number.isFinite(external.layoutTargetX));
  assert.ok(Number.isFinite(external.layoutTargetY));

  assert.equal(
    unresolved.layoutTargetX >= workerBox.minX && unresolved.layoutTargetX <= workerBox.maxX
      && unresolved.layoutTargetY >= workerBox.minY && unresolved.layoutTargetY <= workerBox.maxY,
    false,
  );
  assert.equal(
    external.layoutTargetX >= workerBox.minX && external.layoutTargetX <= workerBox.maxX
      && external.layoutTargetY >= workerBox.minY && external.layoutTargetY <= workerBox.maxY,
    false,
  );
});

test('applyNodeGroupedLayoutInPlace keeps worker node boxes on a circle', () => {
  const nodes = [
    { id: 'demo/a-0', label: 'a-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 1 },
    { id: 'demo/b-0', label: 'b-0', namespace: 'demo', k8sNode: 'worker-b', traffic: 1 },
    { id: 'demo/c-0', label: 'c-0', namespace: 'demo', k8sNode: 'worker-c', traffic: 1 },
    { id: 'demo/d-0', label: 'd-0', namespace: 'demo', k8sNode: 'worker-d', traffic: 1 },
  ];

  const boxes = applyNodeGroupedLayoutInPlace(nodes);
  assert.equal(boxes.length, 4);

  const radii = boxes.map((box) => Math.hypot(box.centerX, box.centerY));
  const minRadius = Math.min(...radii);
  const maxRadius = Math.max(...radii);
  assert.ok(maxRadius - minRadius < 0.01);
});

test('applyNodeGroupedLayoutInPlace keeps four-node spacing similar to five-node layout', () => {
  const four = [
    { id: 'demo/n-0', label: 'n-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 1 },
    { id: 'demo/n-1', label: 'n-1', namespace: 'demo', k8sNode: 'worker-b', traffic: 1 },
    { id: 'demo/n-2', label: 'n-2', namespace: 'demo', k8sNode: 'worker-c', traffic: 1 },
    { id: 'demo/n-3', label: 'n-3', namespace: 'demo', k8sNode: 'worker-d', traffic: 1 },
  ];
  const five = [
    { id: 'demo/m-0', label: 'm-0', namespace: 'demo', k8sNode: 'worker-a', traffic: 1 },
    { id: 'demo/m-1', label: 'm-1', namespace: 'demo', k8sNode: 'worker-b', traffic: 1 },
    { id: 'demo/m-2', label: 'm-2', namespace: 'demo', k8sNode: 'worker-c', traffic: 1 },
    { id: 'demo/m-3', label: 'm-3', namespace: 'demo', k8sNode: 'worker-d', traffic: 1 },
    { id: 'demo/m-4', label: 'm-4', namespace: 'demo', k8sNode: 'worker-e', traffic: 1 },
  ];

  const boxes4 = applyNodeGroupedLayoutInPlace(four);
  const boxes5 = applyNodeGroupedLayoutInPlace(five);
  const radius4 = Math.hypot(boxes4[0].centerX, boxes4[0].centerY);
  const radius5 = Math.hypot(boxes5[0].centerX, boxes5[0].centerY);

  assert.ok(Math.abs(radius4 - radius5) < 0.01);
});

test('applyNodeGroupedLayoutInPlace preserves positioned nodes and updates layout targets', () => {
  const nodes = [
    {
      id: 'demo/reviews-0',
      label: 'reviews-0',
      namespace: 'demo',
      k8sNode: 'worker-a',
      traffic: 2,
      x: 540,
      y: -320,
      fx: 540,
      fy: -320,
      vx: 0,
      vy: 0,
    },
    {
      id: 'demo/api-0',
      label: 'api-0',
      namespace: 'demo',
      k8sNode: 'worker-b',
      traffic: 2,
      x: -520,
      y: 300,
      fx: -520,
      fy: 300,
      vx: 0,
      vy: 0,
    },
  ];

  const before = nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }));
  const boxes = applyNodeGroupedLayoutInPlace(nodes);
  const boxesByKey = new Map(boxes.map((box) => [box.key, box]));

  for (const node of nodes) {
    const initial = before.find((entry) => entry.id === node.id);
    assert.equal(node.x, initial.x);
    assert.equal(node.y, initial.y);
    assert.equal(node.fx, initial.x);
    assert.equal(node.fy, initial.y);

    const box = boxesByKey.get(node.k8sNode);
    assert.ok(box);
    assert.ok(node.layoutTargetX >= box.innerMinX - 0.01 && node.layoutTargetX <= box.innerMaxX + 0.01);
    assert.ok(node.layoutTargetY >= box.innerMinY - 0.01 && node.layoutTargetY <= box.innerMaxY + 0.01);
  }
});

test('applyNodeGroupedLayoutInPlace honors pinned pod positions in node-group mode', () => {
  const nodes = [
    {
      id: 'demo/reviews-0',
      label: 'reviews-0',
      namespace: 'demo',
      k8sNode: 'worker-a',
      traffic: 2,
      x: 120,
      y: 80,
      fx: 120,
      fy: 80,
      vx: 0,
      vy: 0,
    },
    {
      id: 'demo/api-0',
      label: 'api-0',
      namespace: 'demo',
      k8sNode: 'worker-b',
      traffic: 2,
      x: -120,
      y: -80,
      fx: -120,
      fy: -80,
      vx: 0,
      vy: 0,
    },
  ];

  const pinned = new Map([
    [nodes[0].id, { x: 9999, y: 9999 }],
  ]);
  const boxes = applyNodeGroupedLayoutInPlace(nodes, pinned, new Set());
  const boxesByKey = new Map(boxes.map((box) => [box.key, box]));
  const workerABox = boxesByKey.get('worker-a');
  assert.ok(workerABox);

  const expectedX = Math.min(workerABox.innerMaxX, Math.max(workerABox.innerMinX, 9999));
  const expectedY = Math.min(workerABox.innerMaxY, Math.max(workerABox.innerMinY, 9999));

  assert.equal(nodes[0].layoutTargetX, expectedX);
  assert.equal(nodes[0].layoutTargetY, expectedY);
});
