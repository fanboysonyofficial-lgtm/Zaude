// Ctrl controls for values. Hold Ctrl and drag, or Ctrl and scroll, over a value to change it.
// - Clip blocks on the timeline: Ctrl + vertical scroll changes the clip's volume. Ctrl + horizontal
//   scroll changes the clip's length, and Shift and Alt scroll move and slip it (see gestures below).
// - Value fields (the inspector): Ctrl + any direction changes the value.
import * as T from './timeline.js';
import { getHslBands } from './color.js';

export const SENS_WHEEL = 0.0015; // fraction of property range per scroll pixel
export const SENS_DRAG = 0.0045;  // fraction of property range per dragged pixel

// The scroll amount along the dominant axis, positive meaning "up" or "right".
export function dominantScroll(e) {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
  const px = (vertical ? -e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
  return { vertical, px };
}

export function scrubbedValue(clip, prop, amount) {
  const def = T.PROPS[prop];
  const v = T.propValue(clip, prop) + amount;
  return Math.min(def.max, Math.max(def.min, v));
}

// Trackpad length/move/slip gestures on the timeline (Ctrl, Shift, Alt with a horizontal swipe).
export function gestureMode(e) {
  if (e.ctrlKey) return 'length';
  if (e.shiftKey) return 'move';
  if (e.altKey) return 'slip';
  return null;
}

export function installScrub(root, { store, actions }) {
  // Ctrl + scroll over a value (inspector) or a clip block (timeline volume)
  root.addEventListener('wheel', (e) => {
    const s = store.get();
    const field = e.target.closest('[data-scrub-prop]');
    const blk = e.target.closest('.blk[data-clip]');
    if (field && e.ctrlKey) {
      e.preventDefault();
      const clip = T.findClip(s.clips, field.dataset.scrubClip);
      if (!clip) return;
      const prop = field.dataset.scrubProp;
      const def = T.PROPS[prop];
      if (!def) return;
      const span = def.max - def.min;
      const { px } = dominantScroll(e);
      if (field.dataset.scrubBand) {
        const band = getHslBands(clip).find((b) => b.id === field.dataset.scrubBand);
        if (!band) return;
        const key = field.dataset.scrubBandKey;
        const cur = typeof band[key] === 'number' ? band[key] : def.default;
        actions.setHslBandProp(clip.id, band.id, key, Math.min(def.max, Math.max(def.min, cur + px * SENS_WHEEL * span)));
      } else {
        actions.setProp(clip.id, prop, scrubbedValue(clip, prop, px * SENS_WHEEL * span));
      }
      return;
    }
    if (blk && e.ctrlKey) {
      const { vertical, px } = dominantScroll(e);
      if (vertical) {
        e.preventDefault();
        const clip = T.findClip(s.clips, blk.dataset.clip);
        if (clip && (clip.kind === 'audio' || clip.kind === 'video')) {
          actions.setProp(clip.id, 'volume', scrubbedValue(clip, 'volume', px * SENS_WHEEL));
        }
        return;
      }
    }
    // length, move, and slip on the selected clip
    const onTimeline = e.target.closest('.timeline .scroller');
    const mode = onTimeline ? gestureMode(e) : null;
    if (mode) {
      const { px } = { px: e.deltaX * (e.deltaMode === 1 ? 16 : 1) };
      if (Math.abs(px) <= Math.abs(e.deltaY)) { e.preventDefault(); return; } // pinch and vertical scroll
      e.preventDefault();
      actions.gesture(mode, px);
    }
  }, { passive: false });

  // Drag (with or without Ctrl) over a value field in the Inspector
  root.addEventListener('pointerdown', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field || e.button !== 0) return;
    e.preventDefault();
    const s = store.get();
    const clip = T.findClip(s.clips, field.dataset.scrubClip);
    if (!clip) return;
    const prop = field.dataset.scrubProp;
    const def = T.PROPS[prop];
    if (!def) return;
    const span = def.max - def.min;
    const bandId = field.dataset.scrubBand || null;
    const bandKey = field.dataset.scrubBandKey || null;
    let start;
    if (bandId) {
      const band = getHslBands(clip).find((b) => b.id === bandId);
      if (!band) return;
      start = typeof band[bandKey] === 'number' ? band[bandKey] : def.default;
    } else {
      start = T.propValue(clip, prop);
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => {
      const amount = ((ev.clientX - x0) - (ev.clientY - y0)) * SENS_DRAG * span;
      const nextVal = Math.min(def.max, Math.max(def.min, start + amount));
      if (bandId) actions.setHslBandProp(clip.id, bandId, bandKey, nextVal);
      else actions.setProp(clip.id, prop, nextVal);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
