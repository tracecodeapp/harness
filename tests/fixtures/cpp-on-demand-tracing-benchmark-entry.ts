import {
  CppWorkerClient,
  type CppPreparedProgramHandle,
} from '../../packages/runtime-cpp/src/cpp-worker-client';
import { TraceCCCompilerService } from '../../packages/runtime-cpp/src/tracecc-compiler-service';
import type { BrowserWorkerLike } from '../../packages/runtime-browser/src/internal';

export interface CppOnDemandFixture {
  readonly problem: string;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
  readonly cases: readonly {
    readonly id: string;
    readonly input: Record<string, unknown>;
  }[];
}

export interface CppCompilerIntegrity {
  readonly assets: readonly {
    readonly url: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

export interface CppOnDemandSample {
  readonly problem: string;
  readonly strategy: 'single-instrumented' | 'dual-artifact';
  readonly selectedCaseId: string;
  readonly selectedIndex: number;
  readonly runnerInitMs: number;
  readonly tracePrepareWallMs: number;
  readonly traceCompileMs: number;
  readonly codePrepareWallMs: number;
  readonly codeCompileMs: number;
  readonly executionWallMs: number;
  readonly decisionWallMs: number;
  readonly compilerRequests: number;
  readonly runnerWorkers: number;
  readonly eventCounts: readonly number[];
  readonly runMs: readonly number[];
  readonly outputJson: readonly string[];
  readonly traceProgramId: string;
  readonly codeProgramId?: string;
}

declare global {
  var initializeCppOnDemandTracing:
    | ((integrity: CppCompilerIntegrity) => Promise<{ warmMs: number }>)
    | undefined;
  var runCppOnDemandTracingSample:
    | ((
        fixture: CppOnDemandFixture,
        strategy: CppOnDemandSample['strategy'],
        selectedIndex: number,
        traceOptions: Record<string, unknown>
      ) => Promise<CppOnDemandSample>)
    | undefined;
  var disposeCppOnDemandTracing: (() => void) | undefined;
}

let compiler: TraceCCCompilerService | undefined;
let compilerRequests = 0;
let runnerWorkers = 0;

function trackedWorker(url: string | URL): BrowserWorkerLike {
  const href = String(url);
  if (!href.includes('traceccRole=compiler')) runnerWorkers += 1;
  const worker = new Worker(url, { type: 'module' });
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

function requireCompiler(): TraceCCCompilerService {
  if (!compiler) {
    throw new Error('C++ on-demand benchmark compiler was not initialized.');
  }
  return compiler;
}

function createClient(): CppWorkerClient {
  const trustedCompiler = requireCompiler();
  return new CppWorkerClient({
    workerUrl: '/workers/cpp-worker.js',
    workerFactory: trackedWorker,
    compilerWasmUrl: '/tracecc/tracecc-reactor.wasm',
    linkerWasmUrl: '/tracecc/tracecc-reactor.wasm',
    sysrootUrl: '/tracecc/llvm-resources.tar',
    runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
    trustedCompilerService: {
      async compileTrusted(payload, signal) {
        compilerRequests += 1;
        return trustedCompiler.compileTrusted(payload, signal);
      },
    },
    programCacheLimit: 0,
    debug: false,
    executionTimeoutMs: 120_000,
    tracingTimeoutMs: 120_000,
  });
}

function requireHandle(
  result: Awaited<ReturnType<CppWorkerClient['prepareRuntimeProgram']>>,
  mode: 'code' | 'trace'
): CppPreparedProgramHandle {
  if (result.success === false) {
    throw new Error(
      result.error ?? `C++ ${mode} preparation did not return a program handle.`
    );
  }
  if (result.handle.mode !== mode) {
    throw new Error(`C++ ${mode} preparation returned a ${result.handle.mode} handle.`);
  }
  return result.handle;
}

function outputJson(result: {
  readonly kind?: string;
  readonly output?: unknown;
  readonly error?: string;
}): string {
  if (result.kind !== 'completed') {
    throw new Error(
      result.error ?? `C++ execution ended as ${result.kind ?? 'unknown'}.`
    );
  }
  return JSON.stringify(result.output);
}

function runMs(result: { readonly timings?: { readonly runMs?: number } }): number {
  return Number(result.timings?.runMs ?? 0);
}

async function prepare(
  client: CppWorkerClient,
  fixture: CppOnDemandFixture,
  mode: 'code' | 'trace',
  traceOptions?: Record<string, unknown>
): Promise<{
  readonly handle: CppPreparedProgramHandle;
  readonly wallMs: number;
  readonly compileMs: number;
}> {
  const startedAt = performance.now();
  const result = await client.prepareRuntimeProgram({
    mode,
    code: fixture.code,
    functionName: fixture.functionName,
    executionStyle: fixture.executionStyle ?? 'solution-method',
    ...(mode === 'trace' ? { traceOptions: traceOptions as never } : {}),
  });
  return {
    handle: requireHandle(result, mode),
    wallMs: performance.now() - startedAt,
    compileMs: Number(result.timings?.compileMs ?? result.timings?.totalMs ?? 0),
  };
}

globalThis.initializeCppOnDemandTracing = async (integrity) => {
  compiler?.terminate();
  compiler = new TraceCCCompilerService({
    workerUrl: '/workers/cpp-worker.js',
    compilerUrl: '/tracecc/tracecc-reactor.wasm',
    resourcesUrl: '/tracecc/llvm-resources.tar',
    runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
    compilerIntegrity: integrity,
    workerFactory: trackedWorker,
    artifactCacheEntries: 0,
    artifactCacheBytes: 0,
    // Match createBrowserCppRuntimeProvider's product default. Compiler
    // retirement is part of the opportunity cost of issuing an extra compile.
    maxCompilesPerWorker: 64,
    requestTimeoutMs: 120_000,
    shards: {
      narrow: {
        pchUrl: '/tracecc/narrow.pch',
        pchSourceUrl: '/tracecc/narrow.source.hpp',
        runtimeObjectUrl: '/tracecc/narrow.o',
      },
      broad: {
        pchUrl: '/tracecc/broad.pch',
        pchSourceUrl: '/tracecc/broad.source.hpp',
        runtimeObjectUrl: '/tracecc/broad.o',
      },
      map: {
        pchUrl: '/tracecc/map.pch',
        pchSourceUrl: '/tracecc/map.source.hpp',
        runtimeObjectUrl: '/tracecc/map.o',
      },
    },
  });
  const startedAt = performance.now();
  // Warm each immutable PCH lane before paired timing. Which shard a program
  // selects must not decide whether its first A/B sample pays an asset load.
  await compiler.warmup('narrow');
  await compiler.warmup('broad');
  await compiler.warmup('map');
  return { warmMs: performance.now() - startedAt };
};

globalThis.runCppOnDemandTracingSample = async (
  fixture,
  strategy,
  selectedIndex,
  traceOptions
) => {
  if (!Number.isInteger(selectedIndex) || !fixture.cases[selectedIndex]) {
    throw new RangeError(
      `Invalid selected C++ case index ${selectedIndex} for ${fixture.problem}.`
    );
  }
  const compilerStart = compilerRequests;
  const runnerStart = runnerWorkers;
  const client = createClient();
  const handles: CppPreparedProgramHandle[] = [];
  const initStartedAt = performance.now();
  await client.init();
  const runnerInitMs = performance.now() - initStartedAt;

  try {
    const decisionStartedAt = performance.now();
    const tracePreparation = await prepare(
      client,
      fixture,
      'trace',
      traceOptions
    );
    handles.push(tracePreparation.handle);

    let codePreparation:
      | Awaited<ReturnType<typeof prepare>>
      | undefined;
    if (strategy === 'dual-artifact') {
      codePreparation = await prepare(client, fixture, 'code');
      handles.push(codePreparation.handle);
      if (codePreparation.handle.programId === tracePreparation.handle.programId) {
        throw new Error('C++ dual strategy reused one program id for two artifacts.');
      }
    }

    const executionOrder = [
      selectedIndex,
      ...fixture.cases.flatMap((_, index) =>
        index === selectedIndex ? [] : [index]
      ),
    ];
    const eventCounts = new Array<number>(fixture.cases.length).fill(0);
    const caseRunMs = new Array<number>(fixture.cases.length).fill(0);
    const outputs = new Array<string>(fixture.cases.length);
    const executionStartedAt = performance.now();

    if (strategy === 'single-instrumented') {
      const results = await client.executePreparedTraceBatch(
        tracePreparation.handle,
        {
          inputBatch: executionOrder.map((index) => fixture.cases[index]!.input),
          limits: { wallClockMs: 120_000 },
        },
        {
          traceEnabledBatch: executionOrder.map(
            (index) => index === selectedIndex
          ),
        }
      );
      for (let offset = 0; offset < results.length; offset += 1) {
        const index = executionOrder[offset]!;
        const result = results[offset]!;
        eventCounts[index] = result.trace.events.length;
        caseRunMs[index] = runMs(result);
        outputs[index] = outputJson(result);
      }
    } else {
      const traced = await client.executePreparedTrace(
        tracePreparation.handle,
        {
          inputs: fixture.cases[selectedIndex]!.input,
          limits: { wallClockMs: 120_000 },
        }
      );
      eventCounts[selectedIndex] = traced.trace.events.length;
      caseRunMs[selectedIndex] = runMs(traced);
      outputs[selectedIndex] = outputJson(traced);

      for (const index of executionOrder.slice(1)) {
        const result = await client.executePreparedCode(
          codePreparation!.handle,
          {
            inputs: fixture.cases[index]!.input,
            limits: { wallClockMs: 120_000 },
          }
        );
        caseRunMs[index] = runMs(result);
        outputs[index] = outputJson(result);
      }
    }

    const executionWallMs = performance.now() - executionStartedAt;
    const decisionWallMs = performance.now() - decisionStartedAt;
    if (eventCounts[selectedIndex] <= 0) {
      throw new Error(
        `Selected C++ case ${fixture.cases[selectedIndex]!.id} emitted no events.`
      );
    }
    if (eventCounts.some((count, index) => index !== selectedIndex && count !== 0)) {
      throw new Error('An unselected C++ case emitted trace events.');
    }
    const requests = compilerRequests - compilerStart;
    const expectedRequests = strategy === 'single-instrumented' ? 1 : 2;
    if (requests !== expectedRequests) {
      throw new Error(
        `${strategy} issued ${requests} compiler requests instead of ${expectedRequests}.`
      );
    }
    const workers = runnerWorkers - runnerStart;
    if (workers !== 1) {
      throw new Error(`${strategy} created ${workers} learner runners instead of one.`);
    }

    return {
      problem: fixture.problem,
      strategy,
      selectedCaseId: fixture.cases[selectedIndex]!.id,
      selectedIndex,
      runnerInitMs,
      tracePrepareWallMs: tracePreparation.wallMs,
      traceCompileMs: tracePreparation.compileMs,
      codePrepareWallMs: codePreparation?.wallMs ?? 0,
      codeCompileMs: codePreparation?.compileMs ?? 0,
      executionWallMs,
      decisionWallMs,
      compilerRequests: requests,
      runnerWorkers: workers,
      eventCounts,
      runMs: caseRunMs,
      outputJson: outputs,
      traceProgramId: tracePreparation.handle.programId,
      ...(codePreparation
        ? { codeProgramId: codePreparation.handle.programId }
        : {}),
    } satisfies CppOnDemandSample;
  } finally {
    for (const handle of handles) {
      await client.disposePreparedProgram(handle).catch(() => undefined);
    }
    client.terminate();
  }
};

globalThis.disposeCppOnDemandTracing = () => {
  compiler?.terminate();
  compiler = undefined;
};
