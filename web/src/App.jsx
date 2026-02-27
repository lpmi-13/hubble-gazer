import React, { useState, useCallback, useMemo } from 'react';
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
  const {
    graphData,
    connected,
    trackNodePosition,
    persistNodePosition,
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

  return (
    <div className="app">
      <div className="app-background" aria-hidden="true" />
      <header className="header">
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
          <span className={`status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Stream Live' : 'Reconnecting'}
          </span>
        </div>
      </header>
      <main className={`main ${selectedLink ? 'main-panel-open' : ''}`}>
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
    </div>
  );
}
