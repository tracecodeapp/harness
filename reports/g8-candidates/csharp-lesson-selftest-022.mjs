import assert from 'node:assert/strict';
import { csharpReplenishmentOutcome } from './java-runner/csharp-replenishment-witness.mjs';

// Exercise the lesson runner's real options even when this particular browser
// run uses a different worker. These are generated phase receipts, without
// catalog data or measured latencies.
export function assertLessonPromotion022(caseCount, options) {
  const worker = 2;
  const phases = [
    { worker: 1, workerKind: 'compiler', type: 'prepare-program', role: 'ordinary',
      artifactKey: 'learner' },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'init', received: 1 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'warmup', received: 2 },
    { worker, workerKind: 'runner', role: 'ordinary', type: 'execute-prepared-code',
      tier: 'compatibility', artifactKey: 'trusted', received: 3 },
    ...Array.from({ length: caseCount }, (_, index) => ({
      worker, workerKind: 'runner', role: 'ordinary',
      type: 'execute-prepared-code', tier: 'algorithm-fast',
      artifactKey: 'learner', received: 4 + index,
      timings: {
        executionRealm: 'retained-worker-collectible-context',
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    })),
  ];
  const outcome = csharpReplenishmentOutcome(phases, 'trusted', options);
  assert.equal(outcome.error, undefined, 'C# Lesson Continue promoted standby');
  assert.ok(outcome.promotedOrdinaryWorkers.has(worker));
  const missingPrime = phases.filter(({ artifactKey }) => artifactKey !== 'trusted');
  assert.equal(csharpReplenishmentOutcome(missingPrime, 'trusted', options).error,
    'C# trusted standby replenishment witness differs', 'C# Lesson Continue must require the trusted prime');
}
