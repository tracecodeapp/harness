/**
 * Learner-failure classification matrix: the programs, run modes, and the
 * classification each cell must receive.
 *
 * Shared by the browser entry (which runs the cells through the public
 * BrowserJudgeHost) and the Node runner (which asserts and reports them).
 *
 * Classification is read exactly the way a consumer reads it: from the Judge
 * diagnostics on the compile result or on each case. `provider` means the
 * Harness said `runtime-provider-error` (or the host call itself rejected).
 */

export type MatrixLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

export const MATRIX_LANGUAGES: readonly MatrixLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'java',
  'csharp',
  'cpp',
];

/**
 * - `code`: one plain case.
 * - `code-batch`: several plain cases in one evaluation.
 * - `trace`: one traced case.
 * - `trace-batch`: several traced cases in one evaluation.
 * - `interactive`: a retained interactive execution (correctness for every
 *   case, a trace of the selected case) and one trace continuation.
 * - `code-batch-stop`, `trace-batch-stop`: the batch modes with
 *   `stopAtFirstRunaway` (Submit opting into Run's stopping), for the kinds in
 *   `STOPPING_MODE_KINDS`.
 *
 * Program preparation (compilation) runs in every mode; the `syntax` row and
 * the injected provider failure exercise it.
 */
export type MatrixMode =
  | 'code'
  | 'code-batch'
  | 'trace'
  | 'trace-batch'
  | 'interactive'
  | 'code-batch-stop'
  | 'trace-batch-stop';

export const MATRIX_MODES: readonly MatrixMode[] = [
  'code',
  'code-batch',
  'trace',
  'trace-batch',
  'interactive',
  'code-batch-stop',
  'trace-batch-stop',
];

/** Batch modes that opt into stopping at the first runaway case. */
export const STOPPING_BATCH_MODES: readonly MatrixMode[] = ['code-batch-stop', 'trace-batch-stop'];

/**
 * Kinds the stopping batch modes run: a runaway, which stops the batch, and
 * failures that must not stop it (an exception, recursion, a trace budget).
 */
export const STOPPING_MODE_KINDS: readonly string[] = [
  'infinite-loop',
  'top-level-exception',
  'unbounded-recursion',
  'trace-step-limit',
];

/** The plain mode a stopping mode extends; expectations and gaps are shared. */
export function baseMode(mode: MatrixMode): MatrixMode {
  switch (mode) {
    case 'code-batch-stop':
      return 'code-batch';
    case 'trace-batch-stop':
      return 'trace-batch';
    default:
      return mode;
  }
}

/** Modes that stop at the first case a time or line limit stopped. */
export function stopsAtFirstRunaway(mode: MatrixMode): boolean {
  return mode === 'interactive' || STOPPING_BATCH_MODES.includes(mode);
}

export type MatrixFailureKind =
  | 'syntax'
  | 'top-level-exception'
  | 'helper-exception'
  | 'argument-error'
  | 'division-by-zero'
  | 'index-out-of-range'
  | 'unbounded-recursion'
  | 'infinite-loop'
  | 'trace-step-limit'
  | 'process-exit'
  | 'early-exit-zero'
  | 'abort-runaway'
  | 'unhandled-rejection'
  | 'memory-fault'
  | 'provider-asset-failure'
  | 'compile-header-error'
  | 'compile-template-instantiation'
  | 'compile-missing-include'
  | 'compile-macro-expansion'
  | 'compile-split-declaration'
  | 'compile-declaration-line'
  | 'compile-after-second-class'
  | 'compile-missing-symbol'
  | 'compile-private-member'
  | 'compile-header-errors-several-lines'
  | 'compile-many-errors'
  | 'forged-result-marker'
  | 'printed-result-marker'
  | 'keyless-tree-input'
  | 'keyless-tree-root'
  | 'keyless-list-input'
  | 'typing-names';

/** What a consumer concludes from the Judge result. */
export type MatrixClass =
  | 'compile'
  | 'runtime'
  | 'limit'
  | 'completed'
  | 'provider'
  | 'not-run'
  | 'aborted'
  | 'unclassified'
  | 'hung';

export interface MatrixProgram {
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: 'function' | 'solution-method';
}

export interface MatrixCellSpec {
  readonly language: MatrixLanguage;
  readonly kind: MatrixFailureKind;
  readonly program: MatrixProgram;
  /** Acceptable classes. Learner cells never list `provider`. */
  readonly expected: readonly MatrixClass[];
  /** When `limit` is expected, the acceptable limit reasons. */
  readonly limitReasons?: readonly string[];
  /**
   * Source line a learner needs, when the language can know it. Derived
   * from the line containing `faultText`.
   */
  readonly line?: number;
  /** Modes that are not meaningful for this kind (not a gap: no such cell). */
  readonly modes?: readonly MatrixMode[];
  readonly limits?: { readonly wallClockMs?: number };
  readonly traceOptions?: { readonly maxTraceSteps?: number };
  /** Modes where the cell is expected to complete instead (e.g. trace limit in code mode). */
  readonly completesIn?: readonly MatrixMode[];
  /**
   * The compiler's primary error: the first `error:` line of the message
   * must contain this text (the explanation survives, first).
   */
  readonly primaryError?: string;
  /** At most this many `error:` diagnostics are shown (one explicit budget). */
  readonly maxErrors?: number;
  /** Text the primary error must keep (the compiler's own explanation). */
  readonly messageIncludes?: readonly string[];
  /** 1-based column of the error in the learner's original source line. */
  readonly column?: number;
  /** Each case's input, in place of the default `{ n }`. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export const MATRIX_WALL_CLOCK_MS = 4_000;
export const MATRIX_TRACE_STEPS = 400;

const LEARNER_LIMIT_REASONS = ['client-timeout', 'line-limit', 'single-line-limit'];
// Unbounded recursion is the learner's failure whichever guard stops it first:
// a recursion or memory guard, a tracer's per-line guard, or the time limit.
const RECURSION_LIMIT_REASONS = [
  'recursion-limit',
  'memory-limit',
  'single-line-limit',
  'line-limit',
  'client-timeout',
];
const TRACE_LIMIT_REASONS = ['trace-limit', 'trace-byte-limit', 'line-limit', 'single-line-limit'];

function lines(...source: string[]): string {
  return source.join('\n');
}

function lineOf(code: string, faultText: string): number {
  const index = code.split('\n').findIndex((line) => line.includes(faultText));
  if (index < 0) throw new Error(`Fault marker ${JSON.stringify(faultText)} not found.`);
  return index + 1;
}

interface Draft {
  readonly kind: MatrixFailureKind;
  readonly code: string;
  readonly faultText?: string;
  readonly expected: readonly MatrixClass[];
  readonly limitReasons?: readonly string[];
  readonly modes?: readonly MatrixMode[];
  readonly limits?: { readonly wallClockMs?: number };
  readonly traceOptions?: { readonly maxTraceSteps?: number };
  readonly completesIn?: readonly MatrixMode[];
  /** Line is not knowable for this language/kind (e.g. a Wasm trap). */
  readonly noLine?: boolean;
  readonly primaryError?: string;
  readonly maxErrors?: number;
  readonly messageIncludes?: readonly string[];
  /** Where the error's column is in the faulting line: `text`'s index + `offset` + 1. */
  readonly errorColumn?: { readonly text: string; readonly offset: number };
  readonly inputs?: Readonly<Record<string, unknown>>;
}

// Key-less nodes: a child or next a node does not list is null (None,
// nullptr) in every language. The programs guard with the language's own null
// test, so a missing link that arrives as anything else is a runtime failure.
/** Key-less leaves under keyed parents, as the catalog writes trees. */
const KEYLESS_TREE_INPUT = {
  root: { val: 1, left: { val: 2 }, right: { val: 3, left: { val: 4 } }, __id__: 'tree-0' },
};
/** A lone key-less root: only a declared node type says it is a tree. */
const KEYLESS_TREE_ROOT = { root: { val: 5 } };
/** A key-less tail under keyed nodes. */
const KEYLESS_LIST_INPUT = { head: { val: 1, next: { val: 2, next: { val: 3 } } } };

function keylessDrafts(programs: { readonly tree: string; readonly list: string }): readonly Draft[] {
  return [
    { kind: 'keyless-tree-input', code: programs.tree, expected: ['completed'], inputs: KEYLESS_TREE_INPUT, noLine: true },
    { kind: 'keyless-tree-root', code: programs.tree, expected: ['completed'], inputs: KEYLESS_TREE_ROOT, noLine: true },
    { kind: 'keyless-list-input', code: programs.list, expected: ['completed'], inputs: KEYLESS_LIST_INPUT, noLine: true },
  ];
}

/** Compile-only cells: preparation runs the same way in every mode. */
const COMPILE_CELL_MODES: readonly MatrixMode[] = ['code', 'trace'];

const TRACED_MODES: readonly MatrixMode[] = ['trace', 'trace-batch', 'interactive'];

function infiniteLoopDraft(code: string, faultText: string): Draft {
  return {
    kind: 'infinite-loop',
    code,
    faultText,
    expected: ['limit'],
    limitReasons: LEARNER_LIMIT_REASONS,
    limits: { wallClockMs: MATRIX_WALL_CLOCK_MS },
    noLine: true,
  };
}

function traceLimitDraft(code: string): Draft {
  return {
    kind: 'trace-step-limit',
    code,
    // A finite program: plain modes complete; traced modes stop recording.
    expected: ['limit', 'completed'],
    limitReasons: TRACE_LIMIT_REASONS,
    traceOptions: { maxTraceSteps: MATRIX_TRACE_STEPS },
    completesIn: ['code', 'code-batch'],
    noLine: true,
  };
}

function providerDraft(code: string): Draft {
  return { kind: 'provider-asset-failure', code, expected: ['provider'], noLine: true };
}

const PYTHON: readonly Draft[] = [
  {
    kind: 'syntax',
    code: lines('def solve(n):', '    total = n +', '    return total'),
    faultText: 'total = n +',
    expected: ['compile'],
  },
  {
    kind: 'top-level-exception',
    code: lines('def solve(n):', '    return n', 'raise ValueError("top level failure")'),
    faultText: 'raise ValueError',
    expected: ['runtime'],
  },
  {
    kind: 'helper-exception',
    code: lines(
      'def helper(n):',
      '    return undefined_name + n',
      'def solve(n):',
      '    return helper(n)'
    ),
    faultText: 'undefined_name',
    expected: ['runtime'],
  },
  {
    kind: 'argument-error',
    code: lines(
      'def helper(a, b):',
      '    return a + b',
      'def solve(n):',
      '    return helper(n)'
    ),
    faultText: 'return helper(n)',
    expected: ['runtime'],
  },
  {
    kind: 'division-by-zero',
    code: lines('def solve(n):', '    zero = 0', '    return n // zero'),
    faultText: 'n // zero',
    expected: ['runtime'],
  },
  {
    kind: 'index-out-of-range',
    code: lines('def solve(n):', '    values = [1, 2]', '    return values[n + 5]'),
    faultText: 'values[n + 5]',
    expected: ['runtime'],
  },
  {
    kind: 'unbounded-recursion',
    code: lines('def solve(n):', '    return solve(n + 1) + 1'),
    faultText: 'solve(n + 1)',
    expected: ['runtime', 'limit'],
    limitReasons: RECURSION_LIMIT_REASONS,
    // Stack exhaustion is detected at a frame boundary (the call or the
    // callee's entry), not at one source line; the line is not asserted.
    noLine: true,
  },
  infiniteLoopDraft(
    lines(
      'def solve(n):',
      '    left, right = 0, n',
      '    while left <= right:',
      '        mid = (left + right) // 2',
      '    return left'
    ),
    'while left <= right'
  ),
  traceLimitDraft(
    lines('def solve(n):', '    total = 0', '    for i in range(20000):', '        total += i', '    return n')
  ),
  {
    kind: 'process-exit',
    code: lines('import sys', 'def solve(n):', '    sys.exit(3)'),
    faultText: 'sys.exit(3)',
    expected: ['runtime'],
  },
  {
    // Ends the interpreter without unwinding: "successful exit, no result".
    kind: 'early-exit-zero',
    code: lines('import os', 'def solve(n):', '    os._exit(0)'),
    expected: ['runtime'],
    // The interpreter ends without a traceback, so no line is knowable.
    noLine: true,
  },
  providerDraft(lines('def solve(n):', '    return n')),
];

function javascriptDrafts(typed: boolean): readonly Draft[] {
  const param = typed ? 'n: number' : 'n';
  const ret = typed ? ': number' : '';
  const any = typed ? ' as any' : '';
  return [
    {
      kind: 'syntax',
      code: lines(`function solve(${param})${ret} {`, '  const total = n +;', '  return total;', '}'),
      faultText: 'const total = n +;',
      expected: ['compile'],
    },
    {
      kind: 'top-level-exception',
      code: lines(
        `function solve(${param})${ret} {`,
        '  return n;',
        '}',
        'throw new Error("top level failure");'
      ),
      faultText: 'throw new Error',
      expected: ['runtime'],
    },
    {
      kind: 'helper-exception',
      code: lines(
        `function helper(${param})${ret} {`,
        `  return (globalThis${any}).undefinedHelper(n);`,
        '}',
        `function solve(${param})${ret} {`,
        '  return helper(n);',
        '}'
      ),
      faultText: 'undefinedHelper',
      expected: ['runtime'],
    },
    {
      kind: 'argument-error',
      code: lines(`function solve(${param})${ret} {`, `  return (n${any}).toUpperCase();`, '}'),
      faultText: 'toUpperCase',
      expected: ['runtime'],
    },
    {
      kind: 'division-by-zero',
      code: lines(
        `function solve(${param})${ret} {`,
        '  const zero = BigInt(0);',
        '  return Number(BigInt(n) / zero);',
        '}'
      ),
      faultText: 'BigInt(n) / zero',
      expected: ['runtime'],
    },
    {
      kind: 'index-out-of-range',
      code: lines(
        `function solve(${param})${ret} {`,
        `  const values${typed ? ': any[]' : ''} = [1, 2];`,
        '  return values[n + 5].length;',
        '}'
      ),
      faultText: 'values[n + 5].length',
      expected: ['runtime'],
    },
    {
      kind: 'unbounded-recursion',
      code: lines(`function solve(${param})${ret} {`, '  return solve(n + 1) + 1;', '}'),
      faultText: 'solve(n + 1)',
      expected: ['runtime', 'limit'],
      limitReasons: RECURSION_LIMIT_REASONS,
      noLine: true,
    },
    infiniteLoopDraft(
      lines(
        `function solve(${param})${ret} {`,
        '  let left = 0;',
        '  const right = n;',
        '  while (left <= right) {',
        '    left = Math.min(left, right);',
        '  }',
        '  return left;',
        '}'
      ),
      'while (left <= right)'
    ),
    traceLimitDraft(
      lines(
        `function solve(${param})${ret} {`,
        '  let total = 0;',
        '  for (let i = 0; i < 20000; i += 1) {',
        '    total += i;',
        '  }',
        '  return n;',
        '}'
      )
    ),
    {
      kind: 'process-exit',
      code: lines(
        `function solve(${param})${ret} {`,
        `  (globalThis${any}).process.exit(3);`,
        '  return n;',
        '}'
      ),
      faultText: 'process.exit(3)',
      expected: ['runtime'],
    },
    {
      kind: 'early-exit-zero',
      code: lines(
        `function solve(${param})${ret} {`,
        `  (globalThis${any}).process.exit(0);`,
        '  return n;',
        '}'
      ),
      // Browsers have no process to exit; the attempt is the program's error.
      expected: ['runtime'],
      noLine: true,
    },
    {
      kind: 'unhandled-rejection',
      code: lines(
        `function solve(${param})${ret} {`,
        '  Promise.reject(new Error("unhandled rejection"));',
        '  return n;',
        '}'
      ),
      // The function returned a value; a stray rejection is not the provider's.
      expected: ['completed', 'runtime'],
      noLine: true,
    },
    providerDraft(lines(`function solve(${param})${ret} {`, '  return n;', '}')),
  ];
}

const JAVA: readonly Draft[] = [
  {
    kind: 'syntax',
    code: lines('class Solution {', '  public int solve(int n) {', '    int total = n +;', '    return total;', '  }', '}'),
    faultText: 'int total = n +;',
    expected: ['compile'],
  },
  {
    kind: 'top-level-exception',
    code: lines(
      'class Solution {',
      '  public int solve(int n) {',
      '    throw new IllegalStateException("top level failure");',
      '  }',
      '}'
    ),
    faultText: 'throw new IllegalStateException',
    expected: ['runtime'],
  },
  {
    kind: 'helper-exception',
    code: lines(
      'class Solution {',
      '  private int helper(int n) {',
      '    throw new IllegalArgumentException("helper failure " + n);',
      '  }',
      '  public int solve(int n) {',
      '    return helper(n);',
      '  }',
      '}'
    ),
    faultText: 'throw new IllegalArgumentException',
    expected: ['runtime'],
  },
  {
    kind: 'argument-error',
    code: lines(
      'class Solution {',
      '  public int solve(int n) {',
      '    Object value = "text";',
      '    return (Integer) value;',
      '  }',
      '}'
    ),
    faultText: '(Integer) value',
    expected: ['runtime'],
  },
  {
    kind: 'division-by-zero',
    code: lines('class Solution {', '  public int solve(int n) {', '    int zero = 0;', '    return n / zero;', '  }', '}'),
    faultText: 'n / zero',
    expected: ['runtime'],
  },
  {
    kind: 'index-out-of-range',
    code: lines(
      'class Solution {',
      '  public int solve(int n) {',
      '    int[] values = new int[2];',
      '    return values[n + 5];',
      '  }',
      '}'
    ),
    faultText: 'values[n + 5]',
    expected: ['runtime'],
  },
  {
    kind: 'unbounded-recursion',
    code: lines('class Solution {', '  public int solve(int n) {', '    return solve(n + 1) + 1;', '  }', '}'),
    faultText: 'solve(n + 1)',
    expected: ['runtime', 'limit'],
    limitReasons: RECURSION_LIMIT_REASONS,
    // Stack exhaustion is detected at a frame boundary (the call or the
    // callee's entry), not at one source line; the line is not asserted.
    noLine: true,
  },
  infiniteLoopDraft(
    lines(
      'class Solution {',
      '  public int solve(int n) {',
      '    int left = 0;',
      '    int right = n;',
      '    while (left <= right) {',
      '      left = Math.min(left, right);',
      '    }',
      '    return left;',
      '  }',
      '}'
    ),
    'while (left <= right)'
  ),
  traceLimitDraft(
    lines(
      'class Solution {',
      '  public int solve(int n) {',
      '    int total = 0;',
      '    for (int i = 0; i < 20000; i++) {',
      '      total += i;',
      '    }',
      '    return n;',
      '  }',
      '}'
    )
  ),
  {
    kind: 'process-exit',
    code: lines('class Solution {', '  public int solve(int n) {', '    System.exit(3);', '    return n;', '  }', '}'),
    faultText: 'System.exit(3)',
    expected: ['runtime'],
  },
  {
    kind: 'early-exit-zero',
    code: lines('class Solution {', '  public int solve(int n) {', '    System.exit(0);', '    return n;', '  }', '}'),
    expected: ['runtime'],
    noLine: true,
  },
  providerDraft(lines('class Solution {', '  public int solve(int n) {', '    return n;', '  }', '}')),
  // Learner source the worker normalizes before compiling: lines and columns
  // must be reported in the learner's original text.
  {
    kind: 'compile-split-declaration',
    code: lines(
      'public',
      'class Solution {',
      '  public int solve(int n) {',
      '    int total = n +;',
      '    return total;',
      '  }',
      '}'
    ),
    faultText: 'int total = n +;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'illegal start of expression',
    errorColumn: { text: '+;', offset: 1 },
  },
  {
    kind: 'compile-declaration-line',
    code: 'public class Solution { public int solve(int n) { return n +; } }',
    faultText: 'return n +;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'illegal start of expression',
    errorColumn: { text: '+;', offset: 1 },
  },
  {
    kind: 'compile-after-second-class',
    code: lines(
      'class Helper {',
      '  static int twice(int v) { return v * 2; }',
      '}',
      'public class Solution {',
      '  public int solve(int n) {',
      '    int total = Helper.twice(n) +;',
      '    return total;',
      '  }',
      '}'
    ),
    faultText: 'int total = Helper.twice(n) +;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'illegal start of expression',
    errorColumn: { text: '+;', offset: 1 },
  },
  {
    kind: 'compile-missing-symbol',
    code: 'public class Solution { public int solve(int n) { return missing; } }',
    faultText: 'return missing;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'cannot find symbol',
    // javac's explanation survives whether or not an excerpt can be shown.
    messageIncludes: ['variable missing', 'location: class Solution'],
    errorColumn: { text: 'missing;', offset: 0 },
  },
];

const CSHARP: readonly Draft[] = [
  {
    kind: 'syntax',
    code: lines('public class Solution {', '  public int Solve(int n) {', '    int total = n +;', '    return total;', '  }', '}'),
    faultText: 'int total = n +;',
    expected: ['compile'],
  },
  {
    kind: 'top-level-exception',
    code: lines(
      'using System;',
      'public class Solution {',
      '  public int Solve(int n) {',
      '    throw new InvalidOperationException("top level failure");',
      '  }',
      '}'
    ),
    faultText: 'throw new InvalidOperationException',
    expected: ['runtime'],
  },
  {
    kind: 'helper-exception',
    code: lines(
      'using System;',
      'public class Solution {',
      '  private int Helper(int n) {',
      '    throw new ArgumentException("helper failure " + n);',
      '  }',
      '  public int Solve(int n) {',
      '    return Helper(n);',
      '  }',
      '}'
    ),
    faultText: 'throw new ArgumentException',
    expected: ['runtime'],
  },
  {
    kind: 'argument-error',
    code: lines(
      'public class Solution {',
      '  public int Solve(int n) {',
      '    object value = "text";',
      '    return (int)value;',
      '  }',
      '}'
    ),
    faultText: '(int)value',
    expected: ['runtime'],
  },
  {
    kind: 'division-by-zero',
    code: lines('public class Solution {', '  public int Solve(int n) {', '    int zero = 0;', '    return n / zero;', '  }', '}'),
    faultText: 'n / zero',
    expected: ['runtime'],
  },
  {
    kind: 'index-out-of-range',
    code: lines(
      'public class Solution {',
      '  public int Solve(int n) {',
      '    int[] values = new int[2];',
      '    return values[n + 5];',
      '  }',
      '}'
    ),
    faultText: 'values[n + 5]',
    expected: ['runtime'],
  },
  {
    kind: 'unbounded-recursion',
    code: lines('public class Solution {', '  public int Solve(int n) {', '    return Solve(n + 1) + 1;', '  }', '}'),
    faultText: 'Solve(n + 1)',
    expected: ['runtime', 'limit'],
    limitReasons: RECURSION_LIMIT_REASONS,
    // Stack exhaustion is detected at a frame boundary (the call or the
    // callee's entry), not at one source line; the line is not asserted.
    noLine: true,
  },
  infiniteLoopDraft(
    lines(
      'using System;',
      'public class Solution {',
      '  public int Solve(int n) {',
      '    int left = 0;',
      '    int right = n;',
      '    while (left <= right) {',
      '      left = Math.Min(left, right);',
      '    }',
      '    return left;',
      '  }',
      '}'
    ),
    'while (left <= right)'
  ),
  traceLimitDraft(
    lines(
      'public class Solution {',
      '  public int Solve(int n) {',
      '    int total = 0;',
      '    for (int i = 0; i < 20000; i++) {',
      '      total += i;',
      '    }',
      '    return n;',
      '  }',
      '}'
    )
  ),
  {
    kind: 'process-exit',
    code: lines(
      'using System;',
      'public class Solution {',
      '  public int Solve(int n) {',
      '    Environment.Exit(3);',
      '    return n;',
      '  }',
      '}'
    ),
    faultText: 'Environment.Exit(3)',
    expected: ['runtime'],
  },
  {
    kind: 'early-exit-zero',
    code: lines(
      'using System;',
      'public class Solution {',
      '  public int Solve(int n) {',
      '    Environment.Exit(0);',
      '    return n;',
      '  }',
      '}'
    ),
    expected: ['runtime'],
    noLine: true,
  },
  providerDraft(lines('public class Solution {', '  public int Solve(int n) {', '    return n;', '  }', '}')),
];

const CPP: readonly Draft[] = [
  {
    kind: 'syntax',
    code: lines('class Solution {', 'public:', '  int solve(int n) {', '    int total = n +;', '    return total;', '  }', '};'),
    faultText: 'int total = n +;',
    expected: ['compile'],
  },
  {
    kind: 'top-level-exception',
    code: lines(
      '#include <stdexcept>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    throw std::runtime_error("top level failure");',
      '  }',
      '};'
    ),
    faultText: 'throw std::runtime_error',
    expected: ['runtime'],
  },
  {
    kind: 'helper-exception',
    code: lines(
      '#include <stdexcept>',
      '#include <string>',
      'class Solution {',
      '  int helper(int n) {',
      '    throw std::invalid_argument("helper failure " + std::to_string(n));',
      '  }',
      'public:',
      '  int solve(int n) {',
      '    return helper(n);',
      '  }',
      '};'
    ),
    faultText: 'throw std::invalid_argument',
    expected: ['runtime'],
  },
  {
    // C++ checks argument counts at compile time.
    kind: 'argument-error',
    code: lines(
      'class Solution {',
      '  int helper(int a, int b) { return a + b; }',
      'public:',
      '  int solve(int n) {',
      '    return helper(n);',
      '  }',
      '};'
    ),
    faultText: 'return helper(n);',
    expected: ['compile'],
  },
  {
    kind: 'division-by-zero',
    code: lines(
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    volatile int zero = 0;',
      '    return n / zero;',
      '  }',
      '};'
    ),
    faultText: 'n / zero',
    expected: ['runtime'],
  },
  {
    kind: 'index-out-of-range',
    code: lines(
      '#include <vector>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::vector<int> values(2);',
      '    return values.at(n + 5);',
      '  }',
      '};'
    ),
    faultText: 'values.at(n + 5)',
    expected: ['runtime'],
  },
  {
    kind: 'unbounded-recursion',
    code: lines(
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    volatile int pad[16];',
      '    pad[0] = n;',
      '    return solve(n + 1) + pad[0];',
      '  }',
      '};'
    ),
    faultText: 'solve(n + 1)',
    expected: ['runtime', 'limit'],
    limitReasons: RECURSION_LIMIT_REASONS,
    // Stack exhaustion is detected at a frame boundary (the call or the
    // callee's entry), not at one source line; the line is not asserted.
    noLine: true,
  },
  infiniteLoopDraft(
    lines(
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    volatile int left = 0;',
      '    int right = n;',
      '    while (left <= right) {',
      '      left = left < right ? left : right;',
      '    }',
      '    return left;',
      '  }',
      '};'
    ),
    'while (left <= right)'
  ),
  traceLimitDraft(
    lines(
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    int total = 0;',
      '    for (int i = 0; i < 20000; i++) {',
      '      total += i;',
      '    }',
      '    return n;',
      '  }',
      '};'
    )
  ),
  {
    kind: 'process-exit',
    code: lines(
      '#include <cstdlib>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::exit(3);',
      '    return n;',
      '  }',
      '};'
    ),
    faultText: 'std::exit(3)',
    expected: ['runtime'],
  },
  {
    kind: 'memory-fault',
    code: lines(
      '#include <vector>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::vector<int> values(2);',
      '    values[n + 900000000] = 1;',
      '    return values[0];',
      '  }',
      '};'
    ),
    faultText: 'values[n + 900000000]',
    expected: ['runtime'],
  },
  {
    kind: 'early-exit-zero',
    code: lines(
      '#include <cstdlib>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::exit(0);',
      '    return n;',
      '  }',
      '};'
    ),
    expected: ['runtime'],
    noLine: true,
  },
  {
    // A forged result line, then an early exit: the driver's result is
    // authenticated per execution, so this is the program ending early, never
    // a pass with the forged value.
    kind: 'forged-result-marker',
    code: lines(
      '#include <cstdlib>',
      '#include <iostream>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::cout << "__TRACECODE_RESULT__[42]" << std::endl;',
      '    std::exit(0);',
      '    return n;',
      '  }',
      '};'
    ),
    expected: ['runtime'],
    noLine: true,
  },
  {
    // Marker-shaped text the program prints is its console output; its real
    // result is still reported.
    kind: 'printed-result-marker',
    code: lines(
      '#include <iostream>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::cout << "__TRACECODE_RESULT__not json" << std::endl;',
      '    std::cout << "__TRACECODE_TRACE_STATUS__{}" << std::endl;',
      '    return n;',
      '  }',
      '};'
    ),
    expected: ['completed'],
    noLine: true,
  },
  providerDraft(lines('class Solution {', 'public:', '  int solve(int n) {', '    return n;', '  }', '};')),
  // Compile errors whose explanation is not (only) in the learner's file: the
  // primary error and its instantiation or expansion chain must survive.
  {
    kind: 'compile-header-error',
    code: lines(
      '#include <algorithm>',
      '#include <vector>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::vector<int> a = {3, 1, 2};',
      '    std::sort(a.begin(), a.end(), [](int, int) {});',
      '    return n;',
      '  }',
      '};'
    ),
    faultText: 'std::sort(a.begin()',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'invalid operands to binary expression',
  },
  {
    kind: 'compile-template-instantiation',
    code: lines(
      'template <typename T> int twice(T value) { return value * 2; }',
      'struct Point { int x; };',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    return twice(Point{n});',
      '  }',
      '};'
    ),
    faultText: 'return value * 2;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'invalid operands to binary expression',
    messageIncludes: ['invalid operands'],
  },
  {
    kind: 'compile-missing-include',
    code: lines(
      '#include <tracecode_no_such_header>',
      'class Solution {',
      'public:',
      '  int solve(int n) { return n; }',
      '};'
    ),
    faultText: '#include <tracecode_no_such_header>',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'file not found',
    messageIncludes: ['not found'],
  },
  {
    kind: 'compile-macro-expansion',
    code: lines(
      '#define SQUARE(x) ((x) * (x)',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    return SQUARE(n);',
      '  }',
      '};'
    ),
    faultText: 'return SQUARE(n);',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: "expected ')'",
  },
  {
    // The driver's call fails, but the chain reaches the learner's source.
    kind: 'compile-private-member',
    code: lines('class Solution {', '  int solve(int n) { return n; }', '};'),
    faultText: 'int solve(int n)',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'is a private member',
  },
  {
    // Several library-header errors, each requested from a different learner
    // line: every one of those lines is reported.
    kind: 'compile-header-errors-several-lines',
    code: lines(
      '#include <algorithm>',
      '#include <vector>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::vector<int> v = {1, 2, 3};',
      '    long a = std::count_if(v.begin(), v.end(), [](int) {});',
      '    long b = std::count_if(v.begin(), v.end(), [](int) {});',
      '    long c = std::count_if(v.begin(), v.end(), [](int) {});',
      '    long d = std::count_if(v.begin(), v.end(), [](int) {});',
      '    return static_cast<int>(a + b + c + d) + n;',
      '  }',
      '};'
    ),
    faultText: 'long a = std::count_if',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: 'not contextually convertible',
    messageIncludes: ['solution.cpp:7:', 'solution.cpp:8:', 'solution.cpp:9:', 'solution.cpp:10:'],
  },
  {
    // Errors located in the learner's own file obey the same budget.
    kind: 'compile-many-errors',
    code: lines(
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    int a = undefined1;',
      '    int b = undefined2;',
      '    int c = undefined3;',
      '    int d = undefined4;',
      '    int e = undefined5;',
      '    int f = undefined6;',
      '    int g = undefined7;',
      '    int h = undefined8;',
      '    return a + b + c + d + e + f + g + h + n;',
      '  }',
      '};'
    ),
    faultText: 'int a = undefined1;',
    expected: ['compile'],
    modes: COMPILE_CELL_MODES,
    primaryError: "use of undeclared identifier 'undefined1'",
    maxErrors: 5,
    messageIncludes: ['more errors not shown'],
  },
];

function programFor(language: MatrixLanguage, code: string): MatrixProgram {
  switch (language) {
    case 'python':
    case 'javascript':
    case 'typescript':
      return { code, functionName: 'solve', executionStyle: 'function' };
    case 'java':
    case 'cpp':
      return { code, functionName: 'solve', executionStyle: 'solution-method' };
    case 'csharp':
      return { code, functionName: 'Solve', executionStyle: 'solution-method' };
  }
}

const KEYLESS_PROGRAMS: Readonly<Record<MatrixLanguage, { readonly tree: string; readonly list: string }>> = {
  python: {
    tree: lines(
      'from typing import Optional',
      'def solve(root: Optional[TreeNode]) -> int:',
      '    if root is None:',
      '        return 0',
      '    return root.val + solve(root.left) + solve(root.right)'
    ),
    list: lines(
      'from typing import Optional',
      'def solve(head: Optional[ListNode]) -> int:',
      '    total = 0',
      '    while head is not None:',
      '        total += head.val',
      '        head = head.next',
      '    return total'
    ),
  },
  javascript: {
    tree: lines(
      'function solve(root) {',
      '  if (root === null) return 0;',
      '  return root.val + solve(root.left) + solve(root.right);',
      '}'
    ),
    list: lines(
      'function solve(head) {',
      '  let total = 0;',
      '  for (let node = head; node !== null; node = node.next) total += node.val;',
      '  return total;',
      '}'
    ),
  },
  typescript: {
    tree: lines(
      'function solve(root: TreeNode | null): number {',
      '  if (root === null) return 0;',
      '  return root.val + solve(root.left) + solve(root.right);',
      '}'
    ),
    list: lines(
      'function solve(head: ListNode | null): number {',
      '  let total = 0;',
      '  for (let node = head; node !== null; node = node.next) total += node.val;',
      '  return total;',
      '}'
    ),
  },
  java: {
    tree: lines(
      'class Solution {',
      '  public int solve(TreeNode root) {',
      '    if (root == null) return 0;',
      '    return root.val + solve(root.left) + solve(root.right);',
      '  }',
      '}'
    ),
    list: lines(
      'class Solution {',
      '  public int solve(ListNode head) {',
      '    int total = 0;',
      '    for (ListNode node = head; node != null; node = node.next) total += node.val;',
      '    return total;',
      '  }',
      '}'
    ),
  },
  csharp: {
    tree: lines(
      'public class Solution {',
      '  public int Solve(TreeNode root) {',
      '    if (root == null) return 0;',
      '    return root.val + Solve(root.left) + Solve(root.right);',
      '  }',
      '}'
    ),
    list: lines(
      'public class Solution {',
      '  public int Solve(ListNode head) {',
      '    int total = 0;',
      '    for (ListNode node = head; node != null; node = node.next) total += node.val;',
      '    return total;',
      '  }',
      '}'
    ),
  },
  cpp: {
    tree: lines(
      'class Solution {',
      'public:',
      '  int solve(TreeNode* root) {',
      '    if (root == nullptr) return 0;',
      '    return root->val + solve(root->left) + solve(root->right);',
      '  }',
      '};'
    ),
    list: lines(
      'class Solution {',
      'public:',
      '  int solve(ListNode* head) {',
      '    int total = 0;',
      '    for (ListNode* node = head; node != nullptr; node = node->next) total += node->val;',
      '    return total;',
      '  }',
      '};'
    ),
  },
};

function languageDrafts(language: MatrixLanguage): readonly Draft[] {
  switch (language) {
    case 'python':
      return PYTHON;
    case 'javascript':
      return javascriptDrafts(false);
    case 'typescript':
      return javascriptDrafts(true);
    case 'java':
      return JAVA;
    case 'csharp':
      return CSHARP;
    case 'cpp':
      return CPP;
  }
}

// A pasted LeetCode solution: typing names used without an import must work
// in every mode (Run is traced, Submit is not), on the fast and compatibility
// tiers alike.
const PYTHON_TYPING_NAMES: Draft = {
  kind: 'typing-names',
  code: lines(
    'def solve(nums: List[int], target: int) -> List[int]:',
    '    seen: Dict[int, int] = {}',
    '    for index, value in enumerate(nums):',
    '        if target - value in seen:',
    '            return [seen[target - value], index]',
    '        seen[value] = index',
    '    return []'
  ),
  expected: ['completed'],
  inputs: { nums: [2, 7, 11, 15], target: 9 },
  noLine: true,
};

function draftsFor(language: MatrixLanguage): readonly Draft[] {
  return [
    ...languageDrafts(language),
    ...keylessDrafts(KEYLESS_PROGRAMS[language]),
    ...(language === 'python' ? [PYTHON_TYPING_NAMES] : []),
  ];
}

export function matrixCells(language: MatrixLanguage): readonly MatrixCellSpec[] {
  return draftsFor(language).map((draft) => ({
    language,
    kind: draft.kind,
    program: programFor(language, draft.code),
    expected: draft.expected,
    ...(draft.limitReasons ? { limitReasons: draft.limitReasons } : {}),
    ...(draft.faultText && !draft.noLine ? { line: lineOf(draft.code, draft.faultText) } : {}),
    ...(draft.modes ? { modes: draft.modes } : {}),
    ...(draft.limits ? { limits: draft.limits } : {}),
    ...(draft.traceOptions ? { traceOptions: draft.traceOptions } : {}),
    ...(draft.completesIn ? { completesIn: draft.completesIn } : {}),
    ...(draft.primaryError ? { primaryError: draft.primaryError } : {}),
    ...(draft.maxErrors ? { maxErrors: draft.maxErrors } : {}),
    ...(draft.messageIncludes ? { messageIncludes: draft.messageIncludes } : {}),
    ...(draft.errorColumn && draft.faultText
      ? { column: columnOf(draft.code, draft.faultText, draft.errorColumn) }
      : {}),
    ...(draft.inputs ? { inputs: draft.inputs } : {}),
  }));
}

function columnOf(
  code: string,
  faultText: string,
  at: { readonly text: string; readonly offset: number }
): number {
  const line = code.split('\n').find((candidate) => candidate.includes(faultText))!;
  return line.indexOf(at.text) + at.offset + 1;
}

export function healthyProgram(language: MatrixLanguage): MatrixProgram {
  return programFor(language, draftsFor(language).find(
    (draft) => draft.kind === 'provider-asset-failure'
  )!.code);
}

export function isTracedMode(mode: MatrixMode): boolean {
  return TRACED_MODES.includes(baseMode(mode));
}

/** One observed Judge case (or compile) outcome, as a consumer reads it. */
export interface MatrixObservation {
  readonly class: MatrixClass;
  readonly code?: string;
  readonly message?: string;
  readonly line?: number;
  readonly status?: string;
  readonly reason?: string;
  /** Completed cases: the returned value, JSON, truncated. */
  readonly value?: string;
  /** The Judge's typed origin: program:<stage>, limit:<reason>, provider:<reason>, none. */
  readonly origin?: string;
  /** What `judgeCaseExecutionOutcome` produced: completed, failed:<stage>, limit:<reason>, provider-rejected. */
  readonly conversion?: string;
  /** abort-runaway: ms from the abort to the call settling, and the next run's duration. */
  readonly settledAfterAbortMs?: number;
  readonly nextRunMs?: number;
}

export interface MatrixCellResult {
  readonly language: MatrixLanguage;
  readonly mode: MatrixMode;
  readonly kind: MatrixFailureKind;
  readonly observations: readonly MatrixObservation[];
  readonly elapsedMs: number;
  /** A healthy program evaluated on the same host afterwards. */
  readonly healthyAfter?: boolean;
  readonly healthyAfterDetail?: string;
}
