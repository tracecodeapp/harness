#!/usr/bin/env npx tsx

import * as Effect from 'effect/Effect';
import * as Either from 'effect/Either';
import {
  makeTraceKernelHost,
  TraceKernelControlledRuntime,
  TraceKernelInvalidArgumentError,
  type TraceKernelProcessSpec,
  type TraceKernelRuntimeLeaseReleaseDisposition,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertUnsupported(
  result: TraceKernelSyscallResult,
  operation: string
): void {
  assertCondition(
    !result.ok &&
      result.error.code === 'EOPNOTSUPP' &&
      result.error.message.includes(operation),
    `Algorithm profile unexpectedly admitted ${operation}: ${JSON.stringify(result)}`
  );
}

async function main(): Promise<void> {
  const controlled = new TraceKernelControlledRuntime('host-runner');
  const deliveredSignals: string[] = [];
  const releaseDispositions: TraceKernelRuntimeLeaseReleaseDisposition[] = [];
  let revalidationCount = 0;

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
        context.sessionId === session.id &&
          context.pid === process.pid &&
          context.command === 'existing-product-runner',
        'The host executor did not attach to the authoritative process identity.'
      );
      const identity = yield* context.syscalls.dispatch({
        op: 'identity',
      });
      assertCondition(
        identity.ok &&
          identity.value.op === 'identity' &&
          identity.value.pid === process.pid,
        `The controlled runtime did not receive process-bound syscall authority: ${JSON.stringify(
          identity
        )}`
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
        if (signal === 'SIGWINCH') return;
        return Effect.runPromise(controlled.complete(process.pid, {
          exitCode: 143,
          stderr: 'terminated by host runner\n',
          termination: { kind: 'signal', signal, exitCode: 143 },
        })).then(() => undefined);
      });
      yield* controlled.setLeaseHandler(process.pid, {
        revalidate: () => {
          revalidationCount += 1;
        },
        release: (disposition) => {
          releaseDispositions.push(disposition);
        },
      });
      yield* process.signal('SIGTERM');
      const snapshot = yield* process.wait();
      assertCondition(
        deliveredSignals.join(',') === 'SIGTERM',
        'TraceKernel did not deliver the signal to the controlled host executor.'
      );
      assertCondition(
        snapshot.termination?.kind === 'signal' &&
          snapshot.termination.signal === 'SIGTERM' &&
          snapshot.stderr === 'terminated by host runner\n',
        `The controlled executor result did not finish the kernel process: ${JSON.stringify(snapshot)}`
      );
      assertCondition(
        controlled.attachedPids().length === 0,
        'The controlled runtime lease remained attached after process exit.'
      );

      const reusableProcess = yield* session.spawn({
        runtime: controlled.runtime,
        command: 'healthy-product-runner',
        cwd: '/workspace',
      });
      yield* reusableProcess.awaitStarted();
      yield* controlled.awaitAttached(reusableProcess.pid);
      yield* controlled.setLeaseHandler(reusableProcess.pid, {
        revalidate: () => {
          revalidationCount += 1;
        },
        release: (disposition) => {
          releaseDispositions.push(disposition);
        },
      });
      yield* controlled.complete(reusableProcess.pid, { exitCode: 0 });
      yield* reusableProcess.wait();
      assertCondition(
        revalidationCount === 1 &&
          releaseDispositions.length === 2 &&
          releaseDispositions[0]?.kind === 'destroy' &&
          releaseDispositions[0].reason === 'signaled' &&
          releaseDispositions[1]?.kind === 'reuse' &&
          releaseDispositions[1].reason === 'revalidated',
        `TraceKernel did not enforce destroy-on-signal and explicit revalidation before reuse: ${JSON.stringify({
          revalidationCount,
          releaseDispositions,
        })}`
      );

      yield* session.mkdir('/workspace', { recursive: true });
      yield* session.writeFile(
        '/workspace/solution.py',
        new TextEncoder().encode('from collections import deque\n')
      );
      yield* session.writeFile(
        '/workspace/secret.txt',
        new TextEncoder().encode('kernel-private')
      );
      const explicitUnrestrictedProcess = yield* session.spawn({
        runtime: controlled.runtime,
        command: 'explicit-unrestricted-runner',
        runtimeSyscalls: { profile: 'unrestricted' },
      });
      yield* explicitUnrestrictedProcess.awaitStarted();
      const explicitUnrestrictedContext = yield* controlled.awaitAttached(
        explicitUnrestrictedProcess.pid
      );
      const explicitUnrestrictedProcessList =
        yield* explicitUnrestrictedContext.syscalls.dispatch({
          op: 'processList',
        });
      assertCondition(
        explicitUnrestrictedProcessList.ok &&
          explicitUnrestrictedProcessList.value.op === 'processList',
        `Explicit unrestricted profile changed the general syscall contract: ${JSON.stringify(explicitUnrestrictedProcessList)}`
      );
      yield* controlled.complete(explicitUnrestrictedProcess.pid, {
        exitCode: 0,
      });
      yield* explicitUnrestrictedProcess.wait();
      const invalidRuntimePolicy = yield* Effect.either(session.spawn({
        runtime: controlled.runtime,
        command: 'invalid-runtime-policy-shape',
        runtimeSyscalls:
          'algorithm' as unknown as TraceKernelProcessSpec['runtimeSyscalls'],
      }));
      assertCondition(
        Either.isLeft(invalidRuntimePolicy) &&
          invalidRuntimePolicy.left instanceof TraceKernelInvalidArgumentError &&
          invalidRuntimePolicy.left.argument === 'runtimeSyscalls',
        `TraceKernel did not reject a non-object runtime syscall policy: ${JSON.stringify(invalidRuntimePolicy)}`
      );
      const invalidProfile = yield* Effect.either(session.spawn({
        runtime: controlled.runtime,
        command: 'invalid-algorithm-profile',
        runtimeSyscalls: {
          profile: 'algoritm',
          readableFiles: ['./solution.py'],
        } as unknown as TraceKernelProcessSpec['runtimeSyscalls'],
      }));
      assertCondition(
        Either.isLeft(invalidProfile) &&
          invalidProfile.left instanceof TraceKernelInvalidArgumentError &&
          invalidProfile.left.argument === 'runtimeSyscalls.profile',
        `TraceKernel did not reject an unknown runtime syscall profile: ${JSON.stringify(invalidProfile)}`
      );
      const invalidReadableFiles = yield* Effect.either(session.spawn({
        runtime: controlled.runtime,
        command: 'invalid-algorithm-readable-files',
        runtimeSyscalls: {
          profile: 'algorithm',
          readableFiles: './solution.py',
        } as unknown as TraceKernelProcessSpec['runtimeSyscalls'],
      }));
      assertCondition(
        Either.isLeft(invalidReadableFiles) &&
          invalidReadableFiles.left instanceof TraceKernelInvalidArgumentError &&
          invalidReadableFiles.left.argument === 'runtimeSyscalls.readableFiles',
        `TraceKernel did not reject malformed readable files: ${JSON.stringify(invalidReadableFiles)}`
      );
      const algorithmProcess = yield* session.spawn({
        runtime: controlled.runtime,
        command: 'algorithm-judge-runner',
        cwd: '/workspace',
        runtimeSyscalls: {
          profile: 'algorithm',
          readableFiles: ['./solution.py', './not-yet-materialized.py'],
        },
      });
      yield* algorithmProcess.awaitStarted();
      const algorithmContext = yield* controlled.awaitAttached(
        algorithmProcess.pid
      );
      const allowedSourceRead = yield* algorithmContext.syscalls.dispatch({
        op: 'readFile',
        path: '/workspace/./solution.py',
      });
      assertCondition(
        allowedSourceRead.ok &&
          allowedSourceRead.value.op === 'readFile' &&
          new TextDecoder().decode(allowedSourceRead.value.bytes) ===
            'from collections import deque\n',
        `Algorithm profile could not read its exact submission: ${JSON.stringify(allowedSourceRead)}`
      );
      const deniedSecretRead = yield* algorithmContext.syscalls.dispatch({
        op: 'readFile',
        path: '/workspace/secret.txt',
      });
      assertUnsupported(deniedSecretRead, 'readFile');
      assertCondition(
        !deniedSecretRead.ok &&
          deniedSecretRead.error.message ===
            'EOPNOTSUPP: TraceKernel algorithm profile does not permit readFile of "/workspace/secret.txt"',
        `Algorithm path denial was not reported precisely: ${JSON.stringify(deniedSecretRead)}`
      );
      yield* session.symlink(
        '/workspace/secret.txt',
        '/workspace/linked-solution.py'
      );
      const symlinkProcess = yield* session.spawn({
        runtime: controlled.runtime,
        command: 'algorithm-symlink-runner',
        cwd: '/workspace',
        runtimeSyscalls: {
          profile: 'algorithm',
          readableFiles: ['./linked-solution.py'],
        },
      });
      yield* symlinkProcess.awaitStarted();
      const symlinkContext = yield* controlled.awaitAttached(
        symlinkProcess.pid
      );
      assertUnsupported(
        yield* symlinkContext.syscalls.dispatch({
          op: 'readFile',
          path: '/workspace/linked-solution.py',
        }),
        'readFile'
      );
      yield* controlled.complete(symlinkProcess.pid, { exitCode: 0 });
      yield* symlinkProcess.wait();
      assertUnsupported(
        yield* algorithmContext.syscalls.dispatch({
          op: 'writeFile',
          path: '/workspace/output.txt',
          bytes: new TextEncoder().encode('cross-case state'),
        }),
        'writeFile'
      );
      assertUnsupported(
        yield* algorithmContext.syscalls.dispatch({
          op: 'spawn',
          runtime: controlled.runtime,
          command: 'escaped-child',
        }),
        'spawn'
      );
      assertUnsupported(
        yield* algorithmContext.syscalls.dispatch({ op: 'socket' }),
        'socket'
      );
      assertUnsupported(
        yield* algorithmContext.syscalls.dispatch({ op: 'processList' }),
        'processList'
      );
      assertUnsupported(
        yield* algorithmContext.syscalls.dispatch({
          op: 'watchdog',
          action: 'arm',
          timeoutMs: 1,
        }),
        'watchdog'
      );
      const outputExists = yield* session.fileSystem.stat(
        '/workspace/output.txt'
      ).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false))
      );
      assertCondition(
        !outputExists &&
          session.processSnapshots().every(
            (entry) => entry.command !== 'escaped-child'
          ) &&
          algorithmProcess.snapshot().watchdog === undefined,
        'A denied algorithm syscall mutated kernel state.'
      );
      yield* controlled.complete(algorithmProcess.pid, { exitCode: 0 });
      yield* algorithmProcess.wait();
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-controlled-runtime-v1',
    kernelOwnedPid: true,
    hostControlledExecution: true,
    kernelOwnedStandardDescriptors: true,
    signalDelivery: true,
    leaseCleanup: true,
    engineLeaseDisposition: true,
    explicitUnrestrictedProfile: true,
    nonObjectRuntimePolicyRejected: true,
    invalidRuntimePolicyRejected: true,
    algorithmCapabilityProfile: true,
    unresolvedReadableFileIsolated: true,
    symlinkedReadableFileRejected: true,
    deniedSyscallsHaveNoSideEffects: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
