import { matchesWorkerReply, replyRowCount } from 'stage1-worker-evidence';
import { observeDeferred } from 'stage1-deferred-browser';
import {
  builtInProjectEvaluators,
  createAlgorithmJudgeBundle,
  createAlgorithmJudgeReceipt,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '@tracecode/harness/judge';
import { getLanguageRuntimeProfile } from '@tracecode/harness/tracekernel';
export { resolveBuiltInTraceCCRuntimeManifest } from '@tracecode/harness/tracekernel';
export { builtInProjectEvaluators, createAlgorithmJudgeBundle, createBrowserJudgeHost };

export function supportedTraceOptions(language, options) {
  if (!options) return undefined;
  const controls = getLanguageRuntimeProfile(language).capabilities.tracing.controls;
  return Object.fromEntries(Object.entries(options).filter(([key]) => controls[key]));
}

let transcript = [];
const journal = [];

export function installJudgeJournal(targetLanguage, maxBytes) {
  Object.defineProperty(globalThis, Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1'), {
    configurable: true,
    value: {
      onEvent(event) {
        journal.push({ ...event, sequence: journal.length });
      },
      ...(maxBytes === undefined ? {} : {
        judgedOutputPolicy: ({ language }) => language === targetLanguage ? { maxBytes } : undefined,
      }),
    },
  });
}

export function judgeJournal() {
  return journal;
}
let nextGeneration = 0;
let seed;
let seedHits;
const NativeWorker = globalThis.Worker;
class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    const generation = ++nextGeneration;
    const worker = String(url);
    const pathname = new URL(url, location.href).pathname;
    const pythonWorker = pathname.endsWith('/python-worker.js');
    const javaWorker = /\/java(?:-runtime)?-worker\.js$/.test(pathname);
    const cppWorker = pathname.endsWith('/cpp-worker.js');
    const csharpWorker = pathname.endsWith('/csharp-worker.js');
    const pending = new Map();
    const programs = new Map();
    this.addEventListener('message', (event) => {
      const data = event.data;
      const command = pending.get(data?.id);
      if (command) {
        if (pythonWorker && command.protocolToken !== undefined && !matchesWorkerReply(event, command)) return;
        if (command.cppProtocolToken || command.csharpProtocol) {
          if (command.csharpProtocol ? !matchesWorkerReply(event, command)
            : !event.isTrusted || data.protocolToken !== command.cppProtocolToken) return;
          if (data.type === 'runtime-progress' && data.payload?.stage === 'ordinary-case-started') {
            transcript.push({ action: 'ordinary-start', worker, generation, id: data.id, caseIndex: data.payload.detail?.caseIndex });
            return;
          }
          // A progress event is not a terminal worker acknowledgement.
          if (data.type !== command.type && data.type !== 'error') return;
        }
        if (data.type !== 'batch-case-progress') pending.delete(data.id);
        const rows = command.inputs;
        const mutate = (row, input, traced) => {
          if (row?.success !== true || !input) return;
          if ((seed === 'stdout-b' && input.n === 11 && !traced) || seed === 'stdout-all') {
            if (typeof row.output !== 'number') return;
            const before = row.output;
            row.output += 1;
            seedHits.push({ generation, before, after: row.output, input });
          }
          if (seed === 'list-field' && row.output?.__type__ === 'ListNode') {
            row.output.value = 1;
            seedHits.push({ generation, input, field: 'value' });
          }
        };
        if (seed && pythonWorker && rows) {
          if (data.type === 'batch-case-progress' && data.payload?.phase === 'finished') {
            const index = data.payload.index;
            mutate(data.payload.result, rows[index], command.trace?.[index]);
          } else if (data.type === 'execute-result') {
            if (Array.isArray(data.payload?.results)) {
              data.payload.results.forEach((row, index) => mutate(row, rows[index], command.trace?.[index]));
            } else if (!Array.isArray(rows)) mutate(data.payload, rows, command.trace);
          }
        }
        transcript.push({
          action: 'response', worker, generation, id: data.id, type: data.type,
          success: data.payload?.success ?? data.ok,
          mode: data.payload?.mode ?? data.payload?.artifact?.mode ?? data.payload?.snapshot?.mode ?? command.mode,
          tier: data.payload?.isolationProfile?.tier ?? data.payload?.artifact?.isolationProfile?.tier ??
            data.payload?.algorithmIsolationProfile?.tier ?? data.payload?.preparedRunnerTier,
          tierReason: data.payload?.artifact?.isolationProfile?.reasons ??
            data.payload?.algorithmIsolationProfile?.reasons ?? data.payload?.preparedRunnerReason,
          rows: replyRowCount(event, command), phase: data.payload?.phase,
          index: data.payload?.index,
          ...(command.cppProtocolToken ? {
            cppTerminal: true,
            recorder: data.payload?.observation?.attemptToken === command.attemptToken ? data.payload?.observation : undefined,
          } : {}),
          ...(command.csharpProtocol ? {
            csharpTerminal: true,
            startedCaseIndexes: data.payload?.startedCaseIndexes,
            recorderToken: data.payload?.observation?.attemptToken,
          } : {}),
        });
      }
    });
    this.addEventListener('error', (event) => {
      transcript.push({ action: 'error', worker, generation, message: event.message });
    });
    const post = this.postMessage.bind(this);
    this.postMessage = (data, options) => {
      const payload = data?.payload ?? data;
      const prepared = payload?.prepared ?? payload?.artifact;
      if (data?.type === 'prepare' && payload?.programId) programs.set(payload.programId, payload.source);
      const program = programs.get(payload?.programId);
      function copySecondEdge(input) {
        if (!input?.root?.right?.__ref__) return;
        input.root.right = { val: input.root.left.val, left: structuredClone(input.root.left.left), right: null };
        seedHits.push({ generation, input });
      }
      if (seed === 'split-second-edge' && javaWorker && /^execute-prepared-runtime-program(?:-batch)?$/.test(data?.type)) {
        if (payload?.inputBatch) {
          data = { ...data, payload: { ...payload, inputBatch: structuredClone(payload.inputBatch) } };
          data.payload.inputBatch.forEach(copySecondEdge);
        } else if (payload?.inputs) {
          data = { ...data, payload: { ...payload, inputs: structuredClone(payload.inputs) } };
          copySecondEdge(data.payload.inputs);
        }
      }
      const command = {
        action: 'command', worker, generation, id: data?.id, type: data?.type,
        role: payload?.runtimeRole, mode: payload?.mode ?? prepared?.mode ?? program?.mode,
        tier: payload?.isolationProfile?.tier ?? prepared?.isolationProfile?.tier ??
          payload?.preparedRunnerTier ?? prepared?.preparedRunnerTier,
        functionName: payload?.functionName ?? prepared?.functionName ?? program?.functionName,
        inputs: payload?.inputBatch ?? payload?.inputs,
        trace: payload?.traceEnabledBatch ?? payload?.tracingEnabled ?? payload?.trace ?? payload?.traceFlags,
        forceJudgeCompatible: payload?.forceJudgeCompatible,
      };
      const cppProtocol = cppWorker && typeof data?.protocolToken === 'string' &&
        (payload.reportCaseProgress === true || typeof payload.attemptToken === 'string');
      if (cppProtocol) {
        command.cppProtocol = true;
        command.reportsStarts = payload.reportCaseProgress === true;
        command.attemptToken = payload.attemptToken;
      }
      const csharpProtocol = csharpWorker && (payload.reportCaseProgress === true || payload.observation !== undefined);
      if (csharpProtocol) {
        command.csharpProtocol = true;
        command.reportsStarts = payload.reportCaseProgress === true;
        command.attemptToken = payload.observation?.attemptToken;
      }
      if (command.id) pending.set(command.id, {
        ...command,
        ...(cppProtocol ? { cppProtocolToken: data.protocolToken } : {}),
        ...(pythonWorker || csharpProtocol ? { protocolToken: data.protocolToken } : {}),
      });
      transcript.push(command);
      post(data, options);
    };
  }
}
globalThis.Worker = ObservedWorker;

function errorInfo(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    cause: error?.cause ? String(error.cause) : undefined,
    code: error?.code,
    reason: error?.reason,
  };
}

function jsonWire(value) {
  return JSON.stringify(value, (_, field) => {
    if (field === undefined) return { '$gate.undefined': true };
    if (typeof field === 'bigint') return { '$gate.bigint': String(field) };
    if (typeof field === 'number' && (!Number.isFinite(field) || Object.is(field, -0))) {
      return { '$gate.number': Object.is(field, -0) ? '-0' : String(field) };
    }
    return field;
  });
}

function projectCases(receipt, language, trace) {
  return receipt.evaluation.cases.map((row) => {
    try {
      return judgeCaseExecutionOutcome(row, { language, trace });
    } catch (error) {
      return { rejected: errorInfo(error) };
    }
  });
}

export function projectReceipt(receipt, language, selected) {
  const ordinaryProjections = projectCases(receipt, language, false);
  const tracedProjections = projectCases(receipt, language, true);
  const compile = receipt.evaluation.compile;
  function projectCompile(trace) {
    try {
      return judgeCompileExecutionOutcome(compile, { language, trace });
    } catch (error) {
      return { rejected: errorInfo(error) };
    }
  }
  return {
    ...(compile && compile.status !== 'compiled' ? {
      compileProjection: projectCompile(false),
      tracedCompileProjection: projectCompile(true),
    } : {}),
    ordinaryProjections,
    tracedProjections,
    projections: receipt.evaluation.cases.map(({ caseId }, index) =>
      (selected.includes(caseId) ? tracedProjections : ordinaryProjections)[index]),
    traceAliases: receipt.evaluation.cases.map(({ attachment, trace }, index) =>
      attachment?.trace === undefined || (
        attachment.trace === trace && Object.isFrozen(trace) &&
        (tracedProjections[index].rejected || tracedProjections[index].trace === trace)
      )),
  };
}

export async function runDeferredFixture(fixture, scenario) {
  const { language } = fixture;
  const bundle = await createAlgorithmJudgeBundle({
    ...fixture, id: `ga-${language}-${scenario.name}-deferred`, trace: true,
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
    traceOptions: supportedTraceOptions(language, fixture.traceOptions),
  });
  return observeDeferred(bundle, scenario, {
    createHost: () => createBrowserJudgeHost({
      providers: [language], assetBaseUrl: location.origin + '/workers',
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    }),
    grade: (bundle, evaluation) => {
      const { policy, verdict, passedCount, totalCount } = createAlgorithmJudgeReceipt(bundle, evaluation);
      return { policy, verdict, passedCount, totalCount };
    },
    project: (receipt, caseId) => projectReceipt(receipt, language, [caseId]),
  });
}

let appTraceCapture;
export async function archiveAppObservation(observation) {
  if (!appTraceCapture) {
    const { createAppTraceCapture } = await import(/* @vite-ignore */ '/gate-app-trace-wire.mjs');
    appTraceCapture = createAppTraceCapture(jsonWire, (...part) => globalThis.recordGateTraceChunk(...part));
  }
  return appTraceCapture(observation);
}

export async function runFixture(fixture, requests, nonce, mutation) {
  installJudgeJournal(fixture.language, fixture.judgedByteLimit);
  const handles = new Map();
  let drawn;
  let submitHost;
  let firstCompileFailed = false;
  let createRouteHost;
  if (fixture.algorithmExecution) {
    ({ createJavaScriptRouteHost: createRouteHost } = await import(/* @vite-ignore */ '/gate-routes.mjs'));
  }
  function freshHost() {
    if (createRouteHost) return createRouteHost(fixture.language, fixture.algorithmExecution);
    return createBrowserJudgeHost({
      providers: [fixture.language],
      assetBaseUrl: location.origin + '/workers',
      safeExecution: { workerLifecycle: 'warm-and-retire' },
      ...(fixture.naturalShape ? { cpp: {
        executionTimeoutMs: fixture.limits.wallClockMs,
        tracingTimeoutMs: fixture.limits.wallClockMs,
      } } : {}),
    });
  }
  try {
    for (const request of requests) {
      transcript = [];
      seed = mutation;
      seedHits = [];
      const start = performance.now();
      const journalStart = journal.length;
      let host;
      let reported;
      let bundle;
      let skip;
      const retained = request.mode === 'continuation' ? handles.get('run-first') : undefined;
      try {
        if (request.mode === 'continuation') {
          if (firstCompileFailed) skip = 'initial-compile-failed';
          else if (!retained) throw new Error('Missing first interactive execution handle');
          else {
            reported = await retained.host.execute({
              executionId: retained.id, tracing: { caseIds: request.selected },
            });
          }
        } else {
          const reuseHost = request.mode === 'submit' && !fixture.naturalShape;
          host = reuseHost ? (submitHost ??= freshHost()) : freshHost();
          bundle = await createAlgorithmJudgeBundle({
            id: `${fixture.gate}-${fixture.language}-${fixture.name}-${request.id}`,
            language: fixture.language,
            code: fixture.code,
            functionName: Object.hasOwn(request, 'functionName') ? request.functionName : fixture.functionName,
            executionStyle: fixture.executionStyle,
            trace: Object.hasOwn(request, 'trace') ? request.trace : request.mode === 'initial' || request.selected.length > 0,
            cases: request.cases.map((id) => {
              const { input, expected } = fixture.cases.find((row) => row.id === id);
              return { id, input: structuredClone(input), ...(expected === undefined ? {} : { expected: structuredClone(expected) }) };
            }),
            limits: request.limits ?? fixture.limits,
            traceOptions: supportedTraceOptions(fixture.language, fixture.traceOptions),
            comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
          });
          if (request.mode === 'submit') {
            reported = await host.evaluateAlgorithm({ bundle, ...(request.stop ? { stopAtFirstRunaway: true } : {}) });
          } else if (request.mode === 'execute') {
            reported = await host.execute({ bundle, ...(request.selected.length ? { tracing: { caseIds: request.selected } } : {}) });
          } else {
            reported = await host.execute({ bundle, interactive: true, tracing: { caseIds: request.selected } });
            if (reported.executionId) handles.set(request.id, {
              host, id: reported.executionId, evaluation: reported.evaluation,
              workspaceDigest: bundle.workspaceDigest, journal: journal.slice(journalStart),
            });
            if (request.id === 'run-first') firstCompileFailed = reported.evaluation.status === 'compile-failed';
          }
        }
        const projected = reported && projectReceipt(reported, fixture.language, request.selected);
        const observation = {
          nonce, request: request.id, reported, ...projected, skip, seedHits,
          workspaceDigest: bundle?.workspaceDigest ?? retained?.workspaceDigest,
          retainedExecutionId: retained?.id, retainedEvaluation: retained?.evaluation, retainedJournal: retained?.journal,
          drawnEvaluation: request.id === 'redraw-b' ? drawn?.evaluation : undefined,
          drawnJournal: request.id === 'redraw-b' ? drawn?.journal : undefined,
          journal: journal.slice(journalStart),
          submitted: bundle && {
            id: bundle.id, workspaceDigest: bundle.workspaceDigest,
            traceOptions: bundle.execution.traceOptions,
            ...(fixture.playgroundScript ? { execution: bundle.execution } : {}),
          },
          worker: transcript, wallMs: performance.now() - start,
        };
        await globalThis.recordGateObservation(jsonWire(fixture.archiveAppTraces
          ? await archiveAppObservation(observation) : observation));
        if (request.id === 'draw-b' && reported) drawn = { evaluation: reported.evaluation, journal: journal.slice(journalStart) };
      } catch (error) {
        await globalThis.recordGateObservation(jsonWire({
          nonce, request: request.id, error: errorInfo(error), worker: transcript, journal: journal.slice(journalStart),
          wallMs: performance.now() - start,
        }));
      } finally {
        if (host && (request.mode === 'initial' || request.mode === 'execute' || fixture.naturalShape)) {
          const handle = handles.get(request.id);
          if (request.id !== 'run-first' || !handle) {
            try {
              if (handle) await host.disposeExecution(handle.id);
            } finally {
              host.dispose();
              handles.delete(request.id);
            }
          }
        }
      }
    }
    return nonce;
  } finally {
    for (const { host, id } of handles.values()) {
      try {
        await host.disposeExecution(id);
      } finally {
        host.dispose();
      }
    }
    submitHost?.dispose();
  }
}

export async function observeCppDirect(fixture, batch) {
  transcript = [];
  const { runCppDirect } = await import(/* @vite-ignore */ '/gate-routes.mjs');
  return { ...await runCppDirect(fixture, batch), worker: transcript };
}
