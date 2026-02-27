import React, { useState, useEffect } from 'react';

export default function NamespaceSelector({ value, onChange }) {
  const [namespaces, setNamespaces] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchNamespaces() {
      try {
        const resp = await fetch('/api/namespaces');
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled) {
            setNamespaces(data || []);
          }
        }
      } catch {
        // Silently retry on next interval
      }
    }

    fetchNamespaces();
    const interval = setInterval(fetchNamespaces, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="namespace-selector">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All Namespaces</option>
        {namespaces.sort().map((ns) => (
          <option key={ns} value={ns}>
            {ns}
          </option>
        ))}
      </select>
    </div>
  );
}
