const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');

const injections = {
  'no-recorder': { point: 'observe', fault: 'no-recorder', reason: 'recorder-unavailable' },
  'observer-compile-fault': { point: 'prepare', fault: 'prepare', reason: 'observer-prepare' },
  'observer-encoder-fault': { point: 'encode', fault: 'encode', reason: 'observer-encode' },
  'observer-deadline': { point: 'observe', fault: 'deadline', reason: 'observer-timeout' },
};

export function schedulerInjection(name) {
  return Object.hasOwn(injections, name) ? injections[name] : undefined;
}

export function serviceDeadlineRoute(fixture, route) {
  return fixture.gate === 'G4' && fixture.name === 'transport' &&
    (fixture.language === 'python' || fixture.language === 'java') &&
    (route === 'deadline-keep' || route === 'deadline-stop');
}

export function installJudgeBridge(fixture, journal) {
  const injection = schedulerInjection(fixture.name);
  let armed = false;
  let serviceArmed = false;
  let accepted;
  Object.defineProperty(globalThis, bridgeKey, {
    configurable: true,
    value: {
      onEvent(event) {
        const { sequence: progressSequence, ...fields } = event;
        journal.record('schedule', progressSequence === undefined ? fields : { ...fields, progressSequence });
        if (serviceArmed && event.phase === 'ordinary-case-accepted' && event.caseId === 'A' && event.caseIndex === 0 &&
            (event.language === undefined || event.language === fixture.language) &&
            journal.serviceFinish?.()) accepted = event;
      },
      faultAt(context) {
        const { point, language, caseId } = context;
        const delivery = serviceArmed && point === 'service' && journal.serviceFinish?.();
        if (delivery && accepted && language === fixture.language && context.progress === 'finished' &&
            ['evaluationId', 'workspaceDigest', 'generation', 'caseId', 'caseIndex', 'dispatchGeneration']
              .every((key) => context[key] === accepted[key]) &&
            typeof accepted.evaluationId === 'string' && typeof accepted.workspaceDigest === 'string' &&
            Number.isSafeInteger(accepted.sequence) && accepted.sequence > 0 &&
            Number.isSafeInteger(accepted.dispatchGeneration) && accepted.dispatchGeneration > 0) {
          const { evaluationId, workspaceDigest, generation, caseIndex, dispatchGeneration, progress } = context;
          journal.record('service-deadline-offer', {
            point, language, caseId, evaluationId, workspaceDigest, generation, caseIndex, dispatchGeneration, progress,
            workerGeneration: delivery.generation, commandId: delivery.commandId, acceptedSequence: accepted.sequence,
          });
          serviceArmed = false;
          return 'deadline';
        }
        if (armed && language === fixture.language && point === injection.point &&
            (point === 'prepare' || caseId === 'A')) return injection.fault;
      },
    },
  });
  return {
    track(route) {
      armed = !!injection && route === 'run-first';
      serviceArmed = serviceDeadlineRoute(fixture, route);
      accepted = undefined;
    },
    restore() {
      delete globalThis[bridgeKey];
    },
  };
}
