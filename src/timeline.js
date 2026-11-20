// Pure timeline model for Zaude. No DOM, so it can be tested with `node --test`.
import { getHslBands, makeHslBand, normalizeHex, MAX_HSL_BANDS } from './color.js';

export const FPS = 24;
export const SPEEDS = [0.5, 1, 2, 4];
export const TRACK_IDS = ['V2', 'V1', 'A1', 'A2'];
const EPS = 1e-6;

let seq = 0;
export function newId() {
  seq += 1;
  return 'c' + seq;
}

export const MEDIA = [
  { name: 'forest_pan.mov', kind: 'video', srcDur: 20 },
  { name: 'beach_drone.mp4', kind: 'video', srcDur: 30 },
  { name: 'market_walk.mp4', kind: 'video', srcDur: 40 },
  { name: 'interview_a.mp4', kind: 'video', srcDur: 30 },
  { name: 'voiceover_01.wav', kind: 'audio', srcDur: 60 },
];
export const INSERT_LENGTH = 6; // seconds placed on the timeline by Insert / Overwrite

export function initialClips() {
  const c = (track, name, start, dur, srcDur, extra = {}) => ({
    id: newId(), track, name, start, dur, srcDur, srcIn: 0, speed: 1, transition: 0, kind: kindOfName(name), volume: 1, opacity: 1, muted: false, ...extra,
  });
  return [
    c('V2', 'Title · Natural Moment', 2.5, 14, 14),
    c('V1', 'forest_pan.mov', 0, 9, 20),
    c('V1', 'beach_drone.mp4', 9, 13, 30),
    c('V1', 'market_walk.mp4', 24, 14, 40, { srcIn: 4 }),
    c('V1', 'interview_a.mp4', 40, 17, 30),
    c('A1', 'voiceover_01.wav', 0, 38, 60),
  ];
}

export const clipEnd = (c) => c.start + c.dur;
export const sourceUsed = (c) => c.dur * c.speed;
export const findClip = (clips, id) => clips.find((c) => c.id === id) || null;
export const clone = (clips) => clips.map((c) => ({ ...c }));

export function projectEnd(clips) {
  const latest = clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return Math.max(60, latest + 4);
}

export function timecode(sec) {
  const frames = Math.max(0, Math.round(sec * FPS));
  const pad = (n) => String(n).padStart(2, '0');
  const ff = frames % FPS;
  const s = Math.floor(frames / FPS) % 60;
  const m = Math.floor(frames / (FPS * 60)) % 60;
  const h = Math.floor(frames / (FPS * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

// Clip under the playhead on the topmost track that has one.
export function clipAt(clips, t) {
  const hits = clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
  if (!hits.length) return null;
  return hits.sort((a, b) => TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track))[0];
}

// Split every clip that straddles t (optionally only on one track).
export function splitAt(clips, t, track = null) {
  const out = [];
  for (const c of clips) {
    const eligible = track === null || c.track === track;
    if (eligible && t > c.start + EPS && t < clipEnd(c) - EPS) {
      const leftDur = t - c.start;
      out.push({ ...c, dur: leftDur });
      out.push({ ...c, id: newId(), start: t, dur: c.dur - leftDur, srcIn: c.srcIn + leftDur * c.speed, transition: 0 });
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// Move every clip on `track` that starts at or after t by delta seconds.
export function shiftFrom(clips, track, t, delta) {
  return clips.map((c) => (c.track === track && c.start >= t - EPS ? { ...c, start: c.start + delta } : c));
}

export function trimEnd(clips, id, t) {
  const c = findClip(clips, id);
  if (!c || !(t > c.start + EPS && t < clipEnd(c) - EPS)) return null;
  return clips.map((x) => (x.id === id ? { ...x, dur: t - c.start } : { ...x }));
}

export function deleteClip(clips, id) {
  return clips.filter((c) => c.id !== id).map((c) => ({ ...c }));
}

export function deleteClips(clips, ids) {
  const set = new Set(ids);
  return clips.filter((c) => !set.has(c.id)).map((c) => ({ ...c }));
}

export function rippleDelete(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const end = clipEnd(c);
  return clips
    .filter((x) => x.id !== id)
    .map((x) => (x.track === c.track && x.start >= end - EPS ? { ...x, start: x.start - c.dur } : { ...x }));
}

export function duplicateClip(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const at = clipEnd(c);
  const base = splitAt(clips, at, c.track);
  const shifted = shiftFrom(base, c.track, at, c.dur);
  return [...shifted, { ...c, id: newId(), start: at, transition: 0 }];
}

export function slipClip(clips, id, deltaSource) {
  const c = findClip(clips, id);
  if (!c) return null;
  const max = Math.max(0, c.srcDur - sourceUsed(c));
  const srcIn = Math.min(max, Math.max(0, c.srcIn + deltaSource));
  return clips.map((x) => (x.id === id ? { ...x, srcIn } : { ...x }));
}

// Cycle the clip's speed. The clip gets longer or shorter on the timeline and later clips on its track move.
export function changeSpeed(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const idx = SPEEDS.indexOf(c.speed);
  const speed = SPEEDS[(idx + 1) % SPEEDS.length];
  const newDur = sourceUsed(c) / speed;
  const delta = newDur - c.dur;
  const end = clipEnd(c);
  return clips.map((x) => {
    if (x.id === id) return { ...x, speed, dur: newDur };
    if (x.track === c.track && x.start >= end - EPS) return { ...x, start: x.start + delta };
    return { ...x };
  });
}

export function toggleTransition(clips, id) {
  const c = findClip(clips, id);
  if (!c) return null;
  const transition = c.transition ? 0 : Math.min(1, c.dur / 2);
  return clips.map((x) => (x.id === id ? { ...x, transition } : { ...x }));
}

function makeClip(track, media, start, dur) {
  return {
    id: newId(),
    track,
    name: media.name,
    start,
    dur,
    srcDur: media.srcDur,
    srcIn: 0,
    speed: 1,
    transition: 0,
    kind: media.kind || kindOfName(media.name),
    hasAudio: media.hasAudio,
    volume: 1,
    opacity: 1,
    muted: false,
  };
}

export function insertMedia(clips, track, t, media) {
  const dur = Math.min(media.srcDur, INSERT_LENGTH);
  const split = splitAt(clips, t, track);
  const shifted = shiftFrom(split, track, t, dur);
  return [...shifted, makeClip(track, media, t, dur)];
}

export function overwriteMedia(clips, track, t, media) {
  const dur = Math.min(media.srcDur, INSERT_LENGTH);
  const end = t + dur;
  let next = splitAt(clips, t, track);
  next = splitAt(next, end, track);
  next = next.filter((c) => !(c.track === track && c.start >= t - EPS && clipEnd(c) <= end + EPS));
  return [...next, makeClip(track, media, t, dur)];
}

// Snap t to the nearest clip edge within `threshold` seconds. Returns t unchanged when snapping is off.
export function snapTime(clips, t, enabled, threshold) {
  if (!enabled) return t;
  let best = t;
  let bestDist = threshold;
  for (const c of clips) {
    for (const edge of [c.start, clipEnd(c)]) {
      const d = Math.abs(edge - t);
      if (d <= bestDist) { best = edge; bestDist = d; }
    }
  }
  return best;
}

// ---------- trackpad gestures ----------

// Calibration: one full two-finger sweep across the trackpad is WHEEL_UNITS_PER_SWEEP scroll units.
// At a 60 s visible window, one sweep changes a clip by SWEEP_SECONDS_AT_60S. The rate scales with the
// visible span, so zooming in gives finer control. Adjust these two numbers to tune the feel.
export const WHEEL_UNITS_PER_SWEEP = 1000;
export const SWEEP_SECONDS_AT_60S = 0.80;
export const MIN_CLIP_DUR = 0.01;

export function secondsPerWheelUnit(visibleSpan) {
  return (SWEEP_SECONDS_AT_60S / WHEEL_UNITS_PER_SWEEP) * (visibleSpan / 60);
}

// Change the clip's end (its length). Clamped to the source media, to the next clip on the track, and to a minimum length.
export function adjustEnd(clips, id, deltaSec) {
  const c = findClip(clips, id);
  if (!c) return null;
  const nextStart = clips
    .filter((x) => x.track === c.track && x.id !== id && x.start > c.start + EPS)
    .reduce((m, x) => Math.min(m, x.start), Infinity);
  const maxBySource = (c.srcDur - c.srcIn) / c.speed;
  const maxByNeighbour = nextStart - c.start;
  const dur = Math.max(MIN_CLIP_DUR, Math.min(c.dur + deltaSec, maxBySource, maxByNeighbour));
  return clips.map((x) => (x.id === id ? { ...x, dur } : { ...x }));
}

// Move the clip's start along its track without overlapping its neighbours or going before 0.
export function moveClip(clips, id, deltaSec) {
  const c = findClip(clips, id);
  if (!c) return null;
  const others = clips.filter((x) => x.track === c.track && x.id !== id);
  const prevEnd = others.filter((x) => x.start <= c.start + EPS).reduce((m, x) => Math.max(m, clipEnd(x)), 0);
  const nextStart = others.filter((x) => x.start > c.start + EPS).reduce((m, x) => Math.min(m, x.start), Infinity);
  const start = Math.min(Math.max(c.start + deltaSec, prevEnd, 0), nextStart - c.dur);
  return clips.map((x) => (x.id === id ? { ...x, start } : { ...x }));
}

// Move a group of clips rigidly by deltaSec, stopping if any clip in the group hits 0 or an unselected neighbour.
export function moveClips(clips, ids, deltaSec) {
  const set = new Set(ids);
  const moving = clips.filter((c) => set.has(c.id));
  if (!moving.length) return null;

  let minDelta = -Infinity;
  let maxDelta = Infinity;
  for (const c of moving) {
    minDelta = Math.max(minDelta, -c.start);
    for (const o of clips) {
      if (o.track !== c.track || set.has(o.id)) continue;
      if (clipEnd(o) <= c.start + EPS) {
        minDelta = Math.max(minDelta, clipEnd(o) - c.start);
      } else if (o.start >= clipEnd(c) - EPS) {
        maxDelta = Math.min(maxDelta, o.start - clipEnd(c));
      }
    }
  }
  const applied = Math.min(maxDelta, Math.max(minDelta, deltaSec));
  return clips.map((c) => (set.has(c.id) ? { ...c, start: c.start + applied } : { ...c }));
}

// AutoCAD-style marquee selection:
// - mode 'window' (left-to-right, blue): entire rect must be inside box
// - mode 'crossing' (right-to-left, green): any intersection with box selects the item
export function selectByBox(rects, box, mode) {
  const left = Math.min(box.left, box.right);
  const right = Math.max(box.left, box.right);
  const top = Math.min(box.top, box.bottom);
  const bottom = Math.max(box.top, box.bottom);
  return rects
    .filter((r) => (mode === 'window'
      ? r.left >= left && r.right <= right && r.top >= top && r.bottom <= bottom
      : r.left <= right && r.right >= left && r.top <= bottom && r.bottom >= top))
    .map((r) => r.id);
}

// Puts a clip with the given properties on a track at t, replacing whatever it overlaps.
export function placeRange(clips, track, t, dur, props) {
  const end = t + dur;
  let next = splitAt(clips, t, track);
  next = splitAt(next, end, track);
  next = next.filter((c) => !(c.track === track && c.start >= t - EPS && clipEnd(c) <= end + EPS));
  return [...next, { track, start: t, dur, ...props }];
}

// ---------- media kinds, audio, and properties ----------

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];
const AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'];

// 'video', 'audio', or 'title' for a file name. Clips without a file are titles or generated placeholders.
export function kindOfName(name) {
  const lower = String(name || '').toLowerCase();
  if (VIDEO_EXT.some((e) => lower.endsWith(e))) return 'video';
  if (AUDIO_EXT.some((e) => lower.endsWith(e))) return 'audio';
  return 'title';
}

export const TRANSITION_TYPES = [
  { id: 'none', label: 'None' },
  { id: 'dissolve', label: 'Cross Dissolve' },
  { id: 'fade-black', label: 'Fade to Black' },
  { id: 'fade-white', label: 'Fade to White' },
  { id: 'slide-left', label: 'Slide Left' },
];

export const FILTER_PROPS = [
  'exposure', 'brightness', 'contrast', 'saturation', 'dynamics',
  'temperature', 'hue', 'tint', 'vignette', 'sharpen', 'denoise',
];

export const HSL_PROPS = ['hslHue', 'hslSat', 'hslLight', 'hslRange'];
export const TRANSFORM_PROPS = ['scale', 'rotation', 'posX', 'posY'];

const pctFmt = (v) => Math.round(v * 100) + '%';
const intFmt = (v) => String(Math.round(v));
const intPctFmt = (v) => Math.round(v) + '%';
const signedIntFmt = (v) => { const n = Math.round(v); return (n > 0 ? '+' : '') + n; };
const signedPctFmt = (v) => { const n = Math.round(v); return (n > 0 ? '+' : '') + n + '%'; };
const degFmt = (v) => { const n = Math.round(v); return (n > 0 ? '+' : '') + n + '°'; };

// Clip properties with predetermined integer steps for filters/HSL/transform (less compute, zero float churn).
export const PROPS = {
  volume: { min: 0, max: 2, step: 0.01, default: 1, label: 'Volume', format: pctFmt },
  opacity: { min: 0, max: 1, step: 0.01, default: 1, label: 'Opacity', format: pctFmt },
  blur: { min: 0, max: 100, step: 1, default: 0, label: 'Blur', format: intFmt },
  scale: { min: 10, max: 400, step: 1, default: 100, label: 'Scale', format: intPctFmt },
  rotation: { min: -180, max: 180, step: 1, default: 0, label: 'Rotate', format: degFmt },
  posX: { min: -100, max: 100, step: 1, default: 0, label: 'Position X', format: signedPctFmt },
  posY: { min: -100, max: 100, step: 1, default: 0, label: 'Position Y', format: signedPctFmt },
  exposure: { min: -100, max: 100, step: 1, default: 0, label: 'Lighting', format: signedIntFmt },
  brightness: { min: 0, max: 100, step: 1, default: 50, label: 'Brightness', format: intFmt },
  contrast: { min: 0, max: 100, step: 1, default: 50, label: 'Contrast', format: intFmt },
  saturation: { min: 0, max: 100, step: 1, default: 50, label: 'Saturation', format: intFmt },
  dynamics: { min: -100, max: 100, step: 1, default: 0, label: 'Dynamics', format: signedIntFmt },
  temperature: { min: -100, max: 100, step: 1, default: 0, label: 'Temperature', format: signedIntFmt },
  hue: { min: -180, max: 180, step: 1, default: 0, label: 'Global Hue', format: degFmt },
  tint: { min: -100, max: 100, step: 1, default: 0, label: 'Color Tint', format: signedIntFmt },
  vignette: { min: 0, max: 100, step: 1, default: 0, label: 'Vignette', format: intFmt },
  sharpen: { min: 0, max: 100, step: 1, default: 0, label: 'Sharpen', format: intFmt },
  denoise: { min: 0, max: 100, step: 1, default: 0, label: 'Remove Noise', format: intFmt },
  hslHue: { min: -180, max: 180, step: 1, default: 0, label: 'Color Hue', format: degFmt },
  hslSat: { min: -100, max: 100, step: 1, default: 0, label: 'Color Sat', format: signedIntFmt },
  hslLight: { min: -100, max: 100, step: 1, default: 0, label: 'Color Light', format: signedIntFmt },
  hslRange: { min: 1, max: 100, step: 1, default: 35, label: 'Color Range', format: intFmt },
  transition: { min: 0.1, max: 3, step: 0.1, default: 0.5, label: 'Duration', format: (v) => v.toFixed(1) + ' s' },
  // framing: zoom into the clip and choose which part stays in frame (-100 left/top … +100 right/bottom)
  zoom: { min: 1, max: 4, step: 0.01, default: 1, label: 'Zoom', format: (v) => '×' + v.toFixed(2) },
  panX: { min: -100, max: 100, step: 1, default: 0, label: 'Pan X', format: signedIntFmt },
  panY: { min: -100, max: 100, step: 1, default: 0, label: 'Pan Y', format: signedIntFmt },
};

export function propValue(clip, prop) {
  const def = PROPS[prop];
  const v = clip[prop];
  return typeof v === 'number' ? v : def.default;
}

export function setProp(clips, id, prop, value) {
  const def = PROPS[prop];
  if (!def) return null;
  const snapped = def.step === 1
    ? Math.round(value)
    : Number((Math.round(value / def.step) * def.step).toFixed(4));
  const v = Math.min(def.max, Math.max(def.min, snapped));
  return clips.map((c) => (c.id === id ? { ...c, [prop]: v } : { ...c }));
}

export function resetFilters(clips, id) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    const next = { ...c };
    for (const key of FILTER_PROPS) next[key] = PROPS[key].default;
    for (const key of HSL_PROPS) next[key] = PROPS[key].default;
    next.hslBands = [makeHslBand('#ef4444', 'hb0')];
    next.hslActiveBand = 'hb0';
    next.blur = 0;
    return next;
  });
}

export function resetHsl(clips, id) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    const next = { ...c };
    for (const key of HSL_PROPS) next[key] = PROPS[key].default;
    next.hslBands = [makeHslBand('#ef4444', 'hb0')];
    next.hslActiveBand = 'hb0';
    return next;
  });
}

const BAND_PROP_MAP = { hue: 'hslHue', sat: 'hslSat', light: 'hslLight', range: 'hslRange' };

export function addHslBand(clips, id, hex = '#3b82f6') {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    const bands = getHslBands(c).map((b) => ({ ...b }));
    if (bands.length >= MAX_HSL_BANDS) return { ...c, hslBands: bands };
    const band = makeHslBand(hex);
    bands.push(band);
    return { ...c, hslBands: bands, hslActiveBand: band.id };
  });
}

export function removeHslBand(clips, id, bandId) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    const bands = getHslBands(c).filter((b) => b.id !== bandId).map((b) => ({ ...b }));
    const nextBands = bands.length ? bands : [makeHslBand('#ef4444', 'hb0')];
    const active = nextBands.some((b) => b.id === c.hslActiveBand) ? c.hslActiveBand : nextBands[0].id;
    return { ...c, hslBands: nextBands, hslActiveBand: active };
  });
}

export function updateHslBand(clips, id, bandId, patch) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    const bands = getHslBands(c).map((b) => {
      if (b.id !== bandId) return { ...b };
      const next = { ...b };
      if (patch.hex !== undefined) next.hex = normalizeHex(patch.hex, b.hex);
      for (const [k, propKey] of Object.entries(BAND_PROP_MAP)) {
        if (patch[k] !== undefined) {
          const def = PROPS[propKey];
          const v = Math.min(def.max, Math.max(def.min, Math.round(Number(patch[k]) / def.step) * def.step));
          next[k] = Number(v.toFixed(4));
        }
      }
      return next;
    });
    return { ...c, hslBands: bands, hslActiveBand: bandId };
  });
}

export function setTransition(clips, id, type, duration) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    if (!type || type === 'none') return { ...c, transitionType: 'none', transition: 0 };
    const maxDur = Math.max(0.1, c.dur / 2);
    const dur = Math.min(maxDur, Math.max(0.1, Number(duration) || (c.transition > 0 ? c.transition : 0.5)));
    return { ...c, transitionType: type, transition: Number(dur.toFixed(2)) };
  });
}

// Returns true when any integer filter prop (other than blur) is modified from its default.
export function hasColorFilters(clip) {
  if (!clip) return false;
  return FILTER_PROPS.some((p) => propValue(clip, p) !== PROPS[p].default);
}

// Builds a CSS filter string (used as fallback or for blur; color grading runs on GPU WebGL).
export function buildCssFilter(clip) {
  if (!clip) return 'none';
  const parts = [];
  const brightness = Math.max(0.05, (propValue(clip, 'brightness') / 50) + (propValue(clip, 'exposure') / 100) * 0.5);
  const contrast = Math.max(0.1, (propValue(clip, 'contrast') / 50) + (propValue(clip, 'dynamics') / 100) * 0.35 + (propValue(clip, 'sharpen') / 100) * 0.18);
  const sat = Math.max(0, (propValue(clip, 'saturation') / 50) + (propValue(clip, 'dynamics') / 100) * 0.25);
  const temp = propValue(clip, 'temperature') / 100;
  const tint = propValue(clip, 'tint') / 100;
  const hue = propValue(clip, 'hue') + tint * 45 - temp * 12;
  const blur = (propValue(clip, 'blur') / 100) * 20 + (propValue(clip, 'denoise') / 100) * 0.8;

  if (Math.abs(brightness - 1) > 0.005) parts.push(`brightness(${brightness.toFixed(3)})`);
  if (Math.abs(contrast - 1) > 0.005) parts.push(`contrast(${contrast.toFixed(3)})`);
  if (Math.abs(sat - 1) > 0.005) parts.push(`saturate(${sat.toFixed(3)})`);
  if (temp > 0.01) parts.push(`sepia(${(temp * 0.35).toFixed(3)})`);
  if (Math.abs(hue) > 0.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

export function resetTransform(clips, id) {
  return clips.map((c) => {
    if (c.id !== id) return { ...c };
    return {
      ...c,
      scale: PROPS.scale.default,
      rotation: PROPS.rotation.default,
      posX: PROPS.posX.default,
      posY: PROPS.posY.default,
      flipH: false,
      flipV: false,
    };
  });
}

// Builds a real-time CSS transform string for position, rotation, scale, zoom/pan framing, and mirror.
export function buildCssTransform(clip, extraTranslateX = 0) {
  if (!clip) return 'none';
  const parts = [];
  const px = propValue(clip, 'posX') + extraTranslateX;
  const py = propValue(clip, 'posY');
  if (Math.abs(px) > 0.01 || Math.abs(py) > 0.01) {
    parts.push(`translate(${px.toFixed(2)}%, ${py.toFixed(2)}%)`);
  }
  const rot = propValue(clip, 'rotation');
  if (Math.abs(rot) > 0.01) parts.push(`rotate(${Math.round(rot)}deg)`);
  const sc = propValue(clip, 'scale') / 100;
  if (Math.abs(sc - 1) > 0.001) parts.push(`scale(${sc.toFixed(3)})`);
  // zoom + pan: panX/panY of ±100 move the view to the edge of the zoomed picture
  const z = typeof clip.zoom === 'number' && clip.zoom > 1 ? clip.zoom : 1;
  if (z > 1) {
    const k = ((z - 1) / (2 * z)) * 100;
    const tx = -((Number(clip.panX) || 0) / 100) * k;
    const ty = -((Number(clip.panY) || 0) / 100) * k;
    parts.push(`scale(${z.toFixed(3)})`);
    if (Math.abs(tx) > 0.01 || Math.abs(ty) > 0.01) parts.push(`translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`);
  }
  const sx = clip.flipH ? -1 : 1;
  const sy = clip.flipV ? -1 : 1;
  if (sx !== 1 || sy !== 1) parts.push(`scale(${sx}, ${sy})`);
  return parts.length ? parts.join(' ') : 'none';
}

// Computes live transition visual state at timeline time `t`.
export function transitionState(clip, t) {
  const base = { opacityMul: 1, overlayColor: null, overlayOpacity: 0, translateX: 0 };
  if (!clip) return base;
  const dur = Number(clip.transition) || 0;
  const type = clip.transitionType || (dur > 0 ? 'dissolve' : 'none');
  if (dur <= 0 || type === 'none') return base;

  const elapsed = t - clip.start;
  const remaining = clipEnd(clip) - t;
  let progress = 1; // 1 = fully visible, 0 = fully transitioned
  if (elapsed >= 0 && elapsed < dur) {
    progress = Math.min(1, Math.max(0, elapsed / dur));
  } else if (remaining >= 0 && remaining < dur && (type === 'fade-black' || type === 'fade-white')) {
    progress = Math.min(1, Math.max(0, remaining / dur));
  }
  if (progress >= 1) return base;

  if (type === 'dissolve') return { ...base, opacityMul: progress };
  if (type === 'fade-black') return { ...base, overlayColor: '#000000', overlayOpacity: 1 - progress };
  if (type === 'fade-white') return { ...base, overlayColor: '#ffffff', overlayOpacity: 1 - progress };
  if (type === 'slide-left') return { ...base, translateX: (1 - progress) * 100 };
  return base;
}

// Puts the audio of a video clip on a free audio track as its own clip, and mutes the video.
// Returns { clips } or { error }.
export function detachAudio(clips, id) {
  const c = findClip(clips, id);
  if (!c || c.kind !== 'video') return { error: 'Select a video clip to detach its audio.' };
  if (c.hasAudio === false) return { error: 'This clip has no audio track.' };
  if (c.muted) return { error: 'This clip’s audio is already detached.' };
  const busy = (track) => clips.some((x) => x.track === track && x.start < clipEnd(c) - EPS && clipEnd(x) > c.start + EPS);
  const track = ['A1', 'A2'].find((t) => !busy(t));
  if (!track) return { error: 'No free audio track at this point. Clear space on Audio 1 or Audio 2 first.' };
  const audio = { ...c, id: newId(), track, kind: 'audio', muted: false, volume: c.volume ?? 1, opacity: 1, transition: 0, linkedTo: c.id, name: c.name + ' (audio)' };
  const video = { ...c, muted: true };
  return { clips: [...clips.filter((x) => x.id !== id).map((x) => ({ ...x })), video, audio] };
}

// Inserts a media file from the bin at t on a track, moving later clips on that track to the right.
export function insertFile(clips, track, t, file) {
  const dur = Math.max(0.1, Number(file.duration) || 5);
  const split = splitAt(clips, t, track);
  const shifted = shiftFrom(split, track, t, dur);
  return [...shifted, {
    id: newId(), track, start: t, dur, name: file.name, path: file.path,
    kind: file.kind || kindOfName(file.name), hasAudio: file.hasAudio, srcDur: dur,
    srcIn: 0, speed: 1, transition: 0, volume: 1, opacity: 1, muted: false,
  }];
}

// Sets one flag on a clip (for example muted). Returns a new clip list.
export function setFlag(clips, id, key, value) {
  return clips.map((c) => (c.id === id ? { ...c, [key]: value } : { ...c }));
}
