// A C++ program's traced Run computes what its untraced evaluation computes,
// through the public BrowserJudgeHost in a real C++ worker, for every form of
// control body the tracing rewriter has to normalize (see
// tests/test-cpp-rewriter-control-bodies.ts). Programs the tracer cannot
// instrument without changing them are refused as the provider's failure.
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';

const PRELUDE = [
  '#include <string>',
  '#include <vector>',
  'using namespace std;',
  '#define BUMP(x) ((x) += 1)',
  '#define SWAP_DO(x, y) do { int tmp = (x); (x) = (y); (y) = tmp; } while (0)',
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
  /** Source lines with trace events, for traced cases. */
  readonly tracedLines?: readonly number[];
}

export interface ParityRun {
  readonly status?: string;
  readonly cases: readonly ParityCase[];
  readonly compileFailure?: unknown;
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

function observe(evaluation: any): ParityRun {
  if (evaluation?.status === 'compile-failed') {
    return {
      status: evaluation.status,
      cases: [],
      compileFailure: JSON.parse(JSON.stringify(evaluation.compile?.failure ?? evaluation.compile ?? null)),
    };
  }
  return {
    status: evaluation?.status,
    cases: (evaluation?.cases ?? []).map((testCase: any) => ({
      id: testCase.id ?? testCase.caseId,
      status: testCase.status,
      value: testCase.value,
      ...(testCase.failure ? { failure: JSON.parse(JSON.stringify(testCase.failure)) } : {}),
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
        untraced = observe(receipt.evaluation);
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
        traced = observe(executed.evaluation);
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
