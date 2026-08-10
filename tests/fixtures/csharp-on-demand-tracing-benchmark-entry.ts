import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedProgram,
  TraceExecutionOptions,
} from '../../packages/runtime-contracts/src';
import type { BrowserWorkerLike } from '../../packages/runtime-browser/src/internal';
import { createCSharpRuntimeClient } from '../../packages/runtime-csharp/src/csharp-runtime-client';
import { CSharpWorkerClient } from '../../packages/runtime-csharp/src/csharp-worker-client';

export interface CSharpOnDemandFixture {
  readonly problem: string;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
  readonly cases: readonly {
    readonly id: string;
    readonly input: Record<string, unknown>;
  }[];
}

export interface CSharpOnDemandSample {
  readonly problem: string;
  readonly strategy: 'single-instrumented' | 'dual-artifact';
  readonly tracePrepareMs: number;
  readonly codePrepareMs: number;
  readonly selectedLatencyMs: number;
  readonly drainMs: number;
  readonly decisionMs: number;
  readonly createdCompilerWorkers: number;
  readonly createdRunnerWorkers: number;
  readonly eventCounts: readonly number[];
  readonly runMs: readonly (number | null)[];
  readonly outputs: readonly string[];
}

declare global {
  var runCSharpOnDemandTracingSample:
    | ((
        fixture: CSharpOnDemandFixture,
        strategy: CSharpOnDemandSample['strategy'],
        traceOptions: TraceExecutionOptions
      ) => Promise<CSharpOnDemandSample>)
    | undefined;
}

let createdCompilerWorkers = 0;
let createdRunnerWorkers = 0;
let sharedHarness:
  | {
      readonly compiler: CSharpWorkerClient;
      readonly client: ReturnType<typeof createCSharpRuntimeClient>;
      readonly activeRunners: Set<CSharpWorkerClient>;
    }
  | undefined;

function trackedWorker(
  role: 'compiler' | 'runner',
  url: string | URL,
  options?: WorkerOptions
): BrowserWorkerLike {
  const worker = new Worker(url, options);
  if (role === 'compiler') createdCompilerWorkers += 1;
  else createdRunnerWorkers += 1;
  return {
    get onmessage() {
      return worker.onmessage;
    },
    set onmessage(listener) {
      worker.onmessage = listener;
    },
    get onerror() {
      return worker.onerror;
    },
    set onerror(listener) {
      worker.onerror = listener;
    },
    postMessage(message, transfer) {
      worker.postMessage(message, transfer ?? []);
    },
    terminate() {
      worker.terminate();
    },
  };
}

function createWorkerClient(role: 'compiler' | 'runner'): CSharpWorkerClient {
  return new CSharpWorkerClient({
    workerUrl: '/workers/csharp-worker.js',
    workerFactory: (url, options) => trackedWorker(role, url, options),
    assetBaseUrl:
      role === 'compiler'
        ? '/workers/vendor/csharp'
        : '/workers/vendor/csharp-runner',
    runtimeRole: role,
    debug: false,
    initTimeoutMs: 120_000,
    executionTimeoutMs: 120_000,
    tracingTimeoutMs: 120_000,
  });
}

function getSharedHarness(): NonNullable<typeof sharedHarness> {
  if (sharedHarness) return sharedHarness;
  const compiler = createWorkerClient('compiler');
  const activeRunners = new Set<CSharpWorkerClient>();
  const client = createCSharpRuntimeClient(compiler, {
    compiler,
    batchConcurrency: 1,
    warmup: () => compiler.warmup(),
    createRunner: () => {
      const runner = createWorkerClient('runner');
      activeRunners.add(runner);
      return runner;
    },
    releaseRunner: (runner) => activeRunners.delete(runner),
  });
  sharedHarness = { compiler, client, activeRunners };
  return sharedHarness;
}

function completedOutput(result: {
  readonly kind: string;
  readonly output?: unknown;
  readonly error?: string;
}): string {
  if (result.kind !== 'completed') {
    throw new Error(result.error ?? `C# execution ended as ${result.kind}.`);
  }
  return JSON.stringify(result.output);
}

async function prepare(
  client: ReturnType<typeof createCSharpRuntimeClient>,
  fixture: CSharpOnDemandFixture,
  mode: 'code' | 'trace',
  traceOptions: TraceExecutionOptions
): Promise<{ readonly program: RuntimePreparedProgram; readonly wallMs: number }> {
  const startedAt = performance.now();
  const result = await client.prepareProgram({
    mode,
    code: fixture.code,
    functionName: fixture.functionName,
    executionStyle: fixture.executionStyle ?? 'solution-method',
    ...(mode === 'trace' ? { traceOptions } : {}),
  });
  if (result.kind !== 'prepared') {
    throw new Error(result.error ?? `C# ${mode} preparation failed.`);
  }
  return { program: result.program, wallMs: performance.now() - startedAt };
}

globalThis.runCSharpOnDemandTracingSample = async (
  fixture,
  strategy,
  traceOptions
): Promise<CSharpOnDemandSample> => {
  const compilerWorkersBefore = createdCompilerWorkers;
  const runnerWorkersBefore = createdRunnerWorkers;
  const { client } = getSharedHarness();
  let traceProgram: RuntimePreparedProgram | undefined;
  let codeProgram: RuntimePreparedProgram | undefined;
  try {
    await client.init();
    const trace = await prepare(client, fixture, 'trace', traceOptions);
    traceProgram = trace.program;
    let codePrepareMs = 0;
    if (strategy === 'dual-artifact') {
      const code = await prepare(client, fixture, 'code', traceOptions);
      codeProgram = code.program;
      codePrepareMs = code.wallMs;
    }

    const [selectedCase, ...drainCases] = fixture.cases;
    if (!selectedCase || traceProgram.mode !== 'trace') {
      throw new Error('C# benchmark requires a prepared trace program and at least one case.');
    }
    const selectedStartedAt = performance.now();
    const selected = await traceProgram.executeIsolated({
      inputs: selectedCase.input,
    });
    const selectedLatencyMs = performance.now() - selectedStartedAt;

    const drainStartedAt = performance.now();
    let drain: readonly (ExecutionResult | CodeExecutionResult)[] = [];
    if (drainCases.length > 0) {
      if (strategy === 'single-instrumented') {
        if (!traceProgram.executeBatchIsolated) {
          throw new Error('C# trace program has no isolated batch path.');
        }
        drain = await traceProgram.executeBatchIsolated({
          inputBatch: drainCases.map((testCase) => testCase.input),
          traceEnabledBatch: drainCases.map(() => false),
        });
      } else {
        if (!codeProgram || codeProgram.mode !== 'code' || !codeProgram.executeBatchIsolated) {
          throw new Error('C# dual-artifact sample has no clean batch program.');
        }
        drain = await codeProgram.executeBatchIsolated({
          inputBatch: drainCases.map((testCase) => testCase.input),
        });
      }
    }
    const drainMs = performance.now() - drainStartedAt;
    return {
      problem: fixture.problem,
      strategy,
      tracePrepareMs: trace.wallMs,
      codePrepareMs,
      selectedLatencyMs,
      drainMs,
      decisionMs: trace.wallMs + codePrepareMs + selectedLatencyMs + drainMs,
      createdCompilerWorkers: createdCompilerWorkers - compilerWorkersBefore,
      createdRunnerWorkers: createdRunnerWorkers - runnerWorkersBefore,
      eventCounts: [
        selected.trace.events.length,
        ...drain.map((result) =>
          'trace' in result && result.trace ? result.trace.events.length : 0
        ),
      ],
      runMs: [selected, ...drain].map((result) => result.timings?.runMs ?? null),
      outputs: [selected, ...drain].map(completedOutput),
    };
  } finally {
    await Promise.all([traceProgram?.dispose(), codeProgram?.dispose()]);
  }
};
