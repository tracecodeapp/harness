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
  /^(?:elseifconstexpr|ifconstexpr|elseif|if|else|for|while|do|switch)(?!\w)/.test(label) && !label.includes('tracecode');

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
      else if (tokens[match[index + 1] + 1]?.text !== 'while') {
        problems.push(`do block not followed by its while (by ${tokens[match[index + 1] + 1]?.text})`);
      }
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
  // Review finding 6: the tail on the line after the closing brace.
  {
    name: 'do-while with `while` on the line after `}`',
    body: ['    do {', '      k += 1;', '    }', '    while (k < t);', '    b += 61;'].join('\n'),
    expect: [
      { needle: 'k += 1;', path: ['do'], traced: true },
      { needle: 'b += 61;', path: [] },
    ],
  },
  // Review finding 7: `else if constexpr` with a braceless body, then `else`.
  {
    name: 'else if constexpr with braceless bodies',
    body: ['    if (a < t) k = 71;', '    else if constexpr (sizeof(int) == 4) k = 72;', '    else k = 73;'].join('\n'),
    js: false,
    expect: [
      { needle: 'k = 71;', path: ['if (a < t)'], traced: true },
      { needle: 'k = 72;', path: ['else if constexpr (sizeof(int) == 4)'], traced: true },
      { needle: 'k = 73;', path: ['else'], traced: true },
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
    body: '    if (a < t) TWICE(k++);',
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
  // Review findings: the forms below are rare and hard to instrument exactly.
  {
    name: 'an attributed block as a braceless body (finding 1)',
    prelude: '',
    body: ['    if (a == 99)', '      [[likely]] { ++k; }', '    k += 2;'].join('\n'),
  },
  {
    name: 'a multi-statement macro reached through an alias (finding 2)',
    prelude: '#define TWICE(x) x; x\n#define APPLY(x) TWICE(x)',
    body: '    if (a < t) APPLY(++k);',
  },
  {
    name: 'a multi-statement macro passed as a macro argument (finding 2)',
    prelude: '#define TWICE(x) x; x\n#define CALL(f, x) f(x)',
    body: '    if (a < t) CALL(TWICE, ++k);',
  },
  {
    name: 'an object-like macro naming a multi-statement macro (finding 2)',
    prelude: '#define TWICE(x) x; x\n#define T2 TWICE',
    body: '    if (a < t) T2(++k);',
  },
  {
    name: 'a line comment continued by a trailing backslash (finding 3)',
    prelude: '',
    body: ['    if (a < t) k = 1; // note \\', '    k = 5;'].join('\n'),
  },
  {
    name: 'a raw string literal spanning lines (finding 4)',
    prelude: '',
    body: ['    s = R"(a', 'b)";'].join('\n'),
  },
  {
    name: 'a #line directive in the learner source (finding 5)',
    prelude: '',
    body: ['#line 700', '    k = __LINE__;'].join('\n'),
  },
  {
    name: '__func__ (lambda wrapping would rename the function)',
    prelude: '',
    body: '    s = __func__;',
  },
  {
    name: 'a braceless switch body (finding 8)',
    prelude: '',
    body: ['    switch (t)', '      case 1: k = 7;'].join('\n'),
  },
  {
    name: 'macros that hide braces',
    prelude: '#define BEGIN {\n#define END }',
    body: '    if (a < t) BEGIN k = 1; END',
  },
  {
    name: 'a control statement the tracer cannot delimit (safety net)',
    prelude: '#define REP(i, n) for (int i = 0; i < (n); i++)',
    body: '    if (a < t) REP(i, 2) if (i) k += i;',
  },
  // Round 3, C: macro classification by tokens, every definition counts.
  {
    name: 'two do-while(0) statements in one macro as a braceless body',
    prelude: '#define TWO do { ++k; } while (0); do { ++k; } while (0)',
    body: '    if (a < t) TWO;',
  },
  {
    name: 'a macro whose earlier definition is multi-statement (redefined after #undef)',
    prelude: '#define STEP(x) x; x\n#define USE_STEP(x) STEP(x)\n#undef STEP\n#define STEP(x) ((x) += 1)',
    body: '    if (a < t) STEP(k);',
  },
  // Round 3, D: directives.
  {
    name: 'a directive continued through its line comment',
    prelude: '#define X1 1 // note \\\n#define Y1 2',
    body: '    k = X1;',
  },
  {
    name: 'a multi-line function-like macro',
    prelude: '#define ADD2(p, q) \\\n  ((p) + (q))',
    body: '    k = ADD2(a, b);',
  },
  {
    name: 'a #line directive hidden by a comment',
    prelude: '',
    body: ['#/**/line 700', '    k = __LINE__;'].join('\n'),
  },
  {
    name: '__func__ inside a macro body',
    prelude: '#define FN __func__',
    body: '    s = FN;',
  },
  // Round 3, E: an if-macro where it can capture a statement or an else.
  {
    name: 'an if-macro as a braceless body',
    prelude: '#define LOG_IF(c) if (c) k += 1000',
    body: '    if (a < t) LOG_IF(b > t);',
  },
  {
    name: 'an if-macro followed by else',
    prelude: '#define LOG_IF(c) if (c) k += 1000',
    body: '    LOG_IF(b > t); else k -= 1;',
  },
  // Round 4, item 3: a comment after `#` does not hide a definition.
  {
    name: 'a multi-statement macro defined with a comment after #',
    prelude: '#/**/define TWICE2(x) x; x',
    body: '    if (a < t) TWICE2(k++);',
  },
  {
    name: 'a macro that expands to else',
    prelude: '#define OTHERWISE else',
    body: '    if (a < t) k = 1; OTHERWISE k = 2;',
  },
];

const ACCEPTED_MACROS: Array<{ name: string; prelude: string; body: string; keeps: string; anywhere?: boolean }> = [
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
  {
    name: 'an expression macro reached through an alias as a braceless body',
    prelude: '#define INC(x) ((x) += 1)\n#define BUMP2(x) INC(x)',
    body: '    if (a < t) BUMP2(k);',
    keeps: ' BUMP2(k); ',
    anywhere: true,
  },
  {
    name: '__LINE__ (the same learner line in both builds)',
    prelude: '',
    body: '    k = __LINE__;',
    keeps: 'k = __LINE__;',
  },
  // Round 3, E and common macros: no blanket refusal.
  {
    name: 'an if-macro used standalone in a braced block',
    prelude: '#define LOG_IF(c) if (c) k += 1000',
    body: ['    {', '      LOG_IF(b > t);', '    }'].join('\n'),
    keeps: 'LOG_IF(b > t);',
  },
  {
    name: 'common competitive-programming macros (ll, all, F, REP)',
    prelude: '#define ll long long\n#define all(x) (x).begin(), (x).end()\n#define F first\n#define REP(i, n) for (int i = 0; i < (n); i++)',
    body: [
      '    vector<ll> v{3, 1, 2};',
      '    if (a < t) sort(all(v));',
      '    pair<int, int> p{a, b};',
      '    if (p.F > 0) k += p.F;',
      '    REP(i, 3) k += (int)v[i];',
      '    REP(i, 2) {',
      '      k += i;',
      '    }',
    ].join('\n'),
    keeps: 'REP(i, 2) {',
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
    else if ((error as { code?: unknown }).code !== 'trace-unavailable') failures.push('refusal has no trace-unavailable code');
  }
  results.push({ name: `refused: ${refused.name}`, failures });
}
for (const accepted of ACCEPTED_MACROS) {
  const failures: string[] = [];
  try {
    const output = instrumentBody(accepted.prelude, accepted.body);
    const kept = accepted.anywhere
      ? output.includes(accepted.keeps)
      : output.split('\n').some((line) => line.trim() === accepted.keeps);
    if (!kept) failures.push(`output lost "${accepted.keeps}"`);
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
    // Review finding 9: declarations with multi-word types, and a `for`
    // condition that declares.
    '    if (unsigned long n = a + 1) k += 1;',
    '    if (unsigned long long u = b) { k += 2; }',
    '    if (long double d = 0.5L * t) k += 3;',
    '    if (const auto& r = a) k += 4;',
    '    if (std::size_t z = t) k += 5;',
    '    if (std::string::size_type q = s.size()) k += 6;',
    '    if (int* p = &k) *p += 7;',
    '    for (int i = 0; int j = 2 - i; ++i) k += j;',
  ].join('\n'));
  if (!output.includes('if (int m = a + b; tracecode::with_trace_line(')) failures.push('init-statement not kept before the traced condition');
  const wrappedDeclaration = /static_cast<bool>\((?:int|auto|unsigned|long|const|std::)\b[^)]*?=/.exec(output);
  if (wrappedDeclaration) failures.push(`a declaration was wrapped as an expression: ${wrappedDeclaration[0]}`);
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
    body: '    if (a < t) TWICE(k++);',
    expect: [],
  }).source;
  const opsSource = [
    '#define TWICE(x) x; x',
    'class Counter {',
    '  int k = 0;',
    'public:',
    '  Counter() {}',
    '  int bump(int a) {',
    '    if (a > 0) TWICE(k++);',
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

// Round 3, B: instrumentation evaluates each learner expression once, and a
// read helper (trace_index_read_ref, trace_index_field_read_ref) never
// stands where the learner's expression is written through (a method call,
// an assignment, ++/--, a subscript, a reference binding, a range-for).
{
  const CONST_METHODS = new Set(['size', 'length', 'empty', 'count', 'contains', 'substr', 'compare', 'starts_with', 'ends_with', 'capacity']);
  const writesThroughReadHelper = (output: string): string[] => {
    const problems: string[] = [];
    for (const helper of output.matchAll(/tracecode::trace_index(?:_field)?_read(?:_ref)?\(/g)) {
      let depth = 0;
      let cursor = helper.index! + helper[0].length - 1;
      for (; cursor < output.length; cursor += 1) {
        if (output[cursor] === '(') depth += 1;
        else if (output[cursor] === ')' && --depth === 0) break;
      }
      const call = output.slice(helper.index!, cursor + 1);
      const after = output.slice(cursor + 1).trimStart();
      const before = output.slice(0, helper.index!).trimEnd();
      const method = /^\.\s*([A-Za-z_]\w*)\s*\(/.exec(after);
      if (
        (method && !CONST_METHODS.has(method[1])) ||
        /^(?:[+\-*/%&|^]?=(?!=)|<<=|>>=|\+\+|--|\[|->|\.\s*[A-Za-z_]\w*\s*(?:[+\-*/%&|^]?=(?!=)|\.|\[|\+\+|--))/.test(after) ||
        /(?:\+\+|--|&\s*[A-Za-z_]\w*\s*=|:)$/.test(before)
      ) {
        problems.push(`${call.slice(0, 90)} ${after.slice(0, 30)}`);
      }
    }
    return problems;
  };
  const prelude = '#include <array>\n#include <set>\n#include <vector>\nstruct QQ { int val; string name; vector<int> adj; set<int> seen; };\nstruct Counter { int n = 0; int size() { return ++n; } };\nint tick();';
  const cases: Array<{ name: string; body: string; once?: string; absent?: string; present?: string }> = [
    { name: 'std::array fill with a side-effecting argument', body: '    array<int, 3> ar{};\n    ar.fill(k++);', once: 'k++' },
    { name: 'indexed field read with a side-effecting index', body: '    vector<QQ> qs(3);\n    int i = 0;\n    k = qs[i++].val;', once: 'i++' },
    { name: 'indexed field update with a call as index', body: '    vector<QQ> qs(3);\n    qs[tick()].val += 1;', once: 'tick()' },
    { name: 'push_back on a vector<string> element', body: "    vector<string> names(3);\n    int i = 0;\n    names[i].push_back('a');" },
    { name: 'insert into a vector<set<int>> element', body: '    vector<set<int>> sets(3);\n    int i = 0;\n    sets[i].insert(4);' },
    { name: 'erase from a vector<set<int>> element', body: '    vector<set<int>> sets(3);\n    int i = 0;\n    sets[i].erase(4);' },
    { name: 'push_back on a struct field of an element', body: '    vector<QQ> qs(3);\n    int i = 0;\n    qs[i].adj.push_back(5);' },
    { name: 'assign a string field of an element', body: '    vector<QQ> qs(3);\n    int i = 0;\n    qs[i].name = "x";' },
    { name: 'assign an int field of an element', body: '    vector<QQ> qs(3);\n    int i = 0;\n    qs[i].val = 5;' },
    { name: 'subscript-assign a vector field of an element', body: '    vector<QQ> qs(3);\n    int i = 0;\n    qs[i].adj[0] = 7;' },
    { name: 'prefix increment of an element field', body: '    vector<QQ> qs(3);\n    int i = 0;\n    ++qs[i].val;' },
    { name: 'iterators of an element (reverse)', body: '    vector<string> names(3);\n    int i = 0;\n    reverse(names[i].begin(), names[i].end());' },
    { name: 'find compared with end on an element', body: '    vector<set<int>> sets(3);\n    int i = 0;\n    if (sets[i].find(2) != sets[i].end()) k = 1;' },
    { name: 'reference binding to an element', body: '    vector<QQ> qs(3);\n    int i = 0;\n    QQ& qr = qs[i];\n    qr.val = 3;' },
    { name: 'range-for over an element by reference', body: "    vector<string> names(3);\n    int i = 0;\n    for (char& c : names[i]) c = 'z';" },
    { name: 'assign through back() of an element', body: "    vector<string> names(3);\n    int i = 0;\n    names[i].back() = 'q';" },
    {
      name: 'an element passed to a lambda taking a non-const reference',
      body: '    array<int, 3> ar{};\n    auto inc = [](int& x) { x += 1; };\n    inc(ar[1]);',
      absent: 'inc(tracecode::',
    },
    {
      name: 'an element passed to a recursive lambda through self',
      body: [
        '    array<int, 3> ar{};',
        '    auto walk = [&](auto&& self, int& cell, int depth) -> void {',
        '      if (depth > 0) self(self, ar[0], depth - 1);',
        '      cell += 1;',
        '    };',
        '    walk(walk, ar[2], 2);',
      ].join('\n'),
      absent: 'self, tracecode::',
    },
    {
      // Round 4, item 2: a const reference parameter gets the element itself
      // (identity kept, no copy), with the read recorded beside it.
      name: 'an element passed by const reference is the element, with its read event',
      body: '    array<int, 3> ar{};\n    auto get = [](const int& x) { return x; };\n    k = get(ar[2]);',
      present: 'get(([&]() -> decltype(auto) { auto&& __tc_ref_index = (2); auto&& __tc_ref_element = __tracecode_element(ar[__tc_ref_index]); if (tracecode::trace_event_admissible(true,',
      absent: 'get(tracecode::trace_index_read',
    },
    {
      name: 'the same element twice at const reference parameters keeps its identity',
      body: '    array<int, 3> ar{};\n    auto same = [](const int& p, const int& q) { return &p == &q; };\n    k = same(ar[0], ar[0]);',
      absent: 'same(tracecode::trace_index_read',
      present: 'return (__tc_ref_element); }()), ([&]() -> decltype(auto) {',
    },
    {
      name: 'a row passed to a const vector reference in a loop is not copied',
      body: '    vector<vector<int>> grid(3, vector<int>(3, 1));\n    auto rowSum = [](const vector<int>& row) { return row[0]; };\n    for (int r = 0; r < 3; r++) k += rowSum(grid[r]);',
      absent: 'trace_index_read_ref(grid',
      present: '__tracecode_element(grid[__tc_ref_index])',
    },
    {
      name: 'a nested element at a reference parameter is the element',
      body: '    vector<vector<int>> g(2, vector<int>(2));\n    auto same = [](const int& p, const int& q) { return &p == &q; };\n    k = same(g[0][1], g[0][1]);',
      present: 'same(__tracecode_element(g[0])[1], __tracecode_element(g[0])[1])',
    },
    // Round 4, item 1: parentheses are transparent; a call that contains the
    // access is judged by its own context.
    {
      name: 'a parenthesized element written through',
      body: '    vector<string> names(3, "ab");\n    (names[0]).clear();',
      absent: 'trace_index_read_ref(names',
    },
    {
      name: 'std::get of an element written through',
      body: '    vector<tuple<vector<int>, int>> rows(2);\n    int i = 1;\n    std::get<0>(rows[i]).clear();',
      absent: 'trace_index_read_ref(rows',
    },
    {
      name: 'std::move of an element',
      body: '    vector<string> names(3, "ab");\n    string taken = std::move(names[1]);',
      absent: 'trace_index_read_ref(names',
    },
    {
      name: 'an element read inside a call stays traced',
      body: '    array<int, 3> ar{};\n    k = max(ar[1], 5) + (ar[2]);',
      present: 'max(tracecode::trace_index_read_ref(ar',
    },
    // Round 4: range-for over an element of a vector whose elements are not
    // vectors (blast-radius-analysis: `for (int nxt : graph[node])` with
    // `vector<set<int>> graph`) iterates the element itself;
    // indexed_nested_range_readable only takes a traced vector of vectors.
    {
      name: 'range-for over a vector<set<int>> element',
      body: '    vector<set<int>> graph(3);\n    int u = 1;\n    for (int nxt : graph[u]) k += nxt;',
      present: 'for (int nxt : __tracecode_element(graph[u]))',
    },
    {
      name: 'range-for by reference over a vector<string> element',
      body: "    vector<string> names(3, \"ab\");\n    int i = 0;\n    for (char& c : names[i]) c = 'z';",
      present: 'for (char& c : __tracecode_element(names[i]))',
    },
    {
      name: 'range-for over a row of a const vector-of-vectors parameter... is read as the element',
      body: '    const vector<vector<int>>& g = vector<vector<int>>(2, vector<int>(2, 1));\n    for (int nb : g[1]) k += nb;',
      absent: 'indexed_nested_range_readable(g',
    },
    {
      name: 'range-for over a vector-of-vectors row stays traced',
      body: '    vector<vector<int>> graph(3);\n    int u = 1;\n    for (int nb : graph[u]) k += nb;',
      present: 'tracecode::indexed_nested_range_readable(graph, "graph", u',
    },
    // Round 5: brace- and paren-initialized references, the const-method
    // allowlist, grouping parentheses at reference parameters, braced
    // push_back arguments.
    {
      name: 'a reference initialized with braces or parentheses binds the element',
      // A reference to const binds the read helper's const reference to the
      // element (round 6); a non-const one binds the element directly.
      body: '    array<int, 3> ar{};\n    const int& first{ar[0]};\n    const auto& second(ar[1]);\n    vector<pair<int, int>> ps(2);\n    auto& [p, q]{ps[0]};',
      present: 'const int& first{tracecode::trace_index_read_ref(ar, "ar", 0',
      absent: 'trace_index_read_ref(ps',
    },
    {
      name: 'capacity of an element is not read from a copy',
      body: '    vector<string> names(2);\n    names[0].reserve(100);\n    k = (int)names[0].capacity();',
      absent: 'trace_index_read_ref(names',
    },
    {
      name: "a learner type's size() is not called on a copy",
      body: '    vector<Counter> cs(2);\n    k = cs[0].size();',
      absent: 'trace_index_read_ref(cs',
    },
    {
      name: 'a standard element size() stays traced',
      body: '    vector<string> names(2);\n    k = (int)names[1].size();',
      present: 'tracecode::trace_index_read_ref(names, "names", 1',
    },
    {
      name: 'a parenthesized argument at a reference parameter is the element',
      body: '    array<int, 3> ar{};\n    auto same = [](const int& p, const int& q) { return &p == &q; };\n    k = same((ar[0]), ar[0]);',
      absent: 'trace_index_read_ref(ar',
    },
    {
      name: 'a braced push_back argument is passed through unchanged',
      body: "    vector<string> parts;\n    char c = 'a';\n    parts.push_back({c, c++});",
      present: 'parts.push_back({c, c++});',
      absent: '__tc_mutation_arg',
    },
    // Round 6: a reference declared with a type of several words, and an
    // element in braces at a reference parameter.
    {
      name: 'a reference declared with a multi-word type binds the element',
      body: '    vector<long long> big(2);\n    const long long& first{big[0]};\n    long long const& second(big[1]);\n    vector<unsigned long long> big2(1);\n    unsigned long long& third{big2[0]};',
      present: 'const long long& first{tracecode::trace_index_read_ref(big, "big", 0',
      absent: 'trace_index_read_ref(big2',
    },
    {
      name: 'an element in braces at a reference parameter is the element',
      body: '    array<int, 3> ar{};\n    auto same = [](const int& p, const int& q) { return &p == &q; };\n    k = same({ar[0]}, ar[0]);',
      absent: 'trace_index_read_ref(ar',
    },
    {
      name: 'an element in braces inside an expression is still read',
      body: '    vector<int> big(2);\n    k = max({big[0], 1}) + min({big[1]});',
      present: 'trace_index_read_ref(big',
    },
    // Round 6: references to rows and elements of traced vectors keep the
    // reference (they used to become `auto x = <read>`, a copy), and array
    // declarators are not reads.
    {
      name: 'auto& to a row of a traced vector stays a reference to the row',
      body: '    vector<vector<int>> dp(3, vector<int>(3, 0));\n    int i = 1;\n    auto& cur = dp[i];\n    cur[2] = a;',
      present: 'auto& cur = __tracecode_element(dp[',
      absent: 'auto cur',
    },
    {
      name: 'auto& and int& to an element stay references to the element',
      body: '    vector<int> arr(3);\n    auto& x = arr[1];\n    x++;\n    int& y = arr[2];\n    y = 4;',
      present: 'auto& x = __tracecode_element(arr[1]);',
      absent: 'auto x',
    },
    {
      name: 'auto& to front() of a traced vector binds the element',
      body: '    vector<int> arr(3);\n    auto& f = arr.front();\n    f = 2;',
      present: 'auto& f = __tracecode_element(arr.front());',
    },
    {
      name: 'a reference to a nested element binds through the row',
      body: '    vector<vector<int>> grid(3, vector<int>(3, 0));\n    int& c = grid[1][2];\n    c = 5;',
      present: 'int& c = __tracecode_element(grid[1])[2];',
    },
    {
      name: 'an array of vectors is declared, not read',
      body: '    vector<int> adjc[3];\n    int memo[4];\n    adjc[1].push_back(a);\n    memo[0] = 1;',
      present: 'vector<int> adjc[3];',
      absent: 'trace_index_read_ref(adjc, "adjc", 3',
    },
    {
      name: 'a reference to const binds a nested read; a non-const one the element',
      body: '    vector<vector<int>> grid(2, vector<int>(2, 1));\n    const int& c = grid[1][1];\n    int& d = grid[0][1];\n    d = 4;',
      present: 'const int& c = tracecode::trace_nested_index_read_ref(grid, "grid", 1, 1',
    },
    {
      name: 'a vector<bool> element under auto stays the library proxy',
      body: '    vector<bool> flags(3, false);\n    auto p = flags[1];\n    bool q = flags[2];',
      present: 'auto p = flags[1];',
    },
    {
      name: 'a function returning a reference returns the element, not a local copy',
      body: '    vector<int> v(3);\n    auto pick = [&](int i) -> int& {\n      return v[i];\n    };\n    pick(1) = a;',
      present: 'int& __tc_return_',
    },
    {
      name: 'an east-const reference is not snapshotted as a variable named const',
      body: '    vector<long long> big(2);\n    long long const& second(big[1]);\n    k = (int)second;',
      absent: 'target_json("const")',
    },
    {
      name: 'a compound assignment to a string element keeps the learner expression',
      body: "    vector<string> names(2);\n    char ch = 'a';\n    names[1] += ch;",
      present: 'names[1] += ch;',
    },
    {
      name: 'an increment of a map cell in a vector of maps adds one through the cell proxy',
      body: "    vector<unordered_map<char, int>> freqs(2);\n    freqs[0]['z']++;\n    k = freqs[0]['z'];",
      present: 'trace_nested_index_ref(freqs, "freqs", 0, \'z\', nullptr, "\'z\'") += 1;',
      absent: 'trace_nested_index_read_ref(freqs',
    },
    // Round 4, item 4: fill binds its argument by const reference.
    {
      name: 'fill with std::move binds by const reference, without a move',
      body: '    array<string, 3> ar{};\n    string seed = "s";\n    ar.fill(std::move(seed));',
      present: 'const std::decay_t<decltype(ar)>::value_type& __tc_fill_value_',
    },
  ];
  for (const testCase of cases) {
    const failures: string[] = [];
    let output = '';
    try {
      output = instrumentBody(prelude, testCase.body);
    } catch (error) {
      failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    const functionOutput = output.slice(output.indexOf('int f('));
    for (const problem of writesThroughReadHelper(functionOutput)) failures.push(`writes through a copy: ${problem}`);
    if (testCase.absent && functionOutput.includes(testCase.absent)) failures.push(`output has ${testCase.absent}`);
    if (testCase.present && !functionOutput.includes(testCase.present)) failures.push(`output lacks ${testCase.present}`);
    if (testCase.once) {
      const code = functionOutput.replace(/"(?:\\.|[^"\\])*"/g, '""');
      const count = code.split(testCase.once).length - 1;
      if (count !== 1) failures.push(`${testCase.once} is evaluated ${count} times`);
    }
    results.push({ name: `single evaluation, no write through a copy: ${testCase.name}`, failures });
  }
  // Reads keep their read events.
  const reads = instrumentBody(prelude, '    vector<QQ> qs(3);\n    vector<string> names(3);\n    int i = 0;\n    k = qs[i].val + (int)names[i].size();');
  results.push({
    name: 'indexed reads stay traced',
    failures: reads.includes('trace_index_field_read_ref(qs') && reads.includes('trace_index_read_ref(names')
      ? []
      : ['an indexed read lost its read event'],
  });
}

// Round 4, items 5-7: the trace-execute path's compile safety net, with the
// compiler stubbed (the worker's top-level functions are sandbox properties).
{
  const worker = sandbox as Record<string, any>;
  const realCompileAndRun = worker.compileAndRun;
  type Call = { tracing: boolean; prepareOnly: boolean; driver?: string };
  const runWith = async (
    payload: Record<string, unknown>,
    stub: (call: Call, source: string, functionName: string, inputs: unknown, options: any) => unknown
  ) => {
    const calls: Call[] = [];
    worker.compileAndRun = async (source: string, functionName: string, inputs: unknown, options: any = {}) => {
      const call = { tracing: Boolean(options.tracing), prepareOnly: Boolean(options.prepareOnly), driver: options.preparedDriverSource };
      calls.push(call);
      return stub(call, source, functionName, inputs, options);
    };
    try {
      return { result: await worker.handleExecuteWithTracing(payload), calls };
    } catch (error) {
      return { error: error as Error & { code?: string }, calls };
    } finally {
      worker.compileAndRun = realCompileAndRun;
    }
  };
  const failures5: string[] = [];
  // 5: a refused program that does not compile untraced returns the learner's
  // compile error as its result, not the tracer's refusal.
  const refusedInvalid = programFor({ name: 'r', prelude: '#define TWICE(x) x; x', body: '    if (a < t) TWICE(k++); else b += 1;', expect: [] }).source;
  const learnerError = 'solution.cpp:13:28: error: expected expression';
  const run5 = await runWith({ code: refusedInvalid, functionName: 'f', inputs: { a: 1, b: 2, t: 3 } }, (call, source, functionName, inputs, options) => {
    // The traced build's driver is built (and refused) as compileAndRun builds it.
    if (call.tracing) return worker.buildDriverSource(source, functionName, inputs, options);
    return { success: false, error: learnerError, errorLine: 13, diagnosticStage: 'compile', consoleOutput: [] };
  });
  if (run5.error) failures5.push(`threw ${run5.error.name}: ${run5.error.message}`);
  else if (run5.result.error !== learnerError || run5.result.diagnosticStage !== 'compile' || run5.result.errorLine !== 13) {
    failures5.push(`result is ${JSON.stringify({ error: run5.result.error, stage: run5.result.diagnosticStage, line: run5.result.errorLine })}`);
  }
  results.push({ name: 'trace-execute: a refused program that does not compile reports the learner compile error', failures: failures5 });

  // 6 and 7: a traced build that fails to compile while the untraced build
  // compiles is refused after exactly one untraced compile, whose driver binds
  // the same overload as the traced request.
  const failures67: string[] = [];
  const overloads = [
    '#include <string>',
    'using namespace std;',
    'class Solution {',
    'public:',
    '  int solve(int a) { return a; }',
    '  int solve(int a, int b) { return a + b; }',
    '};',
  ].join('\n');
  const run67 = await runWith({ code: overloads, functionName: 'solve', inputs: { a: 1, b: 2 } }, (call) =>
    call.tracing
      ? { success: false, error: 'solution.cpp:9:1: error: generated code', diagnosticStage: 'compile', consoleOutput: [] }
      : { success: true, preparedArtifact: {}, consoleOutput: [] }
  );
  const untracedCalls = run67.calls.filter((call) => !call.tracing);
  if (!run67.error || run67.error.name !== 'CppTraceUnsupportedError' || run67.error.code !== 'trace-unavailable') {
    failures67.push(`not refused as trace-unavailable: ${run67.error ? run67.error.message : JSON.stringify(run67.result).slice(0, 200)}`);
  }
  if (untracedCalls.length !== 1) failures67.push(`the untraced build was compiled ${untracedCalls.length} times`);
  if (!/solve\(__tc_arg_0, __tc_arg_1\)/.test(untracedCalls[0]?.driver || '')) {
    failures67.push('the untraced driver does not call the two-argument overload the request binds');
  }
  results.push({ name: 'trace-execute: compile safety net compiles the untraced build once, same overload', failures: failures67 });
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
