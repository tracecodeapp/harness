const WITNESS_ERROR = 'Published Java single-worker witness differs';

function workerSet(phases) {
  return new Set(phases.map(({ worker }) => worker));
}

export function javaProductionControlOutcome(result, role, caseCount, caseId) {
  const phases = result?.java?.phases ?? [];
  const prepares = phases.filter(({ type }) => type === 'prepare-runtime-program');
  const batches = phases.filter(({ type }) => type === 'execute-prepared-runtime-program-batch');
  const singles = phases.filter(({ type }) => type === 'execute-prepared-runtime-program');
  const restores = phases.filter(({ type }) => type === 'restore-prepared-runtime-program');
  const workers = workerSet([...prepares, ...batches, ...singles, ...restores]);
  const expectedPrepares = role === 'click' ? 0 : 1;
  const batch = batches[0];
  const valid = prepares.length === expectedPrepares && batches.length === 1 &&
    singles.length === 0 && restores.length === 0 && workers.size === 1 &&
    [...workers].every((worker) => Number.isSafeInteger(worker) && worker > 0) &&
    batch.cases === caseCount && batch.tier === 'algorithm-fast' &&
    batch.timings?.runnerProcessCount === 1;
  if (!valid) return WITNESS_ERROR;

  const selected = result.evaluation?.cases.find(({ id }) => caseId === id);
  if (caseId && (!selected?.learnerLine || !['drawn', 'truncated'].includes(selected?.attachment?.status))) {
    return 'No certified published Java learner drawing';
  }
  if (result.evaluation?.cases.some(({ legacyRefusalFields }) => legacyRefusalFields.length)) {
    return 'A legacy refusal field is present on a published Java result';
  }
}
