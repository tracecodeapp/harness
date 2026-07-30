import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallValue,
} from "@tracecode/tracekernel";

import {
  BrowserJavaScriptProjectExecutionState,
  JavaScriptProjectCommandRequest,
} from "../browser/contracts";

import {
  BrowserBuffer,
  bytesFromNodeValue,
} from "../internal/encoding";

import {
  createBrowserEventLoopApi,
} from "./event-loop";

import {
  BrowserEventEmitter,
} from "./events-util";

import {
  dispatchBrowserNetworkSyscall,
} from "./network";

export function createChildProcessApi(
  executionState: BrowserJavaScriptProjectExecutionState,
  eventLoopApi: ReturnType<typeof createBrowserEventLoopApi>,
  request: JavaScriptProjectCommandRequest
) {
  type SpawnRequest = Extract<TraceKernelSyscallRequest, { op: 'spawn' }>;
  type StdioMode = 'pipe' | 'inherit' | 'ignore';
  type StdioEntry = StdioMode | number | null | undefined;
  interface SpawnOptions {
    cwd?: string;
    detached?: boolean;
    env?: Record<string, unknown>;
    signal?: AbortSignal;
    stdio?: StdioMode | readonly StdioEntry[];
  }

  const runtimeForCommand = (command: string): string => {
    const name = command.split('/').at(-1)?.toLowerCase() ?? command.toLowerCase();
    if (name === 'node' || name === 'nodejs') return 'javascript';
    if (name === 'python' || name === 'python3') return 'python';
    if (name === 'java') return 'java';
    if (name === 'dotnet') return 'csharp';
    return 'cpp';
  };
  const normalizeInvocation = (
    command: unknown,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ): {
    command: string;
    args: string[];
    options: SpawnOptions;
  } => {
    if (typeof command !== 'string' || command.length === 0) {
      throw Object.assign(
        new TypeError('The "file" argument must be of type string and non-empty'),
        { code: 'ERR_INVALID_ARG_TYPE' }
      );
    }
    const args = Array.isArray(argsOrOptions)
      ? argsOrOptions.map((arg) => String(arg))
      : [];
    const options = (
      Array.isArray(argsOrOptions)
        ? maybeOptions
        : argsOrOptions
    ) as SpawnOptions | undefined;
    if (
      options?.stdio !== undefined &&
      !Array.isArray(options.stdio) &&
      options.stdio !== 'pipe' &&
      options.stdio !== 'inherit' &&
      options.stdio !== 'ignore'
    ) {
      throw Object.assign(
        new TypeError(
          'The "stdio" option must be "pipe", "inherit", "ignore", or an array'
        ),
        { code: 'ERR_INVALID_ARG_VALUE' }
      );
    }
    return {
      command,
      args,
      options: options ?? {},
    };
  };
  const stdioPlan = (
    stdio: SpawnOptions['stdio'],
    fallback: StdioMode
  ): {
    readonly stdio: NonNullable<SpawnRequest['stdio']>;
    readonly descriptorMappings: NonNullable<SpawnRequest['descriptorMappings']>;
    readonly hasPipe: boolean;
  } => {
    if (!Array.isArray(stdio)) {
      const mode = (stdio ?? fallback) as StdioMode;
      return {
        stdio: { stdin: mode, stdout: mode, stderr: mode },
        descriptorMappings: [],
        hasPipe: mode === 'pipe',
      };
    }
    const modes: {
      stdin?: StdioMode;
      stdout?: StdioMode;
      stderr?: StdioMode;
    } = {};
    const descriptorMappings: Array<
      NonNullable<SpawnRequest['descriptorMappings']>[number]
    > = [];
    let hasPipe = false;
    const length = Math.max(3, stdio.length);
    for (let childFd = 0; childFd < length; childFd += 1) {
      const entry = stdio[childFd] ?? (childFd < 3 ? 'pipe' : 'ignore');
      if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
        descriptorMappings.push({ parentFd: entry, childFd });
        continue;
      }
      if (entry !== 'pipe' && entry !== 'inherit' && entry !== 'ignore') {
        throw Object.assign(
          new TypeError(`Unsupported stdio entry at index ${childFd}`),
          { code: entry === 'ipc' ? 'ENOSYS' : 'ERR_INVALID_ARG_VALUE' }
        );
      }
      if (childFd < 3) {
        modes[
          childFd === 0 ? 'stdin' : childFd === 1 ? 'stdout' : 'stderr'
        ] = entry;
      } else if (entry === 'inherit') {
        descriptorMappings.push({ parentFd: childFd, childFd });
      } else if (entry === 'pipe') {
        throw Object.assign(
          new Error('ENOSYS: piped stdio descriptors above fd 2 are not implemented'),
          { code: 'ENOSYS' }
        );
      }
      if (entry === 'pipe') hasPipe = true;
    }
    return { stdio: modes, descriptorMappings, hasPipe };
  };
  const syncDispatch = <
    Operation extends TraceKernelSyscallValue['op']
  >(
    syscall: Extract<TraceKernelSyscallRequest, { op: Operation }>
  ): Extract<TraceKernelSyscallValue, { op: Operation }> => {
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error('ENOSYS: child-process subsystem is unavailable'),
        { code: 'ENOSYS' }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(syscall);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
      });
    }
    return result.value as Extract<TraceKernelSyscallValue, { op: Operation }>;
  };
  const asyncDispatch = <
    Operation extends TraceKernelSyscallValue['op']
  >(
    syscall: Extract<TraceKernelSyscallRequest, { op: Operation }>
  ): Promise<Extract<TraceKernelSyscallValue, { op: Operation }>> =>
    dispatchBrowserNetworkSyscall(
      executionState.kernelNetwork,
      syscall
    );

  class BrowserChildReadable extends BrowserEventEmitter {
    readonly readable = true;
    encoding: string | undefined;
    closed = false;
    readonly completion: Promise<void>;

    constructor(readonly fd: number) {
      super();
      this.completion = eventLoopApi.track(this.pump());
      void this.completion.catch((error) => {
        if (!this.closed) this.emit('error', error);
      });
    }

    setEncoding(encoding: string): this {
      this.encoding = encoding;
      return this;
    }

    pipe(destination: { write(chunk: unknown): unknown; end?: () => unknown }): typeof destination {
      this.on('data', (chunk) => destination.write(chunk));
      this.on('end', () => destination.end?.());
      return destination;
    }

    pause(): this {
      return this;
    }

    resume(): this {
      return this;
    }

    destroy(): this {
      if (this.closed) return this;
      this.closed = true;
      void eventLoopApi.track(
        asyncDispatch({ op: 'close', fd: this.fd }).catch(() => undefined)
      );
      return this;
    }

    async pump(): Promise<void> {
      try {
        while (!this.closed) {
          const result = await asyncDispatch({
            op: 'read',
            fd: this.fd,
            maxBytes: 16 * 1024,
          });
          if (result.bytes.byteLength === 0) break;
          const chunk = BrowserBuffer.from(result.bytes);
          this.emit(
            'data',
            this.encoding ? chunk.toString(this.encoding) : chunk
          );
        }
        if (!this.closed) this.emit('end');
      } finally {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: 'close', fd: this.fd }).catch(() => undefined);
          this.emit('close');
        }
      }
    }
  }

  class BrowserChildWritable extends BrowserEventEmitter {
    readonly writable = true;
    ended = false;
    closed = false;
    queuedBytes = 0;
    tail = Promise.resolve();

    constructor(readonly fd: number) {
      super();
    }

    write(
      chunk: unknown,
      encodingOrCallback?: string | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ): boolean {
      const completion = typeof encodingOrCallback === 'function'
        ? encodingOrCallback
        : callback;
      if (this.ended) {
        const error = Object.assign(new Error('write after end'), {
          code: 'ERR_STREAM_WRITE_AFTER_END',
        });
        globalThis.queueMicrotask(() => {
          completion?.(error);
          this.emit('error', error);
        });
        return false;
      }
      const bytes = BrowserBuffer.isBuffer(chunk)
        ? Uint8Array.from(chunk)
        : typeof chunk === 'string'
          ? BrowserBuffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined)
          : Uint8Array.from(bytesFromNodeValue(chunk));
      this.queuedBytes += bytes.byteLength;
      const belowHighWaterMark = this.queuedBytes < 64 * 1024;
      this.tail = this.tail.then(async () => {
        try {
          await asyncDispatch({ op: 'write', fd: this.fd, bytes });
          completion?.(null);
        } catch (error) {
          completion?.(error instanceof Error ? error : new Error(String(error)));
          this.emit('error', error);
        } finally {
          const wasBackpressured = this.queuedBytes >= 64 * 1024;
          this.queuedBytes = Math.max(0, this.queuedBytes - bytes.byteLength);
          if (wasBackpressured && this.queuedBytes < 64 * 1024) {
            this.emit('drain');
          }
        }
      });
      void eventLoopApi.track(this.tail.catch(() => undefined));
      return belowHighWaterMark;
    }

    end(
      chunkOrCallback?: unknown,
      encodingOrCallback?: string | (() => void),
      callback?: () => void
    ): this {
      const chunk = typeof chunkOrCallback === 'function'
        ? undefined
        : chunkOrCallback;
      const completion = typeof chunkOrCallback === 'function'
        ? chunkOrCallback as () => void
        : typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback;
      if (chunk !== undefined) {
        this.write(
          chunk,
          typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
        );
      }
      if (this.ended) return this;
      this.ended = true;
      const closing = this.tail.then(async () => {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: 'close', fd: this.fd }).catch(() => undefined);
        }
        this.emit('finish');
        this.emit('close');
        completion?.();
      });
      this.tail = closing;
      void eventLoopApi.track(closing);
      return this;
    }

    destroy(): this {
      if (this.closed) return this;
      this.ended = true;
      const closing = this.tail.finally(async () => {
        if (!this.closed) {
          this.closed = true;
          await asyncDispatch({ op: 'close', fd: this.fd }).catch(() => undefined);
          this.emit('close');
        }
      });
      this.tail = closing;
      void eventLoopApi.track(closing);
      return this;
    }
  }

  class BrowserChildProcess extends BrowserEventEmitter {
    readonly pid: number;
    readonly stdin: BrowserChildWritable | null;
    readonly stdout: BrowserChildReadable | null;
    readonly stderr: BrowserChildReadable | null;
    readonly stdio: readonly [
      BrowserChildWritable | null,
      BrowserChildReadable | null,
      BrowserChildReadable | null,
    ];
    connected = false;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    refControl?: {
      readonly ref: () => void;
      readonly unref: () => void;
    };

    constructor(
      pid: number,
      stdio: {
        readonly stdinFd?: number;
        readonly stdoutFd?: number;
        readonly stderrFd?: number;
      } | undefined,
      signal?: AbortSignal
    ) {
      super();
      this.pid = pid;
      this.stdin = stdio?.stdinFd === undefined
        ? null
        : new BrowserChildWritable(stdio.stdinFd);
      this.stdout = stdio?.stdoutFd === undefined
        ? null
        : new BrowserChildReadable(stdio.stdoutFd);
      this.stderr = stdio?.stderrFd === undefined
        ? null
        : new BrowserChildReadable(stdio.stderrFd);
      this.stdio = [this.stdin, this.stdout, this.stderr] as const;
      if (signal) {
        const abort = () => this.kill('SIGTERM');
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    }

    kill(
      signal:
        | 'SIGHUP'
        | 'SIGINT'
        | 'SIGQUIT'
        | 'SIGKILL'
        | 'SIGTERM'
        | 'SIGWINCH' = 'SIGTERM'
    ): boolean {
      if (this.exitCode !== null || this.signalCode !== null) return false;
      syncDispatch({
        op: 'kill',
        pid: this.pid,
        signal,
      });
      this.killed = true;
      return true;
    }

    ref(): this {
      this.refControl?.ref();
      return this;
    }

    unref(): this {
      this.refControl?.unref();
      return this;
    }

    attachRefControl(control: {
      readonly ref: () => void;
      readonly unref: () => void;
    }): void {
      this.refControl = control;
    }
  }

  const spawn = (
    command: unknown,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ): BrowserChildProcess => {
    const invocation = normalizeInvocation(command, argsOrOptions, maybeOptions);
    const plan = stdioPlan(invocation.options.stdio, 'pipe');
    const spawned = syncDispatch({
      op: 'spawn',
      runtime: runtimeForCommand(invocation.command),
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.options.cwd ?? request.cwd,
      env: Object.fromEntries(
        Object.entries(invocation.options.env ?? request.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, String(value)])
      ),
      ...(invocation.options.detached
        ? { processGroupId: 0, sessionId: 0 }
        : {}),
      ...(plan.descriptorMappings.length > 0
        ? { descriptorMappings: plan.descriptorMappings }
        : {}),
      stdio: plan.stdio,
    });
    const child = new BrowserChildProcess(
      spawned.pid,
      spawned.stdio,
      invocation.options.signal
    );
    globalThis.queueMicrotask(() => child.emit('spawn'));
    const waitHandle = eventLoopApi.trackRefable(
      asyncDispatch({ op: 'wait', pid: spawned.pid }).then(
        async (waited) => {
          const termination = waited.termination;
          if (!termination) {
            throw Object.assign(
              new Error('EPROTO: blocking child wait returned a running process'),
              { code: 'EPROTO' }
            );
          }
          if (termination.kind === 'signal') {
            child.signalCode = termination.signal;
          } else {
            child.exitCode = termination.exitCode;
          }
          child.emit(
            'exit',
            child.exitCode,
            child.signalCode
          );
          await Promise.all([
            child.stdout?.completion,
            child.stderr?.completion,
          ]);
          child.emit(
            'close',
            child.exitCode,
            child.signalCode
          );
        },
        (error) => {
          // Once the parent runtime is terminating there is no JavaScript
          // event loop left to receive child-process callbacks. Closing the
          // command transport releases any outstanding kernel wait; that
          // expected cancellation must not escape as a late user error.
          if (executionState.cancelled) return;
          child.emit('error', error);
          child.emit('close', null, null);
        }
      )
    );
    child.attachRefControl(waitHandle);
    void waitHandle.completion;
    return child;
  };

  const spawnSync = (
    command: unknown,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ) => {
    const invocation = normalizeInvocation(command, argsOrOptions, maybeOptions);
    const plan = stdioPlan(invocation.options.stdio, 'ignore');
    if (plan.hasPipe) {
      throw Object.assign(
        new Error('ENOSYS: synchronous piped child stdio requires a nonblocking host capture path'),
        { code: 'ENOSYS' }
      );
    }
    const spawned = syncDispatch({
      op: 'spawn',
      runtime: runtimeForCommand(invocation.command),
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.options.cwd ?? request.cwd,
      env: Object.fromEntries(
        Object.entries(invocation.options.env ?? request.env)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, String(value)])
      ),
      ...(invocation.options.detached
        ? { processGroupId: 0, sessionId: 0 }
        : {}),
      ...(plan.descriptorMappings.length > 0
        ? { descriptorMappings: plan.descriptorMappings }
        : {}),
      stdio: plan.stdio,
    });
    const waited = syncDispatch({ op: 'wait', pid: spawned.pid });
    const termination = waited.termination;
    if (!termination) {
      throw Object.assign(
        new Error('EPROTO: blocking child wait returned a running process'),
        { code: 'EPROTO' }
      );
    }
    return {
      pid: spawned.pid,
      output: [null, BrowserBuffer.alloc(0), BrowserBuffer.alloc(0)],
      stdout: BrowserBuffer.alloc(0),
      stderr: BrowserBuffer.alloc(0),
      status: termination.kind === 'signal'
        ? null
        : termination.exitCode,
      signal: termination.kind === 'signal'
        ? termination.signal
        : null,
    };
  };

  return {
    ChildProcess: BrowserChildProcess,
    spawn,
    spawnSync,
  };
}
