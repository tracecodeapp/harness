import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import {
  makeTraceKernelHost,
  TraceKernelControlledRuntime,
  type TraceKernelProcess,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

const JAVA_KERNEL_RUNTIME = 'java-process';

export interface LocalJavaKernelHostRequest {
  readonly operation: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface LocalJavaKernelAuthority {
  dispatchSync(request: LocalJavaKernelHostRequest): TraceKernelSyscallResult;
  dispatch(request: LocalJavaKernelHostRequest): Promise<TraceKernelSyscallResult>;
  resetExecutionScope(): Promise<void>;
  close(): Promise<void>;
}

function syscallRequest(
  request: LocalJavaKernelHostRequest
): TraceKernelSyscallRequest {
  return {
    ...(request.payload ?? {}),
    op: request.operation,
  } as TraceKernelSyscallRequest;
}

/**
 * Creates the Java provider's process authority in the provider Worker.
 *
 * Keeping TraceKernel in the same realm as TraceJVM gives ordinary documents
 * the same authoritative process and TKFS boundary as cross-origin-isolated
 * documents, without requiring a SharedArrayBuffer transport between realms.
 */
export async function createLocalJavaKernelAuthority(): Promise<
  LocalJavaKernelAuthority
> {
  const scope = Effect.runSync(Scope.make());
  const controlledRuntime = new TraceKernelControlledRuntime(
    JAVA_KERNEL_RUNTIME
  );
  let process: TraceKernelProcess | undefined;
  let closed = false;

  try {
    const authority = await Effect.runPromise(
      Scope.extend(
        Effect.gen(function* () {
          const host = yield* makeTraceKernelHost({
            providers: [controlledRuntime.provider],
          });
          const session = yield* host.openSession({
            cwd: '/workspace',
            signalGracePeriodMs: 0,
          });
          yield* session.mkdir('/tmp', { recursive: true });
          yield* session.mkdir('/var', { recursive: true });
          yield* session.mkdir('/var/tmp', { recursive: true });
          const kernelProcess = yield* session.spawn({
            runtime: JAVA_KERNEL_RUNTIME,
            command: 'java',
            cwd: '/workspace',
            owner: { id: 'java', kind: 'user' },
          });
          yield* session.attachNullStandardIo(kernelProcess);
          const context = yield* controlledRuntime.awaitAttached(
            kernelProcess.pid
          );
          const executionScopeImage = yield* session.fileSystem.exportImage();
          return {
            context,
            kernelProcess,
            resetExecutionScope: () =>
              Effect.runPromise(
                session.resetProcessExecutionScope(
                  kernelProcess,
                  executionScopeImage
                )
              ),
          };
        }),
        scope
      )
    );
    process = authority.kernelProcess;

    return {
      dispatchSync: (request) =>
        Effect.runSync(
          authority.context.syscalls.dispatch(syscallRequest(request))
        ),
      dispatch: (request) =>
        Effect.runPromise(
          authority.context.syscalls.dispatch(syscallRequest(request))
        ),
      resetExecutionScope: authority.resetExecutionScope,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await Effect.runPromise(
            controlledRuntime.complete(authority.kernelProcess.pid, {
              exitCode: 0,
            })
          );
          await Effect.runPromise(authority.kernelProcess.wait());
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      },
    };
  } catch (error) {
    if (process) {
      await Effect.runPromise(
        controlledRuntime.fail(
          process.pid,
          error instanceof Error ? error : new Error(String(error))
        )
      ).catch(() => undefined);
    }
    await Effect.runPromise(Scope.close(scope, Exit.fail(error))).catch(
      () => undefined
    );
    throw error;
  }
}
