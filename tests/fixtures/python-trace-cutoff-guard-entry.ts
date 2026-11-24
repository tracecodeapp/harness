// A traced Python Run whose trace stops recording at a budget, through the
// public BrowserJudgeHost in a real Pyodide worker, with the app's trace
// budgets.
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';

// The app's Binary Search with a loop inserted where the target is found.
function search(found: readonly string[]): string {
  return [
    'class Solution:',
    '    def search(self, nums: list[int], target: int) -> int:',
    '        left = 0',
    '        right = len(nums) - 1',
    '        ',
    '        while left <= right:',
    '            mid = (left + right) // 2',
    '            ',
    '            if nums[mid] == target:',
    ...found.map((line) => `                ${line}`),
    '                return mid',
    '            elif nums[mid] < target:',
    '                left = mid + 1',
    '            else:',
    '                right = mid - 1',
    '        ',
    '        return -1',
  ].join('\n');
}

export const PROGRAMS = {
  // Never ends. Its trace fills the byte budget before any line budget.
  runaway: search(['k = 0', 'while k >= 0:', '    k = (k + 1) % 10']),
  // Ends. Its trace fills the same byte budget, then it runs on to finish.
  finishes: search([
    'k = 0',
    'steps = 0',
    'while steps < 20000:',
    '    k = (k + 1) % 10',
    '    steps += 1',
  ]),
  // Ends after 120k lines, well past its trace budget. The tracer stays
  // installed for all of them, so only the learner's lines may count toward
  // the runaway ceiling (counting the harness's helper lines too, ~14 per
  // learner line, would stop it as a runaway).
  runsLong: search(['steps = 0', 'while steps < 60000:', '    steps += 1']),
} as const;

// The app's Run settings for Python.
const TRACE_OPTIONS = {
  maxTraceSteps: 4000,
  maxLineEvents: 12000,
  maxSingleLineHits: 1000,
  maxStoredEvents: 16000,
};

const CASES = [
  { id: '1', input: { nums: [-1, 0, 3, 5, 9, 12, 15], target: 9 }, expected: 4 },
  { id: '2', input: { nums: [-1, 0, 3, 5, 9, 12, 15], target: 2 }, expected: -1 },
  { id: '3', input: { nums: [5], target: 3 }, expected: -1 },
];

export interface TraceCutoffSample {
  readonly program: keyof typeof PROGRAMS;
  readonly ms: number;
  readonly status: string;
  readonly cases: readonly Record<string, any>[];
  readonly error?: string;
}

let sequence = 0;

function summarize(evaluation: any) {
  return (evaluation?.cases ?? []).map((testCase: any) => {
    const { trace, attachment, ...rest } = testCase;
    return JSON.parse(JSON.stringify({
      ...rest,
      ...(attachment && { attachment: { status: attachment.status, reason: attachment.reason } }),
      traceEvents: trace?.events?.length ?? 0,
    }));
  });
}

export async function runTraceCutoff(options: {
  readonly assetBaseUrl: string;
  readonly programs: readonly (keyof typeof PROGRAMS)[];
}): Promise<TraceCutoffSample[]> {
  const host = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['python'] });
  const samples: TraceCutoffSample[] = [];
  try {
    for (const program of options.programs) {
      sequence += 1;
      const bundle = await createAlgorithmJudgeBundle({
        id: `python-trace-cutoff-${sequence}`,
        language: 'python',
        code: PROGRAMS[program],
        functionName: 'search',
        executionStyle: 'solution-method',
        trace: true,
        traceOptions: TRACE_OPTIONS,
        cases: CASES,
      });
      // Warm the runtime so the clock measures the run, not Pyodide's load.
      if (samples.length === 0) {
        await host.evaluateAlgorithm({ bundle: await createAlgorithmJudgeBundle({
          id: 'python-trace-cutoff-warm',
          language: 'python',
          code: search([]),
          functionName: 'search',
          executionStyle: 'solution-method',
          cases: CASES.slice(1, 2),
        }) } as never);
      }
      const startedAt = performance.now();
      let evaluation: any;
      let error: string | undefined;
      try {
        const executed = await host.execute({
          bundle,
          interactive: true,
          tracing: { caseIds: ['1'] },
        });
        evaluation = executed.evaluation;
        if (executed.executionId) await host.disposeExecution(executed.executionId);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      samples.push({
        program,
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
