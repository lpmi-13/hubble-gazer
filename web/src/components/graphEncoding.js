const PROTOCOL_COLORS = Object.freeze({
  TCP: '#3fb950',
  UDP: '#79c0ff',
  ICMP: '#f2cc60',
  unknown: '#8b949e',
});

const MIXED_PARTICLE_COLOR = '#d8ecff';

function normalizeProtocol(protocol) {
  if (typeof protocol !== 'string' || protocol.length === 0) {
    return 'unknown';
  }
  const upper = protocol.toUpperCase();
  return PROTOCOL_COLORS[upper] ? upper : 'unknown';
}

function numericCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return count;
}

export function protocolDistribution(link) {
  const fromMix = [];
  const mix = link?.protocolMix;

  if (mix && typeof mix === 'object') {
    for (const [protocol, count] of Object.entries(mix)) {
      const sanitized = numericCount(count);
      if (sanitized > 0) {
        fromMix.push({
          protocol: normalizeProtocol(protocol),
          count: sanitized,
        });
      }
    }
  }

  const entries = fromMix.length > 0
    ? fromMix
    : [{ protocol: normalizeProtocol(link?.protocol), count: 1 }];

  entries.sort((a, b) => b.count - a.count || a.protocol.localeCompare(b.protocol));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;

  return entries.map((entry) => ({
    ...entry,
    share: entry.count / total,
  }));
}

export function dominantProtocol(link) {
  return protocolDistribution(link)[0]?.protocol || 'unknown';
}

export function protocolColor(protocol) {
  return PROTOCOL_COLORS[normalizeProtocol(protocol)] || PROTOCOL_COLORS.unknown;
}

export function edgeWidth(link) {
  const flowRate = Math.max(0, Number(link?.flowRate) || 0);
  return 1.6 + Math.min(1.4, Math.log2(flowRate + 1) * 0.46);
}

export function trafficParticleCount(link) {
  const flowRate = Math.max(0, Number(link?.flowRate) || 0);
  if (flowRate <= 0) {
    return 0;
  }
  const scaled = Math.round(Math.log2(flowRate + 1) * 2.4);
  return Math.max(1, Math.min(14, scaled));
}

export function particleRadius(link) {
  return Math.max(3.1, edgeWidth(link) * 1.65);
}

export function particleSpeed(link) {
  const flowRate = Math.max(0, Number(link?.flowRate) || 0);
  // Interpreted as normalized edge travel per second.
  return 0.32 + Math.min(0.4, Math.log2(flowRate + 1) * 0.075);
}

export function particleColor(link) {
  if (link?.verdict === 'DROPPED') {
    return '#ff6e6e';
  }
  const distribution = protocolDistribution(link);
  if (distribution.length > 1) {
    return MIXED_PARTICLE_COLOR;
  }
  return protocolColor(distribution[0]?.protocol);
}

export function errorRatio(link) {
  if (!link) {
    return 0;
  }
  const successRate = Number(link.successRate);
  if (Number.isFinite(successRate)) {
    return Math.max(0, Math.min(1, 1 - successRate));
  }
  return link.verdict === 'DROPPED' ? 1 : 0;
}

export const PROTOCOL_LEGEND = Object.freeze([
  { protocol: 'TCP', color: PROTOCOL_COLORS.TCP },
  { protocol: 'UDP', color: PROTOCOL_COLORS.UDP },
  { protocol: 'ICMP', color: PROTOCOL_COLORS.ICMP },
]);
