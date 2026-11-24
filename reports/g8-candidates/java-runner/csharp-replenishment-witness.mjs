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

// The trusted artifact key is captured from this page's completed, untimed
// provider warmup. A compatibility label alone is never enough. A recognized
// replenishment worker may only initialize, warm and execute that exact trusted
// artifact; any learner command on it invalidates the sample.
export function csharpReplenishmentOutcome(phases, trustedArtifactKey) {
  const trustedPrimes = phases.filter((phase) =>
    isTrustedCsharpPrime(phase, trustedArtifactKey));
  if (trustedPrimes.length === 0) return { trustedWorkers: new Set(), trustedPrimes };
  const trustedWorkers = new Set(trustedPrimes.map(({ worker }) => worker));
  const validWorkers = [...trustedWorkers].every((worker) => {
    const workerPhases = phases.filter((phase) => phase.worker === worker);
    const init = workerPhases.filter(({ type }) => type === 'init');
    const warmup = workerPhases.filter(({ type }) => type === 'warmup');
    const primes = workerPhases.filter((phase) => isTrustedCsharpPrime(phase, trustedArtifactKey));
    const forbidden = workerPhases.filter(({ type }) =>
      !['init', 'warmup'].includes(type)).filter((phase) =>
        !isTrustedCsharpPrime(phase, trustedArtifactKey));
    return Number.isSafeInteger(worker) && worker > 0 &&
      init.length === 1 && warmup.length === 1 && primes.length === 1 && forbidden.length === 0 &&
      Number.isFinite(init[0].received) && Number.isFinite(warmup[0].received);
  });
  if (!validWorkers) return { error: 'C# trusted standby replenishment witness differs' };
  const learnerOnTrustedWorker = phases.some((phase) =>
    trustedWorkers.has(phase.worker) && EXECUTION_TYPES.has(phase.type) &&
    !isTrustedCsharpPrime(phase, trustedArtifactKey));
  if (learnerOnTrustedWorker) {
    return { error: 'C# trusted standby worker received a learner command' };
  }
  return { trustedWorkers, trustedPrimes };
}

export function csharpTrustedArtifactKey(warmResult) {
  const phases = warmResult?.csharp?.phases ?? [];
  const primes = phases.filter(({ type, tier, artifactKey, received }) =>
    type === 'execute-prepared-code' && tier === 'compatibility' &&
    typeof artifactKey === 'string' && artifactKey.length > 0 && Number.isFinite(received));
  return primes.length === 1 ? primes[0].artifactKey : undefined;
}
