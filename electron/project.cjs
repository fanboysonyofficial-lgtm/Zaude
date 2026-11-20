// Project folders: scanning a folder for media, and reading and writing the project file (zaude-project.json).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_FILE = 'zaude-project.json';
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];
const AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'];
const MAX_FILES = 500;
const MAX_DEPTH = 2;

function kindOf(name) {
  const lower = String(name).toLowerCase();
  if (VIDEO_EXT.some((e) => lower.endsWith(e))) return 'video';
  if (AUDIO_EXT.some((e) => lower.endsWith(e))) return 'audio';
  return null;
}

// Reads ffprobe's JSON. Returns { duration, hasVideo, hasAudio, width, height }.
function parseProbe(json) {
  const streams = Array.isArray(json && json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = Number(json && json.format && json.format.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
    hasVideo: Boolean(video),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
  };
}

// Runs ffprobe on one file. Resolves to the parsed info, or null when ffprobe is not available.
function probeFile(file) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(parseProbe(JSON.parse(out))); } catch { resolve(null); }
    });
  });
}

// Lists media files in a folder (up to MAX_DEPTH levels down) and probes each one.
// probe is injectable for tests. Returns { ok, media } or { ok: false, error }.
async function scanFolder(folder, probe = probeFile) {
  let stat;
  try {
    stat = fs.statSync(folder);
  } catch {
    return { ok: false, error: 'The folder does not exist.' };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'That is not a folder.' };

  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && kindOf(e.name)) files.push({ path: full, name: e.name, kind: kindOf(e.name) });
    }
  };
  walk(folder, 0);

  const media = [];
  for (const f of files) {
    const info = await probe(f.path);
    media.push({
      ...f,
      duration: info ? info.duration : null,
      hasVideo: info ? info.hasVideo : f.kind === 'video',
      hasAudio: info ? info.hasAudio : null,
      width: info ? info.width : null,
      height: info ? info.height : null,
    });
  }
  media.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, media };
}

function loadProject(folder) {
  const file = path.join(folder, PROJECT_FILE);
  if (!fs.existsSync(file)) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: 'The project file is damaged: ' + e.message };
  }
}

// Writes the project file atomically. Only writes inside folders the user has opened.
function saveProject(folder, data, allowedFolders) {
  const resolved = path.resolve(folder);
  if (!allowedFolders.some((f) => path.resolve(f) === resolved)) {
    return { ok: false, error: 'Open this folder in Zaude before saving to it.' };
  }
  const file = path.join(resolved, PROJECT_FILE);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { PROJECT_FILE, kindOf, parseProbe, probeFile, scanFolder, loadProject, saveProject };
