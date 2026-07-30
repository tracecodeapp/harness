#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

interface BrowserResult {
  preparation: {
    code: Record<string, unknown>;
    trace: Record<string, unknown>;
    invalid: Record<string, unknown>;
  };
  codeRuns: Array<Record<string, unknown>>;
  traceRuns: Array<Record<string, unknown>>;
  legacyTrace: Record<string, unknown>;
  materializedRun: Record<string, unknown>;
  limitedRun: Record<string, unknown>;
  traceLimitedRun: Record<string, unknown>;
  disposedExecutionError: string;
  prepareRequests: number;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-python-prepared-browser-'));
  const workersRoot = join(tempRoot, 'workers');
  const port = 6100 + Math.floor(Math.random() * 200);
  const origin = `http://127.0.0.1:${port}`;

  await runCommand(
    'pnpm',
    ['exec', 'tsx', 'src/cli.ts', 'sync-assets', workersRoot, '--languages', 'python'],
    process.cwd()
  );
  await writeFile(
    join(tempRoot, 'index.html'),
    '<!doctype html><title>Python prepared provider smoke</title>',
    'utf8'
  );

  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'import os',
    'class Handler(SimpleHTTPRequestHandler):',
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    '        super().end_headers()',
    `os.chdir(${JSON.stringify(tempRoot)})`,
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForHttp(origin, 30_000);
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(origin);

    const result = await page.evaluate<BrowserResult>(`(async () => {
      const worker = new Worker('/workers/python-worker.js?tracecodePythonWorkerFormat=module', {
        type: 'module',
      });
      const pending = new Map();
      let nextId = 0;
      let prepareRequests = 0;
      let readyResolve;
      const ready = new Promise((resolve) => { readyResolve = resolve; });

      worker.onmessage = (event) => {
        const { id, type, payload, protocolToken } = event.data || {};
        if (type === 'worker-ready') {
          readyResolve();
          return;
        }
        const request = pending.get(id);
        if (!request || request.protocolToken !== protocolToken) return;
        pending.delete(id);
        if (type === 'error') {
          request.reject(new Error(payload && payload.error || 'Python worker error'));
          return;
        }
        request.resolve(payload);
      };
      worker.onerror = (event) => {
        for (const request of pending.values()) {
          request.reject(new Error(event.message || 'Python worker error'));
        }
        pending.clear();
      };
      const request = (type, payload) => {
        if (type === 'prepare-program') prepareRequests += 1;
        return new Promise((resolve, reject) => {
          const id = 'python-prepared-' + (++nextId);
          const protocolToken = 'python-prepared-token-' + nextId;
          pending.set(id, { resolve, reject, protocolToken });
          worker.postMessage({ id, type, payload, protocolToken });
        });
      };

      await ready;
      await request('init', {
        runtimeAssets: {
          loaderFormat: 'module',
          loaderUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs',
          indexUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/',
          runtimeCoreUrl: location.origin + '/workers/python/runtime-core.js',
          snippetsUrl: location.origin + '/workers/generated-python-harness-snippets.js',
        },
      });
      await request('warmup');

      const codePreparation = await request('prepare-program', {
        mode: 'code',
        code: [
          'import builtins',
          'import math',
          'import os',
          'import sys',
          'import types',
          'history = []',
          'class Counter:',
          '    value = 0',
          'def solve(items):',
          '    before = [len(history), Counter.value, hasattr(builtins, "tracecode_leak"), "tracecode_leak" in sys.modules, hasattr(math, "tracecode_existing_leak"), "/tracecode-leak" in sys.path, os.environ.get("TRACECODE_CASE_LEAK")]',
          '    history.append(items[0])',
          '    Counter.value += 1',
          '    items.append(99)',
          '    builtins.tracecode_leak = True',
          '    sys.modules["tracecode_leak"] = types.ModuleType("tracecode_leak")',
          '    math.tracecode_existing_leak = True',
          '    sys.path.append("/tracecode-leak")',
          '    os.environ["TRACECODE_CASE_LEAK"] = "leaked"',
          '    return before + [len(history), Counter.value, len(items)]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });

      const sharedInput = [7];
      const runCode = () => request('execute-prepared-program', {
        programId: codePreparation.programId,
        mode: 'code',
        inputs: { items: sharedInput },
      });
      const codeRuns = [await runCode(), await runCode()];
      codeRuns.push({ callerInputAfterRuns: sharedInput.slice() });

      const materializedPreparation = await request('prepare-program', {
        mode: 'code',
        code: [
          'def inspect_inputs(root: TreeNode, head: ListNode, right=0):',
          '    return [root.val, root.left.val, head.val, head.next.val, right]',
        ].join('\\n'),
        functionName: 'inspect_inputs',
        executionStyle: 'function',
      });
      const materializedRun = await request('execute-prepared-program', {
        programId: materializedPreparation.programId,
        mode: 'code',
        inputs: {
          right: 5,
          head: {
            __type__: 'ListNode',
            val: 3,
            next: { __type__: 'ListNode', val: 4, next: null },
          },
          root: {
            __type__: 'TreeNode',
            val: 1,
            left: { __type__: 'TreeNode', val: 2, left: null, right: null },
            right: null,
          },
          ignored: 999,
        },
      });

      const traceCode = [
        'history = []',
        'def solve(value):',
        '    history.append(value)',
        '    return len(history)',
      ].join('\\n');
      const tracePreparation = await request('prepare-program', {
        mode: 'trace',
        code: traceCode,
        functionName: 'solve',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 1000 },
      });
      const runTrace = (value) => request('execute-prepared-program', {
        programId: tracePreparation.programId,
        mode: 'trace',
        inputs: { value },
      });
      const traceRuns = [await runTrace(1), await runTrace(2)];
      const legacyTrace = await request('execute-with-tracing', {
        code: traceCode,
        functionName: 'solve',
        inputs: { value: 1 },
        executionStyle: 'function',
        options: { maxTraceSteps: 1000 },
      });

      const limitedPreparation = await request('prepare-program', {
        mode: 'code',
        code: [
          'def spin(value):',
          '    while True:',
          '        value += 1',
        ].join('\\n'),
        functionName: 'spin',
        executionStyle: 'function',
      });
      const limitedRun = await request('execute-prepared-program', {
        programId: limitedPreparation.programId,
        mode: 'code',
        inputs: { value: 0 },
        limits: { maxLineEvents: 10000, maxSingleLineHits: 1000 },
      });

      const traceLimitedPreparation = await request('prepare-program', {
        mode: 'trace',
        code: [
          'def recurse(n):',
          '    if n == 0:',
          '        return 0',
          '    return recurse(n - 1) + 1',
        ].join('\\n'),
        functionName: 'recurse',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 10000 },
      });
      const traceLimitedRun = await request('execute-prepared-program', {
        programId: traceLimitedPreparation.programId,
        mode: 'trace',
        inputs: { n: 150 },
        limits: {
          maxLineEvents: 100000,
          maxSingleLineHits: 10000,
          maxCallDepth: 100,
        },
      });

      const invalid = await request('prepare-program', {
        mode: 'code',
        code: 'def broken(:\\n    pass',
        functionName: 'broken',
        executionStyle: 'function',
      });

      await request('dispose-prepared-program', {
        programId: codePreparation.programId,
      });
      let disposedExecutionError = '';
      try {
        await runCode();
      } catch (error) {
        disposedExecutionError = error instanceof Error ? error.message : String(error);
      }
      await request('dispose-prepared-program', {
        programId: tracePreparation.programId,
      });
      await request('dispose-prepared-program', {
        programId: materializedPreparation.programId,
      });
      await request('dispose-prepared-program', {
        programId: limitedPreparation.programId,
      });
      await request('dispose-prepared-program', {
        programId: traceLimitedPreparation.programId,
      });
      worker.terminate();

      return {
        preparation: { code: codePreparation, trace: tracePreparation, invalid },
        codeRuns,
        traceRuns,
        legacyTrace,
        materializedRun,
        limitedRun,
        traceLimitedRun,
        disposedExecutionError,
        prepareRequests,
      };
    })()`);

    assertCondition(result.preparation.code.success === true, 'Code preparation failed');
    assertCondition(result.preparation.trace.success === true, 'Trace preparation failed');
    assertCondition(
      result.prepareRequests === 6,
      `Expected exactly six explicit preparations, received ${result.prepareRequests}`
    );
    assertCondition(
      JSON.stringify(result.codeRuns[0]?.output) === JSON.stringify([0, 0, false, false, false, false, null, 1, 1, 2]) &&
        JSON.stringify(result.codeRuns[1]?.output) === JSON.stringify([0, 0, false, false, false, false, null, 1, 1, 2]),
      `Prepared code leaked globals, class statics, builtins, modules, or inputs: ${JSON.stringify(result.codeRuns)}`
    );
    assertCondition(
      JSON.stringify(result.codeRuns[2]?.callerInputAfterRuns) === JSON.stringify([7]),
      `Prepared execution mutated caller-owned inputs: ${JSON.stringify(result.codeRuns[2])}`
    );
    for (const [index, run] of result.codeRuns.slice(0, 2).entries()) {
      const timings = run.timings as Record<string, unknown> | undefined;
      assertCondition(
        timings?.compileCacheHit === true &&
          timings.artifactCacheHit === true &&
          typeof timings.runMs === 'number',
        `Prepared code run ${index + 1} did not report artifact reuse and run timing: ${JSON.stringify(run)}`
      );
    }
    for (const [index, run] of result.traceRuns.entries()) {
      const trace = run.trace as { events?: unknown[] } | undefined;
      assertCondition(
        run.success === true &&
          run.output === 1 &&
          Array.isArray(trace?.events) &&
          trace.events.length > 0,
        `Prepared trace run ${index + 1} was not isolated or traced: ${JSON.stringify(run)}`
      );
    }
    assertCondition(
      result.materializedRun.success === true &&
        JSON.stringify(result.materializedRun.output) === JSON.stringify([1, 2, 3, 4, 5]),
      `Prepared execution did not discover arguments or materialize TreeNode/ListNode inputs: ${JSON.stringify(result.materializedRun)}`
    );
    const traceSignature = (run: Record<string, unknown>): string => {
      const trace = run.trace as { events?: Array<Record<string, unknown>> } | undefined;
      return JSON.stringify((trace?.events ?? []).map((event) => ({
        kind: event.kind,
        line: event.line,
        function: event.function,
      })));
    };
    assertCondition(
      traceSignature(result.traceRuns[0] ?? {}) === traceSignature(result.legacyTrace),
      `Prepared trace line remapping diverged from legacy tracing: ${JSON.stringify({
        prepared: traceSignature(result.traceRuns[0] ?? {}),
        legacy: traceSignature(result.legacyTrace),
      })}`
    );
    assertCondition(
      result.limitedRun.success === false &&
        ['line-limit', 'single-line-limit'].includes(String(result.limitedRun.timeoutReason)),
      `Prepared execution ignored per-case guest limits: ${JSON.stringify(result.limitedRun)}`
    );
    assertCondition(
      result.traceLimitedRun.success === false &&
        result.traceLimitedRun.timeoutReason === 'recursion-limit',
      `Prepared trace execution ignored call-depth limits: ${JSON.stringify(result.traceLimitedRun)}`
    );
    assertCondition(
      result.preparation.invalid.success === false &&
        String(result.preparation.invalid.error).length > 0,
      `Invalid Python prepared successfully: ${JSON.stringify(result.preparation.invalid)}`
    );
    assertCondition(
      result.disposedExecutionError.includes('Unknown or disposed prepared Python program'),
      `Disposed program remained executable: ${result.disposedExecutionError}`
    );
    for (const [mode, preparation] of Object.entries({
      code: result.preparation.code,
      trace: result.preparation.trace,
    })) {
      const timings = preparation.timings as Record<string, unknown> | undefined;
      assertCondition(
        timings?.compileCacheHit === false &&
          timings.artifactCacheHit === false &&
          typeof timings.compileMs === 'number',
        `${mode} preparation did not report one-time compilation timing: ${JSON.stringify(preparation)}`
      );
    }
    console.log(
      `PASS: Python prepared programs compile once and isolate code/trace cases ${JSON.stringify({
        codeProgramId: result.preparation.code.programId,
        traceProgramId: result.preparation.trace.programId,
        limitedReason: result.limitedRun.timeoutReason,
      })}`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
