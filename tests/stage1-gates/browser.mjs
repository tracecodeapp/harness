import {
  builtInProjectEvaluators,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '@tracecode/harness/judge';
export { resolveBuiltInTraceCCRuntimeManifest } from '@tracecode/harness/tracekernel';
export { builtInProjectEvaluators, createAlgorithmJudgeBundle, createBrowserJudgeHost };

let transcript = [];
let nextGeneration = 0;
let seed;
let seedHits;
const NativeWorker = globalThis.Worker;
class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    const generation = ++nextGeneration;
    const worker = String(url);
    const pending = new Map();
    const programs = new Map();
    this.addEventListener('message', (event) => {
      const data = event.data;
      const command = pending.get(data?.id);
      if (command) {
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
        if (worker.includes('/python/') && (Array.isArray(rows) || rows)) {
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
          rows: data.payload?.results?.length, phase: data.payload?.phase,
          index: data.payload?.index,
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
      if (seed === 'split-second-edge' && worker.includes('/python/')) {
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
      if (command.id) pending.set(command.id, command);
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

export function projectCases(receipt, language, trace) {
  return receipt.evaluation.cases.map((row) => {
    try {
      return judgeCaseExecutionOutcome(row, { language, trace });
    } catch (error) {
      return { rejected: errorInfo(error) };
    }
  });
}

export async function runFixture(fixture, requests, nonce, mutation) {
  const handles = new Map();
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
    });
  }
  try {
    for (const request of requests) {
      transcript = [];
      seed = mutation;
      seedHits = [];
      const start = performance.now();
      let host;
      let reported;
      let bundle;
      let skip;
      let retainedExecutionId;
      try {
        if (request.mode === 'continuation') {
          const retained = handles.get('run-first');
          if (firstCompileFailed) skip = 'initial-compile-failed';
          else if (!retained) throw new Error('Missing first interactive execution handle');
          else {
            retainedExecutionId = retained.id;
            reported = await retained.host.execute({
              executionId: retained.id, tracing: { caseIds: request.selected },
            });
          }
        } else {
          host = request.mode === 'submit' ? (submitHost ??= freshHost()) : freshHost();
          bundle = await createAlgorithmJudgeBundle({
            id: `${fixture.gate}-${fixture.language}-${fixture.name}-${request.id}`,
            language: fixture.language,
            code: fixture.code,
            functionName: fixture.functionName,
            executionStyle: fixture.executionStyle,
            trace: request.mode === 'initial' || request.selected.length > 0,
            cases: request.cases.map((id) => {
              const { input, expected } = fixture.cases.find((row) => row.id === id);
              return { id, input: structuredClone(input), ...(expected === undefined ? {} : { expected: structuredClone(expected) }) };
            }),
            limits: fixture.limits,
            traceOptions: fixture.traceOptions,
            comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
          });
          if (request.mode === 'submit') {
            reported = await host.evaluateAlgorithm({ bundle, ...(request.stop ? { stopAtFirstRunaway: true } : {}) });
          } else {
            reported = await host.execute({ bundle, interactive: true, tracing: { caseIds: request.selected } });
            if (reported.executionId) handles.set(request.id, { host, id: reported.executionId });
            if (request.id === 'run-first') firstCompileFailed = reported.evaluation.status === 'compile-failed';
          }
        }
        const projections = reported?.evaluation.cases.map((row) => {
          try {
            return judgeCaseExecutionOutcome(row, { language: fixture.language, trace: request.selected.includes(row.caseId) });
          } catch (error) {
            return { rejected: errorInfo(error) };
          }
        });
        let compileProjection;
        if (reported?.evaluation.compile && reported.evaluation.compile.status !== 'compiled') {
          try {
            compileProjection = judgeCompileExecutionOutcome(reported.evaluation.compile, { language: fixture.language });
          } catch (error) {
            compileProjection = { rejected: errorInfo(error) };
          }
        }
        await globalThis.recordGateObservation(jsonWire({
          nonce, request: request.id, reported, projections, compileProjection, skip, retainedExecutionId, seedHits,
          submitted: bundle && { id: bundle.id, workspaceDigest: bundle.workspaceDigest },
          worker: transcript, wallMs: performance.now() - start,
        }));
      } catch (error) {
        await globalThis.recordGateObservation(jsonWire({
          nonce, request: request.id, error: errorInfo(error), worker: transcript,
          wallMs: performance.now() - start,
        }));
      } finally {
        if (request.mode === 'initial' && host) {
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
  const results = await runCppDirect(fixture, batch);
  return { results, worker: transcript };
}
