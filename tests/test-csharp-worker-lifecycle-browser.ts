#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();

interface ExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  timings?: {
    compileCacheHit?: boolean;
    hostArtifactCacheHit?: boolean;
    compileMs?: number;
    compileCacheEntries?: number;
    compileCacheBytes?: number;
    compileArtifactBytes?: number;
    executionRealm?: string;
    totalMs?: number;
  };
}

interface ProjectExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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
  assertCondition(
    existsSync(join(ROOT, 'workers', 'vendor', 'csharp', '_framework', 'dotnet.js')),
    'Expected the vendored C# runtime; run pnpm update:csharp-runtime first.'
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
  assertCondition(address && typeof address !== 'string', 'Expected a TCP server address.');
  const origin = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const metrics = await page.evaluate(async ({ origin }) => {
      const assetBaseUrl = `${origin}/workers/vendor/csharp`;
      const compilerArtifacts = new Map<string, string>();

      async function createWorkerHarness() {
        const worker = new Worker('/workers/csharp/csharp-worker.js', { type: 'module' });
        let nextId = 0;
        const pending = new Map<string, {
          resolve(value: unknown): void;
          reject(error: Error): void;
          protocolToken: string;
        }>();
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'compiler-artifact-cache-request') {
            const request = event.data?.payload ?? {};
            if (request.operation === 'put' && typeof request.key === 'string' && typeof request.value === 'string') {
              compilerArtifacts.set(request.key, request.value);
            }
            const value = request.operation === 'get' && typeof request.key === 'string'
              ? compilerArtifacts.get(request.key)
              : undefined;
            worker.postMessage({
              type: 'compiler-artifact-cache-response',
              requestId: event.data.requestId,
              protocolToken: event.data.protocolToken,
              payload: {
                hit: value !== undefined,
                ...(value === undefined ? {} : { value }),
                stored: request.operation === 'put' && compilerArtifacts.has(request.key),
              },
            });
            return;
          }
          const id = event.data?.id;
          if (!id) return;
          const request = pending.get(id);
          if (!request || event.data?.protocolToken !== request.protocolToken) return;
          if (event.data?.type === 'project-event') return;
          pending.delete(id);
          if (event.data?.type === 'error') {
            request.reject(new Error(event.data?.payload?.error ?? 'C# worker error'));
          } else {
            request.resolve(event.data?.payload);
          }
        });
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || 'C# worker failed');
          for (const request of pending.values()) request.reject(error);
          pending.clear();
        });
        function send<T = ExecuteResult>(type: string, payload: unknown): Promise<T> {
          const id = String(++nextId);
          const protocolToken = `csharp-lifecycle-${id}-${crypto.randomUUID()}`;
          return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve, reject, protocolToken });
            worker.postMessage({ id, type, payload, protocolToken });
          });
        }
        function terminate(reason = new Error('C# test worker terminated')): void {
          worker.terminate();
          for (const request of pending.values()) request.reject(reason);
          pending.clear();
        }
        await send('init', { assetBaseUrl });
        return { send, terminate };
      }

      const source = [
        'public class Solution {',
        '  private static int seen;',
        '  public int Touch(int value) {',
        '    seen += 1;',
        '    return seen * 100 + value;',
        '  }',
        '}',
      ].join('\n');
      const editedSource = source.replace('seen * 100 + value', 'seen * 1000 + value');
      const request = (code: string, value: number) => ({
        code,
        functionName: 'Touch',
        inputs: { value },
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const firstWorker = await createWorkerHarness();
      const cold = await firstWorker.send('execute-code', request(source, 7));
      const warm = await firstWorker.send('execute-code', request(source, 9));
      const edited = await firstWorker.send('execute-code', request(editedSource, 3));
      const hang = firstWorker.send('execute-code', {
        code: 'public class Solution { public int Hang() { while (true) { } } }',
        functionName: 'Hang',
        inputs: {},
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 60_000,
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          firstWorker.terminate(new Error('simulated client timeout'));
          resolve();
        }, 750);
      });
      await hang.catch(() => undefined);

      const replacementWorker = await createWorkerHarness();
      const afterTimeout = await replacementWorker.send('execute-code', request(source, 11));
      replacementWorker.terminate();
      const projectWorker = await createWorkerHarness();
      const procDirectory = await projectWorker.send<ProjectExecuteResult>('execute-project-csharp', {
        source: 'run',
        scriptPath: '<project>',
        args: [],
        cwd: '/workspace/src',
        env: {},
        assetBaseUrl,
        projectUserAuthorityMode: 'permanent',
        project: {
          kernelFiles: [
            { path: '/proc/kernel/info', contents: 'info-body\n' },
            { path: '/proc/kernel/version', contents: 'version-body\n' },
          ],
          files: [{
            path: 'src/Program.cs',
            contents: [
              'var paths = Directory.GetFiles("/proc/kernel");',
              'Array.Sort(paths, StringComparer.Ordinal);',
              'Console.WriteLine(string.Join(",", Array.ConvertAll(paths, Path.GetFileName)));',
              'foreach (var path in paths) {',
              '  Console.WriteLine(Path.GetFileName(path) + "=" + File.ReadAllText(path).Trim());',
              '}',
              '',
            ].join('\n'),
          }],
        },
      });
      projectWorker.terminate();
      return { cold, warm, edited, procDirectory, afterTimeout };
    }, { origin }) as {
      cold: ExecuteResult;
      warm: ExecuteResult;
      edited: ExecuteResult;
      procDirectory: ProjectExecuteResult;
      afterTimeout: ExecuteResult;
    };

    assertCondition(metrics.cold.success && metrics.cold.output === 107, `Cold C# run failed: ${JSON.stringify(metrics.cold)}`);
    assertCondition(metrics.cold.timings?.compileCacheHit === false, 'Cold C# run should miss the compiled artifact cache.');
    assertCondition(metrics.warm.success && metrics.warm.output === 109, `Warm C# run leaked static state: ${JSON.stringify(metrics.warm)}`);
    assertCondition(metrics.warm.timings?.compileCacheHit === true, 'Same-shape C# run should reuse the compiled PE.');
    assertCondition(
      metrics.warm.timings?.executionRealm === 'collectible-assembly-load-context',
      `Warm C# run should report a disposable execution realm: ${JSON.stringify(metrics.warm.timings)}`
    );
    assertCondition(metrics.edited.success && metrics.edited.output === 1003, `Edited C# run failed: ${JSON.stringify(metrics.edited)}`);
    assertCondition(metrics.edited.timings?.compileCacheHit === false, 'Edited C# source must miss the compiled artifact cache.');
    assertCondition(
      metrics.procDirectory.exitCode === 0 &&
        metrics.procDirectory.stdout === 'info,version\ninfo=info-body\nversion=version-body\n',
      `C# project Directory.GetFiles(/proc/kernel) should enumerate readable virtual files: ${JSON.stringify(metrics.procDirectory)}`
    );
    assertCondition(
      metrics.afterTimeout.success && metrics.afterTimeout.output === 111,
      `Replacement C# worker should execute in a clean realm: ${JSON.stringify(metrics.afterTimeout)}`
    );
    assertCondition(
      metrics.afterTimeout.timings?.compileCacheHit === true &&
        metrics.afterTimeout.timings?.hostArtifactCacheHit === true,
      'Replacement C# worker should restore immutable compiler output from the host cache.'
    );

    console.log(JSON.stringify({
      coldCompileMs: metrics.cold.timings?.compileMs,
      coldTotalMs: metrics.cold.timings?.totalMs,
      warmCompileMs: metrics.warm.timings?.compileMs,
      warmTotalMs: metrics.warm.timings?.totalMs,
      editedCompileMs: metrics.edited.timings?.compileMs,
      editedTotalMs: metrics.edited.timings?.totalMs,
      replacementCompileMs: metrics.afterTimeout.timings?.compileMs,
      replacementTotalMs: metrics.afterTimeout.timings?.totalMs,
      cacheEntries: metrics.edited.timings?.compileCacheEntries,
      cacheBytes: metrics.edited.timings?.compileCacheBytes,
      artifactBytes: metrics.warm.timings?.compileArtifactBytes,
    }));
    console.log('PASS: C# browser compiler lifecycle isolates execution and project /proc directories remain enumerable');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('csharp worker lifecycle browser', main);
