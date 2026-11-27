#!/usr/bin/env npx tsx

// The C++ worker copies the call stack onto a drawing's events one kept event
// at a time, under a byte budget, so a runaway recursion's drawing costs at
// most the budget plus one stack. These tests count the frames that copying
// makes, and check every finalizer against the 0.21.0 algorithm on drawings
// the budget does not cut.

import { classifyCppExceptionUse } from '../workers/cpp/cpp-exceptions.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sharedKernelPolicySource = (await readFile('workers/shared/runtime-kernel-policy.js', 'utf8'))
  .replace(/\bexport\s+/g, '');
const workerSource = (await readFile('workers/cpp/cpp-worker.js', 'utf8')).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
  ''
).replace(/^import \{ classifyCppExceptionUse \} from '\.\/cpp-exceptions\.js';\s*/m, '');
const sandbox: Record<string, unknown> = {
  classifyCppExceptionUse,
  console,
  TextEncoder,
  TextDecoder,
  URL,
  WebAssembly,
  Date,
  performance,
  Uint8Array,
  BigInt,
  Map,
  Set,
  Error,
  JSON,
  Object,
  String,
  Number,
  Math,
  RegExp,
  Promise,
  postMessage() {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(
  `${sharedKernelPolicySource}
const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;
const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;
const isRuntimeProcPath = isRuntimeKernelProcPath;
${workerSource}`,
  context,
  { filename: 'cpp-worker.js' }
);

// The 0.21.0 finalizers, verbatim apart from their names: the oracle for
// every drawing the budget leaves whole. They call the worker's own
// unchanged per-event helpers.
vm.runInContext(String.raw`
function reference0210Enrich(events) {
  const stack = [];
  return events.map((event) => {
    if (event?.kind === 'call') {
      const frame = {
        function: event.function || '<module>',
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(typeof event.line === 'number' ? { line: event.line } : {}),
      };
      stack.push(frame);
      return { ...event, callStack: stack.map((f) => ({ ...f })) };
    }
    if (event?.kind === 'return') {
      const withStack = stack.length > 0 ? { ...event, callStack: stack.map((f) => ({ ...f })) } : { ...event };
      popCppCallStackFrame(stack, event.function);
      return withStack;
    }
    return stack.length > 0 ? { ...event, callStack: stack.map((f) => ({ ...f })) } : { ...event };
  });
}
function reference0210Finalize(events, options = {}) {
  const runId = options.runId || 'cpp:run';
  const file = options.file || CPP_USER_SOURCE_FILE;
  const maxPathDepth = normalizeMaxPathDepth(options.maxPathDepth);
  const statementSourceMap = typeof options.sourceCode === 'string'
    ? buildRuntimeStatementSourceMap(options.sourceCode)
    : new Map();
  const userFunctionNames = buildCppUserFunctionNameSet(options.sourceCode);
  const maxEvents = Number.isFinite(options.maxStoredEvents)
    ? Number(options.maxStoredEvents)
    : Number.isFinite(options.maxTraceSteps)
      ? Number(options.maxTraceSteps)
      : DEFAULT_MAX_STORED_EVENTS;
  const normalizedEvents = reference0210Enrich(events).flatMap((event) => {
    const activeFunction = Array.isArray(event.callStack) ? event.callStack[event.callStack.length - 1]?.function : undefined;
    const normalized = stripCppSyntheticHelperFrames({
      ...event,
      ...(event.kind === 'line' && !event.function && activeFunction ? { function: activeFunction } : {}),
      runId,
      file,
    }, userFunctionNames);
    if (isDroppableCppSyntheticHelperEvent(normalized, userFunctionNames)) return [];
    return [normalizeRuntimeTraceEventTargetDepth({
      ...normalized,
      ...cppRuntimeTraceSourceOwnership(normalized, statementSourceMap),
    }, maxPathDepth)];
  });
  const traceLimitExceeded = maxEvents !== undefined && normalizedEvents.length > maxEvents;
  let storedEvents = traceLimitExceeded ? normalizedEvents.slice(0, Math.max(0, maxEvents)) : normalizedEvents;
  if (
    traceLimitExceeded &&
    normalizedEvents.some((event) => event.kind === 'timeout') &&
    !storedEvents.some((event) => event.kind === 'timeout')
  ) {
    const timeoutEvent = normalizedEvents.find((event) => event.kind === 'timeout');
    storedEvents =
      maxEvents && maxEvents > 1 && timeoutEvent
        ? [...normalizedEvents.slice(0, maxEvents - 1), timeoutEvent]
        : timeoutEvent
          ? [timeoutEvent]
          : storedEvents;
  }
  return {
    trace: {
      schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
      language: 'cpp',
      runId,
      events: storedEvents,
      lineEventCount: storedEvents.filter((event) => event.kind === 'line').length,
      traceStepCount: storedEvents.length,
    },
    traceLimitExceeded,
    droppedEventCount: traceLimitExceeded ? Math.max(0, normalizedEvents.length - storedEvents.length) : 0,
  };
}
function reference0210Observation(parsed, prepared, attemptToken, recorderEnabled = true) {
  const status = parsed.traceStatus;
  const events = (prepared.inputMode === 'named-batch'
    ? splitCppBatchTraceEvents(parsed.events, 1)[0] ?? []
    : parsed.events).filter((event) => event.kind !== 'timeout');
  const opts = prepared.traceOptions;
  const { trace } = reference0210Finalize(events, {
    sourceCode: prepared.source,
    maxPathDepth: opts.maxPathDepth,
    maxStoredEvents: Number.MAX_SAFE_INTEGER,
  });
  const dropped = Number.isSafeInteger(status?.droppedEventCount) && status.droppedEventCount > 0
    ? status.droppedEventCount
    : 0;
  const attemptedEvents = events.length + dropped;
  let cut;
  let length = 0;
  let bytes = 0;
  const encoder = Number.isFinite(opts.maxTraceBytes) ? new TextEncoder() : undefined;
  for (const event of trace.events) {
    if (length >= opts.maxTraceSteps) { cut = 'step-budget'; break; }
    if (length >= opts.maxStoredEvents) { cut = 'stored-event-budget'; break; }
    if (encoder) {
      bytes += encoder.encode(JSON.stringify(event)).byteLength;
      if (bytes > opts.maxTraceBytes) { cut = 'byte-budget'; break; }
    }
    length++;
  }
  if (!cut && status?.traceLimitExceeded) {
    cut = {
      'line-limit': 'line-budget',
      'single-line-limit': 'single-line-budget',
      'trace-limit': 'stored-event-budget',
    }[status.timeoutReason];
  }
  const retained = trace.events.slice(0, length);
  return {
    trace: {
      ...trace,
      events: retained,
      lineEventCount: retained.filter(({ kind }) => kind === 'line').length,
      traceStepCount: retained.length,
    },
    observation: {
      attemptToken,
      recorderEnabled,
      recorderCompleted: recorderEnabled && parsed.foundResult && typeof status?.traceLimitExceeded === 'boolean',
      attemptedEvents,
      ...(cut && { cut }),
    },
  };
}
// Count every frame the worker's stack copier makes.
globalThis.__copiedFrames = 0;
const __cloneCppCallStack = cloneCppCallStack;
cloneCppCallStack = (stack) => {
  globalThis.__copiedFrames += stack.length;
  return __cloneCppCallStack(stack);
};
globalThis.__api = {
  finalizeRuntimeTrace,
  finalizePreparedObservation,
  reference0210Finalize,
  reference0210Observation,
  defaults: {
    maxBytes: typeof CPP_DEFAULT_TRACE_MAX_BYTES === 'number' ? CPP_DEFAULT_TRACE_MAX_BYTES : 32 * 1024 * 1024,
    maxEventBytes: typeof CPP_DEFAULT_TRACE_MAX_EVENT_BYTES === 'number' ? CPP_DEFAULT_TRACE_MAX_EVENT_BYTES : 256 * 1024,
  },
};
`, context);

type TraceEvent = Record<string, unknown> & { kind?: string; callStack?: unknown[] };
type Finalized = { trace: { events: TraceEvent[] }; traceLimitExceeded: boolean; droppedEventCount: number };
type Observed = {
  trace: { events: TraceEvent[] };
  observation: { cut?: string; attemptedEvents: number; recorderCompleted: unknown };
};
const api = sandbox.__api as {
  finalizeRuntimeTrace(events: TraceEvent[], options?: Record<string, unknown>): Finalized;
  finalizePreparedObservation(
    parsed: Record<string, unknown>, prepared: Record<string, unknown>, attemptToken: string,
    recorderEnabled?: boolean, programSucceeded?: boolean
  ): Observed;
  reference0210Finalize(events: TraceEvent[], options?: Record<string, unknown>): Finalized;
  reference0210Observation(
    parsed: Record<string, unknown>, prepared: Record<string, unknown>, attemptToken: string, recorderEnabled?: boolean
  ): Observed;
  defaults: { maxBytes: number; maxEventBytes: number };
};
const copiedFrames = () => sandbox.__copiedFrames as number;
const resetCopiedFrames = () => { sandbox.__copiedFrames = 0; };
const utf8 = new TextEncoder();
const eventBytes = (event: unknown) => utf8.encode(JSON.stringify(event)).byteLength;
const traceBytes = (events: unknown[]) => events.reduce<number>((sum, event) => sum + eventBytes(event), 0);
const maxDepth = (events: unknown[]) => events.reduce<number>((max, event) => {
  const stack = (event as TraceEvent).callStack;
  return Math.max(max, Array.isArray(stack) ? stack.length : 0);
}, 0);

const leanSource = 'class Solution {\npublic:\n  int f(int x) {\n    return f(x + 1);\n  }\n};\n';
// The raw stream a runaway `return f(x + 1);` leaves: a call and a line per
// level, never a return, until the recorder stops storing events.
function runawayEvents(levels: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let level = 0; level < levels; level += 1) {
    events.push({ kind: 'call', function: 'f', line: 3, args: { x: 2 + level } });
    events.push({ kind: 'line', function: 'f', line: 4 });
  }
  return events;
}
// The backtracking limits the app sets (lib/utils.ts heavyRecursion branch).
const backtracking = { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000, maxStoredEvents: 16000 };
const observationParsed = (events: TraceEvent[], status: Record<string, unknown>) => ({ foundResult: true, traceStatus: status, events });
const prepared = (traceOptions: Record<string, unknown>) => ({ inputMode: 'single', source: leanSource, traceOptions });

// Each section reports on its own, so a red run names every failing property.
const failures: string[] = [];
function section(name: string, run: () => string | void) {
  try {
    const detail = run();
    console.log(`PASS: ${name}${detail ? ` ${detail}` : ''}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 1. A drawing the observation adapter will refuse copies no frame at all.
section('a refused C++ drawing copies no call-stack frame', () => {
  const events = runawayEvents(8000);
  const status = { traceLimitExceeded: true, timeoutReason: 'trace-limit', droppedEventCount: 0 };
  for (const [label, succeeded, recorderEnabled, parsed] of [
    ['a failed program', false, true, observationParsed(events, status)],
    ['a disabled recorder', true, false, observationParsed(events, status)],
    ['a recorder without a final status', true, true, { foundResult: true, events }],
    ['a program without a result', true, true, { foundResult: false, traceStatus: status, events }],
  ] as const) {
    resetCopiedFrames();
    const doomed = api.finalizePreparedObservation(parsed, prepared(backtracking), 'doomed', recorderEnabled, succeeded);
    assertCondition(copiedFrames() === 0, `${label}: a refused drawing copied ${copiedFrames()} frames`);
    assertCondition(doomed.trace.events.length === 0, `${label}: a refused drawing retained events`);
    assertCondition(doomed.observation.attemptedEvents === events.length,
      `${label}: the attempt count must still describe the recorder's events`);
  }
});

// 2. The lean recursion under the backtracking limits, as if it completed:
// the copy stops at the byte budget, and copies at most one stack past it.
section('the lean recursion copies at most (retained + 1) x depth frames under the byte budget', () => {
for (const levels of [2000, 8000]) {
  const events = runawayEvents(levels);
  for (const traceOptions of [backtracking, { ...backtracking, maxTraceBytes: 1024 * 1024 }]) {
    resetCopiedFrames();
    const result = api.finalizePreparedObservation(
      observationParsed(events, { traceLimitExceeded: true, timeoutReason: 'single-line-limit', droppedEventCount: 0 }),
      prepared(traceOptions), 'lean', true, true
    );
    const budget = (traceOptions as { maxTraceBytes?: number }).maxTraceBytes ?? api.defaults.maxBytes;
    const retained = result.trace.events;
    const bytes = traceBytes(retained);
    assertCondition(result.observation.cut === 'byte-budget',
      `depth ${levels}: the lean recursion's drawing must be cut by bytes, got ${result.observation.cut}`);
    assertCondition(retained.length > 0 && retained.some((event) => event.kind === 'line'),
      `depth ${levels}: the cut must leave a usable prefix`);
    assertCondition(bytes <= budget, `depth ${levels}: ${bytes} retained bytes exceed the ${budget}-byte budget`);
    const depth = Math.min(levels, retained.length + 1);
    assertCondition(copiedFrames() <= (retained.length + 1) * depth,
      `depth ${levels}: ${copiedFrames()} frames copied for ${retained.length} retained events at depth ${depth}`);
    assertCondition(result.observation.attemptedEvents > retained.length, `depth ${levels}: attempted events must exceed the prefix`);
  }
}
});

// 3. The same bound on every other recording path, which reports the cut
// through traceLimitExceeded and droppedEventCount. Its timeout marker still
// replaces the last event, within the budget.
section('batch and one-shot finalizers stop copying at the byte budget', () => {
for (const [levels, withTimeout] of [[8000, false], [2000, true], [8000, true]] as const) {
  const events = runawayEvents(levels);
  if (withTimeout) events.push({ kind: 'timeout', line: 4, reason: 'trace-limit', message: 'Trace limit exceeded.' });
  // A marker carrying a stack deeper than the per-event cap allows is left
  // out like any other oversized event.
  const markerFits = withTimeout && levels === 2000;
  resetCopiedFrames();
  const result = api.finalizeRuntimeTrace(events, { ...backtracking, maxStoredEvents: 50_000, sourceCode: leanSource });
  const retained = result.trace.events;
  assertCondition(result.traceLimitExceeded === true, 'a byte cut must report traceLimitExceeded');
  assertCondition(result.droppedEventCount === events.length - retained.length, 'a byte cut must count the events it left out');
  assertCondition(traceBytes(retained) <= api.defaults.maxBytes, 'a byte cut must keep the drawing within the budget');
  assertCondition((retained[retained.length - 1]?.kind === 'timeout') === markerFits,
    `depth ${levels}: a cut drawing keeps its timeout marker only when the marker fits the per-event cap`);
  assertCondition(retained.every((event) => eventBytes(event) <= api.defaults.maxEventBytes), 'every retained event fits the per-event cap');
  const depth = maxDepth(retained) + 1;
  // The timeout marker is the one copy past (retained + 1).
  assertCondition(copiedFrames() <= (retained.length + (withTimeout ? 2 : 1)) * depth,
    `batch/one-shot: ${copiedFrames()} frames copied for ${retained.length} retained events`);
}
});

// 4. The per-event cap cuts at one oversized event, with the byte-budget reason.
section('the per-event cap cuts at one oversized event', () => {
  const wide = 'v'.repeat(api.defaults.maxEventBytes);
  const events: TraceEvent[] = [
    { kind: 'call', function: 'f', line: 3, args: { x: 1 } },
    { kind: 'line', function: 'f', line: 4 },
    { kind: 'line', function: 'f', line: 4, target: { name: 'wide', value: wide } },
    { kind: 'line', function: 'f', line: 4 },
  ];
  const observed = api.finalizePreparedObservation(
    observationParsed(events, { traceLimitExceeded: false, droppedEventCount: 0 }),
    prepared({ ...backtracking, maxTraceBytes: 64 * 1024 * 1024 }), 'wide', true, true
  );
  assertCondition(observed.observation.cut === 'byte-budget' && observed.trace.events.length === 2,
    `the per-event cap must cut at the oversized event, got ${observed.observation.cut} after ${observed.trace.events.length}`);
  const finalized = api.finalizeRuntimeTrace(events, { sourceCode: leanSource, maxTraceBytes: 64 * 1024 * 1024 });
  assertCondition(finalized.traceLimitExceeded && finalized.trace.events.length === 2 && finalized.droppedEventCount === 2,
    'the per-event cap must stop a verdict path at the oversized event');
  // The cap never exceeds the budget itself.
  const small = api.finalizePreparedObservation(
    observationParsed(events.slice(0, 2), { traceLimitExceeded: false, droppedEventCount: 0 }),
    prepared({ ...backtracking, maxTraceBytes: 10 }), 'small', true, true
  );
  assertCondition(small.observation.cut === 'byte-budget' && small.trace.events.length === 0, 'a budget smaller than one event cuts at once');
});

// 5. Cut precedence: step, then stored events, then bytes.
section('cut precedence is step, stored-event, byte', () => {
  const events = runawayEvents(50);
  const cutOf = (traceOptions: Record<string, unknown>) => api.finalizePreparedObservation(
    observationParsed(events, { traceLimitExceeded: false, droppedEventCount: 0 }), prepared(traceOptions), 'order', true, true
  ).observation.cut;
  const whole = api.finalizePreparedObservation(
    observationParsed(events, { traceLimitExceeded: false, droppedEventCount: 0 }), prepared({}), 'whole', true, true
  ).trace.events;
  const tenEventBytes = traceBytes(whole.slice(0, 10));
  assertCondition(cutOf({ maxTraceSteps: 10, maxStoredEvents: 10, maxTraceBytes: 1e9 }) === 'step-budget', 'step cuts first');
  assertCondition(cutOf({ maxTraceSteps: 11, maxStoredEvents: 10, maxTraceBytes: 1e9 }) === 'stored-event-budget', 'stored events cut second');
  assertCondition(cutOf({ maxTraceSteps: 10, maxStoredEvents: 10, maxTraceBytes: tenEventBytes }) === 'step-budget',
    'a count cap cuts before bytes at the same event');
  assertCondition(cutOf({ maxTraceSteps: 11, maxStoredEvents: 11, maxTraceBytes: tenEventBytes }) === 'byte-budget',
    'bytes cut the event a count cap would still allow');
  assertCondition(cutOf({ maxTraceSteps: 10, maxStoredEvents: 10, maxTraceBytes: traceBytes(whole.slice(0, 5)) }) === 'byte-budget',
    'bytes cut before a later count cap');
});

// 6. Every drawing the budget leaves whole is byte-identical to 0.21.0's,
// on the observation path and on the batch/one-shot path.
section('drawings the budget leaves whole match 0.21.0 on every finalizer', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const source = [
    'int f(int x) {',
    '  return g(x) +',
    '    1;',
    '}',
    'int tracecodeUserHelper(int y) { return y; }',
    'int g(int x) { return tracecodeUserHelper(x); }',
  ].join('\n');
  const functions = ['f', 'g', 'tracecodeUserHelper', 'tracecodeInternal', '__tracecode_batch_case', undefined] as const;
  function stream(length: number): TraceEvent[] {
    const events: TraceEvent[] = [];
    for (let index = 0; index < length; index += 1) {
      const kind = pick(['call', 'call', 'line', 'line', 'line', 'return', 'return', 'stdout', 'exception', 'timeout'] as const);
      const fn = pick(functions);
      const event: TraceEvent = { kind };
      if (fn !== undefined && (kind !== 'line' || random() < 0.5)) event.function = fn;
      if (random() < 0.9) event.line = 1 + Math.floor(random() * 7);
      if (kind === 'call' && random() < 0.8) event.args = { x: Math.floor(random() * 100), label: pick(['a', 'é', '漢', '😀']) };
      if (kind === 'line' && random() < 0.3) {
        event.target = { name: 'grid', path: Array.from({ length: Math.floor(random() * 6) }, (_, i) => i), indexSources: ['i'] };
      }
      if (kind === 'timeout') event.reason = pick(['trace-limit', 'line-limit']);
      if (kind === 'stdout') event.text = pick(['ok\n', 'ünïcode\n']);
      if (random() < 0.05) event.callStack = [{ function: 'g' }];
      events.push(event);
    }
    return events;
  }
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const covered = { countCuts: 0, timeoutSubstitutions: 0, observationCuts: 0, drawnObservations: 0 };
  for (let trial = 0; trial < 400; trial += 1) {
    const events = stream(1 + Math.floor(random() * 120));
    const options = {
      sourceCode: random() < 0.8 ? source : undefined,
      ...(random() < 0.5 ? { maxPathDepth: 1 + Math.floor(random() * 4) } : {}),
      ...(random() < 0.4 ? { maxStoredEvents: Math.floor(random() * 80) } : {}),
      ...(random() < 0.3 ? { maxTraceSteps: Math.floor(random() * 80) } : {}),
      ...(random() < 0.1 ? { maxStoredEvents: 2.5 } : {}),
    };
    const referenceFinalized = api.reference0210Finalize(events, options);
    assertCondition(same(api.finalizeRuntimeTrace(events, options), referenceFinalized),
      `trial ${trial}: the batch/one-shot drawing differs from 0.21.0 (${JSON.stringify(options)})`);
    if (referenceFinalized.traceLimitExceeded) {
      covered.countCuts += 1;
      const stored = referenceFinalized.trace.events;
      if (stored[stored.length - 1]?.kind === 'timeout') covered.timeoutSubstitutions += 1;
    }
    const traceOptions = {
      ...(random() < 0.5 ? { maxPathDepth: 1 + Math.floor(random() * 4) } : {}),
      ...(random() < 0.5 ? { maxTraceSteps: Math.floor(random() * 120) } : {}),
      ...(random() < 0.5 ? { maxStoredEvents: Math.floor(random() * 120) } : {}),
    };
    const inputMode = random() < 0.3 ? 'named-batch' : 'single';
    const observedEvents = inputMode === 'named-batch'
      ? [{ kind: 'call', function: '__tracecode_batch_case', line: 1, args: { index: 0 } }, ...events]
      : events;
    const status = random() < 0.5
      ? { traceLimitExceeded: random() < 0.5, timeoutReason: pick(['line-limit', 'single-line-limit', 'trace-limit']), droppedEventCount: Math.floor(random() * 4) }
      : undefined;
    const parsed = { foundResult: true, ...(status ? { traceStatus: status } : {}), events: observedEvents };
    const preparedProgram = { inputMode, source: options.sourceCode, traceOptions };
    const current = api.finalizePreparedObservation(parsed, preparedProgram, 'same', true, true);
    const reference = api.reference0210Observation(parsed, preparedProgram, 'same', true);
    // 0.21.0 built every drawing; only a completed recorder's drawing is
    // ever shown, so the oracle covers those.
    if (reference.observation.recorderCompleted) {
      assertCondition(same(current, reference), `trial ${trial}: the observation drawing differs from 0.21.0`);
      covered.drawnObservations += 1;
      if (reference.observation.cut) covered.observationCuts += 1;
    } else {
      // A refused drawing's cut is never read; the rest of its evidence is.
      const { cut: _currentCut, ...currentEvidence } = current.observation;
      const { cut: _referenceCut, ...referenceEvidence } = reference.observation;
      assertCondition(same(currentEvidence, referenceEvidence), `trial ${trial}: the observation evidence differs from 0.21.0`);
    }
  }
  assertCondition(covered.countCuts >= 40 && covered.timeoutSubstitutions >= 10 &&
    covered.drawnObservations >= 40 && covered.observationCuts >= 20,
  `the comparison must cover cut drawings: ${JSON.stringify(covered)}`);
  return JSON.stringify(covered);
});

if (failures.length > 0) {
  console.log(`${failures.length} C++ trace memory section(s) failed.`);
  process.exit(1);
}
