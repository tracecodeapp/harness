#!/usr/bin/env npx tsx

import { Worker } from 'node:worker_threads';
import * as Effect from 'effect/Effect';
import {
  decodeTraceKernelSyscallRequest,
  decodeTraceKernelSyscallResult,
  encodeTraceKernelSyscallRequest,
  encodeTraceKernelSyscallResult,
  makeTraceKernelHost,
  makeTraceKernelSharedSyscallChannel,
  TraceKernelSharedSyscallServer,
  TraceKernelSyscallDispatcher,
  type TraceKernelRuntimeProvider,
  type TraceKernelSharedSyscallChannel,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const text = (value: Uint8Array): string => decoder.decode(value);

function comparable(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (entry instanceof Uint8Array) return { bytes: [...entry] };
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function assertCodecRoundTrip(
  value: TraceKernelSyscallRequest | TraceKernelSyscallResult,
  encode: (input: never) => Uint8Array,
  decode: (frame: Uint8Array) => unknown
): void {
  const decoded = decode(encode(value as never));
  assertCondition(
    comparable(decoded) === comparable(value),
    `Binary syscall codec changed the value.\nExpected: ${comparable(value)}\nReceived: ${comparable(decoded)}`
  );
}

interface WorkerResult {
  readonly type: 'result';
  readonly id: number;
  readonly bytes?: Uint8Array;
  readonly transportCalls?: number;
  readonly cacheHits?: number;
  readonly cacheMisses?: number;
  readonly elapsedMs?: number;
  readonly syscallCalls?: number;
  readonly fd?: number;
  readonly address?: { readonly host: string; readonly port: number };
  readonly bytesWritten?: number;
  readonly error?: { readonly code?: string; readonly message: string };
}

class TransportFixtureWorker {
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }
  >();
  private readonly ready: Promise<void>;

  constructor(
    private readonly worker: Worker,
    server: TraceKernelSharedSyscallServer
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (message: unknown): void => {
        if ((message as { type?: unknown })?.type !== 'ready') return;
        this.worker.off('message', onReady);
        resolve();
      };
      this.worker.on('message', onReady);
      this.worker.once('error', reject);
    });
    this.worker.on('message', (message: unknown) => {
      if ((message as { type?: unknown })?.type === 'syscall') {
        void Effect.runPromise(server.service());
        return;
      }
      const result = message as WorkerResult;
      if (result.type !== 'result') return;
      const waiter = this.pending.get(result.id);
      if (!waiter) return;
      this.pending.delete(result.id);
      waiter.resolve(result);
    });
    this.worker.on('error', (error) => {
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  async request(
    op:
      | 'read-twice'
      | 'read'
      | 'read-many'
      | 'read-uncached-many'
      | 'write'
      | 'socket-listen'
      | 'socket-accept-recv'
      | 'socket-connect-send'
      | 'close',
    path?: string,
    value?: Uint8Array,
    iterations?: number,
    socket?: {
      readonly fd?: number;
      readonly address?: { readonly host: string; readonly port: number };
    }
  ): Promise<WorkerResult> {
    await this.ready;
    const id = this.nextRequestId++;
    const result = new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker.postMessage({
      id,
      op,
      ...(path === undefined ? {} : { path }),
      ...(value === undefined ? {} : { bytes: value }),
      ...(iterations === undefined ? {} : { iterations }),
      ...(socket?.fd === undefined ? {} : { fd: socket.fd }),
      ...(socket?.address === undefined ? {} : { address: socket.address }),
    });
    return result;
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

function makeFixtureWorker(
  channel: TraceKernelSharedSyscallChannel,
  generationBuffer: SharedArrayBuffer,
  server: TraceKernelSharedSyscallServer
): TransportFixtureWorker {
  return new TransportFixtureWorker(
    new Worker(
      new URL('./fixtures/tracekernel-shared-client-worker.mjs', import.meta.url),
      {
        workerData: { channel, generationBuffer },
      }
    ),
    server
  );
}

async function main(): Promise<void> {
  const requests: readonly TraceKernelSyscallRequest[] = [
    {
      op: 'pipe',
      options: { capacityChunks: 4, closeOnExec: true, nonblocking: true },
    },
    {
      op: 'watch',
      path: '/workspace/src',
      options: { recursive: true, capacityEvents: 32 },
    },
    {
      op: 'watchdog',
      action: 'arm',
      timeoutMs: 5_000,
      signal: 'SIGKILL',
    },
    { op: 'watchdog', action: 'pet' },
    { op: 'watchdog', action: 'disarm' },
    { op: 'watchdog', action: 'status' },
    {
      op: 'spawn',
      runtime: 'javascript',
      command: 'node',
      args: ['child.js', '--mode=test'],
      cwd: '/workspace/child',
      env: { CHILD_VALUE: 'yes' },
      inheritDescriptors: [0, 1, 2, 7],
      descriptorActions: [
        { op: 'dup2', fd: 7, targetFd: 1 },
        { op: 'close', fd: 7 },
      ],
      descriptorMappings: [
        { parentFd: 12, childFd: 40 },
        { parentFd: 13, childFd: 41 },
      ],
      processGroupId: 100,
      sessionId: 100,
      stdio: {
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'ignore',
      },
    },
    { op: 'wait', pid: 101 },
    { op: 'wait', pid: 101, noHang: true },
    { op: 'identity' },
    { op: 'identity', pid: 101 },
    { op: 'processInfo' },
    { op: 'processInfo', pid: 101 },
    { op: 'processList' },
    { op: 'environment' },
    { op: 'kill', pid: 102, signal: 'SIGHUP' },
    { op: 'kill', pid: 102, signal: 'SIGTERM' },
    { op: 'kill', pid: 102, signal: 'SIGQUIT' },
    { op: 'setsid' },
    { op: 'setpgid', pid: 0, pgid: 0 },
    { op: 'isatty', fd: 0 },
    { op: 'tcgetpgrp', fd: 0 },
    { op: 'tcsetpgrp', fd: 0, pgid: 102 },
    { op: 'tcgetwinsize', fd: 0 },
    { op: 'tcsetwinsize', fd: 0, rows: 40, columns: 120 },
    { op: 'socket' },
    { op: 'bind', fd: 3, address: { host: '127.0.0.1', port: 8080 } },
    { op: 'listen', fd: 3, options: { backlog: 8, capacityChunks: 4 } },
    { op: 'accept', fd: 3 },
    { op: 'connect', fd: 4, address: { host: 'localhost', port: 8080 } },
    { op: 'send', fd: 4, bytes: Uint8Array.from([1, 2, 3]) },
    { op: 'recv', fd: 4, maxBytes: 4096 },
    { op: 'shutdown', fd: 4, how: 'write' },
    { op: 'getsockname', fd: 4 },
    { op: 'getpeername', fd: 4 },
    { op: 'getsockopt', fd: 4, option: 'error' },
    {
      op: 'open',
      path: '/workspace/a',
      options: {
        access: 'read-write',
        create: true,
        exclusive: true,
        truncate: true,
        append: true,
      },
    },
    { op: 'read', fd: 9, maxBytes: 123, position: 17 },
    { op: 'write', fd: 10, bytes: Uint8Array.from([0, 1, 127, 255]), position: 19 },
    { op: 'seek', fd: 10, offset: -4, whence: 'end' },
    { op: 'close', fd: 11 },
    { op: 'dup', fd: 12 },
    { op: 'dup2', fd: 12, targetFd: 19 },
    { op: 'dup3', fd: 12, targetFd: 20, closeOnExec: true },
    { op: 'fcntl', fd: 19, action: 'get-close-on-exec' },
    {
      op: 'fcntl',
      fd: 19,
      action: 'set-close-on-exec',
      closeOnExec: true,
    },
    { op: 'fcntl', fd: 19, action: 'get-nonblocking' },
    {
      op: 'fcntl',
      fd: 19,
      action: 'set-nonblocking',
      nonblocking: true,
    },
    {
      op: 'poll',
      entries: [
        { fd: 20, read: true, write: false },
        { fd: 21, read: false, write: true },
      ],
      timeoutMs: 25,
    },
    { op: 'fstat', fd: 13 },
    { op: 'ftruncate', fd: 14, length: 4096 },
    { op: 'stat', path: '/workspace/a' },
    { op: 'lstat', path: '/workspace/a-link' },
    { op: 'realpath', path: '/workspace/a-link' },
    { op: 'readdir', path: '/workspace' },
    { op: 'mkdir', path: '/workspace/d', options: { recursive: true, mode: 0o750 } },
    { op: 'rmdir', path: '/workspace/d' },
    { op: 'unlink', path: '/workspace/a' },
    { op: 'link', existingPath: '/workspace/a', newPath: '/workspace/a-hard' },
    { op: 'symlink', target: 'a', linkPath: '/workspace/a-link' },
    { op: 'readlink', path: '/workspace/a-link' },
    { op: 'rename', sourcePath: '/workspace/a', destinationPath: '/workspace/b' },
    { op: 'readFile', path: '/workspace/b' },
    { op: 'writeFile', path: '/workspace/b', bytes: Uint8Array.from([4, 5, 6]) },
  ];
  for (const request of requests) {
    assertCodecRoundTrip(
      request,
      encodeTraceKernelSyscallRequest as (input: never) => Uint8Array,
      decodeTraceKernelSyscallRequest
    );
  }

  const results: readonly TraceKernelSyscallResult[] = [
    { ok: true, value: { op: 'pipe', readFd: 3, writeFd: 4 } },
    { ok: true, value: { op: 'watch', fd: 5 } },
    {
      ok: true,
      value: {
        op: 'watchdog',
        armed: true,
        timeoutMs: 5_000,
        deadlineAt: 1_723_456_789_012,
        signal: 'SIGKILL',
      },
    },
    { ok: true, value: { op: 'watchdog', armed: false } },
    {
      ok: true,
      value: {
        op: 'spawn',
        pid: 101,
        stdio: {
          stdinFd: 8,
          stdoutFd: 9,
          stderrFd: 10,
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'wait',
        pid: 101,
        termination: { kind: 'exit', exitCode: 7 },
      },
    },
    {
      ok: true,
      value: {
        op: 'wait',
        pid: 104,
        termination: {
          kind: 'signal',
          signal: 'SIGHUP',
          exitCode: 129,
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'wait',
        pid: 105,
        termination: {
          kind: 'signal',
          signal: 'SIGQUIT',
          exitCode: 131,
        },
      },
    },
    { ok: true, value: { op: 'wait', pid: 101 } },
    {
      ok: true,
      value: { op: 'identity', pid: 100, ppid: 1, pgid: 100, sid: 1 },
    },
    {
      ok: true,
      value: {
        op: 'processInfo',
        process: {
          pid: 100,
          ppid: 1,
          pgid: 100,
          sid: 1,
          phase: 'running',
          runtime: 'javascript',
          command: 'node',
          args: ['main.js'],
          startedAt: 1_723_456_789_012,
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'processList',
        processes: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            sid: 1,
            phase: 'running',
            runtime: 'javascript',
            command: 'node',
            args: ['main.js'],
            startedAt: 1_723_456_789_012,
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            sid: 1,
            phase: 'exited',
            runtime: 'java',
            command: 'java',
            args: ['Child'],
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        op: 'environment',
        env: {
          LANG: 'C.UTF-8',
          TRACE_VALUE: 'kernel-owned',
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'wait',
        pid: 102,
        termination: {
          kind: 'signal',
          signal: 'SIGTERM',
          exitCode: 143,
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'wait',
        pid: 103,
        termination: {
          kind: 'failure',
          exitCode: 126,
          message: 'runtime unavailable',
        },
      },
    },
    { ok: true, value: { op: 'kill' } },
    { ok: true, value: { op: 'setsid', sid: 101, pgid: 101 } },
    { ok: true, value: { op: 'setpgid', pgid: 102 } },
    { ok: true, value: { op: 'isatty', isTerminal: true } },
    { ok: true, value: { op: 'isatty', isTerminal: false } },
    { ok: true, value: { op: 'tcgetpgrp', pgid: 101 } },
    { ok: true, value: { op: 'tcsetpgrp', pgid: 102 } },
    {
      ok: true,
      value: { op: 'tcgetwinsize', rows: 40, columns: 120 },
    },
    {
      ok: true,
      value: { op: 'tcsetwinsize', rows: 55, columns: 144 },
    },
    { ok: true, value: { op: 'socket', fd: 3 } },
    {
      ok: true,
      value: {
        op: 'bind',
        address: { host: '127.0.0.1', port: 8080 },
      },
    },
    { ok: true, value: { op: 'listen' } },
    {
      ok: true,
      value: {
        op: 'accept',
        fd: 5,
        localAddress: { host: '127.0.0.1', port: 8080 },
        remoteAddress: { host: '127.0.0.1', port: 49_152 },
      },
    },
    {
      ok: true,
      value: {
        op: 'connect',
        localAddress: { host: '127.0.0.1', port: 49_152 },
        remoteAddress: { host: '127.0.0.1', port: 8080 },
      },
    },
    { ok: true, value: { op: 'send', bytesWritten: 3 } },
    { ok: true, value: { op: 'recv', bytes: Uint8Array.from([1, 2, 3]) } },
    { ok: true, value: { op: 'shutdown' } },
    {
      ok: true,
      value: {
        op: 'getsockname',
        address: { host: '127.0.0.1', port: 49_152 },
      },
    },
    {
      ok: true,
      value: {
        op: 'getpeername',
        address: { host: '127.0.0.1', port: 8080 },
      },
    },
    { ok: true, value: { op: 'getsockopt' } },
    {
      ok: true,
      value: { op: 'getsockopt', error: 'ECONNREFUSED' },
    },
    { ok: true, value: { op: 'open', fd: 3 } },
    { ok: true, value: { op: 'read', bytes: Uint8Array.from([0, 255]) } },
    { ok: true, value: { op: 'write', bytesWritten: 2 } },
    { ok: true, value: { op: 'seek', offset: 4092 } },
    { ok: true, value: { op: 'close' } },
    { ok: true, value: { op: 'dup', fd: 4 } },
    { ok: true, value: { op: 'dup2', fd: 19 } },
    { ok: true, value: { op: 'dup3', fd: 20, closeOnExec: true } },
    {
      ok: true,
      value: { op: 'fcntl', closeOnExec: false, nonblocking: false },
    },
    {
      ok: true,
      value: { op: 'fcntl', closeOnExec: true, nonblocking: false },
    },
    {
      ok: true,
      value: { op: 'fcntl', closeOnExec: true, nonblocking: true },
    },
    {
      ok: true,
      value: {
        op: 'poll',
        entries: [
          {
            fd: 20,
            read: true,
            write: false,
            hangup: true,
            error: false,
            invalid: false,
          },
          {
            fd: 21,
            read: false,
            write: false,
            hangup: false,
            error: false,
            invalid: true,
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        op: 'fstat',
        stat: {
          path: '/workspace/open.txt',
          kind: 'file',
          inode: 19,
          nlink: 0,
          mode: 0o644,
          size: 64,
          generation: 8,
          createdAt: 20,
          modifiedAt: 21,
          changedAt: 22,
        },
      },
    },
    { ok: true, value: { op: 'ftruncate' } },
    {
      ok: true,
      value: {
        op: 'stat',
        stat: {
          path: '/workspace/a',
          kind: 'file',
          inode: 3,
          nlink: 2,
          mode: 0o644,
          size: 2,
          generation: 4,
          createdAt: 10,
          modifiedAt: 11,
          changedAt: 12,
        },
      },
    },
    {
      ok: true,
      value: {
        op: 'lstat',
        stat: {
          path: '/workspace/a-link',
          kind: 'symlink',
          inode: 4,
          nlink: 1,
          mode: 0o777,
          size: 1,
          generation: 5,
          createdAt: 10,
          modifiedAt: 11,
          changedAt: 12,
        },
      },
    },
    { ok: true, value: { op: 'realpath', path: '/workspace/a' } },
    {
      ok: true,
      value: {
        op: 'readdir',
        entries: [{ name: 'a', kind: 'file', inode: 3 }],
      },
    },
    { ok: true, value: { op: 'mkdir' } },
    { ok: true, value: { op: 'rmdir' } },
    { ok: true, value: { op: 'unlink' } },
    { ok: true, value: { op: 'link' } },
    { ok: true, value: { op: 'symlink' } },
    { ok: true, value: { op: 'readlink', target: 'a' } },
    { ok: true, value: { op: 'rename' } },
    {
      ok: true,
      value: {
        op: 'readFile',
        bytes: Uint8Array.from([1, 2, 3]),
        cacheGeneration: -1,
      },
    },
    { ok: true, value: { op: 'writeFile' } },
    { ok: false, error: { code: 'ENOENT', message: 'ENOENT: missing' } },
    { ok: false, error: { code: 'EAGAIN', message: 'EAGAIN: process limit' } },
    { ok: false, error: { code: 'ECHILD', message: 'ECHILD: already reaped' } },
    { ok: false, error: { code: 'EMFILE', message: 'EMFILE: descriptor limit' } },
    { ok: false, error: { code: 'EROFS', message: 'EROFS: read-only filesystem' } },
  ];
  for (const result of results) {
    assertCodecRoundTrip(
      result,
      encodeTraceKernelSyscallResult as (input: never) => Uint8Array,
      decodeTraceKernelSyscallResult
    );
  }
  const malformedFrame = encodeTraceKernelSyscallResult({
    ok: false,
    error: { code: 'ENOENT', message: 'missing' },
  });
  malformedFrame[5] = 2;
  let malformedRejected = false;
  try {
    decodeTraceKernelSyscallResult(malformedFrame);
  } catch {
    malformedRejected = true;
  }
  assertCondition(malformedRejected, 'Malformed binary response status was accepted.');

  const provider: TraceKernelRuntimeProvider = {
    runtime: 'transport-test',
    initialize: Effect.succeed({
      acquire: (process) =>
        Effect.succeed({
          id: `transport-lease-${process.pid}`,
          runtime: 'transport-test',
          execute: () => Effect.never,
          release: () => Effect.void,
        }),
    }),
  };
  let cachedBenchmarkResult = {
    cachedElapsedMs: 0,
    uncachedElapsedMs: 0,
  };

  await Effect.runPromise(Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeTraceKernelHost({ providers: [provider] });
      const session = yield* host.openSession();
      const readerProcess = yield* session.spawn({
        runtime: 'transport-test',
        command: 'reader-worker',
      });
      const writerProcess = yield* session.spawn({
        runtime: 'transport-test',
        command: 'writer-worker',
      });
      yield* Effect.all(
        [readerProcess.awaitStarted(), writerProcess.awaitStarted()],
        { concurrency: 'unbounded', discard: true }
      );
      yield* session.writeFile('shared.txt', bytes('before'));

      const generationBuffer = session.fileSystem.sharedGenerationBuffer();
      assertCondition(generationBuffer !== undefined, 'Shared generation buffer is unavailable.');
      const readerChannel = makeTraceKernelSharedSyscallChannel({ byteCapacity: 1024 });
      const writerChannel = makeTraceKernelSharedSyscallChannel({ byteCapacity: 1024 });
      const readerServer = new TraceKernelSharedSyscallServer(
        readerChannel,
        new TraceKernelSyscallDispatcher(session, readerProcess)
      );
      const writerServer = new TraceKernelSharedSyscallServer(
        writerChannel,
        new TraceKernelSyscallDispatcher(session, writerProcess)
      );
      const reader = makeFixtureWorker(readerChannel, generationBuffer!, readerServer);
      const writer = makeFixtureWorker(writerChannel, generationBuffer!, writerServer);

      try {
        const initial = yield* Effect.promise(() =>
          reader.request('read-twice', 'shared.txt')
        );
        assertCondition(!initial.error, `Initial worker reads failed: ${comparable(initial)}`);
        assertCondition(text(initial.bytes!) === 'before', 'Cached worker read returned mutable bytes.');
        assertCondition(
          initial.transportCalls === 1 &&
            initial.cacheHits === 1 &&
            initial.cacheMisses === 1,
          `Second unchanged read did not use the runtime cache: ${comparable(initial)}`
        );

        const write = yield* Effect.promise(() =>
          writer.request('write', 'shared.txt', bytes('after'))
        );
        assertCondition(!write.error, `Writer syscall failed: ${comparable(write)}`);
        assertCondition(
          text(yield* session.readFile('shared.txt')) === 'after',
          'Worker write did not commit to authoritative TKFS.'
        );

        const afterMutation = yield* Effect.promise(() =>
          reader.request('read', 'shared.txt')
        );
        assertCondition(!afterMutation.error, `Post-mutation read failed: ${comparable(afterMutation)}`);
        assertCondition(
          text(afterMutation.bytes!) === 'after',
          'Reader worker reused stale bytes after another worker mutation.'
        );
        assertCondition(
          afterMutation.transportCalls === 2 &&
            afterMutation.cacheHits === 1 &&
            afterMutation.cacheMisses === 2,
          `Generation change did not force exactly one authoritative reread: ${comparable(afterMutation)}`
        );

        const cachedBenchmark = yield* Effect.promise(() =>
          reader.request('read-many', 'shared.txt', undefined, 1_000)
        );
        const uncachedBenchmark = yield* Effect.promise(() =>
          reader.request('read-uncached-many', 'shared.txt', undefined, 1_000)
        );
        assertCondition(
          cachedBenchmark.syscallCalls === 0 &&
            uncachedBenchmark.syscallCalls === 1_000,
          `Read-cache benchmark crossed the wrong number of syscall boundaries: ${comparable({
            cachedBenchmark,
            uncachedBenchmark,
          })}`
        );
        cachedBenchmarkResult = {
          cachedElapsedMs: cachedBenchmark.elapsedMs!,
          uncachedElapsedMs: uncachedBenchmark.elapsedMs!,
        };

        yield* session.writeFile('large.bin', new Uint8Array(2048));
        const oversized = yield* Effect.promise(() =>
          reader.request('read', 'large.bin')
        );
        assertCondition(
          oversized.error?.code === 'E2BIG',
          `Oversized response did not fail through bounded framing: ${comparable(oversized)}`
        );

        const listener = yield* Effect.promise(() =>
          reader.request('socket-listen')
        );
        assertCondition(
          !listener.error && listener.fd !== undefined && listener.address !== undefined,
          `Worker listener setup failed: ${comparable(listener)}`
        );
        const accepting = reader.request(
          'socket-accept-recv',
          undefined,
          undefined,
          undefined,
          { fd: listener.fd }
        );
        const sending = yield* Effect.promise(() =>
          writer.request(
            'socket-connect-send',
            undefined,
            bytes('transport-tcp'),
            undefined,
            { address: listener.address }
          )
        );
        const accepted = yield* Effect.promise(() => accepting);
        assertCondition(
          !sending.error &&
            sending.bytesWritten === 13 &&
            !accepted.error &&
            text(accepted.bytes!) === 'transport-tcp',
          `TCP did not cross independent synchronous worker transports: ${comparable({
            sending,
            accepted,
          })}`
        );

        yield* Effect.promise(() => reader.request('close'));
        yield* Effect.promise(() => writer.request('close'));
      } finally {
        readerServer.close();
        writerServer.close();
        yield* Effect.promise(() => Promise.all([
          reader.terminate(),
          writer.terminate(),
        ]).then(() => undefined));
      }

      yield* Effect.all(
        [readerProcess.signal('SIGTERM'), writerProcess.signal('SIGTERM')],
        { concurrency: 'unbounded', discard: true }
      );
    })
  ));

  console.log(JSON.stringify({
    schema: 'tracekernel-013-transport-v1',
    binaryCodecCoversEverySyscall: true,
    sharedFramesAreBounded: true,
    synchronousCallsCrossDedicatedWorkers: true,
    tcpCrossesIndependentWorkerTransports: true,
    unchangedReadsUseGenerationCache: true,
    crossWorkerWritesInvalidateCachedReads: true,
    cacheReturnsDefensiveCopies: true,
    benchmark: {
      iterations: 1_000,
      cachedElapsedMs: cachedBenchmarkResult.cachedElapsedMs,
      uncachedElapsedMs: cachedBenchmarkResult.uncachedElapsedMs,
      cachedSyscallCalls: 0,
      uncachedSyscallCalls: 1_000,
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
