import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/layout.js';

test('default layout has bin, viewer, inspector and timeline', () => {
  const types = L.allAreas(L.defaultLayout()).map((a) => a.type).sort();
  assert.deepEqual(types, ['bin', 'inspector', 'timeline', 'viewer']);
});

test('insertAtSeam adds a window between the two sides of a seam', () => {
  const tree = L.split('row', L.area('bin'), L.area('viewer'));
  const next = L.insertAtSeam(tree, tree.id, 'inspector');
  const order = [];
  const walk = (n) => (n.kind === 'area' ? order.push(n.type) : (walk(n.a), walk(n.b)));
  walk(next);
  assert.deepEqual(order, ['bin', 'inspector', 'viewer']);
});

test('removeNode collapses a window so its sibling takes the space', () => {
  const bin = L.area('bin');
  const tree = L.split('row', bin, L.area('viewer'));
  const next = L.removeNode(tree, bin.id);
  assert.equal(next.kind, 'area');
  assert.equal(next.type, 'viewer');
});

test('the root window cannot be removed', () => {
  const tree = L.area('viewer');
  assert.equal(L.removeNode(tree, tree.id), tree);
});

test('addBeside splits the active window', () => {
  const v = L.area('viewer');
  const next = L.addBeside(v, v.id, 'timeline', 'col');
  assert.equal(next.kind, 'split');
  assert.equal(next.dir, 'col');
  assert.deepEqual(L.allAreas(next).map((a) => a.type), ['viewer', 'timeline']);
});

test('setRatio keeps the ratio inside safe limits', () => {
  const s = L.split('row', L.area('bin'), L.area('viewer'), 0.5);
  assert.equal(L.setRatio(s, s.id, 2).ratio, 0.97);
  assert.equal(L.setRatio(s, s.id, -1).ratio, 0.03);
});

test('setType changes what a window shows', () => {
  const v = L.area('viewer');
  assert.equal(L.setType(v, v.id, 'masking').type, 'masking');
});

test('deserialize falls back to the default layout for bad data', () => {
  assert.deepEqual(L.allAreas(L.deserialize('not json')).length, 4);
  const tree = L.area('bin');
  assert.equal(L.deserialize(L.serialize(tree)).type, 'bin');
});

test('deserialize advances IDs so newly added windows never collide with saved ones', () => {
  const saved = JSON.stringify({
    id: 's50',
    kind: 'split',
    dir: 'row',
    ratio: 0.5,
    a: { id: 'a48', kind: 'area', type: 'bin' },
    b: { id: 'a49', kind: 'area', type: 'viewer' },
  });
  const loaded = L.deserialize(saved);
  const next = L.addBeside(loaded, 'a48', 'timeline', 'col');
  const ids = [];
  const walk = (n) => { ids.push(n.id); if (n.kind === 'split') { walk(n.a); walk(n.b); } };
  walk(next);
  assert.equal(new Set(ids).size, ids.length);
});
