// Workspace layout: a tree of areas (windows) split by seams. Pure data functions, no DOM.
// A split node has two children, a and b, and a ratio (the share of the space given to a).

export const MIN_AREA_PX = 90; // a window smaller than this is removed when its seam is dragged

export const WINDOW_TYPES = [
  { id: 'bin', label: 'Bin', desc: 'Media files, folder import & clip preview' },
  { id: 'viewer', label: 'Viewer', desc: 'Video monitor, playback & scrub bar' },
  { id: 'timeline', label: 'Timeline', desc: 'Multi-track clips, ruler & trackpad editing' },
  { id: 'inspector', label: 'Inspector', desc: 'Selected clip volume, opacity & audio' },
  { id: 'tools', label: 'Tools', desc: 'Cut, Edit, Audio & Deliver actions' },
  { id: 'masking', label: 'Masking', desc: 'AI subject rotoscoping & cutout (soon)' },
  { id: 'remote', label: 'Remote machines', desc: 'SSH GPU server & ComfyUI status' },
];

const typeLabel = (id) => (WINDOW_TYPES.find((t) => t.id === id) || { label: id }).label;
export { typeLabel };

let seq = 0;
const nid = (prefix) => `${prefix}${++seq}`;

export function area(type) {
  return { id: nid('a'), kind: 'area', type };
}

export function split(dir, a, b, ratio = 0.5) {
  return { id: nid('s'), kind: 'split', dir, ratio, a, b };
}

// Starting layout: Bin on the left, Viewer in the middle, Inspector on the right, Timeline along the bottom.
export function defaultLayout() {
  const top = split('row', area('bin'), split('row', area('viewer'), area('inspector'), 0.62), 0.2);
  return split('col', top, area('timeline'), 0.6);
}

export function findNode(tree, id, parent = null) {
  if (!tree) return null;
  if (tree.id === id) return { node: tree, parent };
  if (tree.kind === 'split') return findNode(tree.a, id, tree) || findNode(tree.b, id, tree);
  return null;
}

export function allAreas(tree) {
  if (!tree) return [];
  if (tree.kind === 'area') return [tree];
  return [...allAreas(tree.a), ...allAreas(tree.b)];
}

// Maps a node to a new node with the same id; used to rebuild the tree immutably.
function mapTree(tree, fn) {
  const node = fn(tree);
  if (node !== tree) return node;
  if (tree.kind === 'split') {
    return { ...tree, a: mapTree(tree.a, fn), b: mapTree(tree.b, fn) };
  }
  return tree;
}

export function setType(tree, areaId, type) {
  return mapTree(tree, (n) => (n.id === areaId && n.kind === 'area' ? { ...n, type } : n));
}

export function setRatio(tree, splitId, ratio) {
  const clamped = Math.min(0.97, Math.max(0.03, ratio));
  return mapTree(tree, (n) => (n.id === splitId && n.kind === 'split' ? { ...n, ratio: clamped } : n));
}

// Removes a node (an area, or a whole split with its areas). Its sibling takes the parent's place.
// The root cannot be removed.
export function removeNode(tree, nodeId) {
  if (!tree || tree.id === nodeId) return tree;
  const found = findNode(tree, nodeId);
  if (!found || !found.parent) return tree;
  const sibling = found.parent.a.id === nodeId ? found.parent.b : found.parent.a;
  return mapTree(tree, (n) => (n.id === found.parent.id ? sibling : n));
}

// Splits an area into itself and a new area of the given type. The new area goes after the old one.
export function addBeside(tree, areaId, type, dir = 'row') {
  return mapTree(tree, (n) => (n.id === areaId && n.kind === 'area'
    ? split(dir, n, area(type), 0.5)
    : n));
}

// Puts a new area into a seam: the seam's split keeps its first child and gets a new area before its second child.
export function insertAtSeam(tree, splitId, type) {
  return mapTree(tree, (n) => (n.id === splitId && n.kind === 'split'
    ? { ...n, b: split(n.dir, area(type), n.b, 0.5) }
    : n));
}

// Size in px of a child node inside a split of the given total length.
export function childPx(split_, which, totalPx) {
  return which === 'a' ? totalPx * split_.ratio : totalPx * (1 - split_.ratio);
}

// Serialization for saving the layout between launches.
export function serialize(tree) {
  return JSON.stringify(tree);
}

// Advances the internal ID counter past any numeric IDs already present in a loaded tree
// so newly added areas/splits never collide with deserialized IDs.
function syncSeq(node) {
  if (!node) return;
  const m = /^[as](\d+)$/.exec(node.id);
  if (m) seq = Math.max(seq, Number(m[1]));
  if (node.kind === 'split') {
    syncSeq(node.a);
    syncSeq(node.b);
  }
}

// Reads a saved layout. Returns the default layout if the saved data is not valid.
export function deserialize(text) {
  try {
    const tree = JSON.parse(text);
    if (isValid(tree) && allAreas(tree).length) {
      syncSeq(tree);
      return tree;
    }
  } catch { /* fall through */ }
  return defaultLayout();
}

function isValid(node) {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string') return false;
  if (node.kind === 'area') return WINDOW_TYPES.some((t) => t.id === node.type);
  if (node.kind === 'split') {
    return (node.dir === 'row' || node.dir === 'col') && typeof node.ratio === 'number' && isValid(node.a) && isValid(node.b);
  }
  return false;
}
