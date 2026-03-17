import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_NAMESPACE_COLOR, namespaceColor } from '../src/components/namespaceColors.js';

test('namespaceColor preserves fixed colors for core namespaces', () => {
  assert.equal(namespaceColor('demo'), '#58a6ff');
  assert.equal(namespaceColor('kube-system'), '#bc8cff');
  assert.equal(namespaceColor('default'), '#79c0ff');
});

test('namespaceColor assigns stable distinct colors to custom namespaces', () => {
  const namespaces = ['keda', 'monitoring', 'cert-manager', 'ingress-nginx'];
  const colors = namespaces.map((namespace) => namespaceColor(namespace));

  assert.deepEqual(colors, namespaces.map((namespace) => namespaceColor(namespace)));
  assert.equal(new Set(colors).size, namespaces.length);

  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/i);
    assert.notEqual(color, DEFAULT_NAMESPACE_COLOR);
  }
});

test('namespaceColor falls back to default color for empty namespaces', () => {
  assert.equal(namespaceColor(''), DEFAULT_NAMESPACE_COLOR);
  assert.equal(namespaceColor(null), DEFAULT_NAMESPACE_COLOR);
});
