import assert from 'node:assert/strict';

function graphIndex(root) {
  const definitions = new Map();
  const references = [];
  function index(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(index);
      return;
    }
    if (Object.hasOwn(node, '__ref__')) {
      assert.deepEqual(Object.keys(node), ['__ref__'], 'Malformed graph reference');
      assert.equal(typeof node.__ref__, 'string', 'Graph reference type');
      references.push(node.__ref__);
      return;
    }
    if (Object.hasOwn(node, '__id__')) {
      assert.equal(typeof node.__id__, 'string', 'Graph definition ID type');
      assert(!definitions.has(node.__id__), 'Duplicate graph definition');
      definitions.set(node.__id__, node);
    }
    Object.values(node).forEach(index);
  }
  index(root);
  for (const id of references) assert(definitions.has(id), `Dangling graph reference ${id}`);
  return (node) => node && typeof node === 'object' && Object.hasOwn(node, '__ref__')
    ? definitions.get(node.__ref__) : node;
}

export function assertGraph(actual, expected) {
  const dereferenceActual = graphIndex(actual);
  const dereferenceExpected = graphIndex(expected);
  const forward = new Map();
  const reverse = new Map();
  function compare(leftWire, rightWire, path) {
    const left = dereferenceActual(leftWire);
    const right = dereferenceExpected(rightWire);
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      assert.deepEqual(left, right, path);
      return;
    }
    assert.equal(Array.isArray(left), Array.isArray(right), path);
    if (forward.has(left) || reverse.has(right)) {
      assert(forward.get(left) === right && reverse.get(right) === left, `${path} edge changes identity`);
      return;
    }
    forward.set(left, right);
    reverse.set(right, left);
    if (Array.isArray(left)) assert.equal(left.length, right.length, path);
    // Validate identity requirements separately from the payload fields.
    if (Object.hasOwn(right, '__id__')) assert(Object.hasOwn(left, '__id__'), `${path} has no identity`);
    const payload = (object) => Object.keys(object).filter((key) => key !== '__id__').sort();
    const fields = payload(right);
    assert.deepEqual(payload(left), fields, `${path} fields`);
    for (const field of fields) compare(left[field], right[field], `${path}.${field}`);
  }
  compare(actual, expected, '$');
}

export function runGraphControls() {
  const build = (root, child) => ({
    __id__: root, __type__: 'TreeNode', val: 1,
    left: { __id__: child, __type__: 'TreeNode', val: 2, left: { __ref__: root }, right: null },
    right: { __ref__: child },
  });
  const expected = build('root', 'child');
  const renamed = build('a', 'b');
  assertGraph(renamed, expected);
  const edits = {
    'split-shared': (graph) => { graph.right = { ...graph.left, __id__: 'copy' }; },
    'collapse-distinct': (graph) => { graph.right = { ...graph.left, __id__: 'copy' }; },
    'redirect-back-edge': (graph) => { graph.left.left.__ref__ = 'b'; },
    'leak-value-field': (graph) => { graph.left.value = 1; },
    'remove-null': (graph) => { delete graph.left.right; },
  };
  const results = [{ id: 'renamed-ids', observed: 'pass' }];
  for (const [id, edit] of Object.entries(edits)) {
    const seed = structuredClone(renamed);
    edit(seed);
    if (id === 'collapse-distinct') assert.throws(() => assertGraph(renamed, seed), /identity/);
    else assert.throws(() => assertGraph(seed, expected));
    results.push({ id, observed: 'rejected' });
  }
  return results;
}
