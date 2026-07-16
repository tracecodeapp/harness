#!/usr/bin/env npx tsx

import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-javascript-authority-browser-'));
  const workersRoot = join(tempRoot, 'workers');

  await runCommand(
    'pnpm',
    ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'javascript'],
    root
  );
  await Promise.all([
    build({
      entryPoints: [join(root, 'packages', 'harness-browser', 'src', 'index.ts')],
      outfile: join(tempRoot, 'browser-harness.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages', 'harness-project', 'src', 'zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages', 'harness-project', 'src', 'zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      entryPoints: [join(root, 'packages', 'harness-browser', 'src', 'project.ts')],
      outfile: join(tempRoot, 'browser-project.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages', 'harness-project', 'src', 'zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages', 'harness-project', 'src', 'zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
  ]);
  await writeFile(join(tempRoot, 'index.html'), '<!doctype html><title>JavaScript authority boundary</title>', 'utf8');

  const networkHits: string[] = [];
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname.startsWith('/authority-escape/')) {
      networkHits.push(requestUrl.pathname);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const relativePath = requestUrl.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(requestUrl.pathname.replace(/^\//, ''));
    const filePath = resolve(tempRoot, relativePath);
    if (!filePath.startsWith(`${resolve(tempRoot)}/`) && filePath !== resolve(tempRoot, 'index.html')) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      const contentType = extname(filePath) === '.js'
        ? 'text/javascript'
        : extname(filePath) === '.html'
          ? 'text/html'
          : 'application/octet-stream';
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assertCondition(address && typeof address === 'object', 'Browser test server did not expose an address');
  const origin = `http://127.0.0.1:${address.port}`;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(origin);

    const exposure = await page.evaluate(async () => {
      const names = [
        'fetch',
        'webkitRequestFileSystem',
        'webkitRequestFileSystemSync',
        'webkitResolveLocalFileSystemURL',
        'webkitResolveLocalFileSystemSyncURL',
        'RTCPeerConnection',
        'webkitRTCPeerConnection',
        'RTCDataChannel',
      ];
      const source = `
        const names = ${JSON.stringify(names)};
        const exposure = {};
        for (const name of names) {
          let cursor = self;
          let owner = '';
          while (cursor && !owner) {
            if (Object.getOwnPropertyDescriptor(cursor, name)) {
              owner = cursor === self ? 'own' : (cursor.constructor && cursor.constructor.name) || 'prototype';
            }
            cursor = Object.getPrototypeOf(cursor);
          }
          exposure[name] = owner;
        }
        postMessage(exposure);
      `;
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        return await new Promise<Record<string, string>>((resolveExposure, rejectExposure) => {
          const worker = new Worker(blobUrl);
          worker.onmessage = (event) => {
            worker.terminate();
            resolveExposure(event.data);
          };
          worker.onerror = (event) => {
            worker.terminate();
            rejectExposure(new Error(event.message));
          };
        });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    });

    const classic = await page.evaluate(async ({ testOrigin }) => {
      const browserHarnessUrl = '/browser-harness.js';
      const { createBrowserHarness } = await import(browserHarnessUrl);
      const harness = createBrowserHarness({ assetBaseUrl: '/workers' });
      try {
        const client = harness.getClient('javascript');
        const control = await client.executeCode(
          'function add(a, b) { return a + b; }',
          'add',
          { a: 2, b: 3 },
          'function'
        );
        const computed = await client.executeCode(
          `function escape() {
  const key = 'con' + 'structor';
  const scope = ({})[key][key]('return self')();
  return scope.fetch(${JSON.stringify(`${testOrigin}/authority-escape/classic-computed`)});
}`,
          'escape',
          {},
          'function'
        );
        const deferred = await client.executeCode(
          `async function escapeLater() {
  const key = 'con' + 'structor';
  const scope = ({})[key][key]('return self')();
  const schedule = scope.setTimeout;
  return await new Promise((resolve, reject) => schedule(async () => {
    try {
      await scope.fetch(${JSON.stringify(`${testOrigin}/authority-escape/classic-deferred`)});
      resolve('allowed');
    } catch (error) {
      reject(error);
    }
  }, 0));
}`,
          'escapeLater',
          {},
          'function'
        );
        const typed = await harness.getClient('typescript').executeCode(
          'function multiply(a: number, b: number): number { return a * b; }',
          'multiply',
          { a: 3, b: 4 },
          'function'
        );
        const traced = await client.executeWithTracing(
          'function increment(value) { return value + 1; }',
          'increment',
          { value: 8 }
        );
        return {
          control,
          computed,
          deferred,
          typed,
          traced: {
            success: traced.success,
            output: traced.output,
            eventCount: traced.trace?.events?.length ?? 0,
          },
        };
      } finally {
        harness.dispose();
      }
    }, { testOrigin: origin });

    assertCondition(classic.control.success && classic.control.output === 5, `Classic control failed: ${JSON.stringify(classic)}`);
    assertCondition(
      classic.computed.success === false && classic.computed.error === 'fetch is not defined',
      `Classic computed Function escape was not denied: ${JSON.stringify(classic.computed)}`
    );
    assertCondition(
      classic.deferred.success === false && classic.deferred.error === 'fetch is not defined',
      `Classic deferred Function escape was not denied: ${JSON.stringify(classic.deferred)}`
    );
    assertCondition(classic.typed.success && classic.typed.output === 12, `TypeScript control failed: ${JSON.stringify(classic.typed)}`);
    assertCondition(
      classic.traced.success && classic.traced.output === 9 && classic.traced.eventCount > 0,
      `Classic tracing control failed: ${JSON.stringify(classic.traced)}`
    );

    const projectJournal = await page.evaluate(async () => {
      const { createBrowserProjectWorkspace } = await import('/browser-project.js');
      const workspace = await createBrowserProjectWorkspace({
        assetBaseUrl: '/workers',
        files: [{ path: 'seed.txt', contents: 'seed\n' }],
        nodeProjectTimeoutMs: 20_000,
      });
      const records = [];
      const unsubscribe = workspace.watch((event) => {
        if (event.type === 'kernel-journal') records.push(event.record);
      });
      const client = workspace.kernel.createProcess({
        name: 'client',
        actor: { kind: 'runtime', id: 'learner' },
        signalPolicy: 'system-only',
      });
      const tracebot = workspace.kernel.createProcess({
        name: 'tracebot',
        actor: { kind: 'runtime', id: 'tracebot' },
        signalPolicy: 'system-only',
      });
      try {
        const result = await client.runCommand(
          'node -e "const fs=require(\\\"node:fs\\\");fs.writeFileSync(\\\"node-edit.txt\\\",\\\"changed\\\\n\\\")"'
        );
        const tracebotResult = await tracebot.runCommand(
          'node -e "const fs=require(\\\"node:fs\\\");fs.writeFileSync(\\\"tracebot-edit.txt\\\",\\\"changed\\\\n\\\")"'
        );
        return { result, tracebotResult, records };
      } finally {
        tracebot.dispose();
        client.dispose();
        unsubscribe();
        workspace.dispose();
      }
    });
    assertCondition(
      projectJournal.result.exitCode === 0,
      `Browser Node write failed: ${JSON.stringify(projectJournal)}`
    );
    assertCondition(
      projectJournal.records.some((record) => (
        record.kind === 'fs' &&
        record.op === 'write' &&
        record.path === 'node-edit.txt' &&
        record.actor === 'runtime:learner' &&
        typeof record.pid === 'number'
      )),
      `Browser Node write lost kernel journal process attribution: ${JSON.stringify(projectJournal.records)}`
    );
    assertCondition(
      projectJournal.tracebotResult.exitCode === 0,
      `Browser TraceBot Node write failed: ${JSON.stringify(projectJournal)}`
    );
    assertCondition(
      projectJournal.records.some((record) => (
        record.kind === 'fs' &&
        record.op === 'write' &&
        record.path === 'tracebot-edit.txt' &&
        record.actor === 'runtime:tracebot' &&
        typeof record.pid === 'number'
      )),
      `Browser TraceBot write lost kernel journal process attribution: ${JSON.stringify(projectJournal.records)}`
    );

    const project = await page.evaluate(async ({ testOrigin, exposed }) => {
      const browserProjectUrl = '/browser-project.js';
      const { createBrowserProjectWorkspace } = await import(browserProjectUrl);
      const probeNames = [
        'webkitRequestFileSystem',
        'webkitRequestFileSystemSync',
        'webkitResolveLocalFileSystemURL',
        'webkitResolveLocalFileSystemSyncURL',
        'RTCPeerConnection',
        'webkitRTCPeerConnection',
        'RTCDataChannel',
      ].filter((name) => Boolean(exposed[name]));
      const code = `
(async () => {
  const outcomes = {};
  const descriptor = (name) => {
    let cursor = Object.getPrototypeOf(globalThis);
    while (cursor) {
      const found = Object.getOwnPropertyDescriptor(cursor, name);
      if (found) return found;
      cursor = Object.getPrototypeOf(cursor);
    }
    return null;
  };
  const safe = await fetch('http://localhost:3999/control');
  outcomes.safeFetch = safe.status + ':' + await safe.text();
  const key = 'con' + 'structor';
  try { ({})[key][key]('return self')(); outcomes.computed = 'allowed'; }
  catch (error) { outcomes.computed = error.code || error.name; }
  try {
    await descriptor('fetch').value.call(globalThis, ${JSON.stringify(`${testOrigin}/authority-escape/project-descriptor`)});
    outcomes.descriptorFetch = 'allowed';
  } catch (error) { outcomes.descriptorFetch = error.code || error.name; }
  outcomes.deferredFetch = await new Promise((resolve) => setTimeout(async () => {
    try {
      await descriptor('fetch').value.call(globalThis, ${JSON.stringify(`${testOrigin}/authority-escape/project-deferred`)});
      resolve('allowed');
    } catch (error) { resolve(error.code || error.name); }
  }, 0));
  for (const name of ${JSON.stringify(probeNames)}) {
    try {
      const target = descriptor(name);
      if (!target) { outcomes[name] = 'missing'; continue; }
      if (name === 'webkitRequestFileSystemSync') target.value.call(globalThis, globalThis.TEMPORARY || 0, 1024);
      else if (name.startsWith('webkitRequestFileSystem')) target.value.call(globalThis, globalThis.TEMPORARY || 0, 1024, () => {}, () => {});
      else if (name.startsWith('webkitResolve')) target.value.call(globalThis, 'filesystem:${testOrigin}/temporary/x', () => {}, () => {});
      else new target.value();
      outcomes[name] = 'allowed';
    } catch (error) { outcomes[name] = error.code || error.name; }
  }
  console.log(JSON.stringify(outcomes));
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
`;
      const workspace = await createBrowserProjectWorkspace({
        assetBaseUrl: '/workers',
        files: [{ path: 'authority.js', contents: code }],
        nodeProjectTimeoutMs: 20_000,
      });
      const listener = workspace.http.listen({ host: '127.0.0.1', port: 3999 }, () => ({
        status: 207,
        body: 'kernel-ok',
      }));
      try {
        const result = await workspace.runCommand('node authority.js');
        return { result, probeNames };
      } finally {
        listener.close();
        workspace.dispose();
      }
    }, { testOrigin: origin, exposed: exposure });

    assertCondition(project.result.exitCode === 0, `Project authority command failed: ${JSON.stringify(project.result)}`);
    const outputLine = project.result.stdout.trim().split('\n').at(-1) ?? '';
    const outcomes = JSON.parse(outputLine) as Record<string, string>;
    assertCondition(outcomes.safeFetch === '207:kernel-ok', `TraceKernel fetch control failed: ${JSON.stringify(outcomes)}`);
    assertCondition(outcomes.computed === 'ReferenceError', `Project computed constructor escape was not denied: ${JSON.stringify(outcomes)}`);
    assertCondition(outcomes.descriptorFetch === 'ReferenceError', `Project prototype fetch escape was not denied: ${JSON.stringify(outcomes)}`);
    assertCondition(outcomes.deferredFetch === 'ReferenceError', `Project deferred fetch regained authority: ${JSON.stringify(outcomes)}`);
    for (const name of project.probeNames) {
      assertCondition(
        outcomes[name] === 'ReferenceError' || outcomes[name] === 'missing',
        `Project exposed ${name} authority was neither denied nor absent from the user facade: ${JSON.stringify(outcomes)}`
      );
    }
    assertCondition(networkHits.length === 0, `Native browser authority reached the server: ${networkHits.join(', ')}`);
    console.log(JSON.stringify({ exposure, classic, project: { outcomes, probeNames: project.probeNames } }, null, 2));
    console.log('PASS: public Classic and project browser paths deny ambient authority in real Chromium');
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
