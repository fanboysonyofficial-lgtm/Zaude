import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod from '../electron/text-to-video.cjs';

const t = mod;

test('splitChunks keeps each chunk at 15 s or less and covers the whole length', () => {
  assert.deepEqual(t.splitChunks(30), [{ start: 0, end: 15 }, { start: 15, end: 30 }]);
  assert.deepEqual(t.splitChunks(16), [{ start: 0, end: 15 }, { start: 15, end: 16 }]);
  assert.deepEqual(t.splitChunks(5), [{ start: 0, end: 5 }]);
});

test('validateRequest accepts a normal request and trims the prompt', () => {
  const r = t.validateRequest({ prompt: '  a boat  ', seconds: '5', resolution: '720', quality: 'normal' });
  assert.equal(r.ok, true);
  assert.equal(r.value.prompt, 'a boat');
  assert.equal(r.value.seconds, 5);
});

test('validateRequest rejects empty prompts, bad lengths, and unknown options', () => {
  assert.equal(t.validateRequest({ prompt: '', seconds: 5, resolution: 720, quality: 'normal' }).ok, false);
  assert.equal(t.validateRequest({ prompt: 'x', seconds: 0, resolution: 720, quality: 'normal' }).ok, false);
  assert.equal(t.validateRequest({ prompt: 'x', seconds: 61, resolution: 720, quality: 'normal' }).ok, false);
  assert.equal(t.validateRequest({ prompt: 'x', seconds: 2.5, resolution: 720, quality: 'normal' }).ok, false);
  assert.equal(t.validateRequest({ prompt: 'x', seconds: 5, resolution: 1080, quality: 'normal' }).ok, false);
  assert.equal(t.validateRequest({ prompt: 'x', seconds: 5, resolution: 720, quality: 'best' }).ok, false);
});

test('buildPromptFile writes the numbered chunk format Mannimmate reads', () => {
  const text = t.buildPromptFile('A boat rocks.', 20);
  assert.ok(text.startsWith('Total chunks: 2'));
  assert.ok(text.includes('CHUNK #1 | 0000s-0015s\nPROMPT:\nA boat rocks.'));
  assert.ok(text.includes('CHUNK #2 | 0015s-0020s\nPROMPT:\nA boat rocks.'));
});

test('buildArgs asks for 16:9, the chosen resolution, and the matching preset', () => {
  const args = t.buildArgs({ promptFile: 'p.txt', resolution: 720, quality: 'ultra', outDir: '/out' });
  assert.equal(args[0], 'text-render');
  assert.equal(args[args.indexOf('--aspect') + 1], '16:9');
  assert.equal(args[args.indexOf('--quality') + 1], '720');
  assert.equal(args[args.indexOf('--preset') + 1], 'ultra');
  assert.equal(args[args.indexOf('--out-dir') + 1], '/out');
  assert.ok(args.includes('--json'));
});

test('describeEvent turns CLI events into progress and done messages', () => {
  assert.deepEqual(t.describeEvent({ event: 'text_sequence', progress: 0.5, label: 'Sampling' }),
    { type: 'progress', progress: 0.5, label: 'Sampling' });
  assert.deepEqual(t.describeEvent({ event: 'saved', path: '/x/clip.mp4' }), { type: 'done', path: '/x/clip.mp4', frames: null });
  assert.equal(t.describeEvent({ event: 'queue' }), null);
});

test('parseEventLine ignores plain text and bad JSON', () => {
  assert.equal(t.parseEventLine('hello'), null);
  assert.equal(t.parseEventLine('{bad'), null);
  assert.deepEqual(t.parseEventLine('{"event":"saved","path":"a"}'), { event: 'saved', path: 'a' });
});
