// "Text to video" dialog. Sends the prompt, length and quality to the desktop app,
// which runs the Mannimmate CLI and reports progress back. Requires the desktop app (window.zaudeAI).

const api = window.zaudeAI || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

let jobId = null;   // the render this window is following
let running = false;

function setStatus(text, isError = false) {
  const el = $('t2v-status');
  el.textContent = text;
  el.className = 't2v-status' + (isError ? ' err' : '');
}

function setRunning(on) {
  running = on;
  $('t2v-generate').disabled = on;
  $('t2v-cancel').disabled = !on;
  $('t2v-form').querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.name && el.name !== 'mannimmateDir') el.disabled = on;
  });
  if (!on) $('t2v-progress').hidden = true;
}

function showProgress(progress) {
  const wrap = $('t2v-progress');
  wrap.hidden = false;
  if (typeof progress === 'number') {
    wrap.classList.remove('indeterminate');
    $('t2v-bar').style.width = Math.round(progress * 100) + '%';
  } else {
    wrap.classList.add('indeterminate');
  }
}

function showResult(path) {
  $('t2v-result').innerHTML = `
    <div>Saved clip:</div>
    <code>${esc(path)}</code>
    <div><button type="button" data-reveal="${esc(path)}">Show in folder</button></div>`;
}

function clearResult() {
  $('t2v-result').innerHTML = '';
}

async function open() {
  $('t2v-dialog').hidden = false;
  setStatus('');
  clearResult();
  try {
    const settings = await api.getSettings();
    $('t2v-form').elements.mannimmateDir.value = settings.mannimmateDir;
  } catch (err) {
    setStatus('Could not read settings: ' + err.message, true);
  }
  $('t2v-form').elements.prompt.focus();
}

function close() {
  $('t2v-dialog').hidden = true;
}

async function onSubmit(form) {
  if (running) return;
  const data = new FormData(form);
  const dir = String(data.get('mannimmateDir') || '').trim();
  if (dir) await api.setSettings({ mannimmateDir: dir });

  const result = await api.startTextToVideo({
    prompt: data.get('prompt'),
    seconds: data.get('seconds'),
    resolution: data.get('resolution'),
    quality: data.get('quality'),
    steps: data.get('steps'),
  });
  if (!result.ok) {
    setStatus(result.error, true);
    return;
  }
  jobId = result.id;
  notifyEditor({ type: 'start', id: result.id, seconds: Number(data.get('seconds')) });
  clearResult();
  setRunning(true);
  showProgress(null);
  setStatus('Starting Mannimmate…');
}

function notifyEditor(detail) {
  window.dispatchEvent(new CustomEvent('zaude:t2v', { detail }));
}

function onJob(payload) {
  if (!jobId || payload.id !== jobId) return;
  notifyEditor({ ...payload });
  switch (payload.type) {
    case 'progress':
      setStatus(payload.label || 'Working…');
      showProgress(payload.progress);
      break;
    case 'log':
      break;
    case 'done':
      setRunning(false);
      jobId = null;
      setStatus('Done.');
      showResult(payload.path);
      break;
    case 'cancelled':
      setRunning(false);
      jobId = null;
      setStatus('Cancelled. If ComfyUI already started this clip, it may still finish on the GPU machine.');
      break;
    case 'error':
      setRunning(false);
      jobId = null;
      setStatus(payload.message || 'The render failed.', true);
      break;
  }
}

async function onCancel() {
  if (!jobId) return;
  const res = await api.cancelTextToVideo(jobId);
  if (!res.ok) setStatus(res.error, true);
}

function init() {
  const openBtn = $('t2v-open');
  if (!api) {
    openBtn.disabled = true;
    openBtn.title = 'Text to video is available in the desktop app';
    return;
  }
  openBtn.addEventListener('click', open);
  $('t2v-close').addEventListener('click', close);
  $('t2v-cancel').addEventListener('click', onCancel);
  $('t2v-dialog').addEventListener('click', (e) => {
    if (e.target.id === 't2v-dialog') close();
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) api.reveal(reveal.dataset.reveal);
  });
  $('t2v-form').addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit(e.target);
  });
  api.onJob(onJob);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('t2v-dialog').hidden) close();
  });
}

init();
