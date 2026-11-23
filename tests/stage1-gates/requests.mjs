export function requestMatrix(cases, { gate, language, untracedOnly = false, playgroundScript = false } = {}) {
  if (playgroundScript) {
    const submits = [
      {
        id: 'execute-traced', mode: 'submit', cases, selected: cases,
        functionName: null, trace: true,
      },
      {
        id: 'execute-untraced', mode: 'submit', cases, selected: [],
        functionName: '', trace: false, limits: { wallClockMs: 60000 },
      },
    ];
    if (language !== 'python') return submits;
    return [...submits, ...submits.map((request) => ({
      ...request, id: `host-${request.id}`, mode: 'execute',
    }))];
  }
  const second = cases.slice(1, 2);
  const requests = [
    { id: 'run-first', mode: 'initial', cases, selected: cases.slice(0, 1) },
    ...(second.length ? ['draw-b', 'redraw-b'].map((id) => ({ id, mode: 'continuation', cases: second, selected: second })) : []),
    { id: 'run-all', mode: 'initial', cases, selected: cases },
    { id: 'run-none', mode: 'initial', cases, selected: [] },
    ...[false, true].flatMap((stop) => [cases, ...(cases.length === 1 ? [] : cases.map((id) => [id]))].map((subset) => ({
      id: `submit-${stop ? 'stop' : 'default'}-${subset.join('')}`, mode: 'submit', cases: subset, selected: [], ...(stop ? { stop: true } : {}),
    }))),
    { id: 'submit-traced', mode: 'submit', cases, selected: cases },
  ];
  if (gate === 'G1') {
    for (const id of cases) {
      requests.push(
        { id: `execute-code-${id}`, mode: 'execute', cases: [id], selected: [] },
        { id: `execute-traced-${id}`, mode: 'execute', cases: [id], selected: [id] },
      );
    }
  }
  return untracedOnly ? requests.filter((request) => request.mode === 'submit' && request.selected.length === 0) : requests;
}

export const appSpec = Object.freeze([
  { name: 'blast-radius-analysis', stage: 2, candidateFile: 'wave-1', cases: ['s1'] },
  { name: 'search-autocomplete', stage: 1, candidateFile: 'wave-1-batch-two', cases: [
    's1', 's2', 's3', 's4', 's5', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'p1', 'p2',
  ] },
]);

export function appFixtureName({ name, stage }) {
  return `app-${name}-stage-${stage}`;
}

export function muxRequests(fixture) {
  if (fixture.playgroundScript || fixture.mux === false) return [];
  const cases = fixture.cases.map(({ id }) => id);
  const requests = [{ id: 'algorithm', route: 'mux', mode: 'submit', selected: [], cases }];
  if (fixture.name !== 'queens') {
    requests.push({ id: 'legacy-run', route: 'mux', mode: 'submit', selected: [], cases });
    if (!fixture.untracedOnly) requests.push({ id: 'legacy-trace', route: 'mux', mode: 'submit', selected: cases, cases });
  }
  return requests;
}

export function appFixtureAssertionIds(fixture) {
  const requests = [...requestMatrix(fixture.cases.map(({ id }) => id), fixture), ...muxRequests(fixture)];
  return requests.flatMap((request) => {
    const checks = ['order', 'compile', 'compile-footprint', 'correlation'];
    if (request.mode === 'submit') checks.push('aggregate');
    if (request.id.startsWith('legacy-')) checks.push('legacy-projection');
    if (!request.route) checks.push('worker-ack');
    const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/${request.route ?? 'default'}/${request.id}`;
    return [
      ...checks.map((check) => `${prefix}/@request/${check}`),
      ...request.cases.flatMap((id) =>
        ['identity', 'status', 'value', 'console', 'failure', 'verdict', 'termination', 'diagnostics']
          .map((check) => `${prefix}/${id}/${check}`)),
    ];
  });
}

export function jsRouteRequests(fixture) {
  if (!['javascript', 'typescript'].includes(fixture.language)) return [];
  if (!['stdout', 'ses-constructor-key', 'print-then-throw'].includes(fixture.name)) return [];
  return ['ses-compartment-pool', 'disposable-worker'].map((route) => ({
    route, requests: requestMatrix(fixture.cases.map(({ id }) => id), fixture).map((request) => ({ ...request, route })),
  }));
}

export function cppDirectRoutes(fixture) {
  if (fixture.language !== 'cpp' || !/^(end-character|cpp-delete-|cpp-value-|print-then-throw)/.test(fixture.name)) return [];
  return ['ordinary-single', 'generated-batch'];
}
