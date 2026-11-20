// Frontend audio waveform / spectral graph cache and canvas renderer.

// Slices a file's full peaks/spectral arrays to the portion visible in `clip`.
export function sliceWaveform(data, clip) {
  if (!data || !Array.isArray(data.peaks) || !data.peaks.length) return { peaks: [], spectral: [] };
  const n = data.peaks.length;
  const srcDur = Number(clip && clip.srcDur) || Number(clip && clip.dur) || 0;
  if (srcDur <= 0) return { peaks: data.peaks, spectral: data.spectral || [] };

  const startSec = Math.max(0, Number(clip.srcIn) || 0);
  const usedSec = Math.max(0.01, (Number(clip.dur) || 0) * (Number(clip.speed) || 1));
  const startIdx = Math.max(0, Math.min(n - 1, Math.floor((startSec / srcDur) * n)));
  const endIdx = Math.max(startIdx + 1, Math.min(n, Math.ceil(((startSec + usedSec) / srcDur) * n)));

  return {
    peaks: data.peaks.slice(startIdx, endIdx),
    spectral: Array.isArray(data.spectral) ? data.spectral.slice(startIdx, endIdx) : [],
  };
}

// Draws a spectral-colored bar graph onto `canvas` for the given clip and waveform data.
export function drawWaveform(canvas, data, clip) {
  if (!canvas || !data) return;
  const sliced = sliceWaveform(data, clip);
  if (!sliced.peaks.length) return;

  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(16, Math.round(rect.width || canvas.clientWidth || 120));
  const cssH = Math.max(12, Math.round(rect.height || canvas.clientHeight || 28));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const vol = clip.muted ? 0 : (typeof clip.volume === 'number' ? clip.volume : 1);
  const barStep = Math.max(2 * dpr, Math.floor(3 * dpr));
  const barW = Math.max(1 * dpr, barStep - 1 * dpr);
  const bars = Math.max(1, Math.floor(w / barStep));
  const { peaks, spectral } = sliced;
  const n = peaks.length;
  const isAudioOnly = clip.kind === 'audio';

  for (let i = 0; i < bars; i++) {
    const idx = Math.min(n - 1, Math.floor((i / bars) * n));
    const amp = peaks[idx] * vol;
    const spec = spectral[idx] ?? 0.4;
    const clamped = Math.min(1, amp);
    const barH = Math.max(1.5 * dpr, clamped * (h - 2 * dpr));

    // Spectral color: low frequencies -> cyan/teal (#22D3EE), mid -> indigo, high -> bright violet (#C084FC)
    // Clipped (> 100% volume) -> warm coral (#FB7185)
    if (amp > 1.02) {
      ctx.fillStyle = 'rgba(251, 113, 133, 0.9)';
    } else {
      const r = Math.round(34 + spec * (178 - 34));
      const g = Math.round(211 - spec * (211 - 122));
      const b = Math.round(238 + spec * (252 - 238));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${isAudioOnly ? 0.85 : 0.82})`;
    }

    const x = i * barStep;
    const y = isAudioOnly ? (h - barH) / 2 : (h - barH);
    ctx.fillRect(x, y, barW, barH);
  }
}

export function createWaveformCache({ fetchWaveform }) {
  const cache = new Map();
  const pending = new Map();

  function getCached(filePath) {
    return cache.get(filePath) || null;
  }

  function request(filePath) {
    if (!filePath || !fetchWaveform) return Promise.resolve(null);
    if (cache.has(filePath)) return Promise.resolve(cache.get(filePath));
    if (pending.has(filePath)) return pending.get(filePath);
    const p = Promise.resolve()
      .then(() => fetchWaveform(filePath))
      .then((res) => {
        const val = res && res.ok && Array.isArray(res.peaks) ? { peaks: res.peaks, spectral: res.spectral || [] } : null;
        cache.set(filePath, val);
        pending.delete(filePath);
        return val;
      })
      .catch(() => {
        cache.set(filePath, null);
        pending.delete(filePath);
        return null;
      });
    pending.set(filePath, p);
    return p;
  }

  return { getCached, request };
}
