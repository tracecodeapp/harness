import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  isRuntimeProviderError,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '../../src/judge';
import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';
import {
  healthyProgram,
  baseMode,
  isTracedMode,
  STOPPING_BATCH_MODES,
  STOPPING_MODE_KINDS,
  matrixCells,
  type MatrixCellResult,
  type MatrixCellSpec,
  type MatrixClass,
  type MatrixFailureKind,
  type MatrixLanguage,
  type MatrixMode,
  type MatrixObservation,
  type MatrixProgram,
} from './learner-failure-matrix-cases';

type Host = ReturnType<typeof createBrowserJudgeHost>;
type Receipt = Awaited<ReturnType<Host['evaluateAlgorithm']>>;
type Evaluation = Receipt['evaluation'];

interface DiagnosticLike {
  readonly severity?: string;
  readonly code?: string;
  readonly message?: string;
  readonly line?: number;
}

const LEARNER_STAGES = new Set(['runtime', 'trace']);
const COMPILE_STAGES = new Set([
  'compile',
  'driver-compile',
  'trace-driver-compile',
  'driver-link',
]);
const LIMIT_REASONS = new Set([
  'trace-limit',
  'trace-byte-limit',
  'line-limit',
  'single-line-limit',
  'recursion-limit',
  'memory-limit',
  'serialization-limit',
  'client-timeout',
]);
const CELL_GUARD_MS = Number((globalThis as { __MATRIX_CELL_GUARD_MS__?: number }).__MATRIX_CELL_GUARD_MS__ ?? 150_000);

function classOfCode(code: string | undefined): MatrixClass {
  if (code === 'runtime-provider-error') return 'provider';
  if (code && COMPILE_STAGES.has(code)) return 'compile';
  if (code && LEARNER_STAGES.has(code)) return 'runtime';
  if (code && LIMIT_REASONS.has(code)) return 'limit';
  return 'unclassified';
}

function observe(
  diagnostics: readonly DiagnosticLike[],
  extra: {
    readonly status?: string;
    readonly timedOut?: boolean;
    readonly stderr?: string;
    readonly value?: unknown;
  }
): MatrixObservation {
  const diagnostic =
    diagnostics.find((candidate) => candidate.severity === 'error') ??
    diagnostics[0];
  if (extra.status === 'not-run') {
    return { class: 'not-run', status: extra.status };
  }
  if (extra.status === 'completed') {
    return {
      class: 'completed',
      status: extra.status,
      ...(diagnostic?.code ? { code: diagnostic.code } : {}),
      value: JSON.stringify(extra.value ?? null).slice(0, 80),
    };
  }
  let klass = classOfCode(diagnostic?.code);
  if (klass === 'unclassified' && extra.timedOut) klass = 'limit';
  return {
    class: klass,
    ...(extra.status ? { status: extra.status } : {}),
    ...(diagnostic?.code ? { code: diagnostic.code } : {}),
    ...(klass === 'limit'
      ? { reason: diagnostic?.code && LIMIT_REASONS.has(diagnostic.code) ? diagnostic.code : 'client-timeout' }
      : {}),
    message: diagnostic?.message ?? extra.stderr ?? '',
    ...(typeof diagnostic?.line === 'number' ? { line: diagnostic.line } : {}),
  };
}

type JudgeFailureLike = {
  readonly origin: string;
  readonly stage?: string;
  readonly reason?: string;
};

function originText(failure: JudgeFailureLike | undefined): string | undefined {
  if (!failure) return undefined;
  return failure.origin === 'program'
    ? `program:${failure.stage}`
    : `${failure.origin}:${failure.reason}`;
}

/** What the exported Judge-to-outcome conversion produces for this result. */
function conversionText(convert: () => { readonly kind: string; readonly diagnosticStage?: string; readonly reason?: string }): string {
  try {
    const outcome = convert();
    return outcome.kind === 'failed'
      ? `failed:${outcome.diagnosticStage}`
      : outcome.kind === 'limit'
        ? `limit:${outcome.reason}`
        : outcome.kind;
  } catch (error) {
    return isRuntimeProviderError(error) ? 'provider-rejected' : `threw:${String(error)}`;
  }
}

function observeEvaluation(
  evaluation: Evaluation,
  language: MatrixLanguage,
  trace: boolean
): MatrixObservation[] {
  if (evaluation.status === 'compile-failed') {
    const compile = evaluation.compile;
    return [{
      ...observe(compile.diagnostics, {
        status: 'compile-failed',
        stderr: compile.stderr,
      }),
      origin: originText(compile.failure),
      conversion: conversionText(() =>
        trace
          ? judgeCompileExecutionOutcome(compile, { language, trace: true })
          : judgeCompileExecutionOutcome(compile, { language })
      ),
    }];
  }
  return evaluation.cases.map((testCase) => ({
    ...observe(testCase.diagnostics, {
      status: testCase.status,
      timedOut: testCase.timedOut,
      stderr: testCase.stderr,
      value: testCase.value,
    }),
    origin: originText(testCase.failure) ?? 'none',
    conversion: conversionText(() =>
      trace
        ? judgeCaseExecutionOutcome(testCase, { language, trace: true })
        : judgeCaseExecutionOutcome(testCase, { language })
    ),
  }));
}

function thrown(error: unknown): MatrixObservation {
  return {
    class: 'provider',
    status: 'host-rejected',
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

function caseInputs(count: number, inputs?: Readonly<Record<string, unknown>>) {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index + 1}`,
    input: inputs ? structuredClone(inputs) : { n: 3 + index },
  }));
}

async function bundleFor(
  language: MatrixLanguage,
  program: MatrixProgram,
  options: {
    readonly id: string;
    readonly trace: boolean;
    readonly caseCount: number;
    readonly limits?: { readonly wallClockMs?: number };
    readonly traceOptions?: { readonly maxTraceSteps?: number };
    readonly inputs?: Readonly<Record<string, unknown>>;
  }
) {
  return createAlgorithmJudgeBundle({
    id: options.id,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    cases: caseInputs(options.caseCount, options.inputs),
    trace: options.trace,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.trace && options.traceOptions ? { traceOptions: options.traceOptions } : {}),
  });
}

let bundleSequence = 0;
let batchCaseCount = 2;

async function runMode(
  host: Host,
  language: MatrixLanguage,
  program: MatrixProgram,
  mode: MatrixMode,
  spec: Pick<MatrixCellSpec, 'limits' | 'traceOptions' | 'inputs'>,
  signal?: AbortSignal
): Promise<MatrixObservation[]> {
  bundleSequence += 1;
  const id = `matrix-${language}-${mode}-${bundleSequence}`;
  const trace = isTracedMode(mode);
  const caseCount = mode === 'code' || mode === 'trace' ? 1 : batchCaseCount;
  const bundle = await bundleFor(language, program, {
    id,
    trace,
    caseCount,
    limits: spec.limits,
    traceOptions: spec.traceOptions,
    inputs: spec.inputs,
  });
  try {
    if (mode !== 'interactive') {
      const receipt = await host.evaluateAlgorithm({
        bundle,
        ...(signal ? { signal } : {}),
        ...(STOPPING_BATCH_MODES.includes(mode) ? { stopAtFirstRunaway: true } : {}),
      });
      return observeEvaluation(receipt.evaluation, language, trace);
    }
    const initial = await host.execute({
      bundle,
      interactive: true,
      tracing: { caseIds: ['case-1'] },
      ...(signal ? { signal } : {}),
    });
    const observations = observeEvaluation(initial.evaluation, language, true);
    if (initial.executionId) {
      try {
        const continuation = await host.execute({
          executionId: initial.executionId,
          tracing: { caseIds: ['case-2'] },
        });
        observations.push(...observeEvaluation(continuation.evaluation, language, true));
      } catch (error) {
        observations.push(thrown(error));
      } finally {
        await host.disposeExecution(initial.executionId).catch(() => undefined);
      }
    }
    return observations;
  } catch (error) {
    return [thrown(error)];
  }
}

function guard<T>(promise: Promise<T>, onHang: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onHang()), CELL_GUARD_MS);
    }),
  ]);
}

function brokenAssets(language: MatrixLanguage): Record<string, string> {
  const broken = (name: string) => `${location.origin}/__broken__/${name}`;
  switch (language) {
    case 'python':
      return { pythonRuntime: broken('python-runtime.js') };
    case 'javascript':
    case 'typescript':
      return {
        javascriptWorker: broken('javascript-worker.js'),
        javascriptAlgorithmWorker: broken('javascript-ses-algorithm-worker.js'),
      };
    case 'java':
      return { javaWorker: broken('java-runtime-worker.js') };
    case 'csharp':
      return { csharpWorker: broken('csharp-worker.js') };
    case 'cpp':
      return { cppWorker: broken('cpp-worker.js') };
  }
}

function createHost(
  assetBaseUrl: string,
  language: MatrixLanguage,
  assets?: Record<string, string>
): Host {
  return createBrowserJudgeHost({
    assetBaseUrl,
    providers: [language],
    assets: {
      // C++ takes its worker from the runtime manifest, never a legacy override.
      ...(language === 'cpp' ? {} : assets ?? {}),
      ...(language === 'cpp'
        ? {
            runtimeManifests: {
              cpp: createTraceCCRuntimeManifest(
                '/tracecc',
                assets?.cppWorker ? { workerUrl: assets.cppWorker } : {}
              ),
            },
          }
        : {}),
    },
    // The web app's C++ configuration.
    ...(language === 'cpp'
      ? { cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 } }
      : {}),
  });
}

export interface LanguageMatrixOptions {
  readonly assetBaseUrl: string;
  readonly language: MatrixLanguage;
  readonly modes: readonly MatrixMode[];
  readonly kinds?: readonly MatrixFailureKind[];
  /** Run only the infinite loop, without limits: measure what the defaults do. */
  readonly defaultLimitsProbe?: boolean;
  /** Cases per batch and interactive run (default 2). */
  readonly batchCaseCount?: number;
}

export async function runLanguageMatrix(
  options: LanguageMatrixOptions
): Promise<MatrixCellResult[]> {
  const { language } = options;
  batchCaseCount = options.batchCaseCount ?? 2;
  const results: MatrixCellResult[] = [];
  let host = createHost(options.assetBaseUrl, language);
  const healthy = healthyProgram(language);
  const checkHealthy = async (): Promise<{ ok: boolean; detail: string }> => {
    const observations = await guard(
      runMode(host, language, healthy, 'code', {}),
      () => [{ class: 'hung' as const }]
    );
    const ok = observations.length === 1 && observations[0]!.class === 'completed';
    return { ok, detail: ok ? '' : JSON.stringify(observations) };
  };
  try {
    const cells = matrixCells(language).filter((cell) =>
      options.defaultLimitsProbe
        ? cell.kind === 'infinite-loop'
        : !options.kinds || options.kinds.includes(cell.kind)
    );
    for (const cell of cells) {
      for (const mode of options.modes) {
        if (cell.modes && !cell.modes.includes(baseMode(mode))) continue;
        if (STOPPING_BATCH_MODES.includes(mode) && !STOPPING_MODE_KINDS.includes(cell.kind)) continue;
        if (cell.kind === 'provider-asset-failure') {
          const brokenHost = createHost(
            options.assetBaseUrl,
            language,
            brokenAssets(language)
          );
          const startedAt = performance.now();
          try {
            const observations = await guard(
              runMode(brokenHost, language, cell.program, mode, cell),
              () => [{ class: 'hung' as const }]
            );
            results.push({
              language,
              mode,
              kind: cell.kind,
              observations,
              elapsedMs: Math.round(performance.now() - startedAt),
            });
          } finally {
            brokenHost.dispose();
          }
          continue;
        }
        const spec = options.defaultLimitsProbe
          ? { traceOptions: cell.traceOptions }
          : cell;
        const startedAt = performance.now();
        let hung = false;
        const observations = await guard(
          runMode(host, language, cell.program, mode, spec),
          () => {
            hung = true;
            return [{ class: 'hung' as const }];
          }
        );
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (hung) {
          host.dispose();
          host = createHost(options.assetBaseUrl, language);
        }
        const health = await checkHealthy();
        results.push({
          language,
          mode,
          kind: cell.kind,
          observations,
          elapsedMs,
          healthyAfter: health.ok,
          ...(health.ok ? {} : { healthyAfterDetail: health.detail }),
        });
        if (!health.ok) {
          host.dispose();
          host = createHost(options.assetBaseUrl, language);
        }
      }
    }
    if (!options.defaultLimitsProbe && (!options.kinds || options.kinds.includes('abort-runaway'))) {
      // An abort must end a runaway run promptly and leave the host usable
      // without the consumer disposing it.
      const loop = matrixCells(language).find((cell) => cell.kind === 'infinite-loop')!;
      for (const mode of options.modes.filter((candidate) =>
        candidate === 'code' || candidate === 'interactive'
      )) {
        const controller = new AbortController();
        const startedAt = performance.now();
        let abortedAt = 0;
        setTimeout(() => {
          abortedAt = performance.now();
          controller.abort(new DOMException('Stopped by the learner', 'AbortError'));
        }, ABORT_AFTER_MS);
        let observation: MatrixObservation;
        try {
          const observations = await guard(
            runMode(host, language, loop.program, mode, {}, controller.signal),
            () => [{ class: 'hung' as const }]
          );
          observation = observations.every((candidate) => candidate.class === 'provider' && /abort/i.test(candidate.message ?? ''))
            ? { class: 'aborted', status: 'host-rejected', message: observations[0]?.message }
            : observations[0]!;
        } catch (error) {
          observation = { class: 'aborted', status: 'host-rejected', message: String(error) };
        }
        const settledMs = Math.round(performance.now() - (abortedAt || startedAt));
        const healthStartedAt = performance.now();
        const health = await checkHealthy();
        results.push({
          language,
          mode,
          kind: 'abort-runaway',
          observations: [{ ...observation, settledAfterAbortMs: settledMs, nextRunMs: Math.round(performance.now() - healthStartedAt) }],
          elapsedMs: Math.round(performance.now() - startedAt),
          healthyAfter: health.ok,
          ...(health.ok ? {} : { healthyAfterDetail: health.detail }),
        });
        if (!health.ok) {
          host.dispose();
          host = createHost(options.assetBaseUrl, language);
        }
      }
    }
  } finally {
    host.dispose();
  }
  return results;
}

// Early enough that no runtime's own runaway guard (Python's trips in about a
// second) ends the run first; an abort during preparation must end it too.
const ABORT_AFTER_MS = 300;
