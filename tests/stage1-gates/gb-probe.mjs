const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');

const injections = {
  'observer-compile-fault': { point: 'prepare', fault: 'prepare', reason: 'observer-prepare' },
  'observer-encoder-fault': { point: 'encode', fault: 'encode', reason: 'observer-encode' },
  'observer-deadline': { point: 'observe', fault: 'deadline', reason: 'observer-timeout' },
};

export function schedulerInjection(name) {
  return Object.hasOwn(injections, name) ? injections[name] : undefined;
}

export function installJudgeBridge(fixture, journal) {
  const injection = schedulerInjection(fixture.name);
  let armed = false;
  Object.defineProperty(globalThis, bridgeKey, {
    configurable: true,
    value: {
      onEvent(event) {
        journal.record('schedule', event);
      },
      faultAt({ point, language, caseId }) {
        if (armed && language === fixture.language && point === injection.point &&
            (point === 'prepare' || caseId === 'A')) return injection.fault;
      },
    },
  });
  return {
    track(route) {
      armed = !!injection && route === 'run-first';
    },
    restore() {
      delete globalThis[bridgeKey];
    },
  };
}
