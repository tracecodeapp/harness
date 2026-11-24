const EXECUTION_TYPES = new Set([
  'execute-code',
  'execute-code-batch',
  'execute-with-tracing',
  'execute-prepared-code',
  'execute-prepared-trace',
]);

export function isTrustedCsharpPrime(phase, trustedArtifactKey) {
  return typeof trustedArtifactKey === 'string' && trustedArtifactKey.length > 0 &&
    phase.type === 'execute-prepared-code' && phase.tier === 'compatibility' &&
    phase.artifactKey === trustedArtifactKey;
}

function isPromotedOrdinaryWorker(phases, workerPhases, trustedPrime, options) {
  const caseCount = options?.caseCount;
  if (!Number.isSafeInteger(caseCount) || caseCount < 1) return false;
  const executionType = options?.promotedExecutionType ?? 'execute-prepared-trace';
  const prepareRole = options?.promotedPrepareRole ?? 'observer';
  const learner = workerPhases.filter((phase) => phase !== trustedPrime &&
    !['init', 'warmup'].includes(phase.type));
  if (learner.length !== caseCount || !learner.every(({ type }) => type === executionType)) {
    return false;
  }
  const learnerKeys = new Set(learner.map(({ artifactKey }) => artifactKey));
  if (learnerKeys.size !== 1) return false;
  const [learnerKey] = learnerKeys;
  const matchingPrepare = phases.filter(({ type, role, workerKind, artifactKey }) =>
    type === 'prepare-program' && role === prepareRole && workerKind === 'compiler' &&
    artifactKey === learnerKey);
  const primeIndex = phases.indexOf(trustedPrime);
  return typeof learnerKey === 'string' && learnerKey.length > 0 &&
    learnerKey !== trustedPrime.artifactKey && matchingPrepare.length === 1 &&
    learner.every((phase) => phase.role === 'ordinary' && phase.workerKind === 'runner' &&
      phase.tier === 'algorithm-fast' && Number.isFinite(phase.received) &&
      phase.timings?.executionRealm === 'retained-worker-collectible-context' &&
      phase.timings?.compileCacheHit === true && phase.timings?.artifactCacheHit === true &&
      phases.indexOf(phase) > primeIndex);
}

// The trusted artifact key is captured from this page's completed, untimed
// provider warmup. A compatibility label alone is never enough. A recognized
// replenishment worker may only initialize, warm and execute that exact trusted
// artifact; any learner command on it invalidates the sample.
export function csharpReplenishmentOutcome(phases, trustedArtifactKey, options) {
  const trustedPrimes = phases.filter((phase) =>
    isTrustedCsharpPrime(phase, trustedArtifactKey));
  if (trustedPrimes.length === 0) {
    return { trustedWorkers: new Set(), promotedOrdinaryWorkers: new Set(), trustedPrimes };
  }
  const recognizedWorkers = new Set(trustedPrimes.map(({ worker }) => worker));
  const trustedWorkers = new Set();
  const promotedOrdinaryWorkers = new Set();
  const validWorkers = [...recognizedWorkers].every((worker) => {
    const workerPhases = phases.filter((phase) => phase.worker === worker);
    const init = workerPhases.filter(({ type }) => type === 'init');
    const warmup = workerPhases.filter(({ type }) => type === 'warmup');
    const primes = workerPhases.filter((phase) => isTrustedCsharpPrime(phase, trustedArtifactKey));
    const otherCommands = workerPhases.filter(({ type }) =>
      !['init', 'warmup'].includes(type)).filter((phase) =>
        !isTrustedCsharpPrime(phase, trustedArtifactKey));
    const sequenceValid = Number.isSafeInteger(worker) && worker > 0 &&
      init.length === 1 && warmup.length === 1 && primes.length === 1 &&
      Number.isFinite(init[0].received) && Number.isFinite(warmup[0].received) &&
      phases.indexOf(init[0]) < phases.indexOf(warmup[0]) &&
      phases.indexOf(warmup[0]) < phases.indexOf(primes[0]);
    if (!sequenceValid) return false;
    if (otherCommands.length === 0) {
      const completedPrime = Number.isFinite(primes[0].received);
      const pendingPrime = options?.allowPendingTrustedPrime === true &&
        !Object.hasOwn(primes[0], 'received') && !Object.hasOwn(primes[0], 'timings');
      if (!completedPrime && !pendingPrime) return false;
      trustedWorkers.add(worker);
      return true;
    }
    if (!Number.isFinite(primes[0].received)) return false;
    if (isPromotedOrdinaryWorker(phases, workerPhases, primes[0], options)) {
      promotedOrdinaryWorkers.add(worker);
      return true;
    }
    return false;
  });
  if (!validWorkers) return { error: 'C# trusted standby replenishment witness differs' };
  const learnerOnTrustedWorker = phases.some((phase) =>
    trustedWorkers.has(phase.worker) && EXECUTION_TYPES.has(phase.type) &&
    !isTrustedCsharpPrime(phase, trustedArtifactKey));
  if (learnerOnTrustedWorker) {
    return { error: 'C# trusted standby worker received a learner command' };
  }
  return { trustedWorkers, promotedOrdinaryWorkers, trustedPrimes };
}

export function csharpTrustedArtifactKey(warmResult) {
  const phases = warmResult?.csharp?.phases ?? [];
  const primes = phases.filter(({ type, tier, artifactKey, received }) =>
    type === 'execute-prepared-code' && tier === 'compatibility' &&
    typeof artifactKey === 'string' && artifactKey.length > 0 && Number.isFinite(received));
  return primes.length === 1 ? primes[0].artifactKey : undefined;
}
