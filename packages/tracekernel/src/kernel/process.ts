import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import {
  TraceKernelDescriptorTable,
  type TraceKernelDescriptorDup3Error,
  type TraceKernelDescriptorDupError,
  type TraceKernelDescriptorOperationContext,
  type TraceKernelDescriptorReadError,
  type TraceKernelDescriptorSeekError,
  type TraceKernelDescriptorWriteError,
  type TraceKernelSeekWhence,
} from '../descriptors';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
} from '../errors';
import type {
  TraceKernelPrincipal,
  TraceKernelProcessPhase,
  TraceKernelProcessSchedulingState,
  TraceKernelProcessSnapshot,
  TraceKernelProcessTermination,
  TraceKernelRuntimeLease,
  TraceKernelRuntimeName,
  TraceKernelRuntimeProcessContext,
  TraceKernelSignal,
  TraceKernelTerminatingSignal,
  TraceKernelWatchdogSnapshot,
} from '../model';
import type { TraceKernelProcessInfo } from '../syscalls';
import type { TraceKernelStat } from '../vfs';

export const SYSTEM_PRINCIPAL: TraceKernelPrincipal = Object.freeze({
  id: 'system',
  kind: 'system',
});

/**
 * Host-owned ends of a process's non-terminal standard-I/O pipes.
 *
 * The process exclusively owns fd 0/1/2. The host may feed stdin and drain
 * stdout/stderr without acquiring a synthetic process identity or bypassing
 * the descriptor resources installed in the process table.
 */
export interface TraceKernelHostStandardIo {
  readonly stdinResourceId: string;
  readonly stdoutResourceId: string;
  readonly stderrResourceId: string;
  writeStdin(bytes: Uint8Array): Effect.Effect<number, Error>;
  closeStdin(): Effect.Effect<void>;
  readStdout(maxBytes: number): Effect.Effect<Uint8Array, Error>;
  readStderr(maxBytes: number): Effect.Effect<Uint8Array, Error>;
  closeStdout(): Effect.Effect<void>;
  closeStderr(): Effect.Effect<void>;
  close(): Effect.Effect<void>;
}

export interface MutableProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  controllingTerminalId?: string;
  phase: TraceKernelProcessPhase;
  schedulingState: TraceKernelProcessSchedulingState;
  runtime: TraceKernelRuntimeName;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  owner: TraceKernelPrincipal;
  protected: boolean;
  visible: boolean;
  startedAt?: number;
  endedAt?: number;
  termination?: TraceKernelProcessTermination;
  stdout: string;
  stderr: string;
  watchdog?: TraceKernelWatchdogSnapshot;
}

function signalExitCode(signal: TraceKernelTerminatingSignal): number {
  if (signal === 'SIGHUP') return 129;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGQUIT') return 131;
  if (signal === 'SIGTERM') return 143;
  return 137;
}

function immutableSnapshot(record: MutableProcessRecord): TraceKernelProcessSnapshot {
  return Object.freeze({
    pid: record.pid,
    ppid: record.ppid,
    pgid: record.pgid,
    sid: record.sid,
    ...(record.controllingTerminalId === undefined
      ? {}
      : { controllingTerminalId: record.controllingTerminalId }),
    phase: record.phase,
    schedulingState: record.schedulingState,
    runtime: record.runtime,
    command: record.command,
    args: Object.freeze([...record.args]),
    cwd: record.cwd,
    env: Object.freeze({ ...record.env }),
    owner: record.owner,
    protected: record.protected,
    visible: record.visible,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.termination === undefined ? {} : { termination: record.termination }),
    stdout: record.stdout,
    stderr: record.stderr,
    descriptors: Object.freeze([]),
    ...(record.watchdog ? { watchdog: Object.freeze({ ...record.watchdog }) } : {}),
  });
}

export function processInfoProjection(
  snapshot: TraceKernelProcessSnapshot
): TraceKernelProcessInfo {
  return Object.freeze({
    pid: snapshot.pid,
    ppid: snapshot.ppid,
    pgid: snapshot.pgid,
    sid: snapshot.sid,
    phase: snapshot.phase,
    runtime: snapshot.runtime,
    command: snapshot.command,
    args: snapshot.args,
    ...(snapshot.startedAt === undefined
      ? {}
      : { startedAt: snapshot.startedAt }),
  });
}

/**
 * A running command represented by explicit kernel state.
 *
 * Its execution is supervised by an Effect fiber, but the fiber is not the
 * process identity. PID, lifecycle, termination, and ownership stay in the
 * process record and remain inspectable after the fiber completes.
 */
export class TraceKernelProcess {
  private fiber?: Fiber.RuntimeFiber<TraceKernelProcessSnapshot, never>;
  private runtimeLease?: TraceKernelRuntimeLease;
  private requestedSignal?: TraceKernelTerminatingSignal;
  private pendingSignal?: TraceKernelTerminatingSignal;
  readonly fileSystemMutationOrigin: TraceKernelDescriptorOperationContext;
  readonly descriptors: TraceKernelDescriptorTable;

  constructor(
    private readonly record: MutableProcessRecord,
    private readonly started: Deferred.Deferred<void, TraceKernelProcessStateError>,
    maxDescriptors: number,
    private readonly signalGracePeriodMs: number
  ) {
    this.fileSystemMutationOrigin = Object.freeze({
      get pid() {
        return record.pid;
      },
      get pgid() {
        return record.pgid;
      },
      get sid() {
        return record.sid;
      },
    });
    this.descriptors = new TraceKernelDescriptorTable({
      maxDescriptors,
      operationContext: () => this.fileSystemMutationOrigin,
    });
  }

  get pid(): number {
    return this.record.pid;
  }

  setWatchdog(watchdog?: TraceKernelWatchdogSnapshot): void {
    if (watchdog) this.record.watchdog = Object.freeze({ ...watchdog });
    else delete this.record.watchdog;
  }

  reparent(exitedParentPid: number, replacementPid: number): void {
    if (this.record.ppid === exitedParentPid) {
      this.record.ppid = replacementPid;
    }
  }

  setTopology(pgid: number, sid: number): void {
    this.record.pgid = pgid;
    this.record.sid = sid;
  }

  setControllingTerminal(terminalId?: string): void {
    if (terminalId === undefined) delete this.record.controllingTerminalId;
    else this.record.controllingTerminalId = terminalId;
  }

  setSchedulingState(state: TraceKernelProcessSchedulingState): void {
    this.record.schedulingState = state;
  }

  snapshot(): TraceKernelProcessSnapshot {
    return Object.freeze({
      ...immutableSnapshot(this.record),
      ...(this.pendingSignal === undefined
        ? {}
        : { pendingSignal: this.pendingSignal }),
      descriptors: Object.freeze([...this.descriptors.snapshots()]),
    });
  }

  read(
    fd: number,
    maxBytes: number,
    position?: number
  ): Effect.Effect<Uint8Array, TraceKernelDescriptorReadError> {
    return this.descriptors.read(fd, maxBytes, position);
  }

  write(
    fd: number,
    bytes: Uint8Array,
    position?: number
  ): Effect.Effect<number, TraceKernelDescriptorWriteError> {
    return this.descriptors.write(fd, bytes, position);
  }

  seek(
    fd: number,
    offset: number,
    whence: TraceKernelSeekWhence
  ): Effect.Effect<number, TraceKernelDescriptorSeekError> {
    return this.descriptors.seek(fd, offset, whence);
  }

  close(fd: number): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    return this.descriptors.close(fd);
  }

  dup(fd: number): Effect.Effect<number, TraceKernelDescriptorDupError> {
    return this.descriptors.dup(fd);
  }

  dup2(fd: number, targetFd: number): Effect.Effect<number, TraceKernelDescriptorDupError> {
    return this.descriptors.dup2(fd, targetFd);
  }

  dup3(
    fd: number,
    targetFd: number,
    closeOnExec: boolean
  ): Effect.Effect<number, TraceKernelDescriptorDup3Error> {
    return this.descriptors.dup3(fd, targetFd, closeOnExec);
  }

  fstat(fd: number): Effect.Effect<TraceKernelStat, TraceKernelBadFileDescriptorError> {
    return this.descriptors.stat(fd);
  }

  ftruncate(fd: number, length: number): Effect.Effect<void, TraceKernelBadFileDescriptorError> {
    return this.descriptors.truncate(fd, length);
  }

  wait(): Effect.Effect<TraceKernelProcessSnapshot, TraceKernelProcessStateError> {
    return Effect.suspend(() => {
      if (!this.fiber) {
        return Effect.fail(new TraceKernelProcessStateError({
          pid: this.pid,
          message: `Process ${this.pid} has not started execution.`,
        }));
      }
      return Fiber.await(this.fiber).pipe(Effect.map(() => this.snapshot()));
    });
  }

  awaitStarted(): Effect.Effect<void, TraceKernelProcessStateError> {
    return Deferred.await(this.started);
  }

  signal(signal: TraceKernelSignal): Effect.Effect<void>;
  signal(
    signal: TraceKernelSignal,
    requester: TraceKernelPrincipal
  ): Effect.Effect<void, TraceKernelProcessPermissionError>;
  signal(
    signal: TraceKernelSignal,
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): Effect.Effect<void, TraceKernelProcessPermissionError> {
    return Effect.suspend(() => {
      if (this.record.phase === 'exited') return Effect.void;
      if (
        this.record.protected &&
        requester.kind !== 'system' &&
        (
          requester.id !== this.record.owner.id ||
          requester.kind !== this.record.owner.kind
        )
      ) {
        return Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EACCES',
          pid: this.pid,
          requesterId: requester.id,
          message: `EACCES: actor ${requester.kind}:${requester.id} cannot signal protected process ${this.pid}`,
        }));
      }
      if (signal === 'SIGWINCH') {
        const runtimeLease = this.runtimeLease;
        if (!runtimeLease?.signal) return Effect.void;
        return runtimeLease.signal(signal).pipe(
          // SIGWINCH has a POSIX default disposition of ignore. A runtime
          // without notification support must therefore remain alive.
          Effect.catchAll(() => Effect.void)
        );
      }
      this.requestedSignal = signal;
      this.pendingSignal = signal;
      const fiber = this.fiber;
      const runtimeLease = this.runtimeLease;
      if (
        signal === 'SIGKILL' ||
        !fiber ||
        !runtimeLease?.signal ||
        this.signalGracePeriodMs === 0
      ) {
        return this.forceSignal(signal);
      }

      const completed = Fiber.await(fiber).pipe(
        Effect.as<'completed'>('completed')
      );
      const deliveryFailed = runtimeLease.signal(signal).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (this.pendingSignal === signal) {
              this.pendingSignal = undefined;
            }
          })
        ),
        Effect.matchEffect({
          onFailure: () => Effect.succeed<'delivery-failed'>('delivery-failed'),
          onSuccess: () => Effect.never,
        })
      );
      const deadline = Effect.sleep(this.signalGracePeriodMs).pipe(
        Effect.as<'deadline'>('deadline')
      );
      return Effect.raceAll([completed, deliveryFailed, deadline]).pipe(
        Effect.flatMap((outcome) =>
          outcome === 'completed'
            ? Effect.void
            : this.forceSignal(signal)
        )
      );
    });
  }

  attachFiber(fiber: Fiber.RuntimeFiber<TraceKernelProcessSnapshot, never>): void {
    this.fiber = fiber;
  }

  markStarting(): void {
    this.record.phase = 'starting';
  }

  failBeforeExecution(error: Error): Effect.Effect<void> {
    return Effect.sync(() =>
      this.finish({
        kind: 'failure',
        exitCode: 126,
        message: error.message,
      }, '', error.message.length > 0 ? `${error.message}\n` : '')
    ).pipe(
      Effect.andThen(Deferred.fail(this.started, new TraceKernelProcessStateError({
        pid: this.pid,
        message: error.message,
      }))),
      Effect.asVoid
    );
  }

  execute(lease: TraceKernelRuntimeLease): Effect.Effect<TraceKernelProcessSnapshot, never> {
    const context = this.runtimeContext();
    return Effect.sync(() => {
      this.runtimeLease = lease;
      this.record.phase = 'running';
      this.record.schedulingState = 'running';
      this.record.startedAt = Date.now();
    }).pipe(
      Effect.andThen(Deferred.succeed(this.started, undefined)),
      Effect.andThen(lease.execute(context)),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() => this.finish({
            kind: 'failure',
            exitCode: 1,
            message: error.message,
          }, '', error.message.length > 0 ? `${error.message}\n` : '')),
        onSuccess: (result) =>
          Effect.sync(() => this.finish(
            result.termination ?? {
              kind: 'exit',
              exitCode: result.exitCode,
            },
            result.stdout ?? '',
            result.stderr ?? ''
          )),
      }),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : Effect.sync(() => this.finish({
              kind: 'failure',
              exitCode: 1,
              message: 'Runtime execution failed.',
            }, '', 'Runtime execution failed.\n'))
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          const signal = this.requestedSignal ?? 'SIGTERM';
          this.finish({
            kind: 'signal',
            signal,
            exitCode: signalExitCode(signal),
          }, this.record.stdout, this.record.stderr);
        })
      ),
      Effect.ensuring(Effect.sync(() => {
        if (this.runtimeLease === lease) this.runtimeLease = undefined;
      }))
    );
  }

  private forceSignal(signal: TraceKernelTerminatingSignal): Effect.Effect<void> {
    this.requestedSignal = signal;
    const recordSignalExit = Effect.sync(() =>
      this.finish({
        kind: 'signal',
        signal,
        exitCode: signalExitCode(signal),
      }, this.record.stdout, this.record.stderr)
    ).pipe(
      Effect.andThen(Deferred.fail(this.started, new TraceKernelProcessStateError({
        pid: this.pid,
        message: `Process ${this.pid} terminated before reaching running state.`,
      }))),
      Effect.asVoid
    );
    return this.fiber
      ? Fiber.interrupt(this.fiber).pipe(
          Effect.asVoid,
          Effect.ensuring(recordSignalExit)
        )
      : recordSignalExit;
  }

  private runtimeContext(): TraceKernelRuntimeProcessContext {
    return Object.freeze({
      pid: this.record.pid,
      ppid: this.record.ppid,
      pgid: this.record.pgid,
      sid: this.record.sid,
      ...(this.record.controllingTerminalId === undefined
        ? {}
        : { controllingTerminalId: this.record.controllingTerminalId }),
      command: this.record.command,
      args: this.record.args,
      cwd: this.record.cwd,
      env: this.record.env,
    });
  }

  private finish(
    termination: TraceKernelProcessTermination,
    stdout: string,
    stderr: string
  ): TraceKernelProcessSnapshot {
    if (this.record.phase === 'exited') return this.snapshot();
    this.pendingSignal = undefined;
    this.record.phase = 'exiting';
    this.record.termination = termination;
    this.record.stdout = stdout;
    this.record.stderr = stderr;
    this.record.endedAt = Date.now();
    this.record.phase = 'exited';
    return this.snapshot();
  }
}
