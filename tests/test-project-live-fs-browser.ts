#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

function isBrowserEngine(value: string): value is BrowserEngine {
  return value === 'chromium' || value === 'firefox' || value === 'webkit';
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function selectedEngines(): BrowserEngine[] {
  const configured = process.env.TRACECODE_PROJECT_LIVE_FS_ENGINES?.trim();
  const configuredEngines = configured
    ? configured.split(',').map((engine) => engine.trim()).filter(Boolean)
    : ['chromium'];
  for (const engine of configuredEngines) {
    if (!isBrowserEngine(engine)) throw new Error(`Unsupported browser engine: ${engine}`);
  }
  return [...new Set(configuredEngines.filter(isBrowserEngine))];
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.jar': return 'application/java-archive';
    default: return 'application/octet-stream';
  }
}

async function syncAssets(targetDirectory: string): Promise<void> {
  const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
  const cli = resolve('src/cli.ts');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      tsxCli,
      cli,
      'sync-assets',
      targetDirectory,
      '--languages',
      'python,javascript',
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
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    const stat = statSync(filePath);
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Length': String(stat.size),
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
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-project-live-fs-'));
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
        zlib: resolve('packages/workspace-facade/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/workspace-facade/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startStaticServer(resolve(tempRoot));

    const browserTypes: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit };
    for (const engine of selectedEngines()) {
      const browser = await browserTypes[engine].launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(60_000);
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            console.error(`[${engine} ${message.type()}] ${message.text()}`);
          }
        });
        await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
        await page.evaluate('globalThis.__name = (fn) => fn');
        const result = await page.evaluate(async () => {
          const harnessModuleUrl: string = '/project-harness.mjs';
          const { createBrowserProjectWorkspace } = await import(harnessModuleUrl);
          const workspace = await createBrowserProjectWorkspace({
            assetBaseUrl: '/workers',
            providers: ['python', 'javascript'],
            projectWorkerIsolation: 'per-command',
            pythonProjectTimeoutMs: 30_000,
            nodeProjectTimeoutMs: 30_000,
            files: [
              {
                path: 'held.py',
                contents: [
                  'import os',
                  'import time',
                  'print("held:started", flush=True)',
                  'deadline = time.time() + 10',
                  'while not os.path.exists("shared.txt") and time.time() < deadline:',
                  '    time.sleep(0.05)',
                  'print("held:" + ("visible" if os.path.exists("shared.txt") else "missing"), flush=True)',
                  '',
                ].join('\n'),
              },
              {
                path: 'writer.js',
                contents: 'require("node:fs").writeFileSync("shared.txt", "written-by-javascript\\n");\n',
              },
              {
                path: 'python-writer.py',
                contents: 'open("python-output.txt", "w", encoding="utf-8").write("python\\n")\n',
              },
              {
                path: 'javascript-writer.js',
                contents: 'require("node:fs").writeFileSync("javascript-output.txt", "javascript\\n");\n',
              },
              {
                path: 'python-conflict.py',
                contents: 'open("conflict.txt", "w", encoding="utf-8").write("python\\n")\n',
              },
              {
                path: 'javascript-conflict.js',
                contents: 'require("node:fs").writeFileSync("conflict.txt", "javascript\\n");\n',
              },
            ],
          });
          try {
            let markHeldStarted!: () => void;
            const heldStarted = new Promise<void>((resolvePromise) => {
              markHeldStarted = resolvePromise;
            });
            const held = workspace.runCommand('python3 held.py', {
              onEvent(event: { type: string; stream?: string; data?: string }) {
                if (event.type === 'output' && event.stream === 'stdout' && event.data?.includes('held:started')) {
                  markHeldStarted();
                }
              },
            });
            await Promise.race([
              heldStarted,
              held.then((command: unknown) => {
                throw new Error(`held Python command exited before startup: ${JSON.stringify(command)}`);
              }),
              new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('held Python command did not start')), 20_000)),
            ]);
            const javascriptWriter = await workspace.runCommand('node writer.js');
            const authoritativeContents = await workspace.readFile('shared.txt');
            const heldResult = await held;
            const laterPython = await workspace.runCommand(
              'python3 -c "print(open(\'shared.txt\', encoding=\'utf-8\').read(), end=\'\')"'
            );

            const [parallelPython, parallelJavaScript] = await Promise.all([
              workspace.runCommand('python3 python-writer.py'),
              workspace.runCommand('node javascript-writer.js'),
            ]);
            const conflictingWrites = await Promise.all([
              workspace.runCommand('python3 python-conflict.py'),
              workspace.runCommand('node javascript-conflict.js'),
            ]);
            return {
              javascriptWriter,
              authoritativeContents,
              heldResult,
              laterPython,
              parallelPython,
              parallelJavaScript,
              pythonOutput: await workspace.readFile('python-output.txt'),
              javascriptOutput: await workspace.readFile('javascript-output.txt'),
              conflictingWrites,
              conflictOutput: await workspace.readFile('conflict.txt'),
            };
          } finally {
            workspace.dispose();
          }
        });

        assertCondition(
          result.javascriptWriter.exitCode === 0 && result.authoritativeContents === 'written-by-javascript\n',
          `${engine}: JavaScript live write should reach the authoritative workspace: ${JSON.stringify(result)}`
        );
        assertCondition(
          result.heldResult.exitCode === 0 && result.heldResult.stdout.includes('held:visible'),
          `${engine}: an already-running Python process should observe JavaScript's authoritative TKFS write: ${JSON.stringify(result)}`
        );
        assertCondition(
          result.laterPython.exitCode === 0 && result.laterPython.stdout === 'written-by-javascript\n',
          `${engine}: a later Python process should see JavaScript's committed write: ${JSON.stringify(result)}`
        );
        assertCondition(
          result.parallelPython.exitCode === 0 &&
            result.parallelJavaScript.exitCode === 0 &&
            result.pythonOutput === 'python\n' &&
            result.javascriptOutput === 'javascript\n',
          `${engine}: parallel providers should preserve independent live writes: ${JSON.stringify(result)}`
        );
        assertCondition(
          result.conflictingWrites.every((command) => command.exitCode === 0) &&
            (result.conflictOutput === 'python\n' || result.conflictOutput === 'javascript\n'),
          `${engine}: parallel providers writing one path should commit atomically with one complete final value: ${JSON.stringify(result)}`
        );
        console.log(`PASS: ${engine} project live filesystem cross-provider contract`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
