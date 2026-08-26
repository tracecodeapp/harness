#!/usr/bin/env npx tsx

/**
 * Measures the real browser TraceCC prepared-program boundary without Judge.
 *
 * `fresh-instance` is the product implementation: one immutable compiled
 * WebAssembly.Module is retained while every case receives a fresh WASI
 * instance, linear memory, globals, constructors, and filesystem.
 *
 * `unsafe-shared-case` deliberately changes the learner ABI so every logical
 * case runs inside one Wasm invocation. It is a ceiling experiment only: C++
 * static storage, allocator/runtime state, and ambient libc state are shared.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const samples = Number.parseInt(process.env.TRACECODE_CPP_TIER_SAMPLES ?? '5', 10);
const assetDirectory = resolve(
  process.env.TRACECC_RUNTIME_ASSET_DIR ??
    join(
      root,
      'node_modules/@tracecode/tracecc/runtime-release',
      'fb4b6f41f9e9b7db89b6c8425bb2c6218979219a4150f96619b6461b4b78d294'
    )
);

if (!Number.isSafeInteger(samples) || samples <= 0) {
  throw new Error('TRACECODE_CPP_TIER_SAMPLES must be a positive integer.');
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

async function startServer(staticRoot: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(staticRoot, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(staticRoot + sep) && candidate !== staticRoot) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = candidate.endsWith(sep) ? join(candidate, 'index.html') : candidate;
    import('node:fs').then(({ createReadStream, existsSync, statSync }) => {
      const resolvedPath = statSync(filePath, { throwIfNoEntry: false })?.isDirectory()
        ? join(filePath, 'index.html')
        : filePath;
      if (!existsSync(resolvedPath)) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Length': String(statSync(resolvedPath).size),
        'Content-Type': contentType(resolvedPath),
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      createReadStream(resolvedPath).pipe(response);
    }).catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No benchmark server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    }),
  };
}

function proposedInputs(count: number): Array<{ nums: number[] }> {
  const sizes = [1, 4, 16, 64, 256, 1024];
  return Array.from({ length: count }, (_, index) => {
    const size = sizes[index % sizes.length]!;
    const nums = Array.from(
      { length: size },
      (_, valueIndex) => index * 1_000_000 + valueIndex
    );
    if (size > 1 && index % 3 === 0) nums[size - 1] = nums[0]!;
    if (size > 1 && index % 3 === 1) nums[1] = nums[0]!;
    return { nums };
  });
}

function proposedCases(count: number): Array<{
  id: string;
  input: { nums: number[] };
  expected: boolean;
}> {
  return proposedInputs(count).map((input, index) => ({
    id: `case-${index + 1}`,
    input,
    expected: new Set(input.nums).size !== input.nums.length,
  }));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-isolation-tiers-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let compilerProcess: ReturnType<typeof spawn> | undefined;
  try {
    const assets = [
      'tracecc-reactor.wasm', 'llvm-resources.tar', 'tracecode_runtime.hpp',
      'narrow.pch', 'narrow.source.hpp', 'narrow.o',
      'broad.pch', 'broad.source.hpp', 'broad.o',
      'map.pch', 'map.source.hpp', 'map.o',
    ];
    const integrity = {
      assets: await Promise.all(assets.map(async (name) => {
        const bytes = await readFile(join(assetDirectory, name));
        return {
          url: `/tracecc/${name}`,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      })),
    };

    const workersRoot = join(tempRoot, 'workers');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      compilerProcess = spawn(
        'pnpm',
        ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'cpp'],
        { cwd: root, stdio: 'inherit' }
      );
      compilerProcess.once('error', rejectPromise);
      compilerProcess.once('exit', (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`C++ asset sync exited ${String(code)}.`));
      });
    });
    compilerProcess = undefined;
    await symlink(assetDirectory, join(tempRoot, 'tracecc'), 'dir');

    for (const [entry, output] of [
      ['packages/runtime-cpp/src/cpp-worker-client.ts', 'cpp-worker-client.js'],
      ['packages/runtime-cpp/src/cpp-prepared-provider.ts', 'cpp-prepared-provider.js'],
      ['packages/runtime-cpp/src/tracecc-compiler-service.ts', 'tracecc-compiler-service.js'],
    ] as const) {
      await build({
        entryPoints: [join(root, entry)],
        outfile: join(tempRoot, output),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        tsconfig: join(root, 'tsconfig.base.json'),
        define: { 'process.env.NODE_ENV': '"production"' },
      });
    }
    const judgeEntryPath = join(tempRoot, 'judge-benchmark-entry.ts');
    await writeFile(judgeEntryPath, `
import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from ${JSON.stringify(join(root, 'src/judge.ts'))};

export async function runJudgeBenchmark(options) {
  const host = createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers: ['cpp'],
    safeExecution: { prewarmAfterUse: false },
  });
  try {
    const warmStartedAt = performance.now();
    const warmResult = await host.warmLanguage('cpp');
    const warmMs = performance.now() - warmStartedAt;
    const records = { 10: [], 100: [] };
    for (let sample = 0; sample < options.samples; sample += 1) {
      for (const count of sample % 2 === 0 ? [10, 100] : [100, 10]) {
        const bundleStartedAt = performance.now();
        const bundle = await createAlgorithmJudgeBundle({
          id: 'cpp-' + count + '-' + sample,
          language: 'cpp',
          code: options.code + '\\n// cpp-isolation-tier-' + count + '-' + sample,
          functionName: 'containsDuplicate',
          executionStyle: 'solution-method',
          trace: false,
          cases: options.cases[count],
          policy: allCasesPassPolicy(),
        });
        const evaluateStartedAt = performance.now();
        const receipt = await host.evaluateAlgorithm({ bundle });
        const endedAt = performance.now();
        if (
          receipt.evaluation.status !== 'completed' ||
          receipt.passedCount !== count ||
          receipt.totalCount !== count
        ) {
          throw new Error('C++ Judge benchmark failed: ' + JSON.stringify(receipt));
        }
        records[count].push({
          bundleMs: evaluateStartedAt - bundleStartedAt,
          evaluateMs: endedAt - evaluateStartedAt,
          bundleToReceiptMs: endedAt - bundleStartedAt,
        });
      }
    }
    return { warmMs, warmResult, records };
  } finally {
    host.dispose();
  }
}
`);
    await build({
      entryPoints: [judgeEntryPath],
      outfile: join(tempRoot, 'judge-benchmark.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startServer(tempRoot);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(300_000);
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate('globalThis.__name = (fn) => fn');
      const result = await page.evaluate(async ({ sampleCount, compilerIntegrity }) => {
        const [{ CppWorkerClient }, { createCppPreparedExecutionProvider }, { TraceCCCompilerService }] =
          await Promise.all([
            // @ts-expect-error Browser-served benchmark module.
            import('/cpp-worker-client.js'),
            // @ts-expect-error Browser-served benchmark module.
            import('/cpp-prepared-provider.js'),
            // @ts-expect-error Browser-served benchmark module.
            import('/tracecc-compiler-service.js'),
          ]);
        const compiler = new TraceCCCompilerService({
          workerUrl: '/workers/cpp-worker.js',
          compilerUrl: '/tracecc/tracecc-reactor.wasm',
          resourcesUrl: '/tracecc/llvm-resources.tar',
          runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
          compilerIntegrity,
          maxCompilesPerWorker: 16,
          shards: {
            narrow: { pchUrl: '/tracecc/narrow.pch', pchSourceUrl: '/tracecc/narrow.source.hpp', runtimeObjectUrl: '/tracecc/narrow.o' },
            broad: { pchUrl: '/tracecc/broad.pch', pchSourceUrl: '/tracecc/broad.source.hpp', runtimeObjectUrl: '/tracecc/broad.o' },
            map: { pchUrl: '/tracecc/map.pch', pchSourceUrl: '/tracecc/map.source.hpp', runtimeObjectUrl: '/tracecc/map.o' },
          },
        });
        const workerOptions = {
          workerUrl: '/workers/cpp-worker.js',
          compilerWasmUrl: '/tracecc/tracecc-reactor.wasm',
          linkerWasmUrl: '/tracecc/tracecc-reactor.wasm',
          sysrootUrl: '/tracecc/llvm-resources.tar',
          runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
          trustedCompilerService: compiler,
          executionTimeoutMs: 60_000,
          tracingTimeoutMs: 60_000,
        };
        const provider = createCppPreparedExecutionProvider({
          createWorkerClient: () => new CppWorkerClient(workerOptions),
          warmCompilerOnInit: true,
        });
        const strictSource = [
          'class Solution {',
          'public:',
          '  bool containsDuplicate(vector<int>& nums) {',
          '    unordered_set<int> seen;',
          '    for (int value : nums) {',
          '      if (seen.count(value)) return true;',
          '      seen.insert(value);',
          '    }',
          '    return false;',
          '  }',
          '};',
        ].join('\n');
        const unsafeSource = [
          'class Solution {',
          '  bool one(vector<int>& nums) {',
          '    unordered_set<int> seen;',
          '    for (int value : nums) {',
          '      if (seen.count(value)) return true;',
          '      seen.insert(value);',
          '    }',
          '    return false;',
          '  }',
          'public:',
          '  vector<int> containsDuplicateBatch(vector<vector<int>>& batches) {',
          '    vector<int> results;',
          '    results.reserve(batches.size());',
          '    for (auto& nums : batches) results.push_back(one(nums) ? 1 : 0);',
          '    return results;',
          '  }',
          '};',
        ].join('\n');
        await provider.init();
        const strict = await provider.prepareProgram({
          mode: 'code', code: strictSource, functionName: 'containsDuplicate', executionStyle: 'solution-method',
        });
        const unsafe = await provider.prepareProgram({
          mode: 'code', code: unsafeSource, functionName: 'containsDuplicateBatch', executionStyle: 'solution-method',
        });
        if (strict.kind !== 'prepared' || unsafe.kind !== 'prepared') {
          throw new Error(`C++ benchmark preparation failed: ${JSON.stringify({ strict, unsafe })}`);
        }
        const records: Record<10 | 100, { strict: number[]; unsafe: number[] }> = {
          10: { strict: [], unsafe: [] },
          100: { strict: [], unsafe: [] },
        };
        const inputsFor = (count: number): Array<{ nums: number[] }> => {
          const sizes = [1, 4, 16, 64, 256, 1024];
          return Array.from({ length: count }, (_, index) => {
            const size = sizes[index % sizes.length];
            const nums = Array.from({ length: size }, (_, valueIndex) => index * 1_000_000 + valueIndex);
            if (size > 1 && index % 3 === 0) nums[size - 1] = nums[0];
            if (size > 1 && index % 3 === 1) nums[1] = nums[0];
            return { nums };
          });
        };
        for (let sample = 0; sample < sampleCount; sample += 1) {
          const order: readonly (10 | 100)[] = sample % 2 === 0
            ? [10, 100]
            : [100, 10];
          for (const count of order) {
            const inputs = inputsFor(count);
            const expected = inputs.map(({ nums }) => new Set(nums).size !== nums.length);
            const strictStartedAt = performance.now();
            const strictResults = await strict.program.executeBatchIsolated({ inputBatch: inputs });
            records[count].strict.push(performance.now() - strictStartedAt);
            const strictOutputs = strictResults.map(
              (entry: { kind: string; output?: unknown }) =>
                entry.kind === 'completed' ? entry.output : null
            );
            if (JSON.stringify(strictOutputs) !== JSON.stringify(expected)) {
              throw new Error(`Strict ${count}-case output mismatch: ${JSON.stringify(strictOutputs)}`);
            }

            const unsafeStartedAt = performance.now();
            const unsafeResult = await unsafe.program.executeIsolated({ inputs: { batches: inputs.map(({ nums }) => nums) } });
            records[count].unsafe.push(performance.now() - unsafeStartedAt);
            const unsafeOutputs = unsafeResult.kind === 'completed' && Array.isArray(unsafeResult.output)
              ? unsafeResult.output.map((value: unknown) => value === 1)
              : null;
            if (JSON.stringify(unsafeOutputs) !== JSON.stringify(expected)) {
              throw new Error(`Unsafe ${count}-case output mismatch: ${JSON.stringify(unsafeResult)}`);
            }
          }
        }
        await Promise.all([strict.program.dispose(), unsafe.program.dispose()]);
        provider.terminate();
        compiler.terminate();
        return records;
      }, { sampleCount: samples, compilerIntegrity: integrity });

      const summaries = ([10, 100] as const).map((count) => ({
        cases: count,
        freshInstanceMs: result[count].strict,
        unsafeSharedCaseMs: result[count].unsafe,
        p50FreshInstanceMs: percentile(result[count].strict, 0.5),
        p95FreshInstanceMs: percentile(result[count].strict, 0.95),
        p50UnsafeSharedCaseMs: percentile(result[count].unsafe, 0.5),
        p95UnsafeSharedCaseMs: percentile(result[count].unsafe, 0.95),
        p50CeilingRatio:
          percentile(result[count].strict, 0.5) /
          percentile(result[count].unsafe, 0.5),
      }));
      const strictCode = [
        'class Solution {',
        'public:',
        '  bool containsDuplicate(vector<int>& nums) {',
        '    unordered_set<int> seen;',
        '    for (int value : nums) {',
        '      if (seen.count(value)) return true;',
        '      seen.insert(value);',
        '    }',
        '    return false;',
        '  }',
        '};',
      ].join('\n');
      const judge = await page.evaluate(async (options) => {
        // @ts-expect-error Browser-served benchmark module.
        const benchmark = await import('/judge-benchmark.js');
        return benchmark.runJudgeBenchmark(options);
      }, {
        samples,
        code: strictCode,
        cases: { 10: proposedCases(10), 100: proposedCases(100) },
      });
      const judgeSummaries = ([10, 100] as const).map((count) => {
        const totals = judge.records[count].map(
          (record: { bundleToReceiptMs: number }) => record.bundleToReceiptMs
        );
        const evaluations = judge.records[count].map(
          (record: { evaluateMs: number }) => record.evaluateMs
        );
        return {
          cases: count,
          records: judge.records[count],
          p50BundleToReceiptMs: percentile(totals, 0.5),
          p95BundleToReceiptMs: percentile(totals, 0.95),
          p50EvaluateMs: percentile(evaluations, 0.5),
          p95EvaluateMs: percentile(evaluations, 0.95),
        };
      });
      console.log(JSON.stringify({
        measuredAt: new Date().toISOString(),
        browserVersion: browser.version(),
        samples,
        preparedBoundary: {
          description: 'real-browser TraceCC prepared execution; Judge comparison excluded',
          summaries,
        },
        judgeBoundary: {
          description: 'real browser Judge, compile plus all-case correctness receipt',
          warmMs: judge.warmMs,
          warmResult: judge.warmResult,
          summaries: judgeSummaries,
        },
      }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    compilerProcess?.kill('SIGTERM');
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
