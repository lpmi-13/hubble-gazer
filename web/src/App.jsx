import React, { useState, useCallback } from 'react';
import NetworkGraph from './components/NetworkGraph';
import FlowPanel from './components/FlowPanel';
import NamespaceSelector from './components/NamespaceSelector';
import { useFlowStream } from './hooks/useFlowStream';

export default function App() {
  const [namespace, setNamespace] = useState('');
  const [selectedLink, setSelectedLink] = useState(null);
  const { graphData, connected, persistNodePosition } = useFlowStream(namespace);

  const handleLinkClick = useCallback((link) => {
    setSelectedLink(link);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedLink(null);
  }, []);

  const handleNodePositionChange = useCallback((id, x, y) => {
    persistNodePosition(id, x, y);
  }, [persistNodePosition]);

  return (
    <div className="app">
      <header className="header">
        <h1>KTHW Network Traffic</h1>
        <div className="header-controls">
          <NamespaceSelector value={namespace} onChange={setNamespace} />
          <span className={`status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Live' : 'Connecting...'}
          </span>
        </div>
      </header>
      <main className="main">
        <NetworkGraph
          data={graphData}
          onLinkClick={handleLinkClick}
          onNodePositionChange={handleNodePositionChange}
        />
        {selectedLink && (
          <FlowPanel link={selectedLink} onClose={handleClosePanel} />
        )}
      </main>
    </div>
  );
}
