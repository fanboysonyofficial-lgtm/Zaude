// Lightweight video thumbnail cache and sequential frame extractor.
// Uses a single hidden <video> + <canvas> queue so thumbnails never stall the UI.

export const TIMELINE_STAGE_SEC = 10;

// Computes the filmstrip stages for a timeline clip.
// Clips <= 10s get a single starting-frame preview; clips > 10s get one stage every 10s.
export function timelineThumbStages(clip) {
  const dur = Math.max(0, Number(clip && clip.dur) || 0);
  if (dur <= 0) return [];
  const srcIn = Number(clip.srcIn) || 0;
  const speed = Number(clip.speed) || 1;
  const maxSrc = Number.isFinite(clip.srcDur) && clip.srcDur > 0 ? Math.max(0, clip.srcDur - 0.05) : Infinity;

  if (dur <= TIMELINE_STAGE_SEC) {
    return [{ offset: 0, span: dur, srcTime: Math.min(maxSrc, srcIn) }];
  }

  const stages = [];
  for (let offset = 0; offset < dur - 1e-6; offset += TIMELINE_STAGE_SEC) {
    const span = Math.min(TIMELINE_STAGE_SEC, dur - offset);
    const srcTime = Math.min(maxSrc, srcIn + offset * speed);
    stages.push({ offset, span, srcTime });
  }
  return stages;
}

const keyFor = (filePath, timeSec) => `${filePath}@${Math.round(Math.max(0, timeSec) * 4) / 4}`;
const MAX_THUMB_CACHE = 100;

export function createThumbCache({ getMediaUrl }) {
  const cache = new Map();    // key -> dataURL (string) or null (failed)
  const pending = new Map();  // key -> Promise<string|null>
  const queue = [];
  let running = false;
  let video = null;
  let canvas = null;
  let ctx = null;
  let currentUrl = null;
  let releaseTimer = null;

  function setCache(key, val) {
    if (cache.size >= MAX_THUMB_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    cache.set(key, val);
  }

  function scheduleRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (running || !video) return;
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      currentUrl = null;
    }, 1500);
  }

  function ensureElements() {
    if (video) return;
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 135;
    ctx = canvas.getContext('2d');
  }

  function waitEvent(el, okEvent, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeEventListener(okEvent, onOk);
        el.removeEventListener('error', onErr);
        fn(val);
      };
      const onOk = () => finish(resolve);
      const onErr = () => finish(reject, new Error('video error'));
      const timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
      el.addEventListener(okEvent, onOk, { once: true });
      el.addEventListener('error', onErr, { once: true });
    });
  }

  async function captureFrame(url, timeSec) {
    ensureElements();
    if (currentUrl !== url) {
      currentUrl = url;
      video.src = url;
      await waitEvent(video, 'loadeddata');
    } else if (video.readyState < 2) {
      await waitEvent(video, 'loadeddata');
    }

    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const target = dur > 0 ? Math.min(Math.max(0, timeSec), Math.max(0, dur - 0.05)) : 0;

    if (Math.abs(video.currentTime - target) > 0.04) {
      const seeking = waitEvent(video, 'seeked');
      video.currentTime = target;
      await seeking;
    }

    const vw = video.videoWidth || 240;
    const vh = video.videoHeight || 135;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  async function pump() {
    if (running) return;
    clearTimeout(releaseTimer);
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        let dataUrl = null;
        try {
          const url = await getMediaUrl(job.filePath);
          if (url) dataUrl = await captureFrame(url, job.timeSec);
        } catch {
          dataUrl = null;
        }
        setCache(job.key, dataUrl);
        pending.delete(job.key);
        job.resolve(dataUrl);
      }
    } finally {
      running = false;
      scheduleRelease();
    }
  }

  function getCached(filePath, timeSec) {
    return cache.get(keyFor(filePath, timeSec)) || null;
  }

  function request(filePath, timeSec) {
    if (!filePath || !getMediaUrl) return Promise.resolve(null);
    const key = keyFor(filePath, timeSec);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    const promise = new Promise((resolve) => {
      queue.push({ key, filePath, timeSec, resolve });
      pump();
    });
    pending.set(key, promise);
    return promise;
  }

  return { getCached, request };
}
