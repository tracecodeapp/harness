const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
const faults = [
  { point: 'prepare', fault: 'prepare', reason: 'observer-prepare' },
  { point: 'observe', fault: 'runtime', reason: 'observer-runtime' },
  { point: 'observe', fault: 'deadline', reason: 'observer-timeout' },
  { point: 'encode', fault: 'encode', reason: 'observer-encode' },
];

export function deferredScenarios(language) {
  const injections = language === 'javascript' ? [
    ...faults, { point: 'observe', fault: 'no-recorder', reason: 'recorder-unavailable' },
  ] : faults;
  return [
    { name: 'stdout' },
    { name: 'step-cap', cut: 'step-budget' },
    { name: 'byte-cap', cut: 'byte-budget' },
    { name: 'disposed', dispose: true },
    { name: 'stopped-suffix', suffix: true },
    ...injections.map((fault) => ({ name: fault.reason, fault })),
  ];
}

export async function observeDeferred(bundle, scenario, {
  createHost, project, grade, track = () => {},
}) {
  const caseId = scenario.suffix ? bundle.plan.cases.at(-1).id : bundle.plan.cases[0].id;
  const held = Promise.withResolvers();
  const acknowledged = Promise.withResolvers();
  const events = [];
  const report = { caseId, workspaceDigest: bundle.workspaceDigest, initial: [], continuation: [] };
  const previous = Object.getOwnPropertyDescriptor(globalThis, bridgeKey);
  const injection = scenario.fault ?? (scenario.suffix ? undefined : { point: 'observe', fault: 'stall' });
  let split;
  let host;
  let executionId;
  try {
    if (!scenario.fault && !scenario.dispose) {
      track('joined-reference');
      host = createHost();
      const joined = await host.execute({
        bundle, interactive: true, tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(90_000),
      });
      executionId = joined.executionId;
      report.joined = joined;
      report.joinedGrade = grade(bundle, joined.evaluation);
      if (executionId) await host.disposeExecution(executionId);
      host.dispose();
      executionId = undefined;
    }
    Object.defineProperty(globalThis, bridgeKey, {
      configurable: true,
      value: {
        onEvent(event) {
          events.push({ ...event, sequence: events.length });
          if (event.phase === 'injection-ack' && event.fault === 'stall' && event.caseId === caseId) {
            acknowledged.resolve();
          }
        },
        faultAt({ point, caseId: candidate }) {
          if (point === injection?.point && (point === 'prepare' || candidate === caseId)) return injection.fault;
        },
        releaseStall: () => held.promise,
      },
    });
    track('run-first-deferred');
    host = createHost();
    const verdict = await host.execute({
      bundle, interactive: true, drawingDelivery: 'after-verdict',
      tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(90_000),
    });
    executionId = verdict.executionId;
    split = events.length;
    report.verdict = structuredClone(verdict);
    report.verdictGrade = grade(bundle, verdict.evaluation);

    if (scenario.dispose) {
      await stallAck(acknowledged.promise);
      await host.disposeExecution(executionId);
      held.resolve();
    }
    track('draw-first-deferred');
    const continuation = host.execute({
      executionId, tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(90_000),
    }).then(
      (draw) => ({ draw }),
      (error) => ({ rejection: { name: error.name, message: error.message } }),
    );
    if (injection?.fault === 'stall' && !scenario.dispose) await stallAck(acknowledged.promise);
    held.resolve();
    Object.assign(report, await continuation);
    if (report.draw) report.presentation = project?.(report.draw, caseId);
    report.verdictAfterDraw = verdict;
  } catch (error) {
    report.error = { name: error.name, message: error.message };
  } finally {
    held.resolve();
    try {
      if (executionId && !scenario.dispose) await host.disposeExecution(executionId);
    } finally {
      host?.dispose();
      if (previous) Object.defineProperty(globalThis, bridgeKey, previous);
      else delete globalThis[bridgeKey];
    }
  }
  report.initial = events.slice(0, split ?? events.length);
  report.continuation = split === undefined ? [] : events.slice(split);
  return report;
}

async function stallAck(acknowledged) {
  let timer;
  try {
    await Promise.race([acknowledged, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Observer did not acknowledge stall')), 45_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
