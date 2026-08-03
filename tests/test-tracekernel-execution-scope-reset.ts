#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

const encoder = new TextEncoder();

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const provider: TraceKernelRuntimeProvider = {
  runtime: 'execution-scope-reset-test',
  initialize: Effect.succeed({
    acquire: (process) =>
      Effect.succeed({
        id: `execution-scope-reset-${process.pid}`,
        runtime: 'execution-scope-reset-test',
        execute: () => Effect.never,
        release: () => Effect.void,
      }),
  }),
};

async function main(): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession({ cwd: '/workspace' });
      yield* session.mkdir('/tmp', { recursive: true });
      const process = yield* session.spawn({
        runtime: 'execution-scope-reset-test',
        command: 'java',
        cwd: '/workspace',
        owner: { id: 'java', kind: 'user' },
      });
      yield* session.attachNullStandardIo(process);
      yield* process.awaitStarted();
      const baseline = yield* session.fileSystem.exportImage();
      const baselineGeneration = session.fileSystemGeneration;
      const child = yield* session.spawnChild(process, {
        runtime: 'execution-scope-reset-test',
        command: 'child',
        cwd: '/workspace',
      });
      yield* child.awaitStarted();
      yield* session.configureProcessWatchdog(process, 'arm', {
        timeoutMs: 60_000,
      });

      yield* session.writeFile(
        '/tmp/case-state.txt',
        encoder.encode('first case')
      );
      const leakedFd = yield* session.openFile(
        process,
        '/tmp/case-state.txt',
        { access: 'read' }
      );
      assertCondition(
        leakedFd > 2,
        'Execution-scope fixture did not allocate a non-standard descriptor.'
      );

      yield* session.resetProcessExecutionScope(process, baseline);

      const missing = yield* Effect.exit(
        session.stat('/tmp/case-state.txt')
      );
      assertCondition(
        missing._tag === 'Failure',
        'TraceKernel execution-scope rollback retained a case-created file.'
      );
      assertCondition(
        process.descriptors.snapshots().map(({ fd }) => fd).join(',') ===
          '0,1,2',
        'TraceKernel execution-scope rollback retained a case-owned descriptor.'
      );
      assertCondition(
        session.fileSystemGeneration > baselineGeneration,
        'TraceKernel execution-scope rollback did not advance cache generation.'
      );
      assertCondition(
        !session.processSnapshots().some(({ pid }) => pid === child.pid),
        'TraceKernel execution-scope rollback retained a child process.'
      );
      const watchdog = yield* session.configureProcessWatchdog(
        process,
        'status'
      );
      assertCondition(
        watchdog === undefined,
        'TraceKernel execution-scope rollback retained a process watchdog.'
      );
      })
    )
  );

  console.log(
    'PASS: TraceKernel restores one leased runtime execution scope between cases'
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
