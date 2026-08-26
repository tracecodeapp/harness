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
      ? `${engine}: one kernel-bound runner must own the complete trace batch`
      : `${engine}: caller-carried restore must retain the fresh-process compatibility boundary`
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
    if (url.pathname === '/test.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(bundle);
      return;
    }

    const staticPath = staticRoutes.get(url.pathname);
    if (staticPath) {
      response.setHeader('content-type', contentType(staticPath));
      response.end(readFileSync(staticPath));
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
    response.end('<!doctype html><script src="/test.js"></script>');
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
      const isolationModes = engine === 'chromium' ? [true, false] : [true];
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
