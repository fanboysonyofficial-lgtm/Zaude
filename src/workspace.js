// Draws the window layout: areas separated by draggable seams. Seams resize smoothly,
// double-click to reset 50/50, and single-click to open a visual window picker with previews.
import * as L from './layout.js';

const SAVE_KEY = 'zaude.layout';
const SCALE_KEY = 'zaude.scale';
const SCALES = [0.85, 1, 1.15, 1.25];

// Crisp miniature SVG previews for each window type in the Windows picker.
const WINDOW_PREVIEWS = {
  bin: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="7" y="7" width="32" height="7" rx="2" fill="#2A2A36"/>
    <rect x="43" y="7" width="26" height="7" rx="2" fill="#2A2A36"/>
    <rect x="7" y="19" width="82" height="9" rx="2" fill="#22203A" stroke="#8B5CF6" stroke-width="1"/>
    <rect x="11" y="22" width="44" height="3" rx="1" fill="#ECECF2"/>
    <rect x="7" y="31" width="82" height="8" rx="2" fill="#1C1C25"/>
    <rect x="11" y="34" width="36" height="2.5" rx="1" fill="#8E8EA3"/>
    <rect x="7" y="42" width="82" height="8" rx="2" fill="#1C1C25"/>
    <rect x="11" y="45" width="52" height="2.5" rx="1" fill="#8E8EA3"/>
  </svg>`,
  viewer: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="8" y="6" width="80" height="33" rx="3" fill="#07070B" stroke="#2A2A36"/>
    <polygon points="44,16 56,22.5 44,29" fill="#8B5CF6" opacity="0.85"/>
    <rect x="8" y="43" width="80" height="5" rx="2.5" fill="#1C1C25"/>
    <rect x="8" y="43" width="38" height="5" rx="2.5" fill="#8B5CF6" opacity="0.65"/>
    <rect x="45" y="41" width="2" height="9" rx="1" fill="#F4F4F8"/>
  </svg>`,
  timeline: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <line x1="20" y1="11" x2="90" y2="11" stroke="#34343F" stroke-width="1"/>
    <rect x="6" y="15" width="12" height="7" rx="1.5" fill="#2A2A36"/>
    <rect x="22" y="15" width="24" height="7" rx="2" fill="#3B3A22"/>
    <rect x="6" y="25" width="12" height="7" rx="1.5" fill="#2A2A36"/>
    <rect x="20" y="25" width="22" height="7" rx="2" fill="#2E4460"/>
    <rect x="44" y="25" width="28" height="7" rx="2" fill="#2E4460" stroke="#ECECF2" stroke-width="0.9"/>
    <rect x="6" y="35" width="12" height="7" rx="1.5" fill="#2A2A36"/>
    <rect x="20" y="35" width="58" height="7" rx="2" fill="#23464F"/>
    <line x1="48" y1="8" x2="48" y2="48" stroke="#F4F4F8" stroke-width="1.4"/>
  </svg>`,
  inspector: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="8" y="7" width="46" height="4.5" rx="1.5" fill="#ECECF2"/>
    <rect x="8" y="16" width="80" height="11" rx="3" fill="#1B1B24" stroke="#2F2F3B"/>
    <rect x="8" y="16" width="52" height="11" rx="3" fill="#8B5CF6" opacity="0.28"/>
    <rect x="13" y="20" width="24" height="3" rx="1" fill="#A4A4B8"/>
    <rect x="8" y="31" width="80" height="11" rx="3" fill="#1B1B24" stroke="#2F2F3B"/>
    <rect x="8" y="31" width="66" height="11" rx="3" fill="#22D3EE" opacity="0.24"/>
    <rect x="13" y="35" width="24" height="3" rx="1" fill="#A4A4B8"/>
  </svg>`,
  tools: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="7" y="7" width="16" height="6" rx="2" fill="#2A2A36"/>
    <rect x="26" y="7" width="16" height="6" rx="2" fill="#1C1C25"/>
    <rect x="45" y="7" width="18" height="6" rx="2" fill="#1C1C25"/>
    <rect x="7" y="18" width="38" height="12" rx="3" fill="#1C1C25" stroke="#33333F"/>
    <rect x="51" y="18" width="38" height="12" rx="3" fill="#1C1C25" stroke="#33333F"/>
    <rect x="7" y="34" width="38" height="12" rx="3" fill="#2A2440" stroke="#8B5CF6"/>
    <rect x="51" y="34" width="38" height="12" rx="3" fill="#1C1C25" stroke="#33333F"/>
  </svg>`,
  masking: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="10" y="8" width="76" height="40" rx="3" fill="#181822"/>
    <ellipse cx="48" cy="28" rx="18" ry="13" fill="#8B5CF6" fill-opacity="0.22" stroke="#22D3EE" stroke-dasharray="3 2" stroke-width="1.3"/>
    <circle cx="30" cy="28" r="2" fill="#ECECF2"/>
    <circle cx="66" cy="28" r="2" fill="#ECECF2"/>
    <circle cx="48" cy="15" r="2" fill="#ECECF2"/>
    <circle cx="48" cy="41" r="2" fill="#ECECF2"/>
  </svg>`,
  remote: `<svg viewBox="0 0 96 56" aria-hidden="true">
    <rect x="2" y="2" width="92" height="52" rx="4" fill="#121218" stroke="#2F2F3B"/>
    <rect x="10" y="10" width="76" height="14" rx="3" fill="#1C1C25" stroke="#33333F"/>
    <circle cx="18" cy="17" r="3" fill="#34D399"/>
    <rect x="25" y="15" width="36" height="4" rx="1.5" fill="#ECECF2"/>
    <rect x="10" y="29" width="76" height="14" rx="3" fill="#1C1C25" stroke="#8B5CF6"/>
    <circle cx="18" cy="36" r="3" fill="#8B5CF6"/>
    <rect x="25" y="34" width="44" height="4" rx="1.5" fill="#A4A4B8"/>
  </svg>`,
};

export function createWorkspace(root, { createPanel, store, onLayoutChange }) {
  let tree = loadTree();
  const instances = new Map(); // area id -> { type, panel }
  let activeArea = null;
  let maximizedArea = null;
  let popup = null;
  let uiScale = loadScale();

  function loadTree() {
    try {
      return L.deserialize(localStorage.getItem(SAVE_KEY) || '');
    } catch {
      return L.defaultLayout();
    }
  }

  function saveTree() {
    try { localStorage.setItem(SAVE_KEY, L.serialize(tree)); } catch { /* storage not available */ }
  }

  function loadScale() {
    try {
      const saved = Number(localStorage.getItem(SCALE_KEY));
      if (SCALES.includes(saved)) return saved;
    } catch { /* ignore */ }
    return 1;
  }

  function applyScale(scale) {
    uiScale = SCALES.includes(scale) ? scale : 1;
    try { localStorage.setItem(SCALE_KEY, String(uiScale)); } catch { /* ignore */ }
    document.documentElement.style.setProperty('--ui-scale', String(uiScale));
    document.documentElement.style.fontSize = Math.round(12 * uiScale) + 'px';
    updatePanels();
  }

  function panelFor(area) {
    let inst = instances.get(area.id);
    if (!inst || inst.type !== area.type) {
      if (inst && inst.panel.destroy) inst.panel.destroy();
      inst = { type: area.type, panel: createPanel(area.type) };
      instances.set(area.id, inst);
    }
    return inst.panel;
  }

  function setActiveArea(id) {
    if (activeArea === id) return;
    activeArea = id;
    root.querySelectorAll('.area').forEach((el) => {
      el.classList.toggle('active', el.dataset.area === activeArea);
    });
  }

  function renderNode(node, totalAreas) {
    if (node.kind === 'area') {
      const panel = panelFor(node);
      const isMax = maximizedArea === node.id;
      const el = document.createElement('section');
      el.className = 'area' + (activeArea === node.id ? ' active' : '') + (isMax ? ' maximized' : '');
      el.dataset.area = node.id;
      el.innerHTML = `
        <header class="area-head">
          <select class="area-type" aria-label="Window type">
            ${L.WINDOW_TYPES.map((t) => `<option value="${t.id}" ${t.id === node.type ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
          <span class="grow"></span>
          <div class="area-actions">
            <button class="area-btn" data-area-act="split-row" aria-label="Split right" title="Split right">◫</button>
            <button class="area-btn" data-area-act="split-col" aria-label="Split down" title="Split down">⬓</button>
            <button class="area-btn" data-area-act="maximize" aria-label="${isMax ? 'Restore window' : 'Maximize window'}" title="${isMax ? 'Restore layout' : 'Maximize window'}">${isMax ? '⤡' : '⤢'}</button>
            ${totalAreas > 1 && !isMax ? '<button class="area-btn area-close" data-area-act="close" aria-label="Close window" title="Close window">×</button>' : ''}
          </div>
        </header>`;
      const body = document.createElement('div');
      body.className = 'area-body';
      body.appendChild(panel.el);
      el.appendChild(body);
      el.addEventListener('pointerdown', () => setActiveArea(node.id), true);
      el.querySelector('.area-type').addEventListener('change', (e) => {
        tree = L.setType(tree, node.id, e.target.value);
        commit();
      });
      el.querySelector('.area-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-area-act]');
        if (!btn) return;
        const act = btn.dataset.areaAct;
        if (act === 'close') {
          if (L.allAreas(tree).length <= 1) return;
          if (maximizedArea === node.id) maximizedArea = null;
          tree = L.removeNode(tree, node.id);
          commit();
        } else if (act === 'split-row' || act === 'split-col') {
          maximizedArea = null;
          const dir = act === 'split-row' ? 'row' : 'col';
          openWindowPicker(btn, `Split ${dir === 'row' ? 'right' : 'down'} with…`, (type) => {
            tree = L.addBeside(tree, node.id, type, dir);
            commit();
          });
        } else if (act === 'maximize') {
          maximizedArea = isMax ? null : node.id;
          render();
        }
      });
      return el;
    }

    const wrap = document.createElement('div');
    wrap.className = 'split ' + (node.dir === 'row' ? 'split-row' : 'split-col');
    wrap.dataset.split = node.id;
    const a = renderNode(node.a, totalAreas);
    const b = renderNode(node.b, totalAreas);
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    const seam = document.createElement('div');
    seam.className = 'seam ' + (node.dir === 'row' ? 'seam-v' : 'seam-h');
    seam.title = 'Drag to resize · Double-click to reset 50/50 · Click to add a window';
    seam.setAttribute('role', 'separator');
    seam.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
    seam.innerHTML = '<span class="seam-grip" aria-hidden="true"></span>';
    seam.addEventListener('pointerdown', (e) => startSeamDrag(e, node, wrap, a, b));
    seam.addEventListener('dblclick', (e) => {
      e.preventDefault();
      closePopup();
      tree = L.setRatio(tree, node.id, 0.5);
      commit();
    });
    wrap.append(a, seam, b);
    return wrap;
  }

  function render() {
    closePopup();
    const areas = L.allAreas(tree);
    if (!activeArea || !areas.some((a) => a.id === activeArea)) {
      activeArea = areas[0] ? areas[0].id : null;
    }
    if (maximizedArea && !areas.some((a) => a.id === maximizedArea)) {
      maximizedArea = null;
    }

    root.innerHTML = '';
    // drop panels for areas that no longer exist
    const live = new Set(areas.map((a) => a.id));
    for (const [id, inst] of instances) {
      if (!live.has(id)) {
        if (inst.panel.destroy) inst.panel.destroy();
        instances.delete(id);
      }
    }

    const viewTree = maximizedArea ? areas.find((a) => a.id === maximizedArea) : tree;
    root.appendChild(renderNode(viewTree, areas.length));
    updatePanels();
    if (onLayoutChange) onLayoutChange();
  }

  function updatePanels() {
    const s = store.get();
    for (const inst of instances.values()) {
      if (inst.panel.update) inst.panel.update(s);
    }
  }

  function commit() {
    saveTree();
    render();
  }

  function resetLayout() {
    maximizedArea = null;
    tree = L.defaultLayout();
    commit();
  }

  // ---------- seams ----------

  function startSeamDrag(e, node, wrap, a, b) {
    if (e.button !== 0 || e.detail > 1) return; // ignore double-click second press
    e.preventDefault();
    const vertical = node.dir === 'row';
    const rect = wrap.getBoundingClientRect();
    const total = vertical ? rect.width : rect.height;
    if (total <= 0) return;
    const startPos = vertical ? e.clientX : e.clientY;
    const startRatio = node.ratio;
    const minRatio = Math.min(0.45, Math.max(0.05, L.MIN_AREA_PX / total));
    let moved = false;
    let liveRatio = startRatio;
    const seam = e.currentTarget;
    try { seam.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer */ }

    const onMove = (ev) => {
      const pos = vertical ? ev.clientX : ev.clientY;
      const delta = pos - startPos;
      if (!moved && Math.abs(delta) > 3) {
        moved = true;
        seam.classList.add('dragging');
        document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
      }
      if (!moved) return;
      liveRatio = Math.min(1 - minRatio, Math.max(minRatio, (total * startRatio + delta) / total));
      a.style.flex = `${liveRatio} 1 0`;
      b.style.flex = `${1 - liveRatio} 1 0`;
    };

    const onUp = () => {
      seam.removeEventListener('pointermove', onMove);
      seam.removeEventListener('pointerup', onUp);
      seam.removeEventListener('pointercancel', onUp);
      seam.classList.remove('dragging');
      document.body.style.cursor = '';
      if (moved) {
        tree = L.setRatio(tree, node.id, liveRatio);
        saveTree();
        updatePanels();
      } else {
        openSeamMenu(e.clientX, e.clientY, node.id);
      }
    };
    seam.addEventListener('pointermove', onMove);
    seam.addEventListener('pointerup', onUp);
    seam.addEventListener('pointercancel', onUp);
  }

  // ---------- visual window picker menus ----------

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
    document.removeEventListener('pointerdown', outsideClose, true);
    document.removeEventListener('keydown', escClose);
  }

  function outsideClose(e) {
    if (popup && !popup.contains(e.target)) closePopup();
  }

  function escClose(e) {
    if (e.key === 'Escape') closePopup();
  }

  function openMenu(x, y, title, onPick, { showExtras = false } = {}) {
    closePopup();
    popup = document.createElement('div');
    popup.className = 'menu window-picker';
    popup.setAttribute('role', 'menu');

    const cards = L.WINDOW_TYPES.map((t) => `
      <button class="win-card" role="menuitem" data-type="${t.id}">
        <span class="win-thumb">${WINDOW_PREVIEWS[t.id] || ''}</span>
        <span class="win-meta">
          <span class="win-name">${t.label}</span>
          <span class="win-desc muted">${t.desc || ''}</span>
        </span>
      </button>`).join('');

    const extras = showExtras ? `
      <div class="picker-footer">
        <div class="scale-group" role="group" aria-label="Interface scale">
          <span class="muted">UI Scale</span>
          ${SCALES.map((sc) => `<button type="button" class="scale-btn${sc === uiScale ? ' on' : ''}" data-scale="${sc}">${Math.round(sc * 100)}%</button>`).join('')}
        </div>
        <button type="button" class="reset-btn" data-reset="1">Reset layout</button>
      </div>` : '';

    popup.innerHTML = `<div class="menu-title">${title}</div><div class="win-grid">${cards}</div>${extras}`;
    document.body.appendChild(popup);
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    popup.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    popup.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';

    popup.addEventListener('click', (e) => {
      const scaleBtn = e.target.closest('[data-scale]');
      if (scaleBtn) {
        applyScale(Number(scaleBtn.dataset.scale));
        popup.querySelectorAll('[data-scale]').forEach((b) => b.classList.toggle('on', Number(b.dataset.scale) === uiScale));
        return;
      }
      if (e.target.closest('[data-reset]')) {
        closePopup();
        resetLayout();
        return;
      }
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      const type = btn.dataset.type;
      closePopup();
      onPick(type);
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', outsideClose, true);
      document.addEventListener('keydown', escClose);
    }, 0);
  }

  function openWindowPicker(anchor, title, onPick) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, title, onPick);
  }

  function openSeamMenu(x, y, splitId) {
    openMenu(x, y, 'Insert window at seam', (type) => {
      maximizedArea = null;
      tree = L.insertAtSeam(tree, splitId, type);
      commit();
    });
  }

  // The Windows tab (top left): adds a window next to the active one, with visual previews & scale options.
  function openWindowsMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, 'Add a window', (type) => {
      maximizedArea = null;
      const areas = L.allAreas(tree);
      const target = areas.find((a) => a.id === activeArea) || areas[areas.length - 1];
      tree = L.addBeside(tree, target.id, type, 'row');
      commit();
    }, { showExtras: true });
  }

  function init() {
    applyScale(uiScale);
    render();
    window.addEventListener('resize', updatePanels);
  }

  store.subscribe(() => updatePanels());
  store.subscribeTime((s) => {
    for (const inst of instances.values()) {
      if (inst.panel.updateTime) inst.panel.updateTime(s);
    }
  });

  function ensurePanel(type) {
    const areas = L.allAreas(tree);
    if (areas.some((a) => a.type === type)) return;
    maximizedArea = null;
    const target = areas.find((a) => a.type === 'viewer') || areas[areas.length - 1];
    tree = L.addBeside(tree, target.id, type, 'row');
    commit();
  }

  return {
    init,
    render,
    resetLayout,
    applyScale,
    ensurePanel,
    openWindowsMenu,
    getTree: () => tree,
  };
}
