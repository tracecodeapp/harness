const WITNESS_ERROR = 'Published Python single-worker witness differs';

function phases(result) {
  const journal = result?.workerJournal ?? result;
  return Array.isArray(journal)
    ? journal.filter(({ phase }) => phase === undefined || phase === 'send')
    : [];
}

export function pythonProductionControlOutcome(result, role, caseCount) {
  const journal = phases(result);
  const legacy = journal.filter(({ role: phaseRole }) => phaseRole === 'legacy-trace');
  if (legacy.length > 0) {
    const prepares = legacy.filter(({ type }) => type === 'prepare-program');
    const batches = legacy.filter(({ type }) => type === 'execute-prepared-program-batch');
    const singles = legacy.filter(({ type }) => type === 'execute-prepared-program');
    const used = [...prepares, ...batches, ...singles];
    const workers = new Set(used.map(({ worker }) => worker));
    const expected = role === 'run'
      ? prepares.length === 1 && batches.length === 1 && singles.length === 0 &&
        batches[0].cases === caseCount && batches[0].tier === 'algorithm-fast'
      : role === 'click'
        ? prepares.length === 0 && batches.length === 0 && singles.length === 1 &&
          singles[0].tier === 'algorithm-fast'
        : false;
    const complete = used.every(({ received }) => Number.isFinite(received));
    const onlyLegacyCommands = journal.filter(({ type }) =>
      ['prepare-program', 'execute-prepared-program-batch', 'execute-prepared-program'].includes(type))
      .every(({ role: phaseRole }) => phaseRole === 'legacy-trace');
    if (!expected || !complete || !onlyLegacyCommands || workers.size !== 1 ||
        ![...workers].every((worker) => Number.isSafeInteger(worker) && worker > 0)) {
      return WITNESS_ERROR;
    }
    return;
  }
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
  const used = [...ordinaryPrepares, ...ordinaryBatches, ...ordinarySingles,
    ...observerPrepares, ...observerExecutions];
  const workers = new Set(used.map(({ worker }) => worker));

  const valid = ordinaryPrepares.length === expectedOrdinary &&
    ordinaryBatches.length === expectedOrdinary && ordinarySingles.length === 0 &&
    ordinaryBatches.every(({ cases, tier }) => cases === caseCount && tier === 'algorithm-fast') &&
    observerPrepares.length === expectedObserverPrepares &&
    observerExecutions.length === expectedObserver &&
    observerPrepares.every(({ mode, observation }) => mode === 'trace' && observation === true) &&
    observerExecutions.every(({ mode, observation }) => mode === 'trace' && observation === true) &&
    workers.size === 1 && [...workers].every((worker) => Number.isSafeInteger(worker) && worker > 0);
  if (!valid) return WITNESS_ERROR;
}
