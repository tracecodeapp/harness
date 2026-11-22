// A C++ program's traced Run computes what its untraced evaluation computes,
// through the public BrowserJudgeHost in a real C++ worker, for every form of
// control body the tracing rewriter has to normalize (see
// tests/test-cpp-rewriter-control-bodies.ts). Programs the tracer cannot
// instrument without changing them are refused as the provider's failure.
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCompileExecutionOutcome,
} from '../../src/judge';

const PRELUDE = [
  '#include <algorithm>',
  '#include <array>',
  '#include <set>',
  '#include <string>',
  '#include <vector>',
  'using namespace std;',
  '#define BUMP(x) ((x) += 1)',
  '#define SWAP_DO(x, y) do { int tmp = (x); (x) = (y); (y) = tmp; } while (0)',
  '#define LOG_IF(c) if (c) k += 1000',
  '#define ll long long',
  '#define all(x) (x).begin(), (x).end()',
  '#define F first',
  '#define REP(i, n) for (int i = 0; i < (n); i++)',
  'struct QQ { int val; string name; vector<int> adj; set<int> seen; };',
];

export interface ParityForm {
  readonly name: string;
  /** Statements of `int name(int a, int b, int t)`, after `int k = 0; string s = "";`. */
  readonly body: string;
}

/** Each form becomes a helper; `solve(form, a, b, t)` dispatches to it. */
export function formsProgram(forms: readonly ParityForm[]): string {
  const lines = [...PRELUDE, 'class Solution {'];
  forms.forEach((form, index) => {
    lines.push(`  // ${form.name}`);
    lines.push(`  long long form${index + 1}(int a, int b, int t) {`);
    lines.push('    int k = 0;');
    lines.push('    string s = "";');
    lines.push(form.body);
    lines.push('    return 1000000LL * a + 10000LL * b + 100LL * k + (long long)s.size() * 7 + (s.empty() ? 0 : s[0]);');
    lines.push('  }');
  });
  lines.push('public:');
  lines.push('  long long solve(int form, int a, int b, int t) {');
  lines.push('    switch (form) {');
  forms.forEach((_form, index) => {
    lines.push(`      case ${index + 1}: return form${index + 1}(a, b, t);`);
  });
  lines.push('    }');
  lines.push('    return -1;');
  lines.push('  }');
  lines.push('};');
  return lines.join('\n');
}

export const PARITY_INPUTS: ReadonlyArray<{ a: number; b: number; t: number }> = [
  { a: 0, b: 0, t: 1 },
  { a: 2, b: 1, t: 1 },
  { a: -1, b: 3, t: 0 },
  { a: 4, b: 4, t: 3 },
];

export interface ParityProgram {
  readonly id: string;
  readonly code: string;
  readonly functionName: string;
  readonly cases: ReadonlyArray<{ readonly id: string; readonly input: Record<string, unknown> }>;
  /** Cases recorded with a trace in the traced Run (all cases run either way). */
  readonly tracedCaseIds: readonly string[];
}

export interface ParityCase {
  readonly id: string;
  readonly status: string;
  readonly value?: unknown;
  readonly failure?: unknown;
  /** The case's first error diagnostic code. */
  readonly code?: string;
  /** Source lines with trace events, for traced cases. */
  readonly tracedLines?: readonly number[];
}

export interface ParityRun {
  readonly status?: string;
  readonly cases: readonly ParityCase[];
  readonly compileFailure?: unknown;
  /** The failed compile's first error diagnostic code. */
  readonly compileCode?: string;
  /** The failed compile's wall time as Judge reports it (ms). */
  readonly compileMs?: number;
  /** What judgeCompileExecutionOutcome returns, or the error it throws. */
  readonly compileOutcome?: { readonly kind?: string; readonly diagnosticStage?: string; readonly threw?: string; readonly code?: string; readonly reason?: string };
  readonly error?: string;
  readonly errorName?: string;
}

export interface ParitySample {
  readonly id: string;
  readonly traced: ParityRun;
  readonly untraced: ParityRun;
}

let sequence = 0;

function bundleFor(program: ParityProgram, trace: boolean) {
  sequence += 1;
  return createAlgorithmJudgeBundle({
    id: `cpp-trace-parity-${program.id}-${trace ? 'traced' : 'untraced'}-${sequence}`,
    language: 'cpp',
    code: program.code,
    functionName: program.functionName,
    executionStyle: 'solution-method',
    trace,
    cases: program.cases.map((testCase) => ({ id: testCase.id, input: structuredClone(testCase.input) })),
  });
}

function tracedLines(trace: any): number[] | undefined {
  const events = Array.isArray(trace?.events) ? trace.events : undefined;
  if (!events) return undefined;
  const lines = new Set<number>();
  for (const event of events) {
    if (typeof event?.line === 'number') lines.add(event.line);
  }
  return [...lines].sort((left, right) => left - right);
}

const errorCode = (diagnostics: any): string | undefined =>
  (Array.isArray(diagnostics) ? diagnostics : []).find((diagnostic: any) => diagnostic?.severity === 'error')?.code;

function compileMs(compile: any): number | undefined {
  const total = compile?.timings?.totalMs;
  if (typeof total === 'number') return total;
  return typeof compile?.startedAt === 'number' && typeof compile?.endedAt === 'number'
    ? compile.endedAt - compile.startedAt
    : undefined;
}

function compileOutcome(compile: any, trace: boolean): ParityRun['compileOutcome'] {
  try {
    const outcome: any = judgeCompileExecutionOutcome(compile, { language: 'cpp', trace } as never);
    return { kind: outcome.kind, diagnosticStage: outcome.diagnosticStage };
  } catch (error: any) {
    return { threw: error?.name, code: error?.code, reason: error?.reason };
  }
}

function observe(evaluation: any, trace: boolean): ParityRun {
  if (evaluation?.status === 'compile-failed') {
    return {
      status: evaluation.status,
      cases: [],
      compileFailure: JSON.parse(JSON.stringify(evaluation.compile?.failure ?? evaluation.compile ?? null)),
      compileCode: errorCode(evaluation.compile?.diagnostics),
      ...(compileMs(evaluation.compile) !== undefined ? { compileMs: compileMs(evaluation.compile) } : {}),
      compileOutcome: compileOutcome(evaluation.compile, trace),
    };
  }
  return {
    status: evaluation?.status,
    cases: (evaluation?.cases ?? []).map((testCase: any) => ({
      id: testCase.id ?? testCase.caseId,
      status: testCase.status,
      value: testCase.value,
      ...(testCase.failure ? { failure: JSON.parse(JSON.stringify(testCase.failure)) } : {}),
      ...(errorCode(testCase.diagnostics) ? { code: errorCode(testCase.diagnostics) } : {}),
      ...(testCase.trace ? { tracedLines: tracedLines(testCase.trace) } : {}),
    })),
  };
}

function thrown(error: unknown): ParityRun {
  return {
    cases: [],
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : undefined,
  };
}

export async function runParity(options: {
  readonly assetBaseUrl: string;
  readonly programs: readonly ParityProgram[];
}): Promise<ParitySample[]> {
  const host = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['cpp'] });
  const samples: ParitySample[] = [];
  try {
    for (const program of options.programs) {
      let untraced: ParityRun;
      try {
        const receipt = await host.evaluateAlgorithm({ bundle: await bundleFor(program, false) } as never);
        untraced = observe(receipt.evaluation, false);
      } catch (error) {
        untraced = thrown(error);
      }
      let traced: ParityRun;
      try {
        const executed = await host.execute({
          bundle: await bundleFor(program, true),
          interactive: true,
          tracing: { caseIds: [...program.tracedCaseIds] },
        });
        traced = observe(executed.evaluation, true);
        if (executed.executionId) await host.disposeExecution(executed.executionId);
      } catch (error) {
        traced = thrown(error);
      }
      samples.push({ id: program.id, traced, untraced });
    }
  } finally {
    host.dispose();
  }
  return samples;
}
