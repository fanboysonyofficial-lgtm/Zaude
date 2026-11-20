import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineThumbStages } from '../src/thumbs.js';

test('clips 10 seconds or shorter get a single preview stage', () => {
  const stages = timelineThumbStages({ dur: 10, srcIn: 2, speed: 1, srcDur: 20 });
  assert.equal(stages.length, 1);
  assert.deepEqual(stages[0], { offset: 0, span: 10, srcTime: 2 });

  const short = timelineThumbStages({ dur: 4.5, srcIn: 0, speed: 1, srcDur: 10 });
  assert.equal(short.length, 1);
  assert.deepEqual(short[0], { offset: 0, span: 4.5, srcTime: 0 });
});

test('a 60-second clip gets 6 stages spaced every 10 seconds', () => {
  const stages = timelineThumbStages({ dur: 60, srcIn: 0, speed: 1, srcDur: 60 });
  assert.equal(stages.length, 6);
  assert.deepEqual(stages.map((s) => s.offset), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(stages.map((s) => s.span), [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(stages.map((s) => s.srcTime), [0, 10, 20, 30, 40, 50]);
});

test('clips above 10 seconds respect srcIn, speed, and partial final stage', () => {
  const stages = timelineThumbStages({ dur: 25, srcIn: 5, speed: 2, srcDur: 100 });
  assert.equal(stages.length, 3);
  assert.deepEqual(stages, [
    { offset: 0, span: 10, srcTime: 5 },
    { offset: 10, span: 10, srcTime: 25 },
    { offset: 20, span: 5, srcTime: 45 },
  ]);
});
