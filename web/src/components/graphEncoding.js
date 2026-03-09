const TRAFFIC_LAYERS = Object.freeze({
  l4: 'l4',
  l7: 'l7',
});

const L4_PROTOCOL_COLORS = Object.freeze({
  TCP: '#3fb950',
  UDP: '#79c0ff',
  ICMP: '#f2cc60',
  unknown: '#8b949e',
});

const L7_PROTOCOL_COLORS = Object.freeze({
  HTTP: '#ffb86b',
  DNS: '#79c0ff',
  Kafka: '#3fb950',
  unknown: '#8b949e',
});

const MIXED_PARTICLE_COLOR = '#d8ecff';

function resolveTrafficLayer(trafficLayer) {
  return trafficLayer === TRAFFIC_LAYERS.l7 ? TRAFFIC_LAYERS.l7 : TRAFFIC_LAYERS.l4;
}

function protocolColorsForLayer(trafficLayer) {
  return resolveTrafficLayer(trafficLayer) === TRAFFIC_LAYERS.l7
    ? L7_PROTOCOL_COLORS
    : L4_PROTOCOL_COLORS;
}

function normalizeProtocol(protocol, trafficLayer = TRAFFIC_LAYERS.l4) {
  if (typeof protocol !== 'string' || protocol.length === 0) {
    return 'unknown';
  }
  const upper = protocol.toUpperCase();
  const palette = protocolColorsForLayer(trafficLayer);
  return palette[upper] ? upper : 'unknown';
}

function numericCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return count;
}

export function protocolDistribution(link, trafficLayer = TRAFFIC_LAYERS.l4) {
  const fromMix = [];
  const mix = link?.protocolMix;

  if (mix && typeof mix === 'object') {
    for (const [protocol, count] of Object.entries(mix)) {
      const sanitized = numericCount(count);
      if (sanitized > 0) {
        fromMix.push({
          protocol: normalizeProtocol(protocol, trafficLayer),
          count: sanitized,
        });
      }
    }
  }

  const entries = fromMix.length > 0
    ? fromMix
    : [{ protocol: normalizeProtocol(link?.protocol, trafficLayer), count: 1 }];

  entries.sort((a, b) => b.count - a.count || a.protocol.localeCompare(b.protocol));
  const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;

  return entries.map((entry) => ({
    ...entry,
    share: entry.count / total,
  }));
}

export function dominantProtocol(link, trafficLayer = TRAFFIC_LAYERS.l4) {
  return protocolDistribution(link, trafficLayer)[0]?.protocol || 'unknown';
}

export function protocolColor(protocol, trafficLayer = TRAFFIC_LAYERS.l4) {
  const palette = protocolColorsForLayer(trafficLayer);
  return palette[normalizeProtocol(protocol, trafficLayer)] || palette.unknown;
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
  return 0.32 + Math.min(0.4, Math.log2(flowRate + 1) * 0.075);
}

export function particleColor(link, trafficLayer = TRAFFIC_LAYERS.l4) {
  if (resolveTrafficLayer(trafficLayer) === TRAFFIC_LAYERS.l4 && link?.verdict === 'DROPPED') {
    return '#ff6e6e';
  }
  const distribution = protocolDistribution(link, trafficLayer);
  if (distribution.length > 1) {
    return MIXED_PARTICLE_COLOR;
  }
  return protocolColor(distribution[0]?.protocol, trafficLayer);
}

export function errorRatio(link, trafficLayer = TRAFFIC_LAYERS.l4) {
  if (!link) {
    return 0;
  }

  if (resolveTrafficLayer(trafficLayer) === TRAFFIC_LAYERS.l7) {
    if (!link?.l7?.http) {
      return 0;
    }
    const successRate = Number(link.successRate);
    if (Number.isFinite(successRate)) {
      return Math.max(0, Math.min(1, 1 - successRate));
    }
    return 0;
  }

  const successRate = Number(link.successRate);
  if (Number.isFinite(successRate)) {
    return Math.max(0, Math.min(1, 1 - successRate));
  }
  return link.verdict === 'DROPPED' ? 1 : 0;
}

export function protocolLegend(trafficLayer = TRAFFIC_LAYERS.l4) {
  const palette = protocolColorsForLayer(trafficLayer);
  if (resolveTrafficLayer(trafficLayer) === TRAFFIC_LAYERS.l7) {
    return [
      { protocol: 'HTTP', label: 'HTTP', color: palette.HTTP },
      { protocol: 'DNS', label: 'DNS', color: palette.DNS },
      { protocol: 'unknown', label: 'Unknown', color: palette.unknown },
    ];
  }

  return ['TCP', 'UDP', 'ICMP'].map((protocol) => ({
    protocol,
    label: protocol,
    color: palette[protocol] || palette.unknown,
  }));
}

export const PROTOCOL_LEGEND = protocolLegend();
