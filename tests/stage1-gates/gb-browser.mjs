import {
  builtInProjectEvaluators,
  createAlgorithmJudgeBundle,
  createAlgorithmJudgeReceipt,
  createBrowserJudgeHost,
  judgeCaseExecutionOutcome,
  judgeCompileExecutionOutcome,
} from '@tracecode/harness/judge';
import { installJournal } from './gb-transport.mjs';
import { observeDeferred } from './deferred-browser.mjs';
import { installJudgeBridge, schedulerInjection, serviceDeadlineRoute } from './gb-probe.mjs';
import { restoreTransferredTraceEvents } from '../../packages/runtime-browser/src/trace-event-transport.ts';
import { javaTraceHooksEventsToRuntimeTrace } from '../../packages/runtime-contracts/src/trace-adapters/java.ts';

export { builtInProjectEvaluators, createAlgorithmJudgeBundle, createBrowserJudgeHost };
export { resolveBuiltInTraceCCRuntimeManifest } from '@tracecode/harness/tracekernel';

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

function fixtureBundle(fixture, route, rows, trace, traceOptions = fixture.traceOptions) {
  return createAlgorithmJudgeBundle({
    id: [fixture.gate, fixture.language, fixture.name, route].join('-'),
    language: fixture.language,
    code: route === 'timeout-fanout' ? fixture.timeoutCode ?? fixture.code : fixture.code,
    functionName: fixture.functionName,
    executionStyle: fixture.executionStyle,
    trace,
    cases: rows.map(({ id, input, expected }) => ({ id, input: structuredClone(input), expected })),
    ...(fixture.limits ? { limits: fixture.limits } : {}),
    ...(route === 'timeout-fanout' ? { limits: { wallClockMs: 4000 } } : {}),
    traceOptions,
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  });
}

async function observeLongerPrefix(fixture, host, route, rows) {
  try {
    const bundle = await fixtureBundle(fixture, route, rows, true, {
      ...fixture.traceOptions,
      maxTraceSteps: 12,
    });
    const result = await host.execute({ bundle, interactive: true, tracing: { caseIds: [rows[0].id] } });
    if (result.executionId) await host.disposeExecution(result.executionId);
    return { bundleDigest: bundle.workspaceDigest, evaluation: result.evaluation };
  } finally {
    host.dispose();
  }
}

function decodeJavaObservation(payload, maxPathDepth) {
  try {
    const { results: [entry] } = restoreTransferredTraceEvents(payload);
    const { cut, attemptedEvents, reason } = entry.observation;
    if (entry.success === false) return { drawing: { status: 'refused', reason } };
    const javaEvents = entry.trace?.events;
    if (entry.success !== true || !Array.isArray(javaEvents) ||
        !javaEvents.every((event) => typeof event === 'string')) return { drawing: null };
    const trace = javaTraceHooksEventsToRuntimeTrace(javaEvents, entry.sourceText,
      { runId: 'java:run', file: 'solution.java', maxPathDepth });
    return {
      javaEvents,
      drawing: cut === undefined
        ? { status: 'drawn', trace }
        : { status: 'truncated', trace, reason: cut, attemptedEvents },
    };
  } catch {
    return { drawing: null };
  }
}

export async function runDeferredFixture(fixture, scenario) {
  const journal = installJournal(fixture, { decodeJavaObservation });
  const createHost = () => createBrowserJudgeHost({
    assetBaseUrl: '/workers', providers: [fixture.language],
    ...(fixture.language === 'cpp' ? { cpp: { executionTimeoutMs: 20000, tracingTimeoutMs: 20000 } } : {}),
  });
  try {
    const bundle = await fixtureBundle(fixture, `deferred-${scenario.name}`, fixture.cases, true);
    const report = await observeDeferred(bundle, scenario, {
      createHost,
      track: (route) => journal.track(route),
      grade: (bundle, evaluation) => {
        const { policy, verdict, passedCount, totalCount } = createAlgorithmJudgeReceipt(bundle, evaluation);
        return { policy, verdict, passedCount, totalCount };
      },
      project: (receipt) => receipt.evaluation.cases.map((row) => convert(judgeCaseExecutionOutcome, row, {
        language: fixture.language,
      })),
    });
    return { ...report, wire: journal.since(0) };
  } finally {
    journal.restore();
  }
}

export async function runFixture(fixture, options, onReceipt) {
  const journal = installJournal(fixture, { decodeJavaObservation });
  const faultFixture = fixture.name === 'transport';
  const bridge = installJudgeBridge(fixture, journal);
  const schedulerFault = schedulerInjection(fixture.name);
  const createHost = () => createBrowserJudgeHost({
    assetBaseUrl: '/workers',
    providers: [fixture.language],
    ...(fixture.language === 'cpp' ? {
      cpp: { executionTimeoutMs: 20000, tracingTimeoutMs: 20000 },
    } : {}),
  });
  let reusable;
  let retained;
  let executionId;
  let retainedCompile;
  let retainedWorkspaceDigest;
  const retainedEvidence = [];
  let registeredReceiptPath = false;
  let singletonGuard;
  let singletonStderr;
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
        if (mux && typeof globalThis.gbRunMux !== 'function') {
          record = { unavailable: 'The staged pinned mux adapter was unavailable' };
        } else if (faultFixture && route.startsWith('deadline-') && !serviceDeadlineRoute(fixture, route)) {
          record = { unavailable: 'Requires an ordinary commit barrier and a coordinator service-deadline ACK' };
        } else if (continuation && !executionId) {
          record = { unavailable: 'The first Run returned no continuation handle', retainedCompile };
        } else {
          if (!mux) host = continuation ? retained : ownHost ? createHost() : (reusable ??= createHost());
          if (faultFixture || fixture.noInterruptBuffer) {
            await host.warmLanguage(fixture.language);
          }
          const setupMs = performance.now() - start;
          journal.track(route, faultFixture && transportRoutes.has(route) ? route : undefined);
          bridge.track(route);
          if (continuation) {
            const result = await host.execute({ executionId, tracing: { caseIds: [route.at(-1)] } });
            record = {
              result, setupMs, retainedCompile, retainedExecutionId: executionId, retainedWorkspaceDigest,
              retainedEvidence: [...retainedEvidence],
            };
          } else {
            const rows = rowsFor(fixture, route);
            const trace = interactive || route === 'submit-traced';
            const bundle = await fixtureBundle(fixture, route, rows, trace);
            if (interactive) {
              const ids = route === 'run-first' ? [rows[0].id] : route === 'run-all' ? rows.map((row) => row.id) : [];
              record = { setupMs, stimulus: { bundle, interactive: true, caseIds: ids } };
              const result = await host.execute({ bundle, interactive: true, tracing: { caseIds: ids } });
              currentExecutionId = result.executionId;
              record.result = result;
              if (usesRetainedHost) {
                retained = host;
                executionId = result.executionId;
                retainedCompile = result.evaluation.compile;
                retainedWorkspaceDigest = bundle.workspaceDigest;
              }
            } else {
              const stop = route.startsWith('submit-stop') || route.endsWith('-stop');
              const stopFlag = stop ? { stopAtFirstRunaway: true } :
                route === 'submit-keep' || route.endsWith('-keep') ? { stopAtFirstRunaway: false } : {};
              const stimulus = { bundle, ...stopFlag };
              record = { stimulus, setupMs };
              if (mux) {
                record.muxAdapter = await globalThis.gbRunMux(bundle);
                record.result = record.muxAdapter.response.result;
              } else {
                record.result = await host.evaluateAlgorithm(stimulus);
              }
              if (route === 'submit-omitted-B') {
                const row = record.result.evaluation.cases[0];
                if (row?.failure?.origin === 'limit') {
                  singletonGuard = row.failure.reason;
                  singletonStderr = row.stderr;
                }
              }
            }
          }
          if (fixture.name === 'step-cap' && route === 'run-first' &&
              record.result?.evaluation?.cases[0]?.attachment?.status === 'truncated' &&
              journal.since(from).some(({ kind, request }) => kind === 'observer-reply' && request === route)) {
            // Use a separate execution with a larger source-step budget to
            // witness the recorder stream beyond the cutoff. Its work never
            // contributes starts, scheduling evidence, or grades to Run.
            const referenceRoute = `${route}:reference`;
            journal.track(referenceRoute);
            bridge.track(referenceRoute);
            try {
              record.prefixReference = await observeLongerPrefix(fixture, createHost(), referenceRoute, rowsFor(fixture, route));
            } catch (error) {
              record.prefixReference = { rejection: describe(error) };
            } finally {
              journal.track(route);
              bridge.track(route);
            }
          }
          const evaluation = record.result?.evaluation;
          if (evaluation) {
            registeredReceiptPath ||= evaluation.cases.some((row) => typeof row.attachment?.evaluationId === 'string');
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
      const transcript = journal.since(from);
      if (schedulerFault && !transcript.some(({ kind, request }) => kind === 'schedule' && request === route)) {
        record = { unavailable: 'The installed Judge did not emit the trusted schedule journal' };
      }
      if (serviceDeadlineRoute(fixture, route) && !transcript.some(({ kind, phase, request }) =>
        request === route && kind === 'schedule' &&
        (phase?.startsWith('ordinary-case-') || phase === 'service-deadline'))) {
        record = { ...record, unavailable: 'The installed Judge did not emit the D-WATCH progress journal' };
      }
      if ((usesRetainedHost || continuation) && record.result?.evaluation) {
        retainedEvidence.push(...transcript.filter(({ kind, request }) =>
          request === route && (kind === 'schedule' || kind === 'observer-reply' || kind.startsWith('ordinary-'))));
      }
      await onReceipt({
        ...record, route, singletonGuard, singletonStderr, transcript, registeredReceiptPath, durationMs: performance.now() - start,
        crossOriginIsolated: globalThis.crossOriginIsolated,
      });
    }
  } finally {
    try {
      if (executionId) await retained.disposeExecution(executionId);
    } finally {
      retained?.dispose();
      reusable?.dispose();
      bridge.restore();
      journal.restore();
    }
  }
}
