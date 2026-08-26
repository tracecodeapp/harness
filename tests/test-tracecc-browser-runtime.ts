#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

const REQUIRED_TRACECC_ASSETS = [
  'tracecc-reactor.wasm',
  'llvm-resources.tar',
  'tracecode_runtime.hpp',
  'narrow.pch',
  'narrow.source.hpp',
  'narrow.o',
  'broad.pch',
  'broad.source.hpp',
  'broad.o',
  'map.pch',
  'map.source.hpp',
  'map.o',
] as const;

async function resolveTraceCCAssets(root: string): Promise<{
  sourceRoot: string;
  files: readonly { path: string; size: number; sha256: string }[];
}> {
  if (process.env.TRACECC_RUNTIME_ASSET_DIR) {
    const sourceRoot = resolve(process.env.TRACECC_RUNTIME_ASSET_DIR);
    return {
      sourceRoot,
      files: await Promise.all(REQUIRED_TRACECC_ASSETS.map(async (path) => {
        const bytes = await readFile(join(sourceRoot, path));
        return {
          path,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      })),
    };
  }
  const { tracecc } = await loadEngineRuntimePackages(root);
  return {
    sourceRoot: tracecc.sourceRoot,
    files: tracecc.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const traceccAssets = await resolveTraceCCAssets(root);
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecc-browser-runtime-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5600 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
  const compilerIntegrity = {
    assets: traceccAssets.files.map((file) => ({
      url: `${origin}/tracecc/${file.path}`,
      size: file.size,
      sha256: file.sha256,
    })),
  };

  await runCommand(
    'pnpm',
    [
      'exec',
      'tsx',
      'src/cli.ts',
      'sync-assets',
      workersRoot,
      '--languages',
      'cpp',
    ],
    root
  );
  await symlink(traceccAssets.sourceRoot, join(tempRoot, 'tracecc'), 'dir');
  for (const [entry, output] of [
    [
      'packages/runtime-cpp/src/cpp-worker-client.ts',
      'cpp-worker-client.js',
    ],
    [
      'packages/runtime-cpp/src/cpp-prepared-provider.ts',
      'cpp-prepared-provider.js',
    ],
    [
      'packages/runtime-cpp/src/tracecc-compiler-service.ts',
      'tracecc-compiler-service.js',
    ],
    [
      'packages/runtime-browser/src/project.ts',
      'browser-project.js',
    ],
    [
      'packages/runtime-cpp/src/tracecc-runtime-assets.ts',
      'tracecc-runtime-assets.js',
    ],
  ] as const) {
    await build({
      entryPoints: [join(root, entry)],
      outfile: join(tempRoot, output),
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
  }
  await writeFile(
    join(tempRoot, 'index.html'),
    '<!doctype html><title>TraceCC browser runtime</title>',
    'utf8'
  );

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".hpp": "text/plain"}',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        self.send_header("Cache-Control", "no-cache")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    const requestedUrls: string[] = [];
    page.on('request', (request) => {
      requestedUrls.push(request.url());
    });
    page.setDefaultTimeout(180_000);
    await page.goto(origin);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const result = await page.evaluate(`(async () => {
      const NativeWorker = globalThis.Worker;
      const workerUrls = [];
      globalThis.Worker = class ObservedWorker extends NativeWorker {
        constructor(url, options) {
          workerUrls.push(String(url));
          super(url, options);
        }
      };
      const { CppWorkerClient } = await import('/cpp-worker-client.js');
      const { createCppPreparedExecutionProvider } =
        await import('/cpp-prepared-provider.js');
      const { TraceCCCompilerService } =
        await import('/tracecc-compiler-service.js');
      const compiler = new TraceCCCompilerService({
        workerUrl: '/workers/cpp-worker.js',
        compilerUrl: '/tracecc/tracecc-reactor.wasm',
        resourcesUrl: '/tracecc/llvm-resources.tar',
        runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
        compilerIntegrity: ${JSON.stringify(compilerIntegrity)},
        maxCompilesPerWorker: 8,
        shards: {
          narrow: {
            pchUrl: '/tracecc/narrow.pch',
            pchSourceUrl: '/tracecc/narrow.source.hpp',
            runtimeObjectUrl: '/tracecc/narrow.o',
          },
          broad: {
            pchUrl: '/tracecc/broad.pch',
            pchSourceUrl: '/tracecc/broad.source.hpp',
            runtimeObjectUrl: '/tracecc/broad.o',
          },
          map: {
            pchUrl: '/tracecc/map.pch',
            pchSourceUrl: '/tracecc/map.source.hpp',
            runtimeObjectUrl: '/tracecc/map.o',
          },
        },
      });
      const workerOptions = {
        workerUrl: '/workers/cpp-worker.js',
        compilerWasmUrl: '/tracecc/tracecc-reactor.wasm',
        linkerWasmUrl: '/tracecc/tracecc-reactor.wasm',
        sysrootUrl: '/tracecc/llvm-resources.tar',
        runtimeHeaderUrl: '/tracecc/tracecode_runtime.hpp',
        trustedCompilerService: compiler,
        executionTimeoutMs: 60000,
        tracingTimeoutMs: 60000,
      };
      const provider = createCppPreparedExecutionProvider({
        createWorkerClient: () => new CppWorkerClient(workerOptions),
        warmCompilerOnInit: true,
      });
      const measureMainThreadHeartbeat = async (run) => {
        const sampleMs = 16;
        let ticks = 0;
        let maxGapMs = 0;
        let lastTickAt = performance.now();
        const timer = setInterval(() => {
          const now = performance.now();
          maxGapMs = Math.max(maxGapMs, now - lastTickAt);
          lastTickAt = now;
          ticks += 1;
        }, sampleMs);
        try {
          const value = await run();
          // Let a queued heartbeat observe any synchronous deserialization or
          // result adaptation performed immediately before the Promise settled.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { value, ticks, maxGapMs: Math.round(maxGapMs) };
        } finally {
          clearInterval(timer);
        }
      };
      const warmStartedAt = performance.now();
      await provider.init();
      const warmMs = performance.now() - warmStartedAt;
      const compileAndRun = async (code, inputs) => {
        const startedAt = performance.now();
        const preparation = await provider.prepareProgram({
          mode: 'code',
          code,
          functionName: 'add',
          executionStyle: 'solution-method',
        });
        if (preparation.kind !== 'prepared') return {
          kind: preparation.kind,
          error: preparation.error,
          elapsedMs: performance.now() - startedAt,
        };
        const execution = await preparation.program.executeIsolated({
          inputs,
        });
        await preparation.program.dispose();
        return {
          kind: execution.kind,
          output: execution.kind === 'completed'
            ? execution.output
            : undefined,
          error: execution.kind === 'completed'
            ? undefined
            : execution.error,
          timings: preparation.timings,
          elapsedMs: performance.now() - startedAt,
        };
      };
      const firstHeartbeat = await measureMainThreadHeartbeat(() => compileAndRun(
        'class Solution { public: int add(int a, int b) { return a + b; } };',
        { a: 20, b: 22 }
      ));
      const first = firstHeartbeat.value;
      const edited = await compileAndRun(
        'class Solution { public: int add(int a, int b) { return a + b + 1; } };',
        { a: 20, b: 22 }
      );
      const isolatedBatchPreparation = await provider.prepareProgram({
        mode: 'code',
        code: [
          '#include <cstdio>',
          '#include <vector>',
          'int tracecode_global_calls = 0;',
          'class Solution {',
          'public:',
          '  int observe(std::vector<int>& nums, bool hang) {',
          '    if (hang) { while (true) {} }',
          '    static int calls = 0;',
          '    static int* heap_calls = new int(0);',
          '    calls += 1;',
          '    *heap_calls += 1;',
          '    tracecode_global_calls += 1;',
          '    FILE* prior = std::fopen("/case-state.txt", "r");',
          '    bool file_leaked = prior != nullptr;',
          '    if (prior) std::fclose(prior);',
          '    FILE* written = std::fopen("/case-state.txt", "w");',
          '    if (written) { std::fputs("case", written); std::fclose(written); }',
          '    nums.push_back(99);',
          '    bool state_fresh = calls == 1 && *heap_calls == 1 && tracecode_global_calls == 1 && !file_leaked;',
          '    return (state_fresh ? 100 : 900) + static_cast<int>(nums.size());',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'observe',
        executionStyle: 'solution-method',
      });
      if (
        isolatedBatchPreparation.kind !== 'prepared' ||
        isolatedBatchPreparation.program.mode !== 'code' ||
        typeof isolatedBatchPreparation.program.executeBatchIsolated !== 'function'
      ) {
        throw new Error(
          'TraceCC isolated batch preparation failed: ' +
            JSON.stringify(isolatedBatchPreparation)
        );
      }
      const callerOwnedNums = [1, 2];
      const isolatedBatchResults =
        await isolatedBatchPreparation.program.executeBatchIsolated({
          inputBatch: [
            { nums: callerOwnedNums, hang: false },
            { nums: callerOwnedNums, hang: false },
            { nums: callerOwnedNums, hang: false },
          ],
        });
      await isolatedBatchPreparation.program.dispose();

      const abortBatchPreparation = await provider.prepareProgram({
        mode: 'code',
        code: [
          'class Solution {',
          'public:',
          '  int maybeHang(int value, bool hang) {',
          '    if (hang) { while (true) {} }',
          '    return value;',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'maybeHang',
        executionStyle: 'solution-method',
      });
      if (
        abortBatchPreparation.kind !== 'prepared' ||
        abortBatchPreparation.program.mode !== 'code' ||
        typeof abortBatchPreparation.program.executeBatchIsolated !== 'function'
      ) {
        throw new Error(
          'TraceCC abort batch preparation failed: ' +
            JSON.stringify(abortBatchPreparation)
        );
      }
      const abortController = new AbortController();
      const abortedBatchPromise =
        abortBatchPreparation.program.executeBatchIsolated({
          inputBatch: [
            { value: 1, hang: false },
            { value: 2, hang: true },
            { value: 3, hang: false },
          ],
          signal: abortController.signal,
        }).then(
          () => ({ resolved: true, name: '' }),
          (error) => ({
            resolved: false,
            name: error instanceof Error ? error.name : '',
          })
        );
      setTimeout(() => abortController.abort(), 25);
      const abortedBatch = await abortedBatchPromise;
      await abortBatchPreparation.program.dispose();
      const mixedTraceClient = new CppWorkerClient(workerOptions);
      await mixedTraceClient.init();
      const mixedTracePreparation = await mixedTraceClient.prepareRuntimeProgram({
        mode: 'trace',
        code: [
          'class Solution {',
          'public:',
          '  int add(int a, int b) {',
          '    static int calls = 0;',
          '    calls += 1;',
          '    int sum = a + b;',
          '    return calls * 100 + sum;',
          '  }',
          '};',
        ].join('\\n'),
        functionName: 'add',
        executionStyle: 'solution-method',
        traceOptions: { maxTraceSteps: 1000 },
      });
      if (!mixedTracePreparation.success) {
        throw new Error(
          'TraceCC mixed trace preparation failed: ' +
            JSON.stringify(mixedTracePreparation)
        );
      }
      const mixedTraceResults = await mixedTraceClient.executePreparedTraceBatch(
        mixedTracePreparation.handle,
        {
          inputBatch: [
            { a: 1, b: 2 },
            { a: 3, b: 4 },
            { a: 5, b: 6 },
          ],
          traceEnabledBatch: [true, false, true],
        }
      );
      const invalidMixedTraceSelection = await mixedTraceClient
        .executePreparedTraceBatch(
          mixedTracePreparation.handle,
          { inputBatch: [{ a: 1, b: 2 }], traceEnabledBatch: [] }
        )
        .then(
          () => '',
          (error) => error instanceof Error ? error.message : String(error)
        );
      const scriptTracePreparation = await mixedTraceClient.prepareRuntimeProgram({
        mode: 'trace',
        code: 'int result = 42;',
        functionName: '',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 1000 },
      });
      if (!scriptTracePreparation.success) {
        throw new Error(
          'TraceCC script trace preparation failed: ' +
            JSON.stringify(scriptTracePreparation)
        );
      }
      const scriptTraceResults = await mixedTraceClient.executePreparedTraceBatch(
        scriptTracePreparation.handle,
        {
          inputBatch: [{}, {}],
          traceEnabledBatch: [true, false],
        }
      );
      await mixedTraceClient.disposePreparedProgram(
        scriptTracePreparation.handle
      );
      await mixedTraceClient.disposePreparedProgram(
        mixedTracePreparation.handle
      );
      mixedTraceClient.terminate();
      const projectClient = new CppWorkerClient(workerOptions);
      const projectFiles = [
        {
          path: 'main.cpp',
          contents:
            '#include <iostream>\\n#include "helper.hpp"\\n'
            + 'int main(int argc, char** argv) { '
            + 'std::cout << answer() << ":" << (argc > 1 ? argv[1] : "none") << "\\\\n"; }\\n',
        },
        {
          path: 'helper.hpp',
          contents: 'int answer();\\n',
        },
        {
          path: 'helper.cpp',
          contents:
            '#include "helper.hpp"\\n#include <value.hpp>\\n'
            + 'int answer() { return PROJECT_BASE + INCLUDED_VALUE; }\\n',
        },
        {
          path: 'include/value.hpp',
          contents: '#define INCLUDED_VALUE 2\\n',
        },
      ];
      const projectCompile = await projectClient.executeProjectCpp({
        code: '',
        source: 'compile',
        scriptPath: 'main.cpp',
        args: [
          '-std=c++17',
          '-I',
          'include',
          '-DPROJECT_BASE=40',
          'main.cpp',
          'helper.cpp',
          '-o',
          'project-app',
        ],
        cwd: '/workspace',
        env: {},
        project: {
          workspaceRoot: '/workspace',
          cwd: '/workspace',
          files: projectFiles,
        },
      });
      const projectRun = projectCompile.exitCode === 0
        ? await projectClient.executeProjectCpp({
            code: '',
            source: 'run',
            scriptPath: './project-app',
            args: ['generic'],
            cwd: '/workspace',
            env: {},
            project: {
              workspaceRoot: '/workspace',
              cwd: '/workspace',
              files: [...projectFiles, ...(projectCompile.files || [])],
            },
          })
        : null;
      const objectCompile = await projectClient.executeProjectCpp({
        code: '',
        source: 'compile',
        scriptPath: 'lib/value.cpp',
        args: ['-c', 'lib/value.cpp', '-o', 'build/value.o'],
        cwd: '/workspace',
        env: {},
        project: {
          workspaceRoot: '/workspace',
          cwd: '/workspace',
          files: [
            {
              path: 'lib/value.cpp',
              contents: 'extern "C" int project_value() { return 17; }\\n',
            },
          ],
        },
      });
      const objectLinkFiles = [
        {
          path: 'main.c',
          contents:
            '#include <stdio.h>\\n'
            + 'int project_value(void);\\n'
            + 'int main(void) { printf("c:%d\\\\n", project_value()); }\\n',
        },
        ...(objectCompile.files || []),
      ];
      const objectLink = objectCompile.exitCode === 0
        ? await projectClient.executeProjectCpp({
            code: '',
            source: 'compile',
            scriptPath: 'main.c',
            args: ['main.c', 'build/value.o', '-o', 'build/c-app'],
            cwd: '/workspace',
            env: {},
            project: {
              workspaceRoot: '/workspace',
              cwd: '/workspace',
              files: objectLinkFiles,
            },
            options: { compilerCommand: 'gcc' },
          })
        : null;
      const cRun = objectLink?.exitCode === 0
        ? await projectClient.executeProjectCpp({
            code: '',
            source: 'run',
            scriptPath: './c-app',
            args: [],
            cwd: '/workspace/build',
            env: {},
            project: {
              workspaceRoot: '/workspace',
              cwd: '/workspace',
              files: [...objectLinkFiles, ...(objectLink.files || [])],
            },
          })
        : null;
      projectClient.terminate();
      provider.terminate();
      compiler.terminate();
      const { createBrowserProjectWorkspace } =
        await import('/browser-project.js');
      const { createTraceCCRuntimeManifest } =
        await import('/tracecc-runtime-assets.js');
      const workspace = await createBrowserProjectWorkspace({
        providers: ['cpp'],
        assets: {
          runtimeManifests: {
            cpp: createTraceCCRuntimeManifest('/tracecc'),
          },
        },
        projectWorkerIsolation: 'per-command',
        files: [
          {
            path: 'workspace-main.cpp',
            contents:
              '#include <iostream>\\n#include "workspace-value.hpp"\\n'
              + 'int main(int argc, char** argv) { '
              + 'std::cout << workspace_value() << ":" '
              + '<< (argc > 1 ? argv[1] : "none") << "\\\\n"; }\\n',
          },
          {
            path: 'workspace-value.hpp',
            contents: 'int workspace_value();\\n',
          },
          {
            path: 'workspace-value.cpp',
            contents:
              '#include "workspace-value.hpp"\\n'
              + 'int workspace_value() { return 42; }\\n',
          },
        ],
      });
      let workspaceCompile;
      let workspaceRun;
      try {
        workspaceCompile = await workspace.runCommand(
          'clang++ -std=c++17 workspace-main.cpp workspace-value.cpp -o workspace-app'
        );
        workspaceRun = workspaceCompile.exitCode === 0
          ? await workspace.runCommand('./workspace-app project-mode')
          : null;
      } finally {
        workspace.dispose();
      }
      return {
        workerUrls,
        warmMs,
        first,
        firstHeartbeat: {
          ticks: firstHeartbeat.ticks,
          maxGapMs: firstHeartbeat.maxGapMs,
        },
        edited,
        isolatedBatchResults,
        callerOwnedNums,
        abortedBatch,
        mixedTraceResults,
        scriptTraceResults,
        invalidMixedTraceSelection,
        projectCompile: {
          ...projectCompile,
          files: projectCompile.files?.map((file) => ({
            path: file.path,
            encoding: file.encoding,
          })),
        },
        projectRun,
        objectCompile: {
          ...objectCompile,
          files: objectCompile.files?.map((file) => ({
            path: file.path,
            encoding: file.encoding,
          })),
        },
        objectLink: objectLink
          ? {
              ...objectLink,
              files: objectLink.files?.map((file) => ({
                path: file.path,
                encoding: file.encoding,
              })),
            }
          : null,
        cRun,
        workspaceCompile: {
          ...workspaceCompile,
          files: workspaceCompile.files?.map((file) => ({
            path: file.path,
            encoding: file.encoding,
          })),
        },
        workspaceRun,
      };
    })()`) as {
      workerUrls: string[];
      warmMs: number;
      first: {
        kind: string;
        output?: unknown;
        error?: string;
        elapsedMs: number;
        timings?: Record<string, unknown>;
      };
      firstHeartbeat: { ticks: number; maxGapMs: number };
      edited: {
        kind: string;
        output?: unknown;
        error?: string;
        elapsedMs: number;
        timings?: Record<string, unknown>;
      };
      isolatedBatchResults: Array<{
        kind: string;
        output?: unknown;
        timings?: Record<string, unknown>;
      }>;
      callerOwnedNums: number[];
      abortedBatch: { resolved: boolean; name: string };
      mixedTraceResults: Array<{
        kind: string;
        output?: unknown;
        trace?: { events?: unknown[] };
      }>;
      scriptTraceResults: Array<{
        kind: string;
        output?: unknown;
        trace?: { events?: unknown[] };
      }>;
      invalidMixedTraceSelection: string;
      projectCompile: {
        stdout: string;
        stderr: string;
        exitCode: number;
        files?: Array<{ path: string }>;
      };
      projectRun: {
        stdout: string;
        stderr: string;
        exitCode: number;
      } | null;
      objectCompile: {
        stdout: string;
        stderr: string;
        exitCode: number;
        files?: Array<{ path: string }>;
      };
      objectLink: {
        stdout: string;
        stderr: string;
        exitCode: number;
        files?: Array<{ path: string }>;
      } | null;
      cRun: {
        stdout: string;
        stderr: string;
        exitCode: number;
      } | null;
      workspaceCompile: {
        stdout: string;
        stderr: string;
        exitCode: number;
        files?: Array<{ path: string }>;
      };
      workspaceRun: {
        stdout: string;
        stderr: string;
        exitCode: number;
      } | null;
    };
    assertCondition(
      result.first.kind === 'completed' && result.first.output === 42,
      `TraceCC first execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.workerUrls.some((url) => url.includes('traceccRole=compiler')) &&
        result.workerUrls.some((url) => !url.includes('traceccRole=compiler')),
      `TraceCC compilation and execution must use distinct browser workers: ${JSON.stringify(result.workerUrls)}`
    );
    assertCondition(
      result.firstHeartbeat.ticks >= 2 && result.firstHeartbeat.maxGapMs <= 250,
      `TraceCC cold compilation blocked the browser main thread: ${JSON.stringify(result.firstHeartbeat)}`
    );
    assertCondition(
      result.edited.kind === 'completed' && result.edited.output === 43,
      `TraceCC edited execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedBatchResults.length === 3 &&
        result.isolatedBatchResults.every((entry) =>
          entry.kind === 'completed' &&
          entry.output === 103 &&
          entry.timings?.compileMs === 0 &&
          entry.timings?.artifactCacheHit === true
        ) &&
        result.callerOwnedNums.length === 2,
      `TraceCC code batching must retain fresh globals, heap, filesystem, module memory, and caller inputs: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.abortedBatch.resolved === false &&
        result.abortedBatch.name === 'AbortError',
      `TraceCC batch cancellation must retire the active Worker and preserve AbortError: ${JSON.stringify(result.abortedBatch)}`
    );
    assertCondition(
      result.mixedTraceResults.length === 3 &&
        result.mixedTraceResults.every(
          (entry, index) =>
            entry.kind === 'completed' && entry.output === 103 + index * 4
        ) &&
        (result.mixedTraceResults[0]?.trace?.events?.length ?? 0) > 0 &&
        result.mixedTraceResults[1]?.trace?.events?.length === 0 &&
        (result.mixedTraceResults[2]?.trace?.events?.length ?? 0) > 0 &&
        result.invalidMixedTraceSelection ===
          'C++ trace selection must contain one boolean per batch case.',
      `TraceCC mixed batch did not select recording while resetting module state per case: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.scriptTraceResults.length === 2 &&
        result.scriptTraceResults.every(
          (entry) => entry.kind === 'completed' && entry.output === 42
        ) &&
        (result.scriptTraceResults[0]?.trace?.events?.length ?? 0) > 0 &&
        result.scriptTraceResults[1]?.trace?.events?.length === 0,
      `TraceCC script batching did not honor per-case trace selection: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.projectCompile.exitCode === 0 &&
      result.projectCompile.files?.some(
        (file) => file.path === 'project-app'
      ),
      `TraceCC Project compilation failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.projectRun?.exitCode === 0 &&
      result.projectRun.stdout === '42:generic\n',
      `TraceCC Project execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.objectCompile.exitCode === 0 &&
      result.objectCompile.files?.some(
        (file) => file.path === 'build/value.o'
      ),
      `TraceCC Project object compilation failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.objectLink?.exitCode === 0 &&
      result.objectLink.files?.some(
        (file) => file.path === 'build/c-app'
      ),
      `TraceCC Project object linking failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.cRun?.exitCode === 0 &&
      result.cRun.stdout === 'c:17\n',
      `TraceCC C Project execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.workspaceCompile.exitCode === 0,
      `TraceKernel Project workspace compilation failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.workspaceRun?.exitCode === 0 &&
      result.workspaceRun.stdout === '42:project-mode\n',
      `TraceKernel Project workspace execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      requestedUrls.every((url) => !url.includes('/yowasp/')),
      `TraceCC requested a retired compiler asset: ${JSON.stringify(
        requestedUrls.filter((url) => url.includes('/yowasp/'))
      )}`
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
