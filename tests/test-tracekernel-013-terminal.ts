#!/usr/bin/env npx tsx

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import {
  makeTraceKernelHost,
  TraceKernelTerminalError,
  type TraceKernelRuntimeProvider,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertTerminalError(
  exit: Exit.Exit<unknown, Error>,
  code: TraceKernelTerminalError['code']
): void {
  assertCondition(Exit.isFailure(exit), `Expected terminal ${code}, but operation succeeded.`);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  assertCondition(
    Option.isSome(failure) &&
      failure.value instanceof TraceKernelTerminalError &&
      failure.value.code === code,
    `Expected terminal ${code}, received ${Cause.pretty(exit.cause)}`
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main(): Promise<void> {
  const provider: TraceKernelRuntimeProvider = {
    runtime: 'terminal-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.acquireRelease(
          Effect.succeed({
            id: `terminal-lease-${process.pid}`,
            runtime: 'terminal-test',
            execute: () => Effect.never,
          }),
          () => Effect.void
        ),
    }),
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession({
        cwd: '/workspace',
        signalGracePeriodMs: 0,
      });
      const shell = yield* session.spawn({
        runtime: 'terminal-test',
        command: 'shell',
        owner: { id: 'terminal-user', kind: 'user' },
      });
      yield* shell.awaitStarted();

      const terminal = yield* session.createControllingTerminal(shell, {
        name: '/dev/tty',
        columns: 120,
        rows: 40,
      });
      yield* session.attachTerminalStdio(shell, terminal.id);

      assertCondition(
        shell.snapshot().controllingTerminalId === terminal.id,
        'The session leader did not acquire the controlling terminal.'
      );
      assertCondition(
        (yield* session.isTerminal(shell, 0)) &&
          (yield* session.isTerminal(shell, 1)) &&
          (yield* session.isTerminal(shell, 2)),
        'Terminal stdio descriptors were not installed as terminal resources.'
      );
      assertCondition(
        (yield* session.terminalForegroundProcessGroup(shell, 0)) ===
          shell.snapshot().pgid,
        'A new terminal did not foreground its acquiring process group.'
      );

      const foregroundChild = yield* session.spawnChild(shell, {
        runtime: 'terminal-test',
        command: 'foreground-child',
        inheritDescriptors: 'all',
      });
      yield* foregroundChild.awaitStarted();
      assertCondition(
        foregroundChild.snapshot().controllingTerminalId === terminal.id,
        'A child in the same session did not inherit controlling-terminal identity.'
      );

      yield* session.writeTerminalInput(terminal.id, encoder.encode('from-host'));
      assertCondition(
        decoder.decode(yield* foregroundChild.read(0, 64)) === 'from-host',
        'Foreground terminal input did not cross the shared terminal descriptor.'
      );
      yield* foregroundChild.write(1, encoder.encode('from-child'));
      assertCondition(
        decoder.decode(yield* session.readTerminalOutput(terminal.id, 64)) ===
          'from-child',
        'Terminal output did not cross from the process to the host.'
      );

      const backgroundChild = yield* session.spawnChild(shell, {
        runtime: 'terminal-test',
        command: 'background-child',
        inheritDescriptors: 'all',
        processGroupId: 0,
      });
      yield* backgroundChild.awaitStarted();
      yield* session.writeTerminalInput(terminal.id, encoder.encode('foreground-only'));
      assertTerminalError(
        yield* Effect.exit(backgroundChild.read(0, 64)),
        'EIO'
      );

      yield* session.setTerminalForegroundProcessGroup(
        shell,
        0,
        backgroundChild.snapshot().pgid
      );
      assertCondition(
        decoder.decode(yield* backgroundChild.read(0, 64)) === 'foreground-only',
        'Changing the foreground process group did not transfer terminal input authority.'
      );
      assertTerminalError(yield* Effect.exit(shell.read(0, 64)), 'EIO');

      const detached = yield* session.spawnChild(shell, {
        runtime: 'terminal-test',
        command: 'detached-session',
        inheritDescriptors: 'all',
        sessionId: 0,
      });
      yield* detached.awaitStarted();
      assertCondition(
        detached.snapshot().controllingTerminalId === undefined,
        'A child that created a new session retained controlling-terminal identity.'
      );
      assertCondition(
        yield* session.isTerminal(detached, 0),
        'A detached process descriptor stopped referring to the terminal device.'
      );
      assertTerminalError(
        yield* Effect.exit(session.terminalForegroundProcessGroup(detached, 0)),
        'ENOTTY'
      );
      assertTerminalError(yield* Effect.exit(detached.read(0, 64)), 'EIO');

      const terminalSnapshot = session.terminalSnapshots()[0];
      assertCondition(
        terminalSnapshot?.name === '/dev/tty' &&
          terminalSnapshot.columns === 120 &&
          terminalSnapshot.rows === 40 &&
          terminalSnapshot.foregroundProcessGroupId === backgroundChild.snapshot().pgid,
        `Terminal snapshot is incomplete: ${JSON.stringify(terminalSnapshot)}`
      );

      yield* session.signalTerminalForeground(terminal.id, 'SIGINT');
      const interrupted = yield* backgroundChild.wait();
      assertCondition(
        interrupted.termination?.kind === 'signal' &&
          interrupted.termination.signal === 'SIGINT' &&
          interrupted.termination.exitCode === 130,
        `Terminal interrupt did not target the foreground group: ${JSON.stringify(interrupted.termination)}`
      );
      assertCondition(
        shell.snapshot().phase === 'running' &&
          foregroundChild.snapshot().phase === 'running' &&
          detached.snapshot().phase === 'running',
        'Terminal interrupt escaped the selected foreground process group.'
      );

      yield* foregroundChild.signal('SIGKILL');
      yield* detached.signal('SIGKILL');
      yield* shell.signal('SIGKILL');
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-terminal-v1',
    controllingSessionOwnership: true,
    inheritedTerminalDescriptors: true,
    hostProcessByteTransport: true,
    foregroundReadEnforcement: true,
    foregroundGroupTransfer: true,
    newSessionDetachment: true,
    foregroundSignalDelivery: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
