import React, { useEffect, useRef } from 'react';

function numericCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function breakdownFromMix(mix, fallbackLabel = 'UNKNOWN') {
  const entries = [];
  if (mix && typeof mix === 'object') {
    for (const [label, count] of Object.entries(mix)) {
      const numeric = numericCount(count);
      if (numeric > 0) {
        entries.push({ label: label.toUpperCase(), count: numeric });
      }
    }
  }

  if (entries.length === 0) {
    return [{ label: fallbackLabel.toUpperCase(), count: 1, percent: 100 }];
  }

  entries.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;
  return entries.map((entry) => ({
    ...entry,
    percent: (entry.count / total) * 100,
  }));
}

function summarizeBreakdown(entries) {
  return entries.map((entry) => `${entry.label} ${entry.percent.toFixed(0)}%`).join(' · ');
}

function formatLatency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 'n/a';
  }
  return numeric >= 100 ? `${numeric.toFixed(0)} ms` : `${numeric.toFixed(1)} ms`;
}

export default function FlowPanel({ link, trafficLayer = 'l4', onClose }) {
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

  const isL7 = trafficLayer === 'l7';
  const sourceLabel = typeof link.source === 'object' ? link.source.label || link.source.id : link.source;
  const targetLabel = typeof link.target === 'object' ? link.target.label || link.target.id : link.target;
  const protocolMix = breakdownFromMix(link.protocolMix, link.protocol || 'unknown');
  const protocolHeadline = protocolMix.length > 1
    ? 'Mixed'
    : protocolMix[0]?.label || 'UNKNOWN';

  const successPct = Math.max(0, Math.min(100, (Number(link.successRate) || 0) * 100));
  const errorPct = Math.max(0, 100 - successPct);
  const verdict = link.verdict || 'unknown';
  const verdictClass = verdict === 'FORWARDED' ? 'success' : verdict === 'DROPPED' ? 'error' : 'warn';

  const requestCount = numericCount(link?.l7?.requestCount);
  const responseCount = numericCount(link?.l7?.responseCount);
  const statusMix = breakdownFromMix(link?.l7?.http?.statusClassMix, 'HTTP');
  const methodMix = breakdownFromMix(link?.l7?.http?.methodMix, 'HTTP');
  const hasHTTPDetails = !!link?.l7?.http;

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
          <h2>{isL7 ? 'Application Profile' : 'Traffic Profile'}</h2>
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
          <div className="flow-card-subvalue">{summarizeBreakdown(protocolMix)}</div>
        </div>
        <div className="flow-card">
          <div className="flow-card-label">{isL7 ? 'Event Rate' : 'Flow Rate'}</div>
          <div className="flow-card-value">{(Number(link.flowRate) || 0).toFixed(2)} {isL7 ? 'events/s' : 'flows/s'}</div>
        </div>
        <div className="flow-card">
          <div className="flow-card-label">{isL7 ? 'Total Events' : 'Total Flows'}</div>
          <div className="flow-card-value">{numericCount(link.flowCount)}</div>
        </div>
        {isL7 ? (
          <div className="flow-card">
            <div className="flow-card-label">Request / Response</div>
            <div className="flow-card-value">{requestCount} / {responseCount}</div>
          </div>
        ) : (
          <div className="flow-card">
            <div className="flow-card-label">Verdict</div>
            <div className={`flow-card-value ${verdictClass}`}>{verdict}</div>
          </div>
        )}
      </div>

      {isL7 && (
        <div className="flow-grid">
          {hasHTTPDetails && (
            <div className="flow-card">
              <div className="flow-card-label">HTTP Status Mix</div>
              <div className="flow-card-value monospace">{statusMix[0]?.label || 'HTTP'}</div>
              <div className="flow-card-subvalue">{summarizeBreakdown(statusMix)}</div>
            </div>
          )}
          {hasHTTPDetails && (
            <div className="flow-card">
              <div className="flow-card-label">HTTP Methods</div>
              <div className="flow-card-value monospace">{methodMix[0]?.label || 'HTTP'}</div>
              <div className="flow-card-subvalue">{summarizeBreakdown(methodMix)}</div>
            </div>
          )}
          {hasHTTPDetails && (
            <div className="flow-card">
              <div className="flow-card-label">Latency</div>
              <div className="flow-card-value">p50 {formatLatency(link?.l7?.http?.p50LatencyMs)}</div>
              <div className="flow-card-subvalue">p95 {formatLatency(link?.l7?.http?.p95LatencyMs)}</div>
            </div>
          )}
        </div>
      )}

      <div className="flow-progress">
        <div className="flow-progress-header">
          <span>{isL7 && hasHTTPDetails ? 'HTTP Success' : 'Success Rate'}</span>
          <span className={successPct > 90 ? 'success' : 'warn'}>{successPct.toFixed(1)}%</span>
        </div>
        <div className="flow-progress-track" role="progressbar" aria-valuenow={successPct.toFixed(1)} aria-valuemin="0" aria-valuemax="100">
          <div className="flow-progress-fill success" style={{ width: `${successPct.toFixed(1)}%` }} />
        </div>
      </div>

      {errorPct > 0 && (
        <div className="flow-progress">
          <div className="flow-progress-header">
            <span>{isL7 && hasHTTPDetails ? 'HTTP 5xx Ratio' : 'Error Rate'}</span>
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
