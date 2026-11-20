// "Remote machines" panel. Lists saved ssh machines with their last analysis, adds new ones,
// runs the analysis (and Reconfigure), and shows the full report.
// Requires the desktop app: window.zaudeRemote is provided by electron/preload.cjs.

const api = window.zaudeRemote || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let machines = [];
let viewingId = null;   // when set, the report for this machine is shown
const busy = new Set(); // machine ids with an analysis running
let message = '';
let messageIsError = false;

function setMessage(text, isError = false) {
  message = text;
  messageIsError = isError;
  renderMessage();
}

function renderMessage() {
  const el = $('rm-message');
  el.textContent = message;
  el.className = 'rm-msg' + (messageIsError ? ' err' : '');
}

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}

function summary(m) {
  const r = m.report;
  if (!r) return 'Not analyzed yet';
  const gpu = r.gpus[0] ? `${r.gpus[0].name}, ${r.gpus[0].vramGB} GB VRAM` : 'No NVIDIA GPU';
  const comfy = r.comfyui.present
    ? `ComfyUI ${r.comfyui.running ? 'running' : 'installed'}, ${r.comfyui.modelCount} model files`
    : 'No ComfyUI';
  return `${gpu} · ${r.ramGB} GB RAM · ${comfy}`;
}

function renderList() {
  const rows = machines.length
    ? machines.map((m) => {
        const isBusy = busy.has(m.id);
        const err = m.lastError ? `<div class="rm-err">Last attempt failed (${esc(when(m.lastError.at))}): ${esc(m.lastError.message)}</div>` : '';
        const analyzed = m.analyzedAt ? `Analyzed ${esc(when(m.analyzedAt))}` : '';
        return `<li class="rm-row">
          <div class="rm-info">
            <div><b>${esc(m.name)}</b> <span class="muted">${esc(m.target)}${m.port ? ':' + esc(m.port) : ''}</span></div>
            <div class="rm-sum">${esc(summary(m))}</div>
            ${analyzed ? `<div class="muted">${analyzed}</div>` : ''}
            ${err}
          </div>
          <div class="rm-actions">
            <button data-rm="view" data-id="${esc(m.id)}" ${m.report ? '' : 'disabled'}>View report</button>
            <button data-rm="analyze" data-id="${esc(m.id)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Analyzing…' : m.report ? 'Reconfigure' : 'Analyze'}</button>
            <button data-rm="remove" data-id="${esc(m.id)}" ${isBusy ? 'disabled' : ''}>Remove</button>
          </div>
        </li>`;
      }).join('')
    : '<p class="muted">No remote machines yet. Add one below.</p>';

  return `<ul class="rm-list">${rows}</ul>
    <form id="rm-form" class="rm-form">
      <h3>Add a machine</h3>
      <label>Name <input name="name" placeholder="e.g. tranklena" required maxlength="60" autocomplete="off"></label>
      <label>SSH host <input name="target" placeholder="tranklena or user@192.168.1.20" required autocomplete="off"></label>
      <label>Port <input name="port" placeholder="22 (optional)" autocomplete="off" inputmode="numeric"></label>
      <label>Key file <input name="keyPath" placeholder="optional, e.g. ~/.ssh/id_ed25519" autocomplete="off"></label>
      <p class="muted rm-hint">Uses your ssh setup, including ~/.ssh/config and keys. Password logins are not supported. The machine must be reachable with ssh from this computer.</p>
      <button type="submit" class="primary">Add and analyze</button>
    </form>`;
}

function listItems(items, limit = 30) {
  if (!items.length) return '<span class="muted">none</span>';
  const shown = items.slice(0, limit).map(esc).join(', ');
  return items.length > limit ? `${shown} … (${items.length} total)` : shown;
}

function renderReport(m) {
  const r = m.report;
  const gpus = r.gpus.length
    ? r.gpus.map((g) => `<li>${esc(g.name)}: ${g.vramGB} GB VRAM</li>`).join('')
    : '<li class="muted">No NVIDIA GPU detected</li>';
  const folders = Object.entries(r.models).map(([name, items]) =>
    `<li><b>${esc(name)}</b> (${items.length}): ${listItems(items)}</li>`).join('');
  const comfy = r.comfyui.present
    ? `Installed at <code>${esc(r.comfyui.path)}</code>, ${r.comfyui.running ? 'running now' : 'not running'}, ${r.comfyui.modelCount} model files`
    : 'Not found';
  const isBusy = busy.has(m.id);
  return `<div class="rm-report">
    <div class="rm-report-head">
      <button data-rm="back">Back</button>
      <button data-rm="analyze" data-id="${esc(m.id)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Analyzing…' : 'Reconfigure'}</button>
    </div>
    <h3>${esc(m.name)} <span class="muted">${esc(m.target)}</span></h3>
    <p class="muted">Analyzed ${esc(when(m.analyzedAt))} · ${esc(r.os)}</p>
    <section><h4>Hardware</h4><ul>
      <li>CPU: ${esc(r.cpu.model)} (${r.cpu.cores} threads)</li>
      <li>RAM: ${r.ramGB} GB · Free disk: ${r.diskFreeGB} GB</li>
      ${gpus}
    </ul></section>
    <section><h4>ComfyUI</h4><p>${comfy}</p></section>
    <section><h4>Models</h4><ul>${folders}</ul></section>
    <section><h4>What this machine can do</h4><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>
  </div>`;
}

function render() {
  if (!api) return;
  const body = $('rm-body');
  const m = viewingId ? machines.find((x) => x.id === viewingId) : null;
  if (m && m.report) {
    body.innerHTML = renderReport(m);
  } else {
    viewingId = null;
    body.innerHTML = renderList();
  }
  renderMessage();
}

async function refresh() {
  machines = await api.list();
  render();
}

async function analyze(id) {
  busy.add(id);
  render();
  setMessage('Connecting and analyzing… this can take up to a minute.');
  const res = await api.analyze(id);
  busy.delete(id);
  machines = await api.list();
  if (res.ok) {
    setMessage('Analysis saved. The app will remember this machine.');
    viewingId = id;
  } else {
    setMessage('Analysis failed: ' + res.error, true);
  }
  render();
}

async function onAdd(form) {
  const data = Object.fromEntries(new FormData(form));
  const added = await api.add(data);
  if (!added.ok) {
    setMessage(added.error, true);
    return;
  }
  form.reset();
  await refresh();
  await analyze(added.machine.id);
}

async function onClick(e) {
  const btn = e.target.closest('[data-rm]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  switch (btn.dataset.rm) {
    case 'view': viewingId = id; setMessage(''); render(); break;
    case 'back': viewingId = null; setMessage(''); render(); break;
    case 'analyze': await analyze(id); break;
    case 'remove': {
      const m = machines.find((x) => x.id === id);
      if (!m || !confirm(`Remove ${m.name} and its saved report?`)) return;
      const res = await api.remove(id);
      machines = res.machines;
      if (viewingId === id) viewingId = null;
      setMessage('Removed ' + m.name);
      render();
      break;
    }
  }
}

function open() {
  $('remote-dialog').hidden = false;
  setMessage('');
  refresh().catch((err) => setMessage('Could not load machines: ' + err.message, true));
  $('rm-close').focus();
}

function close() {
  $('remote-dialog').hidden = true;
}

function init() {
  const openBtn = $('remote-open');
  if (!api) {
    openBtn.disabled = true;
    openBtn.title = 'Remote machines are available in the desktop app';
    return;
  }
  openBtn.addEventListener('click', open);
  $('rm-close').addEventListener('click', close);
  $('remote-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'remote-dialog') close();
    else onClick(e);
  });
  $('remote-dialog').addEventListener('submit', (e) => {
    if (e.target.id === 'rm-form') {
      e.preventDefault();
      onAdd(e.target);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('remote-dialog').hidden) close();
  });
}

init();
