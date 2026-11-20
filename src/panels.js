// The content of each window type. Every panel builds its DOM once, updates from the store,
// and uses delegated listeners so it can be moved or rebuilt without losing state.
import * as T from './timeline.js';
import { TOOLS, PAGES, EXPORT_PRESETS, ASPECT_RATIOS, RES_TIERS, exportDimensions } from './actions.js';
import { timelineThumbStages } from './thumbs.js';
import { drawWaveform } from './waveform.js';
import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex, normalizeHex, getHslBands, isBandActive, MAX_HSL_BANDS } from './color.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TRACKS = [
  { id: 'V2', label: 'Video 2' }, { id: 'V1', label: 'Video 1' }, { id: 'A1', label: 'Audio 1' }, { id: 'A2', label: 'Audio 2' },
];
const RULER_STEPS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

function el(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

// ---------- Bin ----------

export function binPanel({ store, actions, engine, thumbs }) {
  const root = el(`<div class="panel bin">
    <div class="panel-bar">
      <button data-act="import">Import folder</button>
      <button data-act="save">Save project</button>
    </div>
    <div class="bin-folder muted"></div>
    <div class="bin-grid" role="listbox" aria-label="Bin"></div>
    <div class="hint muted">Hover any video to scrub preview. Double-click or click + to add at playhead.</div>
  </div>`);
  const grid = root.querySelector('.bin-grid');

  // Single reusable hover-scrub <video> so even 100+ videos stay fast and light on RAM.
  const hoverVideo = document.createElement('video');
  hoverVideo.className = 'bin-hover-video';
  hoverVideo.muted = true;
  hoverVideo.playsInline = true;
  hoverVideo.preload = 'auto';
  const hoverBar = document.createElement('span');
  hoverBar.className = 'bin-scrub-bar';
  const hoverHead = document.createElement('span');
  hoverHead.className = 'bin-scrub-head';
  hoverBar.appendChild(hoverHead);

  let activeCard = null;
  let activePath = null;
  let hoverToken = 0;
  let pendingFrac = null;
  let lastMediaRef = null;
  let lastSelected = null;

  function applyHoverSeek(f) {
    hoverHead.style.left = (f * 100) + '%';
    if (Number.isFinite(hoverVideo.duration) && hoverVideo.duration > 0) {
      pendingFrac = null;
      try { hoverVideo.currentTime = f * hoverVideo.duration; } catch { /* ignore */ }
    } else {
      pendingFrac = f;
    }
  }

  hoverVideo.addEventListener('loadedmetadata', () => {
    if (pendingFrac !== null) applyHoverSeek(pendingFrac);
  });

  let hoverReleaseTimer = null;
  function stopHover() {
    hoverToken += 1;
    activeCard = null;
    activePath = null;
    pendingFrac = null;
    hoverVideo.pause();
    hoverVideo.remove();
    hoverBar.remove();
    clearTimeout(hoverReleaseTimer);
    hoverReleaseTimer = setTimeout(() => {
      if (activeCard) return;
      hoverVideo.removeAttribute('src');
      try { hoverVideo.load(); } catch { /* ignore */ }
    }, 2000);
  }

  function startHover(card, clientX) {
    const filePath = card.dataset.bin;
    const kind = card.dataset.kind;
    if (kind !== 'video' || !engine || !engine.getMediaUrl) return;
    const stage = card.querySelector('.bin-thumb');
    if (!stage) return;

    const r = stage.getBoundingClientRect();
    const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;

    if (activeCard !== card) {
      activeCard = card;
      activePath = filePath;
      stage.append(hoverVideo, hoverBar);
      const token = ++hoverToken;
      engine.getMediaUrl(filePath).then((url) => {
        if (token !== hoverToken || activePath !== filePath || !url) return;
        if (hoverVideo.src !== url) hoverVideo.src = url;
        applyHoverSeek(f);
      });
    }
    applyHoverSeek(f);
  }

  grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.bin-card[data-bin]');
    if (!card || card.dataset.kind !== 'video') {
      if (activeCard) stopHover();
      return;
    }
    startHover(card, e.clientX);
  });
  grid.addEventListener('pointerleave', stopHover);

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'import') actions.importFolder();
      if (act.dataset.act === 'save') actions.saveProject();
      if (act.dataset.act === 'add') {
        e.stopPropagation();
        actions.addBinItem(act.dataset.path);
      }
      return;
    }
    const item = e.target.closest('[data-bin]');
    if (item) actions.selectBin(item.dataset.bin);
  });
  root.addEventListener('dblclick', (e) => {
    const item = e.target.closest('[data-bin]');
    if (item) actions.addBinItem(item.dataset.bin);
  });

  function formatDur(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function update(s) {
    const folderEl = root.querySelector('.bin-folder');
    folderEl.textContent = s.zdFilePath
      ? `${s.projectName}.zd · ${s.zdFilePath}`
      : s.projectFolder
        ? `${s.projectName} · ${s.projectFolder}`
        : 'No folder or .zd open. Import a folder or click Open .zd.';
    folderEl.title = s.zdFilePath || s.projectFolder || '';

    // Avoid rebuilding the grid if media list hasn't changed; just toggle selection class.
    if (lastMediaRef === s.media) {
      if (lastSelected !== s.binSelected) {
        lastSelected = s.binSelected;
        grid.querySelectorAll('.bin-card').forEach((c) => {
          const isSel = c.dataset.bin === s.binSelected;
          c.classList.toggle('sel', isSel);
          c.setAttribute('aria-selected', isSel ? 'true' : 'false');
        });
      }
      return;
    }

    lastMediaRef = s.media;
    lastSelected = s.binSelected;
    stopHover();

    if (!s.media.length) {
      grid.innerHTML = '<div class="bin-empty muted">No files yet.</div>';
      return;
    }

    grid.innerHTML = s.media.map((m) => {
      const sel = s.binSelected === m.path ? ' sel' : '';
      const dur = formatDur(m.duration);
      const posterTime = m.duration ? Math.min(0.5, m.duration * 0.1) : 0;
      const cached = m.kind === 'video' && thumbs ? thumbs.getCached(m.path, posterTime) : null;
      const bgStyle = cached ? ` style="background-image:url('${cached}')"` : '';
      const audioBadge = m.kind === 'audio' ? '<span class="bin-audio-icon" aria-hidden="true">♪</span>' : '';
      return `<div class="bin-card${sel}" role="option" aria-selected="${sel ? 'true' : 'false'}" data-bin="${esc(m.path)}" data-kind="${esc(m.kind)}" title="${esc(m.name)}">
        <div class="bin-thumb${m.kind === 'audio' ? ' is-audio' : ''}"${bgStyle}>
          ${audioBadge}
          ${dur ? `<span class="bin-dur">${dur}</span>` : ''}
          <button type="button" class="bin-quick-add" data-act="add" data-path="${esc(m.path)}" title="Add to timeline at playhead">+</button>
        </div>
        <div class="bin-card-name">${esc(m.name)}</div>
      </div>`;
    }).join('');

    // Request poster frames asynchronously for any uncached videos.
    if (thumbs) {
      for (const m of s.media) {
        if (m.kind !== 'video') continue;
        const posterTime = m.duration ? Math.min(0.5, m.duration * 0.1) : 0;
        if (thumbs.getCached(m.path, posterTime)) continue;
        thumbs.request(m.path, posterTime).then((url) => {
          if (!url || lastMediaRef !== s.media) return;
          const card = Array.from(grid.querySelectorAll('.bin-card')).find((el_) => el_.dataset.bin === m.path);
          const thumb = card && card.querySelector('.bin-thumb');
          if (thumb) thumb.style.backgroundImage = `url('${url}')`;
        });
      }
    }
  }

  return { el: root, update, destroy: stopHover };
}

// ---------- Viewer ----------

export function viewerPanel({ store, actions, engine }) {
  const root = el(`<div class="panel viewer">
    <div class="viewer-stage">
      <div class="viewer-text muted"></div>
      <div class="viewer-transform-hud" hidden></div>
      <div class="dropper-loupe" hidden><span class="dropper-swatch"></span><span class="dropper-hex">#000000</span></div>
    </div>
    <div class="transport">
      <button data-act="play" aria-label="Play" title="Play / Pause (Space)">▶</button>
      <span class="tc"></span>
      <span class="gpu-pill muted" hidden></span>
      <span class="grow"></span>
      <span class="log" aria-live="polite"></span>
    </div>
    <div class="scrubbar" role="slider" aria-label="Scrub through the timeline" tabindex="0">
      <div class="scrub-fill"></div><div class="scrub-head"></div>
      <div class="scrub-tip" hidden></div>
    </div>
  </div>`);
  const stage = root.querySelector('.viewer-stage');
  const bar = root.querySelector('.scrubbar');
  const tip = root.querySelector('.scrub-tip');
  const loupe = root.querySelector('.dropper-loupe');
  const loupeSwatch = root.querySelector('.dropper-swatch');
  const loupeHex = root.querySelector('.dropper-hex');
  const transformHud = root.querySelector('.viewer-transform-hud');
  let hudTimer = null;
  const gpuPill = root.querySelector('.gpu-pill');
  if (engine.getGpuInfo) {
    const raw = engine.getGpuInfo();
    if (raw) {
      const short = /NVIDIA|RTX|GTX/i.test(raw)
        ? (raw.match(/(?:RTX|GTX)\s+[0-9A-Za-z ]+/)?.[0]?.trim() || 'NVIDIA GPU')
        : /Intel/i.test(raw) ? 'Intel GPU'
        : /SwiftShader|llvmpipe|Software/i.test(raw) ? 'CPU Software WebGL'
        : raw.slice(0, 24);
      gpuPill.textContent = 'GPU: ' + short;
      gpuPill.title = raw;
      gpuPill.hidden = false;
      gpuPill.classList.toggle('is-sw', /SwiftShader|llvmpipe|Software/i.test(raw));
    }
  }

  function ensureVideoAttached() {
    if (!engine.video.isConnected) stage.prepend(engine.video);
    if (engine.glCanvas && !engine.glCanvas.isConnected) engine.video.after(engine.glCanvas);
    if (engine.fxOverlay && !engine.fxOverlay.isConnected) (engine.glCanvas || engine.video).after(engine.fxOverlay);
  }
  ensureVideoAttached();

  function showTransformHud(clip) {
    if (!clip) return;
    const sc = T.propValue(clip, 'scale');
    const rot = T.propValue(clip, 'rotation');
    const px = T.propValue(clip, 'posX');
    const py = T.propValue(clip, 'posY');
    transformHud.textContent = `Scale ${sc}% · Rot ${rot > 0 ? '+' : ''}${rot}° · Pos ${px > 0 ? '+' : ''}${px}%, ${py > 0 ? '+' : ''}${py}%`;
    transformHud.hidden = false;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { transformHud.hidden = true; }, 1300);
  }

  function targetVideoClip() {
    const s = store.get();
    const atHead = T.clipAt(s.clips.filter((c) => c.path && c.kind === 'video'), s.playhead);
    if (atHead) {
      if (s.selected !== atHead.id) actions.select(atHead.id);
      return atHead;
    }
    const sel = s.selected ? T.findClip(s.clips, s.selected) : null;
    return sel && sel.kind === 'video' ? sel : null;
  }

  // Shift + trackpad gestures over Viewer:
  // - Shift + Pinch (ctrlKey) or Shift + vertical scroll -> Scale (zoom)
  // - Shift + horizontal two-finger scroll -> Rotate
  // - Shift + Alt + two-finger scroll -> Pan X / Y
  let scaleAccum = 0;
  let rotAccum = 0;
  let panXAccum = 0;
  let panYAccum = 0;
  let accumClipId = null;
  let accumTimer = null;

  stage.addEventListener('wheel', (e) => {
    if (!e.shiftKey) return;
    const clip = targetVideoClip();
    if (!clip) return;
    e.preventDefault();
    const mul = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * mul;
    const dy = e.deltaY * mul;

    if (accumClipId !== clip.id) {
      accumClipId = clip.id;
      scaleAccum = T.propValue(clip, 'scale');
      rotAccum = T.propValue(clip, 'rotation');
      panXAccum = T.propValue(clip, 'posX');
      panYAccum = T.propValue(clip, 'posY');
    }
    clearTimeout(accumTimer);
    accumTimer = setTimeout(() => { accumClipId = null; }, 350);

    if (e.altKey) {
      panXAccum = Math.min(100, Math.max(-100, panXAccum - dx * 0.12));
      panYAccum = Math.min(100, Math.max(-100, panYAccum - dy * 0.12));
      actions.transformClip(clip.id, { posX: Math.round(panXAccum), posY: Math.round(panYAccum) });
    } else if (e.ctrlKey || Math.abs(dy) >= Math.abs(dx)) {
      // Pinch (ctrlKey) or vertical scroll -> zoom/scale
      const gain = e.ctrlKey ? 0.55 : 0.22;
      scaleAccum = Math.min(400, Math.max(10, scaleAccum - dy * gain));
      actions.transformClip(clip.id, { scale: Math.round(scaleAccum) });
    } else {
      // Horizontal two-finger swipe -> rotate
      rotAccum = Math.min(180, Math.max(-180, rotAccum + dx * 0.25));
      actions.transformClip(clip.id, { rotation: Math.round(rotAccum) });
    }
    const updated = T.findClip(store.get().clips, clip.id);
    showTransformHud(updated);
  }, { passive: false });

  stage.addEventListener('pointermove', (e) => {
    if (!store.get().eyedropper) { loupe.hidden = true; return; }
    const picked = engine.samplePixel ? engine.samplePixel(e.clientX, e.clientY, stage) : null;
    if (!picked) { loupe.hidden = true; return; }
    const r = stage.getBoundingClientRect();
    loupe.hidden = false;
    loupe.style.left = Math.min(r.width - 92, Math.max(8, e.clientX - r.left + 14)) + 'px';
    loupe.style.top = Math.max(8, e.clientY - r.top - 34) + 'px';
    loupeSwatch.style.background = picked.hex;
    loupeHex.textContent = picked.hex.toUpperCase();
  });
  stage.addEventListener('pointerleave', () => { loupe.hidden = true; });
  stage.addEventListener('pointerdown', (e) => {
    const mode = store.get().eyedropper;
    if (mode && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      const picked = engine.samplePixel ? engine.samplePixel(e.clientX, e.clientY, stage) : null;
      loupe.hidden = true;
      actions.setEyedropper(false);
      if (picked) actions.setHslTarget(picked.hex, mode === 'add');
      return;
    }
    // Shift + drag on Viewer -> pan video X/Y directly
    if (e.shiftKey && e.button === 0) {
      const clip = targetVideoClip();
      if (!clip) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const baseX = T.propValue(clip, 'posX');
      const baseY = T.propValue(clip, 'posY');
      stage.classList.add('transform-drag');
      const move = (ev) => {
        const dxPct = r.width > 0 ? ((ev.clientX - startX) / r.width) * 100 : 0;
        const dyPct = r.height > 0 ? ((ev.clientY - startY) / r.height) * 100 : 0;
        actions.transformClip(clip.id, {
          posX: Math.round(Math.min(100, Math.max(-100, baseX + dxPct))),
          posY: Math.round(Math.min(100, Math.max(-100, baseY + dyPct))),
        });
        showTransformHud(T.findClip(store.get().clips, clip.id));
      };
      const up = () => {
        stage.classList.remove('transform-drag');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
  });

  function timeFromX(clientX) {
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const end = T.projectEnd(store.get().clips);
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { t: f * end, f };
  }

  bar.addEventListener('pointermove', (e) => {
    const { t, f } = timeFromX(e.clientX);
    tip.hidden = false;
    tip.textContent = T.timecode(t);
    tip.style.left = (f * 100) + '%';
  });
  bar.addEventListener('pointerleave', () => { tip.hidden = true; });
  bar.addEventListener('pointerdown', (e) => {
    try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }
    actions.seekTo(timeFromX(e.clientX).t);
    const move = (ev) => actions.seekTo(timeFromX(ev.clientX).t);
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); actions.stepBy(e.shiftKey ? -1 : -1 / T.FPS); }
    if (e.key === 'ArrowRight') { e.preventDefault(); actions.stepBy(e.shiftKey ? 1 : 1 / T.FPS); }
  });
  root.querySelector('[data-act="play"]').addEventListener('click', () => actions.togglePlay());

  function timeText(s) {
    return T.timecode(s.playhead) + ' / ' + T.timecode(T.projectEnd(s.clips));
  }

  function updateTime(s) {
    root.querySelector('.tc').textContent = timeText(s);
    const end = T.projectEnd(s.clips);
    const f = end ? Math.min(1, Math.max(0, s.playhead / end)) : 0;
    root.querySelector('.scrub-fill').style.width = (f * 100) + '%';
    root.querySelector('.scrub-head').style.left = (f * 100) + '%';
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(Math.round(end * 100) / 100));
    bar.setAttribute('aria-valuenow', String(Math.round(s.playhead * 100) / 100));
  }

  function update(s) {
    ensureVideoAttached();
    stage.classList.toggle('eyedropper-on', Boolean(s.eyedropper));
    if (!s.eyedropper) loupe.hidden = true;
    const btn = root.querySelector('[data-act="play"]');
    btn.textContent = s.playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    const c = T.clipAt(s.clips, s.playhead);
    const labelEl = root.querySelector('.viewer-text');
    if (c && !c.path) {
      labelEl.textContent = c.name;
      labelEl.className = 'viewer-text viewer-badge';
    } else if (!c) {
      labelEl.textContent = 'No clip at playhead';
      labelEl.className = 'viewer-text muted';
    } else {
      labelEl.textContent = '';
      labelEl.className = 'viewer-text';
    }
    const logEl = root.querySelector('.log');
    logEl.textContent = s.log;
    logEl.title = s.log;
    updateTime(s);
  }

  return { el: root, update, updateTime };
}

// ---------- Timeline ----------

export function timelinePanel({ store, actions, thumbs, waveforms }) {
  const root = el(`<div class="panel timeline">
    <div class="tl-body">
      <div class="scroller">
        <div class="tl-grid">
          <div class="tl-corner"></div>
          <div class="ruler" aria-label="Ruler. Click to move the playhead."></div>
          <div class="labels">${TRACKS.map((t) => `<div class="tlbl">${t.label}</div>`).join('')}</div>
          <div class="canvas">
            <div class="tracks"></div>
            <div class="playhead" aria-hidden="true"></div>
            <div class="marquee" hidden aria-hidden="true"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="tl-bar">
      <button data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
      <button data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button data-act="split" title="Split at playhead (S)">✂ Split</button>
      <button data-act="trim" title="Trim end to playhead">Trim</button>
      <button data-act="delete" title="Delete (Delete key)">Delete</button>
      <button data-act="duplicate" title="Duplicate">Duplicate</button>
      <button data-act="snap" class="snap-btn" title="Magnetic snap">Snap</button>
      <span class="sep"></span>
      <button data-act="zoomOut" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button data-act="zoomIn" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button data-act="fit" title="Fit the whole timeline">Fit</button>
      <div class="grow"></div>
      <span class="muted tl-info"></span>
    </div>
  </div>`);
  const scroller = root.querySelector('.scroller');
  const canvas = root.querySelector('.canvas');
  const ruler = root.querySelector('.ruler');
  const tracks = root.querySelector('.tracks');
  const playhead = root.querySelector('.playhead');
  const marquee = root.querySelector('.marquee');
  let lastTimelineKey = '';

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'zoomIn') return actions.zoomIn();
      if (a === 'zoomOut') return actions.zoomOut();
      if (a === 'fit') return actions.fit(Math.max(200, scroller.clientWidth - 86));
      if (a === 'snap') return actions.toggleSnap();
      if (a === 'undo') return actions.undo();
      if (a === 'redo') return actions.redo();
      if (a === 'split') return actions.split();
      if (a === 'trim') return actions.trim();
      if (a === 'delete') return actions.deleteSelected();
      if (a === 'duplicate') return actions.duplicate();
      return;
    }
  });

  // scrubbing on the ruler and empty track space
  function scrubTo(e) {
    const s = store.get();
    const rect = canvas.getBoundingClientRect();
    const t = (e.clientX - rect.left) / s.pps;
    actions.seekTo(actions.snapTime(t, s.pps));
  }
  function startScrub(e) {
    if (e.button !== 0) return;
    if (e.target.closest('[data-clip]')) return;
    e.preventDefault();
    scrubTo(e);
    const move = (ev) => scrubTo(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  ruler.addEventListener('pointerdown', startScrub);

  // right-click context menu on clips (Separate Audio Track, Mute, Split, Duplicate, Delete)
  let ctxMenu = null;
  function closeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    document.removeEventListener('pointerdown', outsideCtxClose, true);
    document.removeEventListener('keydown', escCtxClose);
  }
  function outsideCtxClose(e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu();
  }
  function escCtxClose(e) {
    if (e.key === 'Escape') closeCtxMenu();
  }

  tracks.addEventListener('contextmenu', (e) => {
    const blk = e.target.closest('.blk[data-clip]');
    if (!blk) return;
    e.preventDefault();
    closeCtxMenu();
    const clipId = blk.dataset.clip;
    actions.select(clipId);
    const clip = T.findClip(store.get().clips, clipId);
    if (!clip) return;

    const isVideo = clip.kind === 'video';
    const isMedia = isVideo || clip.kind === 'audio';
    const canSeparate = isVideo && clip.hasAudio !== false && !clip.muted;
    const sepReason = !isVideo ? '' : clip.hasAudio === false ? ' (no audio)' : clip.muted ? ' (already separated / muted)' : '';

    ctxMenu = document.createElement('div');
    ctxMenu.className = 'menu clip-ctx-menu';
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.innerHTML = `
      <div class="menu-title">${esc(clip.name)}</div>
      ${isVideo ? `<button role="menuitem" data-ctx="separate" ${canSeparate ? '' : 'disabled'}>Separate Audio Track${sepReason}</button>` : ''}
      ${isMedia ? `<button role="menuitem" data-ctx="mute">${clip.muted ? 'Unmute audio' : 'Mute audio'}</button>` : ''}
      <button role="menuitem" data-ctx="split">Split at playhead</button>
      <button role="menuitem" data-ctx="duplicate">Duplicate</button>
      <div class="menu-sep"></div>
      <button role="menuitem" data-ctx="ripple">Ripple delete</button>
      <button role="menuitem" data-ctx="delete" class="danger">Delete clip</button>
    `;
    document.body.appendChild(ctxMenu);
    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8)) + 'px';
    ctxMenu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - h - 8)) + 'px';

    ctxMenu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-ctx]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.ctx;
      closeCtxMenu();
      if (act === 'separate') actions.detach();
      else if (act === 'mute') {
        const s = store.get();
        const cur = T.findClip(s.clips, clipId);
        if (cur) actions.commitClips(T.setFlag(s.clips, cur.id, 'muted', !cur.muted), (cur.muted ? 'Unmuted ' : 'Muted ') + cur.name);
      } else if (act === 'split') actions.split();
      else if (act === 'duplicate') actions.duplicate();
      else if (act === 'ripple') actions.ripple();
      else if (act === 'delete') actions.deleteSelected();
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideCtxClose, true);
      document.addEventListener('keydown', escCtxClose);
    }, 0);
  });

  // AutoCAD-style marquee box select on empty track space (L->R blue = window, R->L green = crossing)
  // and direct drag to move a single clip or all selected clips, or drag right edge to trim.
  tracks.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const blk = e.target.closest('[data-clip]');

    if (!blk) {
      e.preventDefault();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const additive = e.shiftKey;
      const baseIds = additive ? [...(store.get().selectedIds || [])] : [];
      let draggingBox = false;
      let matchedIds = [];
      let mode = 'window';

      const updateBox = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!draggingBox && Math.hypot(dx, dy) < 4) return;
        draggingBox = true;
        mode = ev.clientX >= x0 ? 'window' : 'crossing';

        const cRect = canvas.getBoundingClientRect();
        const leftPx = Math.min(x0, ev.clientX) - cRect.left;
        const topPx = Math.min(y0, ev.clientY) - cRect.top;
        const widthPx = Math.abs(ev.clientX - x0);
        const heightPx = Math.abs(ev.clientY - y0);

        marquee.hidden = false;
        marquee.className = 'marquee ' + (mode === 'window' ? 'marquee-window' : 'marquee-crossing');
        marquee.style.left = leftPx + 'px';
        marquee.style.top = topPx + 'px';
        marquee.style.width = widthPx + 'px';
        marquee.style.height = heightPx + 'px';

        const blkEls = Array.from(tracks.querySelectorAll('.blk[data-clip]'));
        const rects = blkEls.map((el_) => {
          const r = el_.getBoundingClientRect();
          return { id: el_.dataset.clip, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const box = { left: x0, right: ev.clientX, top: y0, bottom: ev.clientY };
        const hits = T.selectByBox(rects, box, mode);
        matchedIds = additive ? [...new Set([...baseIds, ...hits])] : hits;
        const hitSet = new Set(matchedIds);
        blkEls.forEach((el_) => el_.classList.toggle('sel', hitSet.has(el_.dataset.clip)));
      };

      const finishBox = () => {
        window.removeEventListener('pointermove', updateBox);
        window.removeEventListener('pointerup', finishBox);
        window.removeEventListener('pointercancel', finishBox);
        marquee.hidden = true;
        if (draggingBox) {
          const label = mode === 'window' ? 'Window' : 'Crossing';
          const msg = matchedIds.length
            ? `Selected ${matchedIds.length} clip${matchedIds.length === 1 ? '' : 's'} (${label})`
            : 'Selection cleared';
          actions.selectMany(matchedIds, msg);
        } else {
          actions.select(null);
          scrubTo(e);
        }
      };

      window.addEventListener('pointermove', updateBox);
      window.addEventListener('pointerup', finishBox);
      window.addEventListener('pointercancel', finishBox);
      return;
    }

    const clipId = blk.dataset.clip;
    const isTrim = Boolean(e.target.closest('.blk-handle'));
    const curSel = store.get().selectedIds || [];

    if ((e.shiftKey || e.ctrlKey || e.metaKey) && !isTrim) {
      actions.toggleSelect(clipId);
      return;
    }

    const alreadyInGroup = curSel.length > 1 && curSel.includes(clipId);
    if (!alreadyInGroup) actions.select(clipId);

    const x0 = e.clientX;
    let lastX = x0;
    let moved = false;

    const move = (ev) => {
      const dx = ev.clientX - lastX;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      lastX = ev.clientX;
      const s = store.get();
      const clip = T.findClip(s.clips, clipId);
      if (!clip) return;
      const dt = dx / s.pps;
      if (isTrim) {
        const next = T.adjustEnd(s.clips, clipId, dt);
        if (next) {
          const after = T.findClip(next, clipId);
          actions.liveClips('drag-trim:' + clipId, next, `${clip.name} length ${after.dur.toFixed(2)} s`);
        }
      } else {
        const ids = s.selectedIds && s.selectedIds.length > 1 && s.selectedIds.includes(clipId)
          ? s.selectedIds
          : [clipId];
        const next = ids.length > 1 ? T.moveClips(s.clips, ids, dt) : T.moveClip(s.clips, clipId, dt);
        if (next) {
          const after = T.findClip(next, clipId);
          const msg = ids.length > 1
            ? `Moved ${ids.length} clips (first at ${after.start.toFixed(2)} s)`
            : `${clip.name} starts at ${after.start.toFixed(2)} s`;
          actions.liveClips('drag-move:' + ids.join(','), next, msg);
        }
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // If user clicked a clip in a multi-selection without dragging, narrow selection to just that clip.
      if (!moved && alreadyInGroup) actions.select(clipId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  function update(s) {
    const selKey = (s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : [])).join(',');
    const timelineKey = `${s.pps}|${s.snap}|${selKey}|` + s.clips.map((c) =>
      `${c.id}:${c.track}:${c.start}:${c.dur}:${c.srcIn}:${c.speed}:${c.volume}:${c.muted}:${c.transition}:${c.generating}:${c.progress}:${c.name}:${c.path}`
    ).join(';');
    if (timelineKey === lastTimelineKey) {
      updateTime(s);
      return;
    }
    lastTimelineKey = timelineKey;

    const end = T.projectEnd(s.clips);
    const pxWidth = Math.max(scroller.clientWidth - 86, end * s.pps);
    canvas.style.width = pxWidth + 'px';
    ruler.style.width = pxWidth + 'px';

    const step = RULER_STEPS.find((x) => x * s.pps >= 70) || RULER_STEPS[RULER_STEPS.length - 1];
    let ticks = '';
    for (let i = 0; i * step <= end + 1e-9; i++) {
      const t = i * step;
      const m = Math.floor(t / 60);
      const r = t - m * 60;
      const label = step >= 1 ? `${String(m).padStart(2, '0')}:${String(Math.floor(r)).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
      ticks += `<span style="left:${t * s.pps}px">${label}</span>`;
    }
    ruler.innerHTML = ticks;

    const pendingThumbs = [];
    const waveClips = [];
    const selSet = new Set(s.selectedIds && s.selectedIds.length ? s.selectedIds : (s.selected ? [s.selected] : []));
    tracks.innerHTML = TRACKS.map((tr) => {
      const blocks = s.clips.filter((c) => c.track === tr.id).map((c) => {
        const kind = c.generating ? 'gen' : (c.kind === 'audio' ? 'audio' : c.kind === 'video' ? 'video' : 'title');
        const sel = selSet.has(c.id) ? ' sel' : '';
        const speed = c.speed && c.speed !== 1 ? ` ×${c.speed}` : '';
        const vol = c.kind === 'audio' || c.kind === 'video' ? (c.muted ? ' · muted' : ` · ${Math.round(T.propValue(c, 'volume') * 100)}%`) : '';
        const pct = Math.round((c.progress || 0) * 100);
        const fill = c.generating ? `<span class="gen-fill${c.progress == null ? ' pulse' : ''}" style="width:${pct}%"></span>` : '';
        const dissolve = c.transition ? '<span class="tr" title="Cross dissolve"></span>' : '';

        let strip = '';
        if (c.kind === 'video' && c.path && !c.generating && thumbs) {
          const stages = timelineThumbStages(c);
          const tiles = stages.map((st, idx) => {
            const leftPct = (st.offset / c.dur) * 100;
            const widthPct = (st.span / c.dur) * 100;
            const cached = thumbs.getCached(c.path, st.srcTime);
            const bg = cached ? `background-image:url('${cached}');` : '';
            if (!cached) pendingThumbs.push({ clipId: c.id, idx, path: c.path, srcTime: st.srcTime });
            return `<span class="blk-frame" data-frame="${idx}" style="left:${leftPct}%;width:${widthPct}%;${bg}"></span>`;
          }).join('');
          strip = `<span class="blk-strip" aria-hidden="true">${tiles}</span>`;
        }

        const hasInternalAudio = c.kind === 'video' && c.path && !c.generating && c.hasAudio !== false && !c.muted;
        const isAudioMedia = c.kind === 'audio' && c.path && !c.generating;
        let waveHtml = '';
        if ((hasInternalAudio || isAudioMedia) && waveforms) {
          waveHtml = `<canvas class="blk-wave ${isAudioMedia ? 'blk-wave-audio' : 'blk-wave-internal'}" aria-hidden="true"></canvas>`;
          waveClips.push(c);
        }

        return `<div class="blk ${kind}${sel}${strip ? ' has-strip' : ''}${hasInternalAudio ? ' has-wave' : ''}" role="button" tabindex="0" data-clip="${esc(c.id)}"
            aria-label="${esc(c.name)}" style="left:${c.start * s.pps}px;width:${Math.max(8, c.dur * s.pps)}px">
            ${strip}${waveHtml}${fill}${dissolve}<span class="blk-label">${esc(c.name + speed + vol)}</span><span class="blk-handle" title="Drag edge to trim length"></span></div>`;
      }).join('');
      return `<div class="trk" data-track="${tr.id}">${blocks}</div>`;
    }).join('');

    for (const item of pendingThumbs) {
      thumbs.request(item.path, item.srcTime).then((url) => {
        if (!url) return;
        const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === item.clipId);
        const tile = blk && blk.querySelector(`.blk-frame[data-frame="${item.idx}"]`);
        if (tile) tile.style.backgroundImage = `url('${url}')`;
      });
    }

    for (const c of waveClips) {
      const cached = waveforms.getCached(c.path);
      if (cached) {
        const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === c.id);
        const canvasEl = blk && blk.querySelector('.blk-wave');
        if (canvasEl && cached.peaks.length) drawWaveform(canvasEl, cached, c);
      } else {
        waveforms.request(c.path).then((data) => {
          if (!data || !data.peaks.length) return;
          const blk = Array.from(tracks.querySelectorAll('.blk[data-clip]')).find((b) => b.dataset.clip === c.id);
          const canvasEl = blk && blk.querySelector('.blk-wave');
          const liveClip = T.findClip(store.get().clips, c.id);
          if (canvasEl && liveClip) drawWaveform(canvasEl, data, liveClip);
        });
      }
    }

    root.querySelector('.snap-btn').classList.toggle('on', s.snap);
    const selInfo = selSet.size > 1 ? ` · ${selSet.size} selected` : '';
    root.querySelector('.tl-info').textContent = `Zoom ${s.pps.toFixed(1)} px/s · ${T.timecode(end)}${selInfo}`;
    updateTime(s);
  }

  function updateTime(s) {
    playhead.style.left = s.playhead * s.pps + 'px';
  }

  return { el: root, update, updateTime, scroller, destroy: closeCtxMenu };
}

// ---------- Inspector ----------

const HSL_SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
const HSL_BAND_FIELDS = [
  { key: 'hue', prop: 'hslHue' },
  { key: 'sat', prop: 'hslSat' },
  { key: 'light', prop: 'hslLight' },
  { key: 'range', prop: 'hslRange' },
];

// Pre-render the color wheel disc ONCE into a cached offscreen canvas so redraws take < 0.05ms.
let wheelCache = null;
function getWheelBitmap(w, h) {
  if (wheelCache && wheelCache.width === w && wheelCache.height === h) return wheelCache;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 4;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const sat = Math.min(1, dist / radius);
      const { r, g, b } = hslToRgb(hue, sat, 0.5);
      const idx = (y * w + x) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  wheelCache = off;
  return off;
}

function drawColorWheel(canvas, hex, allBands = []) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 4;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(getWheelBitmap(w, h), 0, 0);

  // Small dots for other color bands so you can see all targeted colors on the wheel at once
  for (const b of allBands) {
    const rgb = hexToRgb(b.hex);
    if (!rgb) continue;
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const rad = (hsl.h * Math.PI) / 180;
    const rPos = Math.max(0.15, hsl.s) * (radius - 2);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(rad) * rPos, cy + Math.sin(rad) * rPos, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = b.hex;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
  }

  // Active target reticle
  const rgb = hexToRgb(hex) || { r: 239, g: 68, b: 68 };
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const rad = (hsl.h * Math.PI) / 180;
  const rPos = Math.max(0.15, hsl.s) * (radius - 2);
  const mx = cx + Math.cos(rad) * rPos;
  const my = cy + Math.sin(rad) * rPos;

  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.fillStyle = hex;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mx, my, 7.5, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.stroke();
}

export function inspectorPanel({ store, actions }) {
  const root = el(`<div class="panel inspector"></div>`);
  let tab = 'clip'; // 'clip' | 'filters' | 'hsl' | 'transitions'
  let lastStructKey = '';

  function activeBandOf(clip) {
    const bands = getHslBands(clip);
    const active = bands.find((b) => b.id === clip.hslActiveBand) || bands[0];
    return { bands, active };
  }

  function pickWheelColor(canvas, clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = Math.min(r.width, r.height) / 2 - 4;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const sat = Math.min(1, Math.max(0.15, Math.hypot(dx, dy) / Math.max(1, radius)));
    const rgb = hslToRgb(hue, sat, 0.5);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  root.addEventListener('pointerdown', (e) => {
    const wheel = e.target.closest('.hsl-wheel');
    if (!wheel || e.button !== 0) return;
    e.preventDefault();
    const apply = (ev) => {
      const hex = pickWheelColor(wheel, ev.clientX, ev.clientY);
      const s = store.get();
      const clip = s.selected ? T.findClip(s.clips, s.selected) : null;
      if (!clip) return;
      const { active } = activeBandOf(clip);
      actions.setHslBandProp(clip.id, active.id, 'hex', hex, true);
    };
    apply(e);
    const move = (ev) => apply(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  root.addEventListener('change', (e) => {
    const hexInput = e.target.closest('[data-hsl-hex]');
    if (hexInput) {
      const norm = normalizeHex(hexInput.value, null);
      if (norm) actions.setHslTarget(norm, false);
      else { lastStructKey = ''; update(store.get()); }
      return;
    }
    const expField = e.target.closest('[data-exp-field]');
    if (expField) {
      const key = expField.dataset.expField;
      const val = expField.type === 'number' ? Number(expField.value) : expField.value;
      if (key === 'fps') actions.setExportCfg({ fps: Number(val) });
      else if (key === 'rangeStart') actions.setExportCfg({ rangeStart: Math.max(0, Number(val) || 0) });
      else if (key === 'rangeEnd') actions.setExportCfg({ rangeEnd: Math.max(0.1, Number(val) || 0.1) });
      else actions.setExportCfg({ [key]: val });
    }
  });

  root.addEventListener('click', (e) => {
    const expPreset = e.target.closest('[data-exp-preset]');
    if (expPreset) return actions.applyExportPreset(expPreset.dataset.expPreset);
    const expAspect = e.target.closest('[data-exp-aspect]');
    if (expAspect) return actions.setExportCfg({ aspect: expAspect.dataset.expAspect });
    const expFps = e.target.closest('[data-exp-fps]');
    if (expFps) return actions.setExportCfg({ fps: Number(expFps.dataset.expFps) });
    const expRange = e.target.closest('[data-exp-range]');
    if (expRange) return actions.setExportCfg({ rangeMode: expRange.dataset.expRange });
    const expAct = e.target.closest('[data-exp-act]');
    if (expAct) {
      const a = expAct.dataset.expAct;
      if (a === 'close') return actions.closeExport();
      if (a === 'start') return actions.exportRender();
      if (a === 'set-in') {
        const s = store.get();
        const t = Number(s.playhead.toFixed(2));
        actions.setExportCfg({ rangeMode: 'custom', rangeStart: t, rangeEnd: Math.max(t + 0.5, s.exportCfg.rangeEnd) });
        return;
      }
      if (a === 'set-out') {
        const s = store.get();
        const t = Number(s.playhead.toFixed(2));
        actions.setExportCfg({ rangeMode: 'custom', rangeStart: Math.min(s.exportCfg.rangeStart, Math.max(0, t - 0.5)), rangeEnd: Math.max(0.5, t) });
        return;
      }
      if (a === 'reveal') {
        const p = store.get().exportStatus.lastPath;
        if (p && window.zaudeAI && window.zaudeAI.reveal) window.zaudeAI.reveal(p);
        return;
      }
    }
    const tabBtn = e.target.closest('[data-insp-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.inspTab;
      lastStructKey = '';
      update(store.get());
      return;
    }
    const rmBand = e.target.closest('[data-hsl-remove]');
    if (rmBand) {
      e.stopPropagation();
      actions.removeHslBand(rmBand.dataset.hslRemove);
      return;
    }
    const selBand = e.target.closest('[data-hsl-band]');
    if (selBand) {
      actions.selectHslBand(selBand.dataset.hslBand);
      return;
    }
    const swatch = e.target.closest('[data-hsl-swatch]');
    if (swatch) {
      actions.setHslTarget(swatch.dataset.hslSwatch, false);
      return;
    }
    const trBtn = e.target.closest('[data-tr-type]');
    if (trBtn) {
      actions.setTransition(trBtn.dataset.trType);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'detach') actions.detach();
    if (act.dataset.act === 'mirror-h') actions.toggleMirror('h');
    if (act.dataset.act === 'fill') actions.toggleFill();
    if (act.dataset.act === 'mirror-v') actions.toggleMirror('v');
    if (act.dataset.act === 'reset-transform') actions.resetTransform();
    if (act.dataset.act === 'reset-filters') actions.resetFilters();
    if (act.dataset.act === 'reset-hsl') actions.resetHsl();
    if (act.dataset.act === 'add-hsl-band') {
      const s = store.get();
      const clip = s.selected ? T.findClip(s.clips, s.selected) : null;
      const used = clip ? getHslBands(clip).map((b) => b.hex.toLowerCase()) : [];
      const nextHex = HSL_SWATCHES.find((sw) => !used.includes(sw)) || '#3b82f6';
      actions.addHslBand(nextHex);
    }
    if (act.dataset.act === 'eyedropper') {
      actions.setEyedropper(store.get().eyedropper === 'replace' ? false : 'replace');
    }
    if (act.dataset.act === 'eyedropper-add') {
      actions.setEyedropper(store.get().eyedropper === 'add' ? false : 'add');
    }
    if (act.dataset.act === 'mute') {
      const s = store.get();
      const clip = T.findClip(s.clips, s.selected);
      if (clip) actions.commitClips(T.setFlag(s.clips, clip.id, 'muted', !clip.muted), (clip.muted ? 'Unmuted ' : 'Muted ') + clip.name);
    }
    if (act.dataset.act === 'delete') actions.deleteSelected();
  });

  // Double-click any scrub slider to reset it to its default value.
  root.addEventListener('dblclick', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field) return;
    const prop = field.dataset.scrubProp;
    const def = T.PROPS[prop];
    if (!def) return;
    if (field.dataset.scrubBand) {
      actions.setHslBandProp(field.dataset.scrubClip, field.dataset.scrubBand, field.dataset.scrubBandKey, def.default, false);
    } else {
      actions.setProp(field.dataset.scrubClip, prop, def.default);
    }
  });

  root.addEventListener('keydown', (e) => {
    const field = e.target.closest('[data-scrub-prop]');
    if (!field) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const s = store.get();
    const clip = T.findClip(s.clips, field.dataset.scrubClip);
    if (!clip) return;
    const prop = field.dataset.scrubProp;
    const def = T.PROPS[prop];
    if (!def) return;
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1 : -1;
    const step = (e.shiftKey ? def.step * 5 : def.step) * dir;
    if (field.dataset.scrubBand) {
      const band = getHslBands(clip).find((b) => b.id === field.dataset.scrubBand);
      if (!band) return;
      const key = field.dataset.scrubBandKey;
      const cur = typeof band[key] === 'number' ? band[key] : def.default;
      actions.setHslBandProp(clip.id, band.id, key, cur + step, true);
    } else {
      actions.setProp(clip.id, prop, T.propValue(clip, prop) + step);
    }
  });

  // Fast in-place update while dragging sliders/wheel so the DOM isn't rebuilt 60 times/sec.
  function patchInPlace(c) {
    root.querySelectorAll('.scrub-field[data-scrub-prop]').forEach((field) => {
      const prop = field.dataset.scrubProp;
      const def = T.PROPS[prop];
      if (!def) return;
      let val;
      if (field.dataset.scrubBand) {
        const band = getHslBands(c).find((b) => b.id === field.dataset.scrubBand);
        if (!band) return;
        const key = field.dataset.scrubBandKey;
        val = typeof band[key] === 'number' ? band[key] : def.default;
      } else {
        val = T.propValue(c, prop);
      }
      const pct = Math.min(100, Math.max(0, ((val - def.min) / (def.max - def.min)) * 100));
      field.classList.toggle('changed', Math.abs(val - def.default) > 1e-4);
      field.setAttribute('aria-valuenow', String(val));
      const bar = field.querySelector('.scrub-bar');
      const valEl = field.querySelector('.scrub-value');
      if (bar) bar.style.width = pct + '%';
      if (valEl) valEl.textContent = def.format(val);
    });
    if (tab === 'hsl') {
      const { bands, active } = activeBandOf(c);
      const chip = root.querySelector('.hsl-chip');
      const hexInput = root.querySelector('[data-hsl-hex]');
      if (chip) chip.style.background = active.hex;
      if (hexInput && document.activeElement !== hexInput) hexInput.value = active.hex.toUpperCase();
      root.querySelectorAll('.hsl-band-pill').forEach((pill) => {
        const b = bands.find((x) => x.id === pill.dataset.hslBand);
        if (!b) return;
        const dot = pill.querySelector('.hsl-band-dot');
        if (dot) dot.style.background = b.hex;
        pill.classList.toggle('modified', isBandActive(b));
      });
      drawColorWheel(root.querySelector('.hsl-wheel'), active.hex, bands);
    }
  }

  function renderExportPanel(s) {
    const cfg = s.exportCfg;
    const st = s.exportStatus;
    const dims = exportDimensions(cfg.aspect, cfg.resTier);
    const media = s.clips.filter((c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio'));
    const fullEnd = media.length ? Math.max(...media.map((c) => T.clipEnd(c))) : T.projectEnd(s.clips);
    const dur = cfg.rangeMode === 'custom'
      ? Math.max(0, Number(cfg.rangeEnd) - Number(cfg.rangeStart))
      : fullEnd;

    const expKey = JSON.stringify([cfg, st.busy, Math.round((st.progress || 0) * 100), st.message, st.lastPath, fullEnd.toFixed(2)]);
    if (lastStructKey === 'export|' + expKey) return;
    lastStructKey = 'export|' + expKey;

    root.innerHTML = `
      <div class="exp-head">
        <span class="insp-title">Export Video</span>
        <button class="area-btn" data-exp-act="close" title="Back to Clip &amp; Effects">×</button>
      </div>
      <div class="insp-body exp-body">
        <div class="lbl">Platform presets</div>
        <div class="exp-preset-grid">
          ${EXPORT_PRESETS.map((p) => `<button class="${cfg.preset === p.id ? 'on' : ''}" data-exp-preset="${p.id}">${esc(p.label)}</button>`).join('')}
        </div>

        <div class="lbl">Aspect ratio <span class="muted">(${dims.width} × ${dims.height})</span></div>
        <div class="exp-pill-row">
          ${ASPECT_RATIOS.map((ar) => `<button class="${cfg.aspect === ar ? 'on' : ''}" data-exp-aspect="${ar}">${ar}</button>`).join('')}
        </div>

        <div class="exp-two-col">
          <label class="exp-lbl">Resolution
            <select data-exp-field="resTier">
              ${RES_TIERS.map((r) => `<option value="${r.id}" ${cfg.resTier === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </label>
          <label class="exp-lbl">Format
            <select data-exp-field="format">
              <option value="MP4" ${cfg.format === 'MP4' ? 'selected' : ''}>MP4 (H.264)</option>
              <option value="MOV" ${cfg.format === 'MOV' ? 'selected' : ''}>MOV (QuickTime)</option>
            </select>
          </label>
        </div>

        <div class="exp-two-col">
          <div class="exp-lbl">Framerate
            <div class="exp-pill-row">
              ${[24, 30, 60].map((f) => `<button class="${Number(cfg.fps) === f ? 'on' : ''}" data-exp-fps="${f}">${f} fps</button>`).join('')}
            </div>
          </div>
          <label class="exp-lbl">Quality
            <select data-exp-field="quality">
              <option value="draft" ${cfg.quality === 'draft' ? 'selected' : ''}>Draft (fastest)</option>
              <option value="standard" ${cfg.quality === 'standard' ? 'selected' : ''}>Standard</option>
              <option value="high" ${cfg.quality === 'high' ? 'selected' : ''}>High</option>
              <option value="ultra" ${cfg.quality === 'ultra' ? 'selected' : ''}>Ultra</option>
            </select>
          </label>
        </div>

        <div class="lbl">Export range <span class="muted">(${dur.toFixed(1)} s)</span></div>
        <div class="exp-pill-row">
          <button class="${cfg.rangeMode === 'full' ? 'on' : ''}" data-exp-range="full">Full (${fullEnd.toFixed(1)} s)</button>
          <button class="${cfg.rangeMode === 'custom' ? 'on' : ''}" data-exp-range="custom">Custom part</button>
        </div>
        ${cfg.rangeMode === 'custom' ? `
          <div class="exp-two-col">
            <label class="exp-lbl">Start (sec)
              <input type="number" step="0.1" min="0" max="${fullEnd.toFixed(2)}" value="${Number(cfg.rangeStart).toFixed(2)}" data-exp-field="rangeStart">
            </label>
            <label class="exp-lbl">End (sec)
              <input type="number" step="0.1" min="0.1" max="${fullEnd.toFixed(2)}" value="${Number(cfg.rangeEnd).toFixed(2)}" data-exp-field="rangeEnd">
            </label>
          </div>
          <div class="exp-pill-row">
            <button data-exp-act="set-in" title="Set export start to current playhead">In = Playhead</button>
            <button data-exp-act="set-out" title="Set export end to current playhead">Out = Playhead</button>
          </div>` : ''}

        ${st.busy ? `<div class="exp-progress"><div style="width:${Math.round((st.progress || 0) * 100)}%"></div></div>` : ''}
        ${st.message ? `<div class="exp-status muted">${esc(st.message)}</div>` : ''}
        <div class="exp-actions">
          <button class="primary exp-go" data-exp-act="start" ${st.busy ? 'disabled' : ''}>${st.busy ? `Exporting ${Math.round((st.progress || 0) * 100)}%…` : `Export ${cfg.format}`}</button>
          ${st.lastPath ? '<button data-exp-act="reveal">Show in folder</button>' : ''}
        </div>
      </div>`;
  }

  function update(s) {
    if (s.exportOpen) {
      renderExportPanel(s);
      return;
    }
    const c = s.selected ? T.findClip(s.clips, s.selected) : null;
    if (!c) {
      if (lastStructKey !== 'none') {
        lastStructKey = 'none';
        root.innerHTML = '<p class="muted">Select a clip on the timeline to edit its properties, filters, HSL, or transitions. Drag or Ctrl+scroll over any slider (double-click to reset).</p>';
      }
      return;
    }
    const isVideo = c.kind === 'video';
    const isMedia = isVideo || c.kind === 'audio';
    if (!isVideo && tab !== 'clip') tab = 'clip';

    const { bands, active } = isVideo ? activeBandOf(c) : { bands: [], active: null };
    const multiCount = s.selectedIds && s.selectedIds.length > 1 ? s.selectedIds.length : 1;
    const activeTr = c.transition > 0 ? (c.transitionType || 'dissolve') : 'none';
    const structKey = [
      c.id, c.name, c.track, c.start.toFixed(2), c.dur.toFixed(2), c.speed,
      c.muted, c.flipH, c.flipV, c.fill, activeTr, tab, s.eyedropper, multiCount,
      bands.map((b) => b.id).join(','), active ? active.id : '',
    ].join('|');

    if (structKey === lastStructKey) {
      patchInPlace(c);
      return;
    }
    lastStructKey = structKey;

    const scrubField = (prop, band = null, bandKey = null) => {
      const def = T.PROPS[prop];
      const val = band ? (typeof band[bandKey] === 'number' ? band[bandKey] : def.default) : T.propValue(c, prop);
      const pct = Math.min(100, Math.max(0, ((val - def.min) / (def.max - def.min)) * 100));
      const changed = Math.abs(val - def.default) > 1e-4 ? ' changed' : '';
      const bandAttrs = band ? ` data-scrub-band="${esc(band.id)}" data-scrub-band-key="${esc(bandKey)}"` : '';
      return `
      <div class="scrub-field${changed}" tabindex="0" role="slider" aria-label="${def.label}" title="Drag or Ctrl+scroll to adjust · Double-click to reset"
           data-scrub-clip="${esc(c.id)}" data-scrub-prop="${prop}"${bandAttrs}
           aria-valuemin="${def.min}" aria-valuemax="${def.max}" aria-valuenow="${val}">
        <span class="scrub-bar" style="width:${pct}%"></span>
        <span class="scrub-label">${def.label}</span>
        <span class="scrub-value">${def.format(val)}</span>
      </div>`;
    };

    const tabsHtml = isVideo ? `
      <div class="insp-tabs" role="tablist">
        <button class="${tab === 'clip' ? 'on' : ''}" data-insp-tab="clip">Clip</button>
        <button class="${tab === 'filters' ? 'on' : ''}" data-insp-tab="filters">Filters</button>
        <button class="${tab === 'hsl' ? 'on' : ''}" data-insp-tab="hsl">HSL${bands.filter(isBandActive).length ? ` (${bands.filter(isBandActive).length})` : ''}</button>
        <button class="${tab === 'transitions' ? 'on' : ''}" data-insp-tab="transitions">Transitions</button>
      </div>` : '';

    let bodyHtml = '';
    if (tab === 'filters' && isVideo) {
      bodyHtml = `
        <div class="insp-filter-list">
          ${T.FILTER_PROPS.map((p) => scrubField(p)).join('')}
        </div>
        <div class="insp-row">
          <button data-act="reset-filters">Reset all filters</button>
        </div>`;
    } else if (tab === 'hsl' && isVideo && active) {
      const targetHex = normalizeHex(active.hex, '#ef4444');
      const bandPills = bands.map((b, i) => `
        <div class="hsl-band-pill${b.id === active.id ? ' on' : ''}${isBandActive(b) ? ' modified' : ''}" data-hsl-band="${esc(b.id)}" role="button" tabindex="0" title="Edit color #${i + 1} (${esc(b.hex)})">
          <span class="hsl-band-dot" style="background:${esc(b.hex)}"></span>
          <span class="hsl-band-idx">#${i + 1}</span>
          ${bands.length > 1 ? `<button type="button" class="hsl-band-rm" data-hsl-remove="${esc(b.id)}" title="Remove color">×</button>` : ''}
        </div>`).join('');
      const canAdd = bands.length < MAX_HSL_BANDS;

      bodyHtml = `
        <div class="hsl-bands-bar">
          ${bandPills}
          ${canAdd ? '<button type="button" class="hsl-add-band" data-act="add-hsl-band" title="Add another color to control simultaneously">+ Color</button>' : ''}
        </div>
        <div class="hsl-wheel-row">
          <canvas class="hsl-wheel" width="136" height="136" title="Click or drag to pick a target color"></canvas>
          <div class="hsl-controls">
            <div class="lbl">Target color</div>
            <div class="hsl-hex-row">
              <span class="hsl-chip" style="background:${esc(targetHex)}"></span>
              <input class="hsl-hex-input" data-hsl-hex="1" value="${esc(targetHex.toUpperCase())}" maxlength="7" spellcheck="false" aria-label="Hex color code">
            </div>
            <div class="hsl-dropper-row">
              <button class="hsl-dropper-btn${s.eyedropper === 'replace' ? ' on' : ''}" data-act="eyedropper" title="Pick a color from the video for this slot">💧 ${s.eyedropper === 'replace' ? 'Click video…' : 'Pick color'}</button>
              ${canAdd ? `<button class="hsl-dropper-btn${s.eyedropper === 'add' ? ' on' : ''}" data-act="eyedropper-add" title="Pick a new color from the video and add it as a new slot">+💧 New</button>` : ''}
            </div>
            <div class="hsl-swatches">
              ${HSL_SWATCHES.map((sw) => `<button type="button" class="hsl-swatch${targetHex.toLowerCase() === sw ? ' on' : ''}" data-hsl-swatch="${sw}" style="background:${sw}" title="${sw}"></button>`).join('')}
            </div>
          </div>
        </div>
        <div class="insp-filter-list">
          ${HSL_BAND_FIELDS.map((f) => scrubField(f.prop, active, f.key)).join('')}
        </div>
        <div class="insp-row">
          <button data-act="reset-hsl">Reset all HSL</button>
        </div>`;
    } else if (tab === 'transitions' && isVideo) {
      bodyHtml = `
        <div class="lbl">Transition preset</div>
        <div class="insp-tr-grid">
          ${T.TRANSITION_TYPES.map((t) => `<button class="${activeTr === t.id ? 'on' : ''}" data-tr-type="${t.id}">${esc(t.label)}</button>`).join('')}
        </div>
        ${activeTr !== 'none' ? scrubField('transition') : '<p class="muted hint">Pick a transition above to apply it to this clip.</p>'}`;
    } else {
      bodyHtml = `
        ${isMedia ? scrubField('volume') : ''}
        ${isVideo ? scrubField('opacity') : ''}
        ${isVideo ? scrubField('blur') : ''}
        ${isVideo ? `<div class="lbl">Transform <span class="muted">(Shift + trackpad in Viewer)</span></div>
        ${T.TRANSFORM_PROPS.map((p) => scrubField(p)).join('')}
        <div class="insp-row">
          <button class="${c.flipH ? 'on' : ''}" data-act="mirror-h" title="Mirror horizontally">⇄ Mirror H</button>
          <button class="${c.flipV ? 'on' : ''}" data-act="mirror-v" title="Mirror vertically">⇅ Mirror V</button>
          <button data-act="reset-transform" title="Reset scale, rotation, position, and mirror">Reset</button>
        </div>` : ''}
        ${isVideo ? `<div class="lbl">Framing</div>
        <div class="insp-row">
          <button class="${c.fill ? 'on' : ''}" data-act="fill" title="Fill the export frame, cropping the edges (for vertical Shorts from wide clips)">▣ Fill frame</button>
        </div>
        ${scrubField('zoom')}
        ${scrubField('panX')}
        ${scrubField('panY')}` : ''}
        ${isMedia ? `<div class="insp-row"><button data-act="mute">${c.muted ? 'Unmute' : 'Mute'}</button>
          ${isVideo && c.hasAudio !== false && !c.muted ? '<button data-act="detach">Separate Audio Track</button>' : ''}</div>` : ''}
        <div class="insp-row"><button data-act="delete">Delete clip</button></div>`;
    }

    const multiNote = multiCount > 1 ? ` · +${multiCount - 1} more selected` : '';
    root.innerHTML = `
      <div class="insp-title" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="muted insp-meta">${esc(c.track)} · start ${c.start.toFixed(2)} s · length ${c.dur.toFixed(2)} s · speed ×${c.speed || 1}${multiNote}</div>
      ${tabsHtml}
      <div class="insp-body">${bodyHtml}</div>`;

    if (tab === 'hsl' && isVideo && active) {
      drawColorWheel(root.querySelector('.hsl-wheel'), normalizeHex(active.hex, '#ef4444'), bands);
    }
  }

  return { el: root, update };
}

// ---------- Tools ----------

export function toolsPanel({ store, actions }) {
  const root = el(`<div class="panel tools">
    <div class="tabs" role="tablist"></div>
    <div class="tool-list"></div>
    <div class="hint muted">Manual editing works now. Upcoming AI &amp; finishing tools are marked as coming soon.</div>
  </div>`);

  root.addEventListener('click', (e) => {
    const page = e.target.closest('[data-page]');
    if (page) return actions.setPage(page.dataset.page);
    const tool = e.target.closest('[data-tool]');
    if (tool && !tool.disabled) actions.runTool(tool.dataset.tool);
  });

  function update(s) {
    root.querySelector('.tabs').innerHTML = PAGES.map((p) =>
      `<button class="${p.id === s.page ? 'on' : ''}" data-page="${p.id}" aria-pressed="${p.id === s.page}">${p.label}</button>`).join('');
    const sel = s.selected ? T.findClip(s.clips, s.selected) : null;
    const label = (t) => {
      if (t.id === 'format') return 'Format: ' + s.format;
      if (t.id === 'resolution') return 'Resolution: ' + s.resolution;
      return t.label;
    };
    root.querySelector('.tool-list').innerHTML = (TOOLS[s.page] || []).map((t) =>
      `<button class="${t.later ? 'tool-soon' : ''}" data-tool="${t.later ? '' : t.id}" ${t.later ? 'disabled title="Coming in a later step"' : ''}>${esc(label(t))}</button>`).join('')
      + `<div class="muted tool-sel">Selected clip: ${esc(sel ? sel.name : 'none')}</div>`;
  }

  return { el: root, update };
}

// ---------- Placeholder windows ----------

export function placeholderPanel(title, text) {
  const root = el(`<div class="panel placeholder"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p></div>`);
  return { el: root, update() {} };
}

// ---------- Remote machines ----------

export function remotePanel({ openRemote }) {
  const root = el(`<div class="panel remote"><h3>Remote machines</h3>
    <p class="muted">Add a machine over ssh to check its GPU, RAM, and ComfyUI models.</p>
    <button data-act="open" class="ai">Open Remote machines</button></div>`);
  root.addEventListener('click', (e) => { if (e.target.closest('[data-act="open"]')) openRemote(); });
  return { el: root, update() {} };
}

export const PANEL_BUILDERS = {
  bin: binPanel,
  viewer: viewerPanel,
  timeline: timelinePanel,
  inspector: inspectorPanel,
  tools: toolsPanel,
  masking: () => placeholderPanel('Masking', 'Masking is not built yet. It will cut a subject out of a shot.'),
  remote: remotePanel,
};
