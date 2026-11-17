// Correct-program timing through the public BrowserJudgeHost. Uses only APIs
// that exist in 0.19.0 as well, so the same file measures the baseline
// (an unknown evaluateAlgorithm option is ignored there).
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';
import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';

export type TimingLanguage = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';
export type TimingAction = 'run' | 'submit' | 'submit-trace' | 'submit-stop';

export const TIMING_ACTIONS: readonly TimingAction[] = ['run', 'submit', 'submit-trace', 'submit-stop'];

export interface TimingSample {
  readonly language: TimingLanguage;
  readonly action: TimingAction;
  /** First measurement on a fresh host (includes compilation). */
  readonly coldMs: number;
  /** Warm measurements on the same host. */
  readonly warmMs: readonly number[];
  readonly completedCases: number;
  readonly caseCount: number;
}

// A small, correct program: sum 0..n*100 with a loop.
const PROGRAMS: Readonly<Record<TimingLanguage, { code: string; functionName: string; executionStyle: 'function' | 'solution-method' }>> = {
  python: {
    code: ['def solve(n):', '    total = 0', '    for i in range(n * 100):', '        total += i', '    return total'].join('\n'),
    functionName: 'solve',
    executionStyle: 'function',
  },
  javascript: {
    code: ['function solve(n) {', '  let total = 0;', '  for (let i = 0; i < n * 100; i += 1) total += i;', '  return total;', '}'].join('\n'),
    functionName: 'solve',
    executionStyle: 'function',
  },
  typescript: {
    code: ['function solve(n: number): number {', '  let total = 0;', '  for (let i = 0; i < n * 100; i += 1) total += i;', '  return total;', '}'].join('\n'),
    functionName: 'solve',
    executionStyle: 'function',
  },
  java: {
    code: ['class Solution {', '  public int solve(int n) {', '    int total = 0;', '    for (int i = 0; i < n * 100; i++) total += i;', '    return total;', '  }', '}'].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
  csharp: {
    code: ['public class Solution {', '  public int Solve(int n) {', '    int total = 0;', '    for (int i = 0; i < n * 100; i++) total += i;', '    return total;', '  }', '}'].join('\n'),
    functionName: 'Solve',
    executionStyle: 'solution-method',
  },
  cpp: {
    code: ['class Solution {', 'public:', '  int solve(int n) {', '    int total = 0;', '    for (int i = 0; i < n * 100; i++) total += i;', '    return total;', '  }', '};'].join('\n'),
    functionName: 'solve',
    executionStyle: 'solution-method',
  },
};

type Host = ReturnType<typeof createBrowserJudgeHost>;

function createHost(assetBaseUrl: string, language: TimingLanguage): Host {
  return createBrowserJudgeHost({
    assetBaseUrl,
    providers: [language],
    assets: language === 'cpp'
      ? { runtimeManifests: { cpp: createTraceCCRuntimeManifest('/tracecc') } }
      : {},
    ...(language === 'cpp'
      ? { cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 } }
      : {}),
  });
}

let sequence = 0;

async function bundle(language: TimingLanguage, trace: boolean, caseCount: number) {
  sequence += 1;
  const program = PROGRAMS[language];
  return createAlgorithmJudgeBundle({
    id: `timing-${language}-${sequence}`,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    trace,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index + 1}`,
      input: { n: 3 + index },
    })),
  });
}

function completed(evaluation: { status: string; cases?: readonly { status: string }[] }): number {
  return evaluation.status === 'completed'
    ? (evaluation.cases ?? []).filter((testCase) => testCase.status === 'completed').length
    : 0;
}

async function once(host: Host, language: TimingLanguage, action: TimingAction, caseCount: number) {
  const startedAt = performance.now();
  let done = 0;
  if (action === 'run') {
    // The product's Run: an interactive traced execution, the selected case traced.
    const executed = await host.execute({
      bundle: await bundle(language, true, caseCount),
      interactive: true,
      tracing: { caseIds: ['case-1'] },
    });
    done = completed(executed.evaluation as never);
    if (executed.executionId) await host.disposeExecution(executed.executionId);
  } else {
    const receipt = await host.evaluateAlgorithm({
      bundle: await bundle(language, action === 'submit-trace', caseCount),
      ...(action === 'submit-stop' ? { stopAtFirstRunaway: true } : {}),
    } as never);
    done = completed(receipt.evaluation as never);
  }
  return { ms: performance.now() - startedAt, done };
}

export async function runTiming(options: {
  readonly assetBaseUrl: string;
  readonly language: TimingLanguage;
  readonly caseCount: number;
  readonly repeats: number;
  readonly actions?: readonly TimingAction[];
}): Promise<TimingSample[]> {
  const samples: TimingSample[] = [];
  for (const action of options.actions ?? TIMING_ACTIONS) {
    // A fresh host per action: cold includes preparation, warm is steady state.
    const host = createHost(options.assetBaseUrl, options.language);
    try {
      const cold = await once(host, options.language, action, options.caseCount);
      const warm: number[] = [];
      let done = cold.done;
      for (let index = 0; index < options.repeats; index += 1) {
        const sample = await once(host, options.language, action, options.caseCount);
        warm.push(sample.ms);
        done = Math.min(done, sample.done);
      }
      samples.push({
        language: options.language,
        action,
        coldMs: cold.ms,
        warmMs: warm,
        completedCases: done,
        caseCount: options.caseCount,
      });
    } finally {
      host.dispose();
    }
  }
  return samples;
}
