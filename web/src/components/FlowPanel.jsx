import React from 'react';

export default function FlowPanel({ link, onClose }) {
  if (!link) return null;

  const sourceLabel = typeof link.source === 'object' ? link.source.label || link.source.id : link.source;
  const targetLabel = typeof link.target === 'object' ? link.target.label || link.target.id : link.target;
  const successPct = Math.max(0, Math.min(100, (link.successRate || 0) * 100));
  const errorPct = Math.max(0, 100 - successPct);
  const verdict = link.verdict || 'unknown';
  const verdictClass = verdict === 'FORWARDED' ? 'success' : verdict === 'DROPPED' ? 'error' : 'warn';

  return (
    <aside className="flow-panel" role="complementary" aria-label="Flow details">
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
          <div className="flow-card-label">Protocol</div>
          <div className="flow-card-value monospace">{link.protocol || 'unknown'}</div>
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
        <div className="flow-progress-track">
          <div className="flow-progress-fill success" style={{ width: `${successPct.toFixed(1)}%` }} />
        </div>
      </div>

      {errorPct > 0 && (
        <div className="flow-progress">
          <div className="flow-progress-header">
            <span>Error Rate</span>
            <span className={errorPct > 10 ? 'error' : 'warn'}>{errorPct.toFixed(1)}%</span>
          </div>
          <div className="flow-progress-track">
            <div className="flow-progress-fill error" style={{ width: `${errorPct.toFixed(1)}%` }} />
          </div>
        </div>
      )}
    </aside>
  );
}
