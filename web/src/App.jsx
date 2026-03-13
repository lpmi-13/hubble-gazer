import React, { useState, useCallback, useMemo, useEffect, useReducer, useRef } from 'react';
import NetworkGraph from './components/NetworkGraph';
import FlowPanel from './components/FlowPanel';
import NamespaceSelector from './components/NamespaceSelector';
import { useFlowStream } from './hooks/useFlowStream';
import {
  buildStructuralTransitionKey,
  createGraphUiState,
  graphUiReducer,
  isSceneViewportFitReady,
  SCENES,
  sceneToViewMode,
  TRAFFIC_LAYERS,
  VIEW_MODES,
} from './appState';

const TRAFFIC_LAYER_STORAGE_KEY = 'hubble-gazer-traffic-layer:v1';
const CONNECTION_FEEDBACK_DELAY_MS = 180;
const CONNECTION_FEEDBACK_MIN_VISIBLE_MS = 180;
const SCENE_TRANSITION_DURATION_MS = 320;

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
  return `${getEndpointId(link.source)}->${getEndpointId(link.target)}`;
}

export default function App() {
  const [graphUiState, dispatchGraphUi] = useReducer(
    graphUiReducer,
    null,
    () => {
      try {
        const stored = window.localStorage.getItem(TRAFFIC_LAYER_STORAGE_KEY);
        return createGraphUiState(stored);
      } catch {
        return createGraphUiState();
      }
    },
  );
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [layoutToastVisible, setLayoutToastVisible] = useState(false);
  const [layoutToastKey, setLayoutToastKey] = useState(0);
  const [layoutToastMessage, setLayoutToastMessage] = useState('Layout reset');
  const [showRefreshFeedback, setShowRefreshFeedback] = useState(false);
  const [displayConnectionState, setDisplayConnectionState] = useState('disconnected');
  const [namespaceViewportFitRevision, setNamespaceViewportFitRevision] = useState(0);
  const [trafficLayerViewportFitRevision, setTrafficLayerViewportFitRevision] = useState(0);
  const [sceneTransitionActive, setSceneTransitionActive] = useState(false);
  const connectionFeedbackTimeoutRef = useRef(0);
  const reconnectShownAtRef = useRef(0);
  const previousNamespaceRef = useRef('');
  const previousRenderedTrafficLayerRef = useRef('');
  const pendingNamespaceViewportFitRef = useRef(false);
  const previousViewportResetKeyRef = useRef('');
  const sceneTransitionRafRef = useRef(0);
  const sceneTransitionTimeoutRef = useRef(0);
  const {
    namespace,
    scene,
    trafficLayer,
    selectedLinkKey,
    structuralTransitionRevision,
  } = graphUiState;
  const viewMode = sceneToViewMode(scene);
  const {
    graphData,
    trafficLayer: renderedTrafficLayer,
    connected,
    refreshing,
    truncation,
    layoutMode,
    nodeGroupBoxes,
    trackNodePosition,
    persistNodePosition,
    resetLayout,
    groupByK8sNode,
    showPodsUngrouped,
  } = useFlowStream(namespace, viewMode, trafficLayer);

  const handleLinkClick = useCallback((link) => {
    dispatchGraphUi({ type: 'selectLink', linkKey: getLinkKey(link) });
  }, []);

  const handleClosePanel = useCallback(() => {
    dispatchGraphUi({ type: 'closePanel' });
  }, []);

  const handleNodeDrag = useCallback((id, x, y) => {
    trackNodePosition(id, x, y);
  }, [trackNodePosition]);

  const handleNodePositionChange = useCallback((id, x, y) => {
    persistNodePosition(id, x, y);
  }, [persistNodePosition]);

  const handleSceneChange = useCallback((nextScene) => {
    dispatchGraphUi({ type: 'setScene', scene: nextScene });
  }, []);

  const handleTrafficLayerChange = useCallback((layer) => {
    dispatchGraphUi({ type: 'setTrafficLayer', layer });
  }, []);

  const handleNamespaceChange = useCallback((nextNamespace) => {
    dispatchGraphUi({ type: 'setNamespace', namespace: nextNamespace });
  }, []);

  const handleResetLayout = useCallback(() => {
    resetLayout();
    setLayoutToastMessage(scene === SCENES.podNode ? 'Grouped layout reset' : 'Layout reset');
    setLayoutToastVisible(true);
    setLayoutToastKey((prev) => prev + 1);
  }, [resetLayout, scene]);

  const handleMainInteraction = useCallback(() => {
    setMobileControlsOpen((prev) => (prev ? false : prev));
  }, []);

  useEffect(() => {
    if (!layoutToastVisible) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setLayoutToastVisible(false);
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [layoutToastVisible, layoutToastKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TRAFFIC_LAYER_STORAGE_KEY, trafficLayer);
    } catch {
      // Ignore storage errors.
    }
  }, [trafficLayer]);

  useEffect(() => {
    if (previousNamespaceRef.current === namespace) {
      return;
    }
    previousNamespaceRef.current = namespace;
    pendingNamespaceViewportFitRef.current = true;
  }, [namespace]);

  useEffect(() => {
    if (!previousRenderedTrafficLayerRef.current) {
      previousRenderedTrafficLayerRef.current = renderedTrafficLayer;
      return;
    }
    if (previousRenderedTrafficLayerRef.current === renderedTrafficLayer) {
      return;
    }
    previousRenderedTrafficLayerRef.current = renderedTrafficLayer;
    setTrafficLayerViewportFitRevision((prev) => prev + 1);
  }, [renderedTrafficLayer]);

  useEffect(() => {
    if (scene === SCENES.podNode && layoutMode !== 'k8sNode') {
      groupByK8sNode();
      return;
    }
    if (scene === SCENES.pod && layoutMode === 'k8sNode') {
      showPodsUngrouped();
    }
  }, [groupByK8sNode, layoutMode, scene, showPodsUngrouped]);

  useEffect(() => {
    if (!refreshing) {
      setShowRefreshFeedback(false);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setShowRefreshFeedback(true);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [refreshing]);

  useEffect(() => {
    if (!pendingNamespaceViewportFitRef.current || refreshing || !connected) {
      return;
    }
    pendingNamespaceViewportFitRef.current = false;
    setNamespaceViewportFitRevision((prev) => prev + 1);
  }, [connected, refreshing]);

  useEffect(() => {
    window.clearTimeout(connectionFeedbackTimeoutRef.current);

    if (showRefreshFeedback) {
      return () => window.clearTimeout(connectionFeedbackTimeoutRef.current);
    }

    if (!connected) {
      if (displayConnectionState === 'disconnected') {
        return () => window.clearTimeout(connectionFeedbackTimeoutRef.current);
      }

      connectionFeedbackTimeoutRef.current = window.setTimeout(() => {
        reconnectShownAtRef.current = Date.now();
        setDisplayConnectionState('disconnected');
      }, CONNECTION_FEEDBACK_DELAY_MS);

      return () => window.clearTimeout(connectionFeedbackTimeoutRef.current);
    }

    if (displayConnectionState === 'connected') {
      return () => window.clearTimeout(connectionFeedbackTimeoutRef.current);
    }

    const visibleForMs = reconnectShownAtRef.current > 0
      ? Date.now() - reconnectShownAtRef.current
      : 0;
    const delayMs = Math.max(0, CONNECTION_FEEDBACK_MIN_VISIBLE_MS - visibleForMs);

    connectionFeedbackTimeoutRef.current = window.setTimeout(() => {
      reconnectShownAtRef.current = 0;
      setDisplayConnectionState('connected');
    }, delayMs);

    return () => window.clearTimeout(connectionFeedbackTimeoutRef.current);
  }, [connected, displayConnectionState, showRefreshFeedback]);

  const selectedLink = useMemo(() => {
    if (!selectedLinkKey) {
      return null;
    }
    return graphData.links.find((link) => getLinkKey(link) === selectedLinkKey) || null;
  }, [graphData.links, selectedLinkKey]);

  const totals = useMemo(() => {
    const alertEdges = graphData.links.filter((link) => (
      renderedTrafficLayer === TRAFFIC_LAYERS.l7
        ? Number(link?.l7?.http?.statusClassMix?.['5xx']) > 0
        : link.verdict === 'DROPPED'
    )).length;
    return {
      nodes: graphData.nodes.length,
      edges: graphData.links.length,
      alertEdges,
    };
  }, [graphData.links, graphData.nodes.length, renderedTrafficLayer]);

  const canResetLayout = graphData.nodes.length > 0;
  const isPodMode = viewMode === VIEW_MODES.pod;
  const podSummary = isPodMode && graphData.podSummary
    ? graphData.podSummary
    : { liveNodes: 0, terminatedNodes: 0, unresolvedNodes: 0, unresolvedFlows: 0 };
  const viewportResetKey = buildStructuralTransitionKey(scene, structuralTransitionRevision);
  const graphHint = isPodMode
    ? (scene === SCENES.podNode
      ? 'Pods by Node groups only endpoints with confirmed worker placement. External endpoints such as world and unresolved endpoints stay outside worker boxes.'
      : 'Pod view distinguishes live pods, external endpoints such as world, and unresolved endpoints where Hubble omitted the pod name.')
    : (renderedTrafficLayer === TRAFFIC_LAYERS.l7
      ? 'Application mode shows L7 request and response events; HTTP details appear when available.'
      : 'Drag nodes to pin placement while telemetry continues streaming.');
  const truncationNotice = isPodMode && truncation
    ? `Showing top ${truncation.limit} pods by traffic (${truncation.shownNodes}/${truncation.totalNodes}).`
    : null;
  const terminatedNotice = isPodMode && podSummary.terminatedNodes > 0
    ? `Showing ${podSummary.terminatedNodes} terminated pod${podSummary.terminatedNodes === 1 ? '' : 's'} that still have traffic inside the 30 second window.`
    : null;
  const unresolvedNotice = isPodMode && podSummary.unresolvedNodes > 0
    ? `Showing ${podSummary.unresolvedNodes} unresolved endpoint bucket${podSummary.unresolvedNodes === 1 ? '' : 's'} from ${podSummary.unresolvedFlows} recent flow${podSummary.unresolvedFlows === 1 ? '' : 's'} where Hubble did not report a pod name${scene === SCENES.podNode ? ', so they stay outside worker boxes.' : '.'}`
    : null;
  const graphNotices = [truncationNotice, terminatedNotice, unresolvedNotice].filter(Boolean);
  const alertLabel = renderedTrafficLayer === TRAFFIC_LAYERS.l7 ? 'HTTP 5xx' : 'Dropped';
  const statusClass = showRefreshFeedback ? 'updating' : displayConnectionState;
  const statusLabel = showRefreshFeedback
    ? (graphData.nodes.length > 0 ? 'Updating' : 'Loading')
    : (displayConnectionState === 'connected' ? 'Stream Live' : 'Reconnecting');
  const mobileStatusLabel = showRefreshFeedback
    ? (graphData.nodes.length > 0 ? 'Updating' : 'Loading')
    : (displayConnectionState === 'connected' ? 'Live' : 'Retrying');
  const namespaceViewportFitKey = namespaceViewportFitRevision > 0
    ? `${scene}:${namespaceViewportFitRevision}`
    : '';
  const trafficLayerViewportFitKey = trafficLayerViewportFitRevision > 0
    ? `${scene}:${renderedTrafficLayer}:${trafficLayerViewportFitRevision}`
    : '';
  const viewportFitReady = isSceneViewportFitReady(scene, layoutMode, refreshing);
  const appStyle = useMemo(() => ({
    '--scene-transition-duration': `${SCENE_TRANSITION_DURATION_MS}ms`,
  }), []);

  useEffect(() => {
    if (!previousViewportResetKeyRef.current) {
      previousViewportResetKeyRef.current = viewportResetKey;
      return undefined;
    }
    if (previousViewportResetKeyRef.current === viewportResetKey) {
      return undefined;
    }

    previousViewportResetKeyRef.current = viewportResetKey;
    setSceneTransitionActive(false);
    window.clearTimeout(sceneTransitionTimeoutRef.current);
    if (sceneTransitionRafRef.current) {
      window.cancelAnimationFrame(sceneTransitionRafRef.current);
    }

    sceneTransitionRafRef.current = window.requestAnimationFrame(() => {
      setSceneTransitionActive(true);
      sceneTransitionTimeoutRef.current = window.setTimeout(() => {
        setSceneTransitionActive(false);
      }, SCENE_TRANSITION_DURATION_MS);
    });

    return () => {
      window.clearTimeout(sceneTransitionTimeoutRef.current);
      if (sceneTransitionRafRef.current) {
        window.cancelAnimationFrame(sceneTransitionRafRef.current);
      }
    };
  }, [viewportResetKey]);

  return (
    <div className="app" style={appStyle}>
      <div className="app-background" aria-hidden="true" />
      <header className={`header ${mobileControlsOpen ? 'mobile-controls-open' : ''}`} role="banner">
        <div className="header-brand">
          <p className="header-kicker">Realtime Service Topology</p>
          <h1>Hubble Gazer</h1>
        </div>
        <button
          type="button"
          className={`mobile-controls-toggle ${statusClass}`}
          aria-expanded={mobileControlsOpen}
          onClick={() => setMobileControlsOpen((prev) => !prev)}
        >
          <span>{mobileControlsOpen ? 'Hide Controls' : 'Show Controls'}</span>
          <span className="mobile-controls-toggle-state">{mobileStatusLabel}</span>
        </button>
        <div className="header-stats" aria-live="polite">
          <div className="stat-pill">
            <span className="stat-pill-label">Nodes</span>
            <span className="stat-pill-value">{totals.nodes}</span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill-label">Edges</span>
            <span className="stat-pill-value">{totals.edges}</span>
          </div>
          <div className="stat-pill stat-pill-alert">
            <span className="stat-pill-label">{alertLabel}</span>
            <span className="stat-pill-value">{totals.alertEdges}</span>
          </div>
          {isPodMode && podSummary.terminatedNodes > 0 && (
            <div className="stat-pill stat-pill-warn">
              <span className="stat-pill-label">Terminated</span>
              <span className="stat-pill-value">{podSummary.terminatedNodes}</span>
            </div>
          )}
          {isPodMode && podSummary.unresolvedNodes > 0 && (
            <div className="stat-pill stat-pill-warn">
              <span className="stat-pill-label">Unresolved</span>
              <span className="stat-pill-value">{podSummary.unresolvedNodes}</span>
            </div>
          )}
        </div>
        <div className="header-controls">
          <NamespaceSelector value={namespace} onChange={handleNamespaceChange} />
          <div className="view-mode-toggle" role="tablist" aria-label="Traffic layer">
            <button
              type="button"
              role="tab"
              aria-selected={trafficLayer === TRAFFIC_LAYERS.l4}
              className={`view-mode-btn ${trafficLayer === TRAFFIC_LAYERS.l4 ? 'active' : ''}`}
              onClick={() => handleTrafficLayerChange(TRAFFIC_LAYERS.l4)}
            >
              Network (L4)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={trafficLayer === TRAFFIC_LAYERS.l7}
              className={`view-mode-btn ${trafficLayer === TRAFFIC_LAYERS.l7 ? 'active' : ''}`}
              onClick={() => handleTrafficLayerChange(TRAFFIC_LAYERS.l7)}
            >
              Application (L7)
            </button>
          </div>
          <div className="view-mode-toggle" role="tablist" aria-label="Graph view mode">
            <button
              type="button"
              role="tab"
              aria-selected={scene === SCENES.service}
              className={`view-mode-btn ${scene === SCENES.service ? 'active' : ''}`}
              onClick={() => handleSceneChange(SCENES.service)}
            >
              Services
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scene === SCENES.pod}
              className={`view-mode-btn ${scene === SCENES.pod ? 'active' : ''}`}
              onClick={() => handleSceneChange(SCENES.pod)}
            >
              Pods
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scene === SCENES.podNode}
              className={`view-mode-btn ${scene === SCENES.podNode ? 'active' : ''}`}
              onClick={() => handleSceneChange(SCENES.podNode)}
            >
              Pods by Node
            </button>
          </div>
          <button
            type="button"
            className="layout-reset-btn"
            onClick={handleResetLayout}
            disabled={!canResetLayout}
          >
            Reset Layout
          </button>
          <span
            className={`status ${statusClass}`}
            role="status"
            aria-live="polite"
          >
            {statusLabel}
          </span>
        </div>
      </header>
      <main
        className={`main ${selectedLink ? 'main-panel-open' : ''}`}
        role="main"
        onPointerUpCapture={handleMainInteraction}
      >
        <section className="graph-stage">
          <div className={`graph-scene-frame ${sceneTransitionActive ? 'scene-transitioning' : ''}`}>
            <NetworkGraph
              data={graphData}
              trafficLayer={renderedTrafficLayer}
              refreshing={showRefreshFeedback}
              groupingMode={layoutMode}
              nodeGroupBoxes={nodeGroupBoxes}
              viewportResetKey={viewportResetKey}
              viewportFitKey={namespaceViewportFitKey}
              viewportFitIfNeededKey={trafficLayerViewportFitKey}
              viewportFitReady={viewportFitReady}
              layoutMotionEnabled={sceneTransitionActive}
              onLinkClick={handleLinkClick}
              onNodeDrag={handleNodeDrag}
              onNodePositionChange={handleNodePositionChange}
            />
            {graphNotices.length > 0 && (
              <div className="graph-notices" role="status" aria-live="polite">
                {graphNotices.map((notice) => (
                  <p className="graph-truncation-notice" key={notice}>
                    {notice}
                  </p>
                ))}
              </div>
            )}
            <p className="graph-hint">{graphHint}</p>
          </div>
        </section>
        {selectedLink && (
          <FlowPanel link={selectedLink} trafficLayer={renderedTrafficLayer} onClose={handleClosePanel} />
        )}
      </main>
      {layoutToastVisible && (
        <div
          key={layoutToastKey}
          className="app-toast"
          role="status"
          aria-live="polite"
        >
          {layoutToastMessage}
        </div>
      )}
    </div>
  );
}
