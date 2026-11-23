#!/usr/bin/env npx tsx

// A warm C# runner must not report an untraced algorithm-fast case as timed
// out because of a trace run that finished earlier on the same worker.
//
// Regression: RuntimeTraceSink.Reset() (run in every traced execution's
// finally) re-armed the static sink with recording on and a deadline two
// seconds out, and the untraced algorithm-fast path never configured the sink.
// The next untraced case that started more than two seconds later hit the
// expired deadline on its first instrumented line and came back as
// "C# execution timed out." (client-timeout) within milliseconds.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const ROOT = process.cwd();

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function main(): Promise<void> {
  const runnerAssetPath = (
    process.env.TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH ??
    'workers/vendor/csharp-runner'
  ).replace(/^\/+/u, '');
  assertCondition(
    runnerAssetPath.length > 0 &&
      !runnerAssetPath.split('/').some((segment) => segment === '..'),
    'TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH must be a repository-relative path.'
  );
  const compilerBoot = join(
    ROOT,
    'workers/vendor/csharp/_framework/dotnet.boot.js'
  );
  const runnerBoot = join(
    ROOT,
    runnerAssetPath,
    '_framework/dotnet.boot.js'
  );
  assertCondition(
    existsSync(compilerBoot) && existsSync(runnerBoot),
    'Expected explicit C# compiler and runner bundles; run pnpm update:csharp-runtime.'
  );

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const file = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(file)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(file),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assertCondition(address && typeof address !== 'string', 'Expected server port.');
  const origin = `http://127.0.0.1:${address.port}`;

  const engineName = process.env.TRACECODE_CSHARP_BROWSER_ENGINE ?? 'chromium';
  const browserTypes: Record<string, BrowserType> = {
    chromium,
    firefox,
    webkit,
  };
  const browserType = browserTypes[engineName];
  assertCondition(browserType, `Unsupported C# browser engine: ${engineName}`);
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const result = await page.evaluate(async ({
      origin,
      runnerAssetPath,
      staleGapMs,
    }) => {
      type Reply = {
        success?: boolean;
        output?: unknown;
        error?: string;
        events?: Array<Record<string, unknown>>;
        traceLimitExceeded?: boolean;
        timeoutReason?: string | null;
        compiledArtifactKey?: string;
        compiledArtifactBase64?: string;
        compiledArtifactSha256?: string;
        preparedRunnerTier?: 'algorithm-fast' | 'compatibility';
        preparedRunnerReason?: string;
        traceClrWireContract?: {
          parameters: Array<{ name: string; type: { wireType: string } }>;
          returnType: { wireType: string };
        };
        outputBytes?: Uint8Array;
        trustedPreparedArtifact?: {
          mode: 'code' | 'trace';
          code: string;
          functionName: string;
          executionStyle: 'solution-method';
          compiledArtifactKey: string;
          compiledArtifactBase64: string;
          compiledArtifactSha256: string;
          preparedRunnerTier: 'algorithm-fast' | 'compatibility';
          preparedRunnerReason: string;
        };
        timings?: {
          compileCacheHit?: boolean;
          artifactCacheHit?: boolean;
          warmupMs?: number;
          compileMs?: number;
          compileTrustedTemplateHit?: boolean;
          executionRealm?: string;
          wasmLinearMemoryBytes?: number;
          managedHeapBytes?: number;
        };
      };

      const artifacts = new Map<string, string>();
      const createHarness = async (
        role: 'compiler' | 'runner',
        assetBaseUrl: string
      ) => {
        const worker = new Worker('/workers/csharp/csharp-worker.js', {
          type: 'module',
        });
        let nextId = 0;
        const pending = new Map<
          string,
          {
            resolve(value: Reply): void;
            reject(error: Error): void;
            protocolToken: string;
          }
        >();
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'compiler-artifact-cache-request') {
            const request = event.data.payload ?? {};
            if (
              request.operation === 'put' &&
              typeof request.key === 'string' &&
              typeof request.value === 'string'
            ) {
              artifacts.set(request.key, request.value);
            }
            const value =
              request.operation === 'get' && typeof request.key === 'string'
                ? artifacts.get(request.key)
                : undefined;
            worker.postMessage({
              type: 'compiler-artifact-cache-response',
              requestId: event.data.requestId,
              protocolToken: event.data.protocolToken,
              payload: {
                hit: value !== undefined,
                ...(value === undefined ? {} : { value }),
                stored:
                  request.operation === 'put' &&
                  typeof request.key === 'string' &&
                  artifacts.has(request.key),
              },
            });
            return;
          }
          const request = pending.get(event.data?.id);
          if (
            !request ||
            event.data?.protocolToken !== request.protocolToken
          ) {
            return;
          }
          pending.delete(event.data.id);
          if (event.data.type === 'error') {
            request.reject(
              new Error(event.data?.payload?.error ?? 'C# worker error')
            );
          } else {
            request.resolve(event.data?.payload ?? {});
          }
        });
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || 'C# worker failed');
          for (const request of pending.values()) request.reject(error);
          pending.clear();
        });
        const send = (type: string, payload: unknown): Promise<Reply> => {
          const id = String(++nextId);
          const protocolToken = `${role}-${id}-${crypto.randomUUID()}`;
          return new Promise<Reply>((resolve, reject) => {
            pending.set(id, { resolve, reject, protocolToken });
            worker.postMessage({ id, type, payload, protocolToken });
          });
        };
        await send('init', { assetBaseUrl, runtimeRole: role });
        return { send, terminate: () => worker.terminate() };
      };

      const source = `
public class Solution
{
    public int Add(int left, int right)
    {
        var total = left;
        for (var index = 0; index < right; index++)
        {
            total += 1;
        }
        return total;
    }
}`;
      const runawaySource = `
public class Solution
{
    public int Add(int left, int right)
    {
        var total = left;
        while (right >= 0)
        {
            total += 1;
        }
        return total;
    }
}`;
      const compilerBaseUrl = `${origin}/workers/vendor/csharp`;
      const runnerBaseUrl = `${origin}/${runnerAssetPath}`;
      const compiler = await createHarness('compiler', compilerBaseUrl);
      const compilerWarmup = await compiler.send('warmup', {
        assetBaseUrl: compilerBaseUrl,
        runtimeRole: 'compiler',
      });
      const prepareProgram = (
        mode: 'code' | 'trace',
        code: string
      ): Promise<Reply> =>
        compiler.send('prepare-program', {
          mode,
          code,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
          ...(mode === 'trace'
            ? { traceOptions: { maxTraceSteps: 10_000, maxStoredEvents: 10_000 } }
            : {}),
        });
      const codePrepared = await prepareProgram('code', source);
      const tracePrepared = await prepareProgram('trace', source);
      const runawayTracePrepared = await prepareProgram('trace', runawaySource);
      compiler.terminate();

      const descriptor = (mode: 'code' | 'trace', candidate: Reply, code = source) => ({
        mode,
        code,
        functionName: 'Add',
        executionStyle: 'solution-method',
        compiledArtifactKey: candidate.compiledArtifactKey,
        compiledArtifactBase64: candidate.compiledArtifactBase64,
        compiledArtifactSha256: candidate.compiledArtifactSha256,
        preparedRunnerTier: candidate.preparedRunnerTier,
        preparedRunnerReason: candidate.preparedRunnerReason,
        ...(mode === 'trace'
          ? {
              traceOptions: {
                maxTraceSteps: 10_000,
                maxLineEvents: 10_000,
                maxSingleLineHits: 10_000,
                maxStoredEvents: 10_000,
              },
            }
          : {}),
        ...(candidate.traceClrWireContract
          ? { traceClrWireContract: candidate.traceClrWireContract }
          : {}),
      });
      const encodeInt32s = (...values: number[]): Uint8Array => {
        const bytes = new Uint8Array(6 + values.length * 4);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x31574354, true);
        view.setUint16(4, values.length, true);
        values.forEach((value, index) => view.setInt32(6 + index * 4, value, true));
        return bytes;
      };
      const decodeInt32 = (bytes: Uint8Array | undefined): number | null => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 8) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return view.getUint32(0, true) === 0x31574354
          ? view.getInt32(4, true)
          : null;
      };
      const summarize = (reply: Reply, startedAt: number) => ({
        success: reply.success === true,
        output: decodeInt32(reply.outputBytes) ?? reply.output ?? null,
        error: reply.error ?? null,
        timeoutReason: reply.timeoutReason ?? null,
        eventCount: reply.events?.length ?? 0,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      const runUntraced = async (
        runner: Awaited<ReturnType<typeof createHarness>>,
        left: number,
        right: number
      ) => {
        const startedAt = performance.now();
        const reply = await runner.send('execute-prepared-code', {
          prepared: descriptor('code', codePrepared),
          inputs: { left, right },
          inputBytes: encodeInt32s(left, right),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 30_000,
        });
        return summarize(reply, startedAt);
      };
      const runTraced = async (
        runner: Awaited<ReturnType<typeof createHarness>>,
        candidate: Reply,
        code: string,
        left: number,
        right: number,
        timeoutMs = 30_000
      ) => {
        const startedAt = performance.now();
        const reply = await runner.send('execute-prepared-trace', {
          prepared: descriptor('trace', candidate, code),
          inputs: { left, right },
          inputBytes: encodeInt32s(left, right),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs,
        });
        return summarize(reply, startedAt);
      };
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // Fresh runner: the untraced case alone (control).
      const freshRunner = await createHarness('runner', runnerBaseUrl);
      const freshUntraced = await runUntraced(freshRunner, 19, 23);
      freshRunner.terminate();

      // Warm runner: traced case, a pause past the sink's two-second
      // re-armed deadline, then untraced cases (a verdict request).
      const warmRunner = await createHarness('runner', runnerBaseUrl);
      const warmTraced = await runTraced(warmRunner, tracePrepared, source, 19, 23);
      await sleep(staleGapMs);
      const warmUntraced = [] as Array<ReturnType<typeof summarize>>;
      for (let index = 0; index < 3; index += 1) {
        warmUntraced.push(await runUntraced(warmRunner, 19 + index, 23));
      }
      // Back-to-back (no pause): untraced cases must not record trace events.
      const backToBackTraced = await runTraced(warmRunner, tracePrepared, source, 1, 2);
      const backToBackUntraced = await runUntraced(warmRunner, 1, 2);
      warmRunner.terminate();

      // A standby runner primed the way the browser provider primes it: the
      // compiler's trusted artifact (a trace-mode descriptor) run as code.
      // The learner's first case arrives later on that runner.
      const primedRunner = await createHarness('runner', runnerBaseUrl);
      const primeStartedAt = performance.now();
      const prime = summarize(
        await primedRunner.send('execute-prepared-code', {
          prepared: compilerWarmup.trustedPreparedArtifact,
          inputs: { a: 1, b: 2 },
          inputBytes: encodeInt32s(1, 2),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }),
        primeStartedAt
      );
      await sleep(staleGapMs);
      const afterPrime = await runUntraced(primedRunner, 19, 23);
      primedRunner.terminate();

      // Reverse direction: a real traced runaway still reports its own
      // in-runtime deadline as client-timeout, and the runner then serves an
      // untraced case normally after the stale gap.
      const runawayRunner = await createHarness('runner', runnerBaseUrl);
      const runaway = await runTraced(
        runawayRunner,
        runawayTracePrepared,
        runawaySource,
        0,
        1,
        1_000
      );
      await sleep(staleGapMs);
      const afterRunaway = await runUntraced(runawayRunner, 19, 23);
      runawayRunner.terminate();

      return {
        codeTier: codePrepared.preparedRunnerTier ?? null,
        traceTier: tracePrepared.preparedRunnerTier ?? null,
        freshUntraced,
        warmTraced,
        warmUntraced,
        backToBackTraced,
        backToBackUntraced,
        prime,
        afterPrime,
        runaway,
        afterRunaway,
      };
    }, {
      origin,
      runnerAssetPath,
      staleGapMs: 2_500,
    });

    console.log(JSON.stringify(result, null, 2));
    assertCondition(
      result.codeTier === 'algorithm-fast' && result.traceTier === 'algorithm-fast',
      `Expected algorithm-fast artifacts: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.freshUntraced.success && result.freshUntraced.output === 42,
      `Fresh-runner untraced case failed: ${JSON.stringify(result.freshUntraced)}`
    );
    assertCondition(
      result.warmTraced.success && result.warmTraced.output === 42 && result.warmTraced.eventCount > 0,
      `Warm-runner traced case failed: ${JSON.stringify(result.warmTraced)}`
    );
    result.warmUntraced.forEach((reply, index) => {
      assertCondition(
        reply.success && reply.output === 42 + index && reply.timeoutReason === null,
        `Untraced case ${index + 1} after a traced case on a warm runner was not run normally (stale trace deadline): ${JSON.stringify(reply)}`
      );
    });
    assertCondition(
      result.backToBackTraced.success && result.backToBackUntraced.success &&
        result.backToBackUntraced.output === 3,
      `Back-to-back traced then untraced cases failed: ${JSON.stringify({ traced: result.backToBackTraced, untraced: result.backToBackUntraced })}`
    );
    assertCondition(
      result.prime.success && result.prime.output === 3,
      `Trusted standby prime failed: ${JSON.stringify(result.prime)}`
    );
    assertCondition(
      result.afterPrime.success && result.afterPrime.output === 42 && result.afterPrime.timeoutReason === null,
      `First learner case on a primed standby runner was not run normally (stale trace deadline): ${JSON.stringify(result.afterPrime)}`
    );
    assertCondition(
      !result.runaway.success && result.runaway.timeoutReason === 'client-timeout',
      `A real traced C# runaway must still report client-timeout: ${JSON.stringify(result.runaway)}`
    );
    assertCondition(
      result.afterRunaway.success && result.afterRunaway.output === 42,
      `Untraced case after a traced runaway was not run normally: ${JSON.stringify(result.afterRunaway)}`
    );
    console.log('C# stale trace deadline browser test passed.');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
