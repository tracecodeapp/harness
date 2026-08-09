import type {
  CodeExecutionResult,
  ExecutionResult,
  RuntimePreparedProgram,
  TraceExecutionOptions,
} from '../../packages/runtime-contracts/src';
import type { BrowserWorkerLike } from '../../packages/runtime-browser/src/internal';
import {
  JavaScriptWorkerClient,
  type JavaScriptWorkerLanguage,
} from '../../packages/runtime-javascript/src/javascript-worker-client';

export interface JavaScriptOnDemandFixture {
  readonly problem: string;
  readonly language: JavaScriptWorkerLanguage;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle?: 'function' | 'solution-method' | 'ops-class';
  readonly cases: readonly {
    readonly id: string;
    readonly input: Record<string, unknown>;
  }[];
}

export interface JavaScriptOnDemandSample {
  readonly problem: string;
  readonly language: JavaScriptWorkerLanguage;
  readonly strategy: 'single-artifact' | 'dual-artifact';
  readonly tracePrepareMs: number;
  readonly codePrepareMs: number;
  readonly selectedLatencyMs: number;
  readonly drainMs: number;
  readonly totalMs: number;
  readonly createdWorkerCount: number;
  readonly eventCounts: readonly number[];
  readonly outputs: readonly string[];
}

declare global {
  var runJavaScriptOnDemandTracingSample:
    | ((
        fixture: JavaScriptOnDemandFixture,
        strategy: JavaScriptOnDemandSample['strategy'],
        traceOptions: TraceExecutionOptions
      ) => Promise<JavaScriptOnDemandSample>)
    | undefined;
}

let createdWorkers = 0;

function trackedWorker(url: string | URL): BrowserWorkerLike {
  const worker = new Worker(url);
  createdWorkers += 1;
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

function completedOutput(result: {
  readonly kind: string;
  readonly output?: unknown;
  readonly error?: string;
}): string {
  if (result.kind !== 'completed') {
    throw new Error(result.error ?? `Execution ended as ${result.kind}.`);
  }
  return JSON.stringify(result.output);
}

async function prepare(
  client: JavaScriptWorkerClient,
  fixture: JavaScriptOnDemandFixture,
  mode: 'code' | 'trace',
  traceOptions: TraceExecutionOptions
): Promise<{ readonly program: RuntimePreparedProgram; readonly wallMs: number }> {
  const startedAt = performance.now();
  const result = await client.prepareProgram(
    {
      mode,
      code: fixture.code,
      functionName: fixture.functionName,
      executionStyle: fixture.executionStyle ?? 'solution-method',
      ...(mode === 'trace' ? { traceOptions } : {}),
    },
    fixture.language
  );
  if (result.kind !== 'prepared') {
    throw new Error(result.error ?? `${mode} preparation failed.`);
  }
  return { program: result.program, wallMs: performance.now() - startedAt };
}

globalThis.runJavaScriptOnDemandTracingSample = async (
  fixture,
  strategy,
  traceOptions
): Promise<JavaScriptOnDemandSample> => {
  createdWorkers = 0;
  const client = new JavaScriptWorkerClient({
    workerUrl: '/workers/javascript-worker.js',
    workerFactory: trackedWorker,
    debug: false,
    javascriptLibrariesUrl: '/workers/vendor/javascript-libraries.js',
    typescriptCompilerUrl: '/workers/vendor/typescript.js',
  });
  const startedAt = performance.now();
  let traceProgram: RuntimePreparedProgram | undefined;
  let codeProgram: RuntimePreparedProgram | undefined;
  try {
    await client.warmup(fixture.language);
    const traced = await prepare(client, fixture, 'trace', traceOptions);
    traceProgram = traced.program;
    let codePrepareMs = 0;
    if (strategy === 'dual-artifact') {
      const clean = await prepare(client, fixture, 'code', traceOptions);
      codeProgram = clean.program;
      codePrepareMs = clean.wallMs;
    }

    const [selectedCase, ...drainCases] = fixture.cases;
    if (!selectedCase) throw new Error('Benchmark fixture has no cases.');
    if (traceProgram.mode !== 'trace') {
      throw new Error('Trace preparation returned a clean program.');
    }
    const selectedStartedAt = performance.now();
    const selected = await traceProgram.executeIsolated({
      inputs: selectedCase.input,
    });
    const selectedLatencyMs = performance.now() - selectedStartedAt;

    const drainStartedAt = performance.now();
    let drain: readonly (ExecutionResult | CodeExecutionResult)[];
    if (drainCases.length === 0) {
      drain = [];
    } else if (strategy === 'single-artifact') {
      drain = await client.executePreparedTraceBatch(
        traceProgram,
        { inputBatch: drainCases.map((testCase) => testCase.input) },
        { traceEnabledBatch: drainCases.map(() => false) }
      );
    } else {
      if (!codeProgram || codeProgram.mode !== 'code') {
        throw new Error('Dual-artifact sample did not prepare clean code.');
      }
      const executeBatch = codeProgram.executeBatchIsolated;
      if (!executeBatch) {
        throw new Error('JavaScript clean program has no isolated batch path.');
      }
      drain = await executeBatch.call(codeProgram, {
        inputBatch: drainCases.map((testCase) => testCase.input),
      });
    }
    const drainMs = performance.now() - drainStartedAt;
    return {
      problem: fixture.problem,
      language: fixture.language,
      strategy,
      tracePrepareMs: traced.wallMs,
      codePrepareMs,
      selectedLatencyMs,
      drainMs,
      totalMs: performance.now() - startedAt,
      createdWorkerCount: createdWorkers,
      eventCounts: [
        selected.trace.events.length,
        ...drain.map((result) =>
          'trace' in result && result.trace
            ? result.trace.events.length
            : 0
        ),
      ],
      outputs: [selected, ...drain].map(completedOutput),
    };
  } finally {
    await Promise.all([
      traceProgram?.dispose(),
      codeProgram?.dispose(),
    ]);
    client.terminate();
  }
};
