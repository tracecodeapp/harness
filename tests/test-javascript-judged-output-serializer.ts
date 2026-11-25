// The judged-output policy in the JavaScript serializer (lane C-SEAM).
//
// Loads the exact serializer region that the disposable worker runs and that
// scripts/build-javascript-ses-worker.mjs slices into the SES driver, and
// checks it against JSON.stringify as the byte, value, entry and nesting
// oracle. Runs under plain Node: no browser and no build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { JUDGED_OUTPUT_POLICY_DEFAULTS } from '../packages/runtime-contracts/src/judged-output-policy';

type Policy = { maxBytes: number; maxItems: number; maxNodes: number; maxDepth: number };
type Serializer = {
  serializeOutputValue(value: unknown, policy?: Policy | null): unknown;
  serializeTopLevelValue(value: unknown, nodeRefState: unknown): unknown;
  isJudgedOutputLimit(value: unknown): boolean;
};

function loadSerializer(): Serializer {
  const worker = readFileSync(resolve('workers/javascript/javascript-worker.js'), 'utf8');
  const start = worker.indexOf('function isLikelyTreeNodeValue');
  const end = worker.indexOf('function extractUserErrorLine', start);
  assert.ok(start >= 0 && end > start, 'serializer region markers');
  const source = worker.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}
    return {
      serializeOutputValue,
      serializeTopLevelValue,
      isJudgedOutputLimit: typeof isJudgedOutputLimit === 'function' ? isJudgedOutputLimit : () => false,
    };`)() as Serializer;
}

const serializer = loadSerializer();
const JS_DEFAULT = JUDGED_OUTPUT_POLICY_DEFAULTS.javascript!;
const UNBOUNDED: Policy = {
  maxBytes: Number.MAX_SAFE_INTEGER,
  maxItems: Number.MAX_SAFE_INTEGER,
  maxNodes: Number.MAX_SAFE_INTEGER,
  maxDepth: 10_000,
};

type Outcome = { ok: true; value: unknown } | { ok: false; limit: string };

function judged(value: unknown, policy: Partial<Policy> = {}): Outcome {
  try {
    return { ok: true, value: serializer.serializeOutputValue(value, { ...JS_DEFAULT, ...policy }) };
  } catch (error) {
    if (!serializer.isJudgedOutputLimit(error)) throw error;
    const limit = (error as { limit?: unknown }).limit;
    assert.equal(typeof (error as { message?: unknown }).message, 'string');
    return { ok: false, limit: String(limit) };
  }
}

function jsonBytes(value: unknown): number {
  // JSON.stringify(undefined) writes nothing: a root undefined is 0 bytes.
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

/** Nesting of the language value: a container is one deeper than its parent; scalars add nothing. */
function valueDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children = value instanceof Map
    ? [...value].flat()
    : value instanceof Set
      ? [...value]
      : Array.isArray(value)
        ? Array.from(value)
        : Object.values(value);
  return 1 + children.reduce<number>((deepest, child) => Math.max(deepest, valueDepth(child)), 0);
}

/** JSON values, the largest container and the deepest container nesting. */
function jsonShape(value: unknown) {
  // A root undefined writes no JSON text: no values at all.
  if (value === undefined) return { nodes: 0, items: 0, depth: 0 };
  let nodes = 0;
  let items = 0;
  let depth = 0;
  const stack: Array<[unknown, number]> = [[JSON.parse(JSON.stringify(value === undefined ? null : value)), 0]];
  while (stack.length > 0) {
    const [current, parentDepth] = stack.pop()!;
    nodes += 1;
    if (current === null || typeof current !== 'object') continue;
    const children = Array.isArray(current) ? current : Object.values(current);
    items = Math.max(items, children.length);
    depth = Math.max(depth, parentDepth + 1);
    for (const child of children) stack.push([child, parentDepth + 1]);
  }
  return { nodes, items, depth };
}

test('a 1,024-byte policy passes 64 characters and refuses 2,048 as a typed limit', () => {
  assert.deepEqual(judged('x'.repeat(64), { maxBytes: 1024 }), { ok: true, value: 'x'.repeat(64) });
  assert.deepEqual(judged('x'.repeat(2048), { maxBytes: 1024 }), { ok: false, limit: 'byte' });
  assert.deepEqual(judged('x'.repeat(1022), { maxBytes: 1024 }), { ok: true, value: 'x'.repeat(1022) });
  assert.deepEqual(judged('x'.repeat(1023), { maxBytes: 1024 }), { ok: false, limit: 'byte' });
});

test('bytes are UTF-8 of the compact JSON, not UTF-16 code units', () => {
  const cases: Array<[string, number]> = [
    ['é'.repeat(511), 1024],          // 2 bytes each
    ['雪'.repeat(340), 1022],          // 3 bytes each
    ['😀'.repeat(255), 1022],          // a surrogate pair is 4 bytes
    ['\ud800'.repeat(170), 1022],     // a lone surrogate is escaped: 6 bytes
    ['\u0001'.repeat(170), 1022],     // a control character is \u0001: 6 bytes
    ['\n'.repeat(511), 1024],         // a short escape is 2 bytes
    ['"'.repeat(511), 1024],
    ['\\'.repeat(511), 1024],
    [' '.repeat(340), 1022],     // JSON.stringify keeps U+2028 raw: 3 bytes
  ];
  for (const [text, bytes] of cases) {
    assert.equal(jsonBytes(text), bytes, `oracle for ${JSON.stringify(text.slice(0, 2))}`);
    assert.equal(judged(text, { maxBytes: bytes }).ok, true, `${bytes} bytes fit`);
    assert.deepEqual(judged(text, { maxBytes: bytes - 1 }), { ok: false, limit: 'byte' });
  }
  assert.deepEqual(judged('雪'.repeat(400), { maxBytes: 1024 }), { ok: false, limit: 'byte' });
});

test('the product default: just under passes, just over is refused', () => {
  const max = JS_DEFAULT.maxBytes;
  assert.equal(judged('x'.repeat(max - 2)).ok, true);
  assert.deepEqual(judged('x'.repeat(max - 1)), { ok: false, limit: 'byte' });
  assert.equal(judged(Array.from({ length: JS_DEFAULT.maxItems }, () => 0)).ok, true);
  assert.deepEqual(judged(Array.from({ length: JS_DEFAULT.maxItems + 1 }, () => 0)), { ok: false, limit: 'item' });
});

test('a 64 MiB string is refused without a value', () => {
  assert.deepEqual(judged('x'.repeat(64 * 1024 * 1024)), { ok: false, limit: 'byte' });
});

test('nesting: 64 containers pass, 65 are a typed limit, never a <max depth> sentinel', () => {
  const nested = (levels: number) => {
    let value: unknown = 1;
    for (let index = 0; index < levels; index += 1) value = [value];
    return value;
  };
  for (const levels of [48, 49, 50, 64]) {
    const outcome = judged(nested(levels));
    assert.equal(outcome.ok, true, `${levels} levels`);
    assert.equal(JSON.stringify(outcome.ok && outcome.value).includes('<max depth>'), false);
  }
  assert.deepEqual(judged(nested(65)), { ok: false, limit: 'depth' });
  assert.deepEqual(judged(nested(5), { maxDepth: 4 }), { ok: false, limit: 'depth' });
  assert.equal(judged(nested(4), { maxDepth: 4 }).ok, true);
  assert.equal(judged(7, { maxDepth: 0 }).ok, true);
  assert.deepEqual(judged([], { maxDepth: 0 }), { ok: false, limit: 'depth' });
});

test('a linked list of 64 nodes passes and 65 is a typed limit', () => {
  class ListNode {
    val: number;
    next: ListNode | null;
    constructor(val: number, next: ListNode | null = null) { this.val = val; this.next = next; }
  }
  const list = (length: number) => {
    let head: ListNode | null = null;
    for (let index = length; index > 0; index -= 1) head = new ListNode(index, head);
    return head;
  };
  const passed = judged(list(64));
  assert.equal(passed.ok, true);
  assert.equal(jsonShape(passed.ok && passed.value).depth, 64);
  assert.equal(JSON.stringify(passed.ok && passed.value).includes('<max depth>'), false);
  assert.deepEqual(judged(list(65)), { ok: false, limit: 'depth' });
});

test('nesting counts language values: a set or map counts once, not its JSON wrappers', () => {
  // A Map is written as { __type__: 'map', entries: [[k, v]] }, three JSON
  // containers, but it is one value deep, as the serializer (and C# and Java)
  // have always counted it. 25 nested Maps pass on main today.
  let map: unknown = 'leaf';
  for (let depth = 0; depth < 25; depth += 1) map = new Map([[depth, map]]);
  assert.equal(judged(map).ok, true);
  let maps: unknown = 'leaf';
  for (let depth = 0; depth < 64; depth += 1) maps = new Map([[depth, maps]]);
  assert.equal(judged(maps).ok, true);
  assert.deepEqual(judged(new Map([[0, maps]])), { ok: false, limit: 'depth' });
  const set = new Set([[1]]);
  assert.equal(judged(set, { maxDepth: 2 }).ok, true);
  assert.deepEqual(judged(set, { maxDepth: 1 }), { ok: false, limit: 'depth' });
  assert.equal(judged(new Map([[1, [2]]]), { maxDepth: 2 }).ok, true);
  assert.deepEqual(judged(new Map([[1, [2]]]), { maxDepth: 1 }), { ok: false, limit: 'depth' });
});

test('a cycle is a typed limit; a shared child is serialized at each occurrence', () => {
  const array: unknown[] = [1];
  array.push(array);
  assert.deepEqual(judged(array), { ok: false, limit: 'cycle' });
  const object: Record<string, unknown> = { a: 1 };
  object.self = { inner: object };
  assert.deepEqual(judged(object), { ok: false, limit: 'cycle' });
  const set = new Set<unknown>();
  set.add(set);
  assert.deepEqual(judged(set), { ok: false, limit: 'cycle' });

  const row = [1, 2];
  const shared = { x: 1 };
  const members = new Set([3]);
  assert.deepEqual(judged([[row, row], [shared, shared], new Array(3).fill([]), [members, members]]), {
    ok: true,
    value: [
      [[1, 2], [1, 2]],
      [{ x: 1 }, { x: 1 }],
      [[], [], []],
      [{ __type__: 'set', values: [3] }, { __type__: 'set', values: [3] }],
    ],
  });
  const view = new Int32Array([4, 5]);
  assert.deepEqual(judged([view, view]), { ok: true, value: [[4, 5], [4, 5]] });
});

test('nodes and class instances keep their references', () => {
  class TreeNode {
    val: number;
    left: TreeNode | null;
    right: TreeNode | null;
    constructor(val: number, left: TreeNode | null = null, right: TreeNode | null = null) {
      this.val = val; this.left = left; this.right = right;
    }
  }
  const child = new TreeNode(2);
  const root = new TreeNode(1, child, child);
  const outcome = judged(root);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.value, serializer.serializeOutputValue(root));
  const cyclic = new TreeNode(1);
  cyclic.left = cyclic;
  const cycled = judged(cyclic);
  assert.equal(cycled.ok, true);
  assert.deepEqual(cycled.ok && cycled.value, serializer.serializeOutputValue(cyclic));
});

test('entries are per container and values are counted over the whole answer', () => {
  assert.equal(judged([1, 2, 3], { maxItems: 3 }).ok, true);
  assert.deepEqual(judged([1, 2, 3, 4], { maxItems: 3 }), { ok: false, limit: 'item' });
  assert.equal(judged([[1, 2, 3], [4, 5, 6]], { maxItems: 3 }).ok, true);
  assert.deepEqual(judged({ a: 1, b: 2, c: 3, d: 4 }, { maxItems: 3 }), { ok: false, limit: 'item' });
  assert.deepEqual(judged(new Set([1, 2, 3, 4]), { maxItems: 3 }), { ok: false, limit: 'item' });
  // [[1,2,3],[4,5,6]] is 9 JSON values.
  assert.equal(judged([[1, 2, 3], [4, 5, 6]], { maxNodes: 9 }).ok, true);
  assert.deepEqual(judged([[1, 2, 3], [4, 5, 6]], { maxNodes: 8 }), { ok: false, limit: 'node' });
});

test('an exponential shared structure stops at the node bound', () => {
  let value: unknown = [0];
  for (let index = 0; index < 40; index += 1) value = [value, value];
  const startedAt = performance.now();
  assert.deepEqual(judged(value, { maxDepth: 100 }), { ok: false, limit: 'node' });
  assert.ok(performance.now() - startedAt < 10_000, 'bounded work');
});

test('a refusal leaves no budget armed: legacy and trace serialization are unchanged afterwards', () => {
  const array: unknown[] = [];
  array.push(array);
  const deep = (() => {
    let value: unknown = 1;
    for (let index = 0; index < 60; index += 1) value = [value];
    return value;
  })();
  const legacyBefore = JSON.stringify([serializer.serializeOutputValue(array), serializer.serializeOutputValue(deep)]);
  const traceBefore = JSON.stringify(serializer.serializeTopLevelValue(Array.from({ length: 100 }, (_, i) => i), { ids: new WeakMap(), nextId: 1 }));
  assert.equal(judged('x'.repeat(2048), { maxBytes: 1024 }).ok, false);
  assert.equal(judged(array).ok, false);
  assert.equal(judged([[1, 2, 3, 4]], { maxItems: 2 }).ok, false);
  assert.equal(JSON.stringify([serializer.serializeOutputValue(array), serializer.serializeOutputValue(deep)]), legacyBefore);
  assert.ok(legacyBefore.includes('<cycle>') && legacyBefore.includes('<max depth>'), 'calls without a policy keep their markers');
  assert.equal(JSON.stringify(serializer.serializeTopLevelValue(Array.from({ length: 100 }, (_, i) => i), { ids: new WeakMap(), nextId: 1 })), traceBefore);
  assert.ok(traceBefore.includes('__truncated__'), 'trace limits still truncate');
  assert.equal(judged('x'.repeat(64), { maxBytes: 1024 }).ok, true);
});

test('a judged value never carries a placeholder or a truncation marker', () => {
  const large = Array.from({ length: 70 }, (_, index) => ({ index, label: `item-${index}` }));
  const outcome = judged(large);
  assert.equal(outcome.ok, true);
  const text = JSON.stringify(outcome.ok && outcome.value);
  for (const marker of ['<max depth>', '<cycle>', '__truncated__']) assert.equal(text.includes(marker), false, marker);
});

test('an over-wide array is refused before it is copied', () => {
  // A 10,000,000-slot array behind a proxy that counts element reads: the
  // bound must fire on its length, before any element is read or copied.
  let reads = 0;
  const wide = new Proxy(new Array(10_000_000), {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(judged(wide, { maxItems: 1000 }), { ok: false, limit: 'item' });
  assert.equal(reads, 0, 'no element read before the entry bound');
  assert.deepEqual(judged(wide, { maxItems: Number.MAX_SAFE_INTEGER, maxNodes: 1000 }), { ok: false, limit: 'node' });
  assert.equal(reads, 0, 'no element read before the value bound');
});

test('an over-wide typed array is refused on its length', () => {
  const startedAt = performance.now();
  assert.deepEqual(judged(new Uint8Array(20_000_000), { maxItems: 1000 }), { ok: false, limit: 'item' });
  assert.deepEqual(judged(new Uint8Array(20_000_000).buffer, { maxItems: 1000 }), { ok: false, limit: 'item' });
  assert.ok(performance.now() - startedAt < 1_000, 'bounded work');
});

test('an over-wide Set or Map is refused without draining it', () => {
  const originalValues = Set.prototype.values;
  const originalEntries = Map.prototype.entries;
  let pulls = 0;
  const counted = <T,>(iterator: Iterator<T>): Iterator<T> => ({
    next() { pulls += 1; return iterator.next(); },
  });
  Set.prototype.values = function values(this: Set<unknown>) {
    return counted(originalValues.call(this)) as ReturnType<typeof originalValues>;
  };
  Map.prototype.entries = function entries(this: Map<unknown, unknown>) {
    return counted(originalEntries.call(this)) as ReturnType<typeof originalEntries>;
  };
  try {
    const set = new Set(Array.from({ length: 5000 }, (_, index) => index));
    const map = new Map(Array.from({ length: 5000 }, (_, index) => [index, index]));
    for (const value of [set, map]) {
      pulls = 0;
      assert.deepEqual(judged(value, { maxItems: 100 }), { ok: false, limit: 'item' });
      assert.ok(pulls <= 101, `drained ${pulls} entries past a 100-entry bound`);
      pulls = 0;
      assert.deepEqual(judged(value, { maxNodes: 100 }), { ok: false, limit: 'node' });
      assert.ok(pulls <= 101, `drained ${pulls} entries past a 100-value bound`);
    }
  } finally {
    Set.prototype.values = originalValues;
    Map.prototype.entries = originalEntries;
  }
});

test('a Set or Map that cannot be read is a typed limit, never a placeholder', () => {
  // A proxy has no Set or Map internal slot, so the built-in iterator throws.
  for (const value of [new Proxy(new Set([1]), {}), new Proxy(new Map([[1, 2]]), {})]) {
    assert.deepEqual(judged(value), { ok: false, limit: 'unrepresentable' });
    assert.deepEqual(judged([1, value]), { ok: false, limit: 'unrepresentable' });
  }
  // Without a policy (trace mode, direct execution) the placeholder is unchanged.
  assert.equal(serializer.serializeOutputValue(new Proxy(new Set([1]), {})), '<unserializable Set>');
  assert.equal(serializer.serializeOutputValue(new Proxy(new Map([[1, 2]]), {})), '<unserializable Map>');
});

test('a malformed policy fails closed', () => {
  const malformed = { maxBytes: '1024', maxItems: 250_000, maxNodes: 1_000_000, maxDepth: 64 };
  assert.throws(
    () => serializer.serializeOutputValue('x', malformed as unknown as Policy),
    (error) => serializer.isJudgedOutputLimit(error) && (error as { limit?: unknown }).limit === 'byte'
  );
  const missing = { maxBytes: 1024, maxItems: 250_000, maxNodes: 1_000_000 };
  assert.throws(
    () => serializer.serializeOutputValue([], missing as unknown as Policy),
    (error) => serializer.isJudgedOutputLimit(error) && (error as { limit?: unknown }).limit === 'depth'
  );
});

test('a root undefined is no JSON text, so zero bytes', () => {
  assert.deepEqual(judged(undefined, { maxBytes: 0 }), { ok: true, value: undefined });
  assert.deepEqual(judged(null, { maxBytes: 3 }), { ok: false, limit: 'byte' });
  assert.deepEqual(judged([undefined], { maxBytes: 5 }), { ok: false, limit: 'byte' });
  assert.equal(judged([undefined], { maxBytes: 6 }).ok, true);
});

// A seeded generator keeps the fuzz reproducible.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 6 ? 7 : 12));
  const strings = ['', 'a', 'é', '雪', '😀', '\ud800', '\u0001', '\n', '"', '\\', ' ', 'ascii text'];
  switch (pick) {
    case 0: return null;
    case 1: return next() < 0.5;
    case 2: return Math.floor(next() * 2_000_000) - 1_000_000;
    case 3: return [1e21, -1.2345678901234567e-7, 0.1, -0, 5e-324, 1.7976931348623157e308][Math.floor(next() * 6)];
    case 4: return Array.from({ length: Math.floor(next() * 4) + 1 }, () => strings[Math.floor(next() * strings.length)]).join('');
    case 5: return undefined;
    case 6: return Number.NaN;
    case 7: {
      const array = Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1));
      if (next() < 0.2) array.length += 2; // holes
      return array;
    }
    case 8: {
      const object: Record<string, unknown> = {};
      for (let index = Math.floor(next() * 5); index > 0; index -= 1) {
        object[`${strings[Math.floor(next() * strings.length)]}${index}`] = randomValue(next, depth + 1);
      }
      return object;
    }
    case 9: return new Set([randomValue(next, depth + 1), randomValue(next, depth + 1)]);
    case 10: return new Map([[randomValue(next, depth + 1), randomValue(next, depth + 1)]]);
    default: return { val: randomValue(next, depth + 1), next: next() < 0.5 ? null : { val: 1, next: null } };
  }
}

test('fuzz: every bound agrees with JSON.stringify at the boundary', () => {
  const next = random(0xc5ea);
  for (let round = 0; round < 6_000; round += 1) {
    const value = randomValue(next, 0);
    const full = serializer.serializeOutputValue(value, UNBOUNDED);
    const bytes = jsonBytes(full);
    const shape = jsonShape(full);
    const check = (policy: Partial<Policy>, refused: string | null, label: string) => {
      const outcome = judged(value, { ...UNBOUNDED, ...policy });
      if (refused) assert.deepEqual(outcome, { ok: false, limit: refused }, `${label} round ${round}`);
      else assert.deepEqual(outcome, { ok: true, value: full }, `${label} round ${round}`);
    };
    check({ maxBytes: bytes }, null, 'bytes at the bound');
    if (bytes > 0) check({ maxBytes: bytes - 1 }, 'byte', 'bytes over the bound');
    check({ maxNodes: shape.nodes }, null, 'nodes at the bound');
    if (shape.nodes > 0) check({ maxNodes: shape.nodes - 1 }, 'node', 'nodes over the bound');
    check({ maxItems: shape.items }, null, 'items at the bound');
    if (shape.items > 0) check({ maxItems: shape.items - 1 }, 'item', 'items over the bound');
    const depth = valueDepth(value);
    check({ maxDepth: depth }, null, 'depth at the bound');
    if (depth > 0) check({ maxDepth: depth - 1 }, 'depth', 'depth over the bound');
  }
});
