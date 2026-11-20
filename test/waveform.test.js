import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sliceWaveform } from '../src/waveform.js';

const require = createRequire(import.meta.url);
const { computePeaks } = require('../electron/waveform.cjs');

test('computePeaks returns empty arrays for empty PCM', () => {
  assert.deepEqual(computePeaks(Buffer.alloc(0), 16), { peaks: [], spectral: [] });
});

test('computePeaks normalizes amplitude and distinguishes low vs high frequency energy', () => {
  const samples = 400;
  const buf = Buffer.alloc(samples * 2);
  // First half: slow low-frequency wave; second half: fast alternating high-frequency signal
  for (let i = 0; i < samples; i++) {
    const v = i < 200
      ? Math.round(Math.sin((i / 200) * Math.PI * 2) * 16000)
      : (i % 2 === 0 ? 16000 : -16000);
    buf.writeInt16LE(v, i * 2);
  }
  const { peaks, spectral } = computePeaks(buf, 4);
  assert.equal(peaks.length, 4);
  assert.equal(spectral.length, 4);
  assert.ok(Math.max(...peaks) === 1);
  assert.ok(spectral[2] > spectral[0], 'high-frequency section should have higher spectral value');
});

test('sliceWaveform returns the sub-range matching srcIn, dur, and speed', () => {
  const data = {
    peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    spectral: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  };
  const sliced = sliceWaveform(data, { srcIn: 2, dur: 2, speed: 2, srcDur: 10 });
  assert.deepEqual(sliced.peaks, [0.3, 0.4, 0.5, 0.6]);
});
