import test from 'node:test';
import assert from 'node:assert/strict';

import { __TEST_ONLY__ } from '../src/hooks/useFlowStream.js';

const {
  nodeRadius,
  setNodeFixedPosition,
  resolveDraggedNodeOverlap,
  mergeGraphUpdate,
  applyGroupedLayoutInPlace,
} = __TEST_ONLY__;

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
    nodes: [{ id: 'demo/productpage', label: 'productpage', namespace: 'demo', traffic: 11 }],
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
