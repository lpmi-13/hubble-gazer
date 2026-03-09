import test from 'node:test';
import assert from 'node:assert/strict';

import {
  edgeWidth,
  errorRatio,
  particleColor,
  particleRadius,
  particleSpeed,
  protocolColor,
  protocolDistribution,
  protocolLegend,
  trafficParticleCount,
} from '../src/components/graphEncoding.js';

test('protocolDistribution uses protocolMix and computes shares', () => {
  const distribution = protocolDistribution({
    protocol: 'TCP',
    protocolMix: { UDP: 3, TCP: 9, ICMP: 2 },
  });

  assert.equal(distribution.length, 3);
  assert.equal(distribution[0].protocol, 'TCP');
  assert.equal(distribution[0].count, 9);
  assert.ok(distribution[0].share > distribution[1].share);

  const shareSum = distribution.reduce((sum, segment) => sum + segment.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 0.000001);
});

test('protocolDistribution falls back to dominant protocol when mix is unavailable', () => {
  const distribution = protocolDistribution({ protocol: 'udp' });
  assert.deepEqual(distribution, [{ protocol: 'UDP', count: 1, share: 1 }]);
});

test('protocolDistribution respects l7 protocol palette', () => {
  const distribution = protocolDistribution({
    protocol: 'http',
    protocolMix: { DNS: 2, HTTP: 5 },
  }, 'l7');

  assert.equal(distribution[0].protocol, 'HTTP');
  assert.equal(distribution[1].protocol, 'DNS');
});

test('trafficParticleCount scales with traffic volume', () => {
  const low = { flowRate: 0.2 };
  const medium = { flowRate: 2.5 };
  const high = { flowRate: 12 };

  assert.ok(trafficParticleCount(low) < trafficParticleCount(medium));
  assert.ok(trafficParticleCount(medium) < trafficParticleCount(high));
  assert.equal(trafficParticleCount({ flowRate: 0 }), 0);
});

test('particle color reflects drop state and mixed-protocol state', () => {
  assert.equal(
    particleColor({ verdict: 'DROPPED', protocol: 'TCP' }),
    '#ff6e6e',
  );
  assert.equal(
    particleColor({ verdict: 'FORWARDED', protocolMix: { TCP: 3, UDP: 2 } }),
    '#d8ecff',
  );
  assert.equal(
    particleColor({ verdict: 'FORWARDED', protocol: 'UDP' }),
    protocolColor('UDP'),
  );
});

test('particle color in l7 mode uses l7 protocol colors instead of drop verdicts', () => {
  assert.equal(
    particleColor({ verdict: 'DROPPED', protocol: 'HTTP' }, 'l7'),
    protocolColor('HTTP', 'l7'),
  );
});

test('particle radius stays larger than edge width', () => {
  const link = { flowRate: 4.5 };
  assert.ok(particleRadius(link) > edgeWidth(link));
});

test('particle speed increases slightly with traffic', () => {
  assert.ok(particleSpeed({ flowRate: 0.5 }) < particleSpeed({ flowRate: 10 }));
});

test('errorRatio is derived from successRate and falls back to verdict', () => {
  assert.ok(Math.abs(errorRatio({ successRate: 0.82 }) - 0.18) < 0.000001);
  assert.equal(errorRatio({ verdict: 'DROPPED' }), 1);
  assert.equal(errorRatio({ verdict: 'FORWARDED' }), 0);
});

test('errorRatio in l7 mode only applies to http edges', () => {
  assert.ok(Math.abs(errorRatio({ successRate: 0.8, l7: { http: {} } }, 'l7') - 0.2) < 0.000001);
  assert.equal(errorRatio({ successRate: 0.1 }, 'l7'), 0);
});

test('protocolLegend switches by traffic layer', () => {
  const l4 = protocolLegend('l4').map((item) => item.protocol);
  const l7 = protocolLegend('l7').map((item) => item.protocol);

  assert.deepEqual(l4, ['TCP', 'UDP', 'ICMP']);
  assert.deepEqual(l7, ['HTTP', 'DNS', 'unknown']);
});
