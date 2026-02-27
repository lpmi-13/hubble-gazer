import React from 'react';

export default function FlowPanel({ link, onClose }) {
  if (!link) return null;

  const sourceLabel = typeof link.source === 'object' ? link.source.label || link.source.id : link.source;
  const targetLabel = typeof link.target === 'object' ? link.target.label || link.target.id : link.target;
  const successPct = ((link.successRate || 0) * 100).toFixed(1);
  const errorPct = (100 - successPct).toFixed(1);

  return (
    <div className="flow-panel">
      <div className="flow-panel-header">
        <h2>Flow Details</h2>
        <button className="flow-panel-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Source</div>
        <div className="flow-detail-value">{sourceLabel}</div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Destination</div>
        <div className="flow-detail-value">{targetLabel}</div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Protocol</div>
        <div className="flow-detail-value">{link.protocol || 'unknown'}</div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Flow Rate</div>
        <div className="flow-detail-value">
          {(link.flowRate || 0).toFixed(2)} flows/sec
        </div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Total Flows (30s window)</div>
        <div className="flow-detail-value">{link.flowCount || 0}</div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Verdict</div>
        <div className={`flow-detail-value ${link.verdict === 'FORWARDED' ? 'success' : 'error'}`}>
          {link.verdict || 'unknown'}
        </div>
      </div>

      <div className="flow-detail">
        <div className="flow-detail-label">Success Rate</div>
        <div className={`flow-detail-value ${parseFloat(successPct) > 90 ? 'success' : 'error'}`}>
          {successPct}%
        </div>
        <div className="flow-stat-bar">
          <div
            className="flow-stat-fill success"
            style={{ width: `${successPct}%` }}
          />
        </div>
      </div>

      {parseFloat(errorPct) > 0 && (
        <div className="flow-detail">
          <div className="flow-detail-label">Error Rate</div>
          <div className="flow-detail-value error">{errorPct}%</div>
          <div className="flow-stat-bar">
            <div
              className="flow-stat-fill error"
              style={{ width: `${errorPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
