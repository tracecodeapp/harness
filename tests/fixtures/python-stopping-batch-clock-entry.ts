// Time to a verdict for a Python Run whose case loops forever, through the
// public BrowserJudgeHost in a real Pyodide worker.
import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';

// Binary Search that never returns once it finds the target. The loop runs
// inside C code, so the worker's line guard cannot see it: only a client
// clock can stop it, as on a page with no interrupt buffer.
const SEARCH = [
  'class Solution:',
  '    def search(self, nums, target):',
  '        left, right = 0, len(nums) - 1',
  '        while left <= right:',
  '            mid = (left + right) // 2',
  '            if nums[mid] == target:',
  '                max(iter(int, 1))',
  '                return mid',
  '            if nums[mid] < target:',
  '                left = mid + 1',
  '            else:',
  '                right = mid - 1',
  '        return -1',
].join('\n');

interface OrdinaryBatchWitness {
  readonly startedCaseIndexes: number[];
  activeCase?: { readonly index: number; readonly startedAt: number };
  stoppedCase?: { readonly index: number; readonly startedAt: number; readonly terminatedAt: number };
}

interface WorkerEnvelope {
  readonly id?: string;
  readonly protocolToken?: string;
  readonly type?: string;
  readonly payload?: { readonly mode?: string; readonly phase?: string; readonly index?: number };
}

export interface StoppingClockSample {
  readonly action: string;
  readonly runawayCase: number;
  readonly ms: number;
  readonly ordinaryBatches: readonly {
    readonly startedCaseIndexes: number[];
    readonly timeout?: { readonly caseIndex: number; readonly beforeMs: number; readonly activeMs: number; readonly afterMs: number };
  }[];
  readonly status: string;
  readonly cases: readonly Record<string, any>[];
  readonly error?: string;
}

let sequence = 0;

async function bundle(trace: boolean, caseCount: number, runawayCase: number, wallClockMs: number | undefined) {
  sequence += 1;
  return createAlgorithmJudgeBundle({
    id: `python-stopping-clock-${sequence}`,
    language: 'python',
    code: SEARCH,
    functionName: 'search',
    executionStyle: 'solution-method',
    trace,
    ...(wallClockMs !== undefined ? { limits: { wallClockMs } } : {}),
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index + 1}`,
      // Only the runaway case's target is present, so only it reaches the loop.
      input: { nums: [1, 3, 5, 7, 9], target: index + 1 === runawayCase ? 5 : 4 },
      expected: -1,
    })),
  });
}

function summarize(evaluation: any) {
  return (evaluation?.cases ?? []).map((testCase: any) =>
    testCase.status === 'not-run' || testCase.status === 'completed'
      ? { id: testCase.id ?? testCase.caseId, status: testCase.status }
      : JSON.parse(JSON.stringify({ ...testCase, trace: undefined }))
  );
}

export async function runStoppingClock(options: {
  readonly assetBaseUrl: string;
  readonly caseCount: number;
  readonly wallClockMs?: number;
  readonly scenarios: readonly { action: 'run' | 'submit-stop'; runawayCase: number }[];
}): Promise<StoppingClockSample[]> {
  const NativeWorker = globalThis.Worker;
  let batches: OrdinaryBatchWitness[] | undefined;
  globalThis.Worker = class extends NativeWorker {
    private request?: { readonly id: string; readonly token: string; readonly witness: OrdinaryBatchWitness };

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event: MessageEvent<WorkerEnvelope>) => {
        const request = this.request;
        const { id, protocolToken, type, payload } = event.data;
        if (!event.isTrusted || !request || id !== request.id || protocolToken !== request.token) return;
        if (type === 'execute-result') {
          this.request = undefined;
          return;
        }
        const { witness } = request;
        if (type !== 'batch-case-progress' || payload?.index === undefined) return;
        if (payload.phase === 'started') {
          witness.startedCaseIndexes.push(payload.index);
          witness.activeCase = { index: payload.index, startedAt: performance.now() };
        } else if (payload.phase === 'finished' && witness.activeCase?.index === payload.index) {
          witness.activeCase = undefined;
        }
      });
    }

    override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
      const { id, protocolToken, type, payload } = message as WorkerEnvelope;
      if (batches && type === 'execute-prepared-program-batch' && payload?.mode === 'code' &&
          id !== undefined && protocolToken !== undefined) {
        const witness: OrdinaryBatchWitness = { startedCaseIndexes: [] };
        batches.push(witness);
        this.request = { id, token: protocolToken, witness };
      }
      super.postMessage(message, transferOrOptions as StructuredSerializeOptions | undefined);
    }

    override terminate() {
      const witness = this.request?.witness;
      if (witness?.activeCase && !witness.stoppedCase) {
        witness.stoppedCase = { ...witness.activeCase, terminatedAt: performance.now() };
      }
      super.terminate();
    }
  };
  const host = createBrowserJudgeHost({ assetBaseUrl: options.assetBaseUrl, providers: ['python'] });
  const samples: StoppingClockSample[] = [];
  try {
    // Warm the runtime so the clock measures the run, not Pyodide's load.
    await host.evaluateAlgorithm({ bundle: await bundle(false, 1, 0, undefined) } as never);
    for (const scenario of options.scenarios) {
      batches = [];
      const startedAt = performance.now();
      let evaluation: any;
      let error: string | undefined;
      try {
        if (scenario.action === 'run') {
          const executed = await host.execute({
            bundle: await bundle(true, options.caseCount, scenario.runawayCase, options.wallClockMs),
            interactive: true,
            tracing: { caseIds: [`case-${Math.max(1, scenario.runawayCase)}`] },
          });
          evaluation = executed.evaluation;
          if (executed.executionId) await host.disposeExecution(executed.executionId);
        } else {
          const receipt = await host.evaluateAlgorithm({
            bundle: await bundle(false, options.caseCount, scenario.runawayCase, options.wallClockMs),
            stopAtFirstRunaway: true,
          } as never);
          evaluation = receipt.evaluation;
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const settledAt = performance.now();
      samples.push({
        action: scenario.action,
        runawayCase: scenario.runawayCase,
        ms: settledAt - startedAt,
        ordinaryBatches: batches.map(({ startedCaseIndexes, stoppedCase }) => ({
          startedCaseIndexes,
          ...(stoppedCase ? { timeout: {
            caseIndex: stoppedCase.index,
            beforeMs: stoppedCase.startedAt - startedAt,
            activeMs: stoppedCase.terminatedAt - stoppedCase.startedAt,
            afterMs: settledAt - stoppedCase.terminatedAt,
          } } : {}),
        })),
        status: error ? 'error' : evaluation?.status,
        cases: summarize(evaluation),
        ...(error ? { error } : {}),
      });
    }
  } finally {
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
  return samples;
}
