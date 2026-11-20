import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeZdFile, readZdFile } = require('../electron/zd-format.cjs');

test('writeZdFile and readZdFile round-trip project + embedded video/audio bytes after originals are deleted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-zd-'));
  try {
    const vidPath = path.join(tmp, 'clip.mp4');
    const audPath = path.join(tmp, 'voice.wav');
    const vidBytes = Buffer.from('FAKE_MP4_BINARY_PAYLOAD_0123456789'.repeat(200));
    const audBytes = Buffer.from('FAKE_WAV_BINARY_PAYLOAD_ABCDEFGHIJ'.repeat(150));
    fs.writeFileSync(vidPath, vidBytes);
    fs.writeFileSync(audPath, audBytes);

    const zdPath = path.join(tmp, 'my-edit.zd');
    const saved = await writeZdFile(zdPath, {
      name: 'My Edit',
      format: 'MP4',
      resolution: '1920 × 1080',
      clips: [
        { id: 'c1', track: 'V1', name: 'clip.mp4', path: vidPath, start: 0, dur: 5, brightness: 62, hslBands: [{ id: 'b1', hex: '#3b82f6', hue: 20, sat: 10, light: 0, range: 35 }] },
        { id: 'c2', track: 'V1', name: 'clip.mp4', path: vidPath, start: 5, dur: 4 },
        { id: 'c3', track: 'A1', name: 'voice.wav', path: audPath, start: 0, dur: 9 },
      ],
      media: [
        { name: 'clip.mp4', path: vidPath, kind: 'video', duration: 9 },
        { name: 'voice.wav', path: audPath, kind: 'audio', duration: 9 },
      ],
    });
    assert.equal(saved.ok, true);
    // Deduplicated: clip.mp4 + voice.wav = 2 embedded assets
    assert.equal(saved.assetCount, 2);

    // Delete original media files to prove .zd is 100% self-contained
    fs.unlinkSync(vidPath);
    fs.unlinkSync(audPath);

    const extractRoot = path.join(tmp, 'extracted');
    const opened = await readZdFile(zdPath, extractRoot);
    assert.equal(opened.ok, true);
    assert.equal(opened.project.name, 'My Edit');
    assert.equal(opened.project.clips.length, 3);
    assert.equal(opened.project.clips[0].brightness, 62);
    assert.equal(opened.project.clips[0].hslBands[0].hex, '#3b82f6');
    // Both split video clips point to the same extracted file, whose bytes match bit-for-bit
    assert.equal(opened.project.clips[0].path, opened.project.clips[1].path);
    assert.deepEqual(fs.readFileSync(opened.project.clips[0].path), vidBytes);
    assert.deepEqual(fs.readFileSync(opened.project.clips[2].path), audBytes);
    assert.deepEqual(fs.readFileSync(opened.project.media[0].path), vidBytes);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readZdFile rejects invalid files cleanly', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zaude-zd-bad-'));
  try {
    const bad = path.join(tmp, 'not-a-zd.zd');
    fs.writeFileSync(bad, 'hello world not a zaude file');
    const res = await readZdFile(bad, path.join(tmp, 'out'));
    assert.equal(res.ok, false);
    assert.match(res.error, /not a valid zaude/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
