#!/usr/bin/env npx tsx

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runCommand, waitForHttp } from './example-app-smoke';

interface BrowserResult {
  preparations: Record<string, Record<string, unknown>>;
  codeRuns: Array<Record<string, unknown>>;
  batchRun: Record<string, unknown>;
  batchBaselineAfter: Record<string, unknown>;
  traceRuns: Array<Record<string, unknown>>;
  legacyTrace: Record<string, unknown>;
  limitedRun: Record<string, unknown>;
  traceLimitedRun: Record<string, unknown>;
  preparationWorker: Record<string, unknown>;
  executions: Array<Record<string, unknown>>;
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
    page.setDefaultTimeout(240_000);
    await page.goto(origin);

    const result = await page.evaluate<BrowserResult>(`(async () => {
      let nextWorkerId = 0;
      const executions = [];
      const runtimeAssets = {
        loaderFormat: 'module',
        loaderUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs',
        indexUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.2/full/',
        runtimeCoreUrl: location.origin + '/workers/python/runtime-core.js',
        snippetsUrl: location.origin + '/workers/generated-python-harness-snippets.js',
      };

      const createClient = async (label) => {
        const workerId = ++nextWorkerId;
        const worker = new Worker('/workers/python-worker.js?tracecodePythonWorkerFormat=module', {
          type: 'module',
        });
        const pending = new Map();
        let nextId = 0;
        let prepareRequests = 0;
        let readyResolve;
        let readyReject;
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
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
          const error = new Error(event.message || 'Python worker error');
          readyReject(error);
          for (const request of pending.values()) request.reject(error);
          pending.clear();
        };
        const request = (type, payload) => {
          if (type === 'prepare-program') prepareRequests += 1;
          return new Promise((resolve, reject) => {
            const id = 'python-prepared-' + workerId + '-' + (++nextId);
            const protocolToken = 'python-prepared-token-' + workerId + '-' + nextId;
            pending.set(id, { resolve, reject, protocolToken });
            worker.postMessage({ id, type, payload, protocolToken });
          });
        };

        const startedAt = performance.now();
        await ready;
        const init = await request('init', { runtimeAssets });
        const warmup = await request('warmup');
        const readyMs = performance.now() - startedAt;
        return {
          id: workerId,
          label,
          request,
          terminate: () => worker.terminate(),
          metrics: () => ({
            workerId,
            label,
            init,
            warmup,
            readyMs,
            prepareRequests,
          }),
        };
      };

      const preparationWorker = await createClient('preparation');
      const isolationCode = [
        'import builtins',
        'import math',
        'import os',
        'import random',
        'import sys',
        'import types',
        'history = []',
        'class Counter:',
        '    value = 0',
        'def solve(action, items, root: TreeNode, head: ListNode):',
        '    path = "/tmp/tracecode-prepared-isolation.txt"',
        '    baseline_path = "/tmp/tracecode-prepared-baseline.txt"',
        '    seeded_state = random.Random(12345).getstate()',
        '    before = {',
        '        "history": len(history),',
        '        "counter": Counter.value,',
        '        "builtinLeak": hasattr(builtins, "tracecode_leak"),',
        '        "moduleLeak": "tracecode_leak" in sys.modules,',
        '        "existingModuleLeak": hasattr(math, "tracecode_existing_leak"),',
        '        "pathLeak": "/tracecode-leak" in sys.path,',
        '        "importerLeak": "tracecode://case" in sys.path_importer_cache,',
        '        "envLeak": os.environ.get("TRACECODE_CASE_LEAK"),',
        '        "rngLeak": random.getstate() == seeded_state,',
        '        "recursionLimit": sys.getrecursionlimit(),',
        '        "cwd": os.getcwd(),',
        '        "fileExists": os.path.exists(path),',
        '        "baseline": open(baseline_path).read() if os.path.exists(baseline_path) else None,',
        '    }',
        '    if action == "create":',
        '        with open(path, "w") as handle:',
        '            handle.write("created")',
        '    elif action == "modify":',
        '        with open(path, "w") as handle:',
        '            handle.write("before")',
        '        with open(path, "a") as handle:',
        '            handle.write("-after")',
        '    elif action == "delete":',
        '        with open(path, "w") as handle:',
        '            handle.write("delete-me")',
        '        os.unlink(path)',
        '    if os.path.exists(baseline_path):',
        '        if action == "delete":',
        '            os.unlink(baseline_path)',
        '        else:',
        '            with open(baseline_path, "w") as handle:',
        '                handle.write(action)',
        '    history.append(action)',
        '    Counter.value += 1',
        '    items.append(99)',
        '    builtins.tracecode_leak = True',
        '    sys.modules["tracecode_leak"] = types.ModuleType("tracecode_leak")',
        '    math.tracecode_existing_leak = True',
        '    sys.path.append("/tracecode-leak")',
        '    sys.path_importer_cache["tracecode://case"] = object()',
        '    os.environ["TRACECODE_CASE_LEAK"] = "leaked"',
        '    random.seed(12345)',
        '    sys.setrecursionlimit(before["recursionLimit"] + 137)',
        '    os.chdir("/tmp")',
        '    return {',
        '        "before": before,',
        '        "afterFileExists": os.path.exists(path),',
        '        "values": [root.val, root.left.val, head.val, head.next.val],',
        '        "itemCount": len(items),',
        '    }',
      ].join('\\n');
      const code = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: isolationCode,
        functionName: 'solve',
        executionStyle: 'function',
      });
      const traceCode = [
        'history = []',
        'def solve(value):',
        '    history.append(value)',
        '    return len(history)',
      ].join('\\n');
      const trace = await preparationWorker.request('prepare-program', {
        mode: 'trace',
        code: traceCode,
        functionName: 'solve',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 1000 },
      });
      const batch = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: isolationCode,
        functionName: 'solve',
        executionStyle: 'function',
      });
      const limited = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def spin(value):',
          '    while True:',
          '        value += 1',
        ].join('\\n'),
        functionName: 'spin',
        executionStyle: 'function',
      });
      const traceLimited = await preparationWorker.request('prepare-program', {
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
      const invalid = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: 'def broken(:\\n    pass',
        functionName: 'broken',
        executionStyle: 'function',
      });
      const preparationMetrics = preparationWorker.metrics();
      preparationWorker.terminate();

      const sharedInput = [7];
      const nodeInputs = {
        root: {
          __type__: 'TreeNode',
          val: 1,
          left: { __type__: 'TreeNode', val: 2, left: null, right: null },
          right: null,
        },
        head: {
          __type__: 'ListNode',
          val: 3,
          next: { __type__: 'ListNode', val: 4, next: null },
        },
      };
      const codeRuns = [];
      for (const action of ['create', 'inspect', 'modify', 'delete']) {
        const client = await createClient('code-' + action);
        const startedAt = performance.now();
        try {
          codeRuns.push(await client.request('execute-prepared-program', {
            artifact: code.artifact,
            mode: 'code',
            inputs: {
              action,
              items: sharedInput,
              ...nodeInputs,
            },
          }));
        } finally {
          executions.push({
            ...client.metrics(),
            executionMs: performance.now() - startedAt,
          });
          client.terminate();
        }
      }
      codeRuns.push({ callerInputAfterRuns: sharedInput.slice() });

      const batchClient = await createClient('code-batch');
      const batchStartedAt = performance.now();
      let batchRun;
      let batchBaselineAfter;
      try {
        const setup = await batchClient.request('execute-code', {
          code: [
            'def setup():',
            '    with open("/tmp/tracecode-prepared-baseline.txt", "w") as handle:',
            '        handle.write("baseline")',
            '    return True',
          ].join('\\n'),
          functionName: 'setup',
          inputs: {},
          executionStyle: 'function',
        });
        if (!setup.success) throw new Error('Could not create batch filesystem baseline.');
        batchRun = await batchClient.request('execute-prepared-program-batch', {
          artifact: batch.artifact,
          mode: 'code',
          inputBatch: ['create', 'inspect', 'modify', 'delete'].map((action) => ({
            action,
            items: sharedInput,
            ...nodeInputs,
          })),
        });
        batchBaselineAfter = await batchClient.request('execute-code', {
          code: [
            'def inspect():',
            '    with open("/tmp/tracecode-prepared-baseline.txt") as handle:',
            '        return handle.read()',
          ].join('\\n'),
          functionName: 'inspect',
          inputs: {},
          executionStyle: 'function',
        });
      } finally {
        executions.push({
          ...batchClient.metrics(),
          executionMs: performance.now() - batchStartedAt,
        });
        batchClient.terminate();
      }

      const traceRuns = [];
      let legacyTrace;
      let traceLimitedRun;
      for (const value of [1, 2]) {
        const client = await createClient('trace-' + value);
        const startedAt = performance.now();
        try {
          traceRuns.push(await client.request('execute-prepared-program', {
            artifact: trace.artifact,
            mode: 'trace',
            inputs: { value },
          }));
          if (value === 2) {
            legacyTrace = await client.request('execute-with-tracing', {
              code: traceCode,
              functionName: 'solve',
              inputs: { value: 1 },
              executionStyle: 'function',
              options: { maxTraceSteps: 1000 },
            });
            traceLimitedRun = await client.request('execute-prepared-program', {
              artifact: traceLimited.artifact,
              mode: 'trace',
              inputs: { n: 150 },
              limits: {
                maxLineEvents: 100000,
                maxSingleLineHits: 10000,
                maxCallDepth: 100,
              },
            });
          }
        } finally {
          executions.push({
            ...client.metrics(),
            executionMs: performance.now() - startedAt,
          });
          client.terminate();
        }
      }

      const limitClient = await createClient('code-limit');
      const limitStartedAt = performance.now();
      let limitedRun;
      try {
        limitedRun = await limitClient.request('execute-prepared-program', {
          artifact: limited.artifact,
          mode: 'code',
          inputs: { value: 0 },
          limits: { maxLineEvents: 10000, maxSingleLineHits: 1000 },
        });
      } finally {
        executions.push({
          ...limitClient.metrics(),
          executionMs: performance.now() - limitStartedAt,
        });
        limitClient.terminate();
      }

      return {
        preparations: { code, trace, batch, limited, traceLimited, invalid },
        codeRuns,
        batchRun,
        batchBaselineAfter,
        traceRuns,
        legacyTrace,
        limitedRun,
        traceLimitedRun,
        preparationWorker: preparationMetrics,
        executions,
      };
    })()`);

    for (const mode of ['code', 'trace', 'batch', 'limited', 'traceLimited']) {
      assertCondition(
        result.preparations[mode]?.success === true,
        `${mode} preparation failed: ${JSON.stringify(result.preparations[mode])}`
      );
      const preparation = result.preparations[mode];
      const artifact = preparation?.artifact as Record<string, unknown> | undefined;
      assertCondition(
        artifact?.schemaVersion === 'tracecode.python.prepared-program.v1' &&
          typeof artifact.userCode === 'string' &&
          typeof artifact.executorCode === 'string',
        `${mode} preparation did not return a portable code artifact`
      );
    }
    assertCondition(
      result.preparations.invalid?.success === false &&
        String(result.preparations.invalid?.error).length > 0,
      `Invalid Python prepared successfully: ${JSON.stringify(result.preparations.invalid)}`
    );
    assertCondition(
      result.preparationWorker.prepareRequests === 6,
      `Preparation worker received ${String(result.preparationWorker.prepareRequests)} preparations instead of six`
    );
    const batchResults = result.batchRun.results as Array<Record<string, unknown>>;
    const batchOutputs = batchResults.map(
      (entry) => entry.output as Record<string, unknown>
    );
    assertCondition(
      result.batchRun.success === true &&
        batchResults.length === 4 &&
        batchResults.every((entry) => entry.success === true) &&
        batchOutputs.every((output) => {
          const before = output.before as Record<string, unknown>;
          return (
            before.history === 0 &&
            before.counter === 0 &&
            before.builtinLeak === false &&
            before.moduleLeak === false &&
            before.existingModuleLeak === false &&
            before.pathLeak === false &&
            before.importerLeak === false &&
            before.envLeak === null &&
            before.rngLeak === false &&
            before.fileExists === false &&
            before.baseline === 'baseline' &&
            before.cwd !== '/tmp'
          );
        }),
      `Prepared Python batch did not isolate mutable case state: ${JSON.stringify(result.batchRun)}`
    );
    assertCondition(
      result.batchBaselineAfter.success === true &&
        result.batchBaselineAfter.output === 'baseline',
      `Prepared Python batch did not restore its pre-existing filesystem state: ${JSON.stringify(result.batchBaselineAfter)}`
    );
    assertCondition(
      result.executions.filter((entry) => entry.label === 'code-batch').length === 1,
      'Prepared Python batch did not stay within one warmed executor worker'
    );
    assertCondition(
      result.executions.every((execution) => execution.prepareRequests === 0),
      `An execution worker recompiled source: ${JSON.stringify(result.executions)}`
    );
    assertCondition(
      new Set(result.executions.map((execution) => execution.workerId)).size ===
        result.executions.length,
      'Prepared cases reused a worker generation'
    );

    const baselineOutputs = result.codeRuns.slice(0, 4).map((run) => {
      assertCondition(run.success === true, `Prepared code failed: ${JSON.stringify(run)}`);
      const output = run.output as Record<string, unknown>;
      return output.before as Record<string, unknown>;
    });
    const baselineRecursionLimit = baselineOutputs[0]?.recursionLimit;
    const baselineCwd = baselineOutputs[0]?.cwd;
    for (const [index, before] of baselineOutputs.entries()) {
      assertCondition(
        before.history === 0 &&
          before.counter === 0 &&
          before.builtinLeak === false &&
          before.moduleLeak === false &&
          before.existingModuleLeak === false &&
          before.pathLeak === false &&
          before.importerLeak === false &&
          before.envLeak === null &&
          before.rngLeak === false &&
          before.fileExists === false &&
          before.recursionLimit === baselineRecursionLimit &&
          before.cwd === baselineCwd &&
          before.cwd !== '/tmp',
        `Fresh worker ${index + 1} inherited Python singleton or filesystem state: ${JSON.stringify(before)}`
      );
    }
    const codeOutputs = result.codeRuns.slice(0, 4).map(
      (run) => run.output as Record<string, unknown>
    );
    assertCondition(
      codeOutputs[0]?.afterFileExists === true &&
        codeOutputs[1]?.afterFileExists === false &&
        codeOutputs[2]?.afterFileExists === true &&
        codeOutputs[3]?.afterFileExists === false,
      `Create/inspect/modify/delete behavior was incorrect: ${JSON.stringify(codeOutputs)}`
    );
    assertCondition(
      codeOutputs.every(
        (output) =>
          JSON.stringify(output.values) === JSON.stringify([1, 2, 3, 4]) &&
          output.itemCount === 2
      ),
      `Fresh workers did not materialize inputs consistently: ${JSON.stringify(codeOutputs)}`
    );
    assertCondition(
      JSON.stringify(result.codeRuns[4]?.callerInputAfterRuns) === JSON.stringify([7]),
      `Prepared execution mutated caller-owned inputs: ${JSON.stringify(result.codeRuns[4])}`
    );
    for (const [index, run] of result.codeRuns.slice(0, 4).entries()) {
      const timings = run.timings as Record<string, unknown> | undefined;
      assertCondition(
        timings?.compileCacheHit === true &&
          timings.artifactCacheHit === true &&
          typeof timings.runMs === 'number',
        `Prepared code run ${index + 1} did not report artifact reuse: ${JSON.stringify(run)}`
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
    const traceSignature = (run: Record<string, unknown>): string => {
      const trace = run.trace as { events?: Array<Record<string, unknown>> } | undefined;
      const controlKinds = new Set(['call', 'line', 'return', 'exception']);
      return JSON.stringify(
        (trace?.events ?? [])
          .filter((event) => controlKinds.has(String(event.kind)))
          .map((event) => ({
            kind: event.kind,
            line: event.line,
            function: event.function,
          }))
      );
    };
    assertCondition(
      traceSignature(result.traceRuns[0] ?? {}) === traceSignature(result.legacyTrace),
      `Marshaled trace line mapping diverged from direct tracing: ${JSON.stringify({
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
    console.log(
      `PASS: Python marshaled artifacts cross fresh browser workers ${JSON.stringify({
        preparationReadyMs: result.preparationWorker.readyMs,
        executionReadyMs: result.executions.map((execution) => execution.readyMs),
        executionMs: result.executions.map((execution) => execution.executionMs),
      })}`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
