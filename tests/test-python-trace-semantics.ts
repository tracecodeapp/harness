#!/usr/bin/env npx tsx

// A traced Python Run must compute what the untraced program computes. Each
// case runs the learner source twice under CPython: once as written (the
// oracle) and once through the tracing rewriter, and compares the returned
// value or the raised exception's type and message.

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
    print(json.dumps({'error': [type(error).__name__, str(error)]}))
`;
}

const tracedEpilogue = `
_tc_outcome = (
    {'error': [_tracecode_program_error_step['variables']['errorType'], _tracecode_program_error_step['variables']['error']]}
    if _tracecode_program_error_step is not None
    else {'value': json.loads(json.dumps(_serialize_output(_result)))}
)
print(json.dumps(_tc_outcome))
`;

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
      const traced = JSON.parse(await runPython(dir, 'traced.py', payload.code + tracedEpilogue));
      const same = JSON.stringify(traced) === JSON.stringify(oracle);
      console.log(`${same ? 'PASS' : 'FAIL'} ${testCase.id}: untraced ${JSON.stringify(oracle)} traced ${JSON.stringify(traced)}`);
      if (!same) failures.push(testCase.id);
    }
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
