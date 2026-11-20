#!/usr/bin/env node
// Renders a saved Zaude project folder (zaude-project.json) from the command line, with the
// same renderer as the Export button, so batch jobs and the app give identical results.
//
//   node electron/cli-render.cjs <project-folder> <output.mp4> [--size 1080x1920] [--fps 30] [--quality high]
//
// Clip paths in the project may be absolute or relative to the project folder. A "captions"
// file (.ass/.srt) named in the project is burned in.
const fs = require('node:fs');
const path = require('node:path');
const { loadProject } = require('./project.cjs');
const { renderTimeline } = require('./render.cjs');

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  if (pos.length < 2) {
    console.error('usage: cli-render.cjs <project-folder> <output.mp4> [--size WxH] [--fps N] [--quality draft|standard|high|ultra]');
    process.exit(2);
  }
  const folder = path.resolve(pos[0]);
  const output = path.resolve(pos[1]);
  const loaded = loadProject(folder);
  if (!loaded.ok || !loaded.data) {
    console.error(loaded.error || `No zaude-project.json in ${folder}`);
    process.exit(1);
  }
  const data = loaded.data;
  const clips = (data.clips || []).map((c) => (c.path && !path.isAbsolute(c.path) ? { ...c, path: path.join(folder, c.path) } : c));
  const [w, h] = String(opt.size || data.resolution || '1080x1920').split(/\s*[x×]\s*/).map(Number);
  let subtitles = null;
  if (data.captions && !/[\\/]/.test(data.captions) && fs.existsSync(path.join(folder, data.captions))) subtitles = path.join(folder, data.captions);

  let lastPct = -1;
  const res = await renderTimeline({
    clips,
    width: w,
    height: h,
    fps: Number(opt.fps || data.fps || 30),
    quality: opt.quality || 'high',
    subtitles,
    output,
    onProgress: (p) => {
      const pct = Math.floor(p * 10) * 10;
      if (pct !== lastPct) { lastPct = pct; process.stderr.write(`\r${pct}%`); }
    },
  });
  process.stderr.write('\n');
  if (!res.ok) {
    console.error('render failed: ' + res.error);
    process.exit(1);
  }
  console.log(`${res.path} (${res.encoder})`);
}

main();
