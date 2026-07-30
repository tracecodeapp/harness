#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function compilerIntegrity(workersRoot: string, origin: string): Promise<{
  assets: Array<{ url: string; size: number; sha256: string }>;
}> {
  const assets = [];
  for (const file of [
    'bundle.js',
    'llvm-resources.tar',
    'llvm.core.wasm',
    'llvm.core2.wasm',
    'llvm.core3.wasm',
    'llvm.core4.wasm',
  ]) {
    const bytes = await readFile(join(workersRoot, 'cpp', 'compiler', file));
    assets.push({
      url: `${origin}/workers/cpp/compiler/${file}`,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { assets };
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-cpp-lifecycle-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 5400 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand('pnpm', ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'cpp'], root);
  await build({
    entryPoints: [join(root, 'packages', 'runtime-cpp', 'src', 'cpp-worker-client.ts')],
    outfile: join(tempRoot, 'cpp-worker-client.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(root, 'tsconfig.base.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>C++ lifecycle benchmark</title>', 'utf8');

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        self.send_header("Cache-Control", "no-cache")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const manifest = await compilerIntegrity(workersRoot, origin);
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);
    const result = await page.evaluate(`(async () => {
      const { CppWorkerClient } = await import('/cpp-worker-client.js');
      const client = new CppWorkerClient({
        workerUrl: '/workers/cpp-worker.js',
        compilerFrameUrl: '/workers/cpp-compiler-frame.html',
        compilerWorkerUrl: '/workers/cpp-compiler-worker.js',
        compilerWasmUrl: '',
        linkerWasmUrl: '',
        sysrootUrl: '',
        runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
        compilerBundleUrl: '/workers/cpp/compiler/bundle.js',
        compilerIntegrity: ${JSON.stringify(manifest)},
        executionTimeoutMs: 30000,
      });
      const execute = async (code) => {
        const startedAt = performance.now();
        const response = await client.executeCode({ code: code, functionName: 'add', inputs: { a: 2, b: 3 }, executionStyle: 'solution-method' });
        return {
          durationMs: Math.round(performance.now() - startedAt),
          success: response.kind === 'completed',
          output: response.kind === 'completed' ? response.output : undefined,
          error: response.kind === 'completed' ? undefined : response.error,
          timings: response.timings,
          compilerFrames: document.querySelectorAll('iframe').length,
        };
      };
      const cold = await execute('class Solution { public: int add(int a, int b) { return a + b; } };');
      const edited = await execute('class Solution { public: int add(int a, int b) { return a + b + 1; } };');
      const exact = await execute('class Solution { public: int add(int a, int b) { return a + b + 1; } };');
      const invalid = await execute('class Solution { public: int add(int a, int b) { return a + ; } };');
      const recovered = await execute('class Solution { public: int add(int a, int b) { return a * b; } };');
      const projectFiles = [{
        path: 'main.cpp',
        contents: '#include <iostream>\\nint main() { std::cout << "permanent-project\\\\n"; return 0; }\\n',
      }];
      const projectCompile = await client.executeProjectCpp({
        source: 'compile',
        scriptPath: 'main.cpp',
        args: ['main.cpp', '-o', 'app'],
        cwd: '/workspace',
        env: {},
        project: { files: projectFiles },
      });
      const projectRun = await client.executeProjectCpp({
        source: 'run',
        scriptPath: './app',
        args: [],
        cwd: '/workspace',
        env: {},
        project: { files: [...projectFiles, ...(projectCompile.files || [])] },
      });
      const framesBeforeTerminate = document.querySelectorAll('iframe').length;
      client.terminate();
      return {
        cold,
        edited,
        exact,
        invalid,
        recovered,
        projectCompile,
        projectRun,
        framesBeforeTerminate,
        framesAfterTerminate: document.querySelectorAll('iframe').length,
      };
    })()`) as {
      cold: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      edited: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      exact: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      invalid: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      recovered: { durationMs: number; success: boolean; output?: unknown; error?: string; timings?: Record<string, unknown> };
      projectCompile: { stdout: string; stderr: string; exitCode: number; files?: unknown[] };
      projectRun: { stdout: string; stderr: string; exitCode: number };
      framesBeforeTerminate: number;
      framesAfterTerminate: number;
    };

    assertCondition(result.cold.success && result.cold.output === 5, `cold C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.edited.success && result.edited.output === 6, `edited C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.exact.success && result.exact.output === 6, `exact C++ execution failed: ${JSON.stringify(result)}`);
    assertCondition(result.invalid.success === false, `invalid source should fail compilation: ${JSON.stringify(result)}`);
    assertCondition(
      result.recovered.success && result.recovered.output === 6,
      `compiler diagnostics must not poison the next fresh compiler instance: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.projectCompile.exitCode === 0 &&
        result.projectRun.exitCode === 0 &&
        result.projectRun.stdout === 'permanent-project\n',
      `C++ disposable project workers should retain protocol under permanent authority denial: ${JSON.stringify(result)}`
    );
    assertCondition(result.framesBeforeTerminate === 1, `one compiler frame should persist across commands: ${JSON.stringify(result)}`);
    assertCondition(result.framesAfterTerminate === 0, `terminate should remove the compiler frame: ${JSON.stringify(result)}`);
    assertCondition(
      result.exact.timings?.artifactCacheHit === true && result.exact.timings?.compileCacheHit === true,
      `exact source should hit the content-addressed artifact cache: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.edited.durationMs < result.cold.durationMs,
      `edited source should reuse warm compiler state: ${JSON.stringify(result)}`
    );
    console.log(JSON.stringify(result, null, 2));
    console.log('PASS: C++ browser compiler lifecycle keeps compile state warm and execution disposable');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

test('cpp compiler lifecycle browser', main);
