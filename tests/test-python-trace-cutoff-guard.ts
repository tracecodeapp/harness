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
    options: Record<string, unknown>,
    prepared?: { observationOnly: boolean }
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
  afterDeadlineMs: number | null;
  afterGraceMs: number | null;
  graceStartedMs: number | null;
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
  { untraced = false, graceSeconds, prelude = '', epilogue = '', ...options }: Record<string, unknown>
): Promise<Outcome> {
  const runtime = await loadRuntime();
  // An untraced case takes its ceiling from the Submit defaults. These tests
  // are about whether a stop can be swallowed, not how high that ceiling is:
  // a small one trips it long before the case's deadline.
  const caseDeps = untraced ? { ...deps, INTERVIEW_GUARD_DEFAULTS: GUARD_DEFAULTS } : deps;
  let { code } = runtime.generateTracingCode(caseDeps, source, 'solve', { n: 1 }, 'function', {
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
  if (graceSeconds !== undefined) {
    // The no-deadline grace is 10 s; a shorter one keeps the test fast.
    const grace = '\n_hard_line_grace_seconds = 10.0\n';
    assert.equal(code.split(grace).length, 2, 'one grace setting');
    code = code.replace(grace, `\n_hard_line_grace_seconds = ${Number(graceSeconds).toFixed(1)}\n`);
  }
  const startedAt = performance.now();
  const reply = await runner(`${prelude}
${code}
__tracecode_test_reply = json.dumps({
    'result': _serialize_output(_result),
    'aborted': _execution_aborted,
    'timeoutReason': _timeout_reason,
    'traceLimitExceeded': _trace_limit_exceeded,
    'traceEvents': len(_trace_events),
    'stoppedLine': _infinite_loop_line,
    'monitoring': bool(globals().get('_TC_MONITORING_WAS_ARMED')),
    'afterDeadlineMs': (_tracecode_perf_counter() - _case_deadline) * 1000 if _case_deadline > 0 else None,
    'afterGraceMs': (_tracecode_perf_counter() - _hard_line_deadline) * 1000 if _hard_line_deadline > 0 else None,
    'graceStartedMs': (_hard_line_deadline - _hard_line_grace_seconds - _case_started_at) * 1000 if _hard_line_deadline > 0 else None,
})
${epilogue}
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

// After recording stops, the guards must stop the program soon after its
// deadline, before the client's clock (1 s of headroom, which also has to
// carry the trace back) closes the worker and loses the trace. Each line here
// takes milliseconds, so a fixed 256-line sampling interval overshoots by
// seconds.
const SLOW_LINES = `def solve(n):
    total = 0
    while total >= 0:
        total = sum(range(400000)) % 7
    return total
`;

// The learner's own dynamic code (exec) runs the loop after recording stopped.
const DYNAMIC_LOOP = `def solve(n):
    total = 0
    for step in range(10):
        total += step
    exec("k = 0\\nwhile k >= 0:\\n    k = (k + 1) % 10")
    return total
`;

const SOON_MS = 250;

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  test(`${runnerName}, sys.settrace: slow lines after recording stopped are stopped soon after the deadline`, async () => {
    const outcome = await run(runner, SLOW_LINES, { wallClockMs: 1_500, maxTraceSteps: 5 });
    assert.equal(outcome.timeoutReason, 'client-timeout', JSON.stringify(outcome));
    assert.equal(outcome.traceLimitExceeded, true);
    assert.ok(outcome.afterDeadlineMs! < SOON_MS, `stopped ${Math.round(outcome.afterDeadlineMs!)} ms after the deadline`);
  });

  test(`${runnerName}, PEP 669: with no deadline, slow lines are stopped soon after the grace from when recording stopped`, async () => {
    const outcome = await run(runner, SLOW_LINES, { maxTraceSteps: 5, graceSeconds: 1 });
    assert.equal(outcome.monitoring, true);
    assert.equal(outcome.timeoutReason, 'client-timeout', JSON.stringify(outcome));
    assert.ok(outcome.afterGraceMs! < SOON_MS, `stopped ${Math.round(outcome.afterGraceMs!)} ms after the grace`);
    assert.ok(outcome.ms < 1_000 + 2_000, `stopped after ${Math.round(outcome.ms)} ms`);
  });

  test(`${runnerName}, sys.settrace: a loop in the learner's dynamic code after recording stopped meets the deadline`, async () => {
    const outcome = await run(runner, DYNAMIC_LOOP, { wallClockMs: 1_500, maxTraceSteps: 5 });
    assert.equal(outcome.aborted, true, JSON.stringify(outcome));
    assert.equal(outcome.timeoutReason, 'client-timeout');
    assert.ok(outcome.afterDeadlineMs! < SOON_MS, `stopped ${Math.round(outcome.afterDeadlineMs!)} ms after the deadline`);
    assert.equal(outcome.stoppedLine, 5, 'stopped at the learner\'s exec line');
  });

  test(`${runnerName}, PEP 669: a loop in the learner's dynamic code after recording stopped meets the grace`, async () => {
    const outcome = await run(runner, DYNAMIC_LOOP, { maxTraceSteps: 5, graceSeconds: 1 });
    assert.equal(outcome.aborted, true, JSON.stringify(outcome));
    assert.equal(outcome.timeoutReason, 'client-timeout');
    assert.ok(outcome.afterGraceMs! < SOON_MS, `stopped ${Math.round(outcome.afterGraceMs!)} ms after the grace`);
  });
}

// What the worker returns for a traced case whose trace stopped at a budget,
// through executeWithTracing's classification: a program that finishes
// completes with its truncated trace; a runaway reports the guard's limit,
// keeps its trace prefix, and keeps the trace budget that stopped recording
// (traceLimitReason) beside the case's limit.
for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  const execute = async (source: string, options: Record<string, unknown>) => {
    const runtime = (await loadRuntime()) as Runtime & { executeWithTracing: (...args: unknown[]) => Promise<any> };
    let now = 0;
    return runtime.executeWithTracing(
      {
        ...deps,
        loadPyodideInstance: async () => {},
        getPyodide: () => ({ runPythonAsync: (code: string) => runner(code) }),
        performanceNow: () => ++now,
      },
      source,
      'solve',
      { n: 1 },
      'function',
      { maxTraceSteps: 50_000, maxStoredEvents: 200_000, maxLineEvents: 100_000, maxSingleLineHits: 100_000, ...options }
    );
  };

  test(`${runnerName}: a runaway after the trace byte budget reports the guard and keeps the budget`, async () => {
    const result = await execute(RUNAWAY, { wallClockMs: 15_000, maxTraceBytes: 16 * 1024 });
    assert.equal(result.success, false, JSON.stringify({ ...result, trace: undefined }));
    assert.equal(result.timeoutReason, 'line-limit');
    assert.equal(result.traceLimitExceeded, true);
    assert.equal(result.traceLimitReason, 'trace-byte-limit', 'the budget that stopped recording is kept');
    assert.match(result.error, /^Execution stopped on line [34]: the program executed too many lines/);
    assert.ok(result.trace.events.length > 0);
  });

  test(`${runnerName}: a program that finishes after the trace byte budget completes with the budget`, async () => {
    const result = await execute(FINISHES, { wallClockMs: 15_000, maxTraceBytes: 16 * 1024 });
    assert.equal(result.success, true, JSON.stringify({ ...result, trace: undefined }));
    assert.equal(result.output, 60000);
    assert.equal(result.timeoutReason, 'trace-byte-limit');
    assert.equal(result.traceLimitExceeded, true);
    assert.equal(result.traceLimitReason, 'trace-byte-limit');
    assert.ok(result.trace.events.length > 0);
  });
}

// Lines turn slow just before the deadline, after cheap lines have grown the
// sampling interval to its maximum: the next sample must still come soon
// after the deadline, not 256 slow lines later.
const SUDDENLY_SLOW = `def solve(n):
    import time
    begin = time.perf_counter()
    total = 0
    while time.perf_counter() - begin < 1.3:
        time.sleep(0.0001)
    while total >= 0:
        time.sleep(0.1)
    return total
`;

// Recording stops on the line that sleeps; the grace runs from then, not
// from the next learner line after the sleep.
const SLOW_AFTER_CUTOFF = `def solve(n):
    total = 0
    total = len(str(n))
    __import__('time').sleep(0.8)
    while total >= 0:
        total = sum(range(200000)) % 7
    return total
`;

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  test(`${runnerName}, sys.settrace: lines that turn slow just before the deadline are stopped soon after it`, async () => {
    const outcome = await run(runner, SUDDENLY_SLOW, { wallClockMs: 1_500, maxTraceSteps: 5 });
    assert.equal(outcome.timeoutReason, 'client-timeout', JSON.stringify(outcome));
    assert.ok(outcome.afterDeadlineMs! < SOON_MS, `stopped ${Math.round(outcome.afterDeadlineMs!)} ms after the deadline`);
  });

  test(`${runnerName}, PEP 669: with no deadline, the grace starts when recording stops`, async () => {
    const outcome = await run(runner, SLOW_AFTER_CUTOFF, { maxTraceSteps: 3, graceSeconds: 1 });
    assert.equal(outcome.traceLimitExceeded, true);
    assert.ok(outcome.graceStartedMs! < 500, `grace started ${Math.round(outcome.graceStartedMs!)} ms into the case, after the sleep`);
    assert.equal(outcome.timeoutReason, 'client-timeout', JSON.stringify(outcome));
  });
}

// The sticky stop needs a PEP 669 tool. Learner code that reaches
// sys.monitoring can hold the tool id the guards use (4): the stop then takes
// another free id. With no sys.monitoring at all (Python < 3.12) the stop
// cannot be re-raised, but it is still recorded as the outcome.
const HOLD_TOOL_4 = "import sys as _test_sys\n_test_sys.monitoring.use_tool_id(4, 'learner')";
const FREE_TOOL_4 = "_test_sys.monitoring.free_tool_id(4)";
const NO_MONITORING = "import sys as _test_sys\n_test_monitoring = _test_sys.monitoring\ndel _test_sys.monitoring";
const RESTORE_MONITORING = "_test_sys.monitoring = _test_monitoring";

function withProgramEnds(runner: Runner, prelude: string, epilogue: string): Runner {
  return (program) => {
    const lines = program.trimEnd().split('\n');
    const last = lines.pop();
    return runner([prelude, ...lines, epilogue, last].join('\n'));
  };
}

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  const swallowLoop = SWALLOWS['a bare except: inside a loop'];

  test(`${runnerName}, sys.settrace: a caught stop is re-raised when the learner holds tool id 4`, async () => {
    const outcome = await run(runner, swallowLoop, {
      wallClockMs: 15_000, ...APP_BUDGETS, prelude: HOLD_TOOL_4, epilogue: FREE_TOOL_4,
    });
    assertGuardStopKept(outcome, ['line-limit']);
  });

  test(`${runnerName}: the fast batch re-raises a caught stop when the learner holds tool id 4`, async () => {
    const reply = await withProgramEnds(runner, HOLD_TOOL_4, FREE_TOOL_4)([
      `__tracecode_prepared_user_source = ${toPythonLiteral(swallowLoop)}`,
      `__tracecode_input_batch_literal = ${toPythonLiteral(toPythonLiteral([{ n: 1 }]))}`,
      `__tracecode_limits_literal = ${toPythonLiteral(toPythonLiteral({ ...SUBMIT_LIMITS, stopAtFirstRunaway: true }))}`,
      await fastBatchSource(),
    ].join('\n'));
    const results = JSON.parse(reply) as { success: boolean; timeoutReason?: string }[];
    assert.equal(results[0].success, false, reply);
    assert.ok(RUNAWAY_REASONS.includes(results[0].timeoutReason ?? ''), reply);
  });

  test(`${runnerName}: the interview guard re-raises a caught stop when the learner holds tool id 4`, async () => {
    const runtime = (await loadRuntime()) as Runtime & { executeCode: (...args: unknown[]) => Promise<any> };
    let now = 0;
    const result = await runtime.executeCode(
      {
        ...deps,
        INTERVIEW_GUARD_DEFAULTS: GUARD_DEFAULTS,
        loadPyodideInstance: async () => {},
        getPyodide: () => ({ runPythonAsync: withProgramEnds(runner, HOLD_TOOL_4, FREE_TOOL_4) }),
        performanceNow: () => ++now,
      },
      swallowLoop,
      'solve',
      { n: 1 },
      'function',
      SUBMIT_LIMITS
    );
    assert.equal(result.success, false, JSON.stringify(result));
    assert.ok(RUNAWAY_REASONS.includes(result.timeoutReason), JSON.stringify(result));
  });

  test(`${runnerName}, sys.settrace: with no sys.monitoring a caught stop is still the outcome`, async () => {
    const outcome = await run(runner, SWALLOWS['finally: return'], {
      wallClockMs: 15_000, ...APP_BUDGETS, prelude: NO_MONITORING, epilogue: RESTORE_MONITORING,
    });
    assert.equal(outcome.monitoring, false);
    assertGuardStopKept(outcome, ['line-limit']);
  });
}

// The execution scope's restore() is the safety net that puts builtins and
// modules back after a case. Releasing the guards' PEP 669 tool must not
// depend on names the learner's code can rebind, must never skip the rest of
// the restore, and must release only what the case acquired.
let guardSourcePromise: Promise<string> | undefined;
function executionGuardSource(): Promise<string> {
  guardSourcePromise ??= readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8').then((source) => {
    const self: Record<string, any> = {};
    vm.runInContext(
      source.replace(
        'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = {',
        'globalScope.__TRACECODE_PYODIDE_RUNTIME__ = { createIsolatedPythonExecutionGuard,'
      ),
      vm.createContext({ console, self, globalThis: {} }),
      { filename: 'python-runtime.js' }
    );
    let captured = '';
    try {
      self.__TRACECODE_PYODIDE_RUNTIME__.createIsolatedPythonExecutionGuard({
        runPython: (code: string) => {
          captured = code;
          throw new Error('captured');
        },
      });
    } catch {
      // The source is all this test needs.
    }
    assert.ok(captured.includes('class __TracecodeExecutionGuard'), 'captured the execution guard source');
    return captured.trimEnd().replace(/\n__tracecode_execution_guard$/, '');
  });
  return guardSourcePromise;
}

async function runScopeCase(runner: Runner, caseBody: string): Promise<Record<string, unknown>> {
  const reply = await runner(`${await executionGuardSource()}
import builtins as _test_builtins
import json as _test_json
import sys as _test_sys
_test_saved = dict(_test_builtins.__dict__)
_test_monitoring = getattr(_test_sys, 'monitoring', None)
_test_report = {}
try:
    __tracecode_execution_guard.begin()
${caseBody.split('\n').map((line) => `    ${line}`).join('\n')}
    try:
        __tracecode_execution_guard.restore()
        _test_report['restoreError'] = None
    except BaseException as _test_error:
        _test_report['restoreError'] = type(_test_error).__name__ + ': ' + str(_test_error)
finally:
    _test_report['rangeRestored'] = _test_builtins.__dict__.get('range') is _test_saved['range']
    _test_report['exceptionRestored'] = _test_builtins.__dict__.get('Exception') is _test_saved['Exception']
    _test_builtins.__dict__.update(_test_saved)
    _test_report['tools'] = {
        str(_test_id): _test_monitoring.get_tool(_test_id) for _test_id in (0, 1, 2, 3, 4, 5)
    } if _test_monitoring is not None else {}
    for _test_id in (0, 1, 2, 3, 4, 5):
        if _test_monitoring is not None and _test_monitoring.get_tool(_test_id) is not None:
            _test_monitoring.free_tool_id(_test_id)
__tracecode_test_reply = _test_json.dumps(_test_report)
__tracecode_test_reply
`);
  return JSON.parse(reply);
}

for (const [runnerName, runner] of Object.entries(RUNNERS)) {
  test(`${runnerName}: restore() releases the guards' tool and restores builtins after the case rebound them`, async () => {
    const report = await runScopeCase(runner, [
      "_test_sys.monitoring.use_tool_id(4, 'tracecode')",
      '_test_builtins.range = 5',
      '_test_builtins.Exception = 5',
    ].join('\n'));
    assert.equal(report.restoreError, null, `restore() must not fail: ${report.restoreError}`);
    assert.equal(report.rangeRestored, true);
    assert.equal(report.exceptionRestored, true);
    assert.equal((report.tools as Record<string, unknown>)['4'], null, 'the tool the case acquired is released');
  });

  test(`${runnerName}: restore() leaves a monitoring tool it did not acquire, whatever its name`, async () => {
    const report = await runScopeCase(runner, '');
    assert.equal(report.restoreError, null);
    const held = await runner(`${await executionGuardSource()}
import json as _test_json
import sys as _test_sys
_test_sys.monitoring.use_tool_id(2, 'tracecode')
try:
    __tracecode_execution_guard.begin()
    __tracecode_execution_guard.restore()
    _test_held = _test_sys.monitoring.get_tool(2)
finally:
    if _test_sys.monitoring.get_tool(2) is not None:
        _test_sys.monitoring.free_tool_id(2)
_test_json.dumps(_test_held)
`);
    assert.equal(JSON.parse(held), 'tracecode', 'an independently owned tool named tracecode is kept');
  });
}

// The guards' own code must not depend on builtins the learner's code can
// rebind while it runs.
const REBINDS_BUILTINS = `def solve(n):
    import builtins
    builtins.ValueError = None
    caught = 0
    while True:
        try:
            k = 0
            while k >= 0:
                k = (k + 1) % 10
        except:
            caught += 1
`;

// Host python3 only: each run is a fresh process, while the Pyodide runner
// shares one interpreter that rebound builtins would leave broken.
test('python3, sys.settrace: the guard still stops a runaway that rebound ValueError', async () => {
  const outcome = await run(runPython3, REBINDS_BUILTINS, {
    wallClockMs: 15_000,
    ...APP_BUDGETS,
    // Tool id 4 is held, so the sticky stop's claim walks the other ids.
    prelude: "import sys as _test_sys\n_test_sys.monitoring.use_tool_id(4, 'learner')",
    epilogue: "_test_sys.monitoring.free_tool_id(4)",
  });
  assertGuardStopKept(outcome, ['line-limit']);
});

test('a Python step-limited observation contains only the genuine recorder prefix', async () => {
  const runtime = await loadRuntime();
  const source = [
    'def solve(n):',
    '    total = 0',
    '    for i in range(20):',
    '        total += i',
    '    return n',
  ].join('\n');
  const observe = async (maxTraceSteps: number) => {
    const { code } = runtime.generateTracingCode(
      deps,
      source,
      'solve',
      { n: 3 },
      'function',
      { maxTraceSteps, maxStoredEvents: 16_000 },
      { observationOnly: true }
    );
    return JSON.parse(await runPython3(code)) as {
      timeoutReason: string;
      observation: { attemptedEvents: number };
      runtimeTrace: { events: Array<{ kind: string }> };
    };
  };
  const capped = await observe(2);
  const reference = await observe(12);
  const events = capped.runtimeTrace.events;
  assert.equal(capped.timeoutReason, 'trace-limit');
  assert.equal(capped.observation.attemptedEvents, events.length + 1);
  assert.ok(events.length > 0 && events.length < reference.runtimeTrace.events.length);
  assert.deepEqual(events, reference.runtimeTrace.events.slice(0, events.length));
});
