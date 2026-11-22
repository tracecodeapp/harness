// Programs for the rule "the untraced answer is the truth on whether a program
// compiles". Each is built in every execution style; see
// javascript-trace-compile-matrix.ts for what is asserted.

export type TraceCompileLanguage = 'javascript' | 'typescript';
export type TraceCompileStyle = 'function' | 'solution-method' | 'ops-class' | 'script';

export const TRACE_COMPILE_STYLES: readonly TraceCompileStyle[] = ['function', 'solution-method', 'ops-class', 'script'];

export interface TraceCompileCase {
  id: string;
  /** Source before the solution (a helper outside it). */
  top?: string;
  /** Statements inside the solution's function or method, before its return. */
  body?: string;
  /** A member of the solution's class (of a helper class where there is none). */
  member?: string;
  /** Rewrites the assembled source. */
  edit?: (code: string) => string;
  languages?: readonly TraceCompileLanguage[];
  styles?: readonly TraceCompileStyle[];
  /**
   * What untraced Submit must answer, so a case cannot stop testing what it
   * names. Omitted where engines, languages or routes legitimately differ.
   */
  untraced?: 'passes' | 'rejects';
  /**
   * For a program untraced passes: 'refused' when a traced step cannot build
   * it, 'either' when that depends on the engine or route. Otherwise it must
   * really be traced, so a refusal cannot hide in this matrix.
   */
  traced?: 'refused' | 'either';
}

const JS = ['javascript'] as const;
const TS = ['typescript'] as const;

const invalid: readonly TraceCompileCase[] = ([
  // The learner mistakes the coordinator named.
  { id: 'missing-brace', edit: (code) => code.slice(0, code.lastIndexOf('}')) },
  { id: 'extra-brace', edit: (code) => `${code}\n}` },
  { id: 'stray-paren', body: 'const extra = (n + 2));' },
  { id: 'class-method-unclosed-paren', member: 'broken() {\n  return Math.max(1, 2;\n}' },
  { id: 'class-method-missing-operand', member: 'broken() {\n  const value = 1 +;\n  return value;\n}' },
  { id: 'helper-class-method', top: 'class Helper {\n  run() {\n    return [1, 2;\n  }\n}' },
  { id: 'helper-function', top: 'function helper() {\n  return (1 + 2;\n}' },
  // Programs the TypeScript parser or printer recovers from, and early errors
  // that its parser does not report.
  { id: 'duplicate-let', body: 'let twice = 1;\nlet twice = 2;' },
  { id: 'duplicate-constructor', top: 'class Twice { constructor() {} constructor() {} }' },
  { id: 'undeclared-private-name', top: 'class NoName { read() { return this.#missing; } }' },
  { id: 'break-outside-loop', body: 'break;' },
  { id: 'unknown-label', body: 'for (;;) { continue missing; }' },
  { id: 'unterminated-string', body: 'const text = "abc;' },
  { id: 'unterminated-template', body: 'const text = `abc;' },
  { id: 'unterminated-comment', edit: (code) => `${code}\n/* never closed` },
  { id: 'missing-comma', body: 'const list = [1 2];' },
  { id: 'await-in-sync-function', body: 'const value = await Promise.resolve(1);' },
  { id: 'super-outside-class', top: 'function noSuper() { super(); }' },
  { id: 'bad-regex', languages: JS, body: 'const pattern = /(/;' },
] satisfies TraceCompileCase[]).map((testCase) => ({ ...testCase, untraced: 'rejects' as const }));

const modernSyntax: readonly TraceCompileCase[] = [
  { id: 'plain', untraced: 'passes' },
  { id: 'private-fields-and-methods', untraced: 'passes', top: 'class Priv { #x = 1; #get() { return this.#x; } static #n = 2; read() { return this.#get() + Priv.#n; } }', body: 'const priv = new Priv().read();' },
  { id: 'private-member', untraced: 'passes', member: '#secret = 1;\npeek() { return this.#secret; }' },
  { id: 'static-block', untraced: 'passes', top: 'class Boot { static ready; static { Boot.ready = true; } }', body: 'const ready = Boot.ready;' },
  { id: 'class-accessors', untraced: 'passes', member: 'get size() { return 1; }\nset size(value) { }' },
  { id: 'class-fields', untraced: 'passes', member: 'count = 0;\nstatic limit = 5;' },
  { id: 'logical-assignment', untraced: 'passes', body: 'let a = null;\na ??= 1;\nlet b = 0;\nb ||= 2;\nlet c = 1;\nc &&= 3;' },
  { id: 'logical-assignment-element', untraced: 'passes', body: 'const groups = {};\ngroups["k"] ??= [];' },
  { id: 'logical-assignment-property', untraced: 'passes', body: 'const o = {};\no.x ??= 5;' },
  { id: 'unsigned-shift-property', untraced: 'passes', body: 'const o = { x: -1 };\no.x >>>= 28;' },
  { id: 'numeric-separators', untraced: 'passes', body: 'const big = 1_000_000;' },
  { id: 'bigint', untraced: 'passes', body: 'const huge = 9_007_199_254_740_993n;' },
  { id: 'optional-chaining', untraced: 'passes', body: 'const o = { a: { b: [1] } };\nconst found = o?.a?.b?.[0] ?? 0;' },
  { id: 'regex-slash', untraced: 'passes', body: 'const path = /\\/api\\/v1/.test("/api/v1");' },
  { id: 'regex-class-slash', untraced: 'passes', body: 'const slash = /[/]/.test("/");' },
  { id: 'regex-braces', untraced: 'passes', body: 'const braces = /[{}]|\\{\\d{1,3}\\}/.test("{12}");' },
  { id: 'regex-flags-v-d', untraced: 'passes', body: 'const set = /[\\p{L}--[a]]/v.test("b");\nconst indexed = /b/d.test("b");' },
  { id: 'regex-named-groups', untraced: 'passes', body: 'const year = "2026".match(/(?<year>\\d{4})/).groups;' },
  { id: 'regex-modifiers', languages: JS, body: 'const loose = /(?i:a)b/.test("Ab");' },
  { id: 'regex-duplicate-groups', languages: JS, body: 'const either = /(?<d>1)|(?<d>2)/.test("2");' },
  { id: 'template-braces', untraced: 'passes', body: 'const text = `{${n}} }{ ${`inner {${n + 1}}`}`;' },
  { id: 'division-not-regex', untraced: 'passes', body: 'const ratio = n / 2 / 1;' },
  { id: 'generators', untraced: 'passes', top: 'function* count() { yield 1; }\nasync function* later() { yield 1; }' },
  { id: 'catch-without-binding', untraced: 'passes', body: 'try { JSON.stringify(n); } catch { }' },
  { id: 'new-target', untraced: 'passes', top: 'function Made() { if (!new.target) return; }' },
  { id: 'unicode-names', untraced: 'passes', body: 'const café = 1;\nconst π = 3;' },
  { id: 'broken-jsdoc', untraced: 'passes', top: '/** @param {Array<{value: number} list */\nfunction documented(list) { return list; }' },
  { id: 'syntax-error-caught-at-runtime', untraced: 'passes', body: 'try { JSON.parse("{"); } catch (error) { }' },
  { id: 'export-declaration', languages: JS, untraced: 'passes', top: 'export const exported = 1;' },
  // Newer syntax and forms where the engine, the language or the untraced
  // route decides; traced must give that same answer or refuse.
  { id: 'top-level-await', top: 'await Promise.resolve(1);', traced: 'either' },
  { id: 'top-level-return-value', top: 'if (typeof undefined !== "undefined") return 1;', traced: 'either' },
  { id: 'using-declaration', top: 'function scoped() { using resource = null; }', traced: 'either' },
  { id: 'class-decorator', top: 'function mark(value) { }\n@mark\nclass Marked { }', traced: 'either' },
  { id: 'auto-accessor', top: 'class Auto { accessor value = 1; }', traced: 'either' },
  { id: 'hashbang', edit: (code) => `#!/usr/bin/env node\n${code}`, traced: 'either' },
  { id: 'html-comment', top: '<!-- an old-style comment', traced: 'either' },
  { id: 'octal-literal', body: 'const mode = 010;', traced: 'either' },
  { id: 'with-statement', body: 'with ({ m: 1 }) { }', traced: 'either' },
  // Names the two untraced routes treat differently: the SES route binds none
  // of these, the disposable-worker runner binds all of them.
  { id: 'top-level-window', top: 'const window = [];', traced: 'either' },
  { id: 'top-level-worker-class', top: 'class Worker { }', traced: 'either' },
  { id: 'top-level-process', top: 'function process() { }', traced: 'either' },
  { id: 'top-level-console', top: 'let console = { log() { } };', traced: 'either' },
  { id: 'ses-restricted-tagged-template', top: 'const raw = String.raw`import(x)`;', traced: 'either' },
];

const typeScriptOnly: readonly TraceCompileCase[] = [
  { id: 'ts-enum', top: 'enum Color { Red, Green }\nconst enum Size { S = 1 }', body: 'const color = Color.Green + Size.S;' },
  { id: 'ts-namespace', top: 'namespace Tools { export const one = 1; }', body: 'const one = Tools.one;' },
  { id: 'ts-satisfies', body: 'const config = { a: 1 } satisfies Record<string, number>;' },
  { id: 'ts-parameter-properties', top: 'class Pair { constructor(public left: number, private right = 2) { } }', body: 'const pair = new Pair(n);' },
  { id: 'ts-parameter-properties-derived', top: 'class Base { constructor(public a: number) { } }\nclass Child extends Base { constructor(public b: number) { super(1); } }', body: 'const child = new Child(n);' },
  { id: 'ts-generic-arrow', top: 'const identity = <T,>(value: T): T => value;\nconst first = <T extends object>(value: T) => value;', body: 'const same = identity<number>(n);' },
  { id: 'ts-assertions', body: 'const a = n as unknown as number;\nconst b = <number>a;\nconst c = [a]!;' },
  { id: 'ts-overloads', top: 'function pick(value: number): number;\nfunction pick(value: string): string;\nfunction pick(value: any) { return value; }' },
  { id: 'ts-abstract', top: 'abstract class Shape { abstract area(): number; }' },
  { id: 'ts-types', top: 'type Pairs = [number, string?];\ninterface Named { name: string }\nconst isNamed = (value: any): value is Named => !!value;' },
].map((testCase) => ({ ...testCase, languages: TS, untraced: 'passes' as const }));

// Valid programs a traced step cannot build: a traced Run refuses them and
// never reports its own verdict on whether they compile.
const tracedBuildFails: readonly TraceCompileCase[] = [
  { id: 'labeled-for-let', body: 'let total = 0;\nouter: for (let i = 0; i < 2; i++) {\n  for (let j = 0; j < 2; j++) {\n    if (j) continue outer;\n    total += 1;\n  }\n}' },
  { id: 'helper-name-collision', top: 'const __traceReadIndex = 1;' },
  { id: 'recorder-name-collision', top: 'const __traceRecorder = 1;' },
  { id: 'destructuring-member-default', body: 'const o = {};\n[o.x = 5] = [];' },
  { id: 'for-of-member-target', body: 'const o = {};\nfor (o.x of [1, 2]) { }' },
  { id: 'await-in-index', top: 'async function fill() {\n  const g = [[0]];\n  g[0][await Promise.resolve(0)] = 7;\n}' },
].map((testCase) => ({ ...testCase, untraced: 'passes' as const, traced: 'refused' as const }));

export const traceCompileCases: readonly TraceCompileCase[] = [
  ...invalid,
  ...modernSyntax,
  ...typeScriptOnly,
  ...tracedBuildFails,
];

export interface TraceCompileProgram {
  code: string;
  functionName: string | null;
  executionStyle: 'function' | 'solution-method' | 'ops-class';
  cases: Array<{ id: string; input: Record<string, unknown>; expected: unknown }>;
}

export function buildTraceCompileProgram(
  testCase: Pick<TraceCompileCase, 'top' | 'body' | 'member' | 'edit'>,
  language: TraceCompileLanguage,
  style: TraceCompileStyle
): TraceCompileProgram {
  const indent = (text: string, depth: number) =>
    text.split('\n').map((line) => ' '.repeat(depth) + line).join('\n');
  const signature = language === 'typescript' ? 'solve(n: number): number' : 'solve(n)';
  // A template literal body must not be re-indented, so only the solution's
  // own lines are.
  const solve = (keyword: string, depth: number) => [
    indent(`${keyword}${signature} {`, depth),
    ...(testCase.body ? [testCase.body] : []),
    indent('  return n * 2;', depth),
    indent('}', depth),
  ].join('\n');

  const className = style === 'solution-method' ? 'Solution' : style === 'ops-class' ? 'Doubler' : null;
  const lines = testCase.top ? [testCase.top] : [];
  if (className) {
    lines.push(`class ${className} {`, ...(testCase.member ? [testCase.member] : []), solve('', 2), '}');
  } else {
    if (testCase.member) lines.push('class Members {', testCase.member, '}');
    lines.push(solve('function ', 0));
    // Script programs leave their answer in `result`.
    if (style === 'script') lines.push('if (true) {', '  result = solve(2);', '}');
  }
  const source = lines.join('\n');

  return {
    code: testCase.edit ? testCase.edit(source) : source,
    functionName: style === 'script' ? null : style === 'ops-class' ? 'Doubler' : 'solve',
    executionStyle: style === 'script' ? 'function' : style,
    cases: [1, 2, 3].map((n) => ({
      id: String(n),
      input: style === 'script' ? {} : style === 'ops-class'
        ? { operations: ['Doubler', 'solve'], arguments: [[], [n]] }
        : { n },
      expected: style === 'script' ? 4 : style === 'ops-class' ? [null, n * 2] : n * 2,
    })),
  };
}
