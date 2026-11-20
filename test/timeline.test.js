import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/timeline.js';

const clip = (over) => ({ id: 'x' + Math.random(), track: 'V1', name: 'a', start: 0, dur: 10, srcDur: 30, srcIn: 0, speed: 1, transition: 0, ...over });

test('splitAt splits straddling clips and keeps source offsets', () => {
  const out = T.splitAt([clip({ id: 'a', start: 0, dur: 10 })], 4);
  assert.equal(out.length, 2);
  assert.equal(out[0].dur, 4);
  assert.equal(out[1].start, 4);
  assert.equal(out[1].dur, 6);
  assert.equal(out[1].srcIn, 4);
});

test('splitAt at a clip edge does nothing', () => {
  assert.equal(T.splitAt([clip({ start: 0, dur: 10 })], 10).length, 1);
});

test('rippleDelete removes the clip and closes the gap', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  const out = T.rippleDelete(clips, 'a');
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
});

test('deleteClip leaves a gap', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  assert.equal(T.deleteClip(clips, 'a')[0].start, 5);
});

test('duplicateClip places a copy after the original and pushes later clips', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5 }), clip({ id: 'b', start: 5, dur: 5 })];
  const out = T.duplicateClip(clips, 'a');
  assert.equal(out.length, 3);
  const copy = out.find((c) => c.id !== 'a' && c.id !== 'b');
  assert.equal(copy.start, 5);
  assert.equal(out.find((c) => c.id === 'b').start, 10);
});

test('trimEnd shortens the clip to the playhead', () => {
  const out = T.trimEnd([clip({ id: 'a', start: 2, dur: 10 })], 'a', 6);
  assert.equal(out[0].dur, 4);
});

test('slipClip moves the source window and stays in range', () => {
  const clips = [clip({ id: 'a', dur: 10, srcDur: 30, srcIn: 0 })];
  assert.equal(T.slipClip(clips, 'a', 5)[0].srcIn, 5);
  assert.equal(T.slipClip(clips, 'a', -5)[0].srcIn, 0);
  assert.equal(T.slipClip(clips, 'a', 100)[0].srcIn, 20);
});

test('changeSpeed cycles speed and resizes the clip and shifts later clips', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 8 }), clip({ id: 'b', start: 8, dur: 2 })];
  const out = T.changeSpeed(clips, 'a'); // 1x -> 2x
  assert.equal(out.find((c) => c.id === 'a').speed, 2);
  assert.equal(out.find((c) => c.id === 'a').dur, 4);
  assert.equal(out.find((c) => c.id === 'b').start, 4);
});

test('insertMedia pushes later clips on that track right', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 10 })];
  const media = { name: 'm.mp4', srcDur: 30 };
  const out = T.insertMedia(clips, 'V1', 4, media);
  const inserted = out.find((c) => c.name === 'm.mp4');
  assert.equal(inserted.start, 4);
  assert.equal(inserted.dur, T.INSERT_LENGTH);
  assert.equal(inserted.kind, 'video');
  assert.equal(inserted.volume, 1);
  assert.equal(inserted.opacity, 1);
  assert.equal(inserted.muted, false);
  const right = out.find((c) => c.id !== inserted.id && c.start > 4);
  assert.equal(right.start, 4 + T.INSERT_LENGTH);
});

test('overwriteMedia replaces the range on its track', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 10 })];
  const out = T.overwriteMedia(clips, 'V1', 2, { name: 'm.mp4', srcDur: 30 });
  const v1 = out.filter((c) => c.track === 'V1').sort((p, q) => p.start - q.start);
  assert.deepEqual(v1.map((c) => [c.start, c.dur]), [[0, 2], [2, T.INSERT_LENGTH], [2 + T.INSERT_LENGTH, 10 - 2 - T.INSERT_LENGTH]]);
});

test('toggleTransition turns a cross dissolve on and off', () => {
  const clips = [clip({ id: 'a', dur: 10 })];
  const on = T.toggleTransition(clips, 'a');
  assert.equal(on[0].transition, 1);
  assert.equal(T.toggleTransition(on, 'a')[0].transition, 0);
});

test('snapTime snaps to nearby edges only when enabled', () => {
  const clips = [clip({ start: 5, dur: 5 })];
  assert.equal(T.snapTime(clips, 5.1, true, 0.25), 5);
  assert.equal(T.snapTime(clips, 5.1, false, 0.25), 5.1);
  assert.equal(T.snapTime(clips, 7, true, 0.25), 7);
});

test('timecode formats at 24 fps', () => {
  assert.equal(T.timecode(0), '00:00:00:00');
  assert.equal(T.timecode(12 + 8 / 24), '00:00:12:08');
});

test('initial project has the expected clips', () => {
  const clips = T.initialClips();
  assert.equal(clips.length, 6);
  for (const c of clips) {
    if (c.kind === 'video') assert.ok(c.track.startsWith('V'), `${c.name} should be on a video track`);
    if (c.kind === 'audio') assert.ok(c.track.startsWith('A'), `${c.name} should be on an audio track`);
  }
});

test('one full sweep at a 60 s view changes a clip by the calibrated amount', () => {
  assert.ok(Math.abs(1000 * T.secondsPerWheelUnit(60) - T.SWEEP_SECONDS_AT_60S) < 1e-9);
});

test('sensitivity scales with the visible span', () => {
  assert.ok(Math.abs(T.secondsPerWheelUnit(6) - T.secondsPerWheelUnit(60) / 10) < 1e-12);
});

test('adjustEnd lengthens and shortens a clip', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', 2)[0].dur, 7);
  assert.equal(T.adjustEnd(clips, 'a', -2)[0].dur, 3);
});

test('adjustEnd keeps at least the minimum length', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 0.05, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', -10)[0].dur, T.MIN_CLIP_DUR);
});

test('adjustEnd cannot run past the source media', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 8, srcIn: 0, speed: 1 })];
  assert.equal(T.adjustEnd(clips, 'a', 100)[0].dur, 8);
});

test('adjustEnd stops at the next clip on the same track', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 5, srcDur: 30 }), clip({ id: 'b', start: 6, dur: 2, srcDur: 30 })];
  assert.equal(T.adjustEnd(clips, 'a', 100)[0].dur, 6);
});

test('moveClip shifts a clip and stops at neighbours and zero', () => {
  const clips = [clip({ id: 'a', start: 0, dur: 2 }), clip({ id: 'b', start: 4, dur: 2 })];
  assert.equal(T.moveClip(clips, 'b', -1)[1].start, 3);
  assert.equal(T.moveClip(clips, 'b', -10)[1].start, 2);
  assert.equal(T.moveClip(clips, 'b', 100)[1].start, 104);
  assert.equal(T.moveClip(clips, 'a', -5)[0].start, 0);
});

test('placeRange puts a clip in a free range and replaces what it covers', () => {
  const clips = [clip({ id: 'a', track: 'V1', start: 0, dur: 10 })];
  const out = T.placeRange(clips, 'V1', 4, 2, { id: 'gen', name: 'Generating…' });
  const gen = out.find((c) => c.id === 'gen');
  assert.equal(gen.start, 4);
  assert.equal(gen.dur, 2);
  const v1 = out.filter((c) => c.track === 'V1').sort((p, q) => p.start - q.start);
  assert.deepEqual(v1.map((c) => [c.start, c.dur]), [[0, 4], [4, 2], [6, 4]]);
});

test('setProp clamps to the property limits and rounds to its step', () => {
  const clips = [clip({ id: 'a' })];
  assert.equal(T.setProp(clips, 'a', 'volume', 5)[0].volume, 2);
  assert.equal(T.setProp(clips, 'a', 'opacity', -1)[0].opacity, 0);
  assert.equal(T.setProp(clips, 'a', 'volume', 0.504)[0].volume, 0.5);
});

test('kindOfName tells video, audio and titles apart', () => {
  assert.equal(T.kindOfName('beach.MP4'), 'video');
  assert.equal(T.kindOfName('voice.wav'), 'audio');
  assert.equal(T.kindOfName('Title · Natural Moment'), 'title');
});

test('detachAudio moves the audio to a free audio track and mutes the video', () => {
  const clips = [clip({ id: 'v', track: 'V1', kind: 'video', start: 0, dur: 5, hasAudio: true })];
  const r = T.detachAudio(clips, 'v');
  assert.ok(r.clips);
  const video = r.clips.find((c) => c.id === 'v');
  const audio = r.clips.find((c) => c.kind === 'audio');
  assert.equal(video.muted, true);
  assert.equal(audio.track, 'A1');
  assert.equal(audio.start, 0);
  assert.equal(audio.dur, 5);
});

test('detachAudio refuses clips without audio and reports busy audio tracks', () => {
  assert.ok(T.detachAudio([clip({ id: 'v', kind: 'video', hasAudio: false })], 'v').error);
  const busy = [
    clip({ id: 'v', track: 'V1', kind: 'video', start: 0, dur: 5, hasAudio: true }),
    clip({ id: 'x', track: 'A1', kind: 'audio', start: 0, dur: 5 }),
    clip({ id: 'y', track: 'A2', kind: 'audio', start: 0, dur: 5 }),
  ];
  assert.ok(T.detachAudio(busy, 'v').error);
});

test('insertFile places a bin file at the playhead and pushes later clips', () => {
  const clips = [clip({ id: 'a', track: 'V1', start: 2, dur: 4 })];
  const out = T.insertFile(clips, 'V1', 0, { name: 'beach.mp4', path: '/x/beach.mp4', duration: 3, hasAudio: true });
  const added = out.find((c) => c.name === 'beach.mp4');
  assert.equal(added.start, 0);
  assert.equal(added.dur, 3);
  assert.equal(added.kind, 'video');
  assert.equal(out.find((c) => c.id === 'a').start, 5);
});

test('selectByBox enforces window (enclosed) vs crossing (touching) selection', () => {
  const rects = [
    { id: 'inside', left: 20, right: 80, top: 10, bottom: 40 },
    { id: 'partial', left: 70, right: 140, top: 10, bottom: 40 },
    { id: 'outside', left: 150, right: 200, top: 10, bottom: 40 },
  ];
  const box = { left: 10, right: 100, top: 0, bottom: 50 };
  assert.deepEqual(T.selectByBox(rects, box, 'window'), ['inside']);
  assert.deepEqual(T.selectByBox(rects, box, 'crossing'), ['inside', 'partial']);
  // Reversed box coordinates (right-to-left drag) work identically
  const revBox = { left: 100, right: 10, top: 50, bottom: 0 };
  assert.deepEqual(T.selectByBox(rects, revBox, 'crossing'), ['inside', 'partial']);
});

test('moveClips moves a group rigidly and stops at 0 or unselected neighbours', () => {
  const clips = [
    clip({ id: 'a', track: 'V1', start: 2, dur: 3 }),
    clip({ id: 'b', track: 'V1', start: 6, dur: 2 }),
    clip({ id: 'c', track: 'V1', start: 10, dur: 2 }),
    clip({ id: 'd', track: 'A1', start: 4, dur: 4 }),
  ];
  // Move a, b, d right by 5 -> b stops at c (start 10, so max delta = 2)
  const right = T.moveClips(clips, ['a', 'b', 'd'], 5);
  assert.equal(right.find((x) => x.id === 'a').start, 4);
  assert.equal(right.find((x) => x.id === 'b').start, 8);
  assert.equal(right.find((x) => x.id === 'd').start, 6);
  assert.equal(right.find((x) => x.id === 'c').start, 10);

  // Move a, b, d left by -10 -> a stops at 0 (so min delta = -2)
  const left = T.moveClips(clips, ['a', 'b', 'd'], -10);
  assert.equal(left.find((x) => x.id === 'a').start, 0);
  assert.equal(left.find((x) => x.id === 'b').start, 4);
  assert.equal(left.find((x) => x.id === 'd').start, 2);
});

test('deleteClips removes all selected clips', () => {
  const clips = [clip({ id: 'a' }), clip({ id: 'b' }), clip({ id: 'c' })];
  assert.deepEqual(T.deleteClips(clips, ['a', 'c']).map((x) => x.id), ['b']);
});

test('buildCssFilter, buildCssTransform, and resetFilters handle integer clip effects', () => {
  const c = clip({ id: 'v', brightness: 65, contrast: 60, saturation: 70, hue: 30, blur: 20, flipH: true, flipV: false });
  const filter = T.buildCssFilter(c);
  assert.ok(filter.includes('brightness(1.300)'));
  assert.ok(filter.includes('contrast(1.200)'));
  assert.ok(filter.includes('saturate(1.400)'));
  assert.ok(filter.includes('hue-rotate(30.0deg)'));
  assert.ok(filter.includes('blur(4.00px)'));
  assert.equal(T.buildCssTransform(c), 'scale(-1, 1)');

  const reset = T.resetFilters([c], 'v')[0];
  assert.equal(T.buildCssFilter(reset), 'none');
  // Filter steps snap strictly to integers
  assert.equal(T.setProp([c], 'v', 'brightness', 63.7)[0].brightness, 64);
});

test('setTransition and transitionState compute fade-to-black and dissolve overlays', () => {
  const c = T.setTransition([clip({ id: 'v', start: 0, dur: 10 })], 'v', 'fade-black', 2)[0];
  assert.equal(c.transitionType, 'fade-black');
  assert.equal(c.transition, 2);
  // Halfway through 2s fade-in -> 50% black overlay
  const midIn = T.transitionState(c, 1);
  assert.equal(midIn.overlayColor, '#000000');
  assert.ok(Math.abs(midIn.overlayOpacity - 0.5) < 1e-6);
  // Middle of clip -> no overlay
  assert.equal(T.transitionState(c, 5).overlayOpacity, 0);
  // Halfway through 2s fade-out (at 9s) -> 50% black overlay
  const midOut = T.transitionState(c, 9);
  assert.ok(Math.abs(midOut.overlayOpacity - 0.5) < 1e-6);
});

test('addHslBand, updateHslBand, and removeHslBand manage multiple color bands', () => {
  let clips = [clip({ id: 'v' })];
  clips = T.addHslBand(clips, 'v', '#3b82f6');
  assert.equal(clips[0].hslBands.length, 2);
  const secondId = clips[0].hslActiveBand;
  clips = T.updateHslBand(clips, 'v', secondId, { hue: 45, sat: 40 });
  const updated = clips[0].hslBands.find((b) => b.id === secondId);
  assert.equal(updated.hue, 45);
  assert.equal(updated.sat, 40);
  clips = T.removeHslBand(clips, 'v', secondId);
  assert.equal(clips[0].hslBands.length, 1);
});

test('buildCssTransform and resetTransform handle scale, rotation, position, and mirror', () => {
  const c = clip({ id: 'v', scale: 150, rotation: -30, posX: 12, posY: -8, flipH: true });
  const tr = T.buildCssTransform(c);
  assert.ok(tr.includes('translate(12.00%, -8.00%)'));
  assert.ok(tr.includes('rotate(-30deg)'));
  assert.ok(tr.includes('scale(1.500)'));
  assert.ok(tr.includes('scale(-1, 1)'));

  const reset = T.resetTransform([c], 'v')[0];
  assert.equal(reset.scale, 100);
  assert.equal(reset.rotation, 0);
  assert.equal(reset.posX, 0);
  assert.equal(reset.posY, 0);
  assert.equal(reset.flipH, false);
  assert.equal(T.buildCssTransform(reset), 'none');
});
