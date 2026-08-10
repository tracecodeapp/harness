import {
  JavaWorkerClient,
  type JavaTraceExecutionOptions,
} from '../../packages/runtime-java/src/java-worker-client';
import {
  createJavaPreparedExecutionProvider,
} from '../../packages/runtime-java/src/java-prepared-provider';
import type {
  BrowserWorkerLike,
} from '../../packages/runtime-browser/src/internal';
import type {
  RuntimeTraceEvent,
} from '../../packages/runtime-contracts/src/runtime-trace';

interface PreparedBrowserResult {
  createdWorkers: number;
  terminatedWorkers: number;
  isolationOutputs: unknown[];
  batchIsolationOutputs: unknown[];
  batchRunnerProcessCount: number;
  failureBatchElapsedMs: number;
  failureBatchRunnerProcessCount: number;
  failureBatchRecovered: boolean;
  failureDiagnostic?: unknown;
  listOutput: unknown;
  opsOutput: unknown;
  traceOutput: unknown;
  traceBatchOutputs: unknown[];
  traceBatchRunnerProcessCount: number;
  traceBatchHasEvents: boolean;
  traceResolvedMaxEvents: number;
  mixedTraceOutputs: unknown[];
  mixedTraceEventCounts: number[];
  mixedTraceRunnerProcessCount: number;
  traceKinds: string[];
  traceParity: boolean;
  executionCompileMs: number[];
  executionWorkerDeltas: number[];
  timeoutBatchRecovered: boolean;
  aborted: boolean;
}

declare global {
  var runJavaPreparedProviderBrowserTest:
    (() => Promise<PreparedBrowserResult>) | undefined;
}

let createdWorkers = 0;
let terminatedWorkers = 0;

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
    tracingTimeoutMs: 60_000,
  });
}

function completedOutput(
  result: { kind: string; output?: unknown; error?: string }
): unknown {
  if (result.kind !== 'completed') {
    throw new Error(result.error ?? `Expected completed result, got ${result.kind}`);
  }
  return result.output;
}

function completedWorkerOutput(result: {
  success: boolean;
  output?: unknown;
  error?: string;
}): unknown {
  if (!result.success) {
    throw new Error(result.error ?? 'Expected successful Java worker result.');
  }
  return result.output;
}

function traceEventShape(event: RuntimeTraceEvent) {
  return {
    kind: event.kind,
    line: event.line,
    function: 'function' in event ? event.function : undefined,
  };
}

async function preparedCode(
  provider: ReturnType<typeof createJavaPreparedExecutionProvider>,
  code: string,
  functionName: string,
  executionStyle: 'function' | 'solution-method' | 'ops-class' = 'solution-method'
) {
  const result = await provider.prepareProgram({
    mode: 'code',
    code,
    functionName,
    executionStyle,
  });
  if (result.kind !== 'prepared' || result.program.mode !== 'code') {
    throw new Error(
      result.kind === 'failed'
        ? result.error
        : 'Java code preparation did not return a code program.'
    );
  }
  return result;
}

globalThis.runJavaPreparedProviderBrowserTest =
  async (): Promise<PreparedBrowserResult> => {
    const provider = createJavaPreparedExecutionProvider({
      createWorkerClient: createClient,
    });
    await provider.init();

    const stateSource = [
      'class Solution {',
      '  private static int initialized = initialize();',
      '  private static int shared = 0;',
      '  private static volatile int background = 0;',
      '  private static final java.io.InputStream initialIn = System.in;',
      '  private static final java.io.PrintStream initialErr = System.err;',
      '  private static int initialize() { return 1; }',
      '  public String isolationProbe(String marker, boolean spawnThread) {',
      '    java.nio.file.Path file = java.nio.file.Paths.get("/tmp/tracecode-prepared-boundary.txt");',
      '    String beforeFile;',
      '    try {',
      '      beforeFile = java.nio.file.Files.exists(file) ? java.nio.file.Files.readString(file) : "missing";',
      '    } catch (java.io.IOException error) {',
      '      throw new RuntimeException(error);',
      '    }',
      '    shared += 1;',
      '    String before = String.join("|",',
      '        String.valueOf(initialized * 100 + shared),',
      '        java.util.Locale.getDefault().toLanguageTag(),',
      '        java.util.TimeZone.getDefault().getID(),',
      '        System.getProperty("user.dir", "missing"),',
      '        System.getProperty("tracecode.prepared.boundary", "missing"),',
      '        beforeFile,',
      '        String.valueOf(background),',
      '        Thread.currentThread().getName(),',
      '        String.valueOf(Thread.currentThread().getPriority()),',
      '        String.valueOf(Thread.getDefaultUncaughtExceptionHandler() == null),',
      '        String.valueOf(System.getenv().size()),',
      '        String.valueOf(System.in == initialIn && System.err == initialErr));',
      '    java.util.Locale.setDefault(java.util.Locale.JAPAN);',
      '    java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("GMT+09:00"));',
      '    System.setProperty("user.dir", "/mutated-" + marker);',
      '    System.setProperty("tracecode.prepared.boundary", marker);',
      '    try {',
      '      java.nio.file.Files.createDirectories(file.getParent());',
      '      java.nio.file.Files.writeString(file, marker);',
      '    } catch (java.io.IOException error) {',
      '      throw new RuntimeException(error);',
      '    }',
      '    Thread.currentThread().setName("mutated-" + marker);',
      '    Thread.currentThread().setPriority(Thread.MIN_PRIORITY);',
      '    Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {});',
      '    System.setIn(new java.io.ByteArrayInputStream(marker.getBytes(java.nio.charset.StandardCharsets.UTF_8)));',
      '    System.setErr(new java.io.PrintStream(new java.io.ByteArrayOutputStream()));',
      '    if (spawnThread) {',
      '      Thread thread = new Thread(() -> {',
      '        while (!Thread.currentThread().isInterrupted()) {',
      '          background += 1;',
      '          Thread.yield();',
      '        }',
      '      }, "prepared-java-leak-probe");',
      '      thread.setDaemon(true);',
      '      thread.start();',
      '      for (int spin = 0; spin < 10000 && background == 0; spin += 1) Thread.yield();',
      '      Runtime.getRuntime().addShutdownHook(new Thread(() -> {',
      '        System.setProperty("tracecode.prepared.shutdown", marker);',
      '        try { java.nio.file.Files.writeString(file, "shutdown-" + marker); } catch (Exception ignored) {}',
      '      }, "prepared-java-shutdown-hook"));',
      '    }',
      '    return before;',
      '  }',
      '}',
    ].join('\n');

    const executionWorkerDeltas: number[] = [];
    const executePreparedCase = async <
      Result,
    >(
      execute: () => Promise<Result>
    ): Promise<Result> => {
      const before = createdWorkers;
      try {
        return await execute();
      } finally {
        executionWorkerDeltas.push(createdWorkers - before);
      }
    };

    const isolationPreparation = await preparedCode(
      provider,
      stateSource,
      'isolationProbe'
    );
    const isolationOutputs = [];
    const executionCompileMs = [];
    for (const [marker, spawnThread] of [
      ['first', true],
      ['second', false],
    ] as const) {
      const result = await executePreparedCase(() =>
        isolationPreparation.program.executeIsolated({
          inputs: { marker, spawnThread },
        })
      );
      isolationOutputs.push(completedOutput(result));
      executionCompileMs.push(result.timings?.compileMs ?? -1);
    }
    const batchIsolationResults =
      await isolationPreparation.program.executeBatchIsolated?.({
        inputBatch: [
          { marker: 'batch-first', spawnThread: false },
          { marker: 'batch-second', spawnThread: false },
        ],
      });
    if (!batchIsolationResults) {
      throw new Error('Prepared Java code program did not expose batch execution.');
    }
    const batchIsolationOutputs =
      batchIsolationResults.map(completedOutput);
    const batchRunnerProcessCount = Number(
      (
        batchIsolationResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    executionCompileMs.push(
      ...batchIsolationResults.map(
        (result) => result.timings?.compileMs ?? -1
      )
    );
    await isolationPreparation.program.dispose();
    await isolationPreparation.program.dispose();

    const failurePreparation = await preparedCode(
      provider,
      [
        'class Solution {',
        '  public int inspect(int value) {',
        '    if (value < 0) return (new int[0])[value];',
        '    return value;',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const failureBatchStart = performance.now();
    const failureBatchResults =
      await failurePreparation.program.executeBatchIsolated?.({
        inputBatch: [{ value: -1 }, { value: -2 }, { value: 3 }],
      });
    const failureBatchElapsedMs = performance.now() - failureBatchStart;
    if (!failureBatchResults) {
      throw new Error('Prepared Java code program did not expose failure batch execution.');
    }
    const failureBatchRunnerProcessCount = Number(
      (
        failureBatchResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const failureDiagnostic =
      failureBatchResults[0]?.kind === 'failed'
        ? failureBatchResults[0].diagnostic
        : undefined;
    const failureBatchRecovered =
      failureBatchResults.length === 3 &&
      failureBatchResults[0]?.kind === 'failed' &&
      failureBatchResults[1]?.kind === 'failed' &&
      failureBatchResults[2]?.kind === 'completed' &&
      failureBatchResults[2].output === 3;
    await failurePreparation.program.dispose();

    const listPreparation = await preparedCode(
      provider,
      [
        'class Solution {',
        '  static class Box { int value; String label; }',
        '  enum Level { LOW, HIGH }',
        '  public int inspect(',
        '      int[] values,',
        '      java.util.List<Integer> list,',
        '      java.util.Map<String, Integer> weights,',
        '      java.util.Set<Integer> seen,',
        '      ListNode head,',
        '      TreeNode root,',
        '      Box box,',
        '      StringBuilder builder,',
        '      Level level) {',
        '    return values[0] + list.get(0) + weights.get("x") +',
        '        seen.iterator().next() + head.val + head.next.val +',
        '        root.val + root.left.val + root.right.val +',
        '        box.value + box.label.length() +',
        '        builder.length() + level.ordinal();',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const listResult = await executePreparedCase(() =>
      listPreparation.program.executeIsolated({
        inputs: {
          values: [2],
          list: [3],
          weights: { x: 4 },
          seen: [5],
          head: [6, 7],
          root: [8, 9, 10],
          box: { value: 11, label: 'ab' },
          builder: 'xy',
          level: 'HIGH',
        },
      })
    );
    const listOutput = completedOutput(listResult);
    executionCompileMs.push(listResult.timings?.compileMs ?? -1);
    await listPreparation.program.dispose();

    const opsPreparation = await preparedCode(
      provider,
      [
        'class Counter {',
        '  private int value;',
        '  Counter(int value) { this.value = value; }',
        '  int add(int delta) { value += delta; return value; }',
        '  void reset() { value = 0; }',
        '}',
      ].join('\n'),
      'Counter',
      'ops-class'
    );
    const opsResult = await executePreparedCase(() =>
      opsPreparation.program.executeIsolated({
        inputs: {
          operations: ['Counter', 'add', 'reset', 'add'],
          arguments: [[4], [3], [], [2]],
        },
      })
    );
    const opsOutput = completedOutput(opsResult);
    executionCompileMs.push(opsResult.timings?.compileMs ?? -1);
    await opsPreparation.program.dispose();

    const traceSource = [
      'class Box { int value; }',
      'class Solution {',
      '  public int sum(int[] values) {',
      '    int total = 0;',
      '    for (int value : values) total += value;',
      '    return total;',
      '  }',
      '  public String stringify(Box box) {',
      '    return String.valueOf(box.value);',
      '  }',
      '}',
    ].join('\n');
    const traceOptions: JavaTraceExecutionOptions = {
      maxTraceSteps: 1_000,
      maxStoredEvents: 2_000,
      traceProfile: true,
    };
    const tracePreparation = await provider.prepareProgram({
      mode: 'trace',
      code: traceSource,
      functionName: 'sum',
      executionStyle: 'solution-method',
      traceOptions,
    });
    if (
      tracePreparation.kind !== 'prepared' ||
      tracePreparation.program.mode !== 'trace'
    ) {
      throw new Error(
        tracePreparation.kind === 'failed'
          ? tracePreparation.error
          : 'Java trace preparation did not return a trace program.'
      );
    }
    const traceProgram = tracePreparation.program;
    const traceResult = await executePreparedCase(() =>
      traceProgram.executeIsolated({
        inputs: { values: [1, 2, 3] },
      })
    );
    const traceOutput = completedOutput(traceResult);
    executionCompileMs.push(traceResult.timings?.compileMs ?? -1);
    if (traceResult.kind !== 'completed') {
      throw new Error('Prepared Java trace did not complete.');
    }
    const traceKinds = traceResult.trace.events.map((event) => event.kind);
    const traceProfilePrefix = '__TRACECODE_TRACE_PROFILE_JSON__:';
    const traceProfileLine = traceResult.consoleOutput?.find((line) =>
      line.startsWith(traceProfilePrefix)
    );
    const traceResolvedMaxEvents = Number(
      traceProfileLine
        ? JSON.parse(traceProfileLine.slice(traceProfilePrefix.length)).maxEvents
        : Number.NaN
    );
    const preparedTraceShape = traceResult.trace.events.map(traceEventShape);
    const traceBatchResults =
      await traceProgram.executeBatchIsolated?.({
        inputBatch: [
          { values: [1, 2, 3] },
          { values: [4, 5] },
        ],
      });
    if (!traceBatchResults) {
      throw new Error('Prepared Java trace program did not expose batch execution.');
    }
    const traceBatchOutputs = traceBatchResults.map(completedOutput);
    const traceBatchRunnerProcessCount = Number(
      (
        traceBatchResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const traceBatchHasEvents = traceBatchResults.every(
      (result) =>
        result.kind === 'completed' &&
        result.trace.events.some((event) => event.kind === 'line') &&
        result.trace.events.some((event) => event.kind === 'return')
    );
    executionCompileMs.push(
      ...traceBatchResults.map(
        (result) => result.timings?.compileMs ?? -1
      )
    );
    await traceProgram.dispose();

    // Exercise the on-demand product shape directly: one trace preparation,
    // one compiled artifact, one runner, and per-case entry-point selection.
    const mixedTraceClient = createClient();
    await mixedTraceClient.warmup();
    const mixedTracePreparation = await mixedTraceClient.prepareRuntimeProgram({
      mode: 'trace',
      code: traceSource,
      functionName: 'sum',
      executionStyle: 'solution-method',
      traceOptions: { maxStoredEvents: 2_000 },
    });
    if (!mixedTracePreparation.success || !mixedTracePreparation.programId) {
      throw new Error(
        mixedTracePreparation.error ??
          'Mixed Java trace preparation did not return a program id.'
      );
    }
    const mixedTraceResults = await mixedTraceClient.executePreparedTraceBatch(
      mixedTracePreparation.programId,
      {
        inputBatch: [
          { values: [1, 2, 3] },
          { values: [4, 5] },
          { values: [6] },
        ],
      },
      { maxStoredEvents: 2_000 },
      { traceEnabledBatch: [true, false, true] }
    );
    const mixedTraceOutputs = mixedTraceResults.map(completedWorkerOutput);
    const mixedTraceEventCounts = mixedTraceResults.map(
      (result) => result.trace.events.length
    );
    const mixedTraceRunnerProcessCount = Number(
      (
        mixedTraceResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    await mixedTraceClient.disposePreparedRuntimeProgram(
      mixedTracePreparation.programId
    );
    mixedTraceClient.terminate();

    const legacyTraceClient = createClient();
    const legacyTrace = await legacyTraceClient.executeWithTracing({
      code: traceSource,
      functionName: 'sum',
      inputs: { values: [1, 2, 3] },
      executionStyle: 'solution-method',
      traceOptions: { maxStoredEvents: 2_000 },
    });
    const legacyTraceShape = legacyTrace.trace.events.map(traceEventShape);
    const traceParity =
      legacyTrace.success &&
      JSON.stringify(legacyTrace.output) === JSON.stringify(traceOutput) &&
      JSON.stringify(legacyTraceShape) === JSON.stringify(preparedTraceShape);
    legacyTraceClient.terminate();

    const hangingPreparation = await preparedCode(
      provider,
      [
        'class Solution {',
        '  public int hang(int value) {',
        '    if (value == 0) while (true) value += 1;',
        '    return value;',
        '  }',
        '}',
      ].join('\n'),
      'hang'
    );
    const timeoutBatchResults =
      await hangingPreparation.program.executeBatchIsolated?.({
        inputBatch: [{ value: 0 }, { value: 1 }],
        limits: { wallClockMs: 1_200 },
      });
    const timeoutBatchRecovered =
      timeoutBatchResults?.length === 2 &&
      timeoutBatchResults[0]?.kind !== 'completed' &&
      timeoutBatchResults[1]?.kind === 'completed' &&
      timeoutBatchResults[1].output === 1;
    const abortController = new AbortController();
    const pendingHang = executePreparedCase(() =>
      hangingPreparation.program.executeIsolated({
        inputs: { value: 0 },
        signal: abortController.signal,
        limits: { wallClockMs: 60_000 },
      })
    );
    setTimeout(() => abortController.abort(), 100);
    let aborted = false;
    try {
      await pendingHang;
    } catch (error) {
      aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'));
    }
    await hangingPreparation.program.dispose();
    provider.dispose();

    return {
      createdWorkers,
      terminatedWorkers,
      isolationOutputs,
      batchIsolationOutputs,
      batchRunnerProcessCount,
      failureBatchElapsedMs,
      failureBatchRunnerProcessCount,
      failureBatchRecovered,
      failureDiagnostic,
      listOutput,
      opsOutput,
      traceOutput,
      traceBatchOutputs,
      traceBatchRunnerProcessCount,
      traceBatchHasEvents,
      traceResolvedMaxEvents,
      mixedTraceOutputs,
      mixedTraceEventCounts,
      mixedTraceRunnerProcessCount,
      traceKinds,
      traceParity,
      executionCompileMs,
      executionWorkerDeltas,
      timeoutBatchRecovered,
      aborted,
    };
  };
