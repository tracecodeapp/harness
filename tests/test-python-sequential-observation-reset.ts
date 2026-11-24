#!/usr/bin/env npx tsx
/**
 * Sequential observation reuses the verdict's interpreter for the drawing.
 * This proves, on real Pyodide with the shipped worker runtime and native
 * recorder, that nothing learner-visible crosses between the two:
 *
 * - through the product path (BrowserJudgeHost, the Judge schedule, the
 *   Python provider and PythonWorkerClient over an in-process worker): the
 *   drawing is made by the interpreter that ran the verdict batch, after it,
 *   and it equals a fresh interpreter's drawing of the same case; the
 *   click-draw after it equals a fresh drawing too; and no loaded module's
 *   state changed across the verdict and both drawings;
 * - on one interpreter, verdict batch then drawing: the drawing, including
 *   its recorder evidence and counters, equals a fresh interpreter's;
 * - the reverse, drawing then verdict batch: the verdict rows equal a fresh
 *   interpreter's.
 *
 * The program mutates every kind of learner state the fast tier admits:
 * globals created on first use, a mutable default, a class attribute and a
 * module-level container. Each call on a fresh interpreter returns
 * [value, 1, 1, 1, value]; any carried state changes those counts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPythonPreparedExecutionProvider } from '../packages/runtime-python/src/index';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { createAlgorithmJudgeBundle } from '../src/judge';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import type { JudgeReceiptProvider } from '../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
} from '../packages/runtime-browser/src';
import {
  createInProcessWorld,
  guestGuardOptions,
  loadPythonInterpreter,
  type PythonInterpreter,
} from './fixtures/python-in-process-worker';

const CODE = [
  'def state():',
  '    global seen, calls',
  '    try:',
  '        return seen',
  '    except NameError:',
  '        seen, calls = [], [0]',
  '        return seen',
  '',
  'class Tally:',
  '    total = 0',
  '',
  'def solve(value, bag=[]):',
  '    history = state()',
  '    history.append(value)',
  '    calls[0] += 1',
  '    bag.append(value)',
  '    Tally.total += value',
  '    return [value, len(history), calls[0], len(bag), Tally.total]',
].join('\n');

const CASES = [1, 2, 3, 4].map((value) => ({
  id: `case-${value}`,
  input: { value },
  expected: [value, 1, 1, 1, value],
}));
const LIMITS = { wallClockMs: 10_000 };

// Module state as the compatibility scope sees it: every loaded module's
// bindings, and the entries of each plain container it holds.
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
                # The compatibility scope restores module containers by
                # refilling them with deep copies, which keeps their values
                # but not their entries' identity. Where a value can be
                # deep-copied, compare values; otherwise compare entries.
                if deep is None and not _tc_probe_entries_same(value, entries):
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

// A drawing's first stdlib import can add a compiled pattern to the re
// module's cache (pickle compiles one at import). The pattern is immutable
// and the importing module is dropped afterwards, so a later run computes
// the same results (see D1-PYTHON-OBSERVER-GUARD.md).
//
// Two more interpreter caches hold objects that cannot be deep-copied, so
// the probe can only compare their entries by identity: the import system's
// finder cache (sys.path_importer_cache, which both guard scopes snapshot
// and restore) and the codec registry's lookup cache (encodings._cache,
// filled by the first lookup of a codec name). Their entries are finder and
// CodecInfo objects the interpreter creates; fast-tier learner code cannot
// reach either (the classifier refuses sys beyond maxsize and private names).
const COMPILE_CACHES = new Set([
  're._cache: entries changed',
  're._cache2: entries changed',
  'sys.path_importer_cache: entries changed',
  'encodings._cache: entries changed',
]);

const WARM_UP = 'def warm(n):\n    return n + 1';

/**
 * A first prepare or drawing on an interpreter imports the tracer's and
 * guard's modules; the browser's restored runtime image has them loaded.
 * Warm both paths with an unrelated program before taking a snapshot.
 */
async function warmUp(python: PythonInterpreter): Promise<void> {
  for (const mode of ['code', 'trace'] as const) {
    const prepared = await python.runtime.prepareProgram!(python.deps, {
      mode, code: WARM_UP, functionName: 'warm', executionStyle: 'function', traceOptions: {},
      ...(mode === 'trace' ? { observationOnly: true } : {}),
    });
    assert.equal(prepared.success, true);
    if (mode === 'code') {
      await python.runtime.executePreparedProgramBatch!(
        python.deps, prepared.artifact, [{ n: 1 }], { guest: guestGuardOptions(LIMITS) },
        undefined, undefined, true, { started() {}, finished() {}, finishedCount: 0, startedCaseIndexes: [] }
      );
    } else {
      await python.runtime.executePreparedProgram!(python.deps, prepared.artifact, { n: 1 }, { guest: guestGuardOptions(LIMITS) });
    }
  }
}

function probe(python: PythonInterpreter) {
  python.pyodide.runPython(MODULE_STATE_PROBE);
  const snapshot = python.pyodide.globals.get('_tc_probe_snapshot');
  const diff = python.pyodide.globals.get('_tc_probe_diff');
  const before = snapshot();
  return () => {
    const changes = diff(before);
    try {
      return (changes.toJs() as string[]).filter((change) => !COMPILE_CACHES.has(change));
    } finally {
      changes.destroy();
      before.destroy();
    }
  };
}

function receiptHost() {
  const world = createInProcessWorld();
  const provider = createPythonPreparedExecutionProvider({
    replenishStandbyAfterUse: true,
    createWorkerClient: () => new PythonWorkerClient({
      workerUrl: 'python-worker.js',
      debug: false,
      workerFactory: () => world.factory() as never,
    }),
  });
  const runtimeHost = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([{
      id: 'python-in-process',
      languages: ['python'],
      create() {
        return {
          preparedProviders: new Map([['python', provider]] as const),
          judgeReceiptProviders: new Map([['python', {
            runtimeVersion: 'python-in-process',
            capabilities: {
              observationLease: 'separate' as const,
              observationDeadlineMs: 60_000,
              observationPrepareDeadlineMs: 60_000,
              stoppingBatchAdmission: 'worker-start' as const,
              nonStoppingBatchAdmission: 'worker-start' as const,
              observationReplyOwnership: 'transferred' as const,
            },
            prepareObservation: (program, signal, traceOptions) =>
              provider.prepareObservation(program, signal, traceOptions),
          } satisfies JudgeReceiptProvider]] as const),
          disposeLanguage() {},
          dispose() {},
        };
      },
    }]),
    providers: ['python'],
    featureOverrides: {
      worker: true,
      webAssembly: true,
      webCrypto: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    },
  });
  return { world, provider, host: createBrowserJudgeHostFromRuntimeHost(runtimeHost) };
}

type Row = { caseId: string; status: string; value?: unknown; attachment?: { status: string; trace?: { events: unknown[] } } };

function row(evaluation: { cases?: readonly unknown[] }, caseId: string): Row {
  const found = (evaluation.cases ?? []).find((entry) => (entry as Row).caseId === caseId) as Row | undefined;
  assert.ok(found, caseId);
  return found;
}

/** The value the learner's solve call returned in a drawing. */
function returned(events: readonly unknown[]): unknown {
  const exits = (events as Array<Record<string, any>>)
    .filter((event) => event.kind === 'return' && event.function === 'solve');
  return exits.at(-1)?.value;
}

/** A fresh interpreter's drawing of one case, through the same provider path. */
async function freshDrawing(input: Record<string, unknown>) {
  const world = createInProcessWorld();
  const provider = createPythonPreparedExecutionProvider({
    replenishStandbyAfterUse: false,
    createWorkerClient: () => new PythonWorkerClient({
      workerUrl: 'python-worker.js',
      debug: false,
      workerFactory: () => world.factory() as never,
    }),
  });
  try {
    const drawing = await provider.observe({
      program: { code: CODE, functionName: 'solve', executionStyle: 'function' },
      inputs: input,
      attemptToken: 'fresh',
    });
    assert.equal(drawing.status, 'drawn', JSON.stringify(drawing).slice(0, 300));
    return drawing.status === 'drawn' ? JSON.stringify(drawing.trace.events) : '';
  } finally {
    provider.terminate();
  }
}

test('the drawing is made on the verdict interpreter after the verdict, and sees none of its learner state', { timeout: 300_000 }, async () => {
  const { world, provider, host } = receiptHost();
  try {
    await provider.init();
    // Load the standby's interpreter and record its module state before
    // anything ran on it.
    const standby = world.workers[0]!;
    const python = await standby.python();
    await warmUp(python);
    const moduleChanges = probe(python);

    const bundle = await createAlgorithmJudgeBundle({
      id: 'python-sequential-reset',
      language: 'python',
      code: CODE,
      functionName: 'solve',
      executionStyle: 'function',
      trace: true,
      limits: LIMITS,
      cases: CASES,
    });
    const run = await host.execute({ bundle, interactive: true, tracing: { caseIds: ['case-2'] } });
    assert.equal(run.evaluation.status, 'completed');
    for (const testCase of CASES) {
      const judged = row(run.evaluation, testCase.id);
      assert.equal(judged.status, 'completed', JSON.stringify(judged).slice(0, 400));
      assert.deepEqual(judged.value, testCase.expected, `${testCase.id}: fresh state in every verdict case`);
    }

    // The product path: one interpreter ran the verdict batch, then drew.
    const work = world.commands.filter((command) =>
      command.type === 'prepare-program' || command.type.startsWith('execute-'));
    assert.deepEqual(
      work.map(({ worker, type, observationOnly }) => ({ worker, type, observationOnly })),
      [
        { worker: 0, type: 'prepare-program', observationOnly: undefined },
        { worker: 0, type: 'execute-prepared-program-batch', observationOnly: undefined },
        { worker: 0, type: 'prepare-program', observationOnly: true },
        { worker: 0, type: 'execute-prepared-program', observationOnly: true },
      ],
      JSON.stringify(world.commands)
    );

    // Verdict → observer: the verdict batch's learner state is invisible.
    const drawn = row(run.evaluation, 'case-2').attachment;
    assert.equal(drawn?.status, 'drawn');
    const events = drawn!.trace!.events;
    assert.deepEqual(returned(events), [2, 1, 1, 1, 2]);
    assert.equal(JSON.stringify(events), await freshDrawing({ value: 2 }), 'the drawing equals a fresh interpreter\'s');

    // Observer → observer: the click-draw on the same interpreter sees
    // nothing of the first drawing.
    const click = await host.execute({ executionId: run.executionId!, tracing: { caseIds: ['case-3'] } });
    const clicked = row(click.evaluation, 'case-3').attachment;
    assert.equal(clicked?.status, 'drawn');
    assert.deepEqual(returned(clicked!.trace!.events), [3, 1, 1, 1, 3]);
    assert.equal(JSON.stringify(clicked!.trace!.events), await freshDrawing({ value: 3 }));
    assert.deepEqual(
      world.commands.filter((command) => command.type.startsWith('execute-')).map(({ worker }) => worker),
      [0, 0, 0],
      'the click-draw ran on the same interpreter'
    );

    // Module state the guard covers: unchanged across the verdict batch and
    // both drawings.
    assert.deepEqual(moduleChanges(), []);
    await host.disposeExecution(run.executionId!);
  } finally {
    host.dispose();
    provider.terminate();
  }
});

async function prepare(python: PythonInterpreter, mode: 'code' | 'trace') {
  const prepared = await python.runtime.prepareProgram!(python.deps, {
    mode,
    code: CODE,
    functionName: 'solve',
    executionStyle: 'function',
    traceOptions: {},
    ...(mode === 'trace' ? { observationOnly: true } : {}),
  });
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 400));
  assert.equal(prepared.artifact.isolationProfile.tier, 'algorithm-fast', JSON.stringify(prepared.artifact.isolationProfile));
  return prepared.artifact;
}

async function verdictBatch(python: PythonInterpreter) {
  const artifact = await prepare(python, 'code');
  const result = await python.runtime.executePreparedProgramBatch!(
    python.deps,
    artifact,
    CASES.map((testCase) => testCase.input),
    { guest: guestGuardOptions(LIMITS) },
    undefined,
    undefined,
    true,
    { started() {}, finished() {}, finishedCount: 0, startedCaseIndexes: [] }
  );
  assert.equal(result.timings?.algorithmFastBatch, true, JSON.stringify(result).slice(0, 400));
  return (structuredClone(result.results) as Array<Record<string, unknown>>).map(({ success, output, error }) => ({ success, output, error }));
}

async function rawDrawing(python: PythonInterpreter, input: Record<string, unknown>) {
  const artifact = await prepare(python, 'trace');
  const result = await python.runtime.executePreparedProgram!(
    python.deps, artifact, input, { guest: guestGuardOptions({ wallClockMs: 10_000 }) }
  );
  // Everything the worker returns except its clocks.
  const { executionTimeMs: _clock, timings: _timings, ...drawing } = result;
  assert.equal(drawing.observation?.recorderCompleted, true, JSON.stringify(drawing).slice(0, 300));
  return JSON.stringify(drawing);
}

test('one interpreter: verdict batch then drawing equals a fresh drawing, recorder evidence included', { timeout: 300_000 }, async () => {
  const reused = await loadPythonInterpreter();
  await warmUp(reused);
  const before = probe(reused);
  const rows = await verdictBatch(reused);
  assert.deepEqual(rows, CASES.map((testCase) => ({ success: true, output: testCase.expected, error: undefined })));
  const afterVerdict = await rawDrawing(reused, { value: 2 });
  assert.deepEqual(before(), []);
  const fresh = await rawDrawing(await loadPythonInterpreter(), { value: 2 });
  assert.equal(afterVerdict, fresh);
});

test('the reverse: drawing then verdict batch on one interpreter gives fresh verdict rows', { timeout: 300_000 }, async () => {
  const reused = await loadPythonInterpreter();
  await rawDrawing(reused, { value: 4 });
  await rawDrawing(reused, { value: 4 });
  assert.deepEqual(
    await verdictBatch(reused),
    CASES.map((testCase) => ({ success: true, output: testCase.expected, error: undefined }))
  );
});
