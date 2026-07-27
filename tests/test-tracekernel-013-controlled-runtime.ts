#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import {
  makeTraceKernelHost,
  TraceKernelControlledRuntime,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const controlled = new TraceKernelControlledRuntime('host-runner');
  const deliveredSignals: string[] = [];

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({
        providers: [controlled.provider],
      });
      const session = yield* host.openSession({ signalGracePeriodMs: 100 });
      const process = yield* session.spawn({
        runtime: controlled.runtime,
        command: 'existing-product-runner',
        cwd: '/workspace',
      });
      yield* process.awaitStarted();
      yield* session.attachNullStandardIo(process);
      const context = yield* controlled.awaitAttached(process.pid);
      assertCondition(
        context.pid === process.pid &&
          context.command === 'existing-product-runner',
        'The host executor did not attach to the authoritative process identity.'
      );
      assertCondition(
        controlled.attachedPids().includes(process.pid),
        'The controlled lease was not visible while execution was active.'
      );
      const standardDescriptors = process.snapshot().descriptors;
      assertCondition(
        standardDescriptors.map((descriptor) => descriptor.fd).join(',') ===
          '0,1,2' &&
          standardDescriptors.every((descriptor) => descriptor.kind === 'device'),
        `Detached standard streams did not reserve kernel fd 0/1/2: ${JSON.stringify(
          standardDescriptors
        )}`
      );
      assertCondition(
        (yield* process.read(0, 32)).byteLength === 0 &&
          (yield* process.write(1, new TextEncoder().encode('discarded'))) === 9,
        'The detached null standard streams did not implement EOF/discard semantics.'
      );

      yield* controlled.setSignalHandler(process.pid, (signal) => {
        deliveredSignals.push(signal);
        return Effect.runPromise(controlled.complete(process.pid, {
          exitCode: 143,
          stderr: 'terminated by host runner\n',
        })).then(() => undefined);
      });
      yield* process.signal('SIGTERM');
      const snapshot = yield* process.wait();
      assertCondition(
        deliveredSignals.join(',') === 'SIGTERM',
        'TraceKernel did not deliver the signal to the controlled host executor.'
      );
      assertCondition(
        snapshot.termination?.kind === 'exit' &&
          snapshot.termination.exitCode === 143 &&
          snapshot.stderr === 'terminated by host runner\n',
        `The controlled executor result did not finish the kernel process: ${JSON.stringify(snapshot)}`
      );
      assertCondition(
        controlled.attachedPids().length === 0,
        'The controlled runtime lease remained attached after process exit.'
      );
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-controlled-runtime-v1',
    kernelOwnedPid: true,
    hostControlledExecution: true,
    kernelOwnedStandardDescriptors: true,
    signalDelivery: true,
    leaseCleanup: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
