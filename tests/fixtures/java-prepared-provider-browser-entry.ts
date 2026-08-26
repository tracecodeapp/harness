import {
  JavaWorkerClient,
  type JavaTraceExecutionOptions,
  type JavaWorkerPreparedProgramSnapshot,
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

interface JavaAlgorithmProfileShape {
  schema?: string;
  tier?: string;
  boundary?: string;
  reasons?: readonly string[];
  scannedClasses?: number;
}

interface PreparedBrowserResult {
  createdWorkers: number;
  terminatedWorkers: number;
  isolationOutputs: unknown[];
  batchIsolationOutputs: unknown[];
  batchRunnerProcessCount: number;
  batchIsolationProfile?: JavaAlgorithmProfileShape;
  failureBatchElapsedMs: number;
  failureBatchRunnerProcessCount: number;
  failureBatchIsolationProfile?: JavaAlgorithmProfileShape;
  failureBatchRecovered: boolean;
  failureDiagnostic?: unknown;
  algorithmLibraryOutputs: unknown[];
  algorithmLibraryRunnerProcessCount: number;
  algorithmLibraryProfile?: JavaAlgorithmProfileShape;
  leaseCeilingCorrect: boolean;
  leaseCeilingRunnerProcessCount: number;
  printingOutputs: unknown[];
  printingRunnerProcessCount: number;
  printingProfile?: JavaAlgorithmProfileShape;
  internOutputs: unknown[];
  internRunnerProcessCount: number;
  internProfile?: JavaAlgorithmProfileShape;
  compatibilityStateOutputs: unknown[];
  compatibilityStateRunnerProcessCount: number;
  compatibilityStateProfile?: JavaAlgorithmProfileShape;
  ambientCapabilityProfile?: JavaAlgorithmProfileShape;
  relabeledArtifactProfile?: JavaAlgorithmProfileShape;
  relabeledArtifactRunnerProcessCount: number;
  relabeledArtifactOutputs: unknown[];
  forgedArtifactProfile?: JavaAlgorithmProfileShape;
  generatedIdentityDistinct: boolean;
  generatedLookalikeProfile?: JavaAlgorithmProfileShape;
  listOutput: unknown;
  opsOutput: unknown;
  traceOutput: unknown;
  sequentialTraceOutputs: unknown[];
  sequentialTraceRunnerProcessCounts: number[];
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
  timeoutBatchRunnerProcessCount: number;
  timeoutBatchRecovered: boolean;
  timeoutBatchKinds: string[];
  timeoutBatchLimitReason?: string;
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
    const batchIsolationProfile = (
      batchIsolationResults[0] as typeof batchIsolationResults[number] & {
        algorithmIsolationProfile?: JavaAlgorithmProfileShape;
      }
    ).algorithmIsolationProfile;
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
    const failureBatchIsolationProfile = (
      failureBatchResults[0] as typeof failureBatchResults[number] & {
        algorithmIsolationProfile?: JavaAlgorithmProfileShape;
      }
    ).algorithmIsolationProfile;
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

    const algorithmLibraryPreparation = await preparedCode(
      provider,
      [
        'import java.util.*;',
        'class Solution {',
        '  private static int calls = 0;',
        '  public int inspect(int[] values) {',
        '    if (values.length == 0) throw new RuntimeException("empty");',
        '    int[] copy = values.clone();',
        '    int[][] grid = new int[][] { copy }.clone();',
        '    String[] labels = new String[] { "value" }.clone();',
        '    if (grid.length + labels.length != 2) throw new RuntimeException("clone");',
        '    Deque<Integer> queue = new ArrayDeque<>();',
        '    for (int value : copy) queue.addLast(value);',
        '    calls += 1;',
        '    return calls * 100 + queue.removeFirst();',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const algorithmLibraryResults =
      await algorithmLibraryPreparation.program.executeBatchIsolated?.({
        inputBatch: [{ values: [7] }, { values: [8] }],
      });
    if (!algorithmLibraryResults) {
      throw new Error('Prepared Java library batch was unavailable.');
    }
    const algorithmLibraryOutputs =
      algorithmLibraryResults.map(completedOutput);
    const algorithmLibraryRunnerProcessCount = Number(
      (
        algorithmLibraryResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const algorithmLibraryProfile = (
      algorithmLibraryResults[0] as typeof algorithmLibraryResults[number] & {
        algorithmIsolationProfile?: JavaAlgorithmProfileShape;
      }
    ).algorithmIsolationProfile;
    const leaseCeilingInputs = Array.from({ length: 65 }, (_, index) => ({
      values: [index + 1],
    }));
    const leaseCeilingResults =
      await algorithmLibraryPreparation.program.executeBatchIsolated?.({
        inputBatch: leaseCeilingInputs,
      });
    if (!leaseCeilingResults) {
      throw new Error('Prepared Java lease-ceiling batch was unavailable.');
    }
    const leaseCeilingCorrect = leaseCeilingResults.every(
      (result, index) => completedOutput(result) === 101 + index
    );
    const leaseCeilingRunnerProcessCount = Number(
      (
        leaseCeilingResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    await algorithmLibraryPreparation.program.dispose();

    const printingPreparation = await preparedCode(
      provider,
      [
        'class Solution {',
        '  public int inspect(int value) {',
        '    System.out.println("debug-" + value);',
        '    System.err.printf("error-%d%n", value);',
        '    return value;',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const printingResults =
      await printingPreparation.program.executeBatchIsolated?.({
        inputBatch: [{ value: 7 }, { value: 8 }],
      });
    if (!printingResults) {
      throw new Error('Prepared Java printing batch was unavailable.');
    }
    const printingOutputs = printingResults.map(completedOutput);
    const printingRunnerProcessCount = Number(
      (
        printingResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const printingProfile = (
      printingResults[0] as typeof printingResults[number] & {
        algorithmIsolationProfile?: JavaAlgorithmProfileShape;
      }
    ).algorithmIsolationProfile;
    await printingPreparation.program.dispose();

    const internPreparation = await preparedCode(
      provider,
      [
        'class Solution {',
        '  public boolean inspect(String value) {',
        '    String fresh = new String(value);',
        '    return fresh.intern() == fresh;',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const internResults =
      await internPreparation.program.executeBatchIsolated?.({
        inputBatch: [
          { value: 'tracecode-intern-cross-case-7f94d1' },
          { value: 'tracecode-intern-cross-case-7f94d1' },
        ],
      });
    if (!internResults) {
      throw new Error('Prepared Java intern batch was unavailable.');
    }
    const internOutputs = internResults.map(completedOutput);
    const internRunnerProcessCount = Number(
      (
        internResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const internProfile = (
      internResults[0] as typeof internResults[number] & {
        algorithmIsolationProfile?: JavaAlgorithmProfileShape;
      }
    ).algorithmIsolationProfile;
    await internPreparation.program.dispose();

    const compatibilityStatePreparation = await preparedCode(
      provider,
      [
        'import java.nio.file.*;',
        'class Solution {',
        '  private static int calls = 0;',
        '  public int inspect(int value) {',
        '    int leaked = calls++ == 0 ? 0 : 1;',
        '    if (System.getProperty("tracecode.java.case-probe") != null) leaked |= 2;',
        '    Path path = Path.of("/tmp/tracecode-java-case-probe");',
        '    if (Files.exists(path)) leaked |= 4;',
        '    if (value == 1) {',
        '      System.setProperty("tracecode.java.case-probe", "set");',
        '      try { Files.writeString(path, "set"); } catch (Exception ignored) {}',
        '      Thread thread = new Thread(() -> {',
        '        try { Thread.sleep(20); } catch (InterruptedException ignored) {}',
        '        System.setProperty("tracecode.java.thread-probe", "set");',
        '      });',
        '      thread.setDaemon(true);',
        '      thread.start();',
        '    } else {',
        '      try { Thread.sleep(60); } catch (InterruptedException ignored) {}',
        '      if (System.getProperty("tracecode.java.thread-probe") != null) leaked |= 8;',
        '    }',
        '    if (Solution.class.getModule().isNamed()) leaked |= 16;',
        '    if (Solution.class.getClassLoader() == null) leaked |= 32;',
        '    return leaked;',
        '  }',
        '}',
      ].join('\n'),
      'inspect'
    );
    const compatibilityStateResults =
      await compatibilityStatePreparation.program.executeBatchIsolated?.({
        inputBatch: [{ value: 1 }, { value: 2 }],
      });
    if (!compatibilityStateResults) {
      throw new Error(
        'Prepared Java compatibility-state batch was unavailable.'
      );
    }
    const compatibilityStateOutputs =
      compatibilityStateResults.map(completedOutput);
    const compatibilityStateRunnerProcessCount = Number(
      (
        compatibilityStateResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    const compatibilityStateProfile = (
      compatibilityStateResults[0] as
        typeof compatibilityStateResults[number] & {
          algorithmIsolationProfile?: JavaAlgorithmProfileShape;
        }
    ).algorithmIsolationProfile;
    await compatibilityStatePreparation.program.dispose();

    const ambientCapabilitySource = [
      'import java.io.*;',
      'import java.lang.ref.*;',
      'import java.net.*;',
      'import java.nio.file.*;',
      'import java.time.*;',
      'import java.time.chrono.*;',
      'import java.util.*;',
      'import java.util.concurrent.*;',
      'import java.util.random.*;',
      'import java.util.stream.*;',
      'import java.util.zip.*;',
      'class ParallelList extends ArrayList<Integer> {}',
      'class Solution {',
      '  private native int nativeProbe();',
      '  public int inspect(int value) {',
      '    if (value < 0) {',
      '      try {',
      '        Files.exists(Path.of("/tmp/tracecode-java-fast"));',
      '        new File("/tmp/tracecode-java-fast").exists();',
      '        new PrintStream("/tmp/tracecode-java-fast-output").println("unsafe");',
      '        System.getenv("TRACECODE_JAVA_FAST");',
      '        System.getProperty("tracecode.java.fast");',
      '        Boolean.getBoolean("tracecode.java.fast");',
      '        Integer.getInteger("tracecode.java.fast");',
      '        Long.getLong("tracecode.java.fast");',
      '        new String("tracecode.java.fast").intern();',
      '        new Thread(() -> {}).start();',
      '        Cleaner.create().register(this, () -> {});',
      '        Executors.newSingleThreadExecutor();',
      '        StreamSupport.stream(List.of(1).spliterator(), true).count();',
      '        Class.forName("java.lang.String");',
      '        new ProcessBuilder("true").start();',
      '        new Socket("127.0.0.1", 1);',
      '        Math.random();',
      '        RandomGenerator.getDefault().nextInt();',
      '        System.nanoTime();',
      '        Clock.tickSeconds(ZoneId.systemDefault()).instant();',
      '        InstantSource.system().instant();',
      '        IsoChronology.INSTANCE.dateNow();',
      '        new GregorianCalendar();',
      '        new GregorianCalendar(TimeZone.getDefault());',
      '        new Calendar.Builder().build();',
      '        StackWalker.getInstance();',
      '        System.LoggerFinder.getLoggerFinder();',
      '        new Scanner(System.in).hasNext();',
      '        ((AutoCloseable) System.out).close();',
      '        try (Formatter formatter = new Formatter(System.out)) {',
      '          formatter.format("%d", value);',
      '        }',
      '        new Formatter("/tmp/tracecode-java-formatter").close();',
      '        new ZipFile("/tmp/tracecode-java-zip").close();',
      '        new ParallelList().parallelStream().count();',
      '      } catch (Exception ignored) {}',
      '      return nativeProbe();',
      '    }',
      '    return value;',
      '  }',
      '}',
    ].join('\n');
    const ambientClient = createClient();
    await ambientClient.warmup();
    const ambientPreparation = await ambientClient.prepareRuntimeProgram({
      mode: 'code',
      code: ambientCapabilitySource,
      functionName: 'inspect',
      executionStyle: 'solution-method',
    });
    if (
      !ambientPreparation.success ||
      !ambientPreparation.programId ||
      !ambientPreparation.snapshot
    ) {
      throw new Error(
        ambientPreparation.error ??
          'Ambient-capability Java preparation failed.'
      );
    }
    const ambientCapabilityProfile =
      ambientPreparation.algorithmIsolationProfile;
    const generatedLookalikeSource = [
      'class ExportsLearnerPredictable$Evil {',
      '  static String readAmbientState() {',
      '    return System.getProperty("tracecode.java.generated-lookalike");',
      '  }',
      '}',
      'class Solution {',
      '  public int inspect(int value) { return value; }',
      '}',
    ].join('\n');
    const generatedLookalikeFirst =
      await ambientClient.prepareRuntimeProgram({
        mode: 'code',
        code: generatedLookalikeSource,
        functionName: 'inspect',
        executionStyle: 'solution-method',
      });
    const generatedLookalikeSecond =
      await ambientClient.prepareRuntimeProgram({
        mode: 'code',
        code: generatedLookalikeSource,
        functionName: 'inspect',
        executionStyle: 'solution-method',
      });
    if (
      !generatedLookalikeFirst.success ||
      !generatedLookalikeFirst.programId ||
      !generatedLookalikeFirst.snapshot ||
      !generatedLookalikeSecond.success ||
      !generatedLookalikeSecond.programId ||
      !generatedLookalikeSecond.snapshot
    ) {
      throw new Error(
        generatedLookalikeFirst.error ??
          generatedLookalikeSecond.error ??
          'Generated-shell lookalike preparation failed.'
      );
    }
    const generatedIdentityDistinct =
      String(generatedLookalikeFirst.snapshot.entryClass ?? '') !==
      String(generatedLookalikeSecond.snapshot.entryClass ?? '');
    const generatedLookalikeProfile =
      generatedLookalikeFirst.algorithmIsolationProfile;
    await ambientClient.disposePreparedRuntimeProgram(
      generatedLookalikeFirst.programId
    );
    await ambientClient.disposePreparedRuntimeProgram(
      generatedLookalikeSecond.programId
    );
    const relabeledSnapshot = {
      ...structuredClone(ambientPreparation.snapshot),
      algorithmIsolationProfile: {
        schema: 'tracecode.java.algorithm-isolation-profile.v1',
        tier: 'algorithm-fast',
        boundary: 'fresh-application-class-loader',
        reasons: [],
        scannedClasses: 1,
      },
    } as JavaWorkerPreparedProgramSnapshot;
    const restoredAmbientClient = createClient();
    await restoredAmbientClient.warmup();
    const restoredAmbient =
      await restoredAmbientClient.restorePreparedRuntimeProgram(
        relabeledSnapshot
      );
    if (!restoredAmbient.success || !restoredAmbient.programId) {
      throw new Error(
        restoredAmbient.error ??
          'Relabeled ambient Java artifact failed to restore.'
      );
    }
    const relabeledArtifactProfile =
      restoredAmbient.algorithmIsolationProfile;
    const relabeledArtifactResults =
      await restoredAmbientClient.executePreparedCodeBatch(
        restoredAmbient.programId,
        { inputBatch: [{ value: 7 }, { value: 8 }] }
      );
    const relabeledArtifactOutputs =
      relabeledArtifactResults.map(completedOutput);
    const relabeledArtifactRunnerProcessCount = Number(
      (
        relabeledArtifactResults[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
    await restoredAmbientClient.disposePreparedRuntimeProgram(
      restoredAmbient.programId
    );
    restoredAmbientClient.terminate();
    const forgedSnapshotSource = structuredClone(
      ambientPreparation.snapshot
    );
    const originalEntryClass = String(forgedSnapshotSource.entryClass ?? '');
    const packageSeparator = originalEntryClass.lastIndexOf('.');
    if (packageSeparator < 0) {
      throw new Error('Prepared Java snapshot did not contain a package.');
    }
    const forgedSnapshot = {
      ...forgedSnapshotSource,
      entryClass: `${originalEntryClass.slice(0, packageSeparator)}.Solution`,
      cleanEntryClass: originalEntryClass,
      algorithmIsolationProfile: {
        schema: 'tracecode.java.algorithm-isolation-profile.v1',
        tier: 'algorithm-fast',
        boundary: 'fresh-application-class-loader',
        reasons: [],
        scannedClasses: 1,
      },
    } as JavaWorkerPreparedProgramSnapshot;
    const forgedAmbientClient = createClient();
    await forgedAmbientClient.warmup();
    const forgedAmbient =
      await forgedAmbientClient.restorePreparedRuntimeProgram(forgedSnapshot);
    if (!forgedAmbient.success || !forgedAmbient.programId) {
      throw new Error(
        forgedAmbient.error ?? 'Forged ambient Java artifact failed to restore.'
      );
    }
    const forgedArtifactProfile = forgedAmbient.algorithmIsolationProfile;
    await forgedAmbientClient.disposePreparedRuntimeProgram(
      forgedAmbient.programId
    );
    forgedAmbientClient.terminate();
    await ambientClient.disposePreparedRuntimeProgram(
      ambientPreparation.programId
    );
    ambientClient.terminate();

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
    const sequentialTraceSecondResult = await executePreparedCase(() =>
      traceProgram.executeIsolated({
        inputs: { values: [4, 5] },
      })
    );
    if (sequentialTraceSecondResult.kind !== 'completed') {
      throw new Error('Second prepared Java trace did not complete.');
    }
    const sequentialTraceOutputs = [
      completedOutput(traceResult),
      completedOutput(sequentialTraceSecondResult),
    ];
    const sequentialTraceRunnerProcessCounts = [
      traceResult,
      sequentialTraceSecondResult,
    ].map((result) =>
      Number(
        (
          result.timings as
            | ({ runnerProcessCount?: number })
            | undefined
        )?.runnerProcessCount ?? -1
      )
    );
    executionCompileMs.push(
      sequentialTraceSecondResult.timings?.compileMs ?? -1
    );
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

    const fallbackPreparation = await provider.prepareProgram({
      mode: 'trace',
      code: [
        'class Solution {',
        '  public int fallback(int[] values) {',
        '    int previous = Integer.parseInt(System.getProperty("tracecode.fallback", "0"));',
        '    System.setProperty("tracecode.fallback", String.valueOf(previous + 1));',
        '    System.out.println("fallback-attempt");',
        '    int total = 0;',
        '    for (int value : values) total += value;',
        '    return previous * 100 + total;',
        '  }',
        '}',
      ].join('\n'),
      functionName: 'fallback',
      executionStyle: 'solution-method',
      traceOptions: { maxStoredEvents: 1 },
    });
    if (
      fallbackPreparation.kind !== 'prepared' ||
      fallbackPreparation.program.mode !== 'trace'
    ) {
      throw new Error(
        fallbackPreparation.kind === 'failed'
          ? fallbackPreparation.error
          : 'Java budget fallback preparation did not return a trace program.'
      );
    }
    const fallbackProgram = fallbackPreparation.program;
    const fallbackResult = await executePreparedCase(() =>
      fallbackProgram.executeIsolated({
        inputs: { values: [1, 2, 3] },
      })
    );
    if (
      fallbackResult.kind !== 'completed' ||
      fallbackResult.output !== 6 ||
      fallbackResult.traceTruncated !== 'trace-limit'
    ) {
      throw new Error(
        `Java budget fallback must rerun in fresh state: ${JSON.stringify(fallbackResult)}`
      );
    }
    await fallbackProgram.dispose();

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
        traceEnabledBatch: [true, false, true],
      },
      { maxStoredEvents: 2_000 }
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
    const timeoutBatchKinds =
      timeoutBatchResults?.map((result) => result.kind) ?? [];
    const timeoutBatchLimitReason =
      timeoutBatchResults?.[0]?.kind === 'limit'
        ? timeoutBatchResults[0].reason
        : undefined;
    const timeoutBatchRunnerProcessCount = Number(
      (
        timeoutBatchResults?.[0]?.timings as
          | ({ runnerProcessCount?: number })
          | undefined
      )?.runnerProcessCount ?? -1
    );
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
      batchIsolationProfile,
      failureBatchElapsedMs,
      failureBatchRunnerProcessCount,
      failureBatchIsolationProfile,
      failureBatchRecovered,
      failureDiagnostic,
      algorithmLibraryOutputs,
      algorithmLibraryRunnerProcessCount,
      algorithmLibraryProfile,
      leaseCeilingCorrect,
      leaseCeilingRunnerProcessCount,
      printingOutputs,
      printingRunnerProcessCount,
      printingProfile,
      internOutputs,
      internRunnerProcessCount,
      internProfile,
      compatibilityStateOutputs,
      compatibilityStateRunnerProcessCount,
      compatibilityStateProfile,
      ambientCapabilityProfile,
      relabeledArtifactProfile,
      relabeledArtifactRunnerProcessCount,
      relabeledArtifactOutputs,
      forgedArtifactProfile,
      generatedIdentityDistinct,
      generatedLookalikeProfile,
      listOutput,
      opsOutput,
      traceOutput,
      sequentialTraceOutputs,
      sequentialTraceRunnerProcessCounts,
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
      timeoutBatchRunnerProcessCount,
      timeoutBatchRecovered,
      timeoutBatchKinds,
      timeoutBatchLimitReason,
      aborted,
    };
  };
