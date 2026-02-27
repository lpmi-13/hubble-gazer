import { useState, useEffect, useRef } from 'react';

const EMPTY_GRAPH = { nodes: [], links: [] };

export function useFlowStream(namespace) {
  const [graphData, setGraphData] = useState(EMPTY_GRAPH);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef(null);

  useEffect(() => {
    const url = namespace
      ? `/api/flows?namespace=${encodeURIComponent(namespace)}`
      : '/api/flows';

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
    };

    source.onmessage = (event) => {
      try {
        const graph = JSON.parse(event.data);
        // Ensure nodes and links arrays exist
        setGraphData({
          nodes: graph.nodes || [],
          links: graph.links || [],
        });
      } catch {
        // Ignore malformed messages
      }
    };

    source.onerror = () => {
      setConnected(false);
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [namespace]);

  return { graphData, connected };
}
