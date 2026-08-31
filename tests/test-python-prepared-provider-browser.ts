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
  algorithmBatchRun: Record<string, unknown>;
  fastParityRuns: Record<string, Record<string, unknown>>;
  isolationProfiles: {
    code: { tier?: string; reasons: string[] };
    batch: { tier?: string; reasons: string[] };
    trace: { tier?: string; reasons: string[] };
    limited: { tier?: string; reasons: string[] };
    algorithmBatch: { tier?: string; reasons: string[] };
    defaultModuleMutation: { tier?: string; reasons: string[] };
    shadowedModuleMutation: { tier?: string; reasons: string[] };
    reflectiveOperator: { tier?: string; reasons: string[] };
    reflectiveFormat: { tier?: string; reasons: string[] };
    stringAnnotation: { tier?: string; reasons: string[] };
    nestedStringAnnotation: { tier?: string; reasons: string[] };
    singleDispatch: { tier?: string; reasons: string[] };
    frameIntrospection: { tier?: string; reasons: string[] };
    updateWrapperEscape: { tier?: string; reasons: string[] };
    sharedAttributeEscape: { tier?: string; reasons: string[] };
    sharedDefaultCapture: { tier?: string; reasons: string[] };
    sharedStateRegistration: { tier?: string; reasons: string[] };
    mathModuleMutation: { tier?: string; reasons: string[] };
    unknownImport: { tier?: string; reasons: string[] };
    unsupportedBuiltin: { tier?: string; reasons: string[] };
    serializationOverride: { tier?: string; reasons: string[] };
    catchAllException: { tier?: string; reasons: string[] };
    baseExceptionCatch: { tier?: string; reasons: string[] };
    exceptionHierarchyCatch: { tier?: string; reasons: string[] };
    exceptionFinalizer: { tier?: string; reasons: string[] };
    objectFinalizer: { tier?: string; reasons: string[] };
    generatorFinalizer: { tier?: string; reasons: string[] };
    cachedDecorator: { tier?: string; reasons: string[] };
    transitiveTraversal: { tier?: string; reasons: string[] };
    treeNodeFreshness: { tier?: string; reasons: string[] };
    dequeExecution: { tier?: string; reasons: string[] };
    customClassHydration: { tier?: string; reasons: string[] };
    globalInput: { tier?: string; reasons: string[] };
    globalRebinding: { tier?: string; reasons: string[] };
    heterogeneousTuple: { tier?: string; reasons: string[] };
    matrixInplace: { tier?: string; reasons: string[] };
    nodeAnnotationParity: { tier?: string; reasons: string[] };
    moduleLookup: { tier?: string; reasons: string[] };
    localCount: { tier?: string; reasons: string[] };
    raising: { tier?: string; reasons: string[] };
    hostileException: { tier?: string; reasons: string[] };
    hostileSerialization: { tier?: string; reasons: string[] };
    wallClockBatch: { tier?: string; reasons: string[] };
    judgeCompatibleWallClock: { tier?: string; reasons: string[] };
    judgeCompatibleSerializationWallClock: { tier?: string; reasons: string[] };
    judgeCompatibleSignatureWallClock: { tier?: string; reasons: string[] };
    reservedGuardCollision: { tier?: string; reasons: string[] };
    reservedGuardAlias: { tier?: string; reasons: string[] };
    internalNameWallClock: { tier?: string; reasons: string[] };
    contextManager: { tier?: string; reasons: string[] };
    traceExceptionWallClock: { tier?: string; reasons: string[] };
    parity: { tier?: string; reasons: string[] };
    inplace: { tier?: string; reasons: string[] };
    serialized: { tier?: string; reasons: string[] };
    trustedPreparationBudget: { tier?: string; reasons: string[] };
    learnerHydrationBudget: { tier?: string; reasons: string[] };
    benchmarkCode: { tier?: string; reasons: string[] };
    benchmarkHasFastBatch: boolean;
  };
  traceRuns: Array<Record<string, unknown>>;
  mixedTraceBatch: Record<string, unknown>;
  legacyTrace: Record<string, unknown>;
  limitedRun: Record<string, unknown>;
  traceLimitedRun: Record<string, unknown>;
  onDemandBenchmark: Record<string, unknown>;
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
        runtimeUrl: location.origin + '/workers/python/python-runtime.js',
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
      if (!code?.success) {
        throw new Error(
          'Python code preparation failed before execution: ' +
          JSON.stringify(code)
        );
      }
      const traceCode = [
        'from collections import deque',
        'history = deque()',
        'def solve(value):',
        '    history.append(value)',
        '    seen = {value: True}',
        '    return len(history) if value in seen else -1',
      ].join('\\n');
      const trace = await preparationWorker.request('prepare-program', {
        mode: 'trace',
        code: traceCode,
        functionName: 'solve',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 1000 },
      });
      const judgeBatchCode = [
        'history = []',
        'class CaseState:',
        '    value = 0',
        'def solve(action, items):',
        '    before = {"history": len(history), "counter": CaseState.value}',
        '    sum(value for value in ())',
        '    history.append(action)',
        '    CaseState.value += 1',
        '    items.append(99)',
        '    return {"before": before, "itemCount": len(items)}',
      ].join('\\n');
      const batch = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: judgeBatchCode,
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
      const algorithmBatch = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'import random',
          'def solve(value):',
          '    if value < 0:',
          '        while True:',
          '            value += 1',
          '    return random.random()',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const defaultModuleMutation = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    heapq.tracecode_case_leak = value',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const shadowedModuleMutation = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'heapq = heapq',
            'def solve(value):',
            '    heapq.tracecode_case_leak = value',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const reflectiveOperator = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    return operator.attrgetter("__globals__")(solve)',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const reflectiveFormat = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    return "{0.__globals__}".format(print)',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const stringAnnotation = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value: "TreeNode.__init__.__globals__"):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const nestedStringAnnotation = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value: list["TreeNode.__init__.__globals__"]):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const singleDispatch = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'from functools import singledispatch',
            '@singledispatch',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const frameIntrospection = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'frames = []',
            'def inspect_driver():',
            '    frame = frames[-1].gi_frame',
            '    while frame is not None:',
            '        if "_tracecode_batch_builtins" in frame.f_globals:',
            '            return True',
            '        frame = frame.f_back',
            '    return False',
            'def solve(value):',
            '    frames.append((inspect_driver() for _ in [value]))',
            '    return next(frames[-1])',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const updateWrapperEscape = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'leaked = {}',
            'class Sink:',
            '    def __getattr__(self, name):',
            '        return leaked',
            'def solve(value):',
            '    update_wrapper(Sink(), TreeNode.get, assigned=(), updated=("__globals__",))',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const sharedDefaultCapture = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'from collections import Counter',
            'def solve(value, Counter=Counter):',
            '    Counter.tracecode_case_leak = value',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const sharedAttributeEscape = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'sink = json.JSONEncoder',
            'def hijack(self, values):',
            '    return "[" + ",".join(["{}" for _ in values]) + "]"',
            'sink.encode = hijack',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const mathModuleMutation = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    math.tracecode_case_leak = value',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const unknownImport = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'import numpy',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const unsupportedBuiltin = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(values):',
            '    return aiter(values)',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const serializationOverride = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'class EmptyEncoder:',
            '    def encode(self, value):',
            '        return ""',
            'json.JSONEncoder.iterencode = lambda self, value, _one_shot=False: ["\\\\\\\"forged\\\\\\\""]',
            'json.encoder.encode_basestring_ascii = lambda value: "\\\\\\\"forged\\\\\\\""',
            '_MAX_SERIALIZED_ITEMS = 10**18',
            '_MAX_SERIALIZED_NODES = 10**18',
            '_MAX_SERIALIZED_BYTES = 10**18',
            '_serialize = lambda *args, **kwargs: "bypass"',
            '_TracecodeSerializationLimit = Exception',
            'json.JSONEncoder = EmptyEncoder',
            'json.dumps = lambda *args, **kwargs: ""',
            'def solve(value):',
            '    if value == 0:',
            '        return "x" * (9 * 1024 * 1024)',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const catchAllException = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    try:',
            '        return value',
            '    except:',
            '        return 0',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const baseExceptionCatch = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    try:',
            '        return value',
            '    except BaseException:',
            '        return 0',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const exceptionFinalizer = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    try:',
            '        return value',
            '    finally:',
            '        return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const objectFinalizer = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'class Finalizer:',
            '    def __del__(self):',
            '        return None',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const generatorFinalizer = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'exit_kind = GeneratorExit',
            'def linger():',
            '    try:',
            '        yield 1',
            '    except (Exception, exit_kind):',
            '        while True:',
            '            pass',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const exceptionHierarchyCatch = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    catcher = Exception.mro()[1]',
            '    try:',
            '        return value',
            '    except catcher:',
            '        return 0',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const cachedDecorator = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            '@cache',
            'def identity(value):',
            '    return value',
            'def solve(value):',
            '    return identity(value)',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const transitiveTraversal = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'import typing',
            'def solve(vector):',
            '    if vector == "json":',
            '        return json.codecs.builtins.getattr(solve, "_" + "_" + "globals__")["_tracecode_batch_host_import"]("js")',
            '    if vector == "re":',
            '        return re.enum.bltns.getattr(solve, "_" + "_" + "globals__")["_tracecode_batch_host_import"]("js")',
            '    if vector == "typing":',
            '        return typing.contextlib.os.getcwd()',
            '    return 7',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const treeNodeFreshness = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    try:',
            '        before = TreeNode.seen',
            '    except AttributeError:',
            '        before = 0',
            '    TreeNode.seen = value',
            '    node = TreeNode(value)',
            '    return [before, node["val"], node.get("value"), repr(node)]',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
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
      const benchmarkCode = [
        'def burn(values: list[int]):',
        '    values.append(101)',
        '    return [sum(values), len(values)]',
      ].join('\\n');
      const tracePrepareStartedAt = performance.now();
      const benchmarkTrace = await preparationWorker.request('prepare-program', {
        mode: 'trace',
        code: benchmarkCode,
        functionName: 'burn',
        executionStyle: 'function',
        traceOptions: { maxTraceSteps: 1000 },
      });
      const tracePrepareMs = performance.now() - tracePrepareStartedAt;
      const codePrepareStartedAt = performance.now();
      const benchmarkCodeOnly = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: benchmarkCode,
        functionName: 'burn',
        executionStyle: 'function',
      });
      const codePrepareMs = performance.now() - codePrepareStartedAt;
      const parity = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve(nums: list[int], points: list[tuple[int, int]], base, exp, modulus):',
          '    print("hello")',
          '    nums.sort()',
          '    return [pow(base, exp, modulus), len(set(points)), nums]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const inplace = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve(nums):',
          '    nums.sort()',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const serialized = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'class TreeChild(TreeNode):',
          '    pass',
          'class ListChild(ListNode):',
          '    pass',
          'class TextChild(str):',
          '    pass',
          'class LyingText(str):',
          '    def __len__(self):',
          '        return 0',
          '    def __iter__(self):',
          '        return iter(())',
          'class IntChild(int):',
          '    pass',
          'class FloatChild(float):',
          '    pass',
          'def solve(value):',
          '    if value < 0:',
          '        return LyingText(chr(0x1F600) * -value)',
          '    if value == 8:',
          '        return "after-limit"',
          '    return [',
          '        TreeChild(value, TreeChild(value + 1)),',
          '        ListChild(value, ListChild(value + 1)),',
          '        solve,',
          '        TextChild("tag"),',
          '        IntChild(value + 2),',
          '        FloatChild(value + 3.5),',
          '    ]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const trustedPreparationParameterNames = Array.from(
        { length: 500 },
        (_, index) => 'a' + String(index)
      );
      const trustedPreparationSignature = trustedPreparationParameterNames
        .map((name) => name + ': list[int]')
        .join(', ');
      const trustedPreparationBudget = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(' + trustedPreparationSignature + '):',
            '    return 1',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const learnerHydrationBudget = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'class Box:',
            '    def __init__(self, value):',
            '        total = 0',
            '        for index in range(6000):',
            '            total += index',
            '        self.value = value',
            'def solve(item: Box):',
            '    return item.value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const dequeExecution = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'from collections import deque',
          'def solve(values):',
          '    queue = deque(values)',
          '    queue.append(9)',
          '    return [queue.popleft(), list(queue)]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const customClassHydration = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'class Config:',
          '    def __init__(self, limit: int):',
          '        self.limit = limit',
          'def solve(config: Config):',
          '    return config.limit + 1',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const globalInput = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'input_size = len(nums)',
          'def helper():',
          '    return input_size + len(nums)',
          'def solve(nums):',
          '    nums.append(9)',
          '    return [helper(), nums]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const globalRebinding = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve():',
          '    global nums',
          '    nums = sorted(nums)',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const heterogeneousTuple = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'class Config:',
          '    def __init__(self, limit: int):',
          '        self.limit = limit',
          'def solve(pair: tuple[int, Config]):',
          '    return [pair[0], pair[1].limit]',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const matrixInplace = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'from typing import List',
          'def solve(matrix: List[List[int]]):',
          '    matrix[0].reverse()',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const nodeAnnotationParity = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve(root: TreeNode):',
          '    return isinstance(root, dict)',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const moduleLookup = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'import math',
          'def solve(count):',
          '    total = 0.0',
          '    for value in range(count):',
          '        total += math.sqrt(value)',
          '    return int(total)',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const localCount = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve(values):',
          '    count = 0',
          '    for value in values:',
          '        count += value',
          '    return count',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const raising = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'def solve(value):',
          '    print("before")',
          '    raise ValueError("bad input\\\\nignored")',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const hostileException = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'class Boom(Exception):',
          '    def __str__(self):',
          '        while True:',
          '            pass',
          'def solve(value):',
          '    if value == 0:',
          '        raise Boom()',
          '    return value',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const wallClockBatch = await preparationWorker.request('prepare-program', {
        mode: 'code',
        code: [
          'class Slow:',
          '    def __getattribute__(self, name):',
          '        while True:',
          '            pass',
          'if phase == "module" and value == 0:',
          '    while True:',
          '        pass',
          'def solve(value, phase):',
          '    if phase == "serialize" and value == 0:',
          '        return Slow()',
          '    return value',
        ].join('\\n'),
        functionName: 'solve',
        executionStyle: 'function',
      });
      const judgeCompatibleWallClock = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def solve(value):',
            '    items = (item for item in [value])',
            '    if value == 0:',
            '        while True:',
            '            pass',
            '    return list(items)[0]',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const judgeCompatibleSerializationWallClock =
        await preparationWorker.request('prepare-program', {
          mode: 'code',
          code: [
            'class SlowDescriptor:',
            '    def __get__(self, instance, owner):',
            '        while True:',
            '            pass',
            '    def __set__(self, instance, value):',
            '        return None',
            'class SlowSerialization(TreeNode):',
            '    left = SlowDescriptor()',
            '    def __init__(self):',
            '        self.val = 0',
            '        self.right = None',
            'def solve(value):',
            '    items = (item for item in [value])',
            '    if value == 0:',
            '        return SlowSerialization()',
            '    return list(items)[0]',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        });
      const judgeCompatibleSignatureWallClock =
        await preparationWorker.request('prepare-program', {
          mode: 'code',
          code: [
            'class SignatureHook:',
            '    def __get__(self, instance, owner):',
            '        if value == 0:',
            '            while True:',
            '                pass',
            '        raise AttributeError("missing")',
            'class Solver:',
            '    __signature__ = SignatureHook()',
            '    def __call__(self, value):',
            '        return value',
            'solve = Solver()',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        });
      const reservedGuardCollision = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def _interview_guard_start():',
            '    return None',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const reservedGuardAlias = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'from math import inf as _interview_case_deadline',
            'match 1:',
            '    case _interview_match_capture:',
            '        pass',
            'def solve(value):',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const internalNameWallClock = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'def _serialize(value):',
            '    if value == 0:',
            '        while True:',
            '            pass',
            '    return value',
            'def solve(value):',
            '    items = (item for item in [value])',
            '    return _serialize(list(items)[0])',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const contextManager = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'class Scope:',
            '    def __enter__(self):',
            '        return self',
            '    def __exit__(self, *args):',
            '        return True',
            'def solve(value):',
            '    with Scope():',
            '        return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const traceExceptionWallClock = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'trace',
          code: [
            'try:',
            '    if phase == "module" and value == 0:',
            '        while True:',
            '            pass',
            'except Exception:',
            '    pass',
            'def solve(value, phase):',
            '    try:',
            '        if phase == "call" and value == 0:',
            '            while True:',
            '                pass',
            '    except Exception:',
            '        return -1',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
          traceOptions: { maxTraceSteps: 1000 },
        }
      );
      const hostileSerialization = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'class Blob:',
            '    pass',
            'class Holder:',
            '    def __getattr__(self, name):',
            '        return Blob()',
            'class Weird:',
            '    def __getattribute__(self, name):',
            '        return Holder()',
            'def solve(value):',
            '    if value < -1:',
            '        return "x" * (-value)',
            '    if value == -1:',
            '        return "x" * (9 * 1024 * 1024)',
            '    if value == 0:',
            '        return Weird()',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      const sharedStateRegistration = await preparationWorker.request(
        'prepare-program',
        {
          mode: 'code',
          code: [
            'import collections.abc',
            'def solve(value):',
            '    collections.abc.Iterable.register(int)',
            '    return value',
          ].join('\\n'),
          functionName: 'solve',
          executionStyle: 'function',
        }
      );
      for (const [name, prepared] of Object.entries({
        unsupportedBuiltin,
        serializationOverride,
        catchAllException,
        baseExceptionCatch,
        exceptionHierarchyCatch,
        exceptionFinalizer,
        objectFinalizer,
        generatorFinalizer,
        transitiveTraversal,
        treeNodeFreshness,
        dequeExecution,
        customClassHydration,
        globalInput,
        globalRebinding,
        heterogeneousTuple,
        matrixInplace,
        nodeAnnotationParity,
        moduleLookup,
        localCount,
        raising,
        hostileException,
        hostileSerialization,
        wallClockBatch,
        judgeCompatibleWallClock,
        judgeCompatibleSerializationWallClock,
        judgeCompatibleSignatureWallClock,
        reservedGuardCollision,
        sharedStateRegistration,
      })) {
        if (!prepared?.success || !prepared?.artifact) {
          throw new Error(
            'Python adversarial preparation failed for ' + name + ': ' +
            JSON.stringify(prepared)
          );
        }
      }
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
      let algorithmBatchRun;
      const fastParityRuns = {};
      try {
        batchRun = await batchClient.request('execute-prepared-program-batch', {
          artifact: batch.artifact,
          mode: 'code',
          inputBatch: ['create', 'inspect', 'modify', 'delete'].map((action) => ({
            action,
            items: sharedInput,
          })),
        });
        algorithmBatchRun = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: algorithmBatch.artifact,
            mode: 'code',
            inputBatch: [{ value: -1 }, { value: 1 }, { value: 2 }],
            limits: {
              maxLineEvents: 10000,
              maxSingleLineHits: 1000,
              maxCallDepth: 100,
            },
          }
        );
        fastParityRuns.parity = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: parity.artifact,
            mode: 'code',
            inputBatch: [{
              nums: [3, 1, 2],
              points: [[1, 2], [3, 4]],
              base: 2,
              exp: 10,
              modulus: 1000,
              ignoredBySignature: true,
            }],
          }
        );
        fastParityRuns.parityCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: parity.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              nums: [3, 1, 2],
              points: [[1, 2], [3, 4]],
              base: 2,
              exp: 10,
              modulus: 1000,
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.inplace = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: inplace.artifact,
            mode: 'code',
            inputBatch: [{ nums: [3, 1, 2] }],
          }
        );
        fastParityRuns.inplaceCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: inplace.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              nums: [3, 1, 2],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.serialized = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: serialized.artifact,
            mode: 'code',
            inputBatch: [
              { value: 7 },
              { value: -710000 },
              { value: 8 },
            ],
          }
        );
        fastParityRuns.serializedCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: serialized.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              value: 7,
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.trustedPreparationBudget = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: trustedPreparationBudget.artifact,
            mode: 'code',
            inputBatch: [Object.fromEntries(
              trustedPreparationParameterNames.map((name) => [name, [1]])
            )],
            limits: {
              interviewGuard: true,
              maxLineEvents: 10000,
              maxSingleLineHits: 10000,
            },
          }
        );
        fastParityRuns.learnerHydrationBudget = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: learnerHydrationBudget.artifact,
            mode: 'code',
            inputBatch: [{ item: { value: 0 } }],
            limits: {
              interviewGuard: true,
              maxLineEvents: 10000,
              maxSingleLineHits: 10000,
            },
          }
        );
        fastParityRuns.dequeExecution = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: dequeExecution.artifact,
            mode: 'code',
            inputBatch: [{ values: [1, 2] }],
          }
        );
        fastParityRuns.dequeExecutionCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: dequeExecution.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              values: [1, 2],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.customClassHydration = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: customClassHydration.artifact,
            mode: 'code',
            inputBatch: [{ config: { limit: 4 } }],
          }
        );
        fastParityRuns.customClassHydrationCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: customClassHydration.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              config: { limit: 4 },
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.globalInput = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: globalInput.artifact,
            mode: 'code',
            inputBatch: [{ nums: [1, 2] }],
          }
        );
        fastParityRuns.globalInputCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: globalInput.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              nums: [1, 2],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.globalRebinding = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: globalRebinding.artifact,
            mode: 'code',
            inputBatch: [{ nums: [3, 1, 2] }],
          }
        );
        fastParityRuns.globalRebindingCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: globalRebinding.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              nums: [3, 1, 2],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.heterogeneousTuple = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: heterogeneousTuple.artifact,
            mode: 'code',
            inputBatch: [{ pair: [1, { limit: 4 }] }],
          }
        );
        fastParityRuns.heterogeneousTupleCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: heterogeneousTuple.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              pair: [1, { limit: 4 }],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.matrixInplace = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: matrixInplace.artifact,
            mode: 'code',
            inputBatch: [{ matrix: [[1, 2, 3], [4, 5, 6]] }],
          }
        );
        fastParityRuns.matrixInplaceCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: matrixInplace.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              matrix: [[1, 2, 3], [4, 5, 6]],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.nodeAnnotationParity = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: nodeAnnotationParity.artifact,
            mode: 'code',
            inputBatch: [{ root: { val: 1 } }],
          }
        );
        fastParityRuns.nodeAnnotationParityCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: nodeAnnotationParity.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              root: { val: 1 },
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.moduleLookup = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: moduleLookup.artifact,
            mode: 'code',
            inputBatch: [{ count: 1000 }],
          }
        );
        fastParityRuns.moduleLookupCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: moduleLookup.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              count: 1000,
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.sourceCodeBinding = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: {
              ...parity.artifact,
              userCode: raising.artifact.userCode,
            },
            mode: 'code',
            inputBatch: [{
              nums: [3, 1, 2],
              points: [[1, 2], [3, 4]],
              base: 2,
              exp: 10,
              modulus: 1000,
            }],
          }
        );
        fastParityRuns.profileRecheck = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: {
              ...frameIntrospection.artifact,
              isolationProfile: { tier: 'algorithm-fast', reasons: [] },
              algorithmFastBatchCode: parity.artifact.algorithmFastBatchCode,
            },
            mode: 'code',
            inputBatch: [{ value: 1 }],
          }
        );
        fastParityRuns.localCount = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: localCount.artifact,
            mode: 'code',
            inputBatch: [{ values: [1, 2, 3] }],
          }
        );
        fastParityRuns.localCountCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: localCount.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              values: [1, 2, 3],
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.raising = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: raising.artifact,
            mode: 'code',
            inputBatch: [{ value: 1 }],
          }
        );
        fastParityRuns.raisingCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: raising.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{
              value: 1,
              ignoredBySignature: { __type__: 'CompatibilitySentinel' },
            }],
          }
        );
        fastParityRuns.hostileException = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: hostileException.artifact,
            mode: 'code',
            inputBatch: [{ value: 0 }, { value: 1 }],
            limits: { wallClockMs: 25 },
          }
        );
        fastParityRuns.hostileSerialization = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: hostileSerialization.artifact,
            mode: 'code',
            inputBatch: [{ value: 0 }, { value: 1 }],
          }
        );
        fastParityRuns.serializationOverride = { results: [] };
        for (const value of [0, 1]) {
          const hardClient = await createClient(
            'serialization-override-' + value
          );
          const hardStartedAt = performance.now();
          try {
            fastParityRuns.serializationOverride.results.push(
              await hardClient.request('execute-prepared-program', {
                artifact: serializationOverride.artifact,
                mode: 'code',
                inputs: { value },
              })
            );
          } finally {
            executions.push({
              ...hardClient.metrics(),
              executionMs: performance.now() - hardStartedAt,
            });
            hardClient.terminate();
          }
        }
        fastParityRuns.serializationDag = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: hostileSerialization.artifact,
            mode: 'code',
            inputBatch: [{ value: -1 }, { value: 1 }],
            limits: { wallClockMs: 250 },
          }
        );
        fastParityRuns.serializationDagCompatibility = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: hostileSerialization.artifact,
            forceJudgeCompatible: true,
            mode: 'code',
            inputBatch: [{ value: -1 }, { value: 1 }],
            limits: { wallClockMs: 250 },
          }
        );
        const aggregateOutput = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: hostileSerialization.artifact,
            mode: 'code',
            inputBatch: [
              { value: -(6 * 1024 * 1024) },
              { value: -(6 * 1024 * 1024) },
              { value: -(6 * 1024 * 1024) },
              { value: -(6 * 1024 * 1024) },
              { value: -(6 * 1024 * 1024) },
              { value: -(6 * 1024 * 1024) },
              { value: 1 },
            ],
          }
        );
        fastParityRuns.aggregateOutput = {
          ...aggregateOutput,
          results: (aggregateOutput.results || []).map((entry) => ({
            ...entry,
            outputLength:
              typeof entry.output === 'string' ? entry.output.length : undefined,
            output: typeof entry.output === 'string' ? undefined : entry.output,
          })),
        };
        fastParityRuns.oneOffSerializationLimit = await batchClient.request(
          'execute-code',
          {
            code: [
              'class EmptyEncoder:',
              '    def encode(self, value):',
              '        return ""',
              'json.JSONEncoder.iterencode = lambda self, value, _one_shot=False: ["\\\\\\\"forged\\\\\\\""]',
              'json.encoder.encode_basestring_ascii = lambda value: "\\\\\\\"forged\\\\\\\""',
              '_serialize = lambda *args, **kwargs: "bypass"',
              '_TracecodeSerializationLimit = Exception',
              'json.JSONEncoder = EmptyEncoder',
              'json.dumps = lambda *args, **kwargs: ""',
              'def solve():',
              '    return "x" * (9 * 1024 * 1024)',
            ].join('\\n'),
            functionName: 'solve',
            inputs: {},
            executionStyle: 'function',
          }
        );
        fastParityRuns.oneOffLargeMatrix = await batchClient.request(
          'execute-code',
          {
            code: [
              'def solve():',
              '    return [[1] * 100 for _ in range(100)]',
            ].join('\\n'),
            functionName: 'solve',
            inputs: {},
            executionStyle: 'function',
          }
        );
        fastParityRuns.wallClockModule = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: wallClockBatch.artifact,
            mode: 'code',
            inputBatch: [
              { value: 0, phase: 'module' },
              { value: 1, phase: 'module' },
            ],
            limits: { wallClockMs: 25 },
          }
        );
        fastParityRuns.wallClockSerialization = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: wallClockBatch.artifact,
            mode: 'code',
            inputBatch: [
              { value: 0, phase: 'serialize' },
              { value: 1, phase: 'serialize' },
            ],
            limits: { wallClockMs: 25 },
          }
        );
        fastParityRuns.judgeCompatibleWallClock = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: judgeCompatibleWallClock.artifact,
            mode: 'code',
            inputBatch: [{ value: 0 }, { value: 1 }],
            limits: { wallClockMs: 25 },
          }
        );
        fastParityRuns.judgeCompatibleSerializationWallClock =
          await batchClient.request('execute-prepared-program-batch', {
            artifact: judgeCompatibleSerializationWallClock.artifact,
            mode: 'code',
            inputBatch: [{ value: 0 }, { value: 1 }],
            limits: { wallClockMs: 25 },
          });
        fastParityRuns.judgeCompatibleSignatureWallClock =
          await batchClient.request('execute-prepared-program-batch', {
            artifact: judgeCompatibleSignatureWallClock.artifact,
            mode: 'code',
            inputBatch: [{ value: 0 }, { value: 1 }],
            limits: { wallClockMs: 25 },
          });
        fastParityRuns.treeNodeFreshness = await batchClient.request(
          'execute-prepared-program-batch',
          {
            artifact: treeNodeFreshness.artifact,
            mode: 'code',
            inputBatch: [{ value: 1 }, { value: 2 }],
          }
        );
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
      let mixedTraceBatch;
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
            mixedTraceBatch = await client.request('execute-prepared-program-batch', {
              artifact: trace.artifact,
              mode: 'trace',
              inputBatch: [{ value: 1 }, { value: 2 }, { value: 3 }],
              traceEnabledBatch: [true, false, true],
            });
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

      const benchmarkClient = await createClient('on-demand-benchmark');
      const benchmarkInputs = [20000, 30000, 40000].map((length) => ({
        values: Array.from({ length }, (_, index) => index % 97),
      }));
      const benchmarkInputLengths = benchmarkInputs.map(({ values }) => values.length);
      const allDisabledMs = [];
      const allDisabledPhaseMs = [];
      const cleanMs = [];
      const cleanPhaseMs = [];
      const mixedOneArtifactMs = [];
      const mixedDualArtifactMs = [];
      let benchmarkOutputsMatch = true;
      let disabledEventsEmpty = true;
      const requestTimed = async (type, payload) => {
        const startedAt = performance.now();
        const response = await benchmarkClient.request(type, payload);
        const results = response.results || [];
        const phaseNames = [
          'inputLiteralMs',
          'namespaceCreateMs',
          'guardBeginMs',
          'bindingMs',
          'compiledExecutionMs',
          'guardRestoreMs',
          'namespaceDestroyMs',
          'resultParseMs',
          'filesystemBeginMs',
          'filesystemRestoreMs',
        ];
        const phaseMs = Object.fromEntries(
          phaseNames.map((name) => [
            name,
            results.reduce(
              (total, entry) => total + (entry.timings?.[name] || 0),
              0
            ),
          ])
        );
        return {
          response,
          ms: performance.now() - startedAt,
          phaseMs,
        };
      };
      const runAllDisabled = () => requestTimed('execute-prepared-program-batch', {
        artifact: benchmarkTrace.artifact,
        mode: 'trace',
        inputBatch: benchmarkInputs,
        traceEnabledBatch: [false, false, false],
      });
      const runClean = () => requestTimed('execute-prepared-program-batch', {
        artifact: benchmarkCodeOnly.artifact,
        mode: 'code',
        inputBatch: benchmarkInputs,
      });
      const runMixedOneArtifact = () => requestTimed('execute-prepared-program-batch', {
        artifact: benchmarkTrace.artifact,
        mode: 'trace',
        inputBatch: benchmarkInputs,
        traceEnabledBatch: [true, false, false],
      });
      const runMixedDualArtifact = async () => {
        const startedAt = performance.now();
        const traced = await benchmarkClient.request('execute-prepared-program-batch', {
          artifact: benchmarkTrace.artifact,
          mode: 'trace',
          inputBatch: benchmarkInputs.slice(0, 1),
          traceEnabledBatch: [true],
        });
        const clean = await benchmarkClient.request('execute-prepared-program-batch', {
          artifact: benchmarkCodeOnly.artifact,
          mode: 'code',
          inputBatch: benchmarkInputs.slice(1),
        });
        return {
          response: {
            success: traced.success && clean.success,
            results: [...(traced.results || []), ...(clean.results || [])],
          },
          ms: performance.now() - startedAt,
        };
      };
      try {
        await runAllDisabled();
        await runClean();
        await runMixedOneArtifact();
        await runMixedDualArtifact();
        for (let iteration = 0; iteration < 6; iteration += 1) {
          const disabledPair = iteration % 2 === 0
            ? [await runAllDisabled(), await runClean()]
            : [await runClean(), await runAllDisabled()].reverse();
          const [disabled, clean] = disabledPair;
          allDisabledMs.push(disabled.ms);
          allDisabledPhaseMs.push(disabled.phaseMs);
          cleanMs.push(clean.ms);
          cleanPhaseMs.push(clean.phaseMs);
          const disabledResults = disabled.response.results || [];
          const cleanResults = clean.response.results || [];
          benchmarkOutputsMatch = benchmarkOutputsMatch &&
            JSON.stringify(disabledResults.map((entry) => entry.output)) ===
              JSON.stringify(cleanResults.map((entry) => entry.output));
          disabledEventsEmpty = disabledEventsEmpty && disabledResults.every(
            (entry) => Array.isArray(entry.trace?.events) && entry.trace.events.length === 0
          );

          const mixedPair = iteration % 2 === 0
            ? [await runMixedOneArtifact(), await runMixedDualArtifact()]
            : [await runMixedDualArtifact(), await runMixedOneArtifact()].reverse();
          const [oneArtifact, dualArtifact] = mixedPair;
          mixedOneArtifactMs.push(oneArtifact.ms);
          mixedDualArtifactMs.push(dualArtifact.ms);
          benchmarkOutputsMatch = benchmarkOutputsMatch &&
            JSON.stringify((oneArtifact.response.results || []).map((entry) => entry.output)) ===
              JSON.stringify((dualArtifact.response.results || []).map((entry) => entry.output));
        }
      } finally {
        executions.push(benchmarkClient.metrics());
        benchmarkClient.terminate();
      }
      const onDemandBenchmark = {
        tracePrepareMs,
        codePrepareMs,
        allDisabledMs,
        allDisabledPhaseMs,
        cleanMs,
        cleanPhaseMs,
        mixedOneArtifactMs,
        mixedDualArtifactMs,
        outputsMatch: benchmarkOutputsMatch,
        disabledEventsEmpty,
        callerInputsUnchanged: benchmarkInputs.every(
          ({ values }, index) => values.length === benchmarkInputLengths[index]
        ),
      };

      return {
        preparations: {
          code,
          trace,
          batch,
          limited,
          algorithmBatch,
          defaultModuleMutation,
          shadowedModuleMutation,
          reflectiveOperator,
          reflectiveFormat,
          stringAnnotation,
          nestedStringAnnotation,
          singleDispatch,
          frameIntrospection,
          updateWrapperEscape,
          sharedAttributeEscape,
          sharedDefaultCapture,
          sharedStateRegistration,
          mathModuleMutation,
          unknownImport,
          unsupportedBuiltin,
          serializationOverride,
          catchAllException,
          baseExceptionCatch,
          exceptionHierarchyCatch,
          exceptionFinalizer,
          objectFinalizer,
          generatorFinalizer,
          cachedDecorator,
          transitiveTraversal,
          treeNodeFreshness,
          traceLimited,
          invalid,
          parity,
          inplace,
          serialized,
          trustedPreparationBudget,
          learnerHydrationBudget,
          dequeExecution,
          customClassHydration,
          globalInput,
          globalRebinding,
          heterogeneousTuple,
          matrixInplace,
          nodeAnnotationParity,
          moduleLookup,
          localCount,
          raising,
          hostileException,
          hostileSerialization,
          wallClockBatch,
          judgeCompatibleWallClock,
          judgeCompatibleSerializationWallClock,
          judgeCompatibleSignatureWallClock,
          reservedGuardCollision,
          reservedGuardAlias,
          internalNameWallClock,
          contextManager,
          traceExceptionWallClock,
        },
        isolationProfiles: {
          code: code.artifact?.isolationProfile,
          batch: batch.artifact?.isolationProfile,
          trace: trace.artifact?.isolationProfile,
          limited: limited.artifact?.isolationProfile,
          algorithmBatch: algorithmBatch.artifact?.isolationProfile,
          defaultModuleMutation:
            defaultModuleMutation.artifact?.isolationProfile,
          shadowedModuleMutation:
            shadowedModuleMutation.artifact?.isolationProfile,
          reflectiveOperator:
            reflectiveOperator.artifact?.isolationProfile,
          reflectiveFormat:
            reflectiveFormat.artifact?.isolationProfile,
          stringAnnotation:
            stringAnnotation.artifact?.isolationProfile,
          nestedStringAnnotation:
            nestedStringAnnotation.artifact?.isolationProfile,
          singleDispatch:
            singleDispatch.artifact?.isolationProfile,
          frameIntrospection:
            frameIntrospection.artifact?.isolationProfile,
          updateWrapperEscape:
            updateWrapperEscape.artifact?.isolationProfile,
          sharedAttributeEscape:
            sharedAttributeEscape.artifact?.isolationProfile,
          sharedDefaultCapture:
            sharedDefaultCapture.artifact?.isolationProfile,
          sharedStateRegistration:
            sharedStateRegistration.artifact?.isolationProfile,
          mathModuleMutation:
            mathModuleMutation.artifact?.isolationProfile,
          unknownImport: unknownImport.artifact?.isolationProfile,
          unsupportedBuiltin: unsupportedBuiltin.artifact?.isolationProfile,
          serializationOverride:
            serializationOverride.artifact?.isolationProfile,
          catchAllException: catchAllException.artifact?.isolationProfile,
          baseExceptionCatch: baseExceptionCatch.artifact?.isolationProfile,
          exceptionHierarchyCatch:
            exceptionHierarchyCatch.artifact?.isolationProfile,
          exceptionFinalizer: exceptionFinalizer.artifact?.isolationProfile,
          objectFinalizer: objectFinalizer.artifact?.isolationProfile,
          generatorFinalizer: generatorFinalizer.artifact?.isolationProfile,
          cachedDecorator: cachedDecorator.artifact?.isolationProfile,
          transitiveTraversal: transitiveTraversal.artifact?.isolationProfile,
          treeNodeFreshness: treeNodeFreshness.artifact?.isolationProfile,
          parity: parity.artifact?.isolationProfile,
          inplace: inplace.artifact?.isolationProfile,
          serialized: serialized.artifact?.isolationProfile,
          trustedPreparationBudget:
            trustedPreparationBudget.artifact?.isolationProfile,
          learnerHydrationBudget:
            learnerHydrationBudget.artifact?.isolationProfile,
          dequeExecution: dequeExecution.artifact?.isolationProfile,
          customClassHydration: customClassHydration.artifact?.isolationProfile,
          globalInput: globalInput.artifact?.isolationProfile,
          globalRebinding: globalRebinding.artifact?.isolationProfile,
          heterogeneousTuple: heterogeneousTuple.artifact?.isolationProfile,
          matrixInplace: matrixInplace.artifact?.isolationProfile,
          nodeAnnotationParity: nodeAnnotationParity.artifact?.isolationProfile,
          moduleLookup: moduleLookup.artifact?.isolationProfile,
          localCount: localCount.artifact?.isolationProfile,
          raising: raising.artifact?.isolationProfile,
          hostileException: hostileException.artifact?.isolationProfile,
          hostileSerialization:
            hostileSerialization.artifact?.isolationProfile,
          wallClockBatch: wallClockBatch.artifact?.isolationProfile,
          judgeCompatibleWallClock:
            judgeCompatibleWallClock.artifact?.isolationProfile,
          judgeCompatibleSerializationWallClock:
            judgeCompatibleSerializationWallClock.artifact?.isolationProfile,
          judgeCompatibleSignatureWallClock:
            judgeCompatibleSignatureWallClock.artifact?.isolationProfile,
          reservedGuardCollision:
            reservedGuardCollision.artifact?.isolationProfile,
          reservedGuardAlias:
            reservedGuardAlias.artifact?.isolationProfile,
          internalNameWallClock:
            internalNameWallClock.artifact?.isolationProfile,
          contextManager: contextManager.artifact?.isolationProfile,
          traceExceptionWallClock:
            traceExceptionWallClock.artifact?.isolationProfile,
          benchmarkCode: benchmarkCodeOnly.artifact?.isolationProfile,
          benchmarkHasFastBatch:
            typeof benchmarkCodeOnly.artifact?.algorithmFastBatchCode === 'string',
        },
        codeRuns,
        batchRun,
        algorithmBatchRun,
        fastParityRuns,
        traceRuns,
        mixedTraceBatch,
        legacyTrace,
        limitedRun,
        traceLimitedRun,
        onDemandBenchmark,
        preparationWorker: preparationMetrics,
        executions,
      };
    })()`);

    for (const mode of [
      'code',
      'trace',
      'batch',
      'limited',
      'algorithmBatch',
      'defaultModuleMutation',
      'shadowedModuleMutation',
      'reflectiveOperator',
      'reflectiveFormat',
      'stringAnnotation',
      'nestedStringAnnotation',
      'singleDispatch',
      'frameIntrospection',
      'updateWrapperEscape',
      'sharedDefaultCapture',
      'mathModuleMutation',
      'unknownImport',
      'unsupportedBuiltin',
      'cachedDecorator',
      'transitiveTraversal',
      'treeNodeFreshness',
      'traceLimited',
      'parity',
      'inplace',
      'serialized',
      'dequeExecution',
      'customClassHydration',
      'globalInput',
      'globalRebinding',
      'heterogeneousTuple',
      'matrixInplace',
      'nodeAnnotationParity',
      'moduleLookup',
      'localCount',
      'raising',
    ]) {
      assertCondition(
        result.preparations[mode]?.success === true,
        `${mode} preparation failed: ${JSON.stringify(result.preparations[mode])}`
      );
      const preparation = result.preparations[mode];
      const artifact = preparation?.artifact as Record<string, unknown> | undefined;
      assertCondition(
        artifact?.schemaVersion === 'tracecode.python.prepared-program.v4' &&
          typeof artifact.userCode === 'string' &&
          typeof artifact.executorCode === 'string',
        `${mode} preparation did not return a portable code artifact`
      );
      if (mode === 'trace' || mode === 'traceLimited') {
        assertCondition(
          artifact.onDemandTracing === true,
          `${mode} preparation did not produce an on-demand trace artifact`
        );
      }
    }
    assertCondition(
      result.preparations.invalid?.success === false &&
        String(result.preparations.invalid?.error).length > 0,
      `Invalid Python prepared successfully: ${JSON.stringify(result.preparations.invalid)}`
    );
    assertCondition(
      result.isolationProfiles.code?.tier === 'hard-isolated' &&
        result.isolationProfiles.code.reasons.some(
          (reason: string) => reason.startsWith('denied-import:')
        ),
      `Python filesystem/interpreter-state code must select hard isolation: ${JSON.stringify(result.isolationProfiles.code)}`
    );
    assertCondition(
      result.isolationProfiles.batch?.tier === 'judge-compatible' &&
        result.isolationProfiles.batch.reasons.includes(
          'suspending-control-flow'
        ),
      `Python generic algorithm code must select retained Judge compatibility: ${JSON.stringify(result.isolationProfiles.batch)}`
    );
    assertCondition(
      result.isolationProfiles.trace?.tier === 'algorithm-fast' &&
        result.isolationProfiles.limited?.tier === 'algorithm-fast' &&
        result.isolationProfiles.algorithmBatch?.tier === 'algorithm-fast' &&
        result.isolationProfiles.benchmarkCode?.tier === 'algorithm-fast' &&
        result.isolationProfiles.parity?.tier === 'algorithm-fast' &&
        result.isolationProfiles.inplace?.tier === 'algorithm-fast' &&
        result.isolationProfiles.serialized?.tier === 'algorithm-fast' &&
        result.isolationProfiles.dequeExecution?.tier === 'algorithm-fast' &&
        result.isolationProfiles.customClassHydration?.tier === 'algorithm-fast' &&
        result.isolationProfiles.globalInput?.tier === 'algorithm-fast' &&
        result.isolationProfiles.globalRebinding?.tier === 'algorithm-fast' &&
        result.isolationProfiles.hostileException?.tier === 'algorithm-fast' &&
        result.isolationProfiles.hostileSerialization?.tier === 'algorithm-fast' &&
        result.isolationProfiles.wallClockBatch?.tier === 'algorithm-fast' &&
        result.isolationProfiles.cachedDecorator?.tier === 'algorithm-fast' &&
        result.isolationProfiles.benchmarkHasFastBatch === true,
      `Python algorithm code and batch-adjacent imports must select an explicit fast artifact: ${JSON.stringify(result.isolationProfiles)}`
    );
    assertCondition(
      result.isolationProfiles.defaultModuleMutation?.tier ===
        'hard-isolated' &&
        result.isolationProfiles.defaultModuleMutation.reasons.includes(
          'shared-state-write'
        ) &&
        result.isolationProfiles.shadowedModuleMutation?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.shadowedModuleMutation.reasons.includes(
          'rebound-default-binding:heapq'
        ),
      `Python fast-path admission did not hard-isolate default module mutation cases: ${JSON.stringify({
        defaultModuleMutation: result.isolationProfiles.defaultModuleMutation,
        shadowedModuleMutation: result.isolationProfiles.shadowedModuleMutation,
      })}`
    );
    assertCondition(
      result.isolationProfiles.reflectiveOperator?.tier === 'hard-isolated' &&
        result.isolationProfiles.reflectiveOperator.reasons.includes(
          'reflective-attribute:attrgetter'
        ) &&
        result.isolationProfiles.reflectiveFormat?.tier === 'hard-isolated' &&
        result.isolationProfiles.reflectiveFormat.reasons.includes(
          'reflective-attribute:format'
        ) &&
        result.isolationProfiles.stringAnnotation?.tier === 'hard-isolated' &&
        result.isolationProfiles.stringAnnotation.reasons.includes(
          'string-annotation'
        ) &&
        result.isolationProfiles.nestedStringAnnotation?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.nestedStringAnnotation.reasons.includes(
          'string-annotation'
        ),
      `Python fast-path admission did not hard-isolate reflective string/annotation cases: ${JSON.stringify({
        reflectiveOperator: result.isolationProfiles.reflectiveOperator,
        reflectiveFormat: result.isolationProfiles.reflectiveFormat,
        stringAnnotation: result.isolationProfiles.stringAnnotation,
        nestedStringAnnotation: result.isolationProfiles.nestedStringAnnotation,
      })}`
    );
    assertCondition(
      result.isolationProfiles.singleDispatch?.tier === 'hard-isolated' &&
        result.isolationProfiles.singleDispatch.reasons.includes(
          'evaluating-import:functools.singledispatch'
        ) &&
        result.isolationProfiles.frameIntrospection?.tier === 'hard-isolated' &&
        result.isolationProfiles.frameIntrospection.reasons.some(
          (reason: string) =>
            reason === 'reflective-attribute:gi_frame' ||
            reason === 'reflective-attribute:f_globals'
        ) &&
        result.isolationProfiles.frameIntrospection.reasons.includes(
          'suspending-control-flow'
        ) &&
        result.isolationProfiles.updateWrapperEscape?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.updateWrapperEscape.reasons.includes(
          'denied-name:update_wrapper'
        ) &&
        result.isolationProfiles.updateWrapperEscape.reasons.includes(
          'reflective-string-argument:__globals__'
        ),
      `Python fast-path admission did not hard-isolate reflective helper escapes: ${JSON.stringify({
        singleDispatch: result.isolationProfiles.singleDispatch,
        frameIntrospection: result.isolationProfiles.frameIntrospection,
        updateWrapperEscape: result.isolationProfiles.updateWrapperEscape,
      })}`
    );
    assertCondition(
      result.isolationProfiles.sharedAttributeEscape?.tier ===
        'hard-isolated' &&
        result.isolationProfiles.sharedAttributeEscape.reasons.includes(
          'shared-binding-escape:json'
        ) &&
        result.isolationProfiles.sharedDefaultCapture?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.sharedDefaultCapture.reasons.includes(
          'shared-binding-escape:Counter'
        ) &&
        result.isolationProfiles.sharedStateRegistration?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.sharedStateRegistration.reasons.includes(
          'shared-state-call:register'
        ) &&
        result.isolationProfiles.mathModuleMutation?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.mathModuleMutation.reasons.includes(
          'shared-state-write'
        ),
      `Python fast-path admission did not hard-isolate shared-state mutation cases: ${JSON.stringify({
        sharedAttributeEscape: result.isolationProfiles.sharedAttributeEscape,
        sharedDefaultCapture: result.isolationProfiles.sharedDefaultCapture,
        sharedStateRegistration: result.isolationProfiles.sharedStateRegistration,
        mathModuleMutation: result.isolationProfiles.mathModuleMutation,
      })}`
    );
    assertCondition(
      result.isolationProfiles.unknownImport?.tier === 'hard-isolated' &&
        result.isolationProfiles.unknownImport.reasons.includes(
          'denied-import:numpy'
        ) &&
        result.isolationProfiles.unsupportedBuiltin?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.unsupportedBuiltin.reasons.includes(
          'unsupported-builtin:aiter'
        ) &&
        result.isolationProfiles.serializationOverride?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.serializationOverride.reasons.includes(
          'shared-state-write'
        ),
      `Python fast-path admission did not hard-isolate import and builtin escape cases: ${JSON.stringify({
        unknownImport: result.isolationProfiles.unknownImport,
        unsupportedBuiltin: result.isolationProfiles.unsupportedBuiltin,
        serializationOverride: result.isolationProfiles.serializationOverride,
      })}`
    );
    assertCondition(
      result.isolationProfiles.catchAllException?.tier ===
        'hard-isolated' &&
        result.isolationProfiles.catchAllException.reasons.includes(
          'catch-all-exception-handler'
        ) &&
        result.isolationProfiles.baseExceptionCatch?.tier === 'hard-isolated' &&
        result.isolationProfiles.baseExceptionCatch.reasons.includes(
          'unsupported-builtin:BaseException'
        ) &&
        result.isolationProfiles.exceptionHierarchyCatch?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.exceptionHierarchyCatch.reasons.includes(
          'reflective-attribute:mro'
        ) &&
        result.isolationProfiles.exceptionFinalizer?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.exceptionFinalizer.reasons.includes(
          'exception-finalizer'
        ) &&
        result.isolationProfiles.objectFinalizer?.tier === 'hard-isolated' &&
        result.isolationProfiles.objectFinalizer.reasons.includes(
          'object-finalizer'
        ) &&
        result.isolationProfiles.generatorFinalizer?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.generatorFinalizer.reasons.includes(
          'generator-finalizer'
        ) &&
        result.isolationProfiles.contextManager?.tier === 'hard-isolated' &&
        result.isolationProfiles.contextManager.reasons.includes(
          'context-manager'
        ) &&
        result.isolationProfiles.reservedGuardCollision?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.reservedGuardCollision.reasons.includes(
          'reserved-runtime-binding:_interview_guard_start'
        ) &&
        result.isolationProfiles.reservedGuardAlias?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.reservedGuardAlias.reasons.includes(
          'reserved-runtime-binding:_interview_case_deadline'
        ) &&
        result.isolationProfiles.reservedGuardAlias.reasons.includes(
          'reserved-runtime-binding:_interview_match_capture'
        ) &&
        result.isolationProfiles.transitiveTraversal?.tier ===
          'hard-isolated' &&
        result.isolationProfiles.transitiveTraversal.reasons.some(
          (reason: string) =>
            reason.startsWith('transitive-shared-access:')
        ),
      `Python fast-path admission did not classify exception-only cases correctly: ${JSON.stringify({
        catchAllException: result.isolationProfiles.catchAllException,
        baseExceptionCatch: result.isolationProfiles.baseExceptionCatch,
        exceptionHierarchyCatch: result.isolationProfiles.exceptionHierarchyCatch,
        exceptionFinalizer: result.isolationProfiles.exceptionFinalizer,
      })}`
    );
    assertCondition(
      result.preparationWorker.prepareRequests === 60,
      `Preparation worker received ${String(result.preparationWorker.prepareRequests)} preparations instead of sixty`
    );
    const algorithmBatchResults = result.algorithmBatchRun.results as Array<{
      success?: boolean;
      output?: unknown;
      timeoutReason?: string;
      timings?: { algorithmFastBatch?: boolean };
    }>;
    assertCondition(
      algorithmBatchResults.length === 3 &&
        algorithmBatchResults[0]?.success === false &&
        ['line-limit', 'single-line-limit'].includes(
          algorithmBatchResults[0]?.timeoutReason ?? ''
        ) &&
        algorithmBatchResults[1]?.success === true &&
        algorithmBatchResults[2]?.success === true &&
        algorithmBatchResults[1]?.output === algorithmBatchResults[2]?.output &&
        algorithmBatchResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `Python algorithm-fast batches must enforce limits, continue safely, and reset RNG state: ${JSON.stringify(result.algorithmBatchRun)}`
    );
    const hostileExceptionResults = result.fastParityRuns.hostileException
      .results as Array<{
        success?: boolean;
        output?: unknown;
        error?: string;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      hostileExceptionResults.length === 2 &&
        hostileExceptionResults[0]?.success === false &&
        hostileExceptionResults[0]?.timeoutReason === 'client-timeout' &&
        hostileExceptionResults[1]?.success === true &&
        hostileExceptionResults[1]?.output === 1 &&
        hostileExceptionResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `A hostile exception formatter escaped the per-case fast-batch envelope: ${JSON.stringify(result.fastParityRuns.hostileException)}`
    );
    const hostileSerializationResults = result.fastParityRuns
      .hostileSerialization.results as Array<{
        success?: boolean;
        output?: unknown;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      hostileSerializationResults.length === 2 &&
        hostileSerializationResults[0]?.success === true &&
        (hostileSerializationResults[0]?.output as { __type__?: string })
          ?.__type__ === 'Weird' &&
        hostileSerializationResults[1]?.success === true &&
        hostileSerializationResults[1]?.output === 1 &&
        hostileSerializationResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `Hostile class metadata poisoned fast-batch serialization: ${JSON.stringify(result.fastParityRuns.hostileSerialization)}`
    );
    const serializationOverrideResults = result.fastParityRuns
      .serializationOverride.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
      }>;
    assertCondition(
      serializationOverrideResults.length === 2 &&
        serializationOverrideResults[0]?.success === false &&
        serializationOverrideResults[0]?.timeoutReason ===
          'serialization-limit' &&
        serializationOverrideResults[1]?.success === true &&
        serializationOverrideResults[1]?.output === 1,
      `Compatibility learner globals bypassed the trusted serializer closure: ${JSON.stringify(serializationOverrideResults)}`
    );
    const trustedPreparationBudgetResults = result.fastParityRuns
      .trustedPreparationBudget.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    const learnerHydrationBudgetResults = result.fastParityRuns
      .learnerHydrationBudget.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      result.isolationProfiles.trustedPreparationBudget?.tier ===
        'algorithm-fast' &&
        trustedPreparationBudgetResults.length === 1 &&
        trustedPreparationBudgetResults[0]?.success === true &&
        trustedPreparationBudgetResults[0]?.output === 1 &&
        trustedPreparationBudgetResults[0]?.timings?.algorithmFastBatch ===
          true,
      `Trusted annotation/signature preparation consumed learner line budget: ${JSON.stringify({ profile: result.isolationProfiles.trustedPreparationBudget, results: trustedPreparationBudgetResults })}`
    );
    assertCondition(
      result.isolationProfiles.learnerHydrationBudget?.tier ===
        'algorithm-fast' &&
        learnerHydrationBudgetResults.length === 1 &&
        learnerHydrationBudgetResults[0]?.success === false &&
        learnerHydrationBudgetResults[0]?.timeoutReason === 'line-limit' &&
        learnerHydrationBudgetResults[0]?.timings?.algorithmFastBatch === true,
      `Learner code invoked during trusted hydration escaped learner line budget: ${JSON.stringify({ profile: result.isolationProfiles.learnerHydrationBudget, results: learnerHydrationBudgetResults })}`
    );
    const serializationDagResults = result.fastParityRuns.serializationDag
      .results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      serializationDagResults.length === 2 &&
        serializationDagResults[0]?.success === false &&
        serializationDagResults[0]?.timeoutReason === 'serialization-limit' &&
        serializationDagResults[1]?.success === true &&
        serializationDagResults[1]?.output === 1 &&
        serializationDagResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `Learner-shaped shared output escaped the fast-batch serialization budget: ${JSON.stringify(result.fastParityRuns.serializationDag)}`
    );
    const serializationDagCompatibilityResults = result.fastParityRuns
      .serializationDagCompatibility.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
      }>;
    assertCondition(
      serializationDagCompatibilityResults.length === 2 &&
        serializationDagCompatibilityResults[0]?.success === false &&
        serializationDagCompatibilityResults[0]?.timeoutReason ===
          'serialization-limit' &&
        serializationDagCompatibilityResults[1]?.success === true &&
        serializationDagCompatibilityResults[1]?.output === 1,
      `Hard-isolated execution must report output budgets explicitly without corrupting later cases: ${JSON.stringify(result.fastParityRuns.serializationDagCompatibility)}`
    );
    const aggregateOutputResults = result.fastParityRuns.aggregateOutput
      .results as Array<{
        success?: boolean;
        output?: unknown;
        outputLength?: number;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      aggregateOutputResults.length === 7 &&
        aggregateOutputResults.slice(0, 5).every(
          (entry) =>
            entry.success === true &&
            entry.outputLength === 6 * 1024 * 1024
        ) &&
        aggregateOutputResults[5]?.success === false &&
        aggregateOutputResults[5]?.timeoutReason === 'serialization-limit' &&
        aggregateOutputResults[6]?.success === true &&
        aggregateOutputResults[6]?.output === 1 &&
        aggregateOutputResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `Python fast-batch aggregate output budget was not case-local: ${JSON.stringify(aggregateOutputResults)}`
    );
    const oneOffSerializationLimit = result.fastParityRuns
      .oneOffSerializationLimit as {
        success?: boolean;
        timeoutReason?: string;
        error?: string;
      };
    assertCondition(
      oneOffSerializationLimit.success === false &&
        oneOffSerializationLimit.timeoutReason === 'serialization-limit' &&
        String(oneOffSerializationLimit.error).includes('serialization-limit'),
      `One-off Python execution must report its output budget as a typed limit: ${JSON.stringify(oneOffSerializationLimit)}`
    );
    const oneOffLargeMatrix = result.fastParityRuns.oneOffLargeMatrix as {
      success?: boolean;
      output?: unknown;
    };
    assertCondition(
      oneOffLargeMatrix.success === true &&
        Array.isArray(oneOffLargeMatrix.output) &&
        oneOffLargeMatrix.output.length === 100 &&
        Array.isArray(oneOffLargeMatrix.output[0]) &&
        oneOffLargeMatrix.output[0].length === 100,
      `Legitimate nested Python output tripped the serialization budget: ${JSON.stringify(oneOffLargeMatrix)}`
    );
    const assertCaseLocalWallClock = (name: string) => {
      const run = result.fastParityRuns[name];
      const entries = run.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
      assertCondition(
        entries.length === 2 &&
          entries[0]?.success === false &&
          entries[0]?.timeoutReason === 'client-timeout' &&
          entries[1]?.success === true &&
          entries[1]?.output === 1 &&
          entries.every(
            (entry) => entry.timings?.algorithmFastBatch === true
          ),
        `A ${name} wall-clock trip did not remain case-local: ${JSON.stringify(run)}`
      );
    };
    assertCaseLocalWallClock('wallClockModule');
    assertCaseLocalWallClock('wallClockSerialization');
    const judgeCompatibleWallClock = result.fastParityRuns
      .judgeCompatibleWallClock;
    const judgeCompatibleWallClockResults =
      judgeCompatibleWallClock.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
    assertCondition(
      result.isolationProfiles.judgeCompatibleWallClock?.tier ===
        'judge-compatible' &&
        result.isolationProfiles.judgeCompatibleWallClock.reasons.includes(
          'suspending-control-flow'
        ) &&
        judgeCompatibleWallClockResults.length === 2 &&
        judgeCompatibleWallClockResults[0]?.success === false &&
        judgeCompatibleWallClockResults[0]?.timeoutReason ===
          'client-timeout' &&
        judgeCompatibleWallClockResults[1]?.success === true &&
        judgeCompatibleWallClockResults[1]?.output === 1 &&
        judgeCompatibleWallClockResults.every(
          (entry) => entry.timings?.algorithmFastBatch !== true
        ),
      `A judge-compatible wall-clock trip did not remain case-local: ${JSON.stringify(judgeCompatibleWallClock)}`
    );
    for (const { name, profile, run } of [
      {
        name: 'judgeCompatibleSerializationWallClock',
        profile:
          result.isolationProfiles.judgeCompatibleSerializationWallClock,
        run: result.fastParityRuns.judgeCompatibleSerializationWallClock,
      },
      {
        name: 'judgeCompatibleSignatureWallClock',
        profile: result.isolationProfiles.judgeCompatibleSignatureWallClock,
        run: result.fastParityRuns.judgeCompatibleSignatureWallClock,
      },
    ]) {
      const entries = run.results as Array<{
        success?: boolean;
        output?: unknown;
        timeoutReason?: string;
        timings?: { algorithmFastBatch?: boolean };
      }>;
      assertCondition(
        profile.tier === 'judge-compatible' &&
          entries.length === 2 &&
          entries[0]?.success === false &&
          entries[0]?.timeoutReason === 'client-timeout' &&
          entries[1]?.success === true &&
          entries[1]?.output === 1 &&
          entries.every(
            (entry) => entry.timings?.algorithmFastBatch !== true
          ),
        `A ${name} hook escaped the case-local wall clock: ${JSON.stringify(run)}`
      );
    }
    assertCondition(
      result.isolationProfiles.internalNameWallClock?.tier ===
        'hard-isolated' &&
        result.isolationProfiles.internalNameWallClock.reasons.includes(
          'reserved-runtime-binding:_serialize'
        ),
      `A learner helper matching an internal function name bypassed admission: ${JSON.stringify(result.isolationProfiles.internalNameWallClock)}`
    );
    const parityResult = (result.fastParityRuns.parity.results as Array<{
      output?: unknown;
      consoleOutput?: unknown;
    }>)[0];
    const inplaceResult = (result.fastParityRuns.inplace.results as Array<{
      output?: unknown;
    }>)[0];
    const serializedResult = (result.fastParityRuns.serialized.results as Array<{
      success?: boolean;
      output?: unknown;
      timeoutReason?: string;
      timings?: { algorithmFastBatch?: boolean };
    }>)[0];
    const serializedResults = result.fastParityRuns.serialized.results as Array<{
      success?: boolean;
      output?: unknown;
      timeoutReason?: string;
      timings?: { algorithmFastBatch?: boolean };
    }>;
    assertCondition(
      serializedResults.length === 3 &&
        serializedResults[0]?.success === true &&
        serializedResults[1]?.success === false &&
        serializedResults[1]?.timeoutReason === 'serialization-limit' &&
        serializedResults[2]?.success === true &&
        serializedResults[2]?.output === 'after-limit' &&
        serializedResults.every(
          (entry) => entry.timings?.algorithmFastBatch === true
        ),
      `A lying str subclass bypassed trusted byte accounting or stopped later cases: ${JSON.stringify(serializedResults)}`
    );
    const fastParityProjection = (name: string) => {
      const run = result.fastParityRuns[name];
      const first = (run.results as Array<Record<string, unknown>>)[0];
      return {
        success: first.success,
        output: first.output,
        consoleOutput: first.consoleOutput,
        error: first.error,
        errorLine: first.errorLine,
        timeoutReason: first.timeoutReason,
      };
    };
    const assertFastPairTiers = (fastName: string, compatibilityName: string) => {
      const fastFirst = (result.fastParityRuns[fastName].results as Array<{
        timings?: { algorithmFastBatch?: boolean };
      }>)[0];
      const compatibilityFirst = (
        result.fastParityRuns[compatibilityName].results as Array<{
          timings?: { algorithmFastBatch?: boolean };
        }>
      )[0];
      assertCondition(
        fastFirst?.timings?.algorithmFastBatch === true &&
          compatibilityFirst?.timings?.algorithmFastBatch !== true,
        `Python differential pair ${fastName}/${compatibilityName} did not execute distinct tiers: ${JSON.stringify({ fastFirst, compatibilityFirst })}`
      );
    };
    for (const [fastName, compatibilityName] of [
      ['parity', 'parityCompatibility'],
      ['inplace', 'inplaceCompatibility'],
      ['serialized', 'serializedCompatibility'],
      ['dequeExecution', 'dequeExecutionCompatibility'],
      ['customClassHydration', 'customClassHydrationCompatibility'],
      ['globalInput', 'globalInputCompatibility'],
      ['globalRebinding', 'globalRebindingCompatibility'],
      ['heterogeneousTuple', 'heterogeneousTupleCompatibility'],
      ['matrixInplace', 'matrixInplaceCompatibility'],
      ['nodeAnnotationParity', 'nodeAnnotationParityCompatibility'],
      ['moduleLookup', 'moduleLookupCompatibility'],
      ['localCount', 'localCountCompatibility'],
      ['raising', 'raisingCompatibility'],
    ]) {
      assertFastPairTiers(fastName, compatibilityName);
    }
    assertCondition(
      JSON.stringify(parityResult?.output) ===
        JSON.stringify([24, 2, [1, 2, 3]]) &&
        JSON.stringify(parityResult?.consoleOutput) ===
          JSON.stringify(['hello']) &&
        JSON.stringify(inplaceResult?.output) ===
          JSON.stringify([1, 2, 3]) &&
        JSON.stringify(serializedResult?.output) ===
          JSON.stringify([
            {
              __type__: 'TreeNode',
              val: 7,
              left: {
                __type__: 'TreeNode',
                val: 8,
                left: null,
                right: null,
              },
              right: null,
            },
            {
              __type__: 'ListNode',
              val: 7,
              next: { __type__: 'ListNode', val: 8, next: null },
            },
            null,
            'tag',
            9,
            10.5,
          ]) &&
        JSON.stringify(fastParityProjection('globalInput').output) ===
          JSON.stringify([5, [1, 2, 9]]) &&
        JSON.stringify(fastParityProjection('globalRebinding').output) ===
          JSON.stringify([1, 2, 3]) &&
        JSON.stringify(fastParityProjection('heterogeneousTuple').output) ===
          JSON.stringify([1, 4]) &&
        JSON.stringify(fastParityProjection('matrixInplace').output) ===
          JSON.stringify([[3, 2, 1], [4, 5, 6]]) &&
        fastParityProjection('nodeAnnotationParity').output === true &&
        typeof fastParityProjection('moduleLookup').output === 'number' &&
        fastParityProjection('localCount').output === 6 &&
        JSON.stringify(fastParityProjection('parity')) ===
          JSON.stringify(fastParityProjection('parityCompatibility')) &&
        JSON.stringify(fastParityProjection('inplace')) ===
          JSON.stringify(fastParityProjection('inplaceCompatibility')) &&
        JSON.stringify(fastParityProjection('serialized')) ===
          JSON.stringify(fastParityProjection('serializedCompatibility')) &&
        JSON.stringify(fastParityProjection('dequeExecution')) ===
          JSON.stringify(fastParityProjection('dequeExecutionCompatibility')) &&
        JSON.stringify(fastParityProjection('customClassHydration')) ===
          JSON.stringify(fastParityProjection('customClassHydrationCompatibility')) &&
        JSON.stringify(fastParityProjection('globalInput')) ===
          JSON.stringify(fastParityProjection('globalInputCompatibility')) &&
        JSON.stringify(fastParityProjection('globalRebinding')) ===
          JSON.stringify(fastParityProjection('globalRebindingCompatibility')) &&
        JSON.stringify(fastParityProjection('heterogeneousTuple')) ===
          JSON.stringify(fastParityProjection('heterogeneousTupleCompatibility')) &&
        JSON.stringify(fastParityProjection('matrixInplace')) ===
          JSON.stringify(fastParityProjection('matrixInplaceCompatibility')) &&
        JSON.stringify(fastParityProjection('nodeAnnotationParity')) ===
          JSON.stringify(fastParityProjection('nodeAnnotationParityCompatibility')) &&
        JSON.stringify(fastParityProjection('moduleLookup')) ===
          JSON.stringify(fastParityProjection('moduleLookupCompatibility')) &&
        JSON.stringify(fastParityProjection('localCount')) ===
          JSON.stringify(fastParityProjection('localCountCompatibility')) &&
        JSON.stringify(fastParityProjection('raising')) ===
          JSON.stringify(fastParityProjection('raisingCompatibility')),
      `Python fast-path output must preserve argument filtering, annotation hydration, in-place results, stdout, and shared serialization: ${JSON.stringify(result.fastParityRuns)}`
    );
    assertCondition(
      (result.fastParityRuns.sourceCodeBinding.results as Array<{
        success?: boolean;
        output?: unknown;
        timings?: { algorithmFastBatch?: boolean };
      }>)[0]?.success === true &&
        JSON.stringify((result.fastParityRuns.sourceCodeBinding.results as Array<{
          output?: unknown;
        }>)[0]?.output) === JSON.stringify([24, 2, [1, 2, 3]]) &&
        (result.fastParityRuns.sourceCodeBinding.results as Array<{
          timings?: { algorithmFastBatch?: boolean };
        }>)[0]?.timings?.algorithmFastBatch === true &&
        result.fastParityRuns.profileRecheck.algorithmFastBatchUnavailable ===
          true &&
        (result.fastParityRuns.profileRecheck.results as unknown[]).length === 0,
      `Python execution must compile the audited source and re-derive fast-tier admission: ${JSON.stringify({
        sourceCodeBinding: result.fastParityRuns.sourceCodeBinding,
        profileRecheck: result.fastParityRuns.profileRecheck,
      })}`
    );
    const treeFreshnessResults = result.fastParityRuns.treeNodeFreshness.results as Array<{
      success?: boolean;
      output?: unknown;
      timings?: { algorithmFastBatch?: boolean };
    }>;
    assertCondition(
      treeFreshnessResults.length === 2 &&
        treeFreshnessResults.every(
          (entry, index) =>
            entry.success === true &&
            JSON.stringify(entry.output) === JSON.stringify([
              0,
              index + 1,
              index + 1,
              `TreeNode(${index + 1})`,
            ]) &&
            entry.timings?.algorithmFastBatch === true
        ),
      `Python TreeNode class state crossed the per-case boundary: ${JSON.stringify(result.fastParityRuns.treeNodeFreshness)}`
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
            output.itemCount === 2
          );
        }),
      `Prepared Python batch did not isolate mutable case state: ${JSON.stringify(result.batchRun)}`
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
    const mixedTraceResults = result.mixedTraceBatch.results as Array<Record<string, unknown>>;
    for (const [index, run] of mixedTraceResults.entries()) {
      const timings = run.timings as Record<string, unknown> | undefined;
      if (index === 1) {
        assertCondition(
          timings?.algorithmFastBatch === true,
          `Tracing-off Python batch case did not use the algorithm-fast driver: ${JSON.stringify(run)}`
        );
      } else {
        assertCondition(
          typeof timings?.guardBeginMs === 'number' &&
            timings.guardBeginMs >= 0 &&
            typeof timings.guardRestoreMs === 'number' &&
            timings.guardRestoreMs >= 0,
          `Traced Python batch case ${index + 1} did not report execution-guard timings: ${JSON.stringify(run)}`
        );
      }
    }
    assertCondition(
      result.mixedTraceBatch.success === true &&
        mixedTraceResults.length === 3 &&
        mixedTraceResults.every(
          (entry) => entry.success === true && entry.output === 1
        ) &&
        (mixedTraceResults[0]?.trace as { events?: unknown[] })?.events?.length! > 0 &&
        (mixedTraceResults[1]?.trace as { events?: unknown[] })?.events?.length === 0 &&
        (mixedTraceResults[2]?.trace as { events?: unknown[] })?.events?.length! > 0,
      `Prepared Python mixed trace batch did not select recording per case: ${JSON.stringify(result.mixedTraceBatch)}`
    );
    assertCondition(
      result.isolationProfiles.traceExceptionWallClock?.tier ===
        'algorithm-fast',
      `Prepared trace timeout regression source did not remain algorithm scoped: ${JSON.stringify(result.isolationProfiles.traceExceptionWallClock)}`
    );
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
    const benchmark = result.onDemandBenchmark as {
      tracePrepareMs: number;
      codePrepareMs: number;
      allDisabledMs: number[];
      allDisabledPhaseMs: Array<Record<string, number>>;
      cleanMs: number[];
      cleanPhaseMs: Array<Record<string, number>>;
      mixedOneArtifactMs: number[];
      mixedDualArtifactMs: number[];
      outputsMatch: boolean;
      disabledEventsEmpty: boolean;
      callerInputsUnchanged: boolean;
    };
    assertCondition(
      benchmark.outputsMatch === true &&
        benchmark.disabledEventsEmpty === true &&
        benchmark.callerInputsUnchanged === true &&
        benchmark.allDisabledMs.length === 6 &&
        benchmark.allDisabledPhaseMs.length === 6 &&
        benchmark.cleanMs.length === 6 &&
        benchmark.cleanPhaseMs.length === 6 &&
        benchmark.mixedOneArtifactMs.length === 6 &&
        benchmark.mixedDualArtifactMs.length === 6,
      `Python direct-runner benchmark invariants failed: ${JSON.stringify(benchmark)}`
    );
    const median = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
    };
    const medianPhases = (values: Array<Record<string, number>>) =>
      Object.fromEntries(
        Object.keys(values[0] ?? {}).map((name) => [
          name,
          median(values.map((entry) => entry[name] ?? 0)),
        ])
      );
    console.log(
      `PASS: Python marshaled artifacts cross fresh browser workers ${JSON.stringify({
        preparationReadyMs: result.preparationWorker.readyMs,
        executionReadyMs: result.executions.map((execution) => execution.readyMs),
        executionMs: result.executions.map((execution) => execution.executionMs),
        onDemandBenchmark: {
          tracePrepareMs: benchmark.tracePrepareMs,
          additionalCleanPrepareMs: benchmark.codePrepareMs,
          disabledFromTraceArtifactMedianMs: median(benchmark.allDisabledMs),
          disabledPhaseMedianMs: medianPhases(benchmark.allDisabledPhaseMs),
          cleanArtifactMedianMs: median(benchmark.cleanMs),
          cleanPhaseMedianMs: medianPhases(benchmark.cleanPhaseMs),
          mixedOneArtifactMedianMs: median(benchmark.mixedOneArtifactMs),
          mixedDualArtifactMedianMs: median(benchmark.mixedDualArtifactMs),
        },
      })}`
    );
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
