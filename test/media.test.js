import { test as mtest } from 'node:test';
import mediaAssert from 'node:assert/strict';
import fsm from 'node:fs';
import osm from 'node:os';
import pathm from 'node:path';
import httpm from 'node:http';
import media from '../electron/media.cjs';

mtest('encode and decode round-trip a path', () => {
  const p = '/home/x/Videos/Zaude/a b.mp4';
  mediaAssert.equal(media.decodeMediaPath(media.encodeMediaPath(p)), p);
});

mtest('isAllowedMedia only accepts media files inside a root', () => {
  const root = '/home/x/Videos/Zaude';
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/clip.mp4', [root]), true);
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/../secret.mp4', [root]), false);
  mediaAssert.equal(media.isAllowedMedia('/etc/passwd', [root]), false);
  mediaAssert.equal(media.isAllowedMedia('/home/x/Videos/Zaude/clip.txt', [root]), false);
});

mtest('parseRange handles full, open, and suffix ranges', () => {
  mediaAssert.deepEqual(media.parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  mediaAssert.deepEqual(media.parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  mediaAssert.deepEqual(media.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  mediaAssert.equal(media.parseRange('bytes=2000-', 1000), 'invalid');
  mediaAssert.equal(media.parseRange('lines=1-2', 1000), 'invalid');
});

mtest('the media server serves allowed files, ranges, and refuses everything else', async () => {
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'zaude-media-'));
  const file = pathm.join(dir, 'clip.mp4');
  fsm.writeFileSync(file, Buffer.alloc(1000, 7));
  const server = httpm.createServer(media.createMediaHandler(() => [dir]));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/media/`;
  try {
    const url = base + media.encodeMediaPath(file);
    const full = await fetch(url);
    mediaAssert.equal(full.status, 200);
    mediaAssert.equal((await full.arrayBuffer()).byteLength, 1000);

    const part = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    mediaAssert.equal(part.status, 206);
    mediaAssert.equal(part.headers.get('content-range'), 'bytes 0-99/1000');
    mediaAssert.equal((await part.arrayBuffer()).byteLength, 100);

    const outside = await fetch(base + media.encodeMediaPath('/etc/passwd'));
    mediaAssert.equal(outside.status, 404);
    const traversal = await fetch(base + media.encodeMediaPath(pathm.join(dir, '..', 'x.mp4')));
    mediaAssert.equal(traversal.status, 404);
  } finally {
    server.close();
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});

import project from '../electron/project.cjs';

mtest('parseProbe reads duration, video, and audio from ffprobe output', () => {
  const info = project.parseProbe({
    format: { duration: '12.3456' },
    streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
  });
  mediaAssert.deepEqual(info, { duration: 12.346, hasVideo: true, hasAudio: true, width: 1920, height: 1080 });
  mediaAssert.equal(project.parseProbe({ streams: [] }).duration, null);
});

mtest('scanFolder lists media files, skips other files, and uses the probe results', async () => {
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'zaude-proj-'));
  fsm.mkdirSync(pathm.join(dir, 'sub'));
  fsm.writeFileSync(pathm.join(dir, 'beach.mp4'), 'x');
  fsm.writeFileSync(pathm.join(dir, 'sub', 'voice.wav'), 'x');
  fsm.writeFileSync(pathm.join(dir, 'notes.txt'), 'x');
  try {
    const r = await project.scanFolder(dir, async (f) => ({
      duration: 3, hasVideo: f.endsWith('.mp4'), hasAudio: true, width: 1, height: 1,
    }));
    mediaAssert.equal(r.ok, true);
    mediaAssert.deepEqual(r.media.map((m) => m.name), ['beach.mp4', 'voice.wav']);
    mediaAssert.equal(r.media[0].kind, 'video');
    mediaAssert.equal(r.media[1].kind, 'audio');
    mediaAssert.equal(r.media[0].duration, 3);
    const missing = await project.scanFolder(pathm.join(dir, 'nope'));
    mediaAssert.equal(missing.ok, false);
  } finally {
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});

mtest('saveProject writes only inside allowed folders and loadProject reads it back', () => {
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'zaude-save-'));
  try {
    const data = { version: 1, name: 'Test', clips: [{ id: 'a' }] };
    mediaAssert.equal(project.saveProject(dir, data, []).ok, false);
    mediaAssert.equal(project.saveProject(dir, data, [dir]).ok, true);
    mediaAssert.deepEqual(project.loadProject(dir).data, data);
    mediaAssert.equal(project.loadProject(pathm.join(dir, 'missing')).data, null);
  } finally {
    fsm.rmSync(dir, { recursive: true, force: true });
  }
});
