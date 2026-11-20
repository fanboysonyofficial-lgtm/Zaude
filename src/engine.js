// Playback engine: one video element for the picture and sound of the topmost video clip,
// one audio element per audio clip, and a clock that moves the playhead while playing.
// Media files are played through the desktop app's media route (window.zaudeAI.mediaUrl).
import * as T from './timeline.js';
import { hasSelectiveHsl, rgbToHex } from './color.js';
import { createHslRenderer } from './hsl-gl.js';

const EPS_SEEK = 0.15; // seconds of drift allowed before the media is moved

export function createEngine(store) {
  const video = document.createElement('video');
  video.className = 'program-video';
  video.playsInline = true;
  video.preload = 'auto';
  video.hidden = true;
  video.addEventListener('loadedmetadata', () => sync());
  // Re-render GPU frame on seeked/loadeddata without re-seeking (prevents infinite seek loops).
  const refreshGpuFrame = () => {
    const s = store.get();
    const vc = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), s.playhead);
    if (vc && (hasSelectiveHsl(vc) || T.hasColorFilters(vc))) {
      if (hslGl.render(video, vc)) {
        hslGl.canvas.hidden = false;
        video.style.visibility = 'hidden';
      }
    }
  };
  video.addEventListener('seeked', refreshGpuFrame);
  video.addEventListener('loadeddata', refreshGpuFrame);

  const hslGl = createHslRenderer();
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1;
  sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  // Overlay for vignette and fade-to-black / fade-to-white transitions.
  const fxOverlay = document.createElement('div');
  fxOverlay.className = 'viewer-fx-overlay';
  fxOverlay.setAttribute('aria-hidden', 'true');

  const urlCache = new Map();
  let videoClipId = null;
  let videoToken = 0;
  let audioCtx = null;
  const videoGain = { node: null, tried: false };
  const audioEls = new Map(); // clip id -> { el, gain, path, token }
  let rafId = 0;
  let lastTs = 0;

  const zaudioApi = () => window.zaudeAI || null;

  async function urlFor(filePath) {
    if (urlCache.has(filePath)) return urlCache.get(filePath);
    const api = zaudioApi();
    if (!api || !api.mediaUrl) return null;
    const res = await api.mediaUrl(filePath);
    const url = res && res.ok ? res.url : null;
    if (url) urlCache.set(filePath, url);
    return url;
  }

  function context() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // Routes an element through a gain node so volume can go above 100%.
  function gainFor(el) {
    const ctx = context();
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    return gain;
  }

  const srcTime = (c, t) => c.srcIn + (t - c.start) * (c.speed || 1);
  const isActive = (c, t) => t >= c.start - 1e-6 && t < c.start + c.dur - 1e-6;

  function setGain(gain, el, clip) {
    const vol = clip.muted ? 0 : T.propValue(clip, 'volume');
    if (gain) {
      gain.gain.value = vol;
      el.muted = false;
    } else {
      el.muted = Boolean(clip.muted);
      el.volume = Math.min(1, Math.max(0, vol));
    }
  }

  function setRate(el, clip) {
    const rate = clip.speed || 1;
    if (el.playbackRate !== rate) {
      try { el.playbackRate = rate; } catch { /* unsupported rate */ }
    }
  }

  function seek(el, want) {
    if (el.readyState < 1 || el.seeking) return;
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
    const clamped = Math.min(Math.max(0, want), Math.max(0, dur - 0.02));
    if (Math.abs(el.currentTime - clamped) > EPS_SEEK || (el.paused && Math.abs(el.currentTime - clamped) > 0.04)) {
      try { el.currentTime = clamped; } catch { /* not loaded yet */ }
    }
  }

  function sync() {
    const s = store.get();
    const t = s.playhead;
    const playing = !!s.playing;

    // picture and sound of the topmost video clip with a file
    const vc = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), t);
    if (!vc) {
      video.hidden = true;
      video.style.visibility = '';
      hslGl.canvas.hidden = true;
      if (!video.paused) video.pause();
      videoClipId = null;
      fxOverlay.style.background = 'none';
      fxOverlay.style.boxShadow = 'none';
    } else {
      if (videoClipId !== vc.id) {
        videoClipId = vc.id;
        const token = ++videoToken;
        urlFor(vc.path).then((url) => {
          if (token !== videoToken || !url) return;
          if (video.src !== url) video.src = url;
        });
      }
      const tr = T.transitionState(vc, t);
      const opStr = String(T.propValue(vc, 'opacity') * tr.opacityMul);
      const transformStr = T.buildCssTransform(vc, tr.translateX);
      const blurPx = (T.propValue(vc, 'blur') / 100) * 20 + (T.propValue(vc, 'denoise') / 100) * 0.8;
      const blurOnlyFilter = blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : 'none';
      const useGpu = hasSelectiveHsl(vc) || T.hasColorFilters(vc);

      video.hidden = false;
      video.style.opacity = opStr;
      video.style.transform = transformStr;

      if (useGpu && hslGl.render(video, vc)) {
        hslGl.canvas.hidden = false;
        hslGl.canvas.style.opacity = opStr;
        hslGl.canvas.style.filter = blurOnlyFilter;
        hslGl.canvas.style.transform = transformStr;
        video.style.filter = 'none';
        video.style.visibility = 'hidden';
      } else {
        hslGl.canvas.hidden = true;
        video.style.filter = T.buildCssFilter(vc);
        video.style.visibility = '';
      }

      // Fade-to-black / fade-to-white transition overlay (vignette runs on GPU when WebGL is active)
      const layers = [];
      if (tr.overlayColor && tr.overlayOpacity > 0.005) {
        const rgb = tr.overlayColor === '#ffffff' ? '255,255,255' : '0,0,0';
        layers.push(`linear-gradient(rgba(${rgb},${tr.overlayOpacity.toFixed(3)}), rgba(${rgb},${tr.overlayOpacity.toFixed(3)}))`);
      }
      if (hslGl.canvas.hidden) {
        const vig = T.propValue(vc, 'vignette') / 100;
        if (vig > 0.005) {
          const inner = Math.max(25, 65 - vig * 30);
          layers.push(`radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,${(vig * 0.88).toFixed(3)}) 100%)`);
        }
      }
      fxOverlay.style.background = layers.length ? layers.join(', ') : 'none';
      if (!videoGain.tried) {
        videoGain.tried = true;
        try { videoGain.node = gainFor(video); } catch { videoGain.node = null; }
      }
      setGain(videoGain.node, video, vc);
      setRate(video, vc);
      seek(video, srcTime(vc, t));
      if (playing && video.paused) video.play().catch(() => {});
      if (!playing && !video.paused) video.pause();
    }

    // audio clips: reuse one audio element per track (A1, A2, ...) so cuts on the same
    // source file never recreate <audio> elements or re-buffer from scratch.
    const activeTracks = new Set();
    for (const c of s.clips) {
      if (c.kind !== 'audio' || !c.path) continue;
      if (!isActive(c, t)) continue;
      const key = c.track || c.id;
      activeTracks.add(key);
      let entry = audioEls.get(key);
      if (!entry) {
        const el = document.createElement('audio');
        el.preload = 'auto';
        el.addEventListener('loadedmetadata', () => sync());
        el.addEventListener('canplay', () => sync());
        el.addEventListener('seeked', () => sync());
        entry = { el, gain: null, gainTried: false, path: null, token: 0 };
        audioEls.set(key, entry);
      }
      if (entry.path !== c.path) {
        entry.path = c.path;
        const token = ++entry.token;
        urlFor(c.path).then((url) => {
          if (!url || entry.token !== token) return;
          if (entry.el.src !== url) {
            entry.el.src = url;
            entry.el.load();
          }
          sync();
        });
      }
      if (!entry.gain && !entry.gainTried) {
        entry.gainTried = true;
        try { entry.gain = gainFor(entry.el); } catch { entry.gain = null; }
      }
      setGain(entry.gain, entry.el, c);
      setRate(entry.el, c);
      seek(entry.el, srcTime(c, t));
      if (playing && entry.el.paused && entry.el.readyState >= 2 && !entry.el.seeking) {
        entry.el.play().catch(() => {});
      }
      if (!playing && !entry.el.paused) entry.el.pause();
    }
    for (const [key, entry] of audioEls) {
      if (!activeTracks.has(key) && !entry.el.paused) {
        entry.el.pause();
      }
    }
  }

  function stopClock() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function tick(ts) {
    const s = store.get();
    if (!s.playing) { stopClock(); return; }
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const end = T.projectEnd(s.clips);
    if (s.playhead + dt >= end) {
      store.setTime(end);
      store.set({ playing: false });
      sync();
      stopClock();
      return;
    }
    store.setTime(s.playhead + dt);
    sync();
    rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (store.get().playing) return;
    const ctx = context();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    lastTs = performance.now();
    store.set({ playing: true });
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    if (!store.get().playing) return;
    store.set({ playing: false });
    stopClock();
    sync();
  }

  function toggle() {
    if (store.get().playing) pause();
    else play();
  }

  // Changes the playhead without playing: used by the ruler, the scrub bar, and the keyboard.
  function seekTo(t) {
    const end = T.projectEnd(store.get().clips);
    store.setTime(Math.min(end, Math.max(0, t)));
    sync();
  }

  // Samples the exact pixel from the current video frame under (clientX, clientY) inside stageEl.
  function samplePixel(clientX, clientY, stageEl) {
    if (video.hidden || video.readyState < 2 || !video.videoWidth || !video.videoHeight || !stageEl) return null;
    const r = stageEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(r.width / vw, r.height / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const offX = (r.width - drawW) / 2;
    const offY = (r.height - drawH) / 2;
    let fx = (clientX - r.left - offX) / drawW;
    let fy = (clientY - r.top - offY) / drawH;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    const s = store.get();
    const vc = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), s.playhead);
    if (vc && vc.flipH) fx = 1 - fx;
    if (vc && vc.flipV) fy = 1 - fy;
    const sx = Math.min(vw - 1, Math.max(0, Math.floor(fx * vw)));
    const sy = Math.min(vh - 1, Math.max(0, Math.floor(fy * vh)));
    try {
      sampleCtx.drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1);
      const [red, green, blue] = sampleCtx.getImageData(0, 0, 1, 1).data;
      return { r: red, g: green, b: blue, hex: rgbToHex(red, green, blue) };
    } catch {
      return null;
    }
  }

  store.subscribe(() => sync());
  store.subscribeTime(() => sync());

  return { video, glCanvas: hslGl.canvas, fxOverlay, play, pause, toggle, seekTo, sync, getMediaUrl: urlFor, samplePixel, getGpuInfo: hslGl.getGpuInfo };
}
