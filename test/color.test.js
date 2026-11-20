import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHex, hexToRgb, rgbToHsl, hslToRgb, normalizeHex, hasSelectiveHsl, getHslBands, makeHslBand } from '../src/color.js';

test('rgbToHex and hexToRgb round-trip colors including 3-digit hex', () => {
  assert.equal(rgbToHex(239, 68, 68), '#ef4444');
  assert.deepEqual(hexToRgb('#ef4444'), { r: 239, g: 68, b: 68 });
  assert.deepEqual(hexToRgb('0f8'), { r: 0, g: 255, b: 136 });
  assert.equal(hexToRgb('not-a-color'), null);
  assert.equal(normalizeHex('3b82f6'), '#3b82f6');
  assert.equal(normalizeHex('zzz', '#ef4444'), '#ef4444');
});

test('rgbToHsl and hslToRgb round-trip primary colors', () => {
  const red = rgbToHsl(255, 0, 0);
  assert.equal(red.h, 0);
  assert.equal(red.s, 1);
  assert.equal(red.l, 0.5);
  assert.deepEqual(hslToRgb(120, 1, 0.5), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hslToRgb(240, 1, 0.5), { r: 0, g: 0, b: 255 });
});

test('hasSelectiveHsl detects non-zero selective HSL shifts across multiple bands', () => {
  assert.equal(hasSelectiveHsl({ hslHue: 0, hslSat: 0, hslLight: 0 }), false);
  assert.equal(hasSelectiveHsl({ hslHue: 25, hslSat: 0, hslLight: 0 }), true);
  assert.equal(hasSelectiveHsl({ hslHue: 0, hslSat: -40, hslLight: 0 }), true);
  const b1 = makeHslBand('#ef4444', 'b1');
  const b2 = { ...makeHslBand('#3b82f6', 'b2'), sat: 50 };
  assert.equal(hasSelectiveHsl({ hslBands: [b1] }), false);
  assert.equal(hasSelectiveHsl({ hslBands: [b1, b2] }), true);
  assert.equal(getHslBands({ hslBands: [b1, b2] }).length, 2);
});
