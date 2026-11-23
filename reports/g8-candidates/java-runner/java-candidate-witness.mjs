const WITNESS_ERROR = 'Java role, batch or worker-reuse witness differs';

function workers(phases, role) {
  return new Set(phases.filter((phase) => phase.role === role).map((phase) => phase.worker));
}

function isSingleWorker(workerSet) {
  return workerSet.size === 1 && [...workerSet].every((worker) =>
    Number.isSafeInteger(worker) && worker > 0);
}

function isStoppingBatch(batch, caseCount) {
  return batch.cases === caseCount &&
    batch.tier === 'algorithm-fast' &&
    batch.timings?.runnerProcessCount === 1;
}

export function javaCandidateCacheReceipt(result) {
  const prepares = (result?.java?.phases ?? [])
    .filter(({ type }) => type === 'prepare-runtime-program')
    .map(({ role, worker, timings }) => ({
      role,
      worker,
      compileCacheHit: timings?.compileCacheHit,
      artifactCacheHit: timings?.artifactCacheHit,
    }));
  return Object.fromEntries(['ordinary', 'observer'].map((role) => [
    role,
    prepares.filter((prepare) => prepare.role === role),
  ]));
}

export function javaCandidateOutcome(result, role, caseCount, caseId) {
  const phases = result.java?.phases ?? [];
  const batches = phases.filter(({ type }) => type === 'execute-prepared-runtime-program-batch');
  const expectedOrdinary = role === 'click' ? 0 : 1;
  const expectedObserver = role === 'submit' ? 0 : 1;
  const ordinary = batches.filter((phase) => phase.role === 'ordinary');
  const observer = batches.filter((phase) => phase.role === 'observer');
  const ordinaryWorkers = workers(phases, 'ordinary');
  const observerWorkers = workers(phases, 'observer');
  const ordinaryRestores = phases.filter(({ type, role: phaseRole }) =>
    type === 'restore-prepared-runtime-program' && phaseRole === 'ordinary');

  const ordinaryValid = expectedOrdinary === 0
    ? ordinary.length === 0 && ordinaryWorkers.size === 0
    : ordinary.length === 1 && isSingleWorker(ordinaryWorkers) &&
      isStoppingBatch(ordinary[0], caseCount) && ordinaryRestores.length === 0;
  const observerValid = expectedObserver === 0
    ? observer.length === 0 && observerWorkers.size === 0
    : observer.length === 1 && isSingleWorker(observerWorkers) && observer[0].cases === 1;
  const workersDistinct = !ordinaryWorkers.size || !observerWorkers.size ||
    [...ordinaryWorkers].every((worker) => !observerWorkers.has(worker));

  if (!ordinaryValid || !observerValid || !workersDistinct ||
      batches.length !== expectedOrdinary + expectedObserver) return WITNESS_ERROR;
  if (role === 'click' && phases.some(({ type }) => type === 'prepare-runtime-program')) {
    return 'Java click prepared another artifact';
  }
  const selected = result.evaluation?.cases.find(({ id }) => caseId === id);
  if (caseId && (!selected?.learnerLine || !['drawn', 'truncated'].includes(selected?.attachment?.status))) {
    return 'No certified Java learner drawing';
  }
  if (result.evaluation?.cases.some(({ legacyRefusalFields }) => legacyRefusalFields.length)) {
    return 'A legacy refusal field is present on a Java result';
  }
}
