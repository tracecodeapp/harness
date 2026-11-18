#!/usr/bin/env npx tsx
// Every Python path gives learner code the same names without an import, from
// one source of truth: the runtime's PYTHON_DEFAULT_IMPORT_PRELUDE. A pasted
// LeetCode solution (`nums: List[int]`) must pass the same way traced and
// untraced, direct and prepared, in the browser runtime and the native one.
// The prepared trace path and the Judge's fast batch run only in Pyodide; the
// learner-failure matrix (python typing-names) and the prepared-provider
// browser test cover them.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createNativeHarness } from '../packages/runtime-native/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Runtime = {
  PYTHON_DEFAULT_IMPORT_PRELUDE?: string;
  executeCode: (...args: unknown[]) => Promise<{ success: boolean; output?: unknown; error?: string; __preparedSource?: string }>;
  generateTracingCode: (...args: unknown[]) => { code: string };
};

function loadRuntime(): Runtime {
  const selfObject: Record<string, unknown> = {};
  vm.runInContext(
    readFileSync(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8'),
    vm.createContext({ console, self: selfObject, globalThis: {} }),
    { filename: 'python-runtime.js' }
  );
  return selfObject.__TRACECODE_PYODIDE_RUNTIME__ as Runtime;
}

const runPython = (script: string) => execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trimEnd();

function deps() {
  return {
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 100000,
      maxSingleLineHits: 100000,
      maxCallDepth: 100,
      maxMemoryBytes: 64 << 20,
      memoryCheckEvery: 10,
    },
    toPythonLiteral,
    loadPyodideInstance: async () => {},
    getPyodide: () => ({
      runPythonAsync: async (code: string) =>
        runPython(code.trimEnd().replace(/\n(_json_out)\s*$/, '\nprint($1)')),
    }),
    performanceNow: () => 0,
  };
}

type Path = (code: string, functionName: string, inputs: Record<string, unknown>, style: string) => Promise<unknown>;

function browserPaths(runtime: Runtime): Record<string, Path> {
  return {
    'executeCode (direct, untraced)': async (code, functionName, inputs, style) => {
      const result = await runtime.executeCode(deps(), code, functionName, inputs, style, {});
      if (!result.success) throw new Error(result.error);
      return result.output;
    },
    'prepared executeCode (untraced)': async (code, functionName, inputs, style) => {
      const prepared = await runtime.executeCode(deps(), code, functionName, inputs, style, {}, { compileOnly: true });
      const raw = JSON.parse(runPython([
        `__tracecode_prepared_user_code = compile(${JSON.stringify(code)}, 'solution.py', 'exec')`,
        `__tracecode_inputs_literal = ${JSON.stringify(toPythonLiteral(inputs))}`,
        `__tracecode_limits_literal = '{}'`,
        `__tracecode_tracing_enabled = False`,
        `__tracecode_inputs_need_materialization = False`,
        prepared.__preparedSource!,
        'import json as _probe_json',
        "print(_probe_json.dumps({k: _tracecode_raw_result.get(k) for k in ('kind', 'output', 'executionError')}, default=str))",
      ].join('\n')).split('\n').pop()!);
      if (raw.kind !== 'success-serialized') throw new Error(JSON.stringify(raw.executionError));
      return raw.output;
    },
    'executeWithTracing (direct, traced)': async (code, functionName, inputs, style) => {
      const traced = runtime.generateTracingCode(deps(), code, functionName, inputs, style, {
        maxTraceSteps: 200000,
        maxLineEvents: 2000000,
      });
      const dir = mkdtempSync(join(tmpdir(), 'tracecode-default-names-'));
      try {
        writeFileSync(join(dir, 'trace.py'), `${traced.code}\nprint(json.dumps({'result': _serialize_output(_result), 'error': [s for s in _trace_data if s.get('event') == 'exception'][:1]}))\n`);
        const parsed = JSON.parse(execFileSync('python3', [join(dir, 'trace.py')], { encoding: 'utf8' }).trim().split('\n').pop()!);
        if (parsed.error.length > 0) throw new Error(JSON.stringify(parsed.error));
        return parsed.result;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function nativePaths(harness: ReturnType<typeof createNativeHarness>): Record<string, Path> {
  const run = async (code: string, functionName: string, inputs: Record<string, unknown>, style: string, cases: number) => {
    const python = harness.getClient('python');
    const result = await python.execute({
      kind: 'code',
      code,
      functionName,
      executionStyle: style,
      cases: Array.from({ length: cases }, (_, index) => ({ id: `case-${index + 1}`, inputs })),
    } as never) as { cases: { outcome: { kind: string; output?: unknown; error?: string } }[] };
    const outcome = result.cases[0]?.outcome;
    if (!outcome || outcome.kind !== 'completed') throw new Error(JSON.stringify(outcome));
    return outcome.output;
  };
  return {
    'native executeCode (one case)': (code, functionName, inputs, style) => run(code, functionName, inputs, style, 1),
    'native batch (two cases)': (code, functionName, inputs, style) => run(code, functionName, inputs, style, 2),
  };
}

// The usual LeetCode signature, module-level uses of the typing names (so they
// are evaluated even where annotations are lazy), and the collections classes,
// which must win over typing's same-named generic aliases.
const LEETCODE = [
  'TYPING_NAMES = (List, Dict, Tuple, Optional, Set)',
  'class Solution:',
  '    def twoSum(self, nums: List[int], target: int) -> List[int]:',
  '        seen: Dict[int, int] = {}',
  '        for index, value in enumerate(nums):',
  '            if target - value in seen:',
  '                return [seen[target - value], index]',
  '            seen[value] = index',
  '        return []',
  '    def classes(self) -> List[bool]:',
  '        return [',
  '            type(Counter()) is collections.Counter,',
  '            OrderedDict is collections.OrderedDict,',
  '            ChainMap is collections.ChainMap,',
  '            deque is collections.deque,',
  '            defaultdict is collections.defaultdict,',
  '        ]',
  '',
].join('\n');

async function main(): Promise<void> {
  const runtime = loadRuntime();
  const harness = createNativeHarness();
  try {
    const paths = { ...browserPaths(runtime), ...nativePaths(harness) };
    for (const [name, path] of Object.entries(paths)) {
      let output: unknown;
      try {
        output = await path(LEETCODE, 'twoSum', { nums: [2, 7, 11, 15], target: 9 }, 'solution-method');
      } catch (error) {
        throw new Error(`${name}: a LeetCode-style List[int] solution must run without importing typing: ${String((error as Error).message).slice(0, 300)}`);
      }
      assertCondition(JSON.stringify(output) === JSON.stringify([0, 1]), `${name}: twoSum returned ${JSON.stringify(output)}`);
      const classes = await path(LEETCODE, 'classes', {}, 'solution-method');
      assertCondition(
        JSON.stringify(classes) === JSON.stringify([true, true, true, true, true]),
        `${name}: Counter, OrderedDict, ChainMap, deque and defaultdict must be the collections classes: ${JSON.stringify(classes)}`
      );
    }

    // One source of truth: the names learner code sees without an import are
    // exactly the runtime's prelude (plus json, math, sys and the node
    // classes), on every path, within a universe that also holds names a path
    // must NOT inject (unqualified math, copy and re names, other modules).
    const prelude = runtime.PYTHON_DEFAULT_IMPORT_PRELUDE;
    assertCondition(typeof prelude === 'string' && prelude.length > 0, 'the Python runtime must export PYTHON_DEFAULT_IMPORT_PRELUDE');
    const { universe, expected } = JSON.parse(runPython(`
import builtins, json
mods = ['typing', 'collections', 'heapq', 'bisect', 'itertools', 'functools', 'operator', 'math', 'copy', 're', 'string', 'array']
universe = set(['ast', 'array', 'string', 're', 'copy', 'random', 'time', 'dataclasses', 'typing', 'collections', 'heapq', 'bisect', 'itertools', 'functools', 'operator', 'json', 'math', 'sys', 'TreeNode', 'ListNode', 'SortedList', 'SortedDict', 'SortedSet'])
for name in mods:
    module = __import__(name)
    universe |= set(getattr(module, '__all__', [n for n in dir(module) if not n.startswith('_')]))
universe -= set(dir(builtins))
env = {}
exec('import json\\nimport math\\nimport sys\\n' + ${JSON.stringify(prelude)}, env)
expected = sorted((set(n for n in env if not n.startswith('_')) | {'TreeNode', 'ListNode'}) & universe)
print(json.dumps({'universe': sorted(universe), 'expected': expected}))
`).split('\n').pop()!) as { universe: string[]; expected: string[] };
    const probe = [
      'class Solution:',
      '    def names(self):',
      '        visible = globals()',
      `        return [name for name in ${JSON.stringify(universe)} if name in visible]`,
      '',
    ].join('\n');
    for (const [name, path] of Object.entries(paths)) {
      const visible = (await path(probe, 'names', {}, 'solution-method')) as string[];
      const missing = expected.filter((entry) => !visible.includes(entry));
      const extra = visible.filter((entry) => !expected.includes(entry));
      assertCondition(
        missing.length === 0 && extra.length === 0,
        `${name}: names without an import must be the runtime prelude's; missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`
      );
    }
    console.log(`PASS: ${Object.keys(paths).length} Python paths give the same ${expected.length} names without an import, and accept a LeetCode List[int] solution`);
  } finally {
    harness.dispose();
  }
}

await test('python default names', main);
