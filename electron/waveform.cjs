// Extracts a compact audio amplitude + spectral-brightness summary from a media file using ffmpeg.
// Uses a serial queue (max 1 ffmpeg at a time) and bounded cache to keep system RAM usage tiny.
const { spawn } = require('node:child_process');

const DEFAULT_BUCKETS = 256;
const SAMPLE_RATE = 2000; // 2 kHz mono s16le = 4 KB/s (fast decode, tiny memory footprint)
const MAX_CACHE_ENTRIES = 60;
const MAX_BYTES = 4 * 1024 * 1024; // cap at 4 MB (~17 min at 2 kHz mono)

// Pure PCM analyzer: converts 16-bit signed little-endian mono PCM into normalized peak & spectral arrays.
function computePeaks(pcmBuffer, buckets = DEFAULT_BUCKETS) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0 || buckets <= 0) return { peaks: [], spectral: [] };

  const count = Math.min(buckets, sampleCount);
  const peaks = new Array(count);
  const spectral = new Array(count);
  let maxPeak = 0;

  for (let b = 0; b < count; b++) {
    const start = Math.floor((b * sampleCount) / count);
    const end = Math.max(start + 1, Math.floor(((b + 1) * sampleCount) / count));
    let peak = 0;
    let absSum = 0;
    let diffSum = 0;
    let prev = pcmBuffer.readInt16LE(start * 2) / 32768;

    for (let i = start; i < end; i++) {
      const s = pcmBuffer.readInt16LE(i * 2) / 32768;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      absSum += a;
      diffSum += Math.abs(s - prev);
      prev = s;
    }

    peaks[b] = peak;
    if (peak > maxPeak) maxPeak = peak;
    spectral[b] = absSum > 1e-6 ? Math.min(1, diffSum / (absSum * 1.4)) : 0;
  }

  const norm = maxPeak > 0.02 ? maxPeak : 1;
  for (let b = 0; b < count; b++) {
    peaks[b] = Math.round((peaks[b] / norm) * 1000) / 1000;
    spectral[b] = Math.round(spectral[b] * 1000) / 1000;
  }
  return { peaks, spectral };
}

const cache = new Map();
const queue = [];
let busy = false;

function setCache(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

function runOne({ filePath, buckets, ffmpeg, key, resolve }) {
  let child;
  try {
    child = spawn(ffmpeg, [
      '-v', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1',
    ], { windowsHide: true });
  } catch (e) {
    resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message });
    return Promise.resolve();
  }

  return new Promise((done) => {
    const chunks = [];
    let totalBytes = 0;

    child.stdout.on('data', (chunk) => {
      if (totalBytes >= MAX_BYTES) return;
      const take = totalBytes + chunk.length > MAX_BYTES ? chunk.subarray(0, MAX_BYTES - totalBytes) : chunk;
      chunks.push(take);
      totalBytes += take.length;
    });

    const finish = (res) => {
      resolve(res);
      done();
    };
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', () => {
      const pcm = chunks.length ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0);
      const result = { ok: true, ...computePeaks(pcm, buckets) };
      setCache(key, result);
      finish(result);
    });
  });
}

async function pumpQueue() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (cache.has(job.key)) {
        job.resolve(cache.get(job.key));
        continue;
      }
      await runOne(job);
    }
  } finally {
    busy = false;
  }
}

function extractWaveform(filePath, { buckets = DEFAULT_BUCKETS, ffmpeg = 'ffmpeg' } = {}) {
  const key = `${filePath}|${buckets}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return new Promise((resolve) => {
    queue.push({ filePath, buckets, ffmpeg, key, resolve });
    pumpQueue();
  });
}

module.exports = { DEFAULT_BUCKETS, computePeaks, extractWaveform };
