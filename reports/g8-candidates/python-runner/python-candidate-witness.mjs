const WITNESS_ERROR = 'Python worker, batch or observer witness differs';

function phases(result) {
  const journal = result?.python?.phases ?? result?.workerJournal ?? result;
  if (!Array.isArray(journal)) return [];
  return journal.filter(({ phase }) => phase === undefined || phase === 'send');
}

function workerSet(items) {
  return new Set(items.map(({ worker }) => worker));
}

function isSingleWorker(items) {
  const workers = workerSet(items);
  return workers.size === 1 && [...workers].every((worker) =>
    Number.isSafeInteger(worker) && worker > 0);
}

function cacheEntry({ type, worker, timings }) {
  return {
    type,
    worker,
    compileCacheHit: timings?.compileCacheHit,
    artifactCacheHit: timings?.artifactCacheHit,
  };
}

export function pythonCandidateCacheReceipt(result) {
  const reported = phases(result).filter(({ role, type }) =>
    ['ordinary', 'observer'].includes(role) &&
    ['prepare-program', 'execute-prepared-program', 'execute-prepared-program-batch'].includes(type));
  return Object.fromEntries(['ordinary', 'observer'].map((role) => [
    role,
    reported.filter((phase) => phase.role === role).map(cacheEntry),
  ]));
}

export function pythonCandidateRequiresStopping(role) {
  if (!['run', 'submit', 'click'].includes(role)) throw new Error('Unknown Python role: ' + role);
  // Run's algorithm-fast batch is the #77 stopping path. Submit evaluates the
  // full batch and does not carry stopAtFirstRunaway in the product journal.
  return role === 'run';
}

export function pythonCandidateOutcome(result, role, caseCount, requireStopping) {
  const journal = phases(result);
  const ordinaryPrepares = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'prepare-program');
  const ordinaryBatches = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'execute-prepared-program-batch');
  const ordinarySingles = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'execute-prepared-program');
  const observerPrepares = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'observer' && type === 'prepare-program');
  const observerExecutions = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'observer' && type === 'execute-prepared-program');
  const expectedOrdinary = role === 'click' ? 0 : 1;
  const expectedObserver = role === 'submit' ? 0 : 1;
  const expectedObserverPrepares = role === 'run' ? 1 : 0;
  const ordinary = [...ordinaryPrepares, ...ordinaryBatches];
  const ordinaryValid = expectedOrdinary === 0
    ? ordinary.length === 0 && ordinarySingles.length === 0
    : ordinaryPrepares.length === 1 && ordinaryPrepares[0].mode === 'code' &&
      ordinaryBatches.length === 1 && ordinarySingles.length === 0 &&
      isSingleWorker(ordinary) && ordinaryBatches[0].mode === 'code' &&
      ordinaryBatches[0].cases === caseCount && ordinaryBatches[0].tier === 'algorithm-fast' &&
      (!requireStopping || ordinaryBatches[0].stopAtFirstRunaway === true);
  const observerValid = observerPrepares.length === expectedObserverPrepares &&
    observerPrepares.every(({ mode, observation }) => mode === 'trace' && observation === true) &&
    observerExecutions.length === expectedObserver &&
    (expectedObserver === 0 || isSingleWorker([...observerPrepares, ...observerExecutions])) &&
    observerExecutions.every(({ mode, observation }) => mode === 'trace' && observation === true);
  const ordinaryWorkers = workerSet(ordinary);
  const observerWorkers = workerSet([...observerPrepares, ...observerExecutions]);
  const distinct = !ordinaryWorkers.size || !observerWorkers.size ||
    [...ordinaryWorkers].every((worker) => !observerWorkers.has(worker));
  const expectedTypes = new Set([
    'prepare-program',
    'execute-prepared-program',
    'execute-prepared-program-batch',
  ]);
  const unknownRolePhase = journal.some(({ role: phaseRole, type }) =>
    ['ordinary', 'observer'].includes(phaseRole) && !expectedTypes.has(type));

  if (!ordinaryValid || !observerValid || !distinct || unknownRolePhase) return WITNESS_ERROR;
}
