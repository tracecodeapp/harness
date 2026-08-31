#!/usr/bin/env npx tsx

import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { isSesAlgorithmSourceEligible } from '../packages/runtime-javascript/src/ses-algorithm-worker-client';
import { runCommand } from './example-app-smoke';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSesAdmissionPolicy(): void {
  const legacyOnlySources = [
    'function solve() { return Math?.random(); }',
    'function solve() { const { random } = Math; return random(); }',
    'function solve() { const M = Math; return M.random(); }',
    "function solve() { return _['template']('<%= value %>')({ value: 1 }); }",
    'function solve() { const lodashAlias = lodash; return lodashAlias?.sample([1]); }',
    'function solve() { const L = require("lodash"); return L.random(1, 5); }',
    'function solve() { const { shuffle } = require("lodash.js"); return shuffle([1, 2]); }',
    'function solve() { const g = globalThis; const M = g.Math; return M.random(); }',
    'function solve() { const holder = { M: Math }; return holder.M.random(); }',
    'globalThis.Array.prototype.last = function () { return this.at(-1); };',
    'MinPriorityQueue.prototype.empty = function () { return this.size() === 0; };',
    'const p = "prototype"; Array[p].last = function () { return this.at(-1); };',
    'const { prototype } = Array; prototype.last = function () { return this.at(-1); };',
    'function solve(value) { return value + 1; } return 0;',
    'await Promise.resolve(); function solve() { return 1; }',
    'function solve() { return 1; } for await (const value of []) {}',
    'function solve() { return 1; } { await using value = null; }',
  ];
  for (const source of legacyOnlySources) {
    assertCondition(
      !isSesAlgorithmSourceEligible(source),
      `SES admission should route legacy-only source away from the retained pool: ${source}`
    );
  }
  assertCondition(
    isSesAlgorithmSourceEligible('function solve(values) { return Math.max(...values); }'),
    'ordinary deterministic Math algorithms should remain SES eligible'
  );
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

async function startServer(root: string) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const path = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!path || !existsSync(path)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(path).size),
      'Content-Type': contentType(path),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
    }),
  };
}

async function main(): Promise<void> {
  assertSesAdmissionPolicy();
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-javascript-ses-provider-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand('pnpm', ['generate:javascript-ses-worker'], process.cwd());
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', 'javascript'],
      process.cwd()
    );
    await build({
      entryPoints: [resolve('tests/fixtures/javascript-ses-provider-entry.ts')],
      outfile: join(tempRoot, 'entry.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        '@tracecode/tracekernel/workspace': resolve('packages/tracekernel/src/workspace/index.ts'),
        '@tracecode/tracekernel': resolve('packages/tracekernel/src/index.ts'),
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(120_000);
      page.on('pageerror', (error) => console.error(error.stack ?? error.message));
      page.on('console', (message) => console.error(`[browser ${message.type()}] ${message.text()}`));
      page.on('requestfailed', (request) => console.error(
        `[browser request failed] ${request.url()} ${request.failure()?.errorText ?? ''}`
      ));
      page.on('response', (response) => {
        if (!response.ok()) console.error(`[browser response] ${response.status()} ${response.url()}`);
      });
      await page.goto(`${server.origin}/`);
      const result = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptSesProvider(`${origin}/workers`);
      }, { origin: server.origin }) as Record<string, {
        verdict: string;
        passedCount: number;
        totalCount: number;
        evaluationStatus: string;
        diagnostics: unknown[];
        stdout: string[];
        values: unknown[];
        valueShapes: unknown[];
        timings: Array<{ algorithmFastBatch?: boolean }>;
        traces: Array<{
          events?: Array<{ kind?: string }>;
          lineEventCount?: number;
          traceStepCount?: number;
        }>;
        elapsedMs: number;
      }>;
      for (const [name, receipt] of Object.entries(result)) {
        if (name === 'timeoutRecovery' || name === 'traceTimeoutRecovery' ||
            name === 'runtimeErrorLine' ||
            name === 'constructorEscape' || name === 'undefinedTargetFallback' ||
            name === 'forAwaitFallback' || name === 'awaitUsingFallback' ||
            name === 'typescriptForAwaitFallback') continue;
        assertCondition(
          receipt.verdict === 'passed' &&
          receipt.evaluationStatus === 'completed' &&
          receipt.passedCount === receipt.totalCount,
          `${name} failed: ${JSON.stringify(receipt)}`
        );
      }
      const timeoutRecovery = result.timeoutRecovery;
      assertCondition(
        timeoutRecovery?.verdict === 'failed' &&
        timeoutRecovery.evaluationStatus === 'completed' &&
        timeoutRecovery.passedCount === timeoutRecovery.totalCount - 1 &&
        timeoutRecovery.elapsedMs < 5_000,
        `timeoutRecovery failed: ${JSON.stringify(timeoutRecovery)}`
      );
      const traceTimeoutRecovery = result.traceTimeoutRecovery;
      assertCondition(
        traceTimeoutRecovery?.verdict === 'failed' &&
        traceTimeoutRecovery.evaluationStatus === 'completed' &&
        traceTimeoutRecovery.passedCount === traceTimeoutRecovery.totalCount - 1 &&
        traceTimeoutRecovery.elapsedMs < 5_000 &&
        traceTimeoutRecovery.timings.slice(1).every(
          (timing) => timing.algorithmFastBatch === true
        ),
        `traceTimeoutRecovery failed: ${JSON.stringify(traceTimeoutRecovery)}`
      );
      const runtimeErrorLine = result.runtimeErrorLine;
      assertCondition(
        runtimeErrorLine?.verdict === 'failed' &&
        runtimeErrorLine.evaluationStatus === 'completed' &&
        runtimeErrorLine.passedCount === 0 &&
        runtimeErrorLine.diagnostics.some((diagnostic) =>
          typeof diagnostic === 'object' &&
          diagnostic !== null &&
          (diagnostic as { line?: unknown }).line === 3
        ),
        `runtimeErrorLine failed: ${JSON.stringify(runtimeErrorLine)}`
      );
      const constructorEscape = result.constructorEscape;
      assertCondition(
        constructorEscape?.verdict === 'failed' &&
        constructorEscape.evaluationStatus === 'completed' &&
        constructorEscape.passedCount === 0,
        `constructorEscape source policy mismatch: ${JSON.stringify(constructorEscape)}`
      );
      const undefinedTargetFallback = result.undefinedTargetFallback;
      assertCondition(
        undefinedTargetFallback?.verdict === 'failed' &&
        undefinedTargetFallback.evaluationStatus === 'completed' &&
        undefinedTargetFallback.passedCount === 0,
        `undefinedTargetFallback failed: ${JSON.stringify(undefinedTargetFallback)}`
      );
      assertCondition(
        result.topLevelReturnFallback?.timings.every(
          (timing) => timing.algorithmFastBatch !== true
        ),
        `top-level return must preserve legacy embedding: ${JSON.stringify(
          result.topLevelReturnFallback
        )}`
      );
      for (const name of [
        'forAwaitFallback',
        'awaitUsingFallback',
        'typescriptForAwaitFallback',
      ] as const) {
        const receipt = result[name];
        assertCondition(
          receipt?.verdict === 'failed' &&
          receipt.evaluationStatus === 'completed' &&
          receipt.passedCount === 0 &&
          receipt.timings.every((timing) => timing.algorithmFastBatch !== true),
          `${name} must preserve legacy syntax behavior: ${JSON.stringify(receipt)}`
        );
      }
      assertCondition(
        result.consoleBlankSes?.stdout[0] === 'a\n\nb\n' &&
        result.consoleBlankLegacy?.stdout[0] === 'a\n\nb\n',
        `blank console policy mismatch: ${JSON.stringify({
          ses: result.consoleBlankSes?.stdout,
          legacy: result.consoleBlankLegacy?.stdout,
        })}`
      );
      assertCondition(
        result.consoleCapSes?.stdout[0] === result.consoleCapLegacy?.stdout[0] &&
        !result.consoleCapSes?.stdout[0]?.includes('…[truncated]') &&
        !result.consoleCapLegacy?.stdout[0]?.includes('…[truncated]') &&
        result.consoleCapLegacy?.stdout[0]?.includes('line-104') &&
        result.consoleCapSes?.timings[0]?.algorithmFastBatch !== true,
        `console isolation policy mismatch: ${JSON.stringify({
          ses: result.consoleCapSes?.stdout,
          legacy: result.consoleCapLegacy?.stdout,
        })}`
      );
      assertCondition(
        result.traceConsoleCap?.verdict === 'passed' &&
        result.traceConsoleCap.evaluationStatus === 'completed' &&
        result.traceConsoleCap.stdout.every((stdout) =>
          stdout === result.consoleCapLegacy?.stdout[0]
        ) &&
        result.traceConsoleCap.timings.every(
          (timing) => timing.algorithmFastBatch !== true
        ),
        `trace console budget must fall back without failing: ${JSON.stringify(
          result.traceConsoleCap
        )}`
      );
      const outputTransport = result.outputTransportParity?.values;
      const symbolArray = outputTransport?.[3] as unknown[] | undefined;
      const outputTransportShapes = result.outputTransportParity?.valueShapes as Array<{
        kind?: unknown;
        keys?: unknown;
        undefinedKeys?: unknown;
        indices?: Array<{ own?: unknown; undefined?: unknown; negativeZero?: unknown }>;
      }> | undefined;
      const outputTransportChecks = {
        objectHasUndefined: outputTransportShapes?.[0]?.kind === 'object' &&
          Array.isArray(outputTransportShapes[0].keys) &&
          outputTransportShapes[0].keys.includes('missing') &&
          Array.isArray(outputTransportShapes[0].undefinedKeys) &&
          outputTransportShapes[0].undefinedKeys.includes('missing'),
        arrayHasUndefined: outputTransportShapes?.[1]?.indices?.[0]?.own === true &&
          outputTransportShapes[1].indices?.[0]?.undefined === true,
        preservesNegativeZero: outputTransportShapes?.[2]?.indices?.[0]?.negativeZero === true,
        serializesSymbol: Array.isArray(symbolArray) && symbolArray[0] === 'Symbol(tracecode)',
        preservesSparseHole: outputTransportShapes?.[4]?.indices?.[0]?.own === false &&
          outputTransportShapes[4].indices?.[1]?.own === true,
      };
      assertCondition(
        Object.values(outputTransportChecks).every(Boolean),
        `output transport parity mismatch: ${JSON.stringify(outputTransportChecks)}`
      );
      const fastParityReceipts = [
        result.isolation,
        result.libraryIsolation,
        result.libraryClosureIsolation,
        result.outputTransportParity,
        result.nodeReferenceParity,
        result.forcedNodeLeafParity,
        result.sharedReferenceParity,
        result.binaryOutputParity,
        result.accessorOutput,
        result.specialOutput,
        result.deepMapOutput,
        result.asyncOpsClassParity,
        result.plainObjectMaterializerParity,
        result.traceFast,
        result.traceDetachedTaskIsolation,
        result.typescriptTraceFast,
      ];
      assertCondition(
        fastParityReceipts.every((receipt) =>
          receipt?.timings.length === receipt.totalCount &&
          receipt.timings.every((timing) => timing.algorithmFastBatch === true)
        ),
        `SES parity regression unexpectedly used compatibility execution: ${JSON.stringify(
          fastParityReceipts.map((receipt) => receipt?.timings)
        )}`
      );
      const fastTrace = result.traceFast;
      assertCondition(
        fastTrace?.traces.length === fastTrace.totalCount &&
        fastTrace.traces.every((trace) =>
          Array.isArray(trace.events) &&
          (trace.lineEventCount ?? 0) > 0 &&
          (trace.traceStepCount ?? 0) >= (trace.lineEventCount ?? 0) &&
          trace.events.some((event) => event.kind === 'call') &&
          trace.events.some((event) => event.kind === 'return')
        ),
        `SES fast trace did not preserve call/line/return events: ${JSON.stringify(
          fastTrace?.traces
        )}`
      );
      assertCondition(
        result.typescriptTraceFast?.traces.every((trace) =>
          Array.isArray(trace.events) &&
          trace.events.some((event) => event.kind === 'line') &&
          trace.events.some((event) => event.kind === 'return')
        ),
        `SES TypeScript fast trace was empty: ${JSON.stringify(
          result.typescriptTraceFast?.traces
        )}`
      );
      const nodeReference = result.nodeReferenceParity?.values[0] as {
        __id__?: unknown;
        next?: { __id__?: unknown; next?: unknown } | null;
        mirror?: { __ref__?: unknown };
      } | undefined;
      assertCondition(
        nodeReference?.__id__ === 'ListNode:1' &&
        nodeReference.next?.__id__ === 'ListNode:2' &&
        nodeReference.next?.next === null &&
        nodeReference.mirror?.__ref__ === 'ListNode:2',
        `node reference parity mismatch: ${JSON.stringify(nodeReference)}`
      );
      const legacyPageRelative = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptLegacyPageRelativeProvider();
      }, { origin: server.origin }) as {
        verdict: string;
        passedCount: number;
        totalCount: number;
        evaluationStatus: string;
      };
      assertCondition(
        legacyPageRelative.verdict === 'passed' &&
        legacyPageRelative.evaluationStatus === 'completed' &&
        legacyPageRelative.passedCount === legacyPageRelative.totalCount,
        `legacyPageRelative failed: ${JSON.stringify(legacyPageRelative)}`
      );
      const serializerParity = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptSerializerParity(`${origin}/workers`);
      }, { origin: server.origin }) as Record<'ses' | 'legacy', {
        verdict: string;
        passedCount: number;
        totalCount: number;
        evaluationStatus: string;
        values: unknown[];
        timings: Array<{ algorithmFastBatch?: boolean }>;
      }>;
      assertCondition(
        serializerParity.ses.verdict === 'passed' &&
        serializerParity.legacy.verdict === 'passed' &&
        serializerParity.ses.evaluationStatus === 'completed' &&
        serializerParity.legacy.evaluationStatus === 'completed' &&
        serializerParity.ses.passedCount === serializerParity.ses.totalCount &&
        serializerParity.legacy.passedCount === serializerParity.legacy.totalCount &&
        JSON.stringify(serializerParity.ses.values) === JSON.stringify(serializerParity.legacy.values) &&
        serializerParity.ses.timings.length === serializerParity.ses.totalCount &&
        serializerParity.ses.timings.every((timing) => timing.algorithmFastBatch === true) &&
        serializerParity.legacy.timings.every((timing) => timing.algorithmFastBatch !== true),
        `browser serializer parity mismatch: ${JSON.stringify(serializerParity)}`
      );
      const traceParity = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptTraceParity(`${origin}/workers`);
      }, { origin: server.origin }) as {
        fast: { verdict: string; timings: Array<{ algorithmFastBatch?: boolean }> };
        general: { verdict: string; timings: Array<{ algorithmFastBatch?: boolean }> };
        fastSignatures: unknown[];
        generalSignatures: unknown[];
      };
      assertCondition(
        traceParity.fast.verdict === 'passed' &&
        traceParity.general.verdict === 'passed' &&
        traceParity.fast.timings.every(
          (timing) => timing.algorithmFastBatch === true
        ) &&
        traceParity.general.timings.every(
          (timing) => timing.algorithmFastBatch !== true
        ) &&
        JSON.stringify(traceParity.fastSignatures) ===
          JSON.stringify(traceParity.generalSignatures),
        `browser fast/compatibility trace parity mismatch: ${JSON.stringify(traceParity)}`
      );
      const sesUnavailable = await page.evaluate(async ({ origin }) => {
        const entry = await import(`${origin}/entry.mjs`);
        return entry.runJavaScriptSesUnavailableFallback(`${origin}/workers`);
      }, { origin: server.origin }) as Record<string, {
        verdict: string;
        passedCount: number;
        totalCount: number;
        evaluationStatus: string;
      }>;
      for (const [name, receipt] of Object.entries(sesUnavailable)) {
        assertCondition(
          receipt.verdict === 'passed' &&
          receipt.evaluationStatus === 'completed' &&
          receipt.passedCount === receipt.totalCount,
          `sesUnavailable.${name} failed: ${JSON.stringify(receipt)}`
        );
      }
      console.log(`PASS: JavaScript SES provider browser integration ${JSON.stringify({
        typescript100Ms: result.typescript?.elapsedMs,
        isolationMs: result.isolation?.elapsedMs,
      })}`);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
