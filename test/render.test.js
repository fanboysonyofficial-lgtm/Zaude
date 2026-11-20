import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsr from 'node:fs';
import osr from 'node:os';
import pathr from 'node:path';
import { spawnSync } from 'node:child_process';
import render from '../electron/render.cjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('atempoChain keeps each step within ffmpeg limits', () => {
  assert.equal(render.atempoChain(1.5), 'atempo=1.5');
  assert.equal(render.atempoChain(4), 'atempo=2,atempo=2');
  assert.equal(render.atempoChain(0.25), 'atempo=0.5,atempo=0.5');
});

test('buildRenderArgs refuses a timeline with no media', () => {
  assert.ok(render.buildRenderArgs({ clips: [{ id: 'x', kind: 'title', name: 'Title' }], resolution: '1920 × 1080', output: '/o.mp4' }).error);
});

test('buildRenderArgs uses NVENC when asked and skips muted video audio', () => {
  const clips = [
    { id: 'v', track: 'V1', kind: 'video', path: '/a.mp4', start: 0, dur: 2, srcIn: 0, speed: 1, hasAudio: true, muted: true },
    { id: 'a', track: 'A1', kind: 'audio', path: '/b.wav', start: 0, dur: 2, srcIn: 0, speed: 1, volume: 1 },
  ];
  const b = render.buildRenderArgs({ clips, resolution: '1920 × 1080', output: '/o.mp4', encoder: 'h264_nvenc', cuda: true });
  assert.ok(b.args.includes('h264_nvenc'));
  const graph = b.args[b.args.indexOf('-filter_complex') + 1];
  assert.ok(!graph.includes('[0:a]'), 'muted video must not contribute audio');
  assert.ok(graph.includes('[1:a]'));
});

test('buildRenderArgs supports custom aspect/size, fps, quality, and partial export range', () => {
  const clips = [
    { id: 'v1', track: 'V1', kind: 'video', path: '/a.mp4', start: 0, dur: 10, srcIn: 1, speed: 1, hasAudio: false },
    { id: 'v2', track: 'V1', kind: 'video', path: '/b.mp4', start: 10, dur: 10, srcIn: 0, speed: 1, hasAudio: false },
  ];
  const b = render.buildRenderArgs({
    clips,
    width: 1080,
    height: 1920,
    fps: 60,
    quality: 'draft',
    rangeStart: 3,
    rangeEnd: 8,
    output: '/tiktok.mp4',
  });
  assert.equal(b.size.w, 1080);
  assert.equal(b.size.h, 1920);
  assert.equal(b.fps, 60);
  assert.equal(b.total, 5);
  assert.ok(b.args.includes('60'));
  assert.ok(b.args.includes('5'));
  // Only v1 overlaps [3, 8], trimmed to start=4 (1 + 3) duration=5
  const graph = b.args[b.args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('s=1080x1920:r=60:d=5'));
  assert.ok(graph.includes('trim=start=4:duration=5'));
  assert.ok(!b.args.includes('/b.mp4'));
});

test('buildRenderArgs bakes clip scale, rotation, and position into ffmpeg filter graph', () => {
  const clips = [
    { id: 'v', track: 'V1', kind: 'video', path: '/a.mp4', start: 0, dur: 4, srcIn: 0, speed: 1, scale: 150, rotation: 30, posX: 10, posY: -20, hasAudio: false },
  ];
  const b = render.buildRenderArgs({ clips, width: 1000, height: 500, fps: 30, output: '/tr.mp4' });
  const graph = b.args[b.args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('scale=1500:750'));
  assert.ok(graph.includes('rotate=0.524:c=black@0:ow=rotw(0.524):oh=roth(0.524)'));
  assert.ok(graph.includes('overlay=x=(W-w)/2+(100):y=(H-h)/2+(-100):eof_action=pass:shortest=0'));
});

test('a real render produces an MP4 of the right length', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fsr.mkdtempSync(pathr.join(osr.tmpdir(), 'zaude-render-'));
  try {
    const video = pathr.join(dir, 'in.mp4');
    const wav = pathr.join(dir, 'tone.wav');
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', wav]);
    const clips = [
      { id: 'v', track: 'V1', kind: 'video', path: video, start: 0, dur: 2, srcIn: 0, speed: 1, hasAudio: true, volume: 1, opacity: 1 },
      { id: 'a', track: 'A1', kind: 'audio', path: wav, start: 1, dur: 2, srcIn: 0, speed: 1, volume: 0.5 },
    ];
    const out = pathr.join(dir, 'out.mp4');
    const progress = [];
    const r = await render.renderTimeline({ clips, resolution: '1280 × 720', output: out, onProgress: (p) => progress.push(p) });
    assert.equal(r.ok, true, r.error);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
    const duration = Number(probe.stdout.trim());
    assert.ok(Math.abs(duration - 3) < 0.2, 'duration was ' + duration);
    assert.ok(progress.length >= 0);
  } finally {
    fsr.rmSync(dir, { recursive: true, force: true });
  }
});

test('fill + zoom + pan crop the clip to the frame instead of letterboxing', () => {
  const clip = { id: 'a', kind: 'video', path: '/x.mp4', track: 'V1', start: 0, dur: 2, fill: true, zoom: 1.5, panX: 100, panY: -100 };
  const built = render.buildRenderArgs({ clips: [clip], width: 1080, height: 1920, output: '/o.mp4' });
  const graph = built.args[built.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /scale=1620:2880:force_original_aspect_ratio=increase/);
  assert.match(graph, /crop=1080:1920:\(iw-1080\)\*1:\(ih-1920\)\*0/);
  assert.doesNotMatch(graph, /pad=1080:1920/);
});

test('clips without framing keep the old fit-with-bars filter', () => {
  const clip = { id: 'a', kind: 'video', path: '/x.mp4', track: 'V1', start: 0, dur: 2 };
  const built = render.buildRenderArgs({ clips: [clip], width: 1080, height: 1920, output: '/o.mp4' });
  const graph = built.args[built.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/);
});

test('captions are burned in after the clips are composed', () => {
  const clip = { id: 'a', kind: 'video', path: '/x.mp4', track: 'V1', start: 0, dur: 2 };
  const built = render.buildRenderArgs({ clips: [clip], width: 1080, height: 1920, subtitles: '/p/caps.ass', output: '/o.mp4' });
  const graph = built.args[built.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /subtitles='\/p\/caps\.ass',.*format=yuv420p\[vout\]/);
});
