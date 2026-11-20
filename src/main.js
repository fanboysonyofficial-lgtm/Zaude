// Starts the editor: state, playback, the window layout, panels, and keyboard shortcuts.
import * as T from './timeline.js';
import { createStore } from './store.js';
import { createEngine } from './engine.js';
import { createActions, initialState } from './actions.js';
import { createWorkspace } from './workspace.js';
import { PANEL_BUILDERS } from './panels.js';
import { installScrub } from './scrub.js';
import { createThumbCache } from './thumbs.js';
import { createWaveformCache } from './waveform.js';

const store = createStore(initialState());
const engine = createEngine(store);
const actions = createActions(store, engine);
const thumbs = createThumbCache({ getMediaUrl: engine.getMediaUrl });
const waveforms = createWaveformCache({
  fetchWaveform: (filePath) => (window.zaudeProject && window.zaudeProject.waveform ? window.zaudeProject.waveform(filePath) : Promise.resolve(null)),
});

const ctx = {
  store,
  actions,
  engine,
  thumbs,
  waveforms,
  openRemote: () => document.getElementById('remote-open').click(),
};

const workspaceEl = document.getElementById('workspace');
const workspace = createWorkspace(workspaceEl, {
  store,
  createPanel: (type) => PANEL_BUILDERS[type](ctx),
  onLayoutChange: () => engine.sync(),
});
workspace.init();
installScrub(workspaceEl, { store, actions });

document.getElementById('windows-open').addEventListener('click', (e) => {
  workspace.openWindowsMenu(e.currentTarget);
});
document.getElementById('open-zd').addEventListener('click', () => actions.openZd());
document.getElementById('save-zd').addEventListener('click', (e) => actions.saveZd(e.shiftKey));
document.getElementById('export-top').addEventListener('click', () => {
  workspace.ensurePanel('inspector');
  actions.toggleExport();
});

// AI render events come from the text to video dialog (ai-ui.js)
window.addEventListener('zaude:t2v', (e) => actions.generationEvent(e.detail));

// keyboard shortcuts, ignored while typing or in a dialog
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.target.closest('.modal')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); return e.shiftKey ? actions.redo() : actions.undo(); }
  if (mod && key === 'y') { e.preventDefault(); return actions.redo(); }
  if (mod && key === 's') { e.preventDefault(); return actions.saveZd(e.shiftKey); }
  if (mod && key === 'o') { e.preventDefault(); return actions.openZd(); }
  if (mod) return;
  if (e.key === 'Escape' && store.get().eyedropper) { e.preventDefault(); return actions.setEyedropper(false); }
  if (e.key === ' ') { e.preventDefault(); return actions.togglePlay(); }
  if (key === 's') { e.preventDefault(); return actions.split(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); return actions.stepBy(e.shiftKey ? -1 : -1 / T.FPS); }
  if (e.key === 'ArrowRight') { e.preventDefault(); return actions.stepBy(e.shiftKey ? 1 : 1 / T.FPS); }
  if (e.key === 'Home') { e.preventDefault(); return actions.seekTo(0); }
  if (e.key === 'End') { e.preventDefault(); return actions.seekTo(T.projectEnd(store.get().clips)); }
  if (e.key === '=' || e.key === '+') return actions.zoomIn();
  if (e.key === '-' || e.key === '_') return actions.zoomOut();
  if (e.key === 'Delete' || e.key === 'Backspace') { if (store.get().selected) actions.deleteSelected(); }
});

// the wheel and drag gestures are installed by installScrub; the Windows menu closes itself on outside clicks
window.zaudeEditor = { store, actions, engine, workspace };
