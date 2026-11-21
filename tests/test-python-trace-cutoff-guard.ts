#!/usr/bin/env npx tsx
/**
 * Once a trace budget stops recording, the Python tracer stays installed with
 * the runaway guards (per-case deadline, line ceiling) for every budget that
 * can stop recording, on both tracing paths (sys.settrace when a per-case
 * clock is set, PEP 669 otherwise). Runs the generated tracer in Pyodide
 * (the browser worker's Python) and in host python3.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';

// A loop that never ends is killed after this; the guards take well under it.
const PROCESS_TIMEOUT_MS = 20_000;

const deps = {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  toPythonLiteral,
};

type Runtime = {
  generateTracingCode: (
    deps: unknown,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: string,
    options: Record<string, unknown>
  ) => { code: string };
};

let runtimePromise: Promise<Runtime> | undefined;
function loadRuntime(): Promise<Runtime> {
  runtimePromise ??= readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8').then((source) => {
    const self: Record<string, unknown> = {};
    vm.runInContext(source, vm.createContext({ console, self, globalThis: {} }), { filename: 'python-runtime.js' });
    return self.__TRACECODE_PYODIDE_RUNTIME__ as Runtime;
  });
  return runtimePromise;
}

/** Runs a program whose last line is an expression and returns that value. */
type Runner = (program: string) => Promise<string>;

async function runPython3(program: string): Promise<string> {
  const lines = program.trimEnd().split('\n');
  lines[lines.length - 1] = `print(${lines[lines.length - 1]})`;
  const dir = await mkdtemp(join(tmpdir(), 'tracecode-python-trace-cutoff-'));
  const script = join(dir, 'trace.py');
  await writeFile(script, lines.join('\n'), 'utf8');
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', ['-W', 'ignore', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`python3 still running after ${PROCESS_TIMEOUT_MS} ms: no guard stopped the program`));
      }, PROCESS_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.stderr.on('data', (chunk) => { err += String(chunk); });
      child.on('error', reject);
      child.on('close', (status) => {
        clearTimeout(timer);
        if (status === 0) resolve(out);
        else reject(new Error(`python3 exited with ${status}\n${err}`));
      });
    });
    const out = stdout.trim().split('\n');
    return out[out.length - 1];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let pyodideWorker: Promise<Worker> | undefined;
let pyodideSequence = 0;
function startPyodide(): Promise<Worker> {
  pyodideWorker ??= new Promise((resolve, reject) => {
    const worker = new Worker(join(process.cwd(), 'tests/fixtures/pyodide-node-runner.mjs'), {
      workerData: { root: process.cwd() },
    });
    worker.once('error', reject);
    worker.once('message', (message) => message?.ready ? resolve(worker) : reject(new Error('Pyodide did not start')));
  });
  return pyodideWorker;
}

async function runPyodide(program: string): Promise<string> {
  const worker = await startPyodide();
  const id = ++pyodideSequence;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Pyodide cannot be interrupted here; replace the thread.
      worker.off('message', onMessage);
      pyodideWorker = undefined;
      void worker.terminate();
      reject(new Error(`Pyodide still running after ${PROCESS_TIMEOUT_MS} ms: no guard stopped the program`));
    }, PROCESS_TIMEOUT_MS);
    const onMessage = (message: { id?: number; value?: string; error?: string }) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      if (message.error !== undefined) reject(new Error(message.error));
      else resolve(message.value ?? '');
    };
    worker.on('message', onMessage);
    worker.postMessage({ id, code: program });
  });
}

after(async () => {
  const worker = pyodideWorker;
  pyodideWorker = undefined;
  if (worker) await (await worker).terminate();
});

const RUNNERS: Record<string, Runner> = { Pyodide: runPyodide, python3: runPython3 };

type Outcome = {
  result: unknown;
  aborted: boolean;
  timeoutReason: string | null;
  traceLimitExceeded: boolean;
  traceEvents: number;
  stoppedLine: number;
  monitoring: boolean;
  ms: number;
};

// The app's Run budgets.
const APP_BUDGETS = {
  maxTraceSteps: 4000,
  maxLineEvents: 12000,
  maxSingleLineHits: 1000,
  maxStoredEvents: 16000,
};

async function run(
  runner: Runner,
  source: string,
  { untraced = false, ...options }: Record<string, unknown>
): Promise<Outcome> {
  const runtime = await loadRuntime();
  let { code } = runtime.generateTracingCode(deps, source, 'solve', { n: 1 }, 'function', {
    maxTraceSteps: 50_000,
    maxStoredEvents: 200_000,
    maxLineEvents: 100_000,
    maxSingleLineHits: 100_000,
    ...options,
  });
  if (untraced) {
    // What a prepared trace executor does for a case it does not trace.
    const arm = '\n_tracecode_arm_tracing()\n';
    assert.equal(code.split(arm).length, 2, 'one place arms tracing');
    code = code.replace(arm, '\nsys.settrace(_tracecode_guard_tracer)\n');
  }
  const startedAt = performance.now();
  const reply = await runner(`${code}
__tracecode_test_reply = json.dumps({
    'result': _serialize_output(_result),
    'aborted': _execution_aborted,
    'timeoutReason': _timeout_reason,
    'traceLimitExceeded': _trace_limit_exceeded,
    'traceEvents': len(_trace_events),
    'stoppedLine': _infinite_loop_line,
    'monitoring': bool(globals().get('_TC_MONITORING_WAS_ARMED')),
})
__tracecode_test_reply
`);
  return { ...JSON.parse(reply), ms: performance.now() - startedAt };
}

// Line 4 is the loop's body.
const RUNAWAY = `def solve(n):
    k = 0
    while k >= 0:
        k = (k + 1) % 10
    return k
`;

const FINISHES = `def solve(n):
    k = 0
    steps = 0
    while steps < 60000:
        k = (k + 1) % 10
        steps += 1
    return steps
`;

// Each line is slow, so the line ceiling is minutes away: only the deadline
// stops it in time.
const SLOW_RUNAWAY = `def solve(n):
    total = 0
    while total >= 0:
        total = sum(range(200000)) % 7
    return total
`;

const BUDGETS = {
  'trace bytes': { maxTraceBytes: 16 * 1024 },
  'stored events': { maxStoredEvents: 200 },
  'trace steps': { maxTraceSteps: 40 },
} as const;

const PATHS = {
  'sys.settrace': { wallClockMs: 15_000 },
  'PEP 669': {},
} as const;

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  for (const [pathName, pathOptions] of Object.entries(PATHS)) {
    const label = `${runnerName}, ${pathName}`;
    for (const [budgetName, budget] of Object.entries(BUDGETS)) {
      test(`${label}: a loop that never ends is stopped by the line guard after ${budgetName} stop recording`, async () => {
        const outcome = await run(runner, RUNAWAY, { ...pathOptions, ...budget });
        assert.equal(outcome.monitoring, pathName === 'PEP 669', 'the intended tracing path ran');
        assert.equal(outcome.aborted, true, JSON.stringify(outcome));
        assert.equal(outcome.timeoutReason, 'line-limit', 'the guard, not the trace budget, is the limit');
        assert.equal(outcome.traceLimitExceeded, true, 'the trace stays marked truncated');
        assert.ok(outcome.traceEvents > 0, 'the recorded prefix is kept');
        assert.ok([3, 4].includes(outcome.stoppedLine), `stopped in the loop, on line ${outcome.stoppedLine}`);
      });

      test(`${label}: a program that ends completes after ${budgetName} stop recording`, async () => {
        const outcome = await run(runner, FINISHES, { ...pathOptions, ...budget });
        assert.equal(outcome.aborted, false, JSON.stringify(outcome));
        assert.equal(outcome.result, 60000);
        assert.equal(outcome.traceLimitExceeded, true);
        assert.ok(['trace-byte-limit', 'trace-limit'].includes(outcome.timeoutReason ?? ''), String(outcome.timeoutReason));
        assert.ok(outcome.traceEvents > 0);
      });
    }

    // After the per-line recording budget, the old degraded path kept the
    // tracer but, under sys.settrace, also counted the lines of the harness's
    // access helpers (~14 per learner line), so a correct program hit the
    // runaway ceiling after ~43k learner lines. Only the learner's lines count.
    test(`${label}: a long correct program completes after the per-line budget stops recording`, async () => {
      const outcome = await run(runner, FINISHES, { ...pathOptions, ...APP_BUDGETS });
      assert.equal(outcome.aborted, false, JSON.stringify(outcome));
      assert.equal(outcome.result, 60000);
      assert.equal(outcome.timeoutReason, 'single-line-limit');
      assert.equal(outcome.traceLimitExceeded, true);
    });
  }

  test(`${runnerName}, sys.settrace: the per-case deadline still fires after the trace stops recording`, async () => {
    const outcome = await run(runner, SLOW_RUNAWAY, { wallClockMs: 1_500, maxTraceSteps: 5 });
    assert.equal(outcome.aborted, true, JSON.stringify(outcome));
    assert.equal(outcome.timeoutReason, 'client-timeout');
    assert.equal(outcome.traceLimitExceeded, true);
    assert.ok(outcome.ms < 10_000, `stopped after ${Math.round(outcome.ms)} ms`);
  });
}

// Correct programs whose loops run through the tracing rewrite's helpers
// (`for` over range, a list and enumerate become generator helpers; a
// comprehension's iterable can too). Each executes 240k-250k learner lines,
// under the 400k untraced ceiling. A helper generator resumed after recording
// stopped keeps the local tracer it got while recording, so its own lines
// must not count as the learner's.
const HELPER_LOOPS: Record<string, { source: string; result: number }> = {
  'for over range': {
    source: `def solve(n):
    total = 0
    for i in range(120000):
        total += i
    return total
`,
    result: 7199940000,
  },
  'for over a list': {
    source: `def solve(n):
    nums = list(range(120000))
    total = 0
    for value in nums:
        total += value
    return total
`,
    result: 7199940000,
  },
  'for over enumerate': {
    source: `def solve(n):
    nums = list(range(120000))
    total = 0
    for index, value in enumerate(nums):
        total += index - value
    return total
`,
    result: 0,
  },
  comprehensions: {
    source: `def solve(n):
    nums = list(range(3000))
    total = 0
    for _ in range(80):
        total += sum([value * 2 for value in nums])
    return total
`,
    result: 80 * 2 * (2999 * 3000) / 2,
  },
};

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  for (const [pathName, pathOptions] of Object.entries(PATHS)) {
    for (const [loopName, { source, result }] of Object.entries(HELPER_LOOPS)) {
      test(`${runnerName}, ${pathName}: a correct ${loopName} loop completes after its trace stops recording`, async () => {
        const outcome = await run(runner, source, { ...pathOptions, ...APP_BUDGETS });
        assert.equal(outcome.aborted, false, JSON.stringify(outcome));
        assert.equal(outcome.result, result);
        assert.equal(outcome.traceLimitExceeded, true);
      });
    }
  }
}

// A guard's stop is a BaseException the learner's code can catch: `finally:
// return`, `except BaseException:` or a bare `except:`. The stop must still be
// the case's outcome (not the fallback the learner returned), and a learner
// that catches it inside a loop must not keep running unguarded.
const SWALLOWS: Record<string, string> = {
  'finally: return': `def solve(n):
    try:
        k = 0
        while k >= 0:
            k = (k + 1) % 10
    finally:
        return -7
`,
  'except BaseException: return': `def solve(n):
    try:
        k = 0
        while k >= 0:
            k = (k + 1) % 10
    except BaseException:
        return -7
`,
  'a bare except: inside a loop': `def solve(n):
    caught = 0
    while True:
        try:
            k = 0
            while k >= 0:
                k = (k + 1) % 10
        except:
            caught += 1
`,
};

// The same swallows around lines too slow to reach any line budget in time:
// only the per-case clock stops them, while the trace is still recording.
const SLOW_SWALLOWS: Record<string, string> = Object.fromEntries(
  Object.entries(SWALLOWS).map(([name, source]) => [
    name,
    source.replace('k = (k + 1) % 10', 'k = sum(range(300000)) % 7'),
  ])
);

const RUNAWAY_REASONS = ['line-limit', 'single-line-limit', 'client-timeout'];

function assertGuardStopKept(outcome: Outcome, reasons: readonly string[]): void {
  assert.equal(outcome.aborted, true, `the guard's stop is the outcome: ${JSON.stringify(outcome)}`);
  assert.ok(reasons.includes(outcome.timeoutReason ?? ''), String(outcome.timeoutReason));
  assert.equal(outcome.result, null, 'the learner\'s fallback is not the result');
}

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  for (const [swallowName, source] of Object.entries(SWALLOWS)) {
    for (const [pathName, pathOptions] of Object.entries(PATHS)) {
      test(`${runnerName}, ${pathName}: ${swallowName} cannot swallow the guard after recording stopped`, async () => {
        assertGuardStopKept(await run(runner, source, { ...pathOptions, ...APP_BUDGETS }), ['line-limit']);
      });
    }

    test(`${runnerName}, sys.settrace: ${swallowName} cannot swallow the deadline while recording`, async () => {
      const outcome = await run(runner, SLOW_SWALLOWS[swallowName], { wallClockMs: 1_500 });
      assertGuardStopKept(outcome, ['client-timeout']);
      assert.equal(outcome.traceLimitExceeded, false, 'stopped while still recording');
      assert.ok(outcome.ms < 10_000, `stopped after ${Math.round(outcome.ms)} ms`);
    });

    // A case of a trace batch that is not traced runs under the untraced guard
    // tracer instead of the recording tracer.
    test(`${runnerName}: ${swallowName} cannot swallow the untraced case guard`, async () => {
      const outcome = await run(runner, source, { wallClockMs: 15_000, untraced: true });
      assertGuardStopKept(outcome, ['line-limit', 'single-line-limit']);
    });
  }
}

// The untraced Submit paths have their own guards with the same hole: the
// algorithm-fast batch driver and executeCode's interview guard.
let fastBatchSourcePromise: Promise<string> | undefined;
function fastBatchSource(): Promise<string> {
  fastBatchSourcePromise ??= readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8').then((source) => {
    const self: Record<string, any> = {};
    vm.runInContext(
      source.replace(
        'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = {',
        'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = { buildPythonAlgorithmFastBatchSource,'
      ),
      vm.createContext({ console, self, globalThis: {} }),
      { filename: 'python-runtime.js' }
    );
    return self.__TRACECODE_PYODIDE_RUNTIME__.buildPythonAlgorithmFastBatchSource(
      { ...deps, INTERVIEW_GUARD_DEFAULTS: GUARD_DEFAULTS },
      'solve',
      'function'
    );
  });
  return fastBatchSourcePromise;
}

const GUARD_DEFAULTS = {
  maxLineEvents: 400000,
  maxSingleLineHits: 150000,
  maxCallDepth: 2000,
  maxMemoryBytes: 96 * 1024 * 1024,
  memoryCheckEvery: 200,
};

const SUBMIT_LIMITS = { interviewGuard: true, maxLineEvents: 20_000, maxSingleLineHits: 5_000, wallClockMs: 15_000 };

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  for (const [swallowName, source] of Object.entries(SWALLOWS)) {
    test(`${runnerName}: ${swallowName} cannot swallow the fast batch guard`, async () => {
      const reply = await runner([
        `__tracecode_prepared_user_source = ${toPythonLiteral(source)}`,
        `__tracecode_input_batch_literal = ${toPythonLiteral(toPythonLiteral([{ n: 1 }, { n: 2 }]))}`,
        `__tracecode_limits_literal = ${toPythonLiteral(toPythonLiteral({ ...SUBMIT_LIMITS, stopAtFirstRunaway: true }))}`,
        await fastBatchSource(),
      ].join('\n'));
      const results = JSON.parse(reply) as { success: boolean; output?: unknown; timeoutReason?: string }[];
      assert.equal(results.length, 1, `the batch stops at the runaway case: ${reply}`);
      assert.equal(results[0].success, false, reply);
      assert.ok(RUNAWAY_REASONS.includes(results[0].timeoutReason ?? ''), reply);
      assert.equal(results[0].output ?? null, null);
    });

    test(`${runnerName}: ${swallowName} cannot swallow the interview guard`, async () => {
      const runtime = (await loadRuntime()) as Runtime & { executeCode: (...args: unknown[]) => Promise<any> };
      let now = 0;
      const result = await runtime.executeCode(
        {
          ...deps,
          INTERVIEW_GUARD_DEFAULTS: GUARD_DEFAULTS,
          loadPyodideInstance: async () => {},
          getPyodide: () => ({ runPythonAsync: (code: string) => runner(code) }),
          performanceNow: () => ++now,
        },
        source,
        'solve',
        { n: 1 },
        'function',
        SUBMIT_LIMITS
      );
      assert.equal(result.success, false, JSON.stringify(result));
      assert.ok(RUNAWAY_REASONS.includes(result.timeoutReason), JSON.stringify(result));
      assert.equal(result.output ?? null, null);
    });
  }
}
