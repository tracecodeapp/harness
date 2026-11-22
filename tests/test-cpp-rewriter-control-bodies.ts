#!/usr/bin/env npx tsx
/**
 * The C++ tracing rewriter keeps the learner's control flow for every form of
 * control body: braceless bodies on the header's line or the next one, `else`
 * and `else if` chains on one line, dangling `else`, bodies that are loops,
 * jumps or macro calls, and comments or literals that contain `;`, `else`,
 * `{` or `}`. Programs it cannot instrument without changing their behavior
 * are refused (CppTraceUnsupportedError), never rewritten into a different
 * program.
 *
 * Each form is checked three ways, without a compiler:
 * - the normalized source (braces added by the tokenizer pass) computes the
 *   same values as the original when run as JavaScript: the forms are written
 *   in the subset where C++ and JavaScript control flow coincide, including
 *   dangling-else binding;
 * - the instrumented output has no braceless control body left, so no inserted
 *   statement can become a body;
 * - every learner statement sits under the same chain of control headers, on
 *   the same `#line`, as in the source, and the formerly untraced forms now get
 *   a setCurrentLine for their own line inside their own block.
 */

import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sharedKernelPolicySource = (await readFile('workers/shared/runtime-kernel-policy.js', 'utf8'))
  .replace(/\bexport\s+/g, '');
const workerSource = (await readFile('workers/cpp/cpp-worker.js', 'utf8')).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
  ''
);
const sandbox: Record<string, unknown> = {
  console, TextEncoder, TextDecoder, URL, WebAssembly, Date, performance, Uint8Array, BigInt,
  Map, Set, Error, JSON, Object, String, Number, Math, RegExp, Promise, postMessage() {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.runInContext(
  `${sharedKernelPolicySource}
const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;
const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;
const isRuntimeProcPath = isRuntimeKernelProcPath;
${workerSource}
globalThis.__rewriter = {
  buildBatchDriverSource,
  buildPreparedOpsClassDriverSource,
  instrumentCppSourceForTracing,
  normalizeCppUserSource,
  normalize: typeof normalizeCppControlBodiesForTracing === 'function' ? normalizeCppControlBodiesForTracing : null,
};`,
  vm.createContext(sandbox),
  { filename: 'cpp-worker.js' }
);
const rewriter = sandbox.__rewriter as {
  buildBatchDriverSource: (source: string, functionName: string, inputs: unknown[], options: Record<string, unknown>) => string;
  buildPreparedOpsClassDriverSource: (source: string, className: string, options: Record<string, unknown>) => string;
  instrumentCppSourceForTracing: (source: string, functionName: string) => string;
  normalizeCppUserSource: (source: string, options?: Record<string, unknown>) => string;
  normalize: null | ((source: string) => { lines: string[]; lineNumbers: number[] });
};

// ---------------------------------------------------------------------------
// A tokenizer of this test's own (independent of the one under test).

interface Token {
  readonly text: string;
  readonly start: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|R"([^(]*)\([\s\S]*?\)\1"|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|^[ \t]*#[^\n]*|[A-Za-z_]\w*|\d[\w.']*|::|\S/gm;
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    if (text.startsWith('//') || text.startsWith('/*') || /^[ \t]*#/.test(text)) continue;
    tokens.push({ text, start: match.index! });
  }
  return tokens;
}

function matchBrackets(tokens: readonly Token[], lenient = false): number[] {
  const match = new Array<number>(tokens.length).fill(-1);
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    if (token.text === '(' || token.text === '[' || token.text === '{') stack.push(index);
    if (token.text === ')' || token.text === ']' || token.text === '}') {
      const open = stack.pop();
      if (open === undefined) {
        if (lenient) return;
        throw new Error(`unbalanced ${token.text}`);
      }
      match[open] = index;
      match[index] = open;
    }
  });
  if (stack.length && !lenient) throw new Error('unbalanced brackets');
  return match;
}

const squash = (text: string) => text.replace(/\s+/g, '');
const isControlLabel = (label: string) =>
  /^(?:elseif|if|else|for|while|do|switch)(?!\w)/.test(label) && !label.includes('tracecode');

// The control headers that open each block enclosing `offset`, outermost
// first, as written before the block's `{` (`if (c)`, `else if (c)`, `else`,
// `for (...)`, `while (...)`, `do`).
function controlPath(tokens: readonly Token[], offset: number): string[] {
  const stack: string[] = [];
  let boundary = 0;
  let parens = 0;
  for (let index = 0; index < tokens.length && tokens[index].start < offset; index += 1) {
    const { text } = tokens[index];
    if (text === '(') parens += 1;
    else if (text === ')') parens -= 1;
    else if (parens > 0) continue;
    if (text === '{') {
      stack.push(squash(tokens.slice(boundary, index).map((token) => token.text).join(' ')));
      boundary = index + 1;
    } else if (text === '}') {
      stack.pop();
      boundary = index + 1;
    } else if (text === ';') {
      boundary = index + 1;
    }
  }
  return stack.filter(isControlLabel);
}

// Every if/for/while/switch/else/do body in `source` is a braced block.
function bracelessBodies(source: string): string[] {
  const tokens = tokenize(source);
  const match = matchBrackets(tokens, true);
  const problems: string[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1]?.text;
    if (token.text === 'else') {
      if (next !== '{' && next !== 'if') problems.push(`else followed by ${next}`);
      return;
    }
    if (token.text === 'do') {
      if (next !== '{') problems.push(`do followed by ${next}`);
      return;
    }
    if (!['if', 'for', 'while', 'switch'].includes(token.text)) return;
    let open = index + 1;
    if (tokens[open]?.text === 'constexpr') open += 1;
    if (tokens[open]?.text !== '(') return;
    const close = match[open];
    const after = tokens[close + 1]?.text;
    const doTail = token.text === 'while' && tokens[index - 1]?.text === '}' && after === ';';
    if (after !== '{' && !doTail) {
      problems.push(`${tokens.slice(index, close + 1).map((entry) => entry.text).join(' ')} followed by ${after}`);
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------

interface Expectation {
  /** Text of the learner statement in the instrumented output (unique). */
  readonly needle: string;
  /** Control headers around it, outermost first (whitespace-insensitive). */
  readonly path: readonly string[];
  /** Text that locates its line in the source, when the output rewrites it. */
  readonly sourceNeedle?: string;
  /** It must get a setCurrentLine for its own line inside its own block. */
  readonly traced?: boolean;
}

interface Form {
  readonly name: string;
  readonly body: string;
  readonly expect: readonly Expectation[];
  /** Run the original and normalized body as JavaScript and compare (default true). */
  readonly js?: boolean;
  readonly prelude?: string;
}

const CLASS_PRELUDE = [
  '#include <string>',
  'using namespace std;',
  '#define BUMP(x) ((x) += 1)',
  '#define SWAP_DO(x, y) do { int tmp = (x); (x) = (y); (y) = tmp; } while (0)',
];

function programFor(form: Form): { source: string; bodyStartLine: number } {
  const head = [
    ...CLASS_PRELUDE,
    ...(form.prelude ? [form.prelude] : []),
    'class Solution {',
    'public:',
    '  int f(int a, int b, int t) {',
    '    int k = 0;',
    '    string s = "";',
  ];
  const tail = ['    return a * 10000 + b * 100 + k + (int)s.size();', '  }', '};', ''];
  return { source: [...head, form.body, ...tail].join('\n'), bodyStartLine: head.length + 1 };
}

const FORMS: Form[] = [
  {
    name: 'one-line if/else',
    body: '    if (a < t) a += 3; else b += 5;',
    expect: [
      { needle: 'a += 3;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 5;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'the app repro: one-line if/else in a binary-search loop',
    body: [
      '    while (a <= b) {',
      '      int mid = a + (b - a) / 2;',
      '      if (mid == t) { k = mid; break; }',
      '      if (mid < t) a = mid + 1; else b = mid - 1;',
      '    }',
    ].join('\n'),
    js: false,
    expect: [
      { needle: 'a = mid + 1;', path: ['while (a <= b)', 'if (mid < t)'], traced: true },
      { needle: 'b = mid - 1;', path: ['while (a <= b)', 'else'], traced: true },
    ],
  },
  {
    name: 'one-line else-if chain',
    body: '    if (a < 0) k += 1; else if (b < 0) k += 2; else if (t > 1) k += 3; else k += 4;',
    expect: [
      { needle: 'k += 1;', path: ['if (a < 0)'], traced: true },
      { needle: 'k += 2;', path: ['else if (b < 0)'], traced: true },
      { needle: 'k += 3;', path: ['else if (t > 1)'], traced: true },
      { needle: 'k += 4;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless else body on the next line',
    body: ['    if (a > t) {', '      a -= 1;', '    } else', '      b += 7;', '    k += 100;'].join('\n'),
    expect: [
      { needle: 'a -= 1;', path: ['if (a > t)'] },
      { needle: 'b += 7;', path: ['else'], traced: true },
      { needle: 'k += 100;', path: [] },
    ],
  },
  {
    name: 'braceless then body on the next line, then a braceless else',
    body: ['    if (a < t)', '      a += 3;', '    else', '      b += 5;', '    k += 9;'].join('\n'),
    expect: [
      { needle: 'a += 3;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 5;', path: ['else'], traced: true },
      { needle: 'k += 9;', path: [] },
    ],
  },
  {
    name: 'braceless if nested in a braceless else',
    body: ['    if (a > 1) k += 1;', '    else', '      if (b > 1) k += 2;', '      else k += 4;', '    k += 8;'].join('\n'),
    expect: [
      { needle: 'k += 1;', path: ['if (a > 1)'], traced: true },
      { needle: 'k += 2;', path: ['else', 'if (b > 1)'], traced: true },
      { needle: 'k += 4;', path: ['else', 'else'], traced: true },
      { needle: 'k += 8;', path: [] },
    ],
  },
  {
    name: 'dangling else on one line',
    body: '    if (a > 0) if (b > 0) k += 1; else k += 2;',
    expect: [
      { needle: 'k += 1;', path: ['if (a > 0)', 'if (b > 0)'], traced: true },
      { needle: 'k += 2;', path: ['if (a > 0)', 'else'], traced: true },
    ],
  },
  {
    name: 'dangling else across lines',
    body: ['    if (a > 0)', '      if (b > 0) k += 10;', '      else k += 20;', '    else k += 40;'].join('\n'),
    expect: [
      { needle: 'k += 10;', path: ['if (a > 0)', 'if (b > 0)'], traced: true },
      { needle: 'k += 20;', path: ['if (a > 0)', 'else'], traced: true },
      { needle: 'k += 40;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless for body under if/else',
    body: '    if (a < t) for (k = 0; k < 3; k++) b += 2; else b += 50;',
    expect: [
      { needle: 'b += 2;', path: ['if (a < t)', 'for (k = 0; k < 3; k++)'], traced: true },
      { needle: 'b += 50;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless while body under if/else',
    body: ['    if (a < t)', '      while (k < 4) k += 1;', '    else', '      k -= 1;'].join('\n'),
    expect: [
      { needle: 'k += 1;', path: ['if (a < t)', 'while (k < 4)'], traced: true },
      { needle: 'k -= 1;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless do-while body under if/else',
    body: '    if (a < t) do k += 2; while (k < 5); else k -= 3;',
    expect: [
      { needle: 'k += 2;', path: ['if (a < t)', 'do'], traced: true },
      { needle: 'k -= 3;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless return bodies',
    body: '    if (a > t) return 707; else if (b > t) return 808; else k += 1;',
    expect: [
      { needle: '(707)', sourceNeedle: 'return 707;', path: ['if (a > t)'] },
      { needle: '(808)', sourceNeedle: 'return 808;', path: ['else if (b > t)'] },
      { needle: 'k += 1;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braceless break and continue in a one-line braced loop body',
    body: '    while (b < 6) { b += 1; if (b == t + 3) break; else if (b % 2) continue; else k += b; }',
    expect: [
      { needle: 'b += 1;', path: ['while (b < 6)'] },
      { needle: 'break;', path: ['while (b < 6)', 'if (b == t + 3)'], traced: true },
      { needle: 'continue;', path: ['while (b < 6)', 'else if (b % 2)'], traced: true },
      { needle: 'k += b;', path: ['while (b < 6)', 'else'], traced: true },
    ],
  },
  {
    name: 'braceless if/else as a braceless loop body on the next lines',
    body: ['    while (a < 3)', '      if (a++ == t) break;', '      else continue;', '    k += 1;'].join('\n'),
    expect: [
      { needle: 'break;', path: ['while (a < 3)', 'if (a++ == t)'], traced: true },
      { needle: 'continue;', path: ['while (a < 3)', 'else'], traced: true },
      { needle: 'k += 1;', path: [] },
    ],
  },
  {
    name: 'macro-call bodies',
    body: '    if (a < t) BUMP(a); else BUMP(b);\n    if (k == 0) SWAP_DO(a, b); else k += 1;',
    js: false,
    expect: [
      { needle: 'BUMP(a);', path: ['if (a < t)'], traced: true },
      { needle: 'BUMP(b);', path: ['else'], traced: true },
      { needle: 'SWAP_DO(a, b);', path: ['if (k == 0)'], traced: true },
      { needle: 'k += 1;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'comments and string literals holding ; else { }',
    body: `    if (a < t) s = "x; else { }"; /* ; } else { */ else s = '}'; // else { ;`,
    expect: [
      { needle: 's = "x; else { }";', path: ['if (a < t)'], traced: true },
      { needle: "s = '}';", path: ['else'], traced: true },
    ],
  },
  {
    name: 'comments holding braces between header, body and else',
    body: [
      '    if (a < t) // pick { the left ;',
      '      a += 11; /* } else { */',
      '    else // else {',
      '      b += 13; // }',
      '    k += 2;',
    ].join('\n'),
    expect: [
      { needle: 'a += 11;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 13;', path: ['else'], traced: true },
      { needle: 'k += 2;', path: [] },
    ],
  },
  {
    name: 'character literals holding ; and {',
    body: "    if (a == t) s += ';'; else s += '{';",
    expect: [
      { needle: "s += ';';", path: ['if (a == t)'], traced: true },
      { needle: "s += '{';", path: ['else'], traced: true },
    ],
  },
  {
    name: 'raw string literal holding ; else { }',
    body: '    if (a < t) s = R"(; else { })"; else s = "y";',
    js: false,
    expect: [
      { needle: 's = R"(; else { })";', path: ['if (a < t)'], traced: true },
      { needle: 's = "y";', path: ['else'], traced: true },
    ],
  },
  {
    name: 'one-line do-while (was untraced)',
    body: '    do k += 1; while (k < t);',
    expect: [{ needle: 'k += 1;', path: ['do'], traced: true }],
  },
  {
    name: 'then-line of if/else with a braced else (was untraced)',
    body: ['    if (a < t) a += 21; else {', '      b += 22;', '    }'].join('\n'),
    expect: [
      { needle: 'a += 21;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 22;', path: ['else'], traced: true },
    ],
  },
  {
    name: 'braced one-line if/else returning in both branches',
    body: '    if (a > t) { return 909; } else { return 910; }',
    expect: [
      { needle: '(909)', sourceNeedle: 'return 909;', path: ['if (a > t)'] },
      { needle: '(910)', sourceNeedle: 'return 910;', path: ['else'] },
    ],
  },
  {
    name: 'braceless header with a multi-line condition',
    body: ['    if (a < t &&', '        b < t)', '      k += 5;', '    else', '      k += 6;'].join('\n'),
    expect: [
      { needle: 'k += 5;', path: ['if (a < t && b < t)'], traced: true },
      { needle: 'k += 6;', path: ['else'], traced: true },
    ],
  },
  {
    // Was broken: post-line snapshots went between the header and its `{`.
    name: 'Allman braces on if, else and do',
    body: [
      '    if (a < t)',
      '    {',
      '      a += 31;',
      '    }',
      '    else',
      '    {',
      '      b += 32;',
      '    }',
      '    if (b > t)',
      '    {',
      '      k += 33;',
      '    }',
      '    do',
      '    {',
      '      k += 34;',
      '    } while (k < t);',
    ].join('\n'),
    expect: [
      { needle: 'a += 31;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 32;', path: ['else'], traced: true },
      { needle: 'k += 33;', path: ['if (b > t)'], traced: true },
      { needle: 'k += 34;', path: ['do'], traced: true },
    ],
  },
  {
    name: 'one-line braceless if, for and while (already handled; still one rewriter line)',
    body: ['    if (a < t) a += 41;', '    for (k = 0; k < 2; k++) b += 42;', '    while (k < 5) k += 1;'].join('\n'),
    expect: [
      { needle: 'a += 41;', path: ['if (a < t)'], traced: true },
      { needle: 'b += 42;', path: ['for (k = 0; k < 2; k++)'], traced: true },
      { needle: 'k += 1;', path: ['while (k < 5)'], traced: true },
    ],
  },
  {
    name: 'two statements and a control statement on one line',
    body: '    a += 1; if (a > t) b += 51; else b += 52; k += 53;',
    expect: [
      { needle: 'b += 51;', path: ['if (a > t)'], traced: true },
      { needle: 'b += 52;', path: ['else'], traced: true },
      { needle: 'k += 53;', path: [] },
    ],
  },
];

const JS_INPUTS: Array<[number, number, number]> = [];
for (const a of [-1, 0, 1, 2, 4]) for (const b of [-1, 0, 2, 5]) for (const t of [0, 1, 3]) JS_INPUTS.push([a, b, t]);

function runJs(body: string): string[] {
  // eslint-disable-next-line no-new-func
  const fn = new Function('a', 'b', 't', `let k = 0; let s = "";\n${body}\nreturn JSON.stringify([a, b, k, s]);`) as (
    a: number,
    b: number,
    t: number
  ) => unknown;
  return JS_INPUTS.map(([a, b, t]) => JSON.stringify(fn(a, b, t)));
}

function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`source has no ${needle}`);
  return source.slice(0, index).split('\n').length;
}

function checkForm(form: Form): string[] {
  const failures: string[] = [];
  const { source, bodyStartLine } = programFor(form);
  const bodyLineCount = form.body.split('\n').length;

  if (form.js !== false) {
    if (!rewriter.normalize) {
      failures.push('no control-body normalization pass');
    } else {
      const normalized = rewriter.normalize(source);
      const normalizedBody = normalized.lines
        .filter((_line, index) => {
          const lineNumber = normalized.lineNumbers[index];
          return lineNumber >= bodyStartLine && lineNumber < bodyStartLine + bodyLineCount;
        })
        .join('\n');
      const before = runJs(form.body);
      const after = runJs(normalizedBody);
      const differing = before.findIndex((value, index) => value !== after[index]);
      if (differing >= 0) {
        failures.push(
          `normalized source computes ${after[differing]} instead of ${before[differing]} for (a, b, t) = (${JS_INPUTS[differing]}):\n${normalizedBody}`
        );
      }
    }
  }

  let instrumented: string;
  try {
    instrumented = rewriter.instrumentCppSourceForTracing(rewriter.normalizeCppUserSource(source, { tracing: true }), 'f');
  } catch (error) {
    return [...failures, `instrumentation threw: ${error instanceof Error ? error.message : String(error)}`];
  }
  const cleaned = instrumented.replace(
    /tracecode::with_trace_line\(\d+, \[&\]\(\) \{ return static_cast<bool>\(([\s\S]*?)\); \}\)/g,
    '$1'
  );
  const functionStart = cleaned.indexOf('int f(');
  const functionOutput = cleaned.slice(functionStart);
  let tokens: Token[];
  try {
    tokens = tokenize(cleaned);
    matchBrackets(tokens);
  } catch (error) {
    return [...failures, `instrumented output brackets: ${error instanceof Error ? error.message : String(error)}`];
  }
  for (const problem of bracelessBodies(functionOutput)) {
    failures.push(`braceless body in instrumented output: ${problem}`);
  }
  for (const expectation of form.expect) {
    const occurrences = functionOutput.split(expectation.needle).length - 1;
    if (occurrences !== 1) {
      failures.push(`${expectation.needle} occurs ${occurrences} times in the instrumented function`);
      continue;
    }
    const offset = functionStart + functionOutput.indexOf(expectation.needle);
    const path = controlPath(tokens, offset);
    const expectedPath = expectation.path.map(squash);
    if (JSON.stringify(path) !== JSON.stringify(expectedPath)) {
      failures.push(`${expectation.needle} is under [${path.join(' > ')}], expected [${expectedPath.join(' > ')}]`);
    }
    const sourceLine = lineOf(source, expectation.sourceNeedle ?? expectation.needle);
    const lineDirectives = [...cleaned.slice(0, offset).matchAll(/#line (\d+) "solution\.cpp"/g)];
    const mappedLine = Number(lineDirectives.at(-1)?.[1]);
    if (mappedLine !== sourceLine) {
      failures.push(`${expectation.needle} compiles under #line ${mappedLine}, expected ${sourceLine}`);
    }
    if (expectation.traced) {
      const marker = `tracecode::TraceHooks::setCurrentLine(${sourceLine});`;
      const markerOffset = cleaned.lastIndexOf(marker, offset);
      if (
        markerOffset < functionStart ||
        JSON.stringify(controlPath(tokens, markerOffset)) !== JSON.stringify(path) ||
        /[{}]/.test(cleaned.slice(markerOffset + marker.length, offset).replace(/if \(tracecode::[^\n]*\n/g, ''))
      ) {
        failures.push(`${expectation.needle} has no ${marker} in its own block`);
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Refused programs, and macro uses that stay traced.

function instrumentBody(prelude: string, body: string): string {
  const { source } = programFor({ name: 'macro', body, prelude, expect: [] });
  return rewriter.instrumentCppSourceForTracing(rewriter.normalizeCppUserSource(source, { tracing: true }), 'f');
}

const REFUSED: Array<{ name: string; prelude: string; body: string }> = [
  {
    name: 'a multi-statement macro as a braceless body',
    prelude: '#define TWICE(x) x; x',
    body: '    if (a < t) TWICE(k++); else b += 1;',
  },
  {
    name: 'a loop-header macro whose braceless body is on the next line',
    prelude: '#define REP(i, n) for (int i = 0; i < (n); i++)',
    body: '    REP(i, 3)\n      k += i;',
  },
  {
    name: 'a preprocessor conditional as a braceless body',
    prelude: '',
    body: ['    if (a < t)', '#ifdef NEVER_DEFINED', '      a += 1;', '#else', '      b += 1;', '#endif'].join('\n'),
  },
];

const ACCEPTED_MACROS: Array<{ name: string; prelude: string; body: string; keeps: string }> = [
  {
    name: 'a loop-header macro with its body on the same line',
    prelude: '#define REP(i, n) for (int i = 0; i < (n); i++)',
    body: '    REP(i, 3) k += i;',
    keeps: 'REP(i, 3) k += i;',
  },
  {
    name: 'a loop-header macro with a braced body',
    prelude: '#define REP(i, n) for (int i = 0; i < (n); i++)',
    body: '    REP(i, 3) {\n      k += i;\n    }',
    keeps: 'REP(i, 3) {',
  },
  {
    name: 'a multi-statement macro used as a plain statement',
    prelude: '#define TWICE(x) x; x',
    body: '    TWICE(k++);',
    keeps: 'TWICE(k++);',
  },
];

const results: Array<{ name: string; failures: string[] }> = [];
for (const form of FORMS) results.push({ name: form.name, failures: checkForm(form) });
for (const refused of REFUSED) {
  const failures: string[] = [];
  try {
    instrumentBody(refused.prelude, refused.body);
    failures.push('instrumented instead of refused');
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name !== 'CppTraceUnsupportedError') failures.push(`threw ${name}: ${message}`);
    else if (!/without changing its behavior \(line \d+:/.test(message)) failures.push(`message: ${message}`);
  }
  results.push({ name: `refused: ${refused.name}`, failures });
}
for (const accepted of ACCEPTED_MACROS) {
  const failures: string[] = [];
  try {
    const output = instrumentBody(accepted.prelude, accepted.body);
    if (!output.split('\n').some((line) => line.trim() === accepted.keeps)) failures.push(`output lost "${accepted.keeps}" as one line`);
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  results.push({ name: `traced: ${accepted.name}`, failures });
}

// Condition wrapping: `if (init; cond)` keeps its init-statement outside the
// traced expression, and a condition that declares a variable is not wrapped
// as an expression (both were compile errors blamed on the learner).
{
  const failures: string[] = [];
  const output = instrumentBody('', [
    '    if (int m = a + b; m > t) {',
    '      k += m;',
    '    }',
    '    while (int* p = nullptr) {',
    '      k += *p;',
    '    }',
  ].join('\n'));
  if (!output.includes('if (int m = a + b; tracecode::with_trace_line(')) failures.push('init-statement not kept before the traced condition');
  if (/static_cast<bool>\((?:int|auto)\b/.test(output)) failures.push('a declaration was wrapped as an expression');
  results.push({ name: 'condition wrapping: if-init statement and declaration condition', failures });
}

// A refusal reaches the worker's request handler as CppTraceUnsupportedError
// through every driver builder (the prepared ops-class builder used to swallow
// instrumentation errors and fall back to an untraced driver).
{
  const failures: string[] = [];
  const refusedSource = programFor({
    name: 'refused',
    prelude: '#define TWICE(x) x; x',
    body: '    if (a < t) TWICE(k++); else b += 1;',
    expect: [],
  }).source;
  const opsSource = [
    '#define TWICE(x) x; x',
    'class Counter {',
    '  int k = 0;',
    'public:',
    '  Counter() {}',
    '  int bump(int a) {',
    '    if (a > 0) TWICE(k++); else k--;',
    '    return k;',
    '  }',
    '};',
  ].join('\n');
  const builders: Array<[string, () => string]> = [
    ['buildBatchDriverSource', () => rewriter.buildBatchDriverSource(refusedSource, 'f', [{}], { tracing: true })],
    ['buildPreparedOpsClassDriverSource', () => rewriter.buildPreparedOpsClassDriverSource(opsSource, 'Counter', { tracing: true, executionStyle: 'ops-class' })],
  ];
  for (const [name, build] of builders) {
    try {
      build();
      failures.push(`${name} built a traced driver`);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CppTraceUnsupportedError') failures.push(`${name} threw ${String(error)}`);
    }
  }
  try {
    rewriter.buildBatchDriverSource(refusedSource, 'f', [{}], {});
  } catch (error) {
    failures.push(`the untraced driver was refused too: ${String(error)}`);
  }
  results.push({ name: 'refusal propagates out of the traced driver builders only', failures });
}

const failed = results.filter((result) => result.failures.length > 0);
for (const result of results) {
  console.log(`${result.failures.length ? 'FAIL' : 'ok  '} ${result.name}`);
  for (const failure of result.failures) console.log(`       ${failure.replace(/\n/g, '\n       ')}`);
}
if (failed.length) {
  console.error(`FAIL: ${failed.length} of ${results.length} C++ control-body forms`);
  process.exit(1);
}
console.log(`PASS: C++ rewriter keeps control flow for ${results.length} control-body forms`);
