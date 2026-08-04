#!/usr/bin/env npx tsx

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium } from 'playwright';

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
    'workers/vendor/csharp-compiler/_framework/dotnet.boot.js'
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

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const result = await page.evaluate(async ({ origin, runnerAssetPath }) => {
      type Reply = {
        success?: boolean;
        output?: unknown;
        error?: string;
        events?: Array<Record<string, unknown>>;
        compiledArtifactKey?: string;
        compiledArtifactBase64?: string;
        compiledArtifactSha256?: string;
        trustedPreparedArtifact?: {
          mode: 'code' | 'trace';
          code: string;
          functionName: string;
          executionStyle: 'solution-method';
          compiledArtifactKey: string;
          compiledArtifactBase64: string;
          compiledArtifactSha256: string;
        };
        timings?: {
          compileCacheHit?: boolean;
          artifactCacheHit?: boolean;
          warmupMs?: number;
          compileMs?: number;
          compileTrustedTemplateHit?: boolean;
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

      const source =
        'public class Solution { public int Add(int left, int right) => left + right; }';
      const structuredSource = `
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

public sealed class Payload
{
    public string Name { get; set; } = "";
    public List<int> Values { get; set; } = new();
    public Dictionary<string, int> Weights { get; set; } = new();
}

public class Solution
{
    public string Inspect(Payload payload)
    {
        var document = JsonDocument.Parse("{\\"ok\\":true}");
        var matched = Regex.IsMatch(payload.Name, "^[A-Z]");
        var totals = (Sum: payload.Values.Sum(), Weight: payload.Weights["x"]);
        return $"{payload.Name}:{totals.Sum}:{totals.Weight}:{matched}:{document.RootElement.GetProperty("ok").GetBoolean()}";
    }
}`;
      const compilerBaseUrl = `${origin}/workers/vendor/csharp-compiler`;
      const runnerBaseUrl = `${origin}/${runnerAssetPath}`;
      const compiler = await createHarness('compiler', compilerBaseUrl);
      const compilerWarmup = await compiler.send('warmup', {
        assetBaseUrl: compilerBaseUrl,
        runtimeRole: 'compiler',
      });
      const prepared = await compiler.send('prepare-program', {
        mode: 'code',
        code: source,
        functionName: 'Add',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
      });
      const structuredPrepared = await compiler.send('prepare-program', {
        mode: 'code',
        code: structuredSource,
        functionName: 'Inspect',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
      });
      const structuredTracePrepared = await compiler.send('prepare-program', {
        mode: 'trace',
        code: structuredSource,
        functionName: 'Inspect',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
        traceOptions: {
          maxTraceSteps: 10_000,
          maxStoredEvents: 10_000,
        },
      });
      compiler.terminate();

      const descriptor = (
        candidateSource: string,
        functionName: string,
        mode: 'code' | 'trace',
        candidate: Reply
      ) => ({
        mode,
        code: candidateSource,
        functionName,
        executionStyle: 'solution-method',
        compiledArtifactKey: candidate.compiledArtifactKey,
        compiledArtifactBase64: candidate.compiledArtifactBase64,
        compiledArtifactSha256: candidate.compiledArtifactSha256,
      });
      const addDescriptor = descriptor(source, 'Add', 'code', prepared);
      const runner = await createHarness('runner', runnerBaseUrl);
      const runnerPrime = await runner.send('execute-prepared-code', {
        prepared: compilerWarmup.trustedPreparedArtifact,
        inputs: { a: 1, b: 2 },
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      const valid = await runner.send('execute-prepared-code', {
        prepared: addDescriptor,
        inputs: { left: 19, right: 23 },
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      runner.terminate();

      const structuredInputs = {
        payload: {
          Name: 'Ada',
          Values: [1, 2, 3],
          Weights: { x: 7 },
        },
      };
      const structuredRunner = await createHarness('runner', runnerBaseUrl);
      const structured = await structuredRunner.send('execute-prepared-code', {
        prepared: descriptor(
          structuredSource,
          'Inspect',
          'code',
          structuredPrepared
        ),
        inputs: structuredInputs,
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      structuredRunner.terminate();

      const traceRunner = await createHarness('runner', runnerBaseUrl);
      const structuredTrace = await traceRunner.send('execute-prepared-trace', {
        prepared: descriptor(
          structuredSource,
          'Inspect',
          'trace',
          structuredTracePrepared
        ),
        inputs: structuredInputs,
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      traceRunner.terminate();

      const tamperRunner = await createHarness('runner', runnerBaseUrl);
      const tampered = await tamperRunner.send('execute-prepared-code', {
        prepared: {
          ...addDescriptor,
          compiledArtifactSha256: '0'.repeat(64),
        },
        inputs: { left: 19, right: 23 },
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      tamperRunner.terminate();
      return {
        prepared,
        compilerWarmup,
        structuredPrepared,
        structuredTracePrepared,
        runnerPrime,
        valid,
        structured,
        structuredTrace,
        tampered,
      };
    }, { origin, runnerAssetPath });

    assertCondition(
      result.compilerWarmup.success &&
        (result.compilerWarmup.timings?.warmupMs ?? 0) > 0,
      `Trusted C# compiler warmup did not prime one fixed emit: ${JSON.stringify(result.compilerWarmup)}`
    );
    assertCondition(
      result.prepared.success &&
        /^[0-9a-f]{64}$/u.test(result.prepared.compiledArtifactSha256 ?? '') &&
        result.prepared.timings?.compileTrustedTemplateHit === true,
      `Trusted C# compiler did not emit a SHA-256-bound artifact: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.runnerPrime.success &&
        result.runnerPrime.output === 3 &&
        result.runnerPrime.timings?.artifactCacheHit === true,
      `Disposable C# runner did not execute the fixed trusted prime artifact: ${JSON.stringify(result.runnerPrime)}`
    );
    assertCondition(
      result.valid.success &&
        result.valid.output === 42 &&
        result.valid.timings?.compileCacheHit === true &&
        result.valid.timings?.artifactCacheHit === true,
      `Disposable C# runner did not execute the compiler artifact: ${JSON.stringify(result.valid)}`
    );
    assertCondition(
      result.structuredPrepared.success &&
        result.structuredTracePrepared.success,
      `Trusted C# compiler did not prepare structured code and trace artifacts: ${JSON.stringify({
        code: result.structuredPrepared,
        trace: result.structuredTracePrepared,
      })}`
    );
    assertCondition(
      result.structured.success &&
        result.structured.output === 'Ada:6:7:True:True' &&
        result.structured.timings?.compileCacheHit === true,
      `Disposable C# runner lost dynamic object/BCL semantics: ${JSON.stringify(result.structured)}`
    );
    assertCondition(
      result.structuredTrace.success &&
        result.structuredTrace.output === 'Ada:6:7:True:True' &&
        (result.structuredTrace.events?.length ?? 0) > 0 &&
        result.structuredTrace.timings?.compileCacheHit === true,
      `Disposable C# runner lost structured tracing semantics: ${JSON.stringify(result.structuredTrace)}`
    );
    assertCondition(
      result.tampered.success === false &&
        result.tampered.error ===
          'Prepared C# artifact is unavailable or invalid.' &&
        result.tampered.timings?.compileCacheHit === false &&
        result.tampered.timings?.artifactCacheHit === false,
      `Disposable C# runner did not reject a tampered artifact: ${JSON.stringify(result.tampered)}`
    );
    console.log(
      JSON.stringify({
        compilerHash: result.prepared.compiledArtifactSha256,
        compilerPrimeMs: result.compilerWarmup.timings?.warmupMs,
        visibleCompileMs: result.prepared.timings?.compileMs,
        trustedRunnerPrimeOutput: result.runnerPrime.output,
        validOutput: result.valid.output,
        structuredOutput: result.structured.output,
        structuredTraceEvents: result.structuredTrace.events?.length ?? 0,
        tamperedRejected: true,
        runnerAssetPath,
      })
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
