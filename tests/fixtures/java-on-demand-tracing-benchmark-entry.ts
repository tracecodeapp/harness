import {
  JavaWorkerClient,
  type JavaTraceExecutionOptions,
  type JavaWorkerPreparedProgramResult,
} from '../../packages/runtime-java/src/java-worker-client';
import type {
  BrowserWorkerLike,
} from '../../packages/runtime-browser/src/internal';

export interface JavaOnDemandFixture {
  readonly problem: string;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
  readonly cases: readonly {
    readonly id: string;
    readonly input: Record<string, unknown>;
  }[];
}

export interface JavaOnDemandSample {
  readonly problem: string;
  readonly strategy: 'single-instrumented' | 'dual-artifact';
  readonly selectedCaseId: string;
  readonly selectedIndex: number;
  readonly workerInitMs: number;
  readonly tracePrepareWallMs: number;
  readonly traceCompileMs: number;
  readonly codePrepareWallMs: number;
  readonly codeCompileMs: number;
  readonly executionWallMs: number;
  readonly decisionWallMs: number;
  readonly runnerProcessCount: number;
  readonly createdWorkerCount: number;
  readonly eventCounts: readonly number[];
  readonly runMs: readonly number[];
  readonly traceProfiles: readonly (Record<string, unknown> | null)[];
  readonly outputJson: readonly string[];
}

export interface JavaOnDemandCalibration {
  readonly problem: string;
  readonly runMs: readonly number[];
  readonly heavyIndex: number;
  readonly outputJson: readonly string[];
}

declare global {
  var runJavaOnDemandTracingSample:
    | ((
        fixture: JavaOnDemandFixture,
        strategy: JavaOnDemandSample['strategy'],
        selectedIndex: number,
        traceOptions: JavaTraceExecutionOptions
      ) => Promise<JavaOnDemandSample>)
    | undefined;
  var calibrateJavaOnDemandTracing:
    | ((
        fixture: JavaOnDemandFixture,
        traceOptions: JavaTraceExecutionOptions
      ) => Promise<JavaOnDemandCalibration>)
    | undefined;
}

let createdWorkers = 0;

function trackedWorker(url: string | URL): BrowserWorkerLike {
  const worker = new Worker(url);
  createdWorkers += 1;
  let terminated = false;
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
      if (terminated) return;
      terminated = true;
      worker.terminate();
    },
  };
}

function createClient(): JavaWorkerClient {
  return new JavaWorkerClient({
    workerUrl:
      '/workers/java-runtime-worker.js?tracejvmBaseUrl=/tracejvm',
    workerFactory: trackedWorker,
    debug: false,
    tracingTimeoutMs: 120_000,
  });
}

function requireProgram(
  result: JavaWorkerPreparedProgramResult,
  mode: 'code' | 'trace'
): string {
  if (!result.success || !result.programId) {
    throw new Error(
      result.error ?? `Java ${mode} preparation did not return a program id.`
    );
  }
  return result.programId;
}

function outputJson(result: {
  kind?: string;
  success?: boolean;
  output?: unknown;
  error?: string;
}): string {
  const completed = result.kind === 'completed' || result.success === true;
  if (!completed) {
    throw new Error(
      result.error ??
        `Java execution ended as ${result.kind ?? `success=${result.success}`}.`
    );
  }
  return JSON.stringify(result.output);
}

function resultRunMs(result: { timings?: { runMs?: number } }): number {
  return Number(result.timings?.runMs ?? 0);
}

const TRACE_PROFILE_PREFIX = '__TRACECODE_TRACE_PROFILE_JSON__:';

function resultTraceProfile(result: {
  consoleOutput?: readonly string[];
}): Record<string, unknown> | null {
  const encoded = result.consoleOutput?.find((line) =>
    line.startsWith(TRACE_PROFILE_PREFIX)
  );
  if (!encoded) return null;
  const value = JSON.parse(encoded.slice(TRACE_PROFILE_PREFIX.length));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function runnerProcesses(
  results: readonly { timings?: unknown }[]
): number {
  const timings = results[0]?.timings as
    | { readonly runnerProcessCount?: unknown }
    | undefined;
  return Number(timings?.runnerProcessCount ?? 0);
}

async function prepare(
  client: JavaWorkerClient,
  fixture: JavaOnDemandFixture,
  mode: 'code' | 'trace',
  traceOptions?: JavaTraceExecutionOptions
): Promise<{
  readonly programId: string;
  readonly wallMs: number;
  readonly compileMs: number;
}> {
  const startedAt = performance.now();
  const result = await client.prepareRuntimeProgram({
    mode,
    code: fixture.code,
    functionName: fixture.functionName,
    executionStyle: fixture.executionStyle ?? 'solution-method',
    ...(mode === 'trace' && traceOptions ? { traceOptions } : {}),
  });
  return {
    programId: requireProgram(result, mode),
    wallMs: performance.now() - startedAt,
    compileMs: Number(result.timings?.compileMs ?? result.timings?.totalMs ?? 0),
  };
}

globalThis.calibrateJavaOnDemandTracing = async (
  fixture,
  traceOptions
): Promise<JavaOnDemandCalibration> => {
  const client = createClient();
  let programId: string | undefined;
  try {
    await client.warmup();
    const prepared = await prepare(client, fixture, 'trace', traceOptions);
    programId = prepared.programId;
    const results = await client.executePreparedTraceBatch(
      programId,
      {
        inputBatch: fixture.cases.map((testCase) => testCase.input),
        limits: { wallClockMs: 120_000 },
      },
      traceOptions,
      {
        traceEnabledBatch: fixture.cases.map(() => false),
      }
    );
    const runMs = results.map(resultRunMs);
    // The first case in every fresh TraceJVM runner pays class-loading startup.
    // That is a runner sunk cost, not a property of the case. Exclude it when
    // choosing the workload-heavy case so calibration measures guard-off work.
    let heavyIndex = runMs.length > 1 ? 1 : 0;
    for (let index = heavyIndex + 1; index < runMs.length; index += 1) {
      if ((runMs[index] ?? 0) > (runMs[heavyIndex] ?? 0)) heavyIndex = index;
    }
    return {
      problem: fixture.problem,
      runMs,
      heavyIndex,
      outputJson: results.map(outputJson),
    };
  } finally {
    if (programId) await client.disposePreparedRuntimeProgram(programId);
    client.terminate();
  }
};

globalThis.runJavaOnDemandTracingSample = async (
  fixture,
  strategy,
  selectedIndex,
  traceOptions
): Promise<JavaOnDemandSample> => {
  if (!Number.isInteger(selectedIndex) || !fixture.cases[selectedIndex]) {
    throw new RangeError(
      `Invalid selected Java case index ${selectedIndex} for ${fixture.problem}.`
    );
  }

  const workerStart = createdWorkers;
  const client = createClient();
  const programIds: string[] = [];
  const warmStartedAt = performance.now();
  await client.warmup();
  const workerInitMs = performance.now() - warmStartedAt;

  try {
    const decisionStartedAt = performance.now();
    const tracePreparation = await prepare(
      client,
      fixture,
      'trace',
      traceOptions
    );
    programIds.push(tracePreparation.programId);

    let codePrepareWallMs = 0;
    let codeCompileMs = 0;
    let executionWallMs = 0;
    let runnerProcessCount = 0;
    const eventCounts = new Array<number>(fixture.cases.length).fill(0);
    const runMs = new Array<number>(fixture.cases.length).fill(0);
    const traceProfiles = new Array<Record<string, unknown> | null>(
      fixture.cases.length
    ).fill(null);
    const outputs = new Array<string>(fixture.cases.length);

    if (strategy === 'single-instrumented') {
      // The product executes the selected case first, then drains the rest.
      // Keep results in fixture order so both strategies remain comparable.
      const executionOrder = [
        selectedIndex,
        ...fixture.cases.flatMap((_, index) =>
          index === selectedIndex ? [] : [index]
        ),
      ];
      const executionStartedAt = performance.now();
      const results = await client.executePreparedTraceBatch(
        tracePreparation.programId,
        {
          inputBatch: executionOrder.map(
            (index) => fixture.cases[index]!.input
          ),
          limits: { wallClockMs: 120_000 },
        },
        traceOptions,
        {
          traceEnabledBatch: executionOrder.map(
            (index) => index === selectedIndex
          ),
        }
      );
      executionWallMs = performance.now() - executionStartedAt;
      runnerProcessCount = runnerProcesses(results);
      for (let offset = 0; offset < results.length; offset += 1) {
        const index = executionOrder[offset]!;
        const result = results[offset]!;
        eventCounts[index] = result.trace.events.length;
        runMs[index] = resultRunMs(result);
        traceProfiles[index] = resultTraceProfile(result);
        outputs[index] = outputJson(result);
      }
    } else {
      const codePreparation = await prepare(client, fixture, 'code');
      programIds.push(codePreparation.programId);
      codePrepareWallMs = codePreparation.wallMs;
      codeCompileMs = codePreparation.compileMs;

      const executionStartedAt = performance.now();
      const selectedResult = await client.executePreparedTraceBatch(
        tracePreparation.programId,
        {
          inputBatch: [fixture.cases[selectedIndex]!.input],
          limits: { wallClockMs: 120_000 },
        },
        traceOptions
      );
      runnerProcessCount += runnerProcesses(selectedResult);
      const traced = selectedResult[0]!;
      eventCounts[selectedIndex] = traced.trace.events.length;
      runMs[selectedIndex] = resultRunMs(traced);
      traceProfiles[selectedIndex] = resultTraceProfile(traced);
      outputs[selectedIndex] = outputJson(traced);

      const unselectedIndices = fixture.cases.flatMap((_, index) =>
        index === selectedIndex ? [] : [index]
      );
      const codeResults = await client.executePreparedCodeBatch(
        codePreparation.programId,
        {
          inputBatch: unselectedIndices.map(
            (index) => fixture.cases[index]!.input
          ),
          limits: { wallClockMs: 120_000 },
        }
      );
      runnerProcessCount += runnerProcesses(codeResults);
      for (let offset = 0; offset < codeResults.length; offset += 1) {
        const index = unselectedIndices[offset]!;
        const result = codeResults[offset]!;
        runMs[index] = resultRunMs(result);
        traceProfiles[index] = resultTraceProfile(result);
        outputs[index] = outputJson(result);
      }
      executionWallMs = performance.now() - executionStartedAt;
    }

    const decisionWallMs = performance.now() - decisionStartedAt;
    if (eventCounts[selectedIndex] <= 0) {
      throw new Error(
        `Selected Java case ${fixture.cases[selectedIndex]!.id} emitted no events.`
      );
    }
    if (
      eventCounts.some((count, index) =>
        index !== selectedIndex && count !== 0
      )
    ) {
      throw new Error('An unselected Java case emitted trace events.');
    }

    return {
      problem: fixture.problem,
      strategy,
      selectedCaseId: fixture.cases[selectedIndex]!.id,
      selectedIndex,
      workerInitMs,
      tracePrepareWallMs: tracePreparation.wallMs,
      traceCompileMs: tracePreparation.compileMs,
      codePrepareWallMs,
      codeCompileMs,
      executionWallMs,
      decisionWallMs,
      runnerProcessCount,
      createdWorkerCount: createdWorkers - workerStart,
      eventCounts,
      runMs,
      traceProfiles,
      outputJson: outputs,
    };
  } finally {
    for (const programId of programIds) {
      await client.disposePreparedRuntimeProgram(programId);
    }
    client.terminate();
  }
};
