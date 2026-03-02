import React, { useEffect, useRef } from 'react';

function protocolBreakdown(link) {
  const entries = [];
  const mix = link?.protocolMix;
  if (mix && typeof mix === 'object') {
    for (const [protocol, count] of Object.entries(mix)) {
      const numeric = Number(count);
      if (Number.isFinite(numeric) && numeric > 0) {
        entries.push({ protocol: protocol.toUpperCase(), count: numeric });
      }
    }
  }

  if (entries.length === 0) {
    return [{ protocol: (link?.protocol || 'unknown').toUpperCase(), count: 1, percent: 100 }];
  }

  entries.sort((a, b) => b.count - a.count || a.protocol.localeCompare(b.protocol));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;
  return entries.map((entry) => ({
    ...entry,
    percent: (entry.count / total) * 100,
  }));
}

export default function FlowPanel({ link, onClose }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (link && panelRef.current) {
      panelRef.current.focus();
    }
  }, [link]);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!link) return null;

  const sourceLabel = typeof link.source === 'object' ? link.source.label || link.source.id : link.source;
  const targetLabel = typeof link.target === 'object' ? link.target.label || link.target.id : link.target;
  const successPct = Math.max(0, Math.min(100, (link.successRate || 0) * 100));
  const errorPct = Math.max(0, 100 - successPct);
  const verdict = link.verdict || 'unknown';
  const verdictClass = verdict === 'FORWARDED' ? 'success' : verdict === 'DROPPED' ? 'error' : 'warn';
  const protocolMix = protocolBreakdown(link);
  const protocolHeadline = protocolMix.length > 1
    ? 'Mixed'
    : protocolMix[0]?.protocol || 'UNKNOWN';

  return (
    <aside
      className="flow-panel"
      ref={panelRef}
      role="complementary"
      aria-label="Flow details"
      tabIndex={-1}
    >
      <div className="flow-panel-header">
        <div>
          <p className="flow-panel-kicker">Edge Details</p>
          <h2>Traffic Profile</h2>
        </div>
        <button type="button" className="flow-panel-close" onClick={onClose} aria-label="Close flow details">
          ×
        </button>
      </div>

      <p className="flow-panel-meta">Live values over the active 30 second aggregation window.</p>

      <div className="flow-route">
        <div className="flow-route-endpoint">{sourceLabel}</div>
        <div className="flow-route-arrow">→</div>
        <div className="flow-route-endpoint">{targetLabel}</div>
      </div>

      <div className="flow-grid">
        <div className="flow-card">
          <div className="flow-card-label">Protocol Mix</div>
          <div className="flow-card-value monospace">{protocolHeadline}</div>
          <div className="flow-card-subvalue">
            {protocolMix.map((entry) => `${entry.protocol} ${entry.percent.toFixed(0)}%`).join(' · ')}
          </div>
        </div>
        <div className="flow-card">
          <div className="flow-card-label">Flow Rate</div>
          <div className="flow-card-value">{(link.flowRate || 0).toFixed(2)} flows/s</div>
        </div>
        <div className="flow-card">
          <div className="flow-card-label">Total Flows</div>
          <div className="flow-card-value">{link.flowCount || 0}</div>
        </div>
        <div className="flow-card">
          <div className="flow-card-label">Verdict</div>
          <div className={`flow-card-value ${verdictClass}`}>{verdict}</div>
        </div>
      </div>

      <div className="flow-progress">
        <div className="flow-progress-header">
          <span>Success Rate</span>
          <span className={successPct > 90 ? 'success' : 'warn'}>{successPct.toFixed(1)}%</span>
        </div>
        <div className="flow-progress-track" role="progressbar" aria-valuenow={successPct.toFixed(1)} aria-valuemin="0" aria-valuemax="100">
          <div className="flow-progress-fill success" style={{ width: `${successPct.toFixed(1)}%` }} />
        </div>
      </div>

      {errorPct > 0 && (
        <div className="flow-progress">
          <div className="flow-progress-header">
            <span>Error Rate</span>
            <span className={errorPct > 10 ? 'error' : 'warn'}>{errorPct.toFixed(1)}%</span>
          </div>
          <div className="flow-progress-track" role="progressbar" aria-valuenow={errorPct.toFixed(1)} aria-valuemin="0" aria-valuemax="100">
            <div className="flow-progress-fill error" style={{ width: `${errorPct.toFixed(1)}%` }} />
          </div>
        </div>
      )}
    </aside>
  );
}
