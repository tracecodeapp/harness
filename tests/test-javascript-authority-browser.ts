#!/usr/bin/env npx tsx

import { test } from 'node:test';
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
      entryPoints: [
        join(
          root,
          'tests',
          'fixtures',
          'javascript-judge-authority-browser-entry.ts'
        ),
      ],
      outfile: join(tempRoot, 'browser-judge.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages', 'tracekernel', 'src', 'zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages', 'tracekernel', 'src', 'zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      entryPoints: [join(root, 'packages', 'runtime-browser', 'src', 'project.ts')],
      outfile: join(tempRoot, 'browser-project.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(root, 'tsconfig.base.json'),
      alias: {
        zlib: join(root, 'packages', 'tracekernel', 'src', 'zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages', 'tracekernel', 'src', 'zlib-browser-shim.ts'),
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
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
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

    const judged = await page.evaluate(async ({ testOrigin }) => {
      // @ts-expect-error This module is built and served by the browser fixture.
      const { evaluateBrowserRuntime } = await import('/browser-judge.js');
      const preparedResults: Record<string, any> = {};
      const preparedTraceResults: Record<string, any> = {};
      for (const language of ['javascript', 'typescript'] as const) {
        const code =
          language === 'typescript'
            ? `let count = 0;
function isolated(value: number): Array<number | null> {
  count += 1;
  (globalThis as any).__preparedBrowserCount =
    ((globalThis as any).__preparedBrowserCount ?? 0) + 1;
  const intrinsic = (Array.prototype as any).__preparedBrowserIntrinsic ?? null;
  (Array.prototype as any).__preparedBrowserIntrinsic = value;
  return [value, count, (globalThis as any).__preparedBrowserCount, intrinsic];
}`
            : `let count = 0;
function isolated(value) {
  count += 1;
  globalThis.__preparedBrowserCount =
    (globalThis.__preparedBrowserCount ?? 0) + 1;
  const intrinsic = Array.prototype.__preparedBrowserIntrinsic ?? null;
  Array.prototype.__preparedBrowserIntrinsic = value;
  return [value, count, globalThis.__preparedBrowserCount, intrinsic];
}`;
        preparedResults[language] = (await evaluateBrowserRuntime({
          language,
          code,
          functionName: 'isolated',
          inputs: [{ value: 3 }, { value: 7 }],
        })).cases;
        preparedTraceResults[language] = (await evaluateBrowserRuntime({
          language,
          code,
          functionName: 'isolated',
          inputs: [{ value: 11 }, { value: 13 }],
          trace: true,
        })).cases;
      }
      const timeoutIsolation = (await evaluateBrowserRuntime({
        language: 'javascript',
        code: `async function maybeWait(wait) {
  if (wait) await new Promise(() => {});
  return 42;
}`,
        functionName: 'maybeWait',
        inputs: [{ wait: true }, { wait: false }],
        limits: { wallClockMs: 50 },
      })).cases;
      const [control] = (await evaluateBrowserRuntime({
        language: 'javascript',
        code: 'function add(a, b) { return a + b; }',
        functionName: 'add',
        inputs: [{ a: 2, b: 3 }],
      })).cases;
      const [computed] = (await evaluateBrowserRuntime({
        language: 'javascript',
        code: `function escape() {
  const key = 'con' + 'structor';
  const scope = ({})[key][key]('return self')();
  return scope.fetch(${JSON.stringify(`${testOrigin}/authority-escape/classic-computed`)});
}`,
        functionName: 'escape',
        inputs: [{}],
      })).cases;
      const [deferred] = (await evaluateBrowserRuntime({
        language: 'javascript',
        code: `async function escapeLater() {
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
        functionName: 'escapeLater',
        inputs: [{}],
      })).cases;
      const [typed] = (await evaluateBrowserRuntime({
        language: 'typescript',
        code:
          'function multiply(a: number, b: number): number { return a * b; }',
        functionName: 'multiply',
        inputs: [{ a: 3, b: 4 }],
      })).cases;
      const [traced] = (await evaluateBrowserRuntime({
        language: 'javascript',
        code: 'function increment(value) { return value + 1; }',
        functionName: 'increment',
        inputs: [{ value: 8 }],
        trace: true,
      })).cases;
      return {
        control,
        computed,
        deferred,
        typed,
        traced,
        preparedJavaScript: preparedResults.javascript,
        preparedTypeScript: preparedResults.typescript,
        preparedTraceJavaScript: preparedTraceResults.javascript,
        preparedTraceTypeScript: preparedTraceResults.typescript,
        timeoutIsolation,
      };
    }, { testOrigin: origin });

    assertCondition(
      judged.control.status === 'completed' && judged.control.value === 5,
      `Browser Judge control failed: ${JSON.stringify(judged)}`
    );
    assertCondition(
      judged.computed.status === 'runtime-error' &&
        judged.computed.diagnostics.some(
          (diagnostic: { message?: string }) =>
            /fetch is not defined|not a valid constructor/u.test(
              diagnostic.message ?? ''
            )
        ),
      `Browser Judge computed Function escape was not denied: ${JSON.stringify(judged.computed)}`
    );
    assertCondition(
      judged.deferred.status === 'runtime-error' &&
        judged.deferred.diagnostics.some(
          (diagnostic: { message?: string }) =>
            /fetch is not defined|not a valid constructor/u.test(
              diagnostic.message ?? ''
            )
        ),
      `Browser Judge deferred Function escape was not denied: ${JSON.stringify(judged.deferred)}`
    );
    assertCondition(
      judged.typed.status === 'completed' && judged.typed.value === 12,
      `Browser Judge TypeScript control failed: ${JSON.stringify(judged.typed)}`
    );
    assertCondition(
      judged.traced.status === 'completed' &&
        judged.traced.value === 9 &&
        judged.traced.trace?.events?.length > 0,
      `Browser Judge tracing control failed: ${JSON.stringify(judged.traced)}`
    );
    for (const [language, result] of [
      ['javascript', judged.preparedJavaScript],
      ['typescript', judged.preparedTypeScript],
    ] as const) {
      assertCondition(
        result?.[0]?.status === 'completed' &&
          JSON.stringify(result[0].value) === JSON.stringify([3, 1, 1, null]) &&
          result[0].timings?.artifactCacheHit === true &&
          result?.[1]?.status === 'completed' &&
          JSON.stringify(result[1].value) === JSON.stringify([7, 1, 1, null]) &&
          result[1].timings?.artifactCacheHit === true,
        `Browser ${language} prepared isolation failed: ${JSON.stringify(result)}`
      );
    }
    for (const [language, result] of [
      ['javascript', judged.preparedTraceJavaScript],
      ['typescript', judged.preparedTraceTypeScript],
    ] as const) {
      assertCondition(
        result?.[0]?.status === 'completed' &&
          JSON.stringify(result[0].value) ===
            JSON.stringify([11, 1, 1, null]) &&
          result[0].trace?.events?.length > 0 &&
          result?.[1]?.status === 'completed' &&
          JSON.stringify(result[1].value) ===
            JSON.stringify([13, 1, 1, null]) &&
          result[1].trace?.events?.length > 0,
        `Browser ${language} prepared trace isolation failed: ${JSON.stringify(result)}`
      );
    }
    assertCondition(
      judged.timeoutIsolation?.[0]?.status === 'timed-out' &&
        judged.timeoutIsolation?.[1]?.status === 'completed' &&
        judged.timeoutIsolation?.[1]?.value === 42,
      `Browser Judge must apply timeouts independently per case: ${JSON.stringify(judged.timeoutIsolation)}`
    );

    const projectJournal = await page.evaluate(async () => {
      const browserProjectModulePath = '/browser-project.js';
      const { createBrowserProjectWorkspace } = await import(browserProjectModulePath);
      const workspace = await createBrowserProjectWorkspace({
        assetBaseUrl: '/workers',
        providers: ['javascript'],
        files: [{ path: 'seed.txt', contents: 'seed\n' }],
        nodeProjectTimeoutMs: 20_000,
      });
      type JournalRecordView = { kind?: string; op?: string; path?: string; actor?: string; pid?: unknown };
      const records: JournalRecordView[] = [];
      const unsubscribe = workspace.watch((event: { type?: string; record?: JournalRecordView }) => {
        if (event.type === 'kernel-journal' && event.record) records.push(event.record);
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

    const detachedPromise = await page.evaluate(async () => {
      // @ts-expect-error This module is built and served by the browser test fixture.
      const { createBrowserProjectWorkspace } = await import('/browser-project.js');
      const code = [
        'let work = Promise.resolve();',
        'for (let index = 0; index < 12; index += 1) {',
        '  work = work.then(() => Promise.resolve());',
        '}',
        'work.then(() => console.log("detached promise completed"));',
        '',
      ].join('\n');
      const workspace = await createBrowserProjectWorkspace({
        assetBaseUrl: '/workers',
        providers: ['javascript'],
        files: [{ path: 'detached-promise.js', contents: code }],
        nodeProjectTimeoutMs: 20_000,
      });
      try {
        return await workspace.runCommand('node detached-promise.js');
      } finally {
        workspace.dispose();
      }
    });
    assertCondition(
      detachedPromise.exitCode === 0 && detachedPromise.stdout === 'detached promise completed\n',
      `Browser Node should drain detached promise jobs before process exit: ${JSON.stringify(detachedPromise)}`
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
        providers: ['javascript'],
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
    console.log(JSON.stringify({ exposure, judged, project: { outcomes, probeNames: project.probeNames } }, null, 2));
    console.log('PASS: public Browser Judge and project paths deny ambient authority in real Chromium');
  } finally {
    await browser?.close();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  }
}

test('javascript authority browser', main);
