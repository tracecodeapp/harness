const WITNESS_ERROR = 'C# assembly, reset or observer witness differs';

function phases(result) {
  return result?.csharp?.phases ?? [];
}

function workerSet(items) {
  return new Set(items.map(({ worker }) => worker));
}

function isSingleWorker(items) {
  const workers = workerSet(items);
  return workers.size === 1 && [...workers].every((worker) =>
    Number.isSafeInteger(worker) && worker > 0);
}

function hasCacheFlag(phase) {
  return phase.timings?.compileCacheHit !== undefined ||
    phase.timings?.artifactCacheHit !== undefined;
}

function cacheEntry({ type, worker, timings }) {
  return {
    type,
    worker,
    compileCacheHit: timings?.compileCacheHit,
    artifactCacheHit: timings?.artifactCacheHit,
  };
}

export function csharpCandidateCacheReceipt(result) {
  const reported = phases(result).filter(({ role, type, timings }) =>
    ['ordinary', 'observer'].includes(role) &&
    ['prepare-program', 'execute-prepared-code', 'execute-prepared-trace'].includes(type) &&
    (type === 'prepare-program' || hasCacheFlag({ timings })));
  return Object.fromEntries(['ordinary', 'observer'].map((role) => [
    role,
    reported.filter((phase) => phase.role === role).map(cacheEntry),
  ]));
}

export function csharpCandidateOutcome(result, role, caseCount, caseId) {
  const journal = phases(result);
  const ordinaryPrepares = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'prepare-program');
  const ordinaryExecutions = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'execute-prepared-code');
  const observerPrepares = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'observer' && type === 'prepare-program');
  const observerExecutions = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'observer' && type === 'execute-prepared-trace');
  const ordinaryDisposals = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'ordinary' && type === 'dispose-prepared-program');
  const observerDisposals = journal.filter(({ role: phaseRole, type }) =>
    phaseRole === 'observer' && type === 'dispose-prepared-program');
  const expectedOrdinary = role === 'click' ? 0 : caseCount;
  const expectedObserver = role === 'submit' ? 0 : 1;
  const expectedObserverPrepares = role === 'run' ? 1 : 0;
  const ordinaryKey = ordinaryPrepares[0]?.artifactKey;

  const ordinaryValid = expectedOrdinary === 0
    ? ordinaryPrepares.length === 0 && ordinaryExecutions.length === 0
    : ordinaryPrepares.length === 1 && ordinaryPrepares[0].mode === 'code' &&
      typeof ordinaryKey === 'string' && ordinaryKey.length > 0 &&
      ordinaryExecutions.length === expectedOrdinary && isSingleWorker(ordinaryExecutions) &&
      ordinaryExecutions.every((phase) =>
        phase.workerKind === 'runner' && phase.artifactKey === ordinaryKey &&
        phase.tier === 'algorithm-fast' &&
        phase.timings?.executionRealm === 'retained-worker-collectible-context' &&
        phase.timings?.compileCacheHit === true && phase.timings?.artifactCacheHit === true) &&
      ordinaryDisposals.length <= 1 &&
      ordinaryDisposals.every(({ artifactKey }) => artifactKey === ordinaryKey);
  const observerKey = observerPrepares[0]?.artifactKey;
  const observerValid = observerPrepares.length === expectedObserverPrepares &&
    observerPrepares.every(({ mode, artifactKey }) =>
      mode === 'trace' && typeof artifactKey === 'string' && artifactKey.length > 0) &&
    observerExecutions.length === expectedObserver &&
    (expectedObserver === 0 || isSingleWorker(observerExecutions)) &&
    observerExecutions.every((phase) =>
      phase.workerKind === 'runner' && phase.observation === true &&
      phase.tier === 'algorithm-fast' &&
      phase.timings?.executionRealm === 'retained-worker-collectible-context') &&
    observerDisposals.length <= 1 &&
    observerDisposals.every(({ artifactKey }) => artifactKey === observerKey);
  const ordinaryWorkers = workerSet(ordinaryExecutions);
  const observerWorkers = workerSet(observerExecutions);
  const distinct = !ordinaryWorkers.size || !observerWorkers.size ||
    [...ordinaryWorkers].every((worker) => !observerWorkers.has(worker));
  const expectedTypes = new Set([
    'prepare-program',
    'execute-prepared-code',
    'execute-prepared-trace',
    'dispose-prepared-program',
  ]);
  const unknownRolePhase = journal.some(({ role: phaseRole, type }) =>
    ['ordinary', 'observer'].includes(phaseRole) && !expectedTypes.has(type));

  if (!ordinaryValid || !observerValid || !distinct || unknownRolePhase) {
    return WITNESS_ERROR;
  }
  const selected = result.evaluation?.cases.find(({ id }) => caseId === id);
  if (caseId && (!selected?.learnerLine || !['drawn', 'truncated'].includes(selected?.attachment?.status))) {
    return 'No certified C# learner drawing';
  }
  if (result.evaluation?.cases.some(({ legacyRefusalFields }) => legacyRefusalFields.length)) {
    return 'A legacy refusal field is present on a C# result';
  }
}
