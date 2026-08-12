#!/usr/bin/env npx tsx

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
    const result = await page.evaluate(async ({ origin, runnerAssetPath }) => {
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
        if (left < 0)
        {
            throw new System.InvalidOperationException("learner boom");
        }
        var total = left + right;
        return total;
    }
}`;
      const enumerableSource = `
using System.Collections.Generic;
using System.Linq;

public class Solution
{
    public IEnumerable<int> Expand(int count) => Enumerable.Range(0, count);
}`;
      const structuredSource = `
using System.ComponentModel.DataAnnotations;
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
        var validation = new ValidationResult("valid");
        return $"{payload.Name}:{totals.Sum}:{totals.Weight}:{matched}:{document.RootElement.GetProperty("ok").GetBoolean()}:{validation.ErrorMessage}";
    }
}`;
      const reflectiveInputMutationSource = `
using System;
using System.Reflection;
using System.Runtime.CompilerServices;

public static class ReflectiveInputHijack
{
    [ModuleInitializer]
    public static void Initialize()
    {
        object domain = AppDomain.CurrentDomain;
        foreach (var assembly in ((AppDomain)domain).GetAssemblies())
        {
            var context = assembly.GetType(
                string.Concat("TraceCode.CSharp", "Host.JudgeRuntimeContext")
            );
            var setter = context?.GetMethod(
                string.Concat("SetCurrentInputs", "Json"),
                BindingFlags.Static | BindingFlags.NonPublic
            );
            setter?.Invoke(
                null,
                new object?[] { "{\\"left\\":100,\\"right\\":200}" }
            );
        }
    }
}

public class Solution
{
    public int Add(int left, int right) => left + right;
}`;
      const directTraceSinkMutationSource = `
public class Solution
{
    public int Add(int left, int right)
    {
        TraceCode.CSharpHost.RuntimeTraceSink.Reset();
        return left + right;
    }
}`;
      const voidOutputSource = `
using System.Collections.Generic;

public class Solution
{
    public void Transform(List<int> values)
    {
        _ = values.Contains(1);
    }

    public void Transform(string[] values)
    {
        values[0] = "changed";
    }
}`;
      const directTraceWrapperMutationSource = `
using System;

public class Solution
{
    public int Add(int left, int right)
    {
        TraceCode.Internal.TraceCodeTrace.Mutate(
            "forged",
            "Clear",
            Array.Empty<object?>()
        );
        return left + right;
    }
}`;
      const dynamicTraceSinkMutationSource = `
public class Solution
{
    public int Add(int left, int right)
    {
        ((dynamic)new ListNode())
            .GetType()
            .Assembly
            .GetType("TraceCode.CSharpHost.RuntimeTraceSink")
            ?.GetMethod("Reset")
            ?.Invoke(null, null);
        return left + right;
    }
}`;
      const compilerBaseUrl = `${origin}/workers/vendor/csharp`;
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
      const fastTracePrepared = await compiler.send('prepare-program', {
        mode: 'trace',
        code: source,
        functionName: 'Add',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
        traceOptions: {
          maxTraceSteps: 10_000,
          maxStoredEvents: 10_000,
        },
      });
      const enumerablePrepared = await compiler.send('prepare-program', {
        mode: 'code',
        code: enumerableSource,
        functionName: 'Expand',
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
      const inputMutationPrepared = await compiler.send('prepare-program', {
        mode: 'code',
        code: `
using System.Runtime.CompilerServices;

public static class InputHijack
{
    [ModuleInitializer]
    public static void Initialize()
    {
        TraceCode.CSharpHost.JudgeRuntimeContext.SetCurrentInputsJson(
            "{\\"left\\":100,\\"right\\":200}"
        );
    }
}

public class Solution
{
    public int Add(int left, int right) => left + right;
}`,
        functionName: 'Add',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
      });
      const reflectiveInputMutationPrepared = await compiler.send(
        'prepare-program',
        {
          mode: 'code',
          code: reflectiveInputMutationSource,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      const directTraceSinkMutationPrepared = await compiler.send(
        'prepare-program',
        {
          mode: 'trace',
          code: directTraceSinkMutationSource,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      const voidOutputPrepared = await compiler.send('prepare-program', {
        mode: 'code',
        code: voidOutputSource,
        functionName: 'Transform',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
      });
      const directTraceWrapperMutationPrepared = await compiler.send(
        'prepare-program',
        {
          mode: 'trace',
          code: directTraceWrapperMutationSource,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      const dynamicTraceSinkMutationPrepared = await compiler.send(
        'prepare-program',
        {
          mode: 'trace',
          code: dynamicTraceSinkMutationSource,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
        }
      );
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
      const encodeTwoInt32 = (left: number, right: number): Uint8Array => {
        const bytes = new Uint8Array(14);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x31574354, true);
        view.setUint16(4, 2, true);
        view.setInt32(6, left, true);
        view.setInt32(10, right, true);
        return bytes;
      };
      const decodeInt32 = (bytes: Uint8Array | undefined): number | null => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 8) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return view.getUint32(0, true) === 0x31574354
          ? view.getInt32(4, true)
          : null;
      };
      const addDescriptor = descriptor(source, 'Add', 'code', prepared);
      const runner = await createHarness('runner', runnerBaseUrl);
      const runnerPrime = await runner.send('execute-prepared-code', {
        prepared: compilerWarmup.trustedPreparedArtifact,
        inputs: { a: 1, b: 2 },
        inputBytes: encodeTwoInt32(1, 2),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      const valid = await runner.send('execute-prepared-code', {
        prepared: addDescriptor,
        inputs: { left: 19, right: 23 },
        inputBytes: encodeTwoInt32(19, 23),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      runner.terminate();

      const fastTraceRunner = await createHarness('runner', runnerBaseUrl);
      const fastTrace = await fastTraceRunner.send('execute-prepared-trace', {
        prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
        inputs: { left: 19, right: 23 },
        inputBytes: encodeTwoInt32(19, 23),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      fastTraceRunner.terminate();

      const fastTraceDisabledRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const fastTraceDisabled = await fastTraceDisabledRunner.send(
        'execute-prepared-trace',
        {
          prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
          inputs: { left: 19, right: 23 },
          inputBytes: encodeTwoInt32(19, 23),
          tracingEnabled: false,
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      fastTraceDisabledRunner.terminate();

      const fastTraceLimitedRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const fastTraceLimited = await fastTraceLimitedRunner.send(
        'execute-prepared-trace',
        {
          prepared: {
            ...descriptor(source, 'Add', 'trace', fastTracePrepared),
            traceOptions: {
              maxTraceSteps: 1,
              maxLineEvents: 10_000,
              maxSingleLineHits: 10_000,
              maxStoredEvents: 10_000,
            },
          },
          inputs: { left: 19, right: 23 },
          inputBytes: encodeTwoInt32(19, 23),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      fastTraceLimitedRunner.terminate();

      const fastTraceHardLimitedRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const fastTraceHardLimited = await fastTraceHardLimitedRunner.send(
        'execute-prepared-trace',
        {
          prepared: {
            ...descriptor(source, 'Add', 'trace', fastTracePrepared),
            traceOptions: {
              maxTraceSteps: 10_000,
              maxLineEvents: 1,
              maxSingleLineHits: 10_000,
              maxStoredEvents: 10_000,
            },
          },
          inputs: { left: 19, right: 23 },
          inputBytes: encodeTwoInt32(19, 23),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      fastTraceHardLimitedRunner.terminate();

      const fastTraceFailureRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const fastTraceFailure = await fastTraceFailureRunner.send(
        'execute-prepared-trace',
        {
          prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
          inputs: { left: -1, right: 23 },
          inputBytes: encodeTwoInt32(-1, 23),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      fastTraceFailureRunner.terminate();

      const enumerableRunner = await createHarness('runner', runnerBaseUrl);
      const enumerableOverflow = await enumerableRunner.send(
        'execute-prepared-code',
        {
          prepared: descriptor(
            enumerableSource,
            'Expand',
            'code',
            enumerablePrepared
          ),
          inputs: { count: 3 },
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      enumerableRunner.terminate();

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

      const nonMutatingVoidRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const nonMutatingVoid = await nonMutatingVoidRunner.send(
        'execute-prepared-code',
        {
          prepared: descriptor(
            voidOutputSource,
            'Transform',
            'code',
            voidOutputPrepared
          ),
          inputs: { values: [1, 2, 3] },
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      nonMutatingVoidRunner.terminate();

      const mutatingVoidRunner = await createHarness('runner', runnerBaseUrl);
      const mutatingVoid = await mutatingVoidRunner.send(
        'execute-prepared-code',
        {
          prepared: descriptor(
            voidOutputSource,
            'Transform',
            'code',
            voidOutputPrepared
          ),
          inputs: { values: ['a', 'b'] },
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      mutatingVoidRunner.terminate();

      const tamperRunner = await createHarness('runner', runnerBaseUrl);
      const tampered = await tamperRunner.send('execute-prepared-code', {
        prepared: {
          ...addDescriptor,
          compiledArtifactSha256: '0'.repeat(64),
        },
        inputs: { left: 19, right: 23 },
        inputBytes: encodeTwoInt32(19, 23),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      tamperRunner.terminate();
      return {
        prepared,
        fastTracePrepared,
        enumerablePrepared,
        compilerWarmup,
        structuredPrepared,
        structuredTracePrepared,
        inputMutationPrepared,
        reflectiveInputMutationPrepared,
        directTraceSinkMutationPrepared,
        directTraceWrapperMutationPrepared,
        dynamicTraceSinkMutationPrepared,
        voidOutputPrepared,
        runnerPrime,
        valid: {
          ...valid,
          output: decodeInt32(valid.outputBytes),
        },
        fastTrace: {
          ...fastTrace,
          output: decodeInt32(fastTrace.outputBytes),
        },
        fastTraceDisabled: {
          ...fastTraceDisabled,
          output: decodeInt32(fastTraceDisabled.outputBytes),
        },
        fastTraceLimited,
        fastTraceHardLimited,
        fastTraceFailure,
        enumerableOverflow,
        structured,
        structuredTrace,
        nonMutatingVoid,
        mutatingVoid,
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
        result.prepared.timings?.compileTrustedTemplateHit === true &&
        result.prepared.preparedRunnerTier === 'algorithm-fast' &&
        result.prepared.traceClrWireContract?.parameters.length === 2,
      `Trusted C# compiler did not emit a SHA-256-bound artifact: ${JSON.stringify(result.prepared)}`
    );
    assertCondition(
      result.runnerPrime.success &&
        result.runnerPrime.output === 3 &&
        result.runnerPrime.timings?.artifactCacheHit === true,
      `Disposable C# runner did not execute the fixed trusted prime artifact: ${JSON.stringify(result.runnerPrime)}`
    );
    assertCondition(
      result.fastTracePrepared.success &&
        result.fastTracePrepared.preparedRunnerTier === 'algorithm-fast' &&
        result.fastTrace.success &&
        result.fastTrace.output === 42 &&
        (result.fastTrace.events?.length ?? 0) > 0,
      `TraceCLR algorithm-fast tracing failed: ${JSON.stringify({
        prepared: result.fastTracePrepared,
        execution: result.fastTrace,
      })}`
    );
    assertCondition(
      result.fastTraceDisabled.success &&
        result.fastTraceDisabled.output === 42 &&
        (result.fastTraceDisabled.events?.length ?? 0) === 0,
      `TraceCLR algorithm-fast trace selection did not bypass trace storage: ${JSON.stringify(result.fastTraceDisabled)}`
    );
    assertCondition(
      result.fastTraceLimited.success &&
        result.fastTraceLimited.traceLimitExceeded === true &&
        result.fastTraceLimited.timeoutReason === 'trace-limit' &&
        (result.fastTraceLimited.events?.length ?? 0) === 1,
      `TraceCLR algorithm-fast tracing did not preserve trace-limit semantics: ${JSON.stringify(result.fastTraceLimited)}`
    );
    assertCondition(
      !result.fastTraceHardLimited.success &&
        result.fastTraceHardLimited.traceLimitExceeded === true &&
        result.fastTraceHardLimited.timeoutReason === 'line-limit' &&
        result.fastTraceHardLimited.events?.some(
          (event) => event.kind === 'timeout' && event.reason === 'line-limit'
        ) === true,
      `TraceCLR algorithm-fast tracing did not preserve thrown line-limit semantics: ${JSON.stringify(result.fastTraceHardLimited)}`
    );
    assertCondition(
      !result.fastTraceFailure.success &&
        result.fastTraceFailure.error?.includes('learner boom') === true &&
        (result.fastTraceFailure.events?.length ?? 0) > 0,
      `TraceCLR algorithm-fast tracing did not preserve partial traces for learner exceptions: ${JSON.stringify(result.fastTraceFailure)}`
    );
    assertCondition(
      result.enumerablePrepared.success &&
        result.enumerablePrepared.preparedRunnerTier === 'compatibility' &&
        result.enumerableOverflow.success &&
        JSON.stringify(result.enumerableOverflow.output) === '[0,1,2]',
      `TraceCLR deferred result enumeration did not fail closed to the compatibility runner: ${JSON.stringify({
        prepared: result.enumerablePrepared,
        execution: result.enumerableOverflow,
      })}`
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
        result.structuredTracePrepared.success &&
        result.structuredPrepared.preparedRunnerTier === 'compatibility' &&
        result.structuredTracePrepared.preparedRunnerTier === 'compatibility',
      `Trusted C# compiler did not prepare structured code and trace artifacts: ${JSON.stringify({
        code: result.structuredPrepared,
        trace: result.structuredTracePrepared,
      })}`
    );
    assertCondition(
      result.inputMutationPrepared.success === false &&
        result.inputMutationPrepared.error?.includes(
          'denied browser runtime API: TraceCode.CSharpHost.JudgeRuntimeContext'
        ) === true,
      `C# learner module initializers must not mutate trusted Judge inputs: ${JSON.stringify(result.inputMutationPrepared)}`
    );
    assertCondition(
      result.reflectiveInputMutationPrepared.success === false &&
        result.reflectiveInputMutationPrepared.error?.includes(
          'denied prepared Judge API'
        ) === true,
      `C# prepared Judge compilation must reject reflection that can reach trusted runtime state: ${JSON.stringify(result.reflectiveInputMutationPrepared)}`
    );
    assertCondition(
      result.directTraceSinkMutationPrepared.success === false &&
        result.directTraceSinkMutationPrepared.error?.includes(
          'denied browser runtime API: TraceCode.CSharpHost.RuntimeTraceSink'
        ) === true,
      `C# learner code must not directly erase or forge trusted trace state: ${JSON.stringify(result.directTraceSinkMutationPrepared)}`
    );
    assertCondition(
      result.directTraceWrapperMutationPrepared.success === false &&
        result.directTraceWrapperMutationPrepared.error?.includes(
          'denied browser runtime API: TraceCode.Internal.TraceCodeTrace'
        ) === true,
      `C# learner code must not forge trace state through the public instrumentation wrapper: ${JSON.stringify(result.directTraceWrapperMutationPrepared)}`
    );
    assertCondition(
      result.dynamicTraceSinkMutationPrepared.success === false &&
        result.dynamicTraceSinkMutationPrepared.error?.includes(
          'denied prepared Judge API: dynamic'
        ) === true,
      `C# prepared Judge compilation must reject explicit dynamic reflection escapes: ${JSON.stringify(result.dynamicTraceSinkMutationPrepared)}`
    );
    assertCondition(
      result.voidOutputPrepared.success &&
        result.voidOutputPrepared.preparedRunnerTier === 'compatibility' &&
        result.nonMutatingVoid.success &&
        result.nonMutatingVoid.output === null,
      `Prepared C# void methods must preserve null output when the first argument is not mutated: ${JSON.stringify({
        prepared: result.voidOutputPrepared,
        execution: result.nonMutatingVoid,
      })}`
    );
    assertCondition(
      result.voidOutputPrepared.success &&
        result.mutatingVoid.success &&
        JSON.stringify(result.mutatingVoid.output) ===
          JSON.stringify(['changed', 'b']),
      `Prepared C# void overloads must return a mutated first argument only for the selected mutating signature: ${JSON.stringify({
        prepared: result.voidOutputPrepared,
        execution: result.mutatingVoid,
      })}`
    );
    assertCondition(
      result.structured.success &&
        result.structured.output === 'Ada:6:7:True:True:valid' &&
        result.structured.timings?.compileCacheHit === true,
      `Disposable C# runner lost dynamic object/BCL semantics: ${JSON.stringify(result.structured)}`
    );
    assertCondition(
      result.structuredTrace.success &&
        result.structuredTrace.output === 'Ada:6:7:True:True:valid' &&
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
        fastTraceOutput: result.fastTrace.output,
        fastTraceEvents: result.fastTrace.events?.length ?? 0,
        fastTraceDisabledEvents:
          result.fastTraceDisabled.events?.length ?? 0,
        fastTraceLimitReason: result.fastTraceLimited.timeoutReason,
        structuredOutput: result.structured.output,
        structuredTraceEvents: result.structuredTrace.events?.length ?? 0,
        inputMutationRejected: true,
        reflectiveRuntimeAccessRejected: true,
        directTraceSinkAccessRejected: true,
        directTraceWrapperAccessRejected: true,
        dynamicReflectionRejected: true,
        voidOutputSemanticsPreserved: true,
        tamperedRejected: true,
        runnerAssetPath,
        engine: engineName,
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
