const FIXED_NAMESPACE_COLORS = {
  demo: '#58a6ff',
  'kube-system': '#bc8cff',
  default: '#79c0ff',
};

export const DEFAULT_NAMESPACE_COLOR = '#8b949e';

export function namespaceColor(namespace) {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    return DEFAULT_NAMESPACE_COLOR;
  }
  return FIXED_NAMESPACE_COLORS[namespace] || generatedNamespaceColor(namespace);
}

function generatedNamespaceColor(namespace) {
  const hue = hashString(namespace) % 360;
  const saturation = 58 + (hashString(`${namespace}:s`) % 14);
  const lightness = 54 + (hashString(`${namespace}:l`) % 10);
  return hslToHex(hue, saturation, lightness);
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hslToHex(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs((2 * l) - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r = 0;
  let g = 0;
  let b = 0;

  if (hp >= 0 && hp < 1) {
    r = c;
    g = x;
  } else if (hp >= 1 && hp < 2) {
    r = x;
    g = c;
  } else if (hp >= 2 && hp < 3) {
    g = c;
    b = x;
  } else if (hp >= 3 && hp < 4) {
    g = x;
    b = c;
  } else if (hp >= 4 && hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const m = l - (c / 2);
  return rgbToHex(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}

function rgbToHex(r, g, b) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(value) {
  return value.toString(16).padStart(2, '0');
}
