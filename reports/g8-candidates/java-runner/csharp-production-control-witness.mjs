import { csharpReplenishmentOutcome } from './csharp-replenishment-witness.mjs';

const WITNESS_ERROR = 'Published C# single-worker witness differs';

export function csharpProductionControlOutcome(result, trustedArtifactKey, replenishmentOptions) {
  const phases = result?.csharp?.phases ?? [];
  const replenishment = csharpReplenishmentOutcome(phases, trustedArtifactKey, replenishmentOptions);
  if (replenishment.error) return replenishment.error;
  const executions = phases.filter(({ type }) =>
    ['execute-code', 'execute-code-batch', 'execute-with-tracing',
      'execute-prepared-code', 'execute-prepared-trace'].includes(type))
    .filter(({ worker }) => !replenishment.trustedWorkers.has(worker));
  const workers = new Set(executions.map(({ worker }) => worker));
  const valid = executions.length > 0 && workers.size === 1 &&
    [...workers].every((worker) => Number.isSafeInteger(worker) && worker > 0) &&
    executions.every(({ received }) => Number.isFinite(received));
  if (!valid) return WITNESS_ERROR;
}
