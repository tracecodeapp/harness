#!/usr/bin/env npx tsx
/**
 * A retained Python observer draws later cases exactly as a fresh one does.
 *
 * The browser keeps an algorithm-fast observer's worker for the next
 * click-draw, so one interpreter runs many drawings. Here, in Pyodide (the
 * browser worker's Python, with the native recorder wheel) and through the
 * worker runtime's own prepare and execute entry points:
 *
 * - one retained interpreter draws every program's cases in order, every
 *   program after the others; earlier cases mutate globals, mutable
 *   defaults, class attributes, caches, module-level containers, the seeded
 *   random stream, the call stack (deep recursion that raises) and the
 *   tracer's budgets (near-limit and over-limit drawings);
 * - each drawing equals, byte for byte, a fresh interpreter's first drawing
 *   of the same case, its recorder evidence and counters included;
 * - algorithm-fast observers draw in the algorithm scope and every other
 *   program in the compatibility scope (witnessed on the real guard);
 * - the algorithm scope leaves no learner-visible module state behind: a
 *   snapshot of every loaded module, as the compatibility scope takes it,
 *   is unchanged by each algorithm-fast drawing;
 * - the comparison can see a leak: a program that writes a module attribute
 *   is classified off the fast tier, and with its tier forced to
 *   algorithm-fast its second drawing differs.
 *
 * Compatibility-classified programs follow the client's rule and draw each
 * case on a fresh interpreter (an observer is kept only after an
 * algorithm-fast drawing). Algorithm-fast programs keep the interpreter
 * after every drawing, truncated or raising ones included, which is stricter
 * than the client.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../packages/runtime-python/src/python-harness';
import { PROGRAMS, type Program } from './fixtures/python-retained-observer-programs';

const NATIVE_WHEEL = 'workers/python/tracecode_native-0.1.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl';
// The observer's own wall clock (python-runtime-client executeObservation).
const OBSERVER_LIMITS = { guest: { wallClockMs: 10_000 } };

type Runtime = Record<string, (...args: any[]) => Promise<any>>;

// The compatibility scope's view of module state: every loaded module's
// bindings, and each plain container it holds (dict, list, set, bytearray),
// compared entry by entry and, where a deep copy compares equal, by value.
const MODULE_STATE_PROBE = `
_TC_PROBE_VALUES = (str, bytes, int, float, bool, type(None), tuple, frozenset)

def _tc_probe_same(new, old):
    # The same object, or an equal immutable value.
    return new is old or (
        type(new) is type(old)
        and type(new) in _TC_PROBE_VALUES
        and new == old
    )

def _tc_probe_entries(value):
    if type(value) is dict:
        return dict(value)
    if type(value) in (list, bytearray):
        return list(value)
    return set(value)

def _tc_probe_entries_same(value, entries):
    if type(value) is dict:
        return value.keys() == entries.keys() and all(
            _tc_probe_same(value[key], entries[key]) for key in entries
        )
    if type(value) in (list, bytearray):
        return len(value) == len(entries) and all(
            _tc_probe_same(new, old) for new, old in zip(value, entries)
        )
    return value == entries

def _tc_probe_snapshot():
    import sys as _sys, copy as _copy
    state = {}
    for name, module in list(_sys.modules.items()):
        namespace = getattr(module, '__dict__', None)
        if not isinstance(namespace, dict) or name == '__main__':
            continue
        bindings = dict(namespace)
        containers = {}
        for key, value in bindings.items():
            if type(value) not in (dict, list, set, bytearray):
                continue
            deep = None
            try:
                candidate = _copy.deepcopy(value)
                if candidate == value:
                    deep = candidate
            except Exception:
                pass
            containers[key] = (_tc_probe_entries(value), deep)
        state[name] = (bindings, containers)
    return state

def _tc_probe_diff(before):
    import sys as _sys
    changes = []
    for name, (bindings, containers) in before.items():
        module = _sys.modules.get(name)
        namespace = getattr(module, '__dict__', None)
        if not isinstance(namespace, dict):
            changes.append(name + ': module gone')
            continue
        for key in set(bindings) | set(namespace):
            if key not in namespace:
                changes.append(name + '.' + key + ': removed')
            elif key not in bindings:
                changes.append(name + '.' + key + ': added')
            elif namespace[key] is not bindings[key]:
                changes.append(name + '.' + key + ': rebound')
            elif key in containers:
                entries, deep = containers[key]
                value = namespace[key]
                if not _tc_probe_entries_same(value, entries):
                    changes.append(name + '.' + key + ': entries changed')
                elif deep is not None:
                    try:
                        same = value == deep
                    except Exception:
                        same = False
                    if not same:
                        changes.append(name + '.' + key + ': contents changed')
    return sorted(changes)
`;

interface Interpreter {
  readonly scopes: string[];
  prepare(program: Program, tierOverride?: string): Promise<Record<string, any>>;
  draw(artifact: Record<string, any>, inputs: Record<string, unknown>): Promise<string>;
  /** Module-state changes a drawing left behind. */
  drawProbed(artifact: Record<string, any>, inputs: Record<string, unknown>): Promise<{ drawing: string; changes: string[] }>;
}

let loadPyodide: (options?: Record<string, unknown>) => Promise<any>;
let runtimeSource: string;

async function interpreter(): Promise<Interpreter> {
  if (!loadPyodide) {
    const require = createRequire(join(process.cwd(), 'package.json'));
    loadPyodide = require('pyodide').loadPyodide;
    runtimeSource = await readFile(join(process.cwd(), 'workers/python/python-runtime.js'), 'utf8');
  }
  const pyodide = await loadPyodide();
  pyodide.setStdout({ batched: () => undefined });
  pyodide.setStderr({ batched: () => undefined });
  await pyodide.loadPackage(join(process.cwd(), NATIVE_WHEEL), {
    messageCallback: () => undefined,
    errorCallback: () => undefined,
  });
  pyodide.runPython('import _tracecode_native');

  // Witness the real guard's scopes: the runtime builds it with one
  // runPython call and keeps the returned proxy.
  const scopes: string[] = [];
  const witnessed = new Proxy(pyodide, {
    get(target, property, receiver) {
      if (property !== 'runPython') return Reflect.get(target, property, receiver);
      return (source: string, ...rest: unknown[]) => {
        const value = target.runPython(source, ...rest);
        if (!String(source).includes('class __TracecodeExecutionGuard')) return value;
        return new Proxy(value, {
          get(guard, name) {
            const member = guard[name];
            if (name === 'begin' || name === 'begin_algorithm') {
              return (...args: unknown[]) => {
                scopes.push(String(name));
                return member(...args);
              };
            }
            // Python attributes pass through; the proxy's own JS methods
            // (toJs, destroy) keep the real proxy as their receiver.
            return typeof member === 'function' && !(member instanceof pyodide.ffi.PyProxy)
              ? member.bind(guard)
              : member;
          },
        });
      };
    },
  });

  const self: Record<string, any> = {};
  vm.runInContext(runtimeSource, vm.createContext({ console, self, globalThis: {} }), {
    filename: 'python-runtime.js',
  });
  const runtime: Runtime = self.__TRACECODE_PYODIDE_RUNTIME__;
  const deps = {
    toPythonLiteral,
    PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
    PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
    PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
    PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
    INTERVIEW_GUARD_DEFAULTS: {
      maxLineEvents: 4_000_000,
      maxSingleLineHits: 1_500_000,
      maxCallDepth: 2000,
      maxMemoryBytes: 96 * 1024 * 1024,
      memoryCheckEvery: 200,
    },
    loadPyodideInstance: async () => {},
    getPyodide: () => witnessed,
    performanceNow: () => performance.now(),
  };
  // The probe's own functions live in __main__, which it skips.
  pyodide.runPython(MODULE_STATE_PROBE);
  const snapshot = pyodide.globals.get('_tc_probe_snapshot');
  const diff = pyodide.globals.get('_tc_probe_diff');

  const draw = async (artifact: Record<string, any>, inputs: Record<string, unknown>) => {
    const result = await runtime.executePreparedProgram!(deps, artifact, inputs, OBSERVER_LIMITS);
    // Everything the worker returns except its clocks.
    const { executionTimeMs: _clock, timings: _timings, ...drawing } = result;
    return JSON.stringify(drawing);
  };
  return {
    scopes,
    async prepare(program, tierOverride) {
      const prepared = await runtime.prepareProgram!(deps, {
        mode: 'trace',
        code: program.code,
        functionName: program.functionName,
        executionStyle: program.executionStyle,
        traceOptions: program.traceOptions ?? {},
        observationOnly: true,
      });
      assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
      const artifact = prepared.artifact;
      return tierOverride
        ? { ...artifact, isolationProfile: { ...artifact.isolationProfile, tier: tierOverride } }
        : artifact;
    },
    draw,
    async drawProbed(artifact, inputs) {
      const before = snapshot();
      try {
        const drawing = await draw(artifact, inputs);
        const changes = diff(before);
        try {
          return { drawing, changes: changes.toJs() };
        } finally {
          changes.destroy();
        }
      } finally {
        before.destroy();
      }
    },
  };
}

async function freshDrawing(program: Program, inputs: Record<string, unknown>) {
  const fresh = await interpreter();
  return fresh.draw(await fresh.prepare(program), inputs);
}

const FAST = Object.entries(PROGRAMS).filter(([, program]) => program.expectTier === 'algorithm-fast');
const COMPATIBLE = Object.entries(PROGRAMS).filter(([, program]) => program.expectTier === 'compatibility');

// The regular-expression compile cache. A drawing's first import of a
// stdlib module (pickle compiles a pattern at import) adds an entry; both
// scopes drop the module from sys.modules afterwards, and a compiled pattern
// is immutable, so the cache cannot change what a later drawing computes.
const COMPILE_CACHES = new Set(['re._cache: entries changed', 're._cache2: entries changed']);

function learnerVisible(changes: readonly string[]): string[] {
  return changes.filter((change) => !COMPILE_CACHES.has(change));
}

function parsed(drawing: string) {
  return JSON.parse(drawing) as Record<string, any>;
}

/** Where two drawings first differ, for the assertion message. */
function firstDifference(retained: string, fresh: string): string {
  const left = parsed(retained);
  const right = parsed(fresh);
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => key !== 'trace' && JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => `${key}: ${JSON.stringify(left[key])} vs ${JSON.stringify(right[key])}`);
  const leftEvents: unknown[] = left.trace?.events ?? [];
  const rightEvents: unknown[] = right.trace?.events ?? [];
  const index = leftEvents.findIndex((event, at) => JSON.stringify(event) !== JSON.stringify(rightEvents[at]));
  const at = index === -1 && leftEvents.length !== rightEvents.length ? leftEvents.length : index;
  return [
    `events ${leftEvents.length} vs ${rightEvents.length}`,
    ...fields,
    ...(at === -1 ? [] : [
      `first differing event #${at}:`,
      `  retained ${JSON.stringify(leftEvents[at])}`,
      `  fresh    ${JSON.stringify(rightEvents[at])}`,
    ]),
  ].join('\n');
}

function assertSameDrawing(retained: string, fresh: string, label: string): void {
  if (retained !== fresh) assert.fail(`${label}: retained and fresh drawings differ\n${firstDifference(retained, fresh)}`);
}

test('a retained algorithm-fast observer draws every later case as a fresh observer does', { timeout: 600_000 }, async () => {
  const retained = await interpreter();
  const leaks: string[] = [];
  const statuses: string[] = [];
  for (const [name, program] of FAST) {
    const artifact = await retained.prepare(program);
    assert.equal(artifact.isolationProfile.tier, 'algorithm-fast', `${name}: ${JSON.stringify(artifact.isolationProfile)}`);
    for (const [index, inputs] of program.inputs.entries()) {
      const label = `${name} case ${index + 1} ${JSON.stringify(inputs)}`;
      const scopeStart = retained.scopes.length;
      const { drawing, changes } = await retained.drawProbed(artifact, inputs);
      assert.deepEqual(retained.scopes.slice(scopeStart), ['begin_algorithm'], `${label}: drawing scope`);
      leaks.push(...learnerVisible(changes).map((change) => `${label}: ${change}`));
      const result = parsed(drawing);
      assert.equal(result.observation?.recorderCompleted, true, `${label}: ${drawing.slice(0, 300)}`);
      statuses.push(`${name}:${result.traceLimitReason ?? (result.success ? 'ok' : 'raised')}`);
      assertSameDrawing(drawing, await freshDrawing(program, inputs), label);
    }
  }
  // The algorithm scope restores nothing per module, and nothing needed it.
  assert.deepEqual(leaks, []);
  // The sequence really exercised the tracer's budgets and a raising case.
  assert.ok(statuses.includes('tracerBudgets:single-line-limit'), statuses.join(' '));
  assert.equal(statuses.filter((entry) => entry === 'recursionAndExceptions:raised').length, 2, statuses.join(' '));
  // Every other drawing completes.
  assert.deepEqual(
    statuses.filter((entry) => !entry.startsWith('tracerBudgets:') && !entry.startsWith('recursionAndExceptions:') && !entry.endsWith(':ok')),
    [],
    statuses.join(' ')
  );
  assert.equal(statuses.filter((entry) => entry === 'tracerBudgets:ok').length, 5, statuses.join(' '));
});

/** The value the drawing's learner call returned. */
function returned(drawing: string, functionName: string): unknown {
  const events: Array<Record<string, any>> = parsed(drawing).trace?.events ?? [];
  const exits = events.filter((event) => event.kind === 'return' && event.function === functionName);
  return exits.at(-1)?.value;
}

test('compatibility-classified observers draw in the compatibility scope, and correctly', { timeout: 600_000 }, async () => {
  for (const [name, program] of COMPATIBLE) {
    for (const [index, inputs] of program.inputs.entries()) {
      const label = `${name} case ${index + 1}`;
      // The client retires a compatibility observer after each drawing, so
      // each case is drawn by a fresh observer.
      const observer = await interpreter();
      const artifact = await observer.prepare(program);
      assert.notEqual(artifact.isolationProfile.tier, 'algorithm-fast', `${label}: ${JSON.stringify(artifact.isolationProfile)}`);
      const scopeStart = observer.scopes.length;
      const drawing = await observer.draw(artifact, inputs);
      assert.deepEqual(observer.scopes.slice(scopeStart), ['begin'], `${label}: drawing scope`);
      assert.equal(parsed(drawing).observation?.recorderCompleted, true, `${label}: ${drawing.slice(0, 300)}`);
      if (program.returns) {
        assert.deepEqual(returned(drawing, program.functionName), program.returns[index], `${label}: returned value`);
      }
    }
  }
});

test('the retained comparison sees a module-state leak the classifier keeps off the fast tier', { timeout: 300_000 }, async () => {
  const program = PROGRAMS.moduleAttributeWrite;
  const inputs = program.inputs[0];

  const asClassified = await interpreter();
  const classified = await asClassified.prepare(program);
  assert.equal(classified.isolationProfile.tier, 'hard-isolated');
  assert.ok(classified.isolationProfile.reasons.includes('shared-state-write'), JSON.stringify(classified.isolationProfile));
  const first = await asClassified.drawProbed(classified, inputs);
  const second = await asClassified.drawProbed(classified, inputs);
  // The compatibility scope undoes the write. (Its restore refills module
  // containers with copies, so only the learner's module is checked here.)
  assert.deepEqual(
    [...first.changes, ...second.changes].filter((change) => change.startsWith('heapq.')),
    [],
    'the compatibility scope restores the module'
  );
  assert.equal(second.drawing, first.drawing);

  const forced = await interpreter();
  const forcedFast = await forced.prepare(program, 'algorithm-fast');
  const leaked = await forced.drawProbed(forcedFast, inputs);
  assert.deepEqual(learnerVisible(leaked.changes), ['heapq.tc_hits: added'], 'the probe names the leaked binding');
  const seen = await forced.drawProbed(forcedFast, inputs);
  assert.equal(leaked.drawing, first.drawing, 'a first drawing has nothing to leak from');
  assert.notEqual(seen.drawing, first.drawing, 'the second drawing sees the first one\'s write');
});
