// Text to video through the Mannimmate CLI (`text-render`, native H3 FL2VA on the ComfyUI machine).
// Pure helpers are at the top so they can be tested. runTextToVideo starts the CLI and reports its JSON events.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SECONDS = 60;
const MAX_CHUNK_SECONDS = 15; // Mannimmate accepts 0.25–15 s per chunk
const MAX_PROMPT_CHARS = 4000;
const RESOLUTIONS = { 320: '320p', 480: '854 × 480', 640: '1138 × 640', 720: '1280 × 720' };
const MAX_STEPS = 100;
const QUALITIES = ['draft', 'normal', 'ultra'];
const ASPECT = '16:9'; // the project default; portrait is not offered yet

// Splits a length into chunks of at most 15 s, each rendered from the same prompt.
function splitChunks(totalSeconds) {
  const chunks = [];
  let start = 0;
  let remaining = totalSeconds;
  while (remaining > 0) {
    const len = Math.min(MAX_CHUNK_SECONDS, remaining);
    chunks.push({ start, end: start + len });
    start += len;
    remaining -= len;
  }
  return chunks;
}

// Checks the dialog input. Returns { ok, value } or { ok: false, error }.
function validateRequest(input) {
  const prompt = String((input && input.prompt) || '').trim();
  const seconds = Number(input && input.seconds);
  const resolution = Number(input && input.resolution);
  const quality = String((input && input.quality) || '');
  const stepsRaw = input && input.steps !== undefined && input.steps !== null && input.steps !== '' ? Number(input.steps) : null;
  if (stepsRaw !== null && (!Number.isInteger(stepsRaw) || stepsRaw < 1 || stepsRaw > MAX_STEPS)) {
    return { ok: false, error: `Steps must be a whole number from 1 to ${MAX_STEPS}.` };
  }
  if (!prompt) return { ok: false, error: 'Write a prompt describing the clip.' };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).` };
  if (prompt.includes('\0')) return { ok: false, error: 'Prompt contains an invalid character.' };
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    return { ok: false, error: `Length must be a whole number of seconds from 1 to ${MAX_SECONDS}.` };
  }
  if (!RESOLUTIONS[resolution]) return { ok: false, error: 'Pick a resolution.' };
  if (!QUALITIES.includes(quality)) return { ok: false, error: 'Pick a quality.' };
  return { ok: true, value: { prompt, seconds, resolution, quality, steps: stepsRaw } };
}

const pad4 = (n) => String(n).padStart(4, '0');

// The numbered prompt file format Mannimmate reads (see its README, "Native H3 text sequences").
function buildPromptFile(prompt, seconds) {
  const chunks = splitChunks(seconds);
  const lines = [`Total chunks: ${chunks.length}`, ''];
  chunks.forEach((c, i) => {
    lines.push(`CHUNK #${i + 1} | ${pad4(c.start)}s-${pad4(c.end)}s`, 'PROMPT:', prompt, '');
  });
  return lines.join('\n');
}

// Arguments for the CLI. quality is the output resolution, preset is the sampling quality.
function buildArgs({ promptFile, resolution, quality, outDir, steps }) {
  const preset = quality === 'draft' ? 'draft' : quality === 'ultra' ? 'ultra' : 'normal';
  return [
    'text-render',
    '--prompt-file', promptFile,
    '--aspect', ASPECT,
    '--quality', String(resolution),
    '--preset', preset,
    ...(steps ? ['--steps', String(steps)] : []),
    '--fps', '24',
    '--gpu-wait', '30',
    '--out-dir', outDir,
    '--json',
  ];
}

// Reads one stdout line. JSON events from the CLI start with "{". Returns the event or null.
function parseEventLine(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  try {
    const event = JSON.parse(text);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

// Turns a CLI event into what the editor shows. Returns null for events it does not show.
function describeEvent(event) {
  switch (event.event) {
    case 'text_sequence': {
      const progress = typeof event.progress === 'number' ? Math.min(1, Math.max(0, event.progress)) : null;
      return { type: 'progress', progress, label: event.label || event.stage || 'Working…' };
    }
    case 'submitted':
      return { type: 'progress', progress: null, label: 'Sent to ComfyUI on the GPU machine…' };
    case 'clip_saved':
      return { type: 'progress', progress: null, label: `Chunk ${event.chunk || ''} saved` };
    case 'saved':
      return event.path ? { type: 'done', path: event.path, frames: event.frames || null } : null;
    default:
      return null;
  }
}

// Starts a render. onEvent receives { type: 'progress'|'done'|'error'|'log', ... }.
// Returns { promise, cancel }. The promise resolves when the CLI exits.
function runTextToVideo({ mannimmateDir, python, request, promptDir, outDir, onEvent }) {
  if (!fs.existsSync(path.join(mannimmateDir, 'mannimmate_cli.py'))) {
    const message = `Mannimmate was not found in ${mannimmateDir}. Set its folder in the dialog.`;
    return { promise: Promise.resolve({ ok: false, error: message }), cancel: () => {} };
  }
  fs.mkdirSync(promptDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const promptFile = path.join(promptDir, `job-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, buildPromptFile(request.prompt, request.seconds), 'utf8');

  const args = [path.join(mannimmateDir, 'mannimmate_cli.py'), ...buildArgs({
    promptFile,
    resolution: request.resolution,
    quality: request.quality,
    steps: request.steps,
    outDir,
  })];

  let child;
  try {
    child = spawn(python, args, { cwd: mannimmateDir, windowsHide: true });
  } catch (e) {
    return { promise: Promise.resolve({ ok: false, error: 'Could not start Python: ' + e.message }), cancel: () => {} };
  }

  let savedPath = null;
  let stderrTail = [];
  let buffer = '';
  const handleLine = (line) => {
    const event = parseEventLine(line);
    if (!event) {
      if (line.trim()) onEvent({ type: 'log', text: line.trim() });
      return;
    }
    if (event.event === 'saved' && event.path) savedPath = event.path;
    const shown = describeEvent(event);
    if (shown) onEvent(shown);
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail.concat(String(chunk).split(/\r?\n/).filter(Boolean))).slice(-10);
  });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, error: 'Could not start Python: ' + e.message }));
    child.on('close', (code, signal) => {
      if (buffer.trim()) handleLine(buffer);
      if (signal) return resolve({ ok: false, cancelled: true, error: 'Cancelled.' });
      if (code === 0 && savedPath) return resolve({ ok: true, path: savedPath });
      const reason = stderrTail.slice(-3).join(' ') || `Mannimmate exited with code ${code}.`;
      resolve({ ok: false, error: reason });
    });
  });

  return {
    promise,
    cancel: () => {
      // SIGTERM lets the CLI cancel its own ComfyUI prompt before it exits.
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    },
  };
}

module.exports = {
  RESOLUTIONS,
  QUALITIES,
  ASPECT,
  MAX_SECONDS,
  splitChunks,
  validateRequest,
  buildPromptFile,
  buildArgs,
  parseEventLine,
  describeEvent,
  runTextToVideo,
};
