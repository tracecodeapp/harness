import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '@tracecode/harness/judge';
import { installJournal } from './gb-transport.mjs';

const transportRoutes = new Set([
  'cut-keep', 'cut-stop', 'during-keep', 'during-stop',
  'timeout-fanout', 'clock-virtual', 'clock-real',
]);

export function rowsFor(fixture, route) {
  const selected = /-(?:A|B|C)$/u.test(route) ? route.at(-1) : undefined;
  return selected ? fixture.cases.filter((row) => row.id === selected) : fixture.cases;
}

function describe(error) {
  return { name: error?.name, message: String(error?.message ?? error), cause: error?.cause, reason: error?.reason, code: error?.code };
}

function convert(conversion, row, options) {
  try {
    return conversion(row, options);
  } catch (error) {
    return { rejected: describe(error) };
  }
}

export async function runFixture(fixture, options, onReceipt) {
  const journal = installJournal(fixture);
  const faultFixture = fixture.name === 'transport';
  const observerFault = ['no-recorder', 'observer-compile-fault', 'observer-encoder-fault'].includes(fixture.name);
  const createHost = (mux) => createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers: [fixture.language],
    ...(mux ? { safeExecution: { workerLifecycle: 'warm-and-retire' } } : {}),
    ...(fixture.language === 'cpp' ? {
      cpp: { executionTimeoutMs: 20000, tracingTimeoutMs: 20000 },
    } : {}),
  });
  let reusable;
  let retained;
  let executionId;
  let retainedCompile;
  let singletonGuard;
  try {
    for (const route of fixture.routes) {
      if (options.routes && !options.routes.includes(route)) continue;
      const start = performance.now();
      const continuation = route.startsWith('continue-') || route.startsWith('repeat-');
      const interactive = route.startsWith('run-');
      const mux = route === 'mux-shape';
      const usesRetainedHost = route === 'run-first' && fixture.routes.some((value) => value.startsWith('continue-'));
      const ownHost = interactive || mux || faultFixture;
      const from = journal.size();
      let host;
      let currentExecutionId;
      let record;
      try {
        if (observerFault || route.startsWith('deadline-') || (fixture.language === 'java' && (route.endsWith('-stop') || route.startsWith('during-')) && faultFixture)) {
          record = { unavailable: 'Required producer or coordinator barrier is absent on the frozen candidate' };
        } else if (continuation && !executionId) {
          record = { unavailable: 'The first Run returned no continuation handle', retainedCompile };
        } else {
          host = continuation ? retained : ownHost ? createHost(mux) : (reusable ??= createHost(false));
          if (mux || faultFixture || fixture.noInterruptBuffer) {
            await host.warmLanguage(fixture.language);
          }
          const setupMs = performance.now() - start;
          journal.track(route, faultFixture && transportRoutes.has(route) ? route : undefined);
          if (continuation) {
            const result = await host.execute({ executionId, tracing: { caseIds: [route.at(-1)] } });
            record = { result, setupMs, retainedCompile, retainedExecutionId: executionId };
          } else {
            const rows = rowsFor(fixture, route);
            const trace = interactive || route === 'submit-traced';
            const bundle = await createAlgorithmJudgeBundle({
              id: [fixture.gate, fixture.language, fixture.name, route].join('-'),
              language: fixture.language,
              code: fixture.code,
              functionName: fixture.functionName,
              executionStyle: fixture.executionStyle,
              trace,
              cases: rows.map(({ id, input, expected }) => ({ id, input: structuredClone(input), expected })),
              ...(fixture.limits ? { limits: fixture.limits } : {}),
              ...(route === 'timeout-fanout' ? { limits: { wallClockMs: 4000 } } : {}),
              traceOptions: fixture.traceOptions,
              comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
            });
            if (interactive) {
              const ids = route === 'run-first' ? [rows[0].id] : route === 'run-all' ? rows.map((row) => row.id) : [];
              const result = await host.execute({ bundle, interactive: true, tracing: { caseIds: ids } });
              currentExecutionId = result.executionId;
              record = { result, setupMs, stimulus: { bundle, interactive: true, caseIds: ids } };
              if (usesRetainedHost) {
                retained = host;
                executionId = result.executionId;
                retainedCompile = result.evaluation.compile;
              }
            } else {
              const stop = route.startsWith('submit-stop') || route.endsWith('-stop');
              const stopFlag = stop ? { stopAtFirstRunaway: true } :
                route === 'submit-keep' || route.endsWith('-keep') ? { stopAtFirstRunaway: false } : {};
              const stimulus = { bundle, ...stopFlag };
              record = { stimulus, setupMs };
              record.result = await host.evaluateAlgorithm(stimulus);
            if (route === 'submit-omitted-B') {
              const row = record.result.evaluation.cases[0];
              if (row?.failure?.origin === 'limit') singletonGuard = row.failure.reason;
            }
            }
          }
          const evaluation = record.result?.evaluation;
          if (evaluation) {
            const conversionOptions = { language: fixture.language };
            record.conversions = {
              compile: evaluation.compile ? convert(judgeCompileExecutionOutcome, evaluation.compile, conversionOptions) : undefined,
              cases: evaluation.cases.map((row) => convert(judgeCaseExecutionOutcome, row, conversionOptions)),
            };
          }
        }
      } catch (error) {
        record = { ...record, rejection: describe(error) };
      } finally {
        if (ownHost && host && host !== retained) {
          try {
            if (currentExecutionId) await host.disposeExecution(currentExecutionId);
          } finally {
            host.dispose();
          }
        }
      }
      await onReceipt({
        ...record, route, singletonGuard, transcript: journal.since(from), durationMs: performance.now() - start,
        crossOriginIsolated: globalThis.crossOriginIsolated,
      });
    }
  } finally {
    try {
      if (executionId) await retained.disposeExecution(executionId);
    } finally {
      retained?.dispose();
      reusable?.dispose();
      journal.restore();
    }
  }
}
