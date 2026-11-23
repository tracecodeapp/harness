import { createAlgorithmJudgeBundle } from '../../src/judge';
import { createBrowserJudgeHostFromRuntimeHost } from '../../src/internal/browser-judge';
import { createBrowserRuntimeHost } from '../../packages/runtime-browser/src/browser-runtime-host';
import { createBrowserRuntimeProviderRegistry } from '../../packages/runtime-browser/src/runtime-provider-registry';
import { createJavaBrowserRuntimeProvider } from '../../packages/runtime-java/src/browser-runtime-provider';
import { JavaWorkerClient } from '../../packages/runtime-java/src/java-worker-client';
import {
  createJavaBrowserPreparedExecutionProvider,
  createJavaJudgeReceiptProvider,
  type JavaPreparedExecutionProvider,
} from '../../packages/runtime-java/src/java-prepared-provider';
import type { JudgeReceiptProvider } from '../../packages/runtime-browser/src/browser-runtime-host-internal';

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

  // Keep the #77 mixed-artifact regression independent of receipt registration.
  const legacy = createJavaBrowserRuntimeProvider({ runtimeAssetBaseUrl: '/tracejvm/' });
  const providerRegistry = createBrowserRuntimeProviderRegistry([{
    ...legacy,
    create(context) {
      const { preparedProviders, preflightLanguage, disposeLanguage, dispose } = legacy.create(context);
      return { preparedProviders, preflightLanguage, disposeLanguage, dispose };
    },
  }]);
  const host = createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    assetBaseUrl: '/workers',
    assets: { javaWorker: workerUrl },
    providers: ['java'],
    providerRegistry,
  }));
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

export async function runJavaCompanionBrowserTest() {
  const requests: Array<{ worker: number; type: string; observer?: boolean; count?: number }> = [];
  const observerRunners: Array<{ count?: number; reused?: boolean }> = [];
  let workers = 0;
  const provider = createJavaBrowserPreparedExecutionProvider({
    workerUrl: workerUrl + '?tracejvmBaseUrl=/tracejvm/',
    tracingTimeoutMs: 1_500,
    workerFactory(url) {
      const worker = new Worker(url);
      const id = ++workers;
      worker.addEventListener('message', ({ data }) => {
        if (id !== 2 || data?.type !== 'execute-prepared-runtime-program-batch') return;
        const timings = data.payload?.results?.[0]?.timings;
        observerRunners.push({ count: timings?.runnerProcessCount, reused: timings?.runnerReused });
      });
      const send = worker.postMessage.bind(worker);
      worker.postMessage = (message, options?) => {
        requests.push({
          worker: id, type: message.type, observer: message.payload?.observerOnly,
          count: message.payload?.inputBatch?.length,
        });
        send(message, options as StructuredSerializeOptions);
      };
      return worker;
    },
  });
  const descriptor = {
    code: `class Solution {
      private static int executions;
      public int solve(int n) {
        System.out.println("ordinary " + n);
        if (n == 0) throw new IllegalStateException("expected");
        if (n < 0) while (true) {}
        int result = n + ++executions;
        for (int i = 0; i < n; i++) {
          result += 0;
        }
        return result;
      }
    }`,
    functionName: 'solve',
    executionStyle: 'solution-method' as const,
  };
  const ordinaryPending = provider.prepareProgram({ ...descriptor, mode: 'code' });
  const observer = provider.prepareObservation(descriptor);
  const draw = (n: number, traceOptions?: import('../../packages/runtime-contracts/src').TraceExecutionOptions) =>
    observer.observe({ program: descriptor, inputs: { n }, traceOptions, attemptToken: 'browser-' + n });
  const ordinary = await ordinaryPending;
  try {
    if (ordinary.kind !== 'prepared' || ordinary.program.mode !== 'code') {
      throw new Error('Java ordinary preparation failed');
    }
    const admission: number[] = [];
    const caseDrawings: Array<ReturnType<typeof draw>> = [];
    const call = {
      inputBatch: [{ n: 0 }, { n: 1 }, { n: -1 }, { n: 2 }],
      limits: { wallClockMs: 800 },
      stopAtFirstRunaway: true,
      onCaseStarted(index: number) {
        admission.push(index);
        if (index === 0) caseDrawings.push(draw(0));
      },
    };
    const batch = await ordinary.program.executeBatchIsolated!(call);
    const [failed, positive, nextPositive, step, byte, line, singleLine] = await Promise.all([
      caseDrawings[0], draw(1), draw(2), draw(1, { maxTraceSteps: 2 }),
      draw(1, { maxTraceBytes: 1 }), draw(1, { maxLineEvents: 1 }),
      draw(3, { maxSingleLineHits: 1 }),
    ]);
    await ordinary.program.dispose();
    const submit = await provider.prepareProgram({ ...descriptor, mode: 'code' });
    if (submit.kind !== 'prepared' || submit.program.mode !== 'code') {
      throw new Error('Java Submit preparation failed');
    }
    const submitResult = await submit.program.executeBatchIsolated!({ inputBatch: [{ n: 2 }] });
    await submit.program.dispose();
    return {
      admission,
      outcomes: batch.map((item) => ([item.kind, item.consoleOutput,
        item.kind === 'completed' ? item.output : item.kind === 'limit' ? item.reason : undefined])),
      failed, positive, nextPositive, step, byte, line, singleLine, requests, workers, observerRunners,
      cache: [ordinary.timings, submit.timings].map((timings) =>
        [timings?.compileCacheHit, timings?.artifactCacheHit]),
      submit: submitResult.map((item) => item.kind === 'completed' ? item.output : item.kind),
    };
  } finally {
    await observer.dispose();
    if (ordinary.kind === 'prepared') await ordinary.program.dispose();
    provider.dispose();
  }
}

export async function runJavaJournalBrowserTest() {
  type Marker = Parameters<NonNullable<JudgeReceiptProvider['mark']>>[0];
  const journal: Marker[] = [];
  const starts: number[] = [];
  const replies: string[] = [];
  const ordinaryBatches: Array<{ requested: boolean; starts: number[]; terminal?: number[] }> = [];
  const bridge = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
  Object.defineProperty(globalThis, bridge, {
    configurable: true, value: { onEvent: (event: Marker) => journal.push(event) },
  });
  const NativeWorker = globalThis.Worker;
  const batchType = 'execute-prepared-runtime-program-batch';
  let batchCommands = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const pending = new Map<string, {
        protocolToken: string;
        attemptToken?: string;
        admissionId?: number;
        ordinary?: typeof ordinaryBatches[number];
      }>();
      this.addEventListener('message', ({ data, isTrusted }) => {
        const request = pending.get(data?.id);
        if (!isTrusted || !request || !request.protocolToken || request.protocolToken !== data.protocolToken) return;
        if (data.type === 'runtime-progress' && data.payload?.stage === 'ordinary-case-started') {
          const { admissionId, caseIndex } = data.payload.detail;
          if (request.ordinary && request.admissionId !== undefined && admissionId === request.admissionId) {
            starts.push(caseIndex);
            request.ordinary.starts.push(caseIndex);
          }
        }
        if (data.type === batchType) {
          pending.delete(data.id);
          if (request.ordinary) request.ordinary.terminal = data.payload?.startedCaseIndexes;
          const row = data.payload?.results?.[0];
          if (request.attemptToken && row?.success && row.observation?.attemptToken === request.attemptToken) {
            replies.push(request.attemptToken);
          }
        }
      });
      this.postMessage = (message, transfer?) => {
        if (message?.type === batchType) {
          batchCommands++;
          const { admissionId, attemptToken } = message.payload;
          const ordinary = attemptToken === undefined ? { requested: Number.isSafeInteger(admissionId), starts: [] } : undefined;
          if (ordinary) ordinaryBatches.push(ordinary);
          pending.set(message.id, {
            protocolToken: message.protocolToken, attemptToken, admissionId, ordinary,
          });
        }
        super.postMessage(message, transfer as StructuredSerializeOptions);
      };
    }
  };
  const java = createJavaBrowserRuntimeProvider({ runtimeAssetBaseUrl: '/tracejvm/' });
  const providerRegistry = createBrowserRuntimeProviderRegistry([{
    ...java,
    create(context) {
      const lease = java.create(context);
      const prepared = lease.preparedProviders!.get('java') as JavaPreparedExecutionProvider;
      return { ...lease, judgeReceiptProviders: new Map([['java', createJavaJudgeReceiptProvider(prepared, 'test')]]) };
    },
  }]);
  const host = createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    assetBaseUrl: '/workers', assets: { javaWorker: workerUrl }, providers: ['java'], providerRegistry,
  }));
  // The existing host must keep the captured callback after it is removed.
  Reflect.deleteProperty(globalThis, bridge);
  try {
    const bundle = await createAlgorithmJudgeBundle({
      id: 'java-journal', language: 'java', code: source, functionName: 'search',
      executionStyle: 'solution-method', trace: true, limits: { wallClockMs: 800 },
      cases: [0, -1, 2].map((target, i) => ({ id: 'ABC'[i]!, input: { nums: [0, 2], target }, expected: i })),
    });
    const initial = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['A'] } });
    if (!initial.executionId) throw new Error('Java Run did not retain the execution');
    const beforeRedraw = { journal: journal.length, commands: batchCommands };
    const redraw = await host.execute({ executionId: initial.executionId, tracing: { caseIds: ['A'] } });
    const redrawBatchCommands = batchCommands;
    const initialJournal = [...journal];
    const initialStarts = [...starts];
    const initialReplies = [...replies];
    const submitBundle = (trace: boolean, targets: readonly number[]) => createAlgorithmJudgeBundle({
      id: trace ? 'java-traced-submit-ack' : 'java-nonstopping-submit-ack',
      language: 'java', code: source, functionName: 'search', executionStyle: 'solution-method',
      trace, limits: { wallClockMs: 800 },
      cases: targets.map((target, i) => ({ id: 'ABC'[i]!, input: { nums: [0, 2], target }, expected: i })),
    });
    const nonstopping = await host.evaluateAlgorithm({
      bundle: await submitBundle(false, [0, -1, 2]), stopAtFirstRunaway: false,
    });
    const traced = await host.evaluateAlgorithm({ bundle: await submitBundle(true, [0, 2]) });
    return {
      journal: initialJournal, starts: initialStarts, replies: initialReplies, beforeRedraw,
      batchCommands: redrawBatchCommands, digest: bundle.workspaceDigest, ordinaryBatches,
      statuses: initial.evaluation.cases.map(({ status }) => status),
      nonstoppingStatuses: nonstopping.evaluation.cases.map(({ status }) => status),
      tracedStatuses: traced.evaluation.cases.map(({ status, attachment }) => [status, attachment?.status]),
      attachment: initial.evaluation.cases[0]?.attachment,
      redraw: redraw.evaluation.cases[0]?.attachment,
    };
  } finally {
    host.dispose();
    globalThis.Worker = NativeWorker;
  }
}

declare global {
  var javaStoppingBatchProbe: typeof runJavaStoppingBatchBrowserTest;
  var javaCompanionProbe: typeof runJavaCompanionBrowserTest;
  var javaJournalProbe: typeof runJavaJournalBrowserTest;
}
globalThis.javaStoppingBatchProbe = runJavaStoppingBatchBrowserTest;
globalThis.javaCompanionProbe = runJavaCompanionBrowserTest;
globalThis.javaJournalProbe = runJavaJournalBrowserTest;
