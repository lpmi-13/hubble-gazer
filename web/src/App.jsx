import React, { useState, useCallback, useMemo, useEffect } from 'react';
import NetworkGraph from './components/NetworkGraph';
import FlowPanel from './components/FlowPanel';
import NamespaceSelector from './components/NamespaceSelector';
import { useFlowStream } from './hooks/useFlowStream';

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
  const [selectedLinkKey, setSelectedLinkKey] = useState(null);
  const [layoutToastVisible, setLayoutToastVisible] = useState(false);
  const [layoutToastKey, setLayoutToastKey] = useState(0);
  const {
    graphData,
    connected,
    trackNodePosition,
    persistNodePosition,
    resetLayout,
  } = useFlowStream(namespace);

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

  const handleResetLayout = useCallback(() => {
    resetLayout();
    setLayoutToastVisible(true);
    setLayoutToastKey((prev) => prev + 1);
  }, [resetLayout]);

  useEffect(() => {
    if (!layoutToastVisible) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setLayoutToastVisible(false);
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [layoutToastVisible, layoutToastKey]);

  const selectedLink = useMemo(() => {
    if (!selectedLinkKey) {
      return null;
    }
    return graphData.links.find((link) => getLinkKey(link) === selectedLinkKey) || null;
  }, [graphData.links, selectedLinkKey]);

  const totals = useMemo(() => {
    const droppedEdges = graphData.links.filter((link) => link.verdict === 'DROPPED').length;
    return {
      nodes: graphData.nodes.length,
      edges: graphData.links.length,
      droppedEdges,
    };
  }, [graphData.links, graphData.nodes.length]);

  const canResetLayout = graphData.nodes.length > 0;

  return (
    <div className="app">
      <div className="app-background" aria-hidden="true" />
      <header className="header" role="banner">
        <div className="header-brand">
          <p className="header-kicker">Realtime Service Topology</p>
          <h1>Hubble Gazer</h1>
        </div>
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
            <span className="stat-pill-label">Dropped</span>
            <span className="stat-pill-value">{totals.droppedEdges}</span>
          </div>
        </div>
        <div className="header-controls">
          <NamespaceSelector value={namespace} onChange={setNamespace} />
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
      <main className={`main ${selectedLink ? 'main-panel-open' : ''}`} role="main">
        <section className="graph-stage">
          <NetworkGraph
            data={graphData}
            onLinkClick={handleLinkClick}
            onNodeDrag={handleNodeDrag}
            onNodePositionChange={handleNodePositionChange}
          />
          <p className="graph-hint">Drag nodes to pin placement while telemetry continues streaming.</p>
        </section>
        {selectedLink && (
          <FlowPanel link={selectedLink} onClose={handleClosePanel} />
        )}
      </main>
      {layoutToastVisible && (
        <div
          key={layoutToastKey}
          className="app-toast"
          role="status"
          aria-live="polite"
        >
          Layout reset
        </div>
      )}
    </div>
  );
}
