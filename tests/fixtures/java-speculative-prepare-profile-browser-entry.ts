import {
  createJavaPreparedExecutionProvider,
} from '../../packages/runtime-java/src/java-prepared-provider';
import {
  JavaWorkerClient,
} from '../../packages/runtime-java/src/java-worker-client';
import type {
  BrowserWorkerLike,
} from '../../packages/runtime-browser/src/internal';
import type {
  RuntimeExecutionTimings,
  RuntimePreparedTraceProgram,
} from '../../packages/runtime-contracts/src';

interface ResponsivenessProfile {
  readonly wallMs: number;
  readonly intervalSamples: number;
  readonly maxTimerDelayMs: number;
  readonly p95TimerDelayMs: number;
  readonly longTaskSupported: boolean;
  readonly longTaskCount: number;
  readonly longTaskTotalMs: number;
  readonly longTaskMaxMs: number;
}

interface BrowserMemorySnapshot {
  readonly performanceMemory?: {
    readonly usedJSHeapSize: number;
    readonly totalJSHeapSize: number;
    readonly jsHeapSizeLimit: number;
  };
  readonly userAgentSpecificMemory?: {
    readonly bytes: number;
    readonly breakdown: ReadonlyArray<{
      readonly bytes: number;
      readonly types: readonly string[];
    }>;
  };
  readonly userAgentSpecificMemoryError?: string;
}

interface ProfileApi {
  environment(): {
    readonly userAgent: string;
    readonly crossOriginIsolated: boolean;
    readonly hardwareConcurrency: number;
    readonly deviceMemory?: number;
  };
  snapshotMemory(detailed: boolean): Promise<BrowserMemorySnapshot>;
  init(): Promise<{
    readonly result: { success: boolean; loadTimeMs: number };
    readonly responsiveness: ResponsivenessProfile;
  }>;
  prepare(revision: string): Promise<{
    readonly timings?: RuntimeExecutionTimings;
    readonly responsiveness: ResponsivenessProfile;
  }>;
  execute(): Promise<{
    readonly success: boolean;
    readonly outputs: unknown[];
    readonly eventCounts: number[];
    readonly timings: Array<RuntimeExecutionTimings | undefined>;
    readonly responsiveness: ResponsivenessProfile;
  }>;
  disposePrepared(): Promise<void>;
  shutdown(): Promise<void>;
}

declare global {
  var javaSpeculativePrepareProfile: ProfileApi | undefined;
}

let createdWorkers = 0;
let terminatedWorkers = 0;

function trackedWorker(url: string | URL): BrowserWorkerLike {
  const worker = new Worker(url);
  worker.addEventListener('error', (event) => {
    console.error('[java-speculative-profile] worker error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
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
      if (!terminated) {
        terminated = true;
        terminatedWorkers += 1;
      }
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

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function profileResponsiveness<Result>(
  operation: () => Promise<Result>
): Promise<{ result: Result; responsiveness: ResponsivenessProfile }> {
  const intervalMs = 16;
  const timerDelays: number[] = [];
  const longTasks: number[] = [];
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    timerDelays.push(Math.max(0, now - previousTick - intervalMs));
    previousTick = now;
  }, intervalMs);
  const longTaskSupported = typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask');
  const observer = longTaskSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      })
    : undefined;
  observer?.observe({ entryTypes: ['longtask'] });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const startedAt = performance.now();
  try {
    const result = await operation();
    return {
      result,
      responsiveness: {
        wallMs: performance.now() - startedAt,
        intervalSamples: timerDelays.length,
        maxTimerDelayMs: Math.max(0, ...timerDelays),
        p95TimerDelayMs: percentile(timerDelays, 0.95),
        longTaskSupported,
        longTaskCount: longTasks.length,
        longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        longTaskMaxMs: Math.max(0, ...longTasks),
      },
    };
  } finally {
    clearInterval(timer);
    observer?.disconnect();
  }
}

function sourceForRevision(revision: string): string {
  return [
    'import java.util.*;',
    'class Solution {',
    '  public int[] twoSum(int[] nums, int target) {',
    '    Map<Integer, Integer> seen = new HashMap<>();',
    '    for (int i = 0; i < nums.length; i++) {',
    '      int needed = target - nums[i];',
    '      if (seen.containsKey(needed)) return new int[]{seen.get(needed), i};',
    '      seen.put(nums[i], i);',
    '    }',
    '    return new int[0];',
    '  }',
    `  // speculative-profile-revision:${revision.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    '}',
  ].join('\n');
}

const inputBatch = [
  { nums: [2, 7, 11, 15], target: 9 },
  { nums: [3, 2, 4], target: 6 },
  { nums: [-1, -2, -3, -4, -5], target: -8 },
  { nums: [0, 4, 3, 0], target: 0 },
  { nums: [5, 75, 25], target: 100 },
  { nums: [-10, 20, 30, 40], target: 10 },
  { nums: [1_000_000_000, -1_000_000_000, 123, 456], target: 0 },
  { nums: [4, 4, 8, 16], target: 8 },
  { nums: [1, 3, 5, 7, 9, 11], target: 20 },
  { nums: [12, -7, 6, 15, -3, 9, 4], target: 2 },
];

const provider = createJavaPreparedExecutionProvider({
  createWorkerClient: createClient,
});
let preparedProgram: RuntimePreparedTraceProgram | undefined;

async function snapshotMemory(detailed: boolean): Promise<BrowserMemorySnapshot> {
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    }
  ).memory;
  const result: BrowserMemorySnapshot = {
    ...(memory
      ? {
          performanceMemory: {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          },
        }
      : {}),
  };
  if (!detailed) return result;
  const measure = (
    performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{
        bytes: number;
        breakdown?: Array<{ bytes: number; types?: string[] }>;
      }>;
    }
  ).measureUserAgentSpecificMemory;
  if (typeof measure !== 'function') return result;
  try {
    const measurement = await measure.call(performance);
    return {
      ...result,
      userAgentSpecificMemory: {
        bytes: measurement.bytes,
        breakdown: (measurement.breakdown ?? []).map((entry) => ({
          bytes: entry.bytes,
          types: entry.types ?? [],
        })),
      },
    };
  } catch (error) {
    return {
      ...result,
      userAgentSpecificMemoryError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

globalThis.javaSpeculativePrepareProfile = {
  environment() {
    const deviceMemory = (
      navigator as Navigator & { deviceMemory?: number }
    ).deviceMemory;
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      ...(deviceMemory === undefined ? {} : { deviceMemory }),
    };
  },
  snapshotMemory,
  async init() {
    const profiled = await profileResponsiveness(() => provider.init());
    return {
      result: profiled.result,
      responsiveness: profiled.responsiveness,
    };
  },
  async prepare(revision) {
    if (preparedProgram) {
      throw new Error('Dispose the current speculative preparation before preparing another revision.');
    }
    const profiled = await profileResponsiveness(() =>
      provider.prepareProgram({
        mode: 'trace',
        code: sourceForRevision(revision),
        functionName: 'twoSum',
        executionStyle: 'solution-method',
        traceOptions: { maxStoredEvents: 20_000 },
      })
    );
    const preparation = profiled.result;
    if (
      preparation.kind !== 'prepared' ||
      preparation.program.mode !== 'trace'
    ) {
      throw new Error(
        preparation.kind === 'failed'
          ? preparation.error
          : 'Java speculative preparation did not return a trace program.'
      );
    }
    preparedProgram = preparation.program;
    return {
      timings: preparation.timings,
      responsiveness: profiled.responsiveness,
    };
  },
  async execute() {
    const program = preparedProgram;
    if (!program?.executeBatchIsolated) {
      throw new Error('Prepare a Java trace program with batch execution before running it.');
    }
    const profiled = await profileResponsiveness(() =>
      program.executeBatchIsolated!({ inputBatch })
    );
    const results = profiled.result;
    return {
      success: results.length === inputBatch.length &&
        results.every((result) => result.kind === 'completed'),
      outputs: results.map((result) =>
        result.kind === 'completed' ? result.output : undefined
      ),
      eventCounts: results.map((result) => result.trace.events.length),
      timings: results.map((result) => result.timings),
      responsiveness: profiled.responsiveness,
    };
  },
  async disposePrepared() {
    const program = preparedProgram;
    preparedProgram = undefined;
    await program?.dispose();
  },
  async shutdown() {
    await this.disposePrepared();
    provider.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (terminatedWorkers !== createdWorkers) {
      throw new Error(
        `Java profiling worker leak: created ${createdWorkers}, terminated ${terminatedWorkers}.`
      );
    }
  },
};
