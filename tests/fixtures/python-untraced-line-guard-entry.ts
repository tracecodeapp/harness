// Untraced Python line guard, through the public BrowserJudgeHost in a real
// Pyodide worker: a correct program that runs a lot of lines must finish,
// and a loop that never ends must still be stopped by the guard.
import { createAlgorithmJudgeBundle } from '../../src/judge';
import { createBrowserJudgeHost } from '../../src/judge/browser';

// count(n) runs 3n + 3 lines for n >= 0, n + 1 of them on the `while` line.
// A negative n loops forever on two lines.
const COUNT = [
  'class Solution:',
  '    def count(self, n):',
  '        if n < 0:',
  '            k = 0',
  '            while k < 10:',
  '                k = (k + 1) % 10',
  '        total = 0',
  '        i = 0',
  '        while i < n:',
  '            total += i',
  '            i += 1',
  '        return total',
].join('\n');

export const HEAVY_N = 400_000;

export interface LineGuardSample {
  readonly action: 'submit' | 'run';
  readonly ms: number;
  readonly status: string;
  readonly cases: readonly Record<string, any>[];
  readonly error?: string;
}

let sequence = 0;

async function bundle(trace: boolean) {
  sequence += 1;
  return createAlgorithmJudgeBundle({
    id: `python-untraced-line-guard-${sequence}`,
    language: 'python',
    code: COUNT,
    functionName: 'count',
    executionStyle: 'solution-method',
    trace,
    cases: [
      { id: 'heavy', input: { n: HEAVY_N }, expected: (HEAVY_N * (HEAVY_N - 1)) / 2 },
      { id: 'small', input: { n: 4 }, expected: 6 },
      { id: 'runaway', input: { n: -1 }, expected: 0 },
    ],
  });
}

function summarize(evaluation: any) {
  return (evaluation?.cases ?? []).map((testCase: any) => JSON.parse(JSON.stringify({
    id: testCase.caseId ?? testCase.id,
    status: testCase.status,
    verdict: testCase.verdict?.kind,
    failure: testCase.failure,
    runMs: testCase.timings?.runMs,
  })));
}

export async function runLineGuard(options: { readonly assetBaseUrl: string }): Promise<LineGuardSample[]> {
  const host = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['python'] });
  const samples: LineGuardSample[] = [];
  try {
    // Warm the runtime so the timings measure the cases, not Pyodide's load.
    await host.evaluateAlgorithm({ bundle: await bundle(false) } as never);
    for (const action of ['submit', 'run'] as const) {
      const startedAt = performance.now();
      let evaluation: any;
      let error: string | undefined;
      try {
        if (action === 'submit') {
          // As the app's Submit sends it: untraced, no limits, every case runs.
          evaluation = (await host.evaluateAlgorithm({ bundle: await bundle(false) } as never)).evaluation;
        } else {
          // A Run traces the selected case; the others run untraced.
          const executed = await host.execute({
            bundle: await bundle(true),
            interactive: true,
            tracing: { caseIds: ['small'] },
          });
          evaluation = executed.evaluation;
          if (executed.executionId) await host.disposeExecution(executed.executionId);
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      samples.push({
        action,
        ms: performance.now() - startedAt,
        status: error ? 'error' : evaluation?.status,
        cases: summarize(evaluation),
        ...(error ? { error } : {}),
      });
    }
  } finally {
    host.dispose();
  }
  return samples;
}
