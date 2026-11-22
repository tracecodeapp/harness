// Programs whose traced Run used to compute something different from the
// untraced Run (or that guard a transform against doing so). Shared by the
// Node worker test (tests/test-javascript-trace-semantics.ts) and the browser
// parity probe (TRACECODE_PARITY_SUITE=targeted).

export interface TraceSemanticsCase {
  id: string;
  code: string;
  /** TypeScript source when the JavaScript source is not also valid TypeScript. */
  typescript?: string;
  functionName?: string;
  executionStyle?: 'function' | 'solution-method' | 'ops-class';
  inputs?: Record<string, unknown>;
  /** The untraced result; checked so a case cannot silently stop testing anything. */
  expected?: unknown;
  languages?: ReadonlyArray<'javascript' | 'typescript'>;
  /** The tracer may refuse this program (a provider failure) instead of tracing it. */
  refusalAllowed?: boolean;
  /** The tracer must refuse this program. */
  refusalRequired?: boolean;
}

function solve(body: string, expected: unknown, extra: Partial<TraceSemanticsCase> = {}) {
  return { code: `function solve() {\n${body}\n}`, expected, ...extra };
}

function asyncSolve(body: string, expected: unknown) {
  return { code: `async function solve() {\n${body}\n}`, expected };
}

export const traceSemanticsCases: readonly TraceSemanticsCase[] = [
  // Per-iteration `let` bindings in a for statement.
  { id: 'J1', ...solve('const f = []; for (let i = 0; i < 2; i++) f.push(() => i); return f[0]();', 0) },
  { id: 'J1-continue', ...solve(`const f = [];
  for (let i = 0; i < 3; i++) {
    if (i === 1) continue;
    f.push(() => i);
  }
  return f.map((g) => g()).join();`, '0,2') },
  { id: 'J1-two-bindings', ...solve(`const f = [];
  for (let i = 0, j = 10; i < 2; i++, j--) f.push(() => i + j);
  return f.map((g) => g()).join();`, '10,10') },
  { id: 'J1-destructured', ...solve(`const f = [];
  for (let [i, j] = [0, 5]; i < 2; i++) f.push(() => i * j);
  return f.map((g) => g()).join();`, '0,5') },
  { id: 'J1-initializer-closure', ...solve(`const f = [];
  for (let i = 0, g = () => i; i < 2; i++) f.push(g);
  return f.map((g) => g()).join();`, '0,0') },
  { id: 'J1-var', ...solve('const f = []; for (var i = 0; i < 2; i++) f.push(() => i); return f[0]();', 2) },
  { id: 'J1-const', ...solve('let n = 0; for (const o = { k: 3 }; n < o.k; n++); return n;', 3) },

  // `delete` of a member must delete, not delete a helper call's result.
  { id: 'J4', ...solve('const o = {x: 1}; delete o.x; return "x" in o;', false) },
  { id: 'J4-bracket', ...solve(`const freq = { a: 2, b: 1 };
  const s = "ab";
  for (const ch of s) {
    freq[ch] -= 1;
    if (freq[ch] === 0) delete freq[ch];
  }
  return Object.keys(freq).join();`, 'a') },
  { id: 'J4-optional', ...solve('const o = {x: 1}; delete o?.x; return "x" in o;', false) },
  { id: 'J4-nested', ...solve('const o = {p: {q: 1}}; delete o.p.q; return Object.keys(o.p).length;', 0) },
  { id: 'J4-indexed-nested', ...solve('const g = [{a: 1}]; const i = 0; delete g[i]["a"]; return Object.keys(g[0]).length;', 0) },
  { id: 'J4-this', code: `class Solution {
  solve() {
    this.seen = { a: 1 };
    delete this.seen.a;
    return Object.keys(this.seen).length;
  }
}`, executionStyle: 'solution-method', expected: 0 },
  { id: 'J4-result', ...solve('const o = {x: 1}; const r = delete o.x; return [r, "x" in o].join();', 'true,false') },

  // A label on a loop stays on the loop.
  { id: 'J2', ...solve('outer: for (const x of [1]) { continue outer; } return 1;', 1) },
  { id: 'J2-for-let', ...solve(`let s = 0;
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j > i) continue outer;
      s++;
    }
  }
  return s;`, 6) },
  { id: 'J2-for-var', ...solve(`outer: for (var i = 0; i < 2; i++) {
    for (var j = 0; j < 2; j++) { if (j) continue outer; }
  }
  return i * 10 + j;`, 21) },
  { id: 'J2-while', ...solve(`let i = 0, s = 0;
  outer: while (i < 3) {
    i++;
    for (const x of [1, 2]) { if (x === 2) continue outer; s += x; }
  }
  return s;`, 3) },
  { id: 'J2-break', ...solve(`let n = 0;
  outer: for (const x of [1, 2, 3]) {
    for (const y of [1, 2]) { if (x === 2) break outer; n += y; }
  }
  return n;`, 3) },
  { id: 'J2-nested-labels', ...solve(`let n = 0;
  a: b: for (const x of [1, 2, 3]) { n += x; if (x === 2) continue a; if (x === 1) continue b; }
  return n;`, 6) },

  // Optional calls keep short-circuiting.
  { id: 'J3', ...solve('const a = null; a?.push(1); return 7;', 7) },
  { id: 'J3-member', ...solve('const o = {}; return o.list?.push(1) ?? "none";', 'none') },
  { id: 'J3-chain', ...solve('const o = { a: null }; o.a?.b.push(1); return 2;', 2) },
  { id: 'J3-map', ...solve('let m = null; m?.set(1, 2); const r = m?.get(1); return r === undefined;', true) },
  { id: 'J3-call', ...solve('const a = [1]; a.push?.(2); const o = {}; o.push?.(3); return a.length;', 2) },
  { id: 'J3-receiver-first', ...solve(`const a = [[1], [2]];
  a[0].push(a.shift());
  return JSON.stringify(a);`, '[[2]]') },
  { id: 'J3-not-a-function', ...solve('const a = {}; try { a.push(1); } catch (e) { return e.message; } return "no";', 'a.push is not a function') },
  { id: 'J3-null-receiver', ...solve('const a = null; try { a.push(1); } catch (e) { return e.message; } return "no";', "Cannot read properties of null (reading 'push')") },
  { id: 'J3-get-receiver', ...solve(`const o = { data: { k: [] }, get(key) { return this.data[key]; } };
  o.get("k").push(1);
  return o.data.k.length;`, 1) },
  { id: 'J3-map-bracket-receiver', ...solve(`const m = new Map([["k", [1]]]);
  try { m["k"].push(2); } catch (e) { return "threw"; }
  return m.get("k").length;`, 'threw') },
  { id: 'J3-map-get-receiver', ...solve(`const m = new Map([["k", []]]);
  m.get("k").push(1);
  return m.get("k").length;`, 1) },

  // Compound and update assignment on members.
  { id: 'J5', ...solve('const a = [1]; a[0] += (a[0] = 10); return a[0];', 11) },
  { id: 'J5-nested', ...solve(`const g = [[0, 0]];
  const old = g[0];
  g[0][1] += (g[0] = [5, 5], 1);
  return [old.join(), g[0].join()].join("|");`, '0,1|5,5') },
  { id: 'J5-property', ...solve('const o = { x: 1 }; o.x += (o.x = 10); return o.x;', 11) },
  { id: 'J5-index-rhs', ...solve('const a = [0, 0]; let i = 0; const f = () => { i = 1; return 5; }; a[i] += f(); return a.join();', '5,0') },
  { id: 'J6', ...solve('const a = ["1"]; a[0]++; return a[0];', 2) },
  { id: 'J6-postfix-value', ...solve('const a = ["5"]; const r = a[0]++; return typeof r + r;', 'number5') },
  { id: 'J6-bigint', ...solve('const a = [1n]; a[0]++; --a[0]; ++a[0]; return String(a[0]);', '2') },
  { id: 'J6-property', ...solve('const o = { c: "1" }; o.c++; return o.c;', 2) },
  { id: 'J6-getter-once', ...solve(`let n = 0;
  const o = { get a() { n++; return [0]; } };
  o.a[0]++;
  o.a[0] += 1;
  return n;`, 2) },
  { id: 'J6-post-index', ...solve('const a = [0, 0, 0]; let i = 0; a[i++] = 5; a[i++] += 2; a[i++]++; return a.join() + i;', '5,2,13') },
  { id: 'J6-logical', ...solve(`const o = { z: 1 };
  o.x ??= 5; o.y ||= 3; o.z &&= 2;
  const a = []; a[0] ??= 4; a[1] ||= 6;
  return JSON.stringify([o, a]);`, '[{"z":2,"x":5,"y":3},[4,6]]') },
  { id: 'J6-unsigned-shift', ...solve('const o = { x: -1 }; o.x >>>= 28; const a = [-1]; a[0] >>>= 28; return o.x + a[0];', 30) },
  { id: 'J6-group-push', ...solve('const m = {}; (m["k"] ??= []).push(1); return m.k.length;', 1) },

  // Block scoping in loop conditions.
  { id: 'J7', ...solve('let x = true; while (x) { let x = false; return 1; } return 0;', 1) },
  { id: 'J7-continue', ...solve('let i = 0, s = 0; while (i < 5) { i++; if (i % 2) continue; s += i; } return s;', 6) },
  { id: 'J7-function', ...solve('let n = 0; while (n < 2) { function f() { return 1; } n += f(); } return n;', 2) },

  // Iterated expressions are evaluated once.
  { id: 'J8', ...solve('let i = 0; const rows = [[7]]; for (const x of rows[i++]) return i;', 1) },
  { id: 'J8-get', ...solve(`let calls = 0;
  const key = () => { calls++; return "k"; };
  const m = new Map([["k", [1, 2]]]);
  let s = 0;
  for (const x of m.get(key())) s += x;
  return s * 10 + calls;`, 31) },
  { id: 'J8-not-iterable', ...solve('const rows = []; let i = 0; try { for (const x of rows[i]) {} } catch (e) { return e.message; } return "no";', 'rows[i] is not iterable') },
  { id: 'J8-for-await', ...asyncSolve(`async function* g() { yield 1; yield 2; }
  let s = 0;
  for await (const x of g()) s += x;
  for await (const x of [Promise.resolve(3)]) s += x;
  return s;`, 6) },
  { id: 'J8-member-target', ...solve('const o = {}; for (o.x of [1, 2]); for (o.k in { a: 1 }); return o.x + o.k;', '2a') },
  { id: 'J8-generator', ...solve(`function* g() {
    const a = [];
    for (let i = 0; i < 3; i++) { a.push(i); yield a[i]; }
  }
  return [...g()].join();`, '0,1,2') },

  // Bracket access on a Map reads the property, not the entry.
  { id: 'J9', ...solve('const m = new Map([["x", 7]]); return m["x"] === undefined;', true),
    typescript: 'function solve(): boolean {\n  const m: any = new Map([["x", 7]]); return m["x"] === undefined;\n}' },
  { id: 'J9-nested', ...solve('const a = [new Map([["x", 7]])]; const k = "x"; return a[0][k] === undefined;', true) },
  { id: 'J9-in', ...solve('const m = new Map([[0, { x: 1 }]]); try { return "x" in m[0]; } catch (e) { return "threw"; }', 'threw') },
  { id: 'J9-duck', ...solve(`class Store {
    constructor() { this.d = { a: 1 }; }
    get(k) { return this.d[k]; }
    set(k, v) { this.d[k] = v; }
    has(k) { return k in this.d; }
    delete(k) { delete this.d[k]; }
  }
  const s = new Store();
  return s["a"] === undefined;`, true) },

  // Thrown values are not replaced or stringified.
  { id: 'J10', ...solve('const e = {toString(){throw 2}}; try {throw e} catch (x) {return x === e}', true) },
  { id: 'J10-tostring-calls', ...solve('let n = 0; const e = { toString() { n++; return "e"; } }; try { throw e; } catch {} return n;', 0) },
  { id: 'J10-console', ...solve('let n = 0; const o = { toString() { n++; return "o"; } }; console.log(o); return n;', 0) },
  { id: 'J10-console-shadow', ...solve('const console = { log() { return 1; } }; console.log("x"); return 1;', 1) },

  // Destructuring assignment targets stay assignment targets.
  { id: 'D1-member-default', ...solve('const o = {}; const a = [0]; [o.x = 5, a[0] = 6] = []; return o.x + a[0];', 11) },
  { id: 'D1-rest', ...solve('let first, rest; [first, ...rest] = [1, 2, 3]; return rest.length;', 2) },
  { id: 'D1-object-rest', ...solve('let a, more; ({ a, ...more } = { a: 1, b: 2, c: 3 }); return Object.keys(more).join();', 'b,c') },
  { id: 'D1-swap', ...solve('const a = [1, 2, 3]; let i = 0, j = 2; [a[i], a[j]] = [a[j], a[i]]; return a.join();', '3,2,1') },
  { id: 'D1-for-of-destructure', ...solve('let a, b, s = 0; for ([a, ...b] of [[1, 2, 3]]) s = a + b.length; return s;', 3) },

  // Calls keep their receiver, arguments and order.
  { id: 'C1-arguments', ...solve('function f() { const a = []; a.push(arguments[0]); return a[0]; } return f(7);', 7) },
  { id: 'C1-args-before-index', ...solve('const a = [[], []]; let i = 0; a[i].push(i++); return JSON.stringify(a) + i;', '[[0],[]]1') },
  { id: 'C1-multi-index-await', ...asyncSolve('const g = [[0]]; g[0][await Promise.resolve(0)] = 7; return g[0][0];', 7) },
  { id: 'C1-derived-constructor', ...solve(`class A { constructor(x) { this.x = x; } }
  class B extends A { constructor() { super(1); this.y = 2; } }
  const b = new B();
  return b.x + b.y;`, 3) },
  { id: 'C1-parameter-properties', languages: ['typescript'], code: '', typescript: `class A { constructor(public x: number) {} }
class B extends A { constructor(public y: number) { super(1); } }
function solve(): number {
  const b = new B(2);
  return b.x + b.y;
}`, expected: 3 },
  { id: 'C1-non-null', languages: ['typescript'], code: '', typescript: `function solve(): number {
  const a: number[] | undefined = [1];
  a![0]++;
  (a as number[])[0] += 1;
  return a![0];
}`, expected: 3 },
];
