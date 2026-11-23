import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';
import { JavaWorkerClient } from '../../packages/runtime-java/src/java-worker-client';

const workerUrl = '/workers/java-runtime-worker.js';
const source = `class Solution {
  private static int calls;
  public int search(int[] nums, int target) {
    calls++;
    if (target < 0) {
      while (true) {}
    }
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
      int mid = (lo + hi) / 2;
      if (nums[mid] == target) return mid + calls - 1;
      if (nums[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}`;

export async function runJavaStoppingBatchBrowserTest() {
  type WorkerRequest = { id: string; type: string; started: number; elapsed?: number };
  type WorkerRecord = { requests: WorkerRequest[]; terminated?: boolean };
  const workers: WorkerRecord[] = [];
  const probe: Array<{ event: string; tracing?: boolean }> = [];
  const NativeWorker = globalThis.Worker;
  let abortDuringFallback: ((worker: WorkerRecord) => void) | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const preparedUrl = new URL(url, location.href);
      preparedUrl.searchParams.set('probe', '1');
      super(preparedUrl, options);
      const worker: typeof workers[number] = { requests: [] };
      const { requests } = worker;
      workers.push(worker);
      this.terminate = () => {
        worker.terminated = true;
        super.terminate();
      };
      this.addEventListener('message', ({ data }) => {
        if (data?.type === 'test-java-runner') {
          const request = requests.find(({ id }) => id === data.requestId);
          if (!request?.type.startsWith('execute-prepared')) return;
          probe.push(data.payload);
          if (data.payload.event === 'run' && data.payload.tracing === false) abortDuringFallback?.(worker);
          return;
        }
        const request = requests.find((item) => item.id === data?.id && item.type === data?.type);
        if (request) request.elapsed = performance.now() - request.started;
      });
      this.postMessage = (message, options?) => {
        if (message.id) {
          requests.push({ id: message.id, type: message.type, started: performance.now() });
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      };
    }
  };

  const host = createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    assets: { javaWorker: workerUrl },
    providers: ['java'],
    java: { runtimeAssetBaseUrl: '/tracejvm/' },
  });
  const options = {
    language: 'java' as const, code: source, functionName: 'search',
    executionStyle: 'solution-method' as const,
  };
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    nums: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], target: i * 2,
  }));
  const cases = inputs.map((input, expected) => ({ id: String(expected), input, expected }));
  const runawayCases = [cases[0]!, { ...cases[1]!, input: { ...inputs[1]!, target: -1 } }, cases[2]!];
  const summary = (start: number) => ({
    runners: probe.slice(start).filter(({ event }) => event === 'created').length,
    dispatches: probe.slice(start).filter(({ event }) => event === 'run').map(({ tracing }) => tracing),
    runnerEvents: probe.slice(start).map(({ event }) => event),
  });
  const client = new JavaWorkerClient({ workerUrl: workerUrl + '?tracejvmBaseUrl=/tracejvm/' });
  try {
    await host.warmLanguage('java');
    const happyBundle = await createAlgorithmJudgeBundle({
      ...options, id: 'java-stopping-ten-cases', trace: true, cases, limits: { wallClockMs: 60_000 },
    });
    let start = probe.length;
    const runStarted = performance.now();
    const happy = await host.execute({ bundle: happyBundle, interactive: true, tracing: { caseIds: ['0'] } });
    const happyLifecycle = {
      ...summary(start),
      elapsedMs: performance.now() - runStarted,
      workers: workers.length,
      requests: workers.flatMap(({ requests }) => requests.map(({ type, elapsed }) => ({ type, elapsed }))),
    };
    if (!happy.executionId) throw new Error('Java Run failed to retain the prepared program.');
    start = probe.length;
    const requestCount = happyLifecycle.requests.length;
    const continuation = await host.execute({ executionId: happy.executionId, tracing: { caseIds: ['1'] } });
    const continuationLifecycle = {
      ...summary(start), workers: workers.length, terminated: workers.some(({ terminated }) => terminated),
      requests: workers.flatMap(({ requests }) => requests).slice(requestCount).map(({ type }) => type),
    };
    await host.disposeExecution(happy.executionId);

    const bound = 800;
    const stopRuns = [];
    for (const selection of ['0', '1', undefined]) {
      const bundle = await createAlgorithmJudgeBundle({
        ...options, id: 'java-runaway-' + selection, trace: selection !== undefined,
        cases: runawayCases, limits: { wallClockMs: bound },
      });
      start = probe.length;
      const requestStart = workers.flatMap(({ requests }) => requests).length;
      const receipt = selection === undefined
        ? await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true })
        : await host.execute({ bundle, stopAtFirstRunaway: true, tracing: { caseIds: [selection] } });
      const requests = workers.flatMap(({ requests }) => requests).slice(requestStart)
        .filter(({ type }) => type.startsWith('execute-prepared'));
      stopRuns.push({ selection, ...summary(start), cases: receipt.evaluation.cases, requests });
    }

    const prepared = await client.prepareRuntimeProgram({ ...options, mode: 'trace' });
    if (!prepared.success || !prepared.programId) throw new Error(prepared.error);
    start = probe.length;
    const nonstopping = await client.executePreparedTraceBatch(prepared.programId, {
      inputBatch: runawayCases.map(({ input }) => input),
      traceEnabledBatch: [false, false, false],
      limits: { wallClockMs: bound },
    });
    const nonstoppingLifecycle = summary(start);
    await client.disposePreparedRuntimeProgram(prepared.programId);

    const fallback = await client.prepareRuntimeProgram({
      ...options, mode: 'trace', traceOptions: { maxStoredEvents: 1 },
    });
    if (!fallback.success || !fallback.programId) throw new Error(fallback.error);
    start = probe.length;
    const truncated = await client.executePreparedTraceBatch(fallback.programId, {
      inputBatch: [inputs[0]!], limits: { wallClockMs: 60_000 },
    });
    const fallbackLifecycle = summary(start);
    start = probe.length;
    const fallbackTimeout = await client.executePreparedTraceBatch(fallback.programId, {
      inputBatch: [runawayCases[1]!.input, inputs[2]!],
      traceEnabledBatch: [true, false],
      limits: { wallClockMs: bound }, stopAtFirstRunaway: true,
    });
    const fallbackTimeoutLifecycle = summary(start);

    const abortBundle = await createAlgorithmJudgeBundle({
      ...options, id: 'java-abort-during-fallback', trace: true,
      traceOptions: { maxStoredEvents: 1 },
      cases: runawayCases.slice(1),
      limits: { wallClockMs: 5_000 },
    });
    const abort = new AbortController();
    let abortedWorker: WorkerRecord | undefined;
    abortDuringFallback = (worker) => {
      abortedWorker = worker;
      abort.abort();
    };
    start = probe.length;
    let abortName: string | undefined;
    try {
      await host.execute({
        bundle: abortBundle, tracing: { caseIds: ['1'] },
        signal: abort.signal, stopAtFirstRunaway: true,
      });
    } catch (error) {
      abortName = (error as Error).name;
    }
    return {
      happy: happy.evaluation.cases, happyLifecycle,
      continuation: continuation.evaluation.cases, continuationLifecycle,
      stopRuns, bound, nonstopping, nonstoppingLifecycle,
      truncated, fallbackLifecycle, fallbackTimeout, fallbackTimeoutLifecycle,
      abortName, abortLifecycle: summary(start), abortedWorkerTerminated: abortedWorker?.terminated,
    };
  } finally {
    client.terminate();
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
}

declare global {
  var javaStoppingBatchProbe: typeof runJavaStoppingBatchBrowserTest;
}
globalThis.javaStoppingBatchProbe = runJavaStoppingBatchBrowserTest;
