// Pure color conversion and selective HSL helpers. No DOM, unit-testable with `node --test`.

export function rgbToHex(r, g, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

export function rgbToHsl(r, g, b) {
  const rn = Math.max(0, Math.min(255, r)) / 255;
  const gn = Math.max(0, Math.min(255, g)) / 255;
  const bn = Math.max(0, Math.min(255, b)) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h: Math.round(h * 10) / 10, s, l };
}

export function hslToRgb(h, s, l) {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = Math.max(0, Math.min(1, s));
  const ln = Math.max(0, Math.min(1, l));
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue2rgb = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(hn) * 255),
    b: Math.round(hue2rgb(hn - 1 / 3) * 255),
  };
}

export function normalizeHex(input, fallback = '#ef4444') {
  const rgb = hexToRgb(input);
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : fallback;
}

export const MAX_HSL_BANDS = 8;

export function makeHslBand(hex = '#ef4444', id = null) {
  return {
    id: id || ('hb' + Math.random().toString(36).slice(2, 8)),
    hex: normalizeHex(hex, '#ef4444'),
    hue: 0,
    sat: 0,
    light: 0,
    range: 35,
  };
}

// Always returns a clean array of HSL bands for a clip (migrating legacy single-band fields if present).
export function getHslBands(clip) {
  if (clip && Array.isArray(clip.hslBands) && clip.hslBands.length) {
    return clip.hslBands;
  }
  const base = makeHslBand((clip && clip.hslTarget) || '#ef4444', 'hb0');
  if (clip) {
    if (typeof clip.hslHue === 'number') base.hue = clip.hslHue;
    if (typeof clip.hslSat === 'number') base.sat = clip.hslSat;
    if (typeof clip.hslLight === 'number') base.light = clip.hslLight;
    if (typeof clip.hslRange === 'number') base.range = clip.hslRange;
  }
  return [base];
}

export function isBandActive(band) {
  if (!band) return false;
  return Math.abs(Math.round(Number(band.hue) || 0)) >= 1
    || Math.abs(Math.round(Number(band.sat) || 0)) >= 1
    || Math.abs(Math.round(Number(band.light) || 0)) >= 1;
}

export function hasSelectiveHsl(clip) {
  if (!clip) return false;
  if (Array.isArray(clip.hslBands) && clip.hslBands.length) {
    return clip.hslBands.some(isBandActive);
  }
  return Math.abs(Math.round(Number(clip.hslHue) || 0)) >= 1
    || Math.abs(Math.round(Number(clip.hslSat) || 0)) >= 1
    || Math.abs(Math.round(Number(clip.hslLight) || 0)) >= 1;
}
