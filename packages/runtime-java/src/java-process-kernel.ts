import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import type { RuntimeKernelSyscallBridge } from '@tracecode/runtime-contracts';
import {
  makeTraceKernelHost,
  makeTraceKernelSharedSyscallChannel,
  TraceKernelControlledRuntime,
  TraceKernelSharedSyscallServer,
  type TraceKernelProcess,
} from '@tracecode/tracekernel';

export interface JavaKernelProcess {
  readonly bridge?: RuntimeKernelSyscallBridge;
  readonly retireWorkerAfterCompletion: boolean;
  complete(exitCode?: number): Promise<void>;
  fail(error: unknown): Promise<void>;
}

const JAVA_KERNEL_RUNTIME = 'java-process';

/**
 * Allocates one authoritative TraceKernel process for one disposable JVM.
 *
 * The Java Worker receives only the process-bound syscall channel. Closing
 * this handle tears down the process, descriptors, and its private TKFS.
 */
export async function createJavaKernelProcess(): Promise<
  JavaKernelProcess
> {
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    typeof Atomics === 'undefined'
  ) {
    return {
      retireWorkerAfterCompletion: true,
      complete: async () => undefined,
      fail: async () => undefined,
    };
  }
  const scope = Effect.runSync(Scope.make());
  const controlledRuntime = new TraceKernelControlledRuntime(
    JAVA_KERNEL_RUNTIME
  );
  let server: TraceKernelSharedSyscallServer | undefined;
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
          const executionScopeImage =
            yield* session.fileSystem.exportImage();
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
    const channel = makeTraceKernelSharedSyscallChannel();
    server = new TraceKernelSharedSyscallServer(
      channel,
      authority.context.syscalls
    );

    const close = async (
      result: { readonly exitCode: number } | Error
    ): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        if (result instanceof Error) {
          await Effect.runPromise(
            controlledRuntime.fail(authority.kernelProcess.pid, result)
          );
        } else {
          await Effect.runPromise(
            controlledRuntime.complete(authority.kernelProcess.pid, result)
          );
        }
        await Effect.runPromise(authority.kernelProcess.wait());
      } finally {
        server?.close();
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    };

    return {
      retireWorkerAfterCompletion: false,
      bridge: {
        channel,
        dispatch: (request) =>
          Effect.runPromise(
            authority.context.syscalls.dispatch(request as never)
          ),
        service: () => server!.servicePromise(),
        resetExecutionScope: authority.resetExecutionScope,
        close: () => server?.close(),
      },
      complete: (exitCode = 0) => close({ exitCode }),
      fail: (error) =>
        close(error instanceof Error ? error : new Error(String(error))),
    };
  } catch (error) {
    server?.close();
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
