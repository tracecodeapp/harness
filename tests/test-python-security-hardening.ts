#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
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
import { RUNTIME_TRACE_SCHEMA_VERSION } from '../packages/runtime-contracts/src/runtime-trace';
import { createPythonRuntimeClient } from '../packages/runtime-python/src/python-runtime-client';
import type { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';

const RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');
const PYTHON_WORKER_PATH = join(process.cwd(), 'workers', 'python', 'python-worker.js');

type RuntimeDeps = {
  PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
  PYTHON_CONVERSION_HELPERS_SNIPPET: string;
  PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
  PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
  toPythonLiteral: (value: unknown) => string;
};

type RuntimeCore = {
  generateTracingCode: (
    deps: RuntimeDeps,
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => { code: string; userCodeStartLine: number };
};

type TraceRunSummary = {
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
  lineEventCount?: number;
  traceStepCount?: number;
};

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function loadRuntimeCore(): Promise<RuntimeCore> {
  const source = await readFile(RUNTIME_CORE_PATH, 'utf8');
  const selfObject: Record<string, unknown> = {};
  const context = vm.createContext({ console, self: selfObject, globalThis: {} });
  vm.runInContext(source, context, { filename: 'runtime-core.js' });
  const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
  assertCondition(typeof runtime === 'object' && runtime !== null, 'Unable to load Python runtime core');
  return runtime as RuntimeCore;
}

async function runPythonScript(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tracecode-python-security-'));
  const scriptPath = join(directory, 'case.py');
  await writeFile(scriptPath, source);
  try {
    return execFileSync('python3', [scriptPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runtimeDeps(): RuntimeDeps {
  return {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    toPythonLiteral,
  };
}

async function testPythonInputLiteralSerializationHandlesCycles(): Promise<void> {
  const cyclicObject: Record<string, unknown> = { label: 'root' };
  cyclicObject.self = cyclicObject;
  const cyclicArray: unknown[] = [1];
  cyclicArray.push(cyclicArray);

  const generatedLiteral = toPythonLiteral({ cyclicObject, cyclicArray });
  assertCondition(
    generatedLiteral === '{"cyclicObject": {"label": "root", "self": None}, "cyclicArray": [1, None]}',
    `generated Python input literal serialization should replace cycles with None: ${generatedLiteral}`
  );

  const source = await readFile(PYTHON_WORKER_PATH, 'utf8');
  const context = vm.createContext({
    console,
    self: {
      location: { search: '' },
      onmessage: null,
      postMessage: () => {},
    },
  });
  vm.runInContext(source, context, { filename: 'python-worker.js' });
  const fallbackLiteral = vm.runInContext(
    `(() => {
      const objectValue = { label: 'root' };
      objectValue.self = objectValue;
      const arrayValue = [1];
      arrayValue.push(arrayValue);
      return fallbackToPythonLiteral({ objectValue, arrayValue });
    })()`,
    context
  ) as string;

  assertCondition(
    fallbackLiteral === '{"objectValue": {"label": "root", "self": None}, "arrayValue": [1, None]}',
    `fallback Python input literal serialization should replace cycles with None: ${fallbackLiteral}`
  );
  console.log('PASS: Python input literal serialization handles cyclic values');
}

async function runTracingCase(
  source: string,
  functionName: string,
  executionStyle = 'function'
): Promise<TraceRunSummary> {
  const runtime = await loadRuntimeCore();
  const payload = runtime.generateTracingCode(
    runtimeDeps(),
    source,
    functionName,
    {},
    executionStyle,
    { maxTraceSteps: 2000, maxLineEvents: 500, maxSingleLineHits: 25 }
  );
  const stdout = await runPythonScript(`${payload.code}
print(json.dumps({
    'traceLimitExceeded': _trace_limit_exceeded,
    'timeoutReason': _timeout_reason,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_data)
}))
`);
  return JSON.parse(stdout) as TraceRunSummary;
}

async function testRepeatedLineSuppressionStillCountsBudget(): Promise<void> {
  const result = await runTracingCase(`def spin():
    while True:
        pass
`, 'spin');

  assertCondition(result.traceLimitExceeded === true, `Repeated empty line loop should trip the trace guard: ${JSON.stringify(result)}`);
  assertCondition(
    result.timeoutReason === 'single-line-limit' || result.timeoutReason === 'line-limit',
    `Repeated empty line loop should report a guard reason: ${JSON.stringify(result)}`
  );
  console.log('PASS: Python duplicate-line suppression still counts guard budget');
}

async function testSolutionConstructorRunsUnderTraceGuard(): Promise<void> {
  const result = await runTracingCase(`class Solution:
    def __init__(self):
        while True:
            pass

    def solve(self):
        return 1
`, 'solve', 'solution-method');

  assertCondition(result.traceLimitExceeded === true, `Solution.__init__ should run under the trace guard: ${JSON.stringify(result)}`);
  assertCondition(
    result.timeoutReason === 'single-line-limit' || result.timeoutReason === 'line-limit',
    `Solution.__init__ loop should report a guard reason: ${JSON.stringify(result)}`
  );
  console.log('PASS: Python Solution constructor runs under trace guard');
}

async function testTypingGlobalsSurvivePersistentCleanup(): Promise<void> {
  const runtime = await loadRuntimeCore();
  const firstPayload = runtime.generateTracingCode(
    runtimeDeps(),
    `def first(value):
    return value + 1
`,
    'first',
    { value: 1 },
    'function',
    { maxTraceSteps: 2000, maxLineEvents: 500, maxSingleLineHits: 25 }
  );
  const secondPayload = runtime.generateTracingCode(
    runtimeDeps(),
    `def second(nums: List[int]) -> int:
    return len(nums)
`,
    'second',
    { nums: [1, 2, 3] },
    'function',
    { maxTraceSteps: 2000, maxLineEvents: 500, maxSingleLineHits: 25 }
  );
  const stdout = await runPythonScript(`${firstPayload.code}
${secondPayload.code}
print(json.dumps({
    'hasList': 'List' in globals(),
    'traceFailed': _trace_failed,
    'lastReturn': next((step.get('returnValue') for step in reversed(_trace_data) if step.get('event') == 'return'), None)
}))
`);
  const result = JSON.parse(stdout) as { hasList?: boolean; traceFailed?: boolean; lastReturn?: unknown };
  assertCondition(result.hasList === true, `Persistent Python cleanup should preserve typing.List: ${JSON.stringify(result)}`);
  assertCondition(result.traceFailed !== true, `Second typed Python run should not fail after cleanup: ${JSON.stringify(result)}`);
  assertCondition(result.lastReturn === 3, `Second typed Python run should return normally: ${JSON.stringify(result)}`);
  console.log('PASS: Python typing globals survive persistent cleanup');
}

async function testCallsiteFlushDoesNotRunUserRepr(): Promise<void> {
  const result = await runTracingCase(`class Bomb:
    __slots__ = ()
    def __repr__(self):
        while True:
            pass

def child():
    return 1

def solve():
    bomb = Bomb()
    return child()
`, 'solve');

  assertCondition(result.traceLimitExceeded !== true, `Callsite flush should not invoke user repr while snapshotting locals: ${JSON.stringify(result)}`);
  assertCondition(
    result.timeoutReason === undefined || result.timeoutReason === null,
    `Skipped user repr should not report a guard timeout: ${JSON.stringify(result)}`
  );
  console.log('PASS: Python callsite flush skips user repr while snapshotting locals');
}

async function testPythonRuntimeClientNormalizesTraceResponse(): Promise<void> {
  const protoPayload = JSON.parse('{"__proto__":{"poisoned":true},"ok":true}');
  const fakeWorker = {
    init: async () => ({ success: true, loadTimeMs: 0 }),
    executeWithTracing: async () => ({
      success: true,
      output: protoPayload,
      executionTimeMs: Number.POSITIVE_INFINITY,
      consoleOutput: { not: 'an array' },
      trace: {
        schemaVersion: 'malicious',
        language: 'python',
        runId: 'python:run',
        events: [
          { kind: 'line', line: 1, function: 'solve', extra: { ignored: true } },
          { kind: 'control', line: 1, target: { variable: 'x' } },
          { kind: 'snapshot', line: 2, target: { variable: 'x', path: ['safe', {}, 1] }, value: { nested: [1, () => 'drop'] } },
          { kind: 'stdout', text: { object: true } },
          { kind: 'read', line: 'bad', target: { variable: 'x' } },
          { kind: 'exception', message: 'normalized' },
        ],
      },
    }),
    executeCode: async () => ({ success: true, output: null, consoleOutput: [] }),
    executeCodeBatch: async () => ({ success: true, results: [] }),
    executeProjectPython: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  } as unknown as PythonWorkerClient;
  const client = createPythonRuntimeClient(fakeWorker);
  const result = await client.executeWithTracing({ code: 'def solve(): return 1', functionName: 'solve', inputs: {} });

  assertCondition(result.kind === 'completed', `Python normalized trace response should lift to a completed outcome: ${JSON.stringify(result)}`);
  assertCondition(result.executionTimeMs === 0, `Python trace execution time should be normalized: ${JSON.stringify(result.executionTimeMs)}`);
  assertCondition(Array.isArray(result.consoleOutput) && result.consoleOutput.length === 0, 'Python console output should normalize to string[]');
  assertCondition(result.trace.schemaVersion === RUNTIME_TRACE_SCHEMA_VERSION, 'Python trace schema version should be normalized');
  assertCondition(result.trace.events.length === 4, `Python trace should drop malformed events: ${JSON.stringify(result.trace.events)}`);
  assertCondition(result.trace.events.every((event) => (event.kind as string) !== 'control'), 'Python trace should reject unsupported event kinds');
  const snapshot = result.trace.events.find((event) => event.kind === 'snapshot');
  assertCondition(snapshot?.kind === 'snapshot' && (snapshot.target as { variable?: string }).variable === 'x', 'Python snapshot target should be preserved');
  assertCondition(
    snapshot?.kind === 'snapshot' && JSON.stringify((snapshot.target as { path?: unknown }).path) === '["safe",1]',
    `Python snapshot path should drop malformed components: ${JSON.stringify(snapshot)}`
  );
  const normalizedOutput = result.output as Record<string, unknown>;
  assertCondition(Object.getPrototypeOf(normalizedOutput) === null, 'Python sanitized object output should use a null prototype');
  assertCondition(
    Object.prototype.hasOwnProperty.call(normalizedOutput, '__proto__') && !('poisoned' in normalizedOutput),
    'Python sanitized output should keep __proto__ inert instead of poisoning the result prototype'
  );
  console.log('PASS: Python runtime client normalizes trace responses');
}

async function testPythonProjectBridgeHardeningHooksArePresent(): Promise<void> {
  const source = await readFile(PYTHON_WORKER_PATH, 'utf8');
  assertCondition(source.includes('_tracekernel_http_validate_component'), 'Python HTTPServer shim should validate request-line and host components');
  assertCondition(source.includes('_reserved_query_names'), 'Python ASGI shim should reserve explicit and injected parameter names before copying query params');
  assertCondition(source.includes('_kwargs[_name] = _request_obj'), 'Python ASGI shim should let Request injection overwrite query parameters');
  assertCondition(source.includes("target.outputDevice === '/dev/null'"), 'Python provider FS device writes should discard /dev/null');
  assertCondition(source.includes('_output_device == "/dev/null"'), 'Python os.write should discard /dev/null');
  assertCondition(source.includes('def _canonical_virtual_namespace_path'), 'Python /dev and /proc policy should canonicalize namespace paths');
  assertCondition(source.includes('def _project_snapshot_absolute_path'), 'Python project snapshots should normalize through a dedicated snapshot path gate');
  assertCondition(source.includes('os.path.islink(_absolute)'), 'Python project snapshots should skip symlink entries');
  assertCondition(
    source.includes('os.path.realpath(_root)') && source.includes('os.path.realpath(_absolute_path)'),
    'Python project snapshots should require realpaths to stay inside the project root'
  );
  assertCondition(
    source.includes('os.walk(_absolute_path, followlinks=False)') && source.includes('os.walk(_root, followlinks=False)'),
    'Python project snapshots should disable symlink-following directory walks'
  );
  assertCondition(source.includes('_project_snapshot_directory_key'), 'Python project snapshots should track visited directories while walking');
  console.log('PASS: Python project bridge hardening hooks are present');
}

await testPythonInputLiteralSerializationHandlesCycles();
await testRepeatedLineSuppressionStillCountsBudget();
await testSolutionConstructorRunsUnderTraceGuard();
await testTypingGlobalsSurvivePersistentCleanup();
await testCallsiteFlushDoesNotRunUserRepr();
await testPythonRuntimeClientNormalizesTraceResponse();
await testPythonProjectBridgeHardeningHooksArePresent();
