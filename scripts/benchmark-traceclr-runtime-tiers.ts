#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const ROOT = process.cwd();
const engineName = process.env.TRACECODE_TRACECLR_BROWSER_ENGINE ?? 'chromium';
const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };
const browserType = browserTypes[engineName];
if (!browserType) throw new Error(`Unsupported TraceCLR browser engine: ${engineName}`);
const sampleCount = Number(process.env.TRACECODE_TRACECLR_TIER_SAMPLES ?? '12');
if (!Number.isInteger(sampleCount) || sampleCount < 3) {
  throw new Error('TRACECODE_TRACECLR_TIER_SAMPLES must be an integer >= 3.');
}

const minimalRoot = join(
  ROOT,
  'packages/runtime-csharp/dotnet/TraceCode.CSharpAlgorithmRunner/bin/Release/net10.0/browser-wasm/AppBundle'
);
const compilerRoot = join(ROOT, 'workers/vendor/csharp');
const runnerRoot = join(ROOT, 'workers/vendor/csharp-runner');
for (const required of [
  join(minimalRoot, '_framework/dotnet.js'),
  join(compilerRoot, '_framework/dotnet.boot.js'),
  join(runnerRoot, '_framework/dotnet.boot.js'),
]) {
  if (!existsSync(required)) {
    throw new Error(`Missing ${required}; build the minimal runner and materialize C# role assets first.`);
  }
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(values: number[]): { firstMs: number; cachedMedianMs: number; cachedP95Ms: number } {
  const cached = values.slice(1);
  return {
    firstMs: values[0],
    cachedMedianMs: percentile(cached, 0.5),
    cachedP95Ms: percentile(cached, 0.95),
  };
}

function encodeTwoInt32(left: number, right: number): Uint8Array {
  const bytes = new Uint8Array(14);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x31574354, true);
  view.setUint16(4, 2, true);
  view.setInt32(6, left, true);
  view.setInt32(10, right, true);
  return bytes;
}

async function main(): Promise<void> {
  copyFileSync(
    join(ROOT, 'tests/fixtures/traceclr-tier-minimal-worker.mjs'),
    join(minimalRoot, 'traceclr-tier-minimal-worker.mjs')
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end('<!doctype html><title>TraceCLR tier benchmark</title>');
      return;
    }
    const root = url.pathname.startsWith('/minimal/') ? minimalRoot : ROOT;
    const relative = url.pathname.startsWith('/minimal/')
      ? url.pathname.slice('/minimal'.length)
      : url.pathname;
    const candidate = normalize(join(root, decodeURIComponent(relative)));
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
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
  if (!address || typeof address === 'string') throw new Error('Missing benchmark server address.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await browserType.launch();
  let browserResult: {
    fastArtifactBase64: string;
    inputBase64: string;
    compileMs: number | null;
    traceCompileMs: number | null;
    integratedFastMs: number[];
    compatibilityMs: number[];
    minimalMs: number[];
    integratedTraceMs: number[];
    minimalTraceMs: number[];
    compatibilityTraceMs: number[];
    traceEventCount: number;
  };
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    browserResult = await page.evaluate(async ({ origin, sampleCount }) => {
      type Reply = {
        success?: boolean;
        output?: unknown;
        outputBytes?: Uint8Array;
        error?: string;
        compiledArtifactKey?: string;
        compiledArtifactBase64?: string;
        compiledArtifactSha256?: string;
        preparedRunnerTier?: 'algorithm-fast' | 'compatibility';
        preparedRunnerReason?: string;
        traceClrWireContract?: unknown;
        events?: unknown[];
        traceLimitExceeded?: boolean;
        timeoutReason?: string | null;
        timings?: { compileMs?: number };
        trustedPreparedArtifact?: Record<string, unknown>;
      };
      const artifacts = new Map<string, string>();
      const createHarness = async (
        role: 'general' | 'compiler' | 'runner',
        assetBaseUrl: string
      ) => {
        const worker = new Worker(`${origin}/workers/csharp/csharp-worker.js`, { type: 'module' });
        let nextId = 0;
        const pending = new Map<string, {
          resolve(value: Reply): void;
          reject(error: Error): void;
          protocolToken: string;
        }>();
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'compiler-artifact-cache-request') {
            const request = event.data.payload ?? {};
            if (request.operation === 'put' && typeof request.key === 'string' && typeof request.value === 'string') {
              artifacts.set(request.key, request.value);
            }
            const value = request.operation === 'get' && typeof request.key === 'string'
              ? artifacts.get(request.key)
              : undefined;
            worker.postMessage({
              type: 'compiler-artifact-cache-response',
              requestId: event.data.requestId,
              protocolToken: event.data.protocolToken,
              payload: {
                hit: value !== undefined,
                ...(value === undefined ? {} : { value }),
                stored: request.operation === 'put' && typeof request.key === 'string' && artifacts.has(request.key),
              },
            });
            return;
          }
          const request = pending.get(event.data?.id);
          if (!request || event.data?.protocolToken !== request.protocolToken) return;
          pending.delete(event.data.id);
          if (event.data.type === 'error') request.reject(new Error(event.data?.payload?.error ?? 'C# worker error'));
          else request.resolve(event.data?.payload ?? {});
        });
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || 'C# worker failed');
          for (const request of pending.values()) request.reject(error);
          pending.clear();
        });
        const send = (type: string, payload: unknown): Promise<Reply> => {
          const id = String(++nextId);
          const protocolToken = `${role}-${id}-${crypto.randomUUID()}`;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, protocolToken });
            worker.postMessage({ id, type, payload, protocolToken });
          });
        };
        await send('init', { assetBaseUrl, runtimeRole: role });
        return { send, terminate: () => worker.terminate() };
      };
      const compilerBaseUrl = `${origin}/workers/vendor/csharp`;
      const runnerBaseUrl = `${origin}/workers/vendor/csharp-runner`;
      const compiler = await createHarness('compiler', compilerBaseUrl);
      await compiler.send('warmup', { assetBaseUrl: compilerBaseUrl, runtimeRole: 'compiler' });
      const prepare = (
        code: string,
        mode: 'code' | 'trace' = 'code'
      ) => compiler.send('prepare-program', {
        mode,
        code,
        functionName: 'Add',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerBaseUrl,
        timeoutMs: 10_000,
      });
      const fastSource = 'public class Solution { public int Add(int left, int right) => left + right; }';
      const compatibilitySource = `
using System;
public class Solution {
  public int Add(int left, int right) {
    if (left == int.MinValue) Console.Write("");
    return left + right;
  }
}`;
      const fast = await prepare(fastSource);
      const fastTrace = await prepare(fastSource, 'trace');
      const compatibility = await prepare(compatibilitySource);
      compiler.terminate();
      const compatibilityCompiler = await createHarness(
        'general',
        compilerBaseUrl
      );
      const compatibilityTrace = await compatibilityCompiler.send(
        'prepare-program',
        {
          mode: 'trace',
          code: fastSource,
          functionName: 'Add',
          executionStyle: 'solution-method',
          assetBaseUrl: compilerBaseUrl,
          timeoutMs: 10_000,
        }
      );
      compatibilityCompiler.terminate();
      if (!fast.success || fast.preparedRunnerTier !== 'algorithm-fast' || !fast.compiledArtifactBase64) {
        throw new Error(`Fast preparation failed: ${JSON.stringify(fast)}`);
      }
      if (!compatibility.success || compatibility.preparedRunnerTier !== 'compatibility') {
        throw new Error(`Compatibility preparation failed: ${JSON.stringify(compatibility)}`);
      }
      if (!fastTrace.success || fastTrace.preparedRunnerTier !== 'algorithm-fast' || !fastTrace.compiledArtifactBase64) {
        throw new Error(`Fast trace preparation failed: ${JSON.stringify(fastTrace)}`);
      }
      if (
        !compatibilityTrace.success ||
        compatibilityTrace.preparedRunnerTier !== 'compatibility' ||
        !compatibilityTrace.compiledArtifactBase64
      ) {
        throw new Error(`Compatibility trace preparation failed: ${JSON.stringify(compatibilityTrace)}`);
      }
      const descriptor = (
        candidate: Reply,
        source: string,
        mode: 'code' | 'trace' = 'code'
      ) => ({
        mode,
        code: source,
        functionName: 'Add',
        executionStyle: 'solution-method',
        compiledArtifactKey: candidate.compiledArtifactKey,
        compiledArtifactBase64: candidate.compiledArtifactBase64,
        compiledArtifactSha256: candidate.compiledArtifactSha256,
        preparedRunnerTier: candidate.preparedRunnerTier,
        preparedRunnerReason: candidate.preparedRunnerReason,
        ...(mode === 'trace' ? {
          traceOptions: {
            maxTraceSteps: 10_000,
            maxLineEvents: 10_000,
            maxSingleLineHits: 10_000,
            maxStoredEvents: 10_000,
          },
        } : {}),
        ...(candidate.traceClrWireContract ? { traceClrWireContract: candidate.traceClrWireContract } : {}),
      });
      const inputBytes = new Uint8Array(14);
      const inputView = new DataView(inputBytes.buffer);
      inputView.setUint32(0, 0x31574354, true);
      inputView.setUint16(4, 2, true);
      inputView.setInt32(6, 19, true);
      inputView.setInt32(10, 23, true);
      const runIntegrated = async (candidate: Reply, source: string): Promise<number> => {
        const startedAt = performance.now();
        const runner = await createHarness('runner', runnerBaseUrl);
        const result = await runner.send('execute-prepared-code', {
          prepared: descriptor(candidate, source),
          inputs: { left: 19, right: 23 },
          ...(candidate.preparedRunnerTier === 'algorithm-fast' ? { inputBytes } : {}),
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        });
        runner.terminate();
        const output = result.outputBytes instanceof Uint8Array
          ? new DataView(result.outputBytes.buffer, result.outputBytes.byteOffset, result.outputBytes.byteLength).getInt32(4, true)
          : result.output;
        if (!result.success || output !== 42) throw new Error(`Integrated ${candidate.preparedRunnerTier} failed: ${JSON.stringify(result)}`);
        return performance.now() - startedAt;
      };
      const decodeOutput = (output: Uint8Array): number =>
        new DataView(
          output.buffer,
          output.byteOffset,
          output.byteLength
        ).getInt32(4, true);
      const runIntegratedTrace = async (
        recordTrace = true,
        candidate: Reply = fastTrace
      ): Promise<{ elapsedMs: number; events: unknown[] }> => {
        const startedAt = performance.now();
        const runner = await createHarness('runner', runnerBaseUrl);
        const result = await runner.send('execute-prepared-trace', {
          prepared: descriptor(candidate, fastSource, 'trace'),
          inputs: { left: 19, right: 23 },
          ...(candidate.preparedRunnerTier === 'algorithm-fast'
            ? { inputBytes }
            : {}),
          tracingEnabled: recordTrace,
          assetBaseUrl: runnerBaseUrl,
          timeoutMs: 10_000,
        });
        runner.terminate();
        const output = result.outputBytes instanceof Uint8Array
          ? decodeOutput(result.outputBytes)
          : result.output;
        if (
          !result.success ||
          output !== 42 ||
          result.traceLimitExceeded === true ||
          (recordTrace && (!Array.isArray(result.events) || result.events.length === 0)) ||
          (!recordTrace && (result.events?.length ?? 0) !== 0)
        ) {
          throw new Error(`Integrated fast trace failed: ${JSON.stringify(result)}`);
        }
        return {
          elapsedMs: performance.now() - startedAt,
          events: result.events ?? [],
        };
      };
      const runMinimal = async (
        trace = false,
        recordTrace = true
      ): Promise<{ elapsedMs: number; events: unknown[] }> => await new Promise((resolve, reject) => {
        const worker = new Worker(
          `${origin}/minimal/traceclr-tier-minimal-worker.mjs`,
          { type: 'module' }
        );
        const startedAt = performance.now();
        const deadline = setTimeout(() => {
          worker.terminate();
          reject(new Error('Minimal TraceCLR worker exceeded the 15 second benchmark deadline.'));
        }, 15_000);
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'ready') {
            worker.postMessage({
              ...(trace ? {
                mode: 'trace',
                artifactBase64: fastTrace.compiledArtifactBase64,
                artifactSha256: fastTrace.compiledArtifactSha256,
                source: fastSource,
                timeoutMs: 10_000,
                maxTraceSteps: 10_000,
                maxLineEvents: 10_000,
                maxSingleLineHits: 10_000,
                maxStoredEvents: 10_000,
                minimalTrace: false,
                recordTrace,
              } : {
                artifactBase64: fast.compiledArtifactBase64,
              }),
              inputBase64: btoa(String.fromCharCode(...inputBytes)),
            });
            return;
          }
          worker.terminate();
          clearTimeout(deadline);
          if (!event.data?.success) reject(new Error(event.data?.error ?? 'Minimal runner failed'));
          else {
            const output = event.data.output as Uint8Array;
            const value = decodeOutput(output);
            if (
              value !== 42 ||
              event.data.traceLimitExceeded === true ||
              (trace && recordTrace && (!Array.isArray(event.data.events) || event.data.events.length === 0)) ||
              (trace && !recordTrace && (event.data.events?.length ?? 0) !== 0)
            ) {
              reject(new Error(`Minimal runner returned an invalid result: ${JSON.stringify(event.data)}`));
            } else {
              resolve({
                elapsedMs: performance.now() - startedAt,
                events: event.data.events ?? [],
              });
            }
          }
        });
        worker.addEventListener('error', (event) => {
          worker.terminate();
          clearTimeout(deadline);
          reject(new Error(event.message));
        }, { once: true });
      });
      const integratedFastMs: number[] = [];
      const compatibilityMs: number[] = [];
      const minimalMs: number[] = [];
      const integratedTraceMs: number[] = [];
      const minimalTraceMs: number[] = [];
      const compatibilityTraceMs: number[] = [];
      let traceEventCount = 0;
      for (let index = 0; index < sampleCount; index++) {
        const integratedTrace = await runIntegratedTrace();
        const minimalTrace = await runMinimal(true);
        const broadTrace = await runIntegratedTrace(
          true,
          compatibilityTrace
        );
        if (JSON.stringify(integratedTrace.events) !== JSON.stringify(minimalTrace.events)) {
          throw new Error(`TraceCLR shells produced different events: ${JSON.stringify({
            integrated: integratedTrace.events,
            minimal: minimalTrace.events,
          })}`);
        }
        if (JSON.stringify(integratedTrace.events) !== JSON.stringify(broadTrace.events)) {
          throw new Error(`Fast and compatibility TraceCLR produced different events: ${JSON.stringify({
            fast: integratedTrace.events,
            compatibility: broadTrace.events,
          })}`);
        }
        if (index === 0) {
          traceEventCount = integratedTrace.events.length;
          await runIntegratedTrace(false);
          await runMinimal(true, false);
        }
        integratedTraceMs.push(integratedTrace.elapsedMs);
        minimalTraceMs.push(minimalTrace.elapsedMs);
        compatibilityTraceMs.push(broadTrace.elapsedMs);
        if (index % 2 === 0) {
          integratedFastMs.push(await runIntegrated(fast, fastSource));
          compatibilityMs.push(await runIntegrated(compatibility, compatibilitySource));
          minimalMs.push((await runMinimal()).elapsedMs);
        } else {
          minimalMs.push((await runMinimal()).elapsedMs);
          compatibilityMs.push(await runIntegrated(compatibility, compatibilitySource));
          integratedFastMs.push(await runIntegrated(fast, fastSource));
        }
      }
      return {
        fastArtifactBase64: fast.compiledArtifactBase64,
        inputBase64: btoa(String.fromCharCode(...inputBytes)),
        compileMs: fast.timings?.compileMs ?? null,
        traceCompileMs: fastTrace.timings?.compileMs ?? null,
        integratedFastMs,
        compatibilityMs,
        minimalMs,
        integratedTraceMs,
        minimalTraceMs,
        compatibilityTraceMs,
        traceEventCount,
      };
    }, { origin, sampleCount });
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'traceclr-tier-benchmark-'));
  const nativeWallMs: number[] = [];
  try {
    const assemblyPath = join(temporaryDirectory, 'Learner.dll');
    const manifestPath = join(temporaryDirectory, 'manifest.json');
    const resultPath = join(temporaryDirectory, 'result.json');
    writeFileSync(assemblyPath, Buffer.from(browserResult.fastArtifactBase64, 'base64'));
    writeFileSync(manifestPath, `${JSON.stringify({
      schema: 'tracecode.traceclr-native-probe.v1',
      cases: [{ id: 'add', assemblyPath, inputBase64: browserResult.inputBase64 }],
    })}\n`);
    const project = join(ROOT, 'tools/TraceCode.TraceClrNativeProbe/TraceCode.TraceClrNativeProbe.csproj');
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '--nologo'], { cwd: ROOT, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`Native probe build failed:\n${build.stderr || build.stdout}`);
    const probe = join(ROOT, 'tools/TraceCode.TraceClrNativeProbe/bin/Release/net10.0/TraceCode.TraceClrNativeProbe.dll');
    for (let index = 0; index < sampleCount; index++) {
      const startedAt = performance.now();
      const run = spawnSync('dotnet', [probe, manifestPath, resultPath], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
      nativeWallMs.push(performance.now() - startedAt);
      if (run.status !== 0) throw new Error(`Native probe failed:\n${run.stderr || run.stdout}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    schema: 'tracecode.traceclr-runtime-tier-benchmark.v1',
    engine: engineName,
    sampleCount,
    compileMs: browserResult.compileMs,
    traceCompileMs: browserResult.traceCompileMs,
    integratedFast: summarize(browserResult.integratedFastMs),
    compatibility: summarize(browserResult.compatibilityMs),
    minimal: summarize(browserResult.minimalMs),
    integratedTrace: summarize(browserResult.integratedTraceMs),
    minimalTrace: summarize(browserResult.minimalTraceMs),
    compatibilityTrace: summarize(browserResult.compatibilityTraceMs),
    traceEventCount: browserResult.traceEventCount,
    nativeProcess: summarize(nativeWallMs),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
