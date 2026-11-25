#!/usr/bin/env npx tsx

// The stack-frame cases, in Chromium, through the generated JavaScript project
// worker (workers/javascript/javascript-project-worker.js) and the TypeScript
// compiler asset. The expected output is the same as the Node-side test's,
// which checks it against real Node. TRACECODE_STACK_FRAME_ENGINES selects
// engines (default chromium; also firefox, webkit).
//
// Chromium must print the expected bytes. Firefox and WebKit format stacks
// their own way (`name@file:line:column`, no `Error: message` header, their
// own column convention), so for them the check is the line numbers: every
// workspace file:line they print must be one Node prints for the case, and
// Firefox must print at least one. WebKit gives eval'd code no location, so
// for it only the absence of a wrong line can be checked. Exit codes must
// match in every engine; `textMatches` is reported, not required.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import {
  STACK_FRAME_WORKSPACE_ROOT,
  stackFrameCases,
  type StackFrameCase,
} from './helpers/javascript-project-stack-frame-cases';

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

async function syncAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      'javascript,typescript',
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function startStaticServer(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve test server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

const ESCAPED_ROOT = STACK_FRAME_WORKSPACE_ROOT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LOCATION_SOURCE = String.raw`((?:file://)?${ESCAPED_ROOT}/[^\s:()@]+):(\d+):\d+`;

function fileLines(text: string): string[] {
  return [...text.matchAll(new RegExp(LOCATION_SOURCE, 'g'))].map((match) => `${match[1]}:${match[2]}`);
}

// When no frame can be attributed, the runner prints one `at <entry>:1:1`.
const PLACEHOLDER_FRAME = new RegExp(`^    at ${LOCATION_SOURCE}$`);

/** Every workspace file:line an engine prints is one Node prints for the case. */
function workspaceLinesMatch(
  testCase: StackFrameCase,
  result: { stdout: string; stderr: string }
): { located: number; placeholders: number; mismatched: string[]; textMatches: boolean } {
  const allowed = new Set(fileLines(`${testCase.expected.stdout}\n${testCase.expected.stderr}`));
  let placeholders = 0;
  const located: string[] = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
    const placeholder = PLACEHOLDER_FRAME.exec(line);
    if (placeholder && placeholder[2] === '1' && line.endsWith(':1:1')) {
      placeholders += 1;
      continue;
    }
    located.push(...fileLines(line));
  }
  // Non-frame output (messages, ordinary console text) is engine-independent.
  const text = (value: string) => value
    .split('\n')
    .filter((line) => line && !/^\s*at /.test(line) && !new RegExp(LOCATION_SOURCE).test(line) && !line.includes('@'));
  const textMatches = (['stdout', 'stderr'] as const).every((stream) =>
    JSON.stringify(text(result[stream])) === JSON.stringify(text(testCase.expected[stream])));
  return { located: located.length, placeholders, mismatched: located.filter((entry) => !allowed.has(entry)), textMatches };
}

function selectedEngines(): string[] {
  const raw = process.env.TRACECODE_STACK_FRAME_ENGINES?.trim();
  const engines = raw ? raw.split(',').map((engine) => engine.trim()).filter(Boolean) : ['chromium'];
  for (const engine of engines) {
    if (!(engine in ENGINES)) throw new Error(`TRACECODE_STACK_FRAME_ENGINES has unknown engine ${JSON.stringify(engine)}.`);
  }
  return engines;
}

async function main(): Promise<void> {
  const engines = selectedEngines();
  const tempRoot = await mkdtemp(join(tmpdir(), 'javascript-stack-frames-browser-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('packages/runtime-browser/src/project.ts')],
      outfile: join(tempRoot, 'project-harness.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      logLevel: 'warning',
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startStaticServer(tempRoot);

    const failures: string[] = [];
    for (const engine of engines) {
      const browser = await ENGINES[engine]!.launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(120_000);
        await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
        await page.evaluate('globalThis.__name = (fn) => fn');
        const results = await page.evaluate(async ({ cases, root }) => {
          // @ts-expect-error This module is generated into the browser test server.
          const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
          const outputs: Array<{ name: string; setup: unknown[]; result: unknown }> = [];
          for (const testCase of cases) {
            const workspace = await createBrowserProjectWorkspace({
              assetBaseUrl: '/workers',
              providers: ['javascript', 'typescript'],
              nodeProjectTimeoutMs: 60_000,
              kernel: { workspace: { root } },
              files: Object.entries(testCase.files).map(([path, contents]) => ({ path, contents })),
            });
            try {
              const setup: unknown[] = [];
              for (const command of testCase.setup ?? []) {
                const step = await workspace.runCommand(command);
                setup.push({ command, exitCode: step.exitCode, stdout: step.stdout, stderr: step.stderr });
              }
              const result = await workspace.runCommand(testCase.command);
              outputs.push({
                name: testCase.name,
                setup,
                result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
              });
            } finally {
              workspace.dispose();
            }
          }
          return outputs;
        }, { cases: stackFrameCases, root: STACK_FRAME_WORKSPACE_ROOT });

        for (const testCase of stackFrameCases) {
          const output = results.find((entry) => entry.name === testCase.name);
          const result = output?.result as { exitCode: number; stdout: string; stderr: string } | undefined;
          const setupFailed = (output?.setup ?? []).some((step) => (step as { exitCode: number }).exitCode !== 0);
          const lineCheck = engine === 'chromium' || !result ? null : workspaceLinesMatch(testCase, result);
          const expectsLocation = fileLines(`${testCase.expected.stdout}\n${testCase.expected.stderr}`).length > 0;
          const ok = Boolean(result) && !setupFailed && result!.exitCode === testCase.expected.exitCode && (
            lineCheck
              ? lineCheck.mismatched.length === 0 && (engine !== 'firefox' || !expectsLocation || lineCheck.located > 0)
              : result!.stdout === testCase.expected.stdout && result!.stderr === testCase.expected.stderr
          );
          if (ok) {
            console.log(`ok - ${engine}: ${testCase.name}${lineCheck ? ` (${lineCheck.located} workspace locations, lines match Node; ${lineCheck.placeholders} placeholder; textMatches=${lineCheck.textMatches})` : ''}`);
          } else {
            failures.push(`${engine}: ${testCase.name}`);
            console.log(`not ok - ${engine}: ${testCase.name}`);
            console.log(`printed ${JSON.stringify(output, null, 2)}\nexpected ${JSON.stringify(testCase.expected, null, 2)}`);
            if (lineCheck) console.log(`line check ${JSON.stringify(lineCheck)}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
    const total = stackFrameCases.length * engines.length;
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${total} browser stack-frame cases failed: ${failures.join('; ')}`);
    }
    console.log(`${total} browser stack-frame cases match Node (${engines.join(', ')})`);
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
