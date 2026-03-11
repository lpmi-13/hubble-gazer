import React, { useState, useCallback, useMemo, useEffect } from 'react';
import NetworkGraph from './components/NetworkGraph';
import FlowPanel from './components/FlowPanel';
import NamespaceSelector from './components/NamespaceSelector';
import { useFlowStream } from './hooks/useFlowStream';

const VIEW_MODES = Object.freeze({
  service: 'service',
  pod: 'pod',
});

const TRAFFIC_LAYERS = Object.freeze({
  l4: 'l4',
  l7: 'l7',
});

const TRAFFIC_LAYER_STORAGE_KEY = 'hubble-gazer-traffic-layer:v1';

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
  const [namespace, setNamespace] = useState('');
  const [viewMode, setViewMode] = useState(VIEW_MODES.service);
  const [trafficLayer, setTrafficLayer] = useState(() => {
    try {
      const stored = window.localStorage.getItem(TRAFFIC_LAYER_STORAGE_KEY);
      return stored === TRAFFIC_LAYERS.l7 ? TRAFFIC_LAYERS.l7 : TRAFFIC_LAYERS.l4;
    } catch {
      return TRAFFIC_LAYERS.l4;
    }
  });
  const [selectedLinkKey, setSelectedLinkKey] = useState(null);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [layoutToastVisible, setLayoutToastVisible] = useState(false);
  const [layoutToastKey, setLayoutToastKey] = useState(0);
  const [layoutToastMessage, setLayoutToastMessage] = useState('Layout reset');
  const {
    graphData,
    connected,
    truncation,
    layoutMode,
    nodeGroupBoxes,
    podNodeCount,
    trackNodePosition,
    persistNodePosition,
    resetLayout,
    groupByK8sNode,
  } = useFlowStream(namespace, viewMode, trafficLayer);

  const handleLinkClick = useCallback((link) => {
    setSelectedLinkKey(getLinkKey(link));
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedLinkKey(null);
  }, []);

  const handleNodeDrag = useCallback((id, x, y) => {
    trackNodePosition(id, x, y);
  }, [trackNodePosition]);

  const handleNodePositionChange = useCallback((id, x, y) => {
    persistNodePosition(id, x, y);
  }, [persistNodePosition]);

  const handleViewModeChange = useCallback((mode) => {
    if (mode === viewMode) {
      return;
    }
    setViewMode(mode);
    setSelectedLinkKey(null);
  }, [viewMode]);

  const handleTrafficLayerChange = useCallback((layer) => {
    if (layer === trafficLayer) {
      return;
    }
    setTrafficLayer(layer);
    setSelectedLinkKey(null);
  }, [trafficLayer]);

  const handleNamespaceChange = useCallback((nextNamespace) => {
    setNamespace(nextNamespace);
    setSelectedLinkKey(null);
  }, []);

  const handleResetLayout = useCallback(() => {
    resetLayout();
    setLayoutToastMessage('Layout reset');
    setLayoutToastVisible(true);
    setLayoutToastKey((prev) => prev + 1);
  }, [resetLayout]);

  const handleGroupByNode = useCallback(() => {
    if (viewMode !== VIEW_MODES.pod) {
      setViewMode(VIEW_MODES.pod);
      setSelectedLinkKey(null);
    }
    groupByK8sNode();
    setLayoutToastMessage('Grouped by Kubernetes node');
    setLayoutToastVisible(true);
    setLayoutToastKey((prev) => prev + 1);
  }, [groupByK8sNode, viewMode]);

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

  const selectedLink = useMemo(() => {
    if (!selectedLinkKey) {
      return null;
    }
    return graphData.links.find((link) => getLinkKey(link) === selectedLinkKey) || null;
  }, [graphData.links, selectedLinkKey]);

  const totals = useMemo(() => {
    const alertEdges = graphData.links.filter((link) => (
      trafficLayer === TRAFFIC_LAYERS.l7
        ? Number(link?.l7?.http?.statusClassMix?.['5xx']) > 0
        : link.verdict === 'DROPPED'
    )).length;
    return {
      nodes: graphData.nodes.length,
      edges: graphData.links.length,
      alertEdges,
    };
  }, [graphData.links, graphData.nodes.length, trafficLayer]);

  const canResetLayout = graphData.nodes.length > 0;
  const isPodMode = viewMode === VIEW_MODES.pod;
  const isNodeGroupMode = isPodMode && layoutMode === 'k8sNode';
  const podSummary = isPodMode && graphData.podSummary
    ? graphData.podSummary
    : { liveNodes: 0, terminatedNodes: 0, unresolvedNodes: 0, unresolvedFlows: 0 };
  const canGroupByNode = podNodeCount > 0;
  const viewportResetKey = `${viewMode}:${namespace || 'all'}:${layoutMode || 'default'}`;
  const graphHint = isPodMode
    ? (isNodeGroupMode
      ? 'Node-group mode active: live pods use Kubernetes node placement, terminated pods stay on their last observed worker, and unresolved endpoints stay in the unknown bucket.'
      : 'Pod view distinguishes live pods, terminated pods still inside the 30 second flow window, and unresolved endpoints where Hubble omitted the pod name.')
    : (trafficLayer === TRAFFIC_LAYERS.l7
      ? 'Application mode shows L7 request and response events; HTTP details appear when available.'
      : 'Drag nodes to pin placement while telemetry continues streaming.');
  const truncationNotice = isPodMode && truncation
    ? `Showing top ${truncation.limit} pods by traffic (${truncation.shownNodes}/${truncation.totalNodes}).`
    : null;
  const terminatedNotice = isPodMode && podSummary.terminatedNodes > 0
    ? `Showing ${podSummary.terminatedNodes} terminated pod${podSummary.terminatedNodes === 1 ? '' : 's'} that still have traffic inside the 30 second window.`
    : null;
  const unresolvedNotice = isPodMode && podSummary.unresolvedNodes > 0
    ? `Showing ${podSummary.unresolvedNodes} unresolved endpoint bucket${podSummary.unresolvedNodes === 1 ? '' : 's'} from ${podSummary.unresolvedFlows} recent flow${podSummary.unresolvedFlows === 1 ? '' : 's'} where Hubble did not report a pod name.`
    : null;
  const graphNotices = [truncationNotice, terminatedNotice, unresolvedNotice].filter(Boolean);
  const alertLabel = trafficLayer === TRAFFIC_LAYERS.l7 ? 'HTTP 5xx' : 'Dropped';

  return (
    <div className="app">
      <div className="app-background" aria-hidden="true" />
      <header className={`header ${mobileControlsOpen ? 'mobile-controls-open' : ''}`} role="banner">
        <div className="header-brand">
          <p className="header-kicker">Realtime Service Topology</p>
          <h1>Hubble Gazer</h1>
        </div>
        <button
          type="button"
          className={`mobile-controls-toggle ${connected ? 'connected' : 'disconnected'}`}
          aria-expanded={mobileControlsOpen}
          onClick={() => setMobileControlsOpen((prev) => !prev)}
        >
          <span>{mobileControlsOpen ? 'Hide Controls' : 'Controls'}</span>
          <span className="mobile-controls-toggle-state">{connected ? 'Live' : 'Retrying'}</span>
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
              aria-selected={viewMode === VIEW_MODES.service}
              className={`view-mode-btn ${viewMode === VIEW_MODES.service ? 'active' : ''}`}
              onClick={() => handleViewModeChange(VIEW_MODES.service)}
            >
              Services
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === VIEW_MODES.pod}
              className={`view-mode-btn ${viewMode === VIEW_MODES.pod ? 'active' : ''}`}
              onClick={() => handleViewModeChange(VIEW_MODES.pod)}
            >
              Pods
            </button>
          </div>
          <button
            type="button"
            className="layout-reset-btn"
            onClick={handleGroupByNode}
            disabled={!canGroupByNode}
          >
            Group by Node
          </button>
          <button
            type="button"
            className="layout-reset-btn"
            onClick={handleResetLayout}
            disabled={!canResetLayout}
          >
            Reset Layout
          </button>
          <span
            className={`status ${connected ? 'connected' : 'disconnected'}`}
            role="status"
            aria-live="polite"
          >
            {connected ? 'Stream Live' : 'Reconnecting'}
          </span>
        </div>
      </header>
      <main
        className={`main ${selectedLink ? 'main-panel-open' : ''}`}
        role="main"
        onPointerUpCapture={handleMainInteraction}
      >
        <section className="graph-stage">
          <NetworkGraph
            data={graphData}
            trafficLayer={trafficLayer}
            groupingMode={layoutMode}
            nodeGroupBoxes={nodeGroupBoxes}
            viewportResetKey={viewportResetKey}
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
        </section>
        {selectedLink && (
          <FlowPanel link={selectedLink} trafficLayer={trafficLayer} onClose={handleClosePanel} />
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
