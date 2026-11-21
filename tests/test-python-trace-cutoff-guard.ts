#!/usr/bin/env npx tsx
/**
 * Once a trace budget stops recording, the Python tracer stays installed with
 * the runaway guards (per-case deadline, line ceiling) for every budget that
 * can stop recording, on both tracing paths (sys.settrace when a per-case
 * clock is set, PEP 669 otherwise). Runs the generated tracer under python3.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
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

async function run(source: string, options: Record<string, unknown>): Promise<Outcome> {
  const runtime = await loadRuntime();
  const { code } = runtime.generateTracingCode(deps, source, 'solve', { n: 1 }, 'function', {
    maxTraceSteps: 50_000,
    maxStoredEvents: 200_000,
    maxLineEvents: 100_000,
    maxSingleLineHits: 100_000,
    ...options,
  });
  const dir = await mkdtemp(join(tmpdir(), 'tracecode-python-trace-cutoff-'));
  const script = join(dir, 'trace.py');
  await writeFile(script, `${code}
print(json.dumps({
    'result': _serialize_output(_result),
    'aborted': _execution_aborted,
    'timeoutReason': _timeout_reason,
    'traceLimitExceeded': _trace_limit_exceeded,
    'traceEvents': len(_trace_events),
    'stoppedLine': _infinite_loop_line,
    'monitoring': bool(globals().get('_TC_MONITORING_WAS_ARMED')),
}))
`, 'utf8');
  const startedAt = performance.now();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const lines = stdout.trim().split('\n');
    return { ...JSON.parse(lines[lines.length - 1]), ms: performance.now() - startedAt };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

for (const [pathName, pathOptions] of Object.entries(PATHS)) {
  for (const [budgetName, budget] of Object.entries(BUDGETS)) {
    test(`${pathName}: a loop that never ends is stopped by the line guard after ${budgetName} stop recording`, async () => {
      const outcome = await run(RUNAWAY, { ...pathOptions, ...budget });
      assert.equal(outcome.monitoring, pathName === 'PEP 669', 'the intended tracing path ran');
      assert.equal(outcome.aborted, true, JSON.stringify(outcome));
      assert.equal(outcome.timeoutReason, 'line-limit', 'the guard, not the trace budget, is the limit');
      assert.equal(outcome.traceLimitExceeded, true, 'the trace stays marked truncated');
      assert.ok(outcome.traceEvents > 0, 'the recorded prefix is kept');
      assert.ok([3, 4].includes(outcome.stoppedLine), `stopped in the loop, on line ${outcome.stoppedLine}`);
    });

    test(`${pathName}: a program that ends completes after ${budgetName} stop recording`, async () => {
      const outcome = await run(FINISHES, { ...pathOptions, ...budget });
      assert.equal(outcome.aborted, false, JSON.stringify(outcome));
      assert.equal(outcome.result, 60000);
      assert.equal(outcome.traceLimitExceeded, true);
      assert.ok(['trace-byte-limit', 'trace-limit'].includes(outcome.timeoutReason ?? ''), String(outcome.timeoutReason));
      assert.ok(outcome.traceEvents > 0);
    });
  }
}

// After the per-line recording budget, the old degraded path kept the tracer
// but, under sys.settrace, also counted the lines of the harness's access
// helpers (~14 per learner line), so a correct program hit the runaway
// ceiling after ~43k learner lines. Only the learner's lines count.
for (const [pathName, pathOptions] of Object.entries(PATHS)) {
  test(`${pathName}: a long correct program completes after the per-line budget stops recording`, async () => {
    // The app's Run budgets.
    const outcome = await run(FINISHES, {
      ...pathOptions,
      maxTraceSteps: 4000,
      maxLineEvents: 12000,
      maxSingleLineHits: 1000,
      maxStoredEvents: 16000,
    });
    assert.equal(outcome.aborted, false, JSON.stringify(outcome));
    assert.equal(outcome.result, 60000);
    assert.equal(outcome.timeoutReason, 'single-line-limit');
    assert.equal(outcome.traceLimitExceeded, true);
  });
}

test('sys.settrace: the per-case deadline still fires after the trace stops recording', async () => {
  const outcome = await run(SLOW_RUNAWAY, { wallClockMs: 1_500, maxTraceSteps: 5 });
  assert.equal(outcome.aborted, true, JSON.stringify(outcome));
  assert.equal(outcome.timeoutReason, 'client-timeout');
  assert.equal(outcome.traceLimitExceeded, true);
  assert.ok(outcome.ms < 10_000, `stopped after ${Math.round(outcome.ms)} ms`);
});
