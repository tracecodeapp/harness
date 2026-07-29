#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  type TraceKernelRuntimeLease,
  type TraceKernelRuntimeLeaseReleaseDisposition,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface MutableEngine {
  readonly id: number;
  state: 'clean' | 'dirty' | 'crashed' | 'invalid';
}

async function main(): Promise<void> {
  let initializeCount = 0;
  let nextEngineId = 1;
  let nextLeaseId = 1;
  let revalidationCount = 0;
  const available: MutableEngine[] = [];
  const destroyedEngineIds: number[] = [];
  const executionEngineIds: number[] = [];
  const releases: Array<{
    readonly leaseId: string;
    readonly engineId: number;
    readonly disposition: TraceKernelRuntimeLeaseReleaseDisposition;
  }> = [];

  const provider: TraceKernelRuntimeProvider = {
    runtime: 'recovery-test',
    initialize: Effect.sync(() => {
      initializeCount += 1;
      const immutableFactoryToken = Object.freeze({ initialized: true });
      return {
        acquire: (process) =>
          Effect.sync(() => {
            assertCondition(
              immutableFactoryToken.initialized,
              'The immutable provider factory was not retained.'
            );
            const engine = available.pop() ?? {
              id: nextEngineId++,
              state: 'clean' as const,
            };
            const leaseId = `recovery-lease-${nextLeaseId++}`;
            const execute = () => Effect.suspend(() => {
              executionEngineIds.push(engine.id);
              if (engine.state !== 'clean') {
                return Effect.fail(
                  new Error(`Mutable engine ${engine.id} leaked ${engine.state} state.`)
                );
              }
              if (process.command === 'block') return Effect.never;
              if (process.command === 'crash') {
                engine.state = 'crashed';
                return Effect.fail(new Error('runtime worker crashed'));
              }
              if (process.command === 'defect') {
                engine.state = 'crashed';
                return Effect.die(new Error('runtime adapter defect'));
              }
              engine.state = process.command === 'validation-failure'
                ? 'invalid'
                : 'dirty';
              return Effect.succeed({
                exitCode: 0,
                stdout: `${process.command}:${engine.id}\n`,
              });
            });
            const release = (
              disposition: TraceKernelRuntimeLeaseReleaseDisposition
            ) => Effect.sync(() => {
              releases.push({ leaseId, engineId: engine.id, disposition });
              if (disposition.kind === 'reuse') {
                assertCondition(
                  engine.state === 'clean',
                  `Engine ${engine.id} was pooled before successful reset.`
                );
                available.push(engine);
              } else {
                destroyedEngineIds.push(engine.id);
              }
            });
            const baseLease: TraceKernelRuntimeLease = {
              id: leaseId,
              runtime: 'recovery-test',
              execute,
              release,
            };
            if (process.command === 'unvalidated') return baseLease;
            return {
              ...baseLease,
              revalidate: () => Effect.suspend(() => {
                revalidationCount += 1;
                if (engine.state === 'invalid') {
                  return Effect.fail(new Error('runtime reset validation failed'));
                }
                engine.state = 'clean';
                return Effect.void;
              }),
            };
          }),
      };
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const execute = (command: string) => session.execute({
        runtime: 'recovery-test',
        command,
      });

      const first = yield* execute('clean-first');
      const second = yield* execute('clean-second');
      assertCondition(
        first.termination?.kind === 'exit' &&
          second.termination?.kind === 'exit' &&
          executionEngineIds[0] === executionEngineIds[1],
        'A successfully revalidated engine was not safely reused.'
      );

      const crashed = yield* execute('crash');
      assertCondition(
        crashed.termination?.kind === 'failure',
        `A runtime crash was not reported as process failure: ${JSON.stringify(crashed)}`
      );
      yield* execute('after-crash');
      assertCondition(
        executionEngineIds[3] !== executionEngineIds[2],
        'A crashed mutable engine was leased to another process.'
      );

      const defect = yield* execute('defect');
      assertCondition(
        defect.termination?.kind === 'failure' &&
          defect.termination.message === 'Runtime execution failed.',
        `A runtime defect escaped the process failure boundary: ${JSON.stringify(defect)}`
      );
      yield* execute('after-defect');
      assertCondition(
        executionEngineIds[5] !== executionEngineIds[4],
        'A defective mutable engine was leased again.'
      );

      const invalid = yield* execute('validation-failure');
      assertCondition(
        invalid.termination?.kind === 'exit',
        'A post-execution validation failure changed the completed program result.'
      );
      yield* execute('after-validation-failure');
      assertCondition(
        executionEngineIds[7] !== executionEngineIds[6],
        'An engine that failed reset validation was leased again.'
      );

      yield* execute('unvalidated');
      yield* execute('after-unvalidated');
      assertCondition(
        executionEngineIds[9] !== executionEngineIds[8],
        'An unvalidated mutable engine was leased again.'
      );

      const interrupted = yield* session.spawn({
        runtime: 'recovery-test',
        command: 'block',
      });
      yield* interrupted.awaitStarted();
      yield* interrupted.signal('SIGKILL');
      const interruptedSnapshot = yield* interrupted.wait();
      assertCondition(
        interruptedSnapshot.termination?.kind === 'signal',
        'A force-interrupted process did not preserve signal termination.'
      );
      yield* execute('after-interrupt');
      assertCondition(
        executionEngineIds[11] !== executionEngineIds[10],
        'An interrupted mutable engine was leased again.'
      );
    })
  ));

  const reasons = releases.map(({ disposition }) => disposition.reason);
  assertCondition(
    initializeCount === 1,
    `Crash recovery discarded immutable provider initialization: ${initializeCount}`
  );
  assertCondition(
    releases.length === 12 &&
      new Set(releases.map(({ leaseId }) => leaseId)).size === releases.length,
    `Runtime leases were not released exactly once: ${JSON.stringify(releases)}`
  );
  assertCondition(
    reasons.includes('revalidated') &&
      reasons.includes('execution-failure') &&
      reasons.includes('revalidation-failure') &&
      reasons.includes('unvalidated') &&
      reasons.includes('interrupted'),
    `Kernel lease dispositions were incomplete: ${JSON.stringify(reasons)}`
  );
  assertCondition(
    revalidationCount === 8,
    `Revalidation ran for a crash, interruption, or unvalidated lease: ${revalidationCount}`
  );

  console.log(JSON.stringify({
    schema: 'tracekernel-runtime-recovery-v1',
    immutableInitializationRetained: true,
    cleanLeaseRevalidatedBeforeReuse: true,
    crashedLeaseDestroyed: true,
    defectiveLeaseDestroyed: true,
    failedValidationDestroysLease: true,
    unvalidatedLeaseDestroyedByDefault: true,
    interruptedLeaseDestroyed: true,
    exactlyOnceRelease: true,
    destroyedEngineIds,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
