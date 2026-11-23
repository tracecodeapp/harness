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
      traceUnavailable: c.traceUnavailable,
      traceExitReason: c.trace?.exitReason,
      timing: c.timings,
      failure: c.failure,
      notRun: c.notRun,
    })),
  };
}

export function createSession(language: string, stopSubmit: boolean) {
  if (crossOriginIsolated) throw new Error('Practice requires a non-isolated document');
  const assetBaseUrl = '/workers';
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
    const traceOptions = Object.fromEntries(
      Object.entries(fixture.traceBudget).filter(([key]) => controls[key]),
    );
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
      policy: allCasesPassPolicy(),
      comparison: fixture.comparison,
    });
  }

  async function release() {
    const id = executionId;
    executionId = undefined;
    if (id) await host.disposeExecution(id);
  }

  return {
    async warm() {
      try {
        return await host.warmLanguage(language);
      } catch (error) {
        return { error: errorDetails(error) };
      }
    },
    async initial(fixture: Fixture, mode: 'run' | 'submit' | 'lesson', cold: boolean) {
      await release();
      const started = performance.now();
      // Model a click as soon as the fresh page can request execution, while its
      // runtime prewarm is still in progress. The host owns the provider queue.
      const warm = cold ? this.warm() : undefined;
      try {
        const b = await bundle(fixture, mode !== 'submit');
        const builtMs = performance.now() - started;
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
        const elapsedMs = performance.now() - started;
        executionId = result.executionId;
        const evaluation = summarize(result.evaluation);
        const firstTrace = evaluation.cases.find((c: { id: string }) => c.id === fixture.cases[0]!.id);
        // These packages deliver the selected trace in the same browser Judge
        // response as all case verdicts. There is no earlier event subscription.
        return {
          elapsedMs, builtMs, evaluation, firstTraceMs: firstTrace?.traceEvents ? elapsedMs : null,
          executionId: Boolean(executionId), warm: await warm, timing: result.timings,
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
        };
      } catch (error) {
        return { error: errorDetails(error) };
      }
    },
    release,
    dispose: () => host.dispose(),
  };
}
