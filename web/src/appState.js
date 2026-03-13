export const SCENES = Object.freeze({
  service: 'service',
  pod: 'pod',
  podNode: 'podNode',
});

export const VIEW_MODES = Object.freeze({
  service: 'service',
  pod: 'pod',
});

export const TRAFFIC_LAYERS = Object.freeze({
  l4: 'l4',
  l7: 'l7',
});

export function resolveScene(scene) {
  if (scene === SCENES.podNode) {
    return SCENES.podNode;
  }
  if (scene === SCENES.pod) {
    return SCENES.pod;
  }
  return SCENES.service;
}

export function resolveTrafficLayer(layer) {
  return layer === TRAFFIC_LAYERS.l7 ? TRAFFIC_LAYERS.l7 : TRAFFIC_LAYERS.l4;
}

export function sceneToViewMode(scene) {
  return resolveScene(scene) === SCENES.service ? VIEW_MODES.service : VIEW_MODES.pod;
}

export function isSceneViewportFitReady(scene, layoutMode, refreshing = false) {
  if (refreshing) {
    return false;
  }

  const resolvedScene = resolveScene(scene);
  if (resolvedScene === SCENES.podNode) {
    return layoutMode === 'k8sNode';
  }
  if (resolvedScene === SCENES.pod) {
    return layoutMode !== 'k8sNode';
  }
  return true;
}

export function createGraphUiState(initialTrafficLayer = TRAFFIC_LAYERS.l4) {
  return {
    namespace: '',
    scene: SCENES.service,
    trafficLayer: resolveTrafficLayer(initialTrafficLayer),
    selectedLinkKey: null,
    structuralTransitionRevision: 0,
  };
}

function applySceneChange(state, scene) {
  const nextScene = resolveScene(scene);
  if (state.scene === nextScene) {
    return state;
  }
  return {
    ...state,
    scene: nextScene,
    selectedLinkKey: null,
    structuralTransitionRevision: state.structuralTransitionRevision + 1,
  };
}

export function graphUiReducer(state, action) {
  switch (action?.type) {
    case 'selectLink':
      return {
        ...state,
        selectedLinkKey: action.linkKey || null,
      };

    case 'closePanel':
      if (!state.selectedLinkKey) {
        return state;
      }
      return {
        ...state,
        selectedLinkKey: null,
      };

    case 'setScene':
      return applySceneChange(state, action.scene);

    case 'setTrafficLayer': {
      const trafficLayer = resolveTrafficLayer(action.layer);
      if (state.trafficLayer === trafficLayer) {
        return state;
      }
      return {
        ...state,
        trafficLayer,
      };
    }

    case 'setNamespace': {
      const namespace = typeof action.namespace === 'string' ? action.namespace : '';
      if (state.namespace === namespace) {
        return state;
      }
      return {
        ...state,
        namespace,
      };
    }

    default:
      return state;
  }
}

export function buildStructuralTransitionKey(scene, revision) {
  return `${resolveScene(scene)}:${Math.max(0, Number(revision) || 0)}`;
}
