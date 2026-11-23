import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '@tracecode/harness/judge';

let transcript = [];
let nextGeneration = 0;
const NativeWorker = globalThis.Worker;
class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    const generation = ++nextGeneration;
    const worker = String(url);
    const pending = new Map();
    this.addEventListener('message', (event) => {
      const data = event.data;
      const command = pending.get(data?.id);
      if (command) {
        pending.delete(data.id);
        transcript.push({
          action: 'response', worker, generation, id: data.id, type: data.type,
          success: data.payload?.success, mode: data.payload?.mode,
          tier: data.payload?.isolationProfile?.tier,
          rows: data.payload?.results?.length,
        });
      }
    });
    this.addEventListener('error', (event) => {
      transcript.push({ action: 'error', worker, generation, message: event.message });
    });
    const post = this.postMessage.bind(this);
    this.postMessage = (data, options) => {
      const payload = data?.payload;
      const prepared = payload?.prepared ?? payload?.artifact;
      const command = {
        action: 'command', worker, generation, id: data?.id, type: data?.type,
        role: payload?.runtimeRole, mode: payload?.mode ?? prepared?.mode,
        tier: payload?.isolationProfile?.tier ?? prepared?.isolationProfile?.tier,
        functionName: payload?.functionName ?? prepared?.functionName,
        inputs: payload?.inputs, trace: payload?.trace ?? payload?.traceFlags,
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
  // Keep undefined distinct from an omitted field in the archived wire.
  return JSON.stringify(value, (_, field) => field === undefined ? { '$gate.undefined': true } : field);
}

export async function runFixture(fixture, requests, nonce) {
  const handles = new Map();
  let submitHost;
  let firstCompileFailed = false;
  function freshHost() {
    return createBrowserJudgeHost({
      providers: [fixture.language],
      assetBaseUrl: location.origin + '/workers',
      safeExecution: { workerLifecycle: 'warm-and-retire' },
    });
  }
  try {
    for (const request of requests) {
      transcript = [];
      const start = performance.now();
      let host;
      let reported;
      let bundle;
      let skip;
      try {
        if (request.mode === 'continuation') {
          const retained = handles.get('run-first');
          if (firstCompileFailed) skip = 'initial-compile-failed';
          else if (!retained) throw new Error('Missing first interactive execution handle');
          else reported = await retained.host.execute({
            executionId: retained.id, tracing: { caseIds: request.selected },
          });
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
          nonce, request: request.id, reported, projections, compileProjection, skip,
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
