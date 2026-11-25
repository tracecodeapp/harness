const WITNESS_ERROR = 'Python worker, batch or observer witness differs';

function phases(result) {
  const journal = result?.python?.phases ?? result?.workerJournal ?? result;
  if (!Array.isArray(journal)) return [];
  return journal.filter(({ phase }) => phase === undefined || phase === 'send');
}

function journal(result) {
  const entries = result?.python?.phases ?? result?.workerJournal ?? result;
  return Array.isArray(entries) ? entries : [];
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

function sequentialCommands(result) {
  const entries = journal(result);
  const sends = entries.filter(({ phase }) => phase === undefined || phase === 'send');
  const ordinaryPrepare = sends.filter(({ role, type }) =>
    role === 'ordinary' && type === 'prepare-program');
  const ordinaryBatch = sends.filter(({ role, type }) =>
    role === 'ordinary' && type === 'execute-prepared-program-batch');
  const ordinarySingles = sends.filter(({ role, type }) =>
    role === 'ordinary' && type === 'execute-prepared-program');
  const observerPrepare = sends.filter(({ role, type }) =>
    role === 'observer' && type === 'prepare-program');
  const observerExecute = sends.filter(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-program');
  return { entries, sends, ordinaryPrepare, ordinaryBatch, ordinarySingles,
    observerPrepare, observerExecute };
}

export function pythonSequentialCandidateReceipt(result) {
  const { entries, ordinaryPrepare, ordinaryBatch, observerPrepare, observerExecute } =
    sequentialCommands(result);
  const batch = ordinaryBatch[0];
  const prepare = observerPrepare[0];
  const execute = observerExecute[0];
  const finished = batch ? entries.filter(({ id, phase }) =>
    id === batch.id && phase === 'finished') : [];
  return {
    verdictWorker: batch?.worker,
    observerPrepareWorker: prepare?.worker,
    observerExecuteWorker: execute?.worker,
    ordinaryPrepareWorker: ordinaryPrepare[0]?.worker,
    finishedCases: finished.length,
    lastCaseFinishedAt: finished.length ? Math.max(...finished.map(({ at }) => at)) : undefined,
    ordinaryReplyAt: batch?.receivedAt,
    observerPrepareSentAt: prepare?.at,
    observerPrepareReplyAt: prepare?.receivedAt,
    observerExecuteSentAt: execute?.at,
    observerExecuteReplyAt: execute?.receivedAt,
  };
}

// F2 deliberately hands the verdict's algorithm-fast worker to the observer.
// The observer prepare is posted after the last case-finished progress receipt
// and may therefore be queued before the terminal batch reply. Observation may
// execute only after both that prepare and the verdict batch acknowledge.
export function pythonSequentialCandidateOutcome(result, caseCount) {
  const { sends, ordinaryPrepare, ordinaryBatch, ordinarySingles,
    observerPrepare, observerExecute } = sequentialCommands(result);
  const expectedTypes = new Set([
    'prepare-program',
    'execute-prepared-program',
    'execute-prepared-program-batch',
  ]);
  const unknownRolePhase = sends.some(({ role, type }) =>
    ['ordinary', 'observer'].includes(role) && !expectedTypes.has(type));
  if (ordinaryPrepare.length !== 1 || ordinaryBatch.length !== 1 ||
      ordinarySingles.length !== 0 || observerPrepare.length !== 1 ||
      observerExecute.length !== 1 || unknownRolePhase) return WITNESS_ERROR;

  const ordinary = ordinaryBatch[0];
  const observationPrepare = observerPrepare[0];
  const observationExecute = observerExecute[0];
  const receipt = pythonSequentialCandidateReceipt(result);
  const allWorkers = [ordinaryPrepare[0], ordinary, observationPrepare, observationExecute]
    .map(({ worker }) => worker);
  const onePositiveWorker = new Set(allWorkers).size === 1 &&
    allWorkers.every((worker) => Number.isSafeInteger(worker) && worker > 0);
  const ordinaryValid = ordinaryPrepare[0].mode === 'code' && ordinary.mode === 'code' &&
    ordinary.cases === caseCount && ordinary.tier === 'algorithm-fast' &&
    ordinary.stopAtFirstRunaway === true && Number.isFinite(ordinary.receivedAt);
  const observerValid = observationPrepare.mode === 'trace' &&
    observationPrepare.observation === true && observationExecute.mode === 'trace' &&
    observationExecute.observation === true && Number.isFinite(observationPrepare.receivedAt) &&
    Number.isFinite(observationExecute.receivedAt);
  const handoffValid = receipt.finishedCases === caseCount &&
    Number.isFinite(receipt.lastCaseFinishedAt) &&
    receipt.observerPrepareSentAt >= receipt.lastCaseFinishedAt &&
    receipt.observerPrepareSentAt <= receipt.ordinaryReplyAt &&
    receipt.observerExecuteSentAt >= receipt.ordinaryReplyAt &&
    receipt.observerExecuteSentAt >= receipt.observerPrepareReplyAt;
  if (!onePositiveWorker || !ordinaryValid || !observerValid || !handoffValid) {
    return WITNESS_ERROR;
  }
}

export function pythonSequentialClickOutcome(result, expectedWorker) {
  const ordinaryOutcome = pythonCandidateOutcome(result, 'click', 1, false);
  if (ordinaryOutcome) return ordinaryOutcome;
  const executions = phases(result).filter(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-program');
  if (!Number.isSafeInteger(expectedWorker) || expectedWorker <= 0 ||
      executions.length !== 1 || executions[0].worker !== expectedWorker) {
    return WITNESS_ERROR;
  }
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
