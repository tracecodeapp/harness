// Page entry for tests/test-direct-entry-installed.mjs (B8 direct-entry ledger).
//
// Runs every public Judge entry point for one language against the installed
// package and returns raw evidence: Judge test-bridge events, a log of every
// command the page sent to a runtime Worker and every reply, and a compact
// projection of each returned row. The Node runner classifies and asserts.
import { Effect } from 'effect';
import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from 'tracecode-harness-under-test/judge';

const BRIDGE = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');

// A two-case function that prints its input and returns input + 1.
const PROGRAMS = {
  python: {
    functionName: 'solve',
    executionStyle: 'function',
    code: 'def solve(n):\n    print(n)\n    return n + 1\n',
  },
  javascript: {
    functionName: 'solve',
    executionStyle: 'function',
    code: 'function solve(n) {\n  console.log(n);\n  return n + 1;\n}\n',
  },
  typescript: {
    functionName: 'solve',
    executionStyle: 'function',
    code: 'function solve(n: number): number {\n  console.log(n);\n  return n + 1;\n}\n',
  },
  java: {
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: [
      'class Solution {',
      '  public int solve(int n) {',
      '    System.out.println(n);',
      '    return n + 1;',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  csharp: {
    functionName: 'Solve',
    executionStyle: 'solution-method',
    code: [
      'using System;',
      'public class Solution {',
      '  public int Solve(int n) {',
      '    Console.WriteLine(n);',
      '    return n + 1;',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  cpp: {
    functionName: 'solve',
    executionStyle: 'solution-method',
    code: [
      '#include <iostream>',
      'class Solution {',
      'public:',
      '  int solve(int n) {',
      '    std::cout << n << std::endl;',
      '    return n + 1;',
      '  }',
      '};',
      '',
    ].join('\n'),
  },
};

const LEGACY_ROW_FIELDS = ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun'];

function small(value) {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    return text.length > 4_000 ? { truncatedJson: text.slice(0, 200) } : JSON.parse(text);
  } catch {
    return { unserializable: String(value) };
  }
}

function text(value, limit = 300) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

// Field names below are the discriminators each worker client puts on its
// commands; tests/test-direct-entry-installed.mjs cites the client lines.
function summarizeSend(message) {
  const top = message && typeof message === 'object' ? message : {};
  const payload = top.payload && typeof top.payload === 'object' ? top.payload : {};
  const pick = (key) => payload[key] ?? top[key];
  return {
    type: top.type,
    id: top.id,
    protocolToken: top.protocolToken,
    mode: payload.mode,
    operation: payload.operation,
    observationOnly: payload.observationOnly === true || payload.artifact?.observationOnly === true || undefined,
    observerOnly: payload.observerOnly === true || undefined,
    preparedMode: payload.prepared?.mode,
    observation: payload.observation ? true : undefined,
    attemptToken: pick('attemptToken') !== undefined ? true : undefined,
    programId: pick('programId'),
    snapshotProgramId: payload.snapshot?.programId,
    sourceMode: top.source?.mode ?? payload.source?.mode,
    traceEnabledBatch: small(pick('traceEnabledBatch')),
    tracingEnabled: payload.tracingEnabled ?? payload.traceEnabled,
    inputs: small(pick('inputs')),
    inputBatch: small(pick('inputBatch')),
  };
}

function summarizeReply(data) {
  const top = data && typeof data === 'object' ? data : {};
  const payload = top.payload && typeof top.payload === 'object' ? top.payload : {};
  return {
    type: top.type,
    id: top.id,
    protocolToken: top.protocolToken,
    ok: typeof top.ok === 'boolean' ? top.ok : undefined,
    success: payload.success,
    programId: payload.programId,
    mode: payload.mode,
    phase: payload.phase,
    index: payload.index,
    resultCount: Array.isArray(payload.results) ? payload.results.length : undefined,
    resultsStreamed: payload.resultsStreamed,
    algorithmFastBatchUnavailable: payload.algorithmFastBatchUnavailable === true || undefined,
    error: text(payload.error) ?? text(top.error),
  };
}

function installWorkerLog(traffic) {
  const NativeWorker = window.Worker;
  let sequence = 0;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const parsed = new URL(String(url), location.href);
      const worker = ++sequence;
      traffic.push({
        worker,
        dir: 'spawn',
        path: parsed.pathname,
        query: parsed.search.slice(0, 200),
      });
      const send = this.postMessage.bind(this);
      this.postMessage = (...args) => {
        try {
          traffic.push({ worker, dir: 'send', ...summarizeSend(args[0]) });
        } catch (error) {
          traffic.push({ worker, dir: 'send', unreadable: String(error) });
        }
        return send(...args);
      };
      this.addEventListener('message', ({ data }) => {
        try {
          traffic.push({ worker, dir: 'recv', ...summarizeReply(data) });
        } catch (error) {
          traffic.push({ worker, dir: 'recv', unreadable: String(error) });
        }
      });
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        traffic.push({ worker, dir: 'terminate' });
        return terminate();
      };
    }
  };
  return () => {
    window.Worker = NativeWorker;
  };
}

function installBridge(events) {
  // Own, non-enumerable data property, as readJudgeTestBridge requires.
  Object.defineProperty(window, BRIDGE, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: {
      onEvent(event) {
        events.push({
          phase: event?.phase,
          caseId: event?.caseId,
          evaluationId: event?.evaluationId,
          generation: event?.generation,
          point: event?.point,
          keys: event && typeof event === 'object' ? Object.keys(event).sort() : [],
        });
      },
    },
  });
  return () => {
    delete window[BRIDGE];
  };
}

function projectRow(row) {
  const own = (key) => Object.hasOwn(row, key);
  return {
    caseId: row.caseId,
    status: row.status,
    hasValue: own('value'),
    value: small(row.value),
    stdout: row.stdout,
    stderr: text(row.stderr, 500),
    verdict: row.verdict?.kind,
    verdictReason: row.verdict?.reason,
    failure: row.failure
      ? { origin: row.failure.origin, reason: row.failure.reason, stage: row.failure.stage, message: text(row.failure.message) }
      : undefined,
    diagnostics: (row.diagnostics ?? []).map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: text(diagnostic.message),
    })),
    hasAttachment: own('attachment'),
    attachmentStatus: row.attachment?.status,
    attachmentReason: row.attachment?.reason,
    hasTrace: own('trace'),
    traceEvents: Array.isArray(row.trace?.events) ? row.trace.events.length : undefined,
    legacyOwn: LEGACY_ROW_FIELDS.filter(own),
  };
}

function projectEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return { missing: true };
  return {
    status: evaluation.status,
    compileStatus: evaluation.compile?.status,
    compileFailure: text(evaluation.compile?.failure?.message, 500),
    cases: (evaluation.cases ?? []).map(projectRow),
  };
}

function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function run({ language, cases, entryDeadlineMs = 240_000 }) {
  const program = PROGRAMS[language];
  if (!program) throw new Error(`No program for ${language}`);
  const traffic = [];
  const events = [];
  const restoreWorker = installWorkerLog(traffic);
  const removeBridge = installBridge(events);
  const entries = [];
  let host;

  const bundleFor = (id, trace) => createAlgorithmJudgeBundle({
    id,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    cases,
    trace,
  });

  async function entry(name, body) {
    const record = {
      name,
      from: { traffic: traffic.length, events: events.length },
      marks: [],
    };
    const mark = (label) => record.marks.push({ label, traffic: traffic.length, events: events.length });
    try {
      record.output = await withDeadline(body(mark), entryDeadlineMs, `${language}/${name}`);
    } catch (error) {
      record.error = errorText(error);
    }
    // Let late replies (lease releases, disposals) land in this window.
    await new Promise((resolve) => setTimeout(resolve, 250));
    record.to = { traffic: traffic.length, events: events.length };
    entries.push(record);
  }

  const scoped = (binding, body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const judge = yield* host.createJudge({ language, binding });
    return yield* body(judge);
  })));

  try {
    host = createBrowserJudgeHost({
      assetBaseUrl: '/staged/workers',
      providers: [language],
      ...(language === 'cpp' ? { cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 } } : {}),
    });
    const warmup = { from: traffic.length };
    try {
      warmup.result = await withDeadline(host.warmLanguage(language), entryDeadlineMs, `${language}/warmup`);
    } catch (error) {
      warmup.error = errorText(error);
    }
    warmup.to = traffic.length;

    const reference = await bundleFor(`b8-${language}-plan`, false);
    const plan = reference.plan;
    const singletonPlan = { ...plan, id: `${plan.id}-singleton`, cases: [plan.cases[0]] };
    const base = {
      sourcePath: reference.execution.sourcePath,
      functionName: program.functionName,
      executionStyle: program.executionStyle,
    };
    const traceBinding = { ...base, trace: true };
    const codeBinding = { ...base };

    // 1. Trace binding, no tracing option: every case is selected.
    await entry('evaluate-all', async () => ({
      evaluation: projectEvaluation(await scoped(traceBinding, (judge) => judge.evaluate(plan))),
    }));
    // 2. Trace binding, explicit selection.
    await entry('evaluate-selected', async () => ({
      evaluation: projectEvaluation(await scoped(traceBinding, (judge) =>
        judge.evaluate(plan, { tracing: { caseIds: ['A'] } }))),
    }));
    // 3. Trace binding, one-case plan.
    await entry('evaluate-singleton', async () => ({
      evaluation: projectEvaluation(await scoped(traceBinding, (judge) => judge.evaluate(singletonPlan))),
    }));
    // 4. Interactive execute, a continuation, then disposal.
    await entry('execute-continuation', async (mark) => scoped(traceBinding, (judge) => Effect.gen(function* () {
      const initial = yield* judge.execute({ plan, interactive: true, tracing: { caseIds: ['A'] } });
      mark('continuation');
      const continuation = yield* judge.execute({ executionId: initial.executionId, tracing: { caseIds: ['B'] } });
      mark('dispose');
      yield* judge.disposeExecution(initial.executionId);
      return {
        hasExecutionId: typeof initial.executionId === 'string',
        sameExecutionId: continuation.executionId === initial.executionId,
        evaluation: projectEvaluation(initial.evaluation),
        continuation: projectEvaluation(continuation.evaluation),
        disposed: true,
      };
    })));
    // 5. One-shot algorithm bundle with trace: true on a trace binding.
    await entry('evaluate-algorithm', async () => {
      const bundle = await bundleFor(`b8-${language}-algorithm`, true);
      const receipt = await scoped(traceBinding, (judge) => judge.evaluateAlgorithm(bundle));
      return { evaluation: projectEvaluation(receipt?.evaluation) };
    });
    // 6. Code binding: no case is selected.
    await entry('evaluate-code', async () => ({
      evaluation: projectEvaluation(await scoped(codeBinding, (judge) => judge.evaluate(plan))),
    }));
    // 7. Reference owner path.
    await entry('owner-execute', async (mark) => {
      const result = await host.execute({
        bundle: await bundleFor(`b8-${language}-owner-run`, true),
        interactive: true,
        tracing: { caseIds: ['A'] },
      });
      mark('dispose');
      if (result.executionId) await host.disposeExecution(result.executionId);
      return { hasExecutionId: typeof result.executionId === 'string', evaluation: projectEvaluation(result.evaluation) };
    });
    await entry('owner-evaluate-algorithm', async () => {
      const receipt = await host.evaluateAlgorithm({ bundle: await bundleFor(`b8-${language}-owner-submit`, false) });
      return { evaluation: projectEvaluation(receipt?.evaluation) };
    });
    return { language, warmup, entries, traffic, events };
  } finally {
    try {
      host?.dispose();
    } catch {
      // Disposal faults are not evidence for this ledger.
    }
    restoreWorker();
    removeBridge();
  }
}
