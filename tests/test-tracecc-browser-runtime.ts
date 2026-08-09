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
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const assetDirectory = process.env.TRACECC_RUNTIME_ASSET_DIR;
  if (!assetDirectory) {
    throw new Error('TRACECC_RUNTIME_ASSET_DIR is required.');
  }
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecc-browser-runtime-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5600 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;
  const traceccAssetNames = [
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
  ];
  const compilerIntegrity = {
    assets: await Promise.all(
      traceccAssetNames.map(async (name) => {
        const bytes = await readFile(join(resolve(assetDirectory), name));
        return {
          url: `${origin}/tracecc/${name}`,
          size: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      })
    ),
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
  await symlink(resolve(assetDirectory), join(tempRoot, 'tracecc'), 'dir');
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
      const first = await compileAndRun(
        'class Solution { public: int add(int a, int b) { return a + b; } };',
        { a: 20, b: 22 }
      );
      const edited = await compileAndRun(
        'class Solution { public: int add(int a, int b) { return a + b + 1; } };',
        { a: 20, b: 22 }
      );
      const mixedTraceClient = new CppWorkerClient(workerOptions);
      await mixedTraceClient.init();
      const mixedTracePreparation = await mixedTraceClient.prepareRuntimeProgram({
        mode: 'trace',
        code: [
          'class Solution {',
          'public:',
          '  int add(int a, int b) {',
          '    int sum = a + b;',
          '    return sum;',
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
        warmMs,
        first,
        edited,
        mixedTraceResults,
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
      warmMs: number;
      first: {
        kind: string;
        output?: unknown;
        error?: string;
        elapsedMs: number;
        timings?: Record<string, unknown>;
      };
      edited: {
        kind: string;
        output?: unknown;
        error?: string;
        elapsedMs: number;
        timings?: Record<string, unknown>;
      };
      mixedTraceResults: Array<{
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
      result.edited.kind === 'completed' && result.edited.output === 43,
      `TraceCC edited execution failed: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.mixedTraceResults.length === 3 &&
        result.mixedTraceResults.every(
          (entry, index) =>
            entry.kind === 'completed' && entry.output === 3 + index * 4
        ) &&
        (result.mixedTraceResults[0]?.trace?.events?.length ?? 0) > 0 &&
        result.mixedTraceResults[1]?.trace?.events?.length === 0 &&
        (result.mixedTraceResults[2]?.trace?.events?.length ?? 0) > 0 &&
        result.invalidMixedTraceSelection ===
          'C++ experimental trace selection must contain one boolean per batch case.',
      `TraceCC mixed batch did not select recording per case from one module: ${JSON.stringify(result)}`
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
      `TraceCC requested a YoWASP asset: ${JSON.stringify(
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
