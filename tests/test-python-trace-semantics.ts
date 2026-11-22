#!/usr/bin/env npx tsx

// A traced Python Run must compute what the untraced program computes. Each
// case runs the learner source twice under CPython: once as written (the
// oracle) and once through the tracing rewriter, and compares the returned
// value or the raised exception's type and message. A traced run that fell
// back to running untraced (trace-unavailable) fails unless the case expects
// it, and each program must also compile on the on-demand (prepared) path.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';
import { pythonTraceSemanticsCases, pythonTraceSemanticsPositionCases } from './fixtures/python-trace-semantics-cases';

type PythonRuntime = {
  generateTracingCode: (
    deps: unknown,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>,
    prepared?: Record<string, unknown>,
  ) => { code: string };
};

const deps = {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  toPythonLiteral,
};

async function loadPythonRuntime(): Promise<PythonRuntime> {
  const source = await readFile(join(process.cwd(), 'workers', 'python', 'python-runtime.js'), 'utf8');
  const selfObject: Record<string, unknown> = {};
  vm.runInContext(source, vm.createContext({ console, self: selfObject, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  return selfObject.__TRACECODE_PYODIDE_RUNTIME__ as PythonRuntime;
}

async function runPython(dir: string, name: string, script: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, script, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim().split('\n').pop() ?? '');
      else reject(new Error(`python3 exited with ${code}\n${stderr}`));
    });
  });
}

function oracleScript(code: string, functionName: string, inputs: Record<string, unknown>) {
  return `import json
${code}
try:
    _value = ${functionName}(**json.loads(${JSON.stringify(JSON.stringify(inputs))}))
    print(json.dumps({'value': _value}))
except Exception as error:
    # The untraced runner's wording when the exception cannot be formatted.
    try:
        _message = str(error)
    except BaseException:
        _message = 'Execution failed'
    print(json.dumps({'error': [type(error).__name__, _message]}))
`;
}

// Reads the outcome from the summary the worker reports to the host, so a
// trace step that the host would read as a failure counts as one here.
const tracedEpilogue = `
_tc_summary = json.loads(__tracecode_execution_result_json)
_tc_error_step = _tc_summary['traceSummary']['errorStep']
_tc_outcome = (
    {'error': [_tc_error_step.get('variables', {}).get('errorType'), _tc_error_step.get('variables', {}).get('error')]}
    if _tc_error_step
    else {'value': _tc_summary['result']}
)
print(json.dumps({'outcome': _tc_outcome, 'traceUnavailable': _tc_summary.get('traceUnavailable')}))
`;

// Instrumentation must not add * or ** calls (CALL_FUNCTION_EX): one runs a
// bound method through PyObject_Call, costing C stack per recursion level,
// which overflows the browser's wasm stack (CPython's own stack hides it).
// The on-demand module holds the raw and the instrumented program, so its
// count is twice the learner program's own (or equal to it on fallback).
const preparedEpilogue = `
import dis as _tc_dis
def _tc_count_call_ex(code):
    count = sum(1 for instruction in _tc_dis.get_instructions(code) if instruction.opname == 'CALL_FUNCTION_EX')
    for constant in code.co_consts:
        if isinstance(constant, type(code)):
            count += _tc_count_call_ex(constant)
    return count
_tc_call_ex = [
    _tc_count_call_ex(compile(_user_code_str, 'solution.py', 'exec')),
    _tc_count_call_ex(__tracecode_prepared_user_code_result),
]
_tc_unavailable = globals().get('_tracecode_trace_unavailable_message', lambda code: None)
# Compile-only payloads leave print captured; write to the real stdout.
sys.__stdout__.write(json.dumps({'traceUnavailable': _tc_unavailable(__tracecode_prepared_user_code_result), 'callEx': _tc_call_ex}) + '\\n')
`;

// An instrumentation failure (transformer exception or a compile error in the
// instrumented program) must never reach the learner: the traced Run returns
// the untraced outcome with an empty trace and a trace-unavailable notice. A
// learner's own compile error is still the learner's.
const INSTRUMENT_DEF = 'def __tracecode_compile_instrumented_user_code(source, raw_tree, on_demand):\n';
const fallbackEpilogue = `
_tc_summary = json.loads(__tracecode_execution_result_json)
_tc_error_step = _tc_summary['traceSummary']['errorStep']
print(json.dumps({
    'outcome': (
        {'error': [_tc_error_step['variables']['errorType'], _tc_error_step['variables']['error']]}
        if _tc_error_step
        else {'value': _tc_summary['result']}
    ),
    'traceUnavailable': _tc_summary.get('traceUnavailable'),
    'events': len(_tc_summary['runtimeTrace']['events']),
}))
`;

async function checkInstrumentationFallback(runtime: PythonRuntime, dir: string, failures: string[]) {
  const programs = [
    { id: 'fallback-value', code: 'def solve(n):\n    seen = {}\n    for i in range(n):\n        seen[i] = i * i\n    return seen\n', inputs: { n: 3 } },
    { id: 'fallback-learner-error', code: 'def solve():\n    data = [1]\n    return data[3]\n', inputs: {} },
  ];
  for (const program of programs) {
    const oracle = JSON.parse(await runPython(dir, 'oracle.py', oracleScript(program.code, 'solve', program.inputs)));
    const payload = runtime.generateTracingCode(deps, program.code, 'solve', program.inputs, 'function', {});
    if (!payload.code.includes(INSTRUMENT_DEF)) throw new Error('instrumentation entry point not found');
    const broken = payload.code.replace(INSTRUMENT_DEF, INSTRUMENT_DEF + "    raise RuntimeError('injected instrumentation failure')\n");
    const run = JSON.parse(await runPython(dir, 'fallback.py', broken + fallbackEpilogue));
    const ok =
      JSON.stringify(run.outcome) === JSON.stringify(oracle) &&
      typeof run.traceUnavailable === 'string' &&
      run.traceUnavailable.includes('RuntimeError') &&
      run.events === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${program.id}: untraced ${JSON.stringify(oracle)} fallback ${JSON.stringify(run)}`);
    if (!ok) failures.push(program.id);
  }
  // The learner's compile error, not an instrumentation fallback.
  const invalid = 'def solve():\n    return 1\nreturn 2\n';
  const payload = runtime.generateTracingCode(deps, invalid, 'solve', {}, 'function', {});
  const broken = payload.code.replace(INSTRUMENT_DEF, INSTRUMENT_DEF + "    raise RuntimeError('injected instrumentation failure')\n");
  let message = '';
  try {
    await runPython(dir, 'invalid.py', broken + fallbackEpilogue);
  } catch (error) {
    message = String(error);
  }
  const ok = message.includes("SyntaxError: 'return' outside function");
  console.log(`${ok ? 'PASS' : 'FAIL'} fallback-learner-compile-error: ${ok ? 'SyntaxError from the learner program' : JSON.stringify(message.slice(-300))}`);
  if (!ok) failures.push('fallback-learner-compile-error');
}

async function main() {
  const runtime = await loadPythonRuntime();
  const only = new Set((process.env.TRACECODE_SEMANTICS_CASES ?? '').split(',').filter(Boolean));
  const cases = [...pythonTraceSemanticsCases, ...pythonTraceSemanticsPositionCases].filter(({ id }) => !only.size || only.has(id));
  const dir = await mkdtemp(join(tmpdir(), 'tracecode-python-semantics-'));
  const failures: string[] = [];
  try {
    for (const testCase of cases) {
      const inputs = testCase.inputs ?? {};
      const oracle = JSON.parse(await runPython(dir, 'oracle.py', oracleScript(testCase.code, 'solve', inputs)));
      if (testCase.expected !== undefined && JSON.stringify(oracle) !== JSON.stringify(testCase.expected)) {
        throw new Error(`${testCase.id}: oracle ${JSON.stringify(oracle)} is not the documented ${JSON.stringify(testCase.expected)}`);
      }
      const payload = runtime.generateTracingCode(deps, testCase.code, 'solve', inputs, 'function', {
        maxTraceSteps: 5000,
        maxLineEvents: 20000,
      });
      const tracedRun = JSON.parse(await runPython(dir, 'traced.py', payload.code + tracedEpilogue));
      const traced = tracedRun.outcome;
      const preparedPayload = runtime.generateTracingCode(deps, testCase.code, 'solve', {}, 'function', {}, {
        compileUserOnly: true,
        onDemand: true,
      });
      const prepared = JSON.parse(await runPython(dir, 'prepared.py', preparedPayload.code + preparedEpilogue));
      const expectsFallback = testCase.traceUnavailable === true;
      const same = JSON.stringify(traced) === JSON.stringify(oracle);
      const fallbackAsExpected =
        (typeof tracedRun.traceUnavailable === 'string') === expectsFallback &&
        (typeof prepared.traceUnavailable === 'string') === expectsFallback;
      const [rawCallEx, preparedCallEx] = prepared.callEx as [number, number];
      const callFormKept = preparedCallEx === (expectsFallback ? rawCallEx : 2 * rawCallEx);
      const ok = same && fallbackAsExpected && callFormKept;
      const fallbackNote = tracedRun.traceUnavailable || prepared.traceUnavailable
        ? ` (trace-unavailable: run ${JSON.stringify(tracedRun.traceUnavailable)}, prepared ${JSON.stringify(prepared.traceUnavailable)})`
        : '';
      const callNote = callFormKept ? '' : ` (instrumentation added * / ** calls: ${preparedCallEx} in the on-demand module for ${rawCallEx} in the program)`;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.id}: untraced ${JSON.stringify(oracle)} traced ${JSON.stringify(traced)}${fallbackNote}${callNote}`);
      if (!ok) failures.push(testCase.id);
    }
    if (!only.size) await checkInstrumentationFallback(runtime, dir, failures);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    throw new Error(`Traced Python changed program results: ${failures.join(', ')}`);
  }
  console.log(`\nTraced Python matched untraced results for ${cases.length} programs.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
