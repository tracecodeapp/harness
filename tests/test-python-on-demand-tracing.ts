#!/usr/bin/env npx tsx

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

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runPythonScript(script: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-python-on-demand-'));
  const scriptPath = join(tempDir, 'test.py');
  await writeFile(scriptPath, script, 'utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`python3 exited with ${code}\n${stderr}`));
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const source = await readFile('workers/python/python-runtime.js', 'utf8');
const selfObject: Record<string, unknown> = {};
vm.runInContext(source, vm.createContext({
  console,
  self: selfObject,
  globalThis: {},
}), { filename: 'python-runtime.js' });

const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__ as {
  generateTracingCode(
    deps: Record<string, unknown>,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: string,
    options: Record<string, unknown>,
    prepared: Record<string, unknown>
  ): { code: string };
  executeWithTracing(
    deps: Record<string, unknown>,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: string,
    options: Record<string, unknown>,
    prepared: Record<string, unknown>
  ): Promise<{ __preparedSource: string }>;
};
assertCondition(runtime?.generateTracingCode, 'Python Python runtime did not load');

const userCode = [
  '"""on-demand module"""',
  'from __future__ import annotations',
  'def solve(values: list[int]) -> int:',
  '    return values[0]',
].join('\n');
const payload = runtime.generateTracingCode(
  {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  },
  userCode,
  'solve',
  {},
  'function',
  {},
  { compileUserOnly: true, onDemand: true }
);

const stdout = await runPythonScript(`${payload.code}
def _tracecode_bomb(*args, **kwargs):
    raise RuntimeError('instrumented branch ran')

_traced_globals = dict(globals())
_traced_globals['__tracecode_tracing_enabled'] = True
exec(__tracecode_prepared_user_code_result, _traced_globals)
_traced_globals['_tracecode_read_index'] = _tracecode_bomb
_traced_hook_called = False
try:
    _traced_globals['solve']([7])
except RuntimeError as _error:
    _traced_hook_called = str(_error) == 'instrumented branch ran'

_clean_globals = dict(globals())
_clean_globals['__tracecode_tracing_enabled'] = False
exec(__tracecode_prepared_user_code_result, _clean_globals)
_clean_globals['_tracecode_read_index'] = _tracecode_bomb
_clean_result = _clean_globals['solve']([7])

_original_print(json.dumps({
    'cleanResult': _clean_result,
    'cleanDoc': _clean_globals.get('__doc__'),
    'tracedHookCalled': _traced_hook_called,
}))
`);
const result = JSON.parse(stdout.trim()) as {
  cleanResult?: unknown;
  cleanDoc?: unknown;
  tracedHookCalled?: unknown;
};
assertCondition(
  result.cleanResult === 7 &&
    result.cleanDoc === 'on-demand module' &&
    result.tracedHookCalled === true,
  `Python on-demand code object did not select raw versus instrumented branches: ${stdout}`
);

const executorDeps = {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  INTERVIEW_GUARD_DEFAULTS: {
    maxLineEvents: 10_000,
    maxSingleLineHits: 1_000,
    maxCallDepth: 100,
    maxMemoryBytes: 8 * 1024 * 1024,
    memoryCheckEvery: 10,
  },
  toPythonLiteral,
  loadPyodideInstance: async () => {},
  performanceNow: () => performance.now(),
};
const traceExecutor = await runtime.executeWithTracing(
  executorDeps,
  userCode,
  'solve',
  {},
  'function',
  {},
  { compileOnly: true }
);
assertCondition(
  traceExecutor.__preparedSource.includes(
    'if __tracecode_tracing_enabled:\n    _tracecode_arm_tracing()'
  ),
  'Prepared trace executor must conditionally arm tracing'
);
const traceExecutorBase64 = Buffer.from(
  traceExecutor.__preparedSource,
  'utf8'
).toString('base64');
await runPythonScript(`
import base64
_source = base64.b64decode(${JSON.stringify(traceExecutorBase64)}).decode('utf-8')
assert isinstance(compile(_source, '<tracecode-prepared-trace>', 'exec'), type(compile('', '', 'exec')))
`);

console.log('PASS: Python one-artifact conditional trace executor');
