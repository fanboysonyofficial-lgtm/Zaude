// Renders the timeline to an MP4 with ffmpeg. Uses NVIDIA NVENC for encoding when ffmpeg has it,
// and CUDA decoding for the inputs, otherwise libx264 on the CPU.
const { spawn, spawnSync } = require('node:child_process');

const PRESETS = {
  '1280 × 720': { w: 1280, h: 720 },
  '1920 × 1080': { w: 1920, h: 1080 },
  '3840 × 2160': { w: 3840, h: 2160 },
  '1080 × 1920': { w: 1080, h: 1920 },
  '1080 × 1080': { w: 1080, h: 1080 },
  '1080 × 1350': { w: 1080, h: 1350 },
};
const FPS = 24;

function resolveSize(resolution, width, height) {
  const wNum = Number(width);
  const hNum = Number(height);
  if (Number.isFinite(wNum) && Number.isFinite(hNum) && wNum >= 64 && hNum >= 64) {
    return { w: Math.round(wNum / 2) * 2, h: Math.round(hNum / 2) * 2 };
  }
  if (PRESETS[resolution]) return PRESETS[resolution];
  const m = /^(\d+)\s*[×x]\s*(\d+)$/i.exec(String(resolution || '').trim());
  if (m) return { w: Math.round(Number(m[1]) / 2) * 2, h: Math.round(Number(m[2]) / 2) * 2 };
  return PRESETS['1920 × 1080'];
}

function qualityArgs(encoder, quality) {
  const q = String(quality || 'high').toLowerCase();
  if (encoder === 'h264_nvenc') {
    const map = {
      draft: ['-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '28', '-b:v', '0'],
      standard: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'],
      high: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
      ultra: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '15', '-b:v', '0'],
    };
    return map[q] || map.high;
  }
  const map = {
    draft: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'],
    standard: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21'],
    high: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
    ultra: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15'],
  };
  return map[q] || map.high;
}

let encoderCache = null;
// Returns { encoder: 'h264_nvenc' | 'libx264', cuda: boolean }. Result is cached for the session.
function detectEncoder(run = spawnSync) {
  if (encoderCache) return encoderCache;
  let encoders = '';
  try {
    encoders = String(run('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
  } catch {
    encoders = '';
  }
  const nvenc = /\bh264_nvenc\b/.test(encoders);
  encoderCache = { encoder: nvenc ? 'h264_nvenc' : 'libx264', cuda: nvenc };
  return encoderCache;
}

// ffmpeg's atempo only accepts 0.5 to 2 per filter, so larger changes are chained.
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  parts.push(s);
  return parts.map((p) => `atempo=${Number(p.toFixed(6))}`).join(',');
}

const r3 = (n) => Number(Number(n).toFixed(3));

// Scales one clip into the W×H frame. Default: fit inside with black bars (as before).
// fill: cover the frame and crop the edges. zoom > 1 enlarges further; panX/panY (-100…100)
// pick which part stays in view (0 = centre, ±100 = the edge).
function framingFilter(c, size) {
  const z = typeof c.zoom === 'number' && c.zoom > 1 ? Math.min(4, c.zoom) : 1;
  if (!c.fill && z === 1) {
    return `scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2:black`;
  }
  const sw = Math.round((size.w * z) / 2) * 2;
  const sh = Math.round((size.h * z) / 2) * 2;
  const fx = r3(0.5 + Math.max(-100, Math.min(100, Number(c.panX) || 0)) / 200);
  const fy = r3(0.5 + Math.max(-100, Math.min(100, Number(c.panY) || 0)) / 200);
  const mode = c.fill ? 'increase' : 'decrease';
  return `scale=${sw}:${sh}:force_original_aspect_ratio=${mode}:flags=lanczos,` +
    `pad=max(iw\\,${size.w}):max(ih\\,${size.h}):(ow-iw)/2:(oh-ih)/2:black,` +
    `crop=${size.w}:${size.h}:(iw-${size.w})*${fx}:(ih-${size.h})*${fy}`;
}

// Builds the ffmpeg arguments for the timeline. Pure: no files are read.
// Clips without a file (titles, placeholders still generating) are skipped.
function buildRenderArgs({ clips, resolution, width, height, fps = FPS, quality = 'high', rangeStart = null, rangeEnd = null, subtitles = null, output, encoder = 'libx264', cuda = false }) {
  const size = resolveSize(resolution, width, height);
  const outFps = Math.max(1, Math.min(120, Math.round(Number(fps) || FPS)));
  let media = clips.filter((c) => c.path && !c.generating && (c.kind === 'video' || c.kind === 'audio'));
  if (!media.length) return { error: 'The timeline has no media clips to render.' };

  const fullEnd = Math.max(...media.map((c) => c.start + c.dur));
  const hasRange = rangeStart !== null && rangeEnd !== null && Number.isFinite(Number(rangeStart)) && Number.isFinite(Number(rangeEnd));
  const winStart = hasRange ? Math.max(0, Number(rangeStart)) : 0;
  const winEnd = hasRange ? Math.max(winStart, Number(rangeEnd)) : fullEnd;
  if (winEnd - winStart < 0.05) return { error: 'Export range must be at least 0.05 seconds long.' };

  if (hasRange) {
    media = media
      .map((c) => {
        const cStart = c.start;
        const cEnd = c.start + c.dur;
        const ovStart = Math.max(cStart, winStart);
        const ovEnd = Math.min(cEnd, winEnd);
        if (ovEnd - ovStart < 0.01) return null;
        const trimLeft = ovStart - cStart;
        const speed = c.speed || 1;
        return {
          ...c,
          start: ovStart - winStart,
          dur: ovEnd - ovStart,
          srcIn: (c.srcIn || 0) + trimLeft * speed,
        };
      })
      .filter(Boolean);
    if (!media.length) return { error: 'No media clips fall inside the selected export range.' };
  }

  const total = hasRange ? (winEnd - winStart) : Math.max(...media.map((c) => c.start + c.dur));

  const inputs = [];
  const graph = [];
  const videoClips = media.filter((c) => c.kind === 'video').sort((a, b) => a.track.localeCompare(b.track));
  const audioClips = media.filter((c) => c.hasAudio !== false && !c.muted && (c.kind === 'audio' || c.hasAudio === true));

  // one input per clip, so each clip uses its own streams
  const inputIndex = new Map();
  let count = 0;
  const addInput = (c) => {
    const key = c.id;
    if (!inputIndex.has(key)) {
      inputIndex.set(key, count++);
      if (cuda) inputs.push('-hwaccel', 'cuda');
      inputs.push('-i', c.path);
    }
    return inputIndex.get(key);
  };

  let base = `color=c=black:s=${size.w}x${size.h}:r=${outFps}:d=${r3(total)}[base0]`;
  graph.push(base);
  let last = 'base0';
  videoClips.forEach((c, k) => {
    const idx = addInput(c);
    const used = r3(c.dur * (c.speed || 1));
    const opacity = typeof c.opacity === 'number' ? c.opacity : 1;
    const fx = [];
    if (c.flipH) fx.push('hflip');
    if (c.flipV) fx.push('vflip');

    const brightInt = typeof c.brightness === 'number' ? c.brightness : 50;
    const contrastInt = typeof c.contrast === 'number' ? c.contrast : 50;
    const satInt = typeof c.saturation === 'number' ? c.saturation : 50;
    const brightness = (brightInt / 50) + ((Number(c.exposure) || 0) / 100) * 0.5 - 1;
    const contrast = (contrastInt / 50) + ((Number(c.dynamics) || 0) / 100) * 0.35;
    const saturation = (satInt / 50) + ((Number(c.dynamics) || 0) / 100) * 0.25;
    if (Math.abs(brightness) > 0.01 || Math.abs(contrast - 1) > 0.01 || Math.abs(saturation - 1) > 0.01) {
      fx.push(`eq=brightness=${r3(Math.max(-1, Math.min(1, brightness)))}:contrast=${r3(Math.max(0.1, Math.min(3, contrast)))}:saturation=${r3(Math.max(0, Math.min(3, saturation)))}`);
    }
    const hueDeg = (Number(c.hue) || 0) + ((Number(c.tint) || 0) / 100) * 45 - ((Number(c.temperature) || 0) / 100) * 12;
    if (Math.abs(hueDeg) > 0.5) fx.push(`hue=h=${r3(hueDeg)}`);
    if (Number(c.denoise) > 0) {
      const d = r3((Number(c.denoise) / 100) * 6);
      fx.push(`hqdn3d=${d}:${d}:${d}:${d}`);
    }
    if (Number(c.sharpen) > 0) {
      fx.push(`unsharp=5:5:${r3((Number(c.sharpen) / 100) * 1.5)}:5:5:0`);
    }
    if (Number(c.blur) > 0) {
      fx.push(`gblur=sigma=${r3((Number(c.blur) / 100) * 20)}`);
    }
    if (Number(c.vignette) > 0) {
      fx.push(`vignette=angle=${r3(0.2 + (Number(c.vignette) / 100) * 1.1)}`);
    }
    const trDur = Number(c.transition) || 0;
    const trType = c.transitionType || (trDur > 0 ? 'dissolve' : 'none');
    if (trDur > 0 && (trType === 'fade-black' || trType === 'fade-white')) {
      const col = trType === 'fade-white' ? 'white' : 'black';
      fx.push(`fade=t=in:st=${r3(c.start)}:d=${r3(trDur)}:color=${col}`);
      fx.push(`fade=t=out:st=${r3(Math.max(c.start, c.start + c.dur - trDur))}:d=${r3(trDur)}:color=${col}`);
    }

    const scalePct = typeof c.scale === 'number' ? c.scale : 100;
    const rotDeg = typeof c.rotation === 'number' ? c.rotation : 0;
    const posX = typeof c.posX === 'number' ? c.posX : 0;
    const posY = typeof c.posY === 'number' ? c.posY : 0;
    const hasTransform = Math.abs(scalePct - 100) > 0.1 || Math.abs(rotDeg) > 0.1 || Math.abs(posX) > 0.1 || Math.abs(posY) > 0.1;

    if (Math.abs(scalePct - 100) > 0.1) {
      const sw = Math.max(2, Math.round((size.w * scalePct / 100) / 2) * 2);
      const sh = Math.max(2, Math.round((size.h * scalePct / 100) / 2) * 2);
      fx.push(`scale=${sw}:${sh}`);
    }
    if (Math.abs(rotDeg) > 0.1) {
      const rad = r3((rotDeg * Math.PI) / 180);
      fx.push(`format=rgba,rotate=${rad}:c=black@0:ow=rotw(${rad}):oh=roth(${rad})`);
    }

    const fxChain = fx.length ? ',' + fx.join(',') : '';
    graph.push(
      `[${idx}:v]trim=start=${r3(c.srcIn || 0)}:duration=${used},setpts=(PTS-STARTPTS)/${c.speed || 1}+${r3(c.start)}/TB,` +
      `${framingFilter(c, size)}${fxChain},` +
      `format=yuva420p,colorchannelmixer=aa=${r3(opacity)}[v${k}]`);
    if (hasTransform) {
      const dx = Math.round((size.w * posX) / 100);
      const dy = Math.round((size.h * posY) / 100);
      graph.push(`[${last}][v${k}]overlay=x=(W-w)/2+(${dx}):y=(H-h)/2+(${dy}):eof_action=pass:shortest=0[base${k + 1}]`);
    } else {
      graph.push(`[${last}][v${k}]overlay=eof_action=pass:shortest=0[base${k + 1}]`);
    }
    last = `base${k + 1}`;
  });
  // burned-in captions; with an export range the subtitle times shift with it
  const subs = subtitles
    ? `setpts=PTS+${r3(winStart)}/TB,subtitles='${String(subtitles).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}',setpts=PTS-${r3(winStart)}/TB,`
    : '';
  graph.push(`[${last}]${subs}format=yuv420p[vout]`);

  const audioLabels = [];
  audioClips.forEach((c, k) => {
    const idx = addInput(c);
    const used = r3(c.dur * (c.speed || 1));
    const vol = typeof c.volume === 'number' ? c.volume : 1;
    const tempo = (c.speed || 1) !== 1 ? atempoChain(c.speed) + ',' : '';
    graph.push(
      `[${idx}:a]atrim=start=${r3(c.srcIn || 0)}:duration=${used},asetpts=PTS-STARTPTS,${tempo}` +
      `volume=${r3(vol)},adelay=${Math.round(c.start * 1000)}:all=1[a${k}]`);
    audioLabels.push(`[a${k}]`);
  });
  let audioArgs = [];
  if (audioLabels.length) {
    graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
    audioArgs = ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'];
  }

  const encodeArgs = qualityArgs(encoder, quality);

  return {
    args: [
      '-hide_banner', '-y', '-progress', 'pipe:1', '-nostats',
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', '[vout]', ...audioArgs,
      ...encodeArgs,
      '-pix_fmt', 'yuv420p', '-r', String(outFps),
      '-t', String(r3(total)),
      '-movflags', '+faststart',
      output,
    ],
    total,
    size,
    fps: outFps,
  };
}

// Runs the render. onProgress receives a fraction from 0 to 1. Resolves to { ok, path } or { ok: false, error }.
function renderTimeline({ clips, resolution, width, height, fps, quality, rangeStart, rangeEnd, subtitles, output, onProgress = () => {}, ffmpeg = 'ffmpeg' }) {
  const enc = detectEncoder();
  const built = buildRenderArgs({ clips, resolution, width, height, fps, quality, rangeStart, rangeEnd, subtitles, output, encoder: enc.encoder, cuda: enc.cuda });
  if (built.error) return Promise.resolve({ ok: false, error: built.error });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, built.args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message });
    }
    let errTail = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && built.total > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / built.total));
      }
    });
    child.stderr.on('data', (chunk) => {
      errTail = errTail.concat(String(chunk).split(/\r?\n/).filter(Boolean)).slice(-8);
    });
    child.on('error', (e) => resolve({ ok: false, error: 'Could not start ffmpeg: ' + e.message }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, path: output, encoder: enc.encoder });
      resolve({ ok: false, error: errTail.slice(-2).join(' ') || `ffmpeg exited with code ${code}.` });
    });
  });
}

module.exports = { PRESETS, detectEncoder, atempoChain, buildRenderArgs, renderTimeline };
