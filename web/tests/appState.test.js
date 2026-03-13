import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStructuralTransitionKey,
  createGraphUiState,
  graphUiReducer,
  isSceneViewportFitReady,
  SCENES,
  sceneToViewMode,
  TRAFFIC_LAYERS,
  VIEW_MODES,
} from '../src/appState.js';

test('sceneToViewMode maps node-group scene back to pod mode', () => {
  assert.equal(sceneToViewMode(SCENES.service), VIEW_MODES.service);
  assert.equal(sceneToViewMode(SCENES.pod), VIEW_MODES.pod);
  assert.equal(sceneToViewMode(SCENES.podNode), VIEW_MODES.pod);
});

test('isSceneViewportFitReady waits for the active scene layout and refresh to settle', () => {
  assert.equal(isSceneViewportFitReady(SCENES.service, 'default', false), true);
  assert.equal(isSceneViewportFitReady(SCENES.pod, 'default', false), true);
  assert.equal(isSceneViewportFitReady(SCENES.pod, 'k8sNode', false), false);
  assert.equal(isSceneViewportFitReady(SCENES.podNode, 'default', false), false);
  assert.equal(isSceneViewportFitReady(SCENES.podNode, 'k8sNode', false), true);
  assert.equal(isSceneViewportFitReady(SCENES.podNode, 'k8sNode', true), false);
});

test('traffic layer changes do not advance the structural transition revision', () => {
  const initial = {
    ...createGraphUiState(TRAFFIC_LAYERS.l4),
    selectedLinkKey: 'default/frontend->default/api',
  };

  const next = graphUiReducer(initial, { type: 'setTrafficLayer', layer: TRAFFIC_LAYERS.l7 });

  assert.equal(next.trafficLayer, TRAFFIC_LAYERS.l7);
  assert.equal(next.structuralTransitionRevision, 0);
  assert.equal(next.selectedLinkKey, 'default/frontend->default/api');
  assert.equal(buildStructuralTransitionKey(next.scene, next.structuralTransitionRevision), 'service:0');
});

test('namespace changes do not advance the structural transition revision', () => {
  const initial = {
    ...createGraphUiState(TRAFFIC_LAYERS.l4),
    selectedLinkKey: 'default/frontend->default/api',
  };

  const next = graphUiReducer(initial, { type: 'setNamespace', namespace: 'demo' });

  assert.equal(next.namespace, 'demo');
  assert.equal(next.structuralTransitionRevision, 0);
  assert.equal(next.selectedLinkKey, 'default/frontend->default/api');
});

test('structural scene changes advance the transition revision', () => {
  const initial = createGraphUiState(TRAFFIC_LAYERS.l4);
  const pod = graphUiReducer(initial, { type: 'setScene', scene: SCENES.pod });
  const grouped = graphUiReducer(pod, { type: 'setScene', scene: SCENES.podNode });
  const service = graphUiReducer(grouped, { type: 'setScene', scene: SCENES.service });

  assert.equal(pod.scene, SCENES.pod);
  assert.equal(pod.structuralTransitionRevision, 1);
  assert.equal(grouped.scene, SCENES.podNode);
  assert.equal(grouped.structuralTransitionRevision, 2);
  assert.equal(service.scene, SCENES.service);
  assert.equal(service.structuralTransitionRevision, 3);
});

test('setting the current scene again preserves the structural scene', () => {
  const initial = {
    ...createGraphUiState(),
    scene: SCENES.podNode,
    structuralTransitionRevision: 2,
  };

  const next = graphUiReducer(initial, { type: 'setScene', scene: SCENES.podNode });

  assert.deepEqual(next, initial);
});

test('scene changes clear the selected link', () => {
  const initial = {
    ...createGraphUiState(),
    scene: SCENES.pod,
    selectedLinkKey: 'default/frontend->default/api',
    structuralTransitionRevision: 1,
  };

  const next = graphUiReducer(initial, { type: 'setScene', scene: SCENES.service });

  assert.equal(next.scene, SCENES.service);
  assert.equal(next.selectedLinkKey, null);
  assert.equal(next.structuralTransitionRevision, 2);
});
