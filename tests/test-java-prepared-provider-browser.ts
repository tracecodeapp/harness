#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type BrowserType,
} from 'playwright';
import type {} from './fixtures/java-stopping-batch-browser-entry';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

interface PreparedBrowserResult {
  createdWorkers: number;
  terminatedWorkers: number;
  isolationOutputs: unknown[];
  batchIsolationOutputs: unknown[];
  batchRunnerProcessCount: number;
  batchIsolationProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  failureBatchElapsedMs: number;
  failureBatchRunnerProcessCount: number;
  failureBatchIsolationProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  failureBatchRecovered: boolean;
  failureDiagnostic?: unknown;
  algorithmLibraryOutputs: unknown[];
  algorithmLibraryRunnerProcessCount: number;
  algorithmLibraryProfile?: {
    schema?: string;
    tier?: string;
    boundary?: string;
    reasons?: readonly string[];
    scannedClasses?: number;
  };
  leaseCeilingCorrect: boolean;
  leaseCeilingRunnerProcessCount: number;
  printingOutputs: unknown[];
  printingRunnerProcessCount: number;
  printingProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  internOutputs: unknown[];
  internRunnerProcessCount: number;
  internProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  compatibilityStateOutputs: unknown[];
  compatibilityStateRunnerProcessCount: number;
  compatibilityStateProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  ambientCapabilityProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  relabeledArtifactProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  relabeledArtifactRunnerProcessCount: number;
  relabeledArtifactOutputs: unknown[];
  forgedArtifactProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
  generatedIdentityDistinct: boolean;
  generatedLookalikeProfile?: {
    tier?: string;
    reasons?: readonly string[];
  };
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

const browserTypes: Record<BrowserEngine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

function contentType(path: string): string {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.jar')) return 'application/java-archive';
  return 'application/octet-stream';
}

function safeFile(root: string, relative: string): string | undefined {
  const path = normalize(join(root, relative));
  if (!path.startsWith(`${normalize(root)}${sep}`)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function assertConsoleResults(
  consoleResults: Awaited<ReturnType<NonNullable<typeof globalThis.runJavaConsoleCases>>>,
  engine: BrowserEngine
): void {
  const lines = ['first line', 'second line'];
  assert.deepEqual(
    Object.fromEntries(Object.entries(consoleResults).map(([name, run]) => [name, [run.kind, run.consoleOutput]])),
    {
      untraced: ['failed', lines],
      traced: ['failed', lines],
      exit: ['failed', [...lines, 'before exit']],
      directBatchFirst: ['completed', lines],
      directBatchSecond: ['completed', lines],
      directTrace: ['failed', lines],
      success: ['completed', lines],
    },
    `${engine}: Java consoleOutput must retain stdout in print order`
  );
  assert.equal(consoleResults.success.output, 7);
}

function assertStoppingBatch(
  result: Awaited<ReturnType<typeof globalThis.javaStoppingBatchProbe>>,
  engine: BrowserEngine,
): void {
  console.log(`Java ten-case Run (${engine}): ${JSON.stringify(result.happyLifecycle)}`);
  console.log(`Java tight-loop probe: ${JSON.stringify({
    nonstopping: result.nonstoppingLifecycle,
    outcomes: result.nonstopping.map(({ success, output, timeoutReason, timings }) =>
      ({ success, output, timeoutReason, runMs: timings?.runMs })),
    fallback: result.fallbackLifecycle,
    fallbackTimeout: result.fallbackTimeoutLifecycle,
    abort: { name: result.abortName, ...result.abortLifecycle },
    stopping: result.stopRuns.map(({ cases, ...lifecycle }) => ({
      ...lifecycle, statuses: cases.map(({ status }) => status),
    })),
  })}`);
  const traceSize = (trace: unknown) => (trace as { events?: unknown[] } | undefined)?.events?.length ?? 0;
  assert.equal(result.happy.length, 10);
  assert.deepEqual(result.happy.map((row) => row.verdict.kind), Array(10).fill('passed'));
  assert.deepEqual(result.happy.map((row) => row.value), Array.from({ length: 10 }, (_, i) => i));
  assert.ok(traceSize(result.happy[0]?.trace) > 0);
  assert.ok(result.happy.slice(1).every((row) => traceSize(row.trace) === 0));
  assert.equal(result.happyLifecycle.workers, 1);
  assert.equal(result.happyLifecycle.runners, 1);
  assert.deepEqual(result.happyLifecycle.dispatches, [true, ...Array(9).fill(false)]);
  assert.equal(result.continuationLifecycle.workers, 1);
  assert.equal(result.continuationLifecycle.terminated, false);
  assert.deepEqual(result.continuationLifecycle.requests, ['execute-prepared-runtime-program-batch']);
  assert.equal(result.continuationLifecycle.runners, 1);
  assert.equal(result.continuation[0]?.caseId, '1');
  assert.equal(result.continuation[0]?.value, 1);
  assert.ok(traceSize(result.continuation[0]?.trace) > 0);

  for (const { cases, requests, dispatches, selection } of result.stopRuns) {
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.type, 'execute-prepared-runtime-program-batch');
    assert.ok((requests[0]?.elapsed ?? Infinity) < result.bound + 800, JSON.stringify(requests));
    assert.deepEqual(dispatches, [selection === '0', selection === '1']);
    assert.equal(cases[0]?.verdict.kind, 'passed');
    assert.equal(cases[1]?.status, 'timed-out');
    assert.equal(cases[1]?.failure?.origin, 'limit');
    assert.equal(cases[1]?.failure?.reason, 'client-timeout');
    assert.equal(cases[1]?.timings?.runMs, result.bound);
    assert.deepEqual(cases[2]?.notRun, {
      reason: 'run-stopped-after-limit', stoppedByCaseId: '1', limit: 'client-timeout',
    });
  }

  assert.deepEqual(result.nonstopping.map(({ output, timeoutReason }) => output ?? timeoutReason), [0, 'client-timeout', 2]);
  assert.equal(result.nonstoppingLifecycle.runners, 2);
  assert.deepEqual(result.nonstoppingLifecycle.runnerEvents, ['created', 'run', 'run', 'disposed', 'created', 'run', 'disposed']);
  assert.equal(result.truncated[0]?.success, true);
  assert.equal(result.truncated[0]?.output, 0);
  assert.equal(result.truncated[0]?.traceLimitExceeded, true);
  assert.deepEqual(result.fallbackLifecycle.dispatches, [true, false]);
  assert.equal(result.fallbackTimeout.length, 1);
  assert.equal(result.fallbackTimeout[0]?.timeoutReason, 'client-timeout');
  assert.equal(result.fallbackTimeout[0]?.timings?.runMs, result.bound);
  assert.equal(result.fallbackTimeout[0]?.traceLimitExceeded, true);
  assert.deepEqual(result.fallbackTimeoutLifecycle.dispatches, [true, false]);
  assert.equal(result.abortName, 'AbortError');
  assert.equal(result.abortedWorkerTerminated, true);
  assert.deepEqual(result.abortLifecycle.dispatches, [true, false]);
}

function assertPreparedResult(
  result: PreparedBrowserResult,
  engine: BrowserEngine,
  isolated: boolean
): void {
  assert.equal(
    result.isolationOutputs.length,
    2,
    `${engine}: the complete mutable process-boundary probe must execute twice`
  );
  assert.equal(
    result.isolationOutputs[0],
    result.isolationOutputs[1],
    `${engine}: class initialization, statics, locale, time zone, working directory, environment, properties, standard streams, thread state, shutdown hooks, and runtime files must begin identically`
  );
  const boundaryFields = String(result.isolationOutputs[0]).split('|');
  assert.equal(
    boundaryFields[0],
    '101',
    `${engine}: static fields and class initialization must reset per case`
  );
  assert.equal(
    boundaryFields[4],
    'missing',
    `${engine}: custom System properties must not cross cases`
  );
  assert.equal(
    boundaryFields[5],
    'missing',
    `${engine}: arbitrary runtime filesystem writes must not cross cases`
  );
  assert.equal(
    boundaryFields[6],
    '0',
    `${engine}: background Java threads must not leak into the next case`
  );
  assert.equal(
    boundaryFields[11],
    'true',
    `${engine}: standard input and error streams must reset per case`
  );
  assert.equal(
    result.batchIsolationOutputs[0],
    result.batchIsolationOutputs[1],
    `${engine}: one leased runner must reset application classes and process state between batch cases`
  );
  const batchBoundaryFields = String(result.batchIsolationOutputs[0]).split('|');
  assert.equal(
    batchBoundaryFields[0],
    '101',
    `${engine}: batch application statics must begin clean`
  );
  assert.equal(
    batchBoundaryFields[4],
    'missing',
    `${engine}: batch System properties must begin clean`
  );
  assert.equal(
    batchBoundaryFields[5],
    'missing',
    `${engine}: batch TKFS state must begin clean`
  );
  assert.equal(
    result.batchRunnerProcessCount,
    2,
    `${engine}: ambient-capability Java must use a fresh inner runner process per case`
  );
  assert.equal(
    result.batchIsolationProfile?.tier,
    'compatibility',
    `${engine}: ambient process state must not enter the algorithm fast tier: ${JSON.stringify(result.batchIsolationProfile)}`
  );
  assert.equal(
    result.failureBatchRunnerProcessCount,
    1,
    `${engine}: ordinary learner exceptions must not replace the leased Java runner`
  );
  assert.equal(
    result.failureBatchIsolationProfile?.tier,
    'algorithm-fast',
    `${engine}: ordinary Java algorithm bytecode should retain one VM: ${JSON.stringify(result.failureBatchIsolationProfile)}`
  );
  assert.equal(
    result.failureBatchRecovered,
    true,
    `${engine}: the same leased Java runner must continue after learner exceptions`
  );
  assert.deepEqual(
    result.failureDiagnostic,
    {
      schema: 'tracecode.runtime-exception.v1',
      language: 'java',
      name: 'ArrayIndexOutOfBoundsException',
      qualifiedName: 'java.lang.ArrayIndexOutOfBoundsException',
      message: 'Index -1 out of bounds for array of length 0',
      frames: [{ function: 'Solution.inspect' }],
      stack: [
        'ArrayIndexOutOfBoundsException: Index -1 out of bounds for array of length 0',
        'at Solution.inspect',
      ].join('\n'),
    },
    `${engine}: learner exceptions must expose a stable diagnostic without generated package identities`
  );
  assert.deepEqual(
    result.algorithmLibraryOutputs,
    [107, 108],
    `${engine}: ordinary imports, collections, and learner statics must preserve output while resetting per case`
  );
  assert.equal(
    result.algorithmLibraryRunnerProcessCount,
    1,
    `${engine}: ordinary algorithm libraries must retain one inner JVM`
  );
  assert.ok(
    result.algorithmLibraryProfile?.schema ===
      'tracecode.java.algorithm-isolation-profile.v1' &&
      result.algorithmLibraryProfile.tier === 'algorithm-fast' &&
      result.algorithmLibraryProfile.boundary ===
        'fresh-application-class-loader' &&
      result.algorithmLibraryProfile.reasons?.length === 0 &&
      Number(result.algorithmLibraryProfile.scannedClasses) >= 1,
    `${engine}: ordinary imports must remain eligible for the Java algorithm tier`
  );
  assert.equal(
    result.leaseCeilingCorrect,
    true,
    `${engine}: retained Java execution must stay correct across the 64-execution lease boundary`
  );
  assert.equal(
    result.leaseCeilingRunnerProcessCount,
    2,
    `${engine}: a 65-case batch must retire the inner JVM at the 64-execution lease ceiling`
  );
  assert.deepEqual(
    result.printingOutputs,
    [7, 8],
    `${engine}: scoped stdout and stderr printing must preserve learner results`
  );
  assert.equal(
    result.printingRunnerProcessCount,
    1,
    `${engine}: scoped PrintStream output must not force one JVM per case: ${JSON.stringify(result.printingProfile)}`
  );
  assert.ok(
    result.printingProfile?.tier === 'algorithm-fast' &&
      result.printingProfile.reasons?.length === 0,
    `${engine}: scoped System.out/System.err printing must remain in the algorithm fast tier: ${JSON.stringify(result.printingProfile)}`
  );
  assert.deepEqual(
    result.internOutputs,
    [true, true],
    `${engine}: fresh compatibility JVMs must prevent String.intern state from crossing cases`
  );
  assert.equal(
    result.internRunnerProcessCount,
    2,
    `${engine}: String.intern must receive a fresh inner JVM per case`
  );
  assert.ok(
    result.internProfile?.tier === 'compatibility' &&
      result.internProfile.reasons?.some((reason) =>
        reason.startsWith('ambient-method:java/lang/String.intern')
      ),
    `${engine}: VM-global String.intern must select compatibility: ${JSON.stringify(result.internProfile)}`
  );
  assert.deepEqual(
    result.compatibilityStateOutputs,
    [0, 0],
    `${engine}: statics, system properties, background threads, modules, classloaders, and files must not leak between compatibility cases`
  );
  assert.equal(
    result.compatibilityStateRunnerProcessCount,
    2,
    `${engine}: ambient compatibility probes must receive one inner JVM per case`
  );
  assert.equal(
    result.compatibilityStateProfile?.tier,
    'compatibility',
    `${engine}: ambient state APIs must not enter the retained-process tier: ${JSON.stringify(result.compatibilityStateProfile)}`
  );
  assert.equal(
    result.ambientCapabilityProfile?.tier,
    'compatibility',
    `${engine}: ambient JVM capabilities must fall back: ${JSON.stringify(result.ambientCapabilityProfile)}`
  );
  const ambientReasons = result.ambientCapabilityProfile?.reasons ?? [];
  for (const expectedReasonPrefix of [
    'ambient-owner:java/io/',
    'ambient-owner:java/io/PrintStream',
    'ambient-owner:java/lang/ref/Cleaner',
    'ambient-owner:java/lang/ProcessBuilder',
    'ambient-owner:java/lang/Thread',
    'ambient-owner:java/lang/StackWalker',
    'ambient-owner:java/lang/System$LoggerFinder',
    'ambient-owner:java/net/',
    'ambient-owner:java/nio/file/',
    'ambient-owner:java/util/concurrent/',
    'ambient-owner:java/util/Calendar$Builder',
    'ambient-owner:java/util/random/RandomGenerator',
    'ambient-owner:java/util/stream/StreamSupport',
    'ambient-owner:java/util/zip/ZipFile',
    'ambient-descriptor:java/io/InputStream',
    'ambient-file-constructor:java/util/Formatter.<init>(Ljava/lang/String;)V',
    'ambient-method:java/lang/AutoCloseable.close()V',
    'ambient-method:java/lang/Boolean.getBoolean',
    'ambient-method:java/lang/Integer.getInteger',
    'ambient-method:java/lang/Long.getLong',
    'ambient-method:java/lang/String.intern',
    'ambient-method:java/util/Formatter.close()V',
    'ambient-method:java/lang/System.getProperty',
    'ambient-method:java/lang/System.getenv',
    'native-method:',
    'nondeterministic-rng:',
    'nondeterministic-time:java/time/Clock.tickSeconds',
    'nondeterministic-time:java/time/InstantSource.system',
    'nondeterministic-time:java/time/chrono/IsoChronology.dateNow',
    'nondeterministic-time:java/util/GregorianCalendar.<init>()V',
    'nondeterministic-time:java/util/GregorianCalendar.<init>(Ljava/util/TimeZone;)V',
    'nondeterministic-time:',
    'parallel-execution:harness/user/job',
    'reflective-method:java/lang/Class.forName',
  ]) {
    assert.ok(
      ambientReasons.some((reason) =>
        reason.startsWith(expectedReasonPrefix)
      ),
      `${engine}: missing Java compatibility reason ${expectedReasonPrefix}: ${JSON.stringify(ambientReasons)}`
    );
  }
  assert.equal(
    result.relabeledArtifactProfile?.tier,
    'compatibility',
    `${engine}: restore must ignore a caller-relabeled tier and retain the untrusted-artifact boundary`
  );
  assert.ok(
    result.relabeledArtifactProfile?.reasons?.includes(
      'restored-artifact-untrusted'
    ),
    `${engine}: restored artifacts must carry an explicit untrusted provenance reason`
  );
  assert.equal(
    result.relabeledArtifactRunnerProcessCount,
    2,
    `${engine}: a compatibility artifact relabeled fast must still use fresh inner JVMs`
  );
  assert.deepEqual(
    result.relabeledArtifactOutputs,
    [7, 8],
    `${engine}: compatibility fallback must preserve learner outputs`
  );
  assert.equal(
    result.forgedArtifactProfile?.tier,
    'compatibility',
    `${engine}: caller-forged entry identities must not admit restored bytes to the fast tier`
  );
  assert.ok(
    result.forgedArtifactProfile?.reasons?.includes(
      'restored-artifact-untrusted'
    ) &&
      result.forgedArtifactProfile.reasons.some((reason) =>
        reason.startsWith('native-method:')
      ),
    `${engine}: restored artifacts must scan every caller-supplied class and retain the untrusted-artifact reason: ${JSON.stringify(result.forgedArtifactProfile)}`
  );
  assert.equal(
    result.generatedIdentityDistinct,
    true,
    `${engine}: identical preparations must receive unpredictable generated-shell identities`
  );
  assert.ok(
    result.generatedLookalikeProfile?.tier === 'compatibility' &&
      result.generatedLookalikeProfile.reasons?.some((reason) =>
        reason.startsWith('ambient-method:java/lang/System.getProperty')
      ),
    `${engine}: learner classes shaped like nested generated shells must still be scanned: ${JSON.stringify(result.generatedLookalikeProfile)}`
  );
  assert.equal(
    result.listOutput,
    70,
    `${engine}: prepared arrays, generic collections/maps, nodes, custom objects, builders, and enums must be materialized`
  );
  assert.deepEqual(
    result.opsOutput,
    [null, 7, null, 2],
    `${engine}: prepared operation-class calls must preserve one-case object state`
  );
  assert.equal(
    result.traceOutput,
    6,
    `${engine}: prepared tracing must preserve the legacy result`
  );
  assert.deepEqual(
    result.sequentialTraceOutputs,
    [6, 9],
    `${engine}: consecutive single-case trace requests must preserve outputs across request-channel rebinding`
  );
  assert.deepEqual(
    result.sequentialTraceRunnerProcessCounts,
    isolated ? [1, 1] : [1, -1],
    isolated
      ? `${engine}: consecutive fast trace requests must reuse one clean inner JVM while rebinding the outer kernel request`
      : `${engine}: ordinary-document fallback must restore into compatibility after outer-worker retirement`
  );
  assert.equal(
    result.traceParity,
    true,
    `${engine}: prepared and legacy Java traces must have the same observable shape`
  );
  assert.deepEqual(
    result.traceBatchOutputs,
    [6, 9],
    `${engine}: prepared trace batches must preserve ordered outputs`
  );
  assert.equal(
    result.traceBatchRunnerProcessCount,
    isolated ? 1 : 2,
    isolated
      ? `${engine}: the admitted trace batch must share one clean inner JVM`
      : `${engine}: the restored compatibility artifact must use a fresh JVM for each trace case`
  );
  assert.equal(
    result.traceBatchHasEvents,
    true,
    `${engine}: trace-event transport must preserve every batch case`
  );
  assert.equal(
    result.traceResolvedMaxEvents,
    1_000,
    `${engine}: Java tracing must honor the stricter maxTraceSteps ceiling when maxStoredEvents is larger`
  );
  assert.deepEqual(
    result.mixedTraceOutputs,
    [6, 9, 6],
    `${engine}: traced and clean companion entry points must preserve ordered outputs`
  );
  assert.ok(
    result.mixedTraceEventCounts[0] > 0 &&
      result.mixedTraceEventCounts[1] === 0 &&
      result.mixedTraceEventCounts[2] > 0,
    `${engine}: one prepared artifact must trace only the selected cases`
  );
  assert.equal(
    result.mixedTraceRunnerProcessCount,
    1,
    `${engine}: mixed traced and clean cases must share one runner process`
  );
  assert.ok(
    result.traceKinds.includes('line') &&
      result.traceKinds.includes('return'),
    `${engine}: prepared tracing must emit semantic line and return events`
  );
  assert.ok(
    result.executionCompileMs.length >= 5 &&
      result.executionCompileMs.every((value) => value === 0),
    `${engine}: isolated executions must not report compilation work`
  );
  assert.ok(
    result.executionWorkerDeltas.length >= 6 &&
      (
        isolated
          ? result.executionWorkerDeltas.every((value) => value === 0)
          : result.executionWorkerDeltas.some((value) => value > 0)
      ),
    isolated
      ? `${engine}: kernel-bound Java cases must replace inner JVMs without replacing the warm compiler Worker`
      : `${engine}: compatibility execution without synchronous kernel transport must retire physical Workers`
  );
  assert.equal(
    result.timeoutBatchRecovered,
    true,
    `${engine}: a per-case timeout must retire the tainted runner and allow the next batch case to run`
  );
  assert.deepEqual(
    result.timeoutBatchKinds,
    ['limit', 'completed'],
    `${engine}: public prepared Judge results must classify a case wall-clock timeout as a limit`
  );
  assert.equal(
    result.timeoutBatchLimitReason,
    'client-timeout',
    `${engine}: public prepared Judge results must preserve the client-timeout reason`
  );
  assert.equal(
    result.timeoutBatchRunnerProcessCount,
    2,
    `${engine}: a timed-out fast-tier case must use a replacement JVM for the later case`
  );
  assert.equal(
    result.aborted,
    true,
    `${engine}: cancellation must abort a running prepared Java case`
  );
  assert.equal(
    result.terminatedWorkers,
    result.createdWorkers,
    `${engine}: every Java worker owned by the test must terminate exactly once`
  );
}

const traceJVMRoot = process.env.TRACECODE_TRACEJVM_ROOT
  ? resolve(process.env.TRACECODE_TRACEJVM_ROOT)
  : (await loadEngineRuntimePackages(resolve('.'))).tracejvm.sourceRoot;
const traceJVMUsesSourceLayout = Boolean(
  safeFile(traceJVMRoot, 'dist/browser-client.js')
);
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'java-prepared-provider-browser-')
);
const bundlePath = join(temporaryDirectory, 'test.js');
const stoppingBundlePath = join(temporaryDirectory, 'stopping.js');

try {
  await build({
    entryPoints: [
      resolve('tests/fixtures/java-prepared-provider-browser-entry.ts'),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const bundle = readFileSync(bundlePath);
  await build({
    entryPoints: [resolve('tests/fixtures/java-stopping-batch-browser-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    tsconfig: resolve('tsconfig.base.json'),
    alias: { 'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts') },
    outfile: stoppingBundlePath,
    logLevel: 'silent',
  });
  const stoppingBundle = readFileSync(stoppingBundlePath);

  const staticRoutes = new Map<string, string>([
    [
      '/workers/java-runtime-worker.js',
      resolve('workers/java/java-runtime-worker.js'),
    ],
    ['/workers/java-worker.js', resolve('workers/java/java-worker.js')],
    [
      '/workers/java-source-augmentations.js',
      resolve('workers/java/java-source-augmentations.js'),
    ],
    [
      '/workers/shared/tracekernel-syscall-client.js',
      resolve('workers/shared/tracekernel-syscall-client.js'),
    ],
    [
      '/workers/shared/tracekernel-local-java-host.js',
      resolve('workers/shared/tracekernel-local-java-host.js'),
    ],
    [
      '/workers/shared/runtime-kernel-policy-classic.js',
      resolve('workers/shared/runtime-kernel-policy-classic.js'),
    ],
    [
      '/workers/vendor/java-browser-helper.jar',
      resolve('workers/vendor/java-browser-helper.jar'),
    ],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('isolated') !== 'false') {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname === '/stopping.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(stoppingBundle);
      return;
    }
    if (url.pathname === '/tracejvm/browser-client.js' && url.searchParams.has('observe')) {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(`
        import { TraceJVMRunnerHost as RunnerHost } from './browser-client.js';
        export * from './browser-client.js';
        const post = self.postMessage.bind(self);
        const observe = (event, details) =>
          post({ type: 'test-java-runner', requestId: self.TraceCodeActiveKernelRequestId, payload: { event, ...details } });
        export class TraceJVMRunnerHost extends RunnerHost {
          async createProcess(...args) {
            const process = await super.createProcess(...args);
            let observed = false;
            const run = process.run.bind(process);
            const dispose = process.dispose.bind(process);
            process.run = (request) => {
              if (request.mainClass === 'tracecode.browser.TraceExecutionRunner') {
                if (!observed) observe('created');
                observed = true;
                observe('run', { tracing: request.args?.[4] !== 'notrace' });
              }
              return run(request);
            };
            process.dispose = () => {
              dispose();
              if (observed) observe('disposed');
            };
            return process;
          }
        }
      `);
      return;
    }
    if (url.pathname === '/test.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }

    const staticPath = staticRoutes.get(url.pathname);
    if (staticPath) {
      response.setHeader('content-type', contentType(staticPath));
      const source = readFileSync(staticPath);
      response.end(url.pathname === '/workers/java-runtime-worker.js' && url.searchParams.has('probe')
        ? source.toString().replace("new URL('browser-client.js', TRACEJVM_BASE_URL)", "new URL('browser-client.js?observe', TRACEJVM_BASE_URL)")
        : source);
      return;
    }

    if (url.pathname.startsWith('/tracejvm/')) {
      const requested = url.pathname.slice('/tracejvm/'.length);
      const relative = traceJVMUsesSourceLayout
        ? requested === 'browser-client.js'
          ? 'dist/browser-client.js'
          : requested === 'browser-worker.js'
            ? 'dist/browser-worker.js'
            : requested.startsWith('compiler/')
              ? `.cache/teavm-javac/artifacts/${requested.slice('compiler/'.length)}`
              : `runtime/assets/${requested}`
        : requested;
      const path = safeFile(traceJVMRoot, relative);
      if (!path) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('content-type', contentType(path));
      response.end(readFileSync(path));
      return;
    }

    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(url.searchParams.has('stopping')
      ? '<!doctype html><script src="/stopping.js"></script>'
      : '<!doctype html><script src="/test.js"></script>');
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Java prepared-provider browser server did not bind.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const requestedEngines = (
      process.env.TRACECODE_JAVA_PREPARED_ENGINES ??
      'chromium,firefox,webkit'
    )
      .split(',')
      .map((engine) => engine.trim())
      .filter(Boolean) as BrowserEngine[];

    for (const engine of requestedEngines) {
      const browserType = browserTypes[engine];
      if (!browserType) throw new Error(`Unknown browser engine: ${engine}`);
      const stoppingOnly = process.env.TRACECODE_JAVA_STOPPING_ONLY === '1';
      const isolationModes = stoppingOnly ? [false] : engine === 'chromium' ? [true, false] : [true];
      for (const isolated of isolationModes) {
        const browser = await browserType.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const browserMessages: string[] = [];
          page.on('console', (message) => {
            if (message.type() === 'error') {
              browserMessages.push(`[console] ${message.text()}`);
            }
          });
          page.on('pageerror', (error) => {
            browserMessages.push(`[pageerror] ${error.message}`);
          });
          await page.goto(`${origin}?isolated=${isolated}`);
          assert.equal(
            await page.evaluate(() => globalThis.crossOriginIsolated),
            isolated,
            `${engine}: test document must exercise the requested isolation mode`
          );
          if (!isolated) {
            await page.goto(`${origin}?isolated=false&stopping`);
            const companion = await page.evaluate(() => globalThis.javaCompanionProbe());
            assert.deepEqual(companion.admission, [0, 1, 2]);
            assert.deepEqual(companion.outcomes[0]?.slice(0, 2), ['failed', ['ordinary 0']]);
            assert.deepEqual(companion.outcomes[1], ['completed', ['ordinary 1'], 2]);
            assert.equal(companion.outcomes[2]?.[2], 'client-timeout');
            assert.equal(companion.positive.status, 'drawn');
            assert.equal(companion.failed?.status, 'drawn');
            assert.equal(companion.step.status, 'truncated');
            assert.equal(companion.byte.status, 'truncated');
            assert.equal(companion.line.status, 'truncated');
            assert.equal(companion.singleLine.status, 'truncated', JSON.stringify(companion.singleLine));
            if (companion.step.status === 'truncated' && companion.byte.status === 'truncated' &&
              companion.line.status === 'truncated' && companion.singleLine.status === 'truncated') {
              assert.equal(companion.step.reason, 'step-budget');
              assert.ok(companion.step.trace.events.length > 0);
              assert.equal(companion.byte.reason, 'byte-budget');
              assert.equal(companion.byte.trace.events.length, 0);
              assert.equal(companion.byte.attemptedEvents, 1);
              assert.equal(companion.line.reason, 'line-budget');
              assert.equal(companion.singleLine.reason, 'single-line-budget');
            }
            assert.equal(companion.workers, 2);
            assert.deepEqual(companion.cache, [[false, false], [true, true]]);
            assert.deepEqual(companion.submit, [3]);
            const prepares = companion.requests.filter(({ type }) => type === 'prepare-runtime-program');
            assert.deepEqual(prepares.map(({ worker, observer }) => [worker, Boolean(observer)])
              .sort(([a], [b]) => Number(a) - Number(b)),
              [[1, false], [1, false], [2, true]]);
            assert.deepEqual(companion.requests.filter(({ type }) =>
              type === 'execute-prepared-runtime-program-batch')
              .map(({ worker, count }) => [worker, count]).sort(([a], [b]) => a! - b!),
              [[1, 4], [1, 1], ...Array.from({ length: 6 }, () => [2, 1])]);
            assert.ok(!companion.requests.some(({ type }) => type === 'restore-prepared-runtime-program'));
            console.log('PASS: separate Java observer preserves the ordinary batch and reuses its artifact');
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const probe = await Promise.race([
              page.evaluate(() => globalThis.javaStoppingBatchProbe()),
              new Promise<never>((_, reject) => {
                deadline = setTimeout(() => reject(new Error('Java stopping batch probe exceeded 45 seconds')), 45_000);
              }),
            ]).finally(() => clearTimeout(deadline));
            assertStoppingBatch(probe, engine);
            console.log(`PASS: Java stopping batches in ${engine} (ordinary document)`);
            if (stoppingOnly) continue;
            await page.goto(`${origin}?isolated=false`);
          }
          const consoleResults = await page.evaluate(() => {
            if (!globalThis.runJavaConsoleCases) {
              throw new Error('Java console fixture did not initialize.');
            }
            return globalThis.runJavaConsoleCases();
          });
          assertConsoleResults(consoleResults, engine);
          console.log(`PASS: Java consoleOutput retains stdout on success and failure in ${engine} (${isolated ? 'cross-origin isolated' : 'ordinary document'})`);
          const result = await page.evaluate(async () => {
            if (!globalThis.runJavaPreparedProviderBrowserTest) {
              throw new Error(
                'Java prepared-provider browser fixture did not initialize.'
              );
            }
            return globalThis.runJavaPreparedProviderBrowserTest();
          });
          try {
            assertPreparedResult(result, engine, isolated);
          } catch (error) {
            if (browserMessages.length > 0) {
              console.error(browserMessages.join('\n'));
            }
            throw error;
          }
          console.log(
            `PASS: Java prepared provider compiles once and isolates every case in ${engine} (${isolated ? 'cross-origin isolated' : 'ordinary document'}); 2 failures + recovery ${result.failureBatchElapsedMs.toFixed(1)}ms`
          );
        } finally {
          await browser.close();
        }
      }
    }
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
