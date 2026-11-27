// Cross-version packaging follows lane AA's release-diff entry. The asset and
// timing boundary follows lane V's non-isolated, same-origin Practice benchmark.
import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from 'tracecode-harness-under-test/judge';
import {
  createTraceCCRuntimeManifest,
  getLanguageRuntimeProfile,
  resolveBrowserRuntimeAssets,
  TRACECC_RUNTIME_ASSET_RELATIVE_PATH,
} from 'tracecode-harness-under-test/tracekernel';
import { javaWorkerPhaseTimings } from './java-candidate-witness.mjs';
import { selectTraceOptions } from './trace-options.mjs';

type Case = {
  id: string;
  input: Record<string, unknown>;
  expected: unknown;
  comparator?: unknown;
};
export type Fixture = {
  id: string;
  language: string;
  code: string;
  functionName: string;
  executionStyle: string;
  comparison: unknown;
  traceBudget: Record<string, number>;
  cases: Case[];
};

function errorDetails(error: unknown) {
  const e = error as { message?: string; reason?: unknown; _tag?: unknown; name?: string };
  return { message: e?.message ?? String(error), reason: e?.reason, tag: e?._tag, name: e?.name };
}

function summarize(evaluation: any) {
  return {
    status: evaluation.status,
    compile: evaluation.compile?.timings,
    compileFailure: evaluation.compile?.failure,
    cases: (evaluation.cases ?? []).map((c: any) => ({
      id: c.caseId,
      status: c.status,
      verdict: c.verdict?.kind,
      traceEvents: Array.isArray(c.trace?.events) ? c.trace.events.length : 0,
      learnerLine: Boolean(c.trace?.events?.some((event: any) => event.kind === 'line' && event.line > 0)),
      legacyRefusalFields: ['untracedRunNeeded', 'traceUnavailable', 'traceUnavailableRun']
        .filter((field) => Object.hasOwn(c, field)),
      traceUnavailable: c.traceUnavailable,
      attachment: c.attachment && { status: c.attachment.status, reason: c.attachment.reason },
      traceExitReason: c.trace?.exitReason,
      timing: c.timings,
      failure: c.failure,
      notRun: c.notRun,
    })),
  };
}

function submitPolicy(fixture: Fixture, main: boolean) {
  // Deploy includes an already-computed passing complexity fact for the
  // Binary Search requirement. Main judges the case-only policy at this
  // boundary and evaluates complexity separately after the verdicts.
  const factIds = !main && fixture.id === 'binary-search'
    ? ['semantic-engine.complexity-requirement.0.satisfied'] : [];
  const equalsTrue = (left: unknown) => ({ op: 'eq', left, right: { op: 'literal', value: true } });
  return {
    facts: factIds.map((id) => ({
      id,
      schema: 1,
      value: true,
      entrypoint: fixture.functionName,
      producer: { id: 'semantic-engine', version: '3.0.0' },
      verification: 'browser-asserted',
      confidence: 1,
    })),
    policy: {
      schema: 'tracecode.judge.verdict-policy.v1',
      requires: factIds.map((id) => ({
        id, schema: 1, producer: 'semantic-engine',
        minimumVerification: 'browser-asserted', minimumConfidence: 1,
      })),
      passWhen: {
        op: 'all',
        conditions: [
          equalsTrue({ op: 'ref', path: 'allCasesPassed' }),
          ...factIds.map((id) => equalsTrue({ op: 'fact', id })),
        ],
      },
    },
  };
}

function measureCandidateRequests(language: string) {
  type Request = {
    worker: number; type: string; role?: string; sent: number; received?: number;
    workerKind?: string; mode?: string; observation?: boolean; artifactKey?: string;
    cases?: number; tier?: string; stopAtFirstRunaway?: boolean;
    timings?: Record<string, unknown>;
    admissionId?: number;
    admissionProgress?: Array<{
      stage?: string; caseIndex?: number; admissionId?: number; success?: boolean; tier?: string;
    }>;
    admissionTerminal?: {
      resultsStreamed?: number; startedCaseIndexes?: number[]; runnerProcessCount?: number;
    };
  };
  let nextWorker = 0;
  let requests: Request[] = [];
  const artifactRoles = new Map<string, string>();
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const parsed = new URL(url, location.href);
      const monitored = language === 'java'
        ? /\/java-runtime-worker\.js$/.test(parsed.pathname)
        : language === 'csharp'
          ? /\/csharp-worker\.js$/.test(parsed.pathname)
          : /\/python-worker\.js$/.test(parsed.pathname) &&
            parsed.searchParams.get('tracecodePythonRole') !== 'runtime-image';
      if (!monitored) return;
      const worker = ++nextWorker;
      let role: string | undefined;
      let workerKind: string | undefined;
      const pending = new Map<string, Request>();
      this.addEventListener('message', ({ data }) => {
        const request = pending.get(data?.id);
        if (!request || data.type === 'batch-case-progress') return;
        if (language === 'java' && data.type === 'runtime-progress' &&
            request.type === 'execute-prepared-runtime-program-batch') {
          const { stage, detail } = data.payload ?? {};
          if (stage === 'ordinary-case-started' || stage === 'ordinary-case-finished') {
            request.admissionProgress ??= [];
            request.admissionProgress.push({
              stage,
              caseIndex: detail?.caseIndex,
              admissionId: detail?.admissionId,
              ...(stage === 'ordinary-case-finished' && {
                success: detail?.result?.success,
                tier: detail?.result?.algorithmIsolationProfile?.tier,
              }),
            });
            request.tier ??= detail?.result?.algorithmIsolationProfile?.tier;
          }
          return;
        }
        const expected = language === 'python'
          ? request.type === 'prepare-program' ? 'prepare-result' : 'execute-result'
          : request.type;
        if (data.type !== expected && data.type !== 'error') return;
        pending.delete(data.id);
        request.received = performance.now();
        request.timings = language === 'java'
          ? javaWorkerPhaseTimings(data.payload)
          : data.payload?.timings;
        if (language === 'java' && request.type === 'execute-prepared-runtime-program-batch' &&
            data.payload?.results === undefined &&
            Number.isSafeInteger(data.payload?.resultsStreamed)) {
          request.admissionTerminal = {
            resultsStreamed: data.payload.resultsStreamed,
            startedCaseIndexes: data.payload.startedCaseIndexes,
            runnerProcessCount: data.payload.timings?.runnerProcessCount,
          };
        }
        request.tier ??= language === 'java'
          ? data.payload?.results?.[0]?.algorithmIsolationProfile?.tier
          : data.payload?.artifact?.isolationProfile?.tier ?? data.payload?.preparedRunnerTier;
        request.artifactKey ??= data.payload?.compiledArtifactKey;
        if (request.type === 'prepare-program' && request.artifactKey && request.role) {
          artifactRoles.set(request.artifactKey, request.role);
        }
      });
      this.postMessage = (message, options?) => {
        const typePattern = language === 'java'
          ? /^(init|warmup|prepare-runtime-program|restore-prepared-runtime-program|execute-prepared-runtime-program|execute-prepared-runtime-program-batch)$/
          : language === 'csharp'
            ? /^(init|warmup|prepare-program|execute-code|execute-code-batch|execute-with-tracing|execute-prepared-code|execute-prepared-trace|dispose-prepared-program)$/
            : /^(prepare-program|execute-prepared-program|execute-prepared-program-batch)$/;
        if (message.id && typePattern.test(message.type)) {
          const payload = message.payload ?? {};
          if (language === 'java' && message.type === 'prepare-runtime-program') {
            role = payload.observerOnly ? 'observer' : payload.mode === 'code' ? 'ordinary' : 'legacy-trace';
          } else if (language === 'csharp') {
            workerKind = payload.runtimeRole ?? workerKind;
            const artifactKey = payload.prepared?.compiledArtifactKey ?? payload.compiledArtifactKey;
            role = message.type === 'prepare-program'
              ? payload.mode === 'code' ? 'ordinary' : 'observer'
              : ['execute-code', 'execute-code-batch', 'execute-with-tracing'].includes(message.type)
                ? payload.mode === 'trace' || payload.trace === true ? 'observer' : 'ordinary'
              : message.type === 'execute-prepared-code'
                ? 'ordinary'
                : message.type === 'execute-prepared-trace' && payload.observation !== undefined
                  ? 'observer'
                  : message.type === 'dispose-prepared-program'
                    ? artifactRoles.get(artifactKey) ?? role
                  : role;
          } else if (language === 'python') {
            const observation = payload.observationOnly === true || payload.artifact?.observationOnly === true;
            role = observation ? 'observer' : payload.mode === 'code' ? 'ordinary' : 'legacy-trace';
          }
          const request: Request = {
            worker,
            workerKind,
            role,
            type: message.type,
            sent: performance.now(),
            mode: payload.mode,
            observation: payload.observation !== undefined || payload.observationOnly === true ||
              payload.artifact?.observationOnly === true,
            artifactKey: payload.prepared?.compiledArtifactKey ?? payload.artifact?.compiledArtifactKey ??
              payload.compiledArtifactKey,
            cases: payload.inputBatch?.length ?? payload.rows?.length,
            tier: payload.prepared?.preparedRunnerTier ?? payload.artifact?.isolationProfile?.tier,
            stopAtFirstRunaway: payload.stopAtFirstRunaway,
            admissionId: payload.admissionId,
          };
          pending.set(message.id, request);
          requests.push(request);
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      };
    }
  };
  return {
    read(start: number, received: number) {
      const phases = requests.map((request) => ({
        ...request,
        role: request.role ?? requests.find(({ worker, role }) => worker === request.worker && role)?.role,
        sentMs: request.sent - start,
        replyMs: request.received === undefined ? undefined : request.received - start,
      }));
      requests = [];
      const batches = phases.filter(({ type }) => type === 'execute-prepared-runtime-program-batch');
      const ordinary = batches.find(({ role }) => role === 'ordinary');
      const lastReply = Math.max(...batches.map(({ received }) => received ?? -Infinity));
      return {
        phases,
        restores: phases.filter(({ type }) => type === 'restore-prepared-runtime-program').length,
        runners: batches.reduce((sum, item) => sum + Number(item.timings?.runnerProcessCount ?? 0), 0),
        ordinaryReplyToJoinMs: ordinary?.received === undefined ? undefined : received - ordinary.received,
        lastWorkerReplyToJoinMs: Number.isFinite(lastReply) ? received - lastReply : undefined,
      };
    },
  };
}

export function createSession(language: string, stopSubmit: boolean, candidate = false,
  candidateRuntime = candidate) {
  if (crossOriginIsolated) throw new Error('Practice requires a non-isolated document');
  const assetBaseUrl = '/workers';
  const measured = candidate && ['java', 'csharp', 'python'].includes(language)
    ? measureCandidateRequests(language)
    : undefined;
  const { pythonWorker, javascriptWorker, javascriptAlgorithmWorker, javaWorker, csharpWorker, cppWorker } =
    resolveBrowserRuntimeAssets();
  const host: any = createBrowserJudgeHost({
    assetBaseUrl,
    providers: [language],
    debug: false,
    assets: {
      pythonWorker, javascriptWorker, javascriptAlgorithmWorker, javaWorker, csharpWorker,
      runtimeManifests: {
        cpp: createTraceCCRuntimeManifest(
          assetBaseUrl + '/' + TRACECC_RUNTIME_ASSET_RELATIVE_PATH,
          { workerUrl: cppWorker },
        ),
      },
    },
    cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
  });
  let sequence = 0;
  let executionId: string | undefined;

  function bundle(fixture: Fixture, trace: boolean) {
    const controls = (getLanguageRuntimeProfile as any)(language).capabilities.tracing.controls;
    const traceOptions = selectTraceOptions(fixture.traceBudget, controls,
      candidateRuntime && language === 'java');
    return (createAlgorithmJudgeBundle as any)({
      id: (trace ? 'interactive-algorithm-' : 'algorithm-') + sequence++,
      language,
      code: fixture.code,
      functionName: fixture.functionName,
      executionStyle: fixture.executionStyle,
      trace,
      ...(trace && { traceOptions }),
      ...(language === 'java' && { limits: { wallClockMs: 60_000 } }),
      cases: fixture.cases,
      ...(trace ? { policy: allCasesPassPolicy() } : submitPolicy(fixture, stopSubmit)),
      comparison: fixture.comparison,
    });
  }

  async function release() {
    const id = executionId;
    executionId = undefined;
    if (id) await host.disposeExecution(id);
  }

  return {
    async warm(collect = true) {
      try {
        const started = performance.now();
        const warm = await host.warmLanguage(language);
        return measured && collect
          ? { ...warm, [language]: measured.read(started, performance.now()) }
          : warm;
      } catch (error) {
        return { error: errorDetails(error) };
      }
    },
    async initial(fixture: Fixture, mode: 'run' | 'submit' | 'lesson', cold: boolean) {
      await release();
      const started = performance.now();
      // Model a click as soon as the fresh page can request execution, while its
      // runtime prewarm is still in progress. The host owns the provider queue.
      const warm = cold ? this.warm(false) : undefined;
      try {
        const b = await bundle(fixture, mode !== 'submit');
        const judgeStarted = performance.now();
        const builtMs = judgeStarted - started;
        const result = mode === 'submit'
          ? await host.evaluateAlgorithm({
              bundle: b,
              ...(stopSubmit && language !== 'python' && { stopAtFirstRunaway: true }),
            })
          : await host.execute({
              bundle: b,
              interactive: true,
              tracing: { caseIds: [fixture.cases[0]!.id] },
            });
        const received = performance.now();
        const elapsedMs = received - started;
        executionId = result.executionId;
        const evaluation = summarize(result.evaluation);
        const firstTrace = evaluation.cases.find((c: { id: string }) => c.id === fixture.cases[0]!.id);
        // These packages deliver the selected trace in the same browser Judge
        // response as all case verdicts. There is no earlier event subscription.
        return {
          elapsedMs, builtMs, evaluation, verdict: result.verdict, firstTraceMs: firstTrace?.traceEvents ? elapsedMs : null,
          ...(fixture.id === 'heavy-022' && { judgeMs: received - judgeStarted }),
          executionId: Boolean(executionId), warm: await warm, timing: result.timings,
          ...(measured && { [language]: measured.read(started, received) }),
        };
      } catch (error) {
        return { error: errorDetails(error), warm: await warm };
      }
    },
    async second(caseId: string) {
      if (!executionId) throw new Error('Interactive Run returned no execution ID');
      try {
        // The app starts a background continuation for this case first when
        // all verdicts pass. The immediate click waits on the in-flight case.
        const requestOut = performance.now();
        const pending = host.execute({ executionId, tracing: { caseIds: [caseId] } });
        const clicked = performance.now();
        const result = await pending;
        const received = performance.now();
        return {
          elapsedMs: received - clicked,
          dispatchToClickMs: clicked - requestOut,
          evaluation: summarize(result.evaluation),
          timing: result.timings,
          ...(measured && { [language]: measured.read(requestOut, received) }),
        };
      } catch (error) {
        return { error: errorDetails(error) };
      }
    },
    release,
    dispose: () => host.dispose(),
  };
}
