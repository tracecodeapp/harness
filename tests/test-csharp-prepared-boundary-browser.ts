#!/usr/bin/env npx tsx

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import {
  CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER,
  CSHARP_ALGORITHM_FAST_MAX_MANAGED_HEAP_BYTES,
} from '../packages/runtime-csharp/src/csharp-fast-runner-policy';

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
      maxFastCasesPerRunner,
      maxFastManagedHeapBytes,
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
        if (left < 0)
        {
            throw new System.InvalidOperationException("learner boom");
        }
        var total = left + right;
        return total;
    }
}`;
      const consoleSource = `
public class Solution
{
    public int Add(int left, int right)
    {
        System.Console.WriteLine(left + right);
        return left + right;
    }
}`;
      const intGetTypeSource = `
public class Solution
{
    public int Probe(int value) => value.GetType().GetHashCode();
}`;
      const stringInternSource = `
public class Solution
{
    public bool Probe(string value, bool intern) => intern
        ? string.Intern(value) == value
        : string.IsInterned(value) is not null;
}`;
      const staticStateSource = `
public class Solution
{
    private static int count;
    public int Next() => ++count;
}`;
      const filesystemSource = `
using System.IO;
public class Solution
{
    public bool Exists(string path) => File.Exists(path);
}`;
      const environmentSource = `
public class Solution
{
    public string? Read(string name) => System.Environment.GetEnvironmentVariable(name);
}`;
      const threadingSource = `
using System.Threading;
public class Solution
{
    private static int count;
    public int Next() => Interlocked.Increment(ref count);
}`;
      const sharedPoolSource = `
using System.Buffers;
public class Solution
{
    public int Rent(int length)
    {
        var values = ArrayPool<int>.Shared.Rent(length);
        try { return values.Length; }
        finally { ArrayPool<int>.Shared.Return(values); }
    }
}`;
      const pinnedMemorySource = `
using System;
public class Solution
{
    public int Pin(int[] values)
    {
        new Memory<int>(values).Pin();
        return values.Length;
    }
}`;
      const hostRuntimeSource = `
public class Solution
{
    private TraceCode.CSharpHost.TraceClrAlgorithmExecutionResult? result;
    public int Read() => result is null ? 0 : 1;
}`;
      const dynamicReflectionSource = `
public class Solution
{
    public string Read(object value)
    {
        dynamic runtimeType = value.GetType();
        return runtimeType.Assembly.FullName;
    }
}`;
      const reflectionGatewaySource = `
public class Solution
{
    public bool Read(object value) => value.GetType() is not null;
}`;
      const concurrentBlockingSource = `
using System.Collections.Concurrent;
public class Solution
{
    public int Read()
    {
        var values = new BlockingCollection<int>();
        return values.Take();
    }
}`;
      const directFrameworkStaticWriteSource = `
using System.Text.RegularExpressions;
public class Solution
{
    public int Set(int value)
    {
        Regex.CacheSize = value;
        return Regex.CacheSize;
    }
}`;
      const deconstructedFrameworkStaticWriteSource = `
using System.Text.RegularExpressions;
public class Solution
{
    public int Set(int value)
    {
        int local;
        (Regex.CacheSize, local) = (value, value);
        return local;
    }
}`;
      const parenthesizedFrameworkStaticWriteSource = `
using System.Text.RegularExpressions;
public class Solution
{
    public int Set(int value)
    {
        (Regex.CacheSize) = value;
        return Regex.CacheSize;
    }
}`;
      const listNodeSource = `
public class Solution
{
    public int Sum(ListNode? head)
    {
        int total = 0;
        for (ListNode? node = head; node is not null; node = node.next)
        {
            total += node.val;
        }
        return total;
    }
}`;
      const treeNodeSource = `
public class Solution
{
    public int Root(TreeNode? root) => root?.val ?? 0;
}`;
      const injectedRuntimeHelperSource = `
public class TreeNode
{
    public int val;
    public TreeNode? left;
    public TreeNode? right;

    public TreeNode(int val = 0, TreeNode? left = null, TreeNode? right = null)
    {
        this.val = val;
        this.left = left;
        this.right = right;
    }
}

public class Solution
{
    public int Read(int[] values) => values.Length +
        (TraceCode.Internal.TraceCodeJsonInput.Read<int[]>(
            "{\\"value\\":[1]}",
            "value",
            0
        )?.Length ?? 0);
}`;
      const retainedHeapProbeSource = `
public class Solution
{
    private static byte[]? retained;

    public int Allocate(int size)
    {
        retained = new byte[size];
        retained[^1] = 1;
        return retained.Length;
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
      const prepareProgram = (
        mode: 'code' | 'trace',
        code: string,
        functionName: string,
        traceOptions?: {
          maxTraceSteps?: number;
          maxLineEvents?: number;
          maxSingleLineHits?: number;
          maxStoredEvents?: number;
        }
      ): Promise<Reply> =>
        compiler.send('prepare-program', {
          mode,
          code,
          functionName,
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
          ...(traceOptions ? { traceOptions } : {}),
        });
      const prepared = await prepareProgram('code', source, 'Add');
      const fastTracePrepared = await prepareProgram('trace', source, 'Add', {
        maxTraceSteps: 10_000,
        maxStoredEvents: 10_000,
      });
      const enumerablePrepared = await prepareProgram(
        'code',
        enumerableSource,
        'Expand'
      );
      const structuredPrepared = await prepareProgram(
        'code',
        structuredSource,
        'Inspect'
      );
      const structuredTracePrepared = await prepareProgram(
        'trace',
        structuredSource,
        'Inspect',
        { maxTraceSteps: 10_000, maxStoredEvents: 10_000 }
      );
      const consolePrepared = await prepareProgram('code', consoleSource, 'Add');
      const intGetTypePrepared = await prepareProgram(
        'code',
        intGetTypeSource,
        'Probe'
      );
      const stringInternPrepared = await prepareProgram(
        'code',
        stringInternSource,
        'Probe'
      );
      const inputMutationPrepared = await prepareProgram('code', `
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
}`);
      const reflectiveInputMutationPrepared = await prepareProgram(
        'code',
        reflectiveInputMutationSource,
        'Add'
      );
      const directTraceSinkMutationPrepared = await prepareProgram(
        'trace',
        directTraceSinkMutationSource,
        'Add'
      );
      const voidOutputPrepared = await prepareProgram(
        'code',
        voidOutputSource,
        'Transform'
      );
      const directTraceWrapperMutationPrepared = await prepareProgram(
        'trace',
        directTraceWrapperMutationSource,
        'Add'
      );
      const dynamicTraceSinkMutationPrepared = await prepareProgram(
        'trace',
        dynamicTraceSinkMutationSource,
        'Add'
      );
      const staticStatePrepared = await prepareProgram(
        'code',
        staticStateSource,
        'Next'
      );
      const filesystemPrepared = await prepareProgram(
        'code',
        filesystemSource,
        'Exists'
      );
      const environmentPrepared = await prepareProgram(
        'code',
        environmentSource,
        'Read'
      );
      const threadingPrepared = await prepareProgram('code', threadingSource, 'Next');
      const sharedPoolPrepared = await prepareProgram(
        'code',
        sharedPoolSource,
        'Rent'
      );
      const pinnedMemoryPrepared = await prepareProgram(
        'code',
        pinnedMemorySource,
        'Pin'
      );
      const hostRuntimePrepared = await prepareProgram(
        'code',
        hostRuntimeSource,
        'Read'
      );
      const dynamicReflectionPrepared = await prepareProgram(
        'code',
        dynamicReflectionSource,
        'Read'
      );
      const reflectionGatewayPrepared = await prepareProgram(
        'code',
        reflectionGatewaySource,
        'Read'
      );
      const concurrentBlockingPrepared = await prepareProgram(
        'code',
        concurrentBlockingSource,
        'Read'
      );
      const directFrameworkStaticWritePrepared = await prepareProgram(
        'code',
        directFrameworkStaticWriteSource,
        'Set'
      );
      const deconstructedFrameworkStaticWritePrepared = await prepareProgram(
        'code',
        deconstructedFrameworkStaticWriteSource,
        'Set'
      );
      const parenthesizedFrameworkStaticWritePrepared = await prepareProgram(
        'code',
        parenthesizedFrameworkStaticWriteSource,
        'Set'
      );
      const listNodePrepared = await prepareProgram('code', listNodeSource, 'Sum');
      const treeNodePrepared = await prepareProgram('code', treeNodeSource, 'Root');
      const injectedRuntimeHelperPrepared = await prepareProgram(
        'code',
        injectedRuntimeHelperSource,
        'Read'
      );
      const retainedHeapProbePrepared = await prepareProgram(
        'code',
        retainedHeapProbeSource,
        'Allocate'
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
      const addDescriptor = descriptor(source, 'Add', 'code', prepared);
      const runner = await createHarness('runner', runnerBaseUrl);
      const runnerPrime = await runner.send('execute-prepared-code', {
        prepared: compilerWarmup.trustedPreparedArtifact,
        inputs: { a: 1, b: 2 },
        inputBytes: encodeInt32s(1, 2),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      const valid = await runner.send('execute-prepared-code', {
        prepared: addDescriptor,
        inputs: { left: 19, right: 23 },
        inputBytes: encodeInt32s(19, 23),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      const stringInternDescriptor = descriptor(
        stringInternSource,
        'Probe',
        'code',
        stringInternPrepared
      );
      const stringInternFirstRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const stringInternFirst = await stringInternFirstRunner.send(
        'execute-prepared-code',
        {
          prepared: stringInternDescriptor,
          inputs: {
            value: 'tracecode-string-intern-probe-7f9e',
            intern: true,
          },
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      stringInternFirstRunner.terminate();
      const stringInternSecondRunner = await createHarness(
        'runner',
        runnerBaseUrl
      );
      const stringInternSecond = await stringInternSecondRunner.send(
        'execute-prepared-code',
        {
          prepared: stringInternDescriptor,
          inputs: {
            value: 'tracecode-string-intern-probe-7f9e',
            intern: false,
          },
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      stringInternSecondRunner.terminate();
      const staticDescriptor = descriptor(
        staticStateSource,
        'Next',
        'code',
        staticStatePrepared
      );
      const staticFirst = await runner.send('execute-prepared-code', {
        prepared: staticDescriptor,
        inputs: {},
        inputBytes: encodeInt32s(),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      const staticSecond = await runner.send('execute-prepared-code', {
        prepared: staticDescriptor,
        inputs: {},
        inputBytes: encodeInt32s(),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      runner.terminate();
      const heapProbeDescriptor = descriptor(
        retainedHeapProbeSource,
        'Allocate',
        'code',
        retainedHeapProbePrepared
      );
      const retainedBatchHeapSamples: number[] = [];
      const retainedBatchManagedHeapSamples: number[] = [];
      const retainedBatchCasesPerRunner: number[] = [];
      let retainedBatchAllPassed = true;
      let retainedBatchRealmsAccurate = true;
      let retainedBatchRunner = await createHarness('runner', runnerBaseUrl);
      let casesOnRunner = 0;
      let lastManagedHeapBytes = 0;
      for (let index = 0; index < 100; index += 1) {
        if (
          casesOnRunner >= maxFastCasesPerRunner ||
          lastManagedHeapBytes >= maxFastManagedHeapBytes
        ) {
          retainedBatchCasesPerRunner.push(casesOnRunner);
          retainedBatchRunner.terminate();
          retainedBatchRunner = await createHarness('runner', runnerBaseUrl);
          casesOnRunner = 0;
          lastManagedHeapBytes = 0;
        }
        const heapProbe = await retainedBatchRunner.send(
          'execute-prepared-code',
          {
          prepared: heapProbeDescriptor,
          inputs: { size: 1_048_576 },
          inputBytes: encodeInt32s(1_048_576),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
          }
        );
        casesOnRunner += 1;
        retainedBatchAllPassed =
          retainedBatchAllPassed &&
          heapProbe.success === true &&
          decodeInt32(heapProbe.outputBytes) === 1_048_576;
        retainedBatchRealmsAccurate =
          retainedBatchRealmsAccurate &&
          heapProbe.timings?.executionRealm ===
            'retained-worker-collectible-context';
        retainedBatchHeapSamples.push(
          heapProbe.timings?.wasmLinearMemoryBytes ?? 0
        );
        retainedBatchManagedHeapSamples.push(
          heapProbe.timings?.managedHeapBytes ?? 0
        );
        lastManagedHeapBytes = heapProbe.timings?.managedHeapBytes ?? 0;
      }
      retainedBatchCasesPerRunner.push(casesOnRunner);
      retainedBatchRunner.terminate();

      const fastTraceRunner = await createHarness('runner', runnerBaseUrl);
      const fastTrace = await fastTraceRunner.send('execute-prepared-trace', {
        prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
        inputs: { left: 19, right: 23 },
        inputBytes: encodeInt32s(19, 23),
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
          inputBytes: encodeInt32s(19, 23),
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
          inputBytes: encodeInt32s(19, 23),
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
          inputBytes: encodeInt32s(19, 23),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      const fastTraceHardLimitedRecovery = await fastTraceHardLimitedRunner.send(
        'execute-prepared-trace',
        {
          prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
          inputs: { left: 19, right: 23 },
          inputBytes: encodeInt32s(19, 23),
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
          inputBytes: encodeInt32s(-1, 23),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      const fastTraceFailureRecovery = await fastTraceFailureRunner.send(
        'execute-prepared-trace',
        {
          prepared: descriptor(source, 'Add', 'trace', fastTracePrepared),
          inputs: { left: 19, right: 23 },
          inputBytes: encodeInt32s(19, 23),
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
        inputBytes: encodeInt32s(19, 23),
        assetBaseUrl: runnerBaseUrl,
        timeoutMs: 10_000,
      });
      tamperRunner.terminate();
      const forgedTierRunner = await createHarness('runner', runnerBaseUrl);
      const forgedTier = await forgedTierRunner.send(
        'execute-prepared-code',
        {
          prepared: {
            ...descriptor(
              filesystemSource,
              'Exists',
              'code',
              filesystemPrepared
            ),
            preparedRunnerTier: 'algorithm-fast',
          },
          inputs: { path: '/tmp/shared-case-state' },
          inputBytes: encodeInt32s(),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      forgedTierRunner.terminate();
      return {
        prepared,
        fastTracePrepared,
        enumerablePrepared,
        compilerWarmup,
        structuredPrepared,
        structuredTracePrepared,
        consolePrepared,
        intGetTypePrepared,
        stringInternPrepared,
        inputMutationPrepared,
        reflectiveInputMutationPrepared,
        directTraceSinkMutationPrepared,
        directTraceWrapperMutationPrepared,
        dynamicTraceSinkMutationPrepared,
        staticStatePrepared,
        filesystemPrepared,
        environmentPrepared,
        threadingPrepared,
        sharedPoolPrepared,
        pinnedMemoryPrepared,
        hostRuntimePrepared,
        dynamicReflectionPrepared,
        reflectionGatewayPrepared,
        concurrentBlockingPrepared,
        directFrameworkStaticWritePrepared,
        deconstructedFrameworkStaticWritePrepared,
        parenthesizedFrameworkStaticWritePrepared,
        listNodePrepared,
        treeNodePrepared,
        injectedRuntimeHelperPrepared,
        retainedHeapProbePrepared,
        voidOutputPrepared,
        runnerPrime,
        valid: {
          ...valid,
          output: decodeInt32(valid.outputBytes),
        },
        stringInternFirst,
        stringInternSecond,
        staticFirst: {
          ...staticFirst,
          output: decodeInt32(staticFirst.outputBytes),
        },
        staticSecond: {
          ...staticSecond,
          output: decodeInt32(staticSecond.outputBytes),
        },
        retainedBatch: {
          allPassed: retainedBatchAllPassed,
          realmsAccurate: retainedBatchRealmsAccurate,
          peakHeapBytes: Math.max(...retainedBatchHeapSamples),
          finalHeapBytes: retainedBatchHeapSamples.at(-1) ?? 0,
          peakManagedHeapBytes: Math.max(...retainedBatchManagedHeapSamples),
          finalManagedHeapBytes:
            retainedBatchManagedHeapSamples.at(-1) ?? 0,
          caseCount: retainedBatchHeapSamples.length,
          casesPerRunner: retainedBatchCasesPerRunner,
          runnerCount: retainedBatchCasesPerRunner.length,
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
        fastTraceHardLimitedRecovery: {
          ...fastTraceHardLimitedRecovery,
          output: decodeInt32(fastTraceHardLimitedRecovery.outputBytes),
        },
        fastTraceFailure,
        fastTraceFailureRecovery: {
          ...fastTraceFailureRecovery,
          output: decodeInt32(fastTraceFailureRecovery.outputBytes),
        },
        enumerableOverflow,
        structured,
        structuredTrace,
        nonMutatingVoid,
        mutatingVoid,
        tampered,
        forgedTier,
      };
    }, {
      origin,
      runnerAssetPath,
      maxFastCasesPerRunner:
        CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER,
      maxFastManagedHeapBytes:
        CSHARP_ALGORITHM_FAST_MAX_MANAGED_HEAP_BYTES,
    });

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
      result.fastTraceHardLimitedRecovery.success &&
        result.fastTraceHardLimitedRecovery.output === 42 &&
        result.fastTraceHardLimitedRecovery.traceLimitExceeded !== true,
      `TraceCLR algorithm-fast line limits poisoned a later case in the same outer runner: ${JSON.stringify(result.fastTraceHardLimitedRecovery)}`
    );
    assertCondition(
      !result.fastTraceFailure.success &&
        result.fastTraceFailure.error?.includes('learner boom') === true &&
        (result.fastTraceFailure.events?.length ?? 0) > 0,
      `TraceCLR algorithm-fast tracing did not preserve partial traces for learner exceptions: ${JSON.stringify(result.fastTraceFailure)}`
    );
    assertCondition(
      result.fastTraceFailureRecovery.success &&
        result.fastTraceFailureRecovery.output === 42 &&
        result.fastTraceFailureRecovery.traceLimitExceeded !== true,
      `TraceCLR algorithm-fast learner failures poisoned a later case in the same outer runner: ${JSON.stringify(result.fastTraceFailureRecovery)}`
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
      result.staticStatePrepared.success &&
        result.staticStatePrepared.preparedRunnerTier === 'algorithm-fast' &&
        result.staticFirst.success &&
        result.staticSecond.success &&
        result.staticFirst.output === 1 &&
        result.staticSecond.output === 1,
      `C# algorithm-fast cases must receive fresh learner static state inside one outer runner: ${JSON.stringify({
        prepared: result.staticStatePrepared,
        first: result.staticFirst,
        second: result.staticSecond,
      })}`
    );
    assertCondition(
      result.staticFirst.timings?.executionRealm ===
        'retained-worker-collectible-context' &&
        result.staticSecond.timings?.executionRealm ===
          'retained-worker-collectible-context',
      `C# algorithm-fast diagnostics must identify the retained worker and collectible per-case context: ${JSON.stringify({
        first: result.staticFirst.timings,
        second: result.staticSecond.timings,
      })}`
    );
    assertCondition(
      result.retainedHeapProbePrepared.success &&
        result.retainedHeapProbePrepared.preparedRunnerTier ===
          'algorithm-fast' &&
      result.retainedBatch.allPassed &&
        result.retainedBatch.realmsAccurate &&
        result.retainedBatch.caseCount === 100 &&
        result.retainedBatch.runnerCount >= 2 &&
        result.retainedBatch.runnerCount <= 3 &&
        Math.max(...result.retainedBatch.casesPerRunner) <=
          CSHARP_ALGORITHM_FAST_MAX_CASES_PER_RUNNER &&
        result.retainedBatch.peakHeapBytes <= 128 * 1024 * 1024 &&
        result.retainedBatch.peakManagedHeapBytes <= 80 * 1024 * 1024,
      `C# retained runner chunks must bound non-reclaimed per-case contexts: ${JSON.stringify({
        prepared: result.retainedHeapProbePrepared,
        batch: result.retainedBatch,
      })}`
    );
    for (const [label, prepared] of [
      ['direct', result.directFrameworkStaticWritePrepared],
      ['deconstructed', result.deconstructedFrameworkStaticWritePrepared],
      ['parenthesized', result.parenthesizedFrameworkStaticWritePrepared],
    ] as const) {
      assertCondition(
        prepared.success &&
          prepared.preparedRunnerTier === 'compatibility' &&
          prepared.preparedRunnerReason?.includes(
            'Writes to shared framework state'
          ) === true,
        `C# ${label} framework-static writes must fail closed to compatibility: ${JSON.stringify(prepared)}`
      );
    }
    assertCondition(
      result.injectedRuntimeHelperPrepared.success &&
        result.injectedRuntimeHelperPrepared.preparedRunnerTier ===
          'compatibility' &&
        result.injectedRuntimeHelperPrepared.preparedRunnerReason?.includes(
          'Ambient API TraceCode.Internal.TraceCodeJsonInput'
        ) === true,
      `Compiler-injected C# runtime helpers must not inherit learner-source provenance: ${JSON.stringify(result.injectedRuntimeHelperPrepared)}`
    );
    for (const [label, prepared] of [
      ['ListNode', result.listNodePrepared],
      ['TreeNode', result.treeNodePrepared],
    ] as const) {
      assertCondition(
        prepared.success &&
          prepared.preparedRunnerTier === 'compatibility' &&
          prepared.preparedRunnerReason?.includes(
            'reference-bearing node topology'
          ) === true &&
          prepared.preparedRunnerReason?.includes('Ambient API') !== true,
        `Trusted C# judge ${label} support must reach the explicit topology gate rather than ambient-API rejection: ${JSON.stringify(prepared)}`
      );
    }
    for (const [label, prepared] of [
      ['filesystem', result.filesystemPrepared],
      ['environment', result.environmentPrepared],
      ['threading', result.threadingPrepared],
      ['shared pool', result.sharedPoolPrepared],
      ['pinned memory', result.pinnedMemoryPrepared],
      ['host runtime', result.hostRuntimePrepared],
      ['blocking collection', result.concurrentBlockingPrepared],
    ] as const) {
      assertCondition(
        prepared.success && prepared.preparedRunnerTier === 'compatibility',
        `C# ${label} code must fail closed to the disposable compatibility runner: ${JSON.stringify(prepared)}`
      );
    }
    assertCondition(
      result.dynamicReflectionPrepared.success === false &&
        String(result.dynamicReflectionPrepared.error).includes(
          'denied prepared Judge API: dynamic'
        ),
      `C# dynamic dispatch must remain rejected before runner selection: ${JSON.stringify(result.dynamicReflectionPrepared)}`
    );
    assertCondition(
      result.consolePrepared.success &&
        result.consolePrepared.preparedRunnerTier === 'compatibility' &&
        result.consolePrepared.preparedRunnerReason?.includes(
          'Ambient API System.Console'
        ) === true,
      `C# Console.WriteLine must be rejected semantically by the prepared policy: ${JSON.stringify(result.consolePrepared)}`
    );
    assertCondition(
      result.intGetTypePrepared.success === false &&
        result.intGetTypePrepared.error?.includes(
          'denied prepared Judge API: System.Object.GetType'
        ) === true,
      `C# GetType on an int must be rejected before fast-tier selection: ${JSON.stringify(result.intGetTypePrepared)}`
    );
    assertCondition(
      result.reflectionGatewayPrepared.success === false &&
        result.reflectionGatewayPrepared.error?.includes(
          'denied prepared Judge API: System.Object.GetType'
        ) === true,
      `C# object.GetType must remain rejected before fast-tier selection: ${JSON.stringify(result.reflectionGatewayPrepared)}`
    );
    assertCondition(
      result.stringInternPrepared.success &&
        result.stringInternPrepared.preparedRunnerTier === 'compatibility' &&
        result.stringInternPrepared.preparedRunnerReason?.includes(
          'Ambient API System.String.'
        ) === true &&
        result.stringInternFirst.success &&
        result.stringInternFirst.output === true &&
        result.stringInternSecond.success &&
        result.stringInternSecond.output === false,
      `C# String.Intern/IsInterned must stay out of retained runners and not observe a prior case: ${JSON.stringify({
        prepared: result.stringInternPrepared,
        first: result.stringInternFirst,
        second: result.stringInternSecond,
      })}`
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
    assertCondition(
      result.forgedTier.success === false &&
        result.forgedTier.error ===
          'Prepared C# artifact is unavailable or invalid.' &&
        result.forgedTier.timings?.compileCacheHit === false &&
        result.forgedTier.timings?.artifactCacheHit === false,
      `Retained C# runner accepted a compatibility artifact relabeled as algorithm-fast: ${JSON.stringify(result.forgedTier)}`
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
        retainedBatch: result.retainedBatch,
        tamperedRejected: true,
        forgedTierRejected: true,
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
