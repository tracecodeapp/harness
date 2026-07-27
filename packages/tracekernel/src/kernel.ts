import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import {
  TraceKernelDescriptorTable,
  TraceKernelPipe,
  type TraceKernelDescriptor,
  type TraceKernelDescriptorDup3Error,
  type TraceKernelDescriptorDupError,
  type TraceKernelDescriptorInheritanceError,
  type TraceKernelDescriptorReadError,
  type TraceKernelDescriptorWriteError,
  type TraceKernelPipeOptions,
} from './descriptors';
import {
  makeTraceKernelNullDescriptor,
  type TraceKernelDeviceAccess,
} from './devices';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelChildProcessError,
  TraceKernelDescriptorLimitError,
  TraceKernelFileSystemError,
  TraceKernelHostClosedError,
  TraceKernelInvalidArgumentError,
  TraceKernelProcessLimitError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
  TraceKernelRuntimeUnavailableError,
  TraceKernelSessionClosedError,
  TraceKernelTerminalError,
  TraceKernelNetworkError,
} from './errors';
import {
  TraceKernelNetworkNamespace,
  TraceKernelTcpSocket,
  type TraceKernelTcpAcceptResult,
  type TraceKernelTcpAddress,
  type TraceKernelTcpConnectResult,
  type TraceKernelTcpListenOptions,
  type TraceKernelTcpShutdownHow,
} from './network';
import type {
  TraceKernelHostOptions,
  TraceKernelFileSystemAccess,
  TraceKernelFileSystemPermission,
  TraceKernelFileSystemPolicy,
  TraceKernelPrincipal,
  TraceKernelProcessPhase,
  TraceKernelProcessSnapshot,
  TraceKernelProcessSpec,
  TraceKernelProcessTermination,
  TraceKernelRuntimeFactory,
  TraceKernelRuntimeLease,
  TraceKernelRuntimeName,
  TraceKernelRuntimeProcessContext,
  TraceKernelRuntimeProvider,
  TraceKernelRuntimeResult,
  TraceKernelSessionOptions,
  TraceKernelSignal,
  TraceKernelWatchdogSignal,
  TraceKernelWatchdogSnapshot,
} from './model';
import {
  TraceKernelFileSystem,
  TraceKernelOpenFileDescription,
  type TraceKernelDirectoryEntry,
  type TraceKernelFileSnapshot,
  type TraceKernelMkdirOptions,
  type TraceKernelOpenFileOptions,
  type TraceKernelStat,
} from './vfs';
import type {
  TraceKernelSpawnParentStdio,
  TraceKernelSpawnStdio,
} from './syscalls';
import {
  TraceKernelTerminal,
  type TraceKernelTerminalAccess,
  type TraceKernelTerminalOptions,
  type TraceKernelTerminalSnapshot,
} from './terminal';
import {
  TraceKernelWatchRegistry,
  type TraceKernelWatchOptions,
} from './watch';

const SYSTEM_PRINCIPAL: TraceKernelPrincipal = Object.freeze({
  id: 'system',
  kind: 'system',
});

function normalizeDescriptorLimit(value: number | undefined): number {
  const requested = Number(value ?? 1024);
  return Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : 1024;
}

function normalizeProcessLimit(value: number | undefined): number {
  const requested = Number(value ?? 256);
  return Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : 256;
}

function normalizeSignalGracePeriod(value: number | undefined): number {
  const requested = Number(value ?? 1_000);
  return Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : 1_000;
}

interface TraceKernelRuntimeProviderSlot {
  readonly provider: TraceKernelRuntimeProvider;
  readonly initialize: Effect.Effect<TraceKernelRuntimeFactory, Error>;
}

interface MutableProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  controllingTerminalId?: string;
  phase: TraceKernelProcessPhase;
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

function signalExitCode(signal: TraceKernelSignal): number {
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
  private requestedSignal?: TraceKernelSignal;
  readonly descriptors: TraceKernelDescriptorTable;

  constructor(
    private readonly record: MutableProcessRecord,
    private readonly started: Deferred.Deferred<void, TraceKernelProcessStateError>,
    maxDescriptors: number,
    private readonly signalGracePeriodMs: number
  ) {
    this.descriptors = new TraceKernelDescriptorTable({
      maxDescriptors,
      operationContext: () => ({
        pid: this.record.pid,
        pgid: this.record.pgid,
        sid: this.record.sid,
      }),
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

  snapshot(): TraceKernelProcessSnapshot {
    return Object.freeze({
      ...immutableSnapshot(this.record),
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
      this.requestedSignal = signal;
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

  private forceSignal(signal: TraceKernelSignal): Effect.Effect<void> {
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
    this.record.phase = 'exiting';
    this.record.termination = termination;
    this.record.stdout = stdout;
    this.record.stderr = stderr;
    this.record.endedAt = Date.now();
    this.record.phase = 'exited';
    return this.snapshot();
  }
}

export class TraceKernelSession {
  private readonly processes = new Map<number, TraceKernelProcess>();
  private readonly exitedChildren = new Map<number, TraceKernelProcess>();
  private readonly waitingChildren = new Set<number>();
  private readonly reapedBeforeUnregister = new Set<number>();
  private readonly childWaiters = new Set<Deferred.Deferred<void>>();
  private readonly watchRegistry = new TraceKernelWatchRegistry();
  private readonly stopWatchingFileSystemMutations: () => void;
  private readonly processWatchdogs = new Map<
    number,
    {
      readonly token: symbol;
      readonly timeoutMs: number;
      readonly signal: TraceKernelWatchdogSignal;
      readonly deadlineAt: number;
      readonly fiber: Fiber.RuntimeFiber<void, never>;
    }
  >();
  private readonly resources = new Map<
    string,
    TraceKernelPipe | TraceKernelOpenFileDescription | TraceKernelTerminal
  >();
  private readonly controllingTerminalsBySession = new Map<number, string>();
  private nextPid = 100;
  private nextResourceId = 1;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly host: TraceKernelHost,
    private readonly scope: Scope.CloseableScope,
    readonly fileSystem: TraceKernelFileSystem,
    readonly networkNamespace: TraceKernelNetworkNamespace,
    readonly cwd: string,
    readonly env: Readonly<Record<string, string>>,
    readonly maxDescriptorsPerProcess: number,
    readonly maxProcesses: number,
    readonly signalGracePeriodMs: number,
    private readonly ownsFileSystem: boolean,
    private readonly fileSystemPolicy?: TraceKernelFileSystemPolicy
  ) {
    this.stopWatchingFileSystemMutations = fileSystem.watchMutations((mutation) => {
      Effect.runSync(this.watchRegistry.publish(mutation));
    });
  }

  spawn(
    spec: TraceKernelProcessSpec
  ): Effect.Effect<
    TraceKernelProcess,
    TraceKernelSessionClosedError |
      TraceKernelProcessLimitError |
      TraceKernelProcessStateError |
      TraceKernelInvalidArgumentError |
      TraceKernelDescriptorInheritanceError
  > {
    return this.spawnPrepared(spec);
  }

  private spawnPrepared<PreparationError extends Error = never>(
    spec: TraceKernelProcessSpec,
    prepare?: (
      process: TraceKernelProcess
    ) => Effect.Effect<void, PreparationError>
  ): Effect.Effect<
    TraceKernelProcess,
      TraceKernelSessionClosedError |
      TraceKernelProcessLimitError |
      TraceKernelProcessStateError |
      TraceKernelInvalidArgumentError |
      TraceKernelDescriptorInheritanceError |
      PreparationError
  > {
    return Effect.gen(this, function* () {
      const started = yield* Deferred.make<void, TraceKernelProcessStateError>();
      const process = yield* Effect.try({
        try: () => this.registerProcess(spec, started),
        catch: (error) =>
          error instanceof TraceKernelSessionClosedError ||
          error instanceof TraceKernelProcessLimitError ||
          error instanceof TraceKernelProcessStateError ||
          error instanceof TraceKernelInvalidArgumentError
          ? error
          : new TraceKernelSessionClosedError({
              sessionId: this.id,
              message: error instanceof Error ? error.message : String(error),
            }),
      });
      yield* this.inheritProcessDescriptors(process, spec).pipe(
        Effect.tapError(() =>
          process.descriptors.closeAll().pipe(
            Effect.ensuring(Effect.sync(() => this.unregisterProcess(process.pid)))
          )
        )
      );
      if (prepare) {
        yield* prepare(process).pipe(
          Effect.tapError(() =>
            process.descriptors.closeAll().pipe(
              Effect.ensuring(Effect.sync(() => this.unregisterProcess(process.pid)))
            )
          )
        );
      }
      yield* this.applyProcessDescriptorActions(process, spec).pipe(
        Effect.tapError(() =>
          process.descriptors.closeAll().pipe(
            Effect.ensuring(Effect.sync(() => this.unregisterProcess(process.pid)))
          )
        )
      );
      process.markStarting();

      const program = Effect.scoped(
        this.host.acquireRuntimeLease(
          spec.runtime,
          this.runtimeContext(process)
        ).pipe(
          Effect.flatMap((lease) => process.execute(lease)),
          Effect.catchAll((error) =>
            process.failBeforeExecution(error).pipe(
              Effect.map(() => process.snapshot())
            )
          ),
          Effect.flatMap((snapshot) =>
            this.flushProcessStandardOutput(process, snapshot).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.as(snapshot)
            )
          )
        )
      ).pipe(
        Effect.ensuring(this.clearProcessWatchdog(process)),
        Effect.ensuring(process.descriptors.closeAll()),
        Effect.ensuring(Effect.sync(() => this.unregisterProcess(process.pid)))
      );

      const fiber = yield* Effect.forkIn(program, this.scope);
      process.attachFiber(fiber);
      return process;
    });
  }

  spawnChild(
    parent: TraceKernelProcess,
    spec: Omit<
      TraceKernelProcessSpec,
      'parentPid' | 'owner' | 'protected' | 'visible'
    >
  ): Effect.Effect<
    TraceKernelProcess,
      TraceKernelSessionClosedError |
      TraceKernelProcessLimitError |
      TraceKernelProcessStateError |
      TraceKernelInvalidArgumentError |
      TraceKernelDescriptorInheritanceError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(parent);
      const parentSnapshot = parent.snapshot();
      return yield* this.spawn({
        ...spec,
        parentPid: parent.pid,
        owner: parentSnapshot.owner,
        protected: parentSnapshot.protected,
        visible: parentSnapshot.visible,
        cwd: spec.cwd ?? parentSnapshot.cwd,
        env: Object.freeze({
          ...parentSnapshot.env,
          ...(spec.env ?? {}),
        }),
      });
    });
  }

  spawnChildWithStdio(
    parent: TraceKernelProcess,
    spec: Omit<
      TraceKernelProcessSpec,
      'parentPid' | 'owner' | 'protected' | 'visible'
    >,
    stdio: TraceKernelSpawnStdio
  ): Effect.Effect<
    {
      readonly process: TraceKernelProcess;
      readonly stdio?: TraceKernelSpawnParentStdio;
    },
    Error
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(parent);
      const parentSnapshot = parent.snapshot();
      const replacedStdioFds = new Set<number>(
        ([
          [0, stdio.stdin],
          [1, stdio.stdout],
          [2, stdio.stderr],
        ] as const)
          .filter(([, mode]) => mode === 'pipe' || mode === 'ignore')
          .map(([fd]) => fd)
      );
      const inheritDescriptors = spec.inheritDescriptors === 'all'
        ? parentSnapshot.descriptors
            .map(({ fd }) => fd)
            .filter((fd) => !replacedStdioFds.has(fd))
        : spec.inheritDescriptors?.filter((fd) => !replacedStdioFds.has(fd));
      let parentStdio: TraceKernelSpawnParentStdio | undefined;
      const process = yield* this.spawnPrepared({
        ...spec,
        ...(inheritDescriptors === undefined ? {} : { inheritDescriptors }),
        parentPid: parent.pid,
        owner: parentSnapshot.owner,
        protected: parentSnapshot.protected,
        visible: parentSnapshot.visible,
        cwd: spec.cwd ?? parentSnapshot.cwd,
        env: Object.freeze({
          ...parentSnapshot.env,
          ...(spec.env ?? {}),
        }),
      }, (child) =>
        this.configureChildStdio(parent, child, stdio).pipe(
          Effect.tap((configured) => Effect.sync(() => {
            parentStdio = configured;
          })),
          Effect.asVoid
        )
      ).pipe(
        Effect.tapError(() =>
          Effect.forEach(
            Object.values(parentStdio ?? {}),
            (fd) => parent.close(fd).pipe(Effect.catchAll(() => Effect.void)),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
      return Object.freeze({
        process,
        ...(parentStdio ? { stdio: parentStdio } : {}),
      });
    });
  }

  waitChild(
    parent: TraceKernelProcess,
    pid: number,
    options: { readonly noHang?: boolean } = {}
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return Effect.suspend(() => {
      const selector = Math.trunc(pid);
      if (!Number.isSafeInteger(pid)) {
        return Effect.fail(new TraceKernelChildProcessError({
          code: 'ECHILD',
          pid: selector,
          message: `ECHILD: invalid child selector ${pid}`,
        }));
      }
      return this.waitChildSelection(parent, selector, options);
    });
  }

  private waitChildSelection(
    parent: TraceKernelProcess,
    selector: number,
    options: { readonly noHang?: boolean }
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(parent);
      const changed = yield* Deferred.make<void>();
      this.childWaiters.add(changed);
      const candidates = this.waitableChildren(parent, selector);
      if (candidates.length === 0) {
        this.childWaiters.delete(changed);
        return yield* Effect.fail(new TraceKernelChildProcessError({
          code: 'ECHILD',
          pid: selector,
          message: `ECHILD: selector ${selector} has no unreaped children of process ${parent.pid}`,
        }));
      }
      const child = candidates.find(
        (candidate) => candidate.snapshot().phase === 'exited'
      );
      if (!child && options.noHang) {
        this.childWaiters.delete(changed);
        return undefined;
      }
      if (!child) {
        yield* Deferred.await(changed).pipe(
          Effect.ensuring(Effect.sync(() => {
            this.childWaiters.delete(changed);
          }))
        );
        return yield* this.waitChildSelection(parent, selector, options);
      }
      this.childWaiters.delete(changed);
      this.waitingChildren.add(child.pid);
      if (this.processes.has(child.pid)) {
        this.reapedBeforeUnregister.add(child.pid);
      }
      return yield* child.wait().pipe(
        Effect.tap(() => Effect.sync(() => {
          this.exitedChildren.delete(child.pid);
        })),
        Effect.ensuring(Effect.sync(() => {
          this.waitingChildren.delete(child.pid);
        }))
      );
    });
  }

  private waitableChildren(
    parent: TraceKernelProcess,
    selector: number
  ): readonly TraceKernelProcess[] {
    const parentSnapshot = parent.snapshot();
    const children = new Map<number, TraceKernelProcess>([
      ...this.processes,
      ...this.exitedChildren,
    ]);
    return [...children.values()]
      .filter((child) => {
        const snapshot = child.snapshot();
        if (
          snapshot.ppid !== parent.pid ||
          this.waitingChildren.has(snapshot.pid) ||
          this.reapedBeforeUnregister.has(snapshot.pid)
        ) {
          return false;
        }
        if (selector > 0) return snapshot.pid === selector;
        if (selector === -1) return true;
        const processGroupId = selector === 0
          ? parentSnapshot.pgid
          : -selector;
        return snapshot.pgid === processGroupId;
      })
      .sort((left, right) => left.pid - right.pid);
  }

  execute(
    spec: TraceKernelProcessSpec
  ): Effect.Effect<
    TraceKernelProcessSnapshot,
      TraceKernelSessionClosedError |
      TraceKernelProcessLimitError |
      TraceKernelProcessStateError |
      TraceKernelInvalidArgumentError |
      TraceKernelDescriptorInheritanceError
  > {
    return Effect.gen(this, function* () {
      const process = yield* this.spawn(spec);
      return yield* process.wait();
    });
  }

  processSnapshots(
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): readonly TraceKernelProcessSnapshot[] {
    return [...this.processes.values()]
      .map((process) => process.snapshot())
      .filter((process) =>
        requester.kind === 'system' ||
        process.visible ||
        (
          process.owner.id === requester.id &&
          process.owner.kind === requester.kind
        )
      )
      .sort((left, right) => left.pid - right.pid);
  }

  processIdentity(
    caller: TraceKernelProcess,
    requestedPid?: number
  ): Effect.Effect<
    {
      readonly pid: number;
      readonly ppid: number;
      readonly pgid: number;
      readonly sid: number;
    },
    TraceKernelProcessStateError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(caller);
      const pid = requestedPid === undefined || requestedPid === 0
        ? caller.pid
        : Math.trunc(requestedPid);
      if (
        !Number.isSafeInteger(requestedPid ?? 0) ||
        pid <= 0
      ) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid,
          message: `ESRCH: invalid process identity target ${requestedPid}`,
        }));
      }
      const target = this.processes.get(pid) ?? this.exitedChildren.get(pid);
      if (!target) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid,
          message: `ESRCH: process ${pid} does not exist in session ${this.id}`,
        }));
      }
      const callerOwner = caller.snapshot().owner;
      const snapshot = target.snapshot();
      if (
        !snapshot.visible &&
        callerOwner.kind !== 'system' &&
        (
          callerOwner.id !== snapshot.owner.id ||
          callerOwner.kind !== snapshot.owner.kind
        )
      ) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid,
          message: `ESRCH: process ${pid} does not exist in session ${this.id}`,
        }));
      }
      return {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        pgid: snapshot.pgid,
        sid: snapshot.sid,
      };
    });
  }

  createProcessSession(
    process: TraceKernelProcess
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const snapshot = process.snapshot();
      if (snapshot.pgid === snapshot.pid) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: process ${process.pid} is already a process-group leader`,
        }));
      }
      process.setTopology(process.pid, process.pid);
      process.setControllingTerminal(undefined);
      yield* this.notifyChildWaiters();
      return process.pid;
    });
  }

  createControllingTerminal(
    process: TraceKernelProcess,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<
    TraceKernelTerminal,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const snapshot = process.snapshot();
      if (snapshot.sid !== snapshot.pid) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: only session leader ${snapshot.sid} may acquire a controlling terminal`,
        }));
      }
      const existingId = this.controllingTerminalsBySession.get(snapshot.sid);
      if (existingId) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: session ${snapshot.sid} already controls terminal ${existingId}`,
        }));
      }
      const resourceId = `tty-${this.nextResourceId++}`;
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processes.values()) {
        if (candidate.snapshot().sid === snapshot.sid) {
          candidate.setControllingTerminal(resourceId);
        }
      }
      return terminal;
    });
  }

  /**
   * Establish or retrieve the host-provided console for an initial session.
   *
   * Browser workspaces have a kernel-owned bootstrap session whose leader is
   * outside the user process table (the conventional PID 1 boundary). A
   * top-level process in that session may therefore ask the host to establish
   * its console without pretending that the process itself is the session
   * leader. Runtime syscalls cannot invoke this host-only operation.
   */
  bootstrapSessionTerminal(
    process: TraceKernelProcess,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<TraceKernelTerminal, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const snapshot = process.snapshot();
      const existingId = this.controllingTerminalsBySession.get(snapshot.sid);
      if (existingId) {
        const existing = yield* this.terminalById(existingId);
        existing.resize(
          options.columns ?? existing.snapshot().columns,
          options.rows ?? existing.snapshot().rows
        );
        process.setControllingTerminal(existing.id);
        return existing;
      }
      if (snapshot.sid !== snapshot.pid && snapshot.ppid !== 1) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: process ${process.pid} cannot bootstrap terminal for session ${snapshot.sid}`,
        }));
      }
      const resourceId = `tty-${this.nextResourceId++}`;
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processes.values()) {
        if (candidate.snapshot().sid === snapshot.sid) {
          candidate.setControllingTerminal(resourceId);
        }
      }
      return terminal;
    });
  }

  openTerminal(
    process: TraceKernelProcess,
    terminalId: string,
    access: TraceKernelTerminalAccess = 'read-write',
    fd?: number
  ): Effect.Effect<number, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const terminal = yield* this.terminalById(terminalId);
      const snapshot = process.snapshot();
      if (
        snapshot.sid !== terminal.sessionId ||
        snapshot.controllingTerminalId !== terminal.id
      ) {
        return yield* Effect.fail(new TraceKernelTerminalError({
          code: 'ENOTTY',
          message: `ENOTTY: terminal ${terminal.name} does not control process ${process.pid}`,
        }));
      }
      return yield* this.installDescriptor(
        process,
        terminal.descriptor(access),
        fd
      );
    });
  }

  attachTerminalStdio(
    process: TraceKernelProcess,
    terminalId: string
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return Effect.gen(this, function* () {
      const installed: number[] = [];
      return yield* Effect.gen(this, function* () {
        installed.push(yield* this.openTerminal(process, terminalId, 'read', 0));
        installed.push(yield* this.openTerminal(process, terminalId, 'write', 1));
        installed.push(yield* this.openTerminal(process, terminalId, 'write', 2));
        return Object.freeze({
          stdinFd: 0 as const,
          stdoutFd: 1 as const,
          stderrFd: 2 as const,
        });
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            installed,
            (fd) => process.close(fd).pipe(Effect.catchAll(() => Effect.void)),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
    });
  }

  replaceTerminalStdio(
    process: TraceKernelProcess,
    terminalId: string
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const terminal = yield* this.terminalById(terminalId);
      const snapshot = process.snapshot();
      if (
        snapshot.sid !== terminal.sessionId ||
        snapshot.controllingTerminalId !== terminal.id
      ) {
        return yield* Effect.fail(new TraceKernelTerminalError({
          code: 'ENOTTY',
          message: `ENOTTY: terminal ${terminal.name} does not control process ${process.pid}`,
        }));
      }
      yield* process.descriptors.replaceMany([
        { fd: 0, descriptor: terminal.descriptor('read') },
        { fd: 1, descriptor: terminal.descriptor('write') },
        { fd: 2, descriptor: terminal.descriptor('write') },
      ]);
      return Object.freeze({
        stdinFd: 0 as const,
        stdoutFd: 1 as const,
        stderrFd: 2 as const,
      });
    });
  }

  isTerminal(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<
    boolean,
    TraceKernelProcessStateError | TraceKernelBadFileDescriptorError
  > {
    return this.assertOwnedProcess(process).pipe(
      Effect.andThen(process.descriptors.lookup(fd)),
      Effect.map((descriptor) => descriptor.resource instanceof TraceKernelTerminal)
    );
  }

  terminalForegroundProcessGroup(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<number, Error> {
    return this.controllingTerminalForDescriptor(process, fd).pipe(
      Effect.map((terminal) => terminal.snapshot().foregroundProcessGroupId)
    );
  }

  setTerminalForegroundProcessGroup(
    process: TraceKernelProcess,
    fd: number,
    processGroupId: number
  ): Effect.Effect<number, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.controllingTerminalForDescriptor(process, fd);
      const pgid = Math.trunc(processGroupId);
      if (!Number.isSafeInteger(processGroupId) || pgid <= 0) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'processGroupId',
          message: `EINVAL: invalid terminal foreground process group ${processGroupId}`,
        }));
      }
      const member = [...this.processes.values()].find((candidate) => {
        const candidateSnapshot = candidate.snapshot();
        return candidateSnapshot.pgid === pgid &&
          candidateSnapshot.sid === terminal.sessionId;
      });
      if (!member) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: process.pid,
          requesterId: process.snapshot().owner.id,
          message: `EPERM: process group ${pgid} is not in terminal session ${terminal.sessionId}`,
        }));
      }
      terminal.setForegroundProcessGroup(pgid);
      return pgid;
    });
  }

  signalTerminalForeground(
    terminalId: string,
    signal: TraceKernelSignal
  ): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const pgid = terminal.snapshot().foregroundProcessGroupId;
      const members = [...this.processes.values()].filter((candidate) => {
        const snapshot = candidate.snapshot();
        return snapshot.sid === terminal.sessionId && snapshot.pgid === pgid;
      });
      if (members.length === 0) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid: -pgid,
          message: `ESRCH: terminal ${terminal.name} foreground process group ${pgid} is empty`,
        }));
      }
      yield* Effect.forEach(
        members,
        (member) => member.signal(signal),
        { concurrency: 'unbounded', discard: true }
      );
    });
  }

  writeTerminalInput(
    terminalId: string,
    bytes: Uint8Array
  ): Effect.Effect<number, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const signalByte = bytes.find((byte) => byte === 0x03 || byte === 0x1c);
      if (signalByte === undefined) {
        return yield* terminal.writeInput(bytes);
      }

      // Default termios ISIG behavior: signal-generating characters are
      // consumed by the terminal and flush unread input instead of becoming
      // process-visible bytes.
      yield* terminal.discardInput();
      yield* this.signalTerminalForeground(
        terminalId,
        signalByte === 0x03 ? 'SIGINT' : 'SIGQUIT'
      );
      return bytes.byteLength;
    });
  }

  sendTerminalInputEof(terminalId: string): Effect.Effect<void, Error> {
    return this.terminalById(terminalId).pipe(
      Effect.flatMap((terminal) => terminal.signalInputEof())
    );
  }

  readTerminalOutput(
    terminalId: string,
    maxBytes: number,
    nonblocking = false
  ): Effect.Effect<Uint8Array, Error> {
    return this.terminalById(terminalId).pipe(
      Effect.flatMap((terminal) => terminal.readOutput(maxBytes, nonblocking))
    );
  }

  resizeTerminal(
    terminalId: string,
    columns: number,
    rows: number
  ): Effect.Effect<TraceKernelTerminalSnapshot, Error> {
    return this.terminalById(terminalId).pipe(
      Effect.tap((terminal) =>
        Effect.sync(() => terminal.resize(columns, rows))
      ),
      Effect.map((terminal) => terminal.snapshot())
    );
  }

  releaseTerminalForegroundToHost(
    terminalId: string,
    expectedProcessGroupId: number
  ): Effect.Effect<number, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      if (terminal.snapshot().closed) {
        return yield* Effect.fail(new TraceKernelTerminalError({
          code: 'EIO',
          message: `EIO: terminal ${terminal.name} is closed`,
        }));
      }
      if (
        terminal.snapshot().foregroundProcessGroupId !==
        expectedProcessGroupId
      ) {
        return terminal.snapshot().foregroundProcessGroupId;
      }
      terminal.setForegroundProcessGroup(terminal.sessionId);
      return terminal.sessionId;
    });
  }

  closeTerminal(terminalId: string): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const terminalSnapshot = terminal.snapshot();
      if (terminalSnapshot.closed) return;

      const foregroundMembers = [...this.processes.values()].filter(
        (candidate) => {
          const snapshot = candidate.snapshot();
          return snapshot.sid === terminalSnapshot.sessionId &&
            snapshot.pgid === terminalSnapshot.foregroundProcessGroupId;
        }
      );
      yield* terminal.dispose();
      this.controllingTerminalsBySession.delete(terminalSnapshot.sessionId);
      for (const candidate of this.processes.values()) {
        if (
          candidate.snapshot().controllingTerminalId === terminal.id
        ) {
          candidate.setControllingTerminal(undefined);
        }
      }
      yield* Effect.forEach(
        foregroundMembers,
        (member) => member.signal('SIGHUP'),
        { concurrency: 'unbounded', discard: true }
      );
    });
  }

  terminalSnapshots(): readonly TraceKernelTerminalSnapshot[] {
    return [...this.resources.values()]
      .filter(
        (resource): resource is TraceKernelTerminal =>
          resource instanceof TraceKernelTerminal
      )
      .map((terminal) => terminal.snapshot())
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  setProcessGroup(
    caller: TraceKernelProcess,
    targetPid: number,
    processGroupId: number
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError |
      TraceKernelProcessPermissionError |
      TraceKernelInvalidArgumentError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(caller);
      const requestedPid = Math.trunc(targetPid);
      const requestedGroup = Math.trunc(processGroupId);
      if (
        !Number.isSafeInteger(targetPid) ||
        !Number.isSafeInteger(processGroupId) ||
        requestedPid < 0 ||
        requestedGroup < 0
      ) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'setpgid',
          message: `EINVAL: invalid setpgid(${targetPid}, ${processGroupId})`,
        }));
      }
      const target = requestedPid === 0 ? caller : this.processes.get(requestedPid);
      if (!target) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid: requestedPid,
          message: `ESRCH: process ${requestedPid} does not exist in session ${this.id}`,
        }));
      }
      if (target !== caller) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: target.pid,
          requesterId: caller.snapshot().owner.id,
          message: `EPERM: a running process may only change its own process group`,
        }));
      }
      const snapshot = target.snapshot();
      if (snapshot.sid === snapshot.pid) {
        return yield* Effect.fail(new TraceKernelProcessPermissionError({
          code: 'EPERM',
          pid: target.pid,
          requesterId: snapshot.owner.id,
          message: `EPERM: session leader ${target.pid} cannot change process group`,
        }));
      }
      const pgid = requestedGroup === 0 ? target.pid : requestedGroup;
      if (
        pgid !== target.pid &&
        ![...this.processes.values()].some((candidate) => {
          const candidateSnapshot = candidate.snapshot();
          return candidateSnapshot.pgid === pgid &&
            candidateSnapshot.sid === snapshot.sid;
        })
      ) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'processGroupId',
          message: `EINVAL: process group ${pgid} does not exist in session ${snapshot.sid}`,
        }));
      }
      target.setTopology(pgid, snapshot.sid);
      yield* this.notifyChildWaiters();
      return pgid;
    });
  }

  signalProcess(
    requester: TraceKernelPrincipal,
    pid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    const process = this.processes.get(pid);
    return process
      ? process.signal(signal, requester)
      : Effect.fail(new TraceKernelProcessStateError({
          pid,
          message: `ESRCH: process ${pid} does not exist in session ${this.id}`,
        }));
  }

  /**
   * Apply the POSIX kill(2) PID selector rules inside this session.
   *
   * A positive value selects one process, zero selects the caller's process
   * group, a value below -1 selects that process group, and -1 selects every
   * other process the requester may signal. Group delivery succeeds when at
   * least one member accepts the signal; an entirely protected target set
   * reports EACCES, while an empty selector reports ESRCH.
   */
  signalProcessTarget(
    requester: TraceKernelPrincipal,
    caller: TraceKernelProcess,
    targetPid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(caller);
      const selector = Math.trunc(targetPid);
      if (!Number.isSafeInteger(targetPid)) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid: selector,
          message: `ESRCH: invalid process selector ${targetPid}`,
        }));
      }
      if (selector > 0) {
        return yield* this.signalProcess(requester, selector, signal);
      }

      const callerSnapshot = caller.snapshot();
      const candidates = [...this.processes.values()].filter((process) => {
        const snapshot = process.snapshot();
        if (selector === -1) return snapshot.pid !== caller.pid;
        const processGroupId = selector === 0
          ? callerSnapshot.pgid
          : -selector;
        return snapshot.pgid === processGroupId;
      });
      if (candidates.length === 0) {
        return yield* Effect.fail(new TraceKernelProcessStateError({
          pid: selector,
          message: selector === -1
            ? `ESRCH: no other processes exist in session ${this.id}`
            : `ESRCH: process group ${selector === 0 ? callerSnapshot.pgid : -selector} does not exist in session ${this.id}`,
        }));
      }

      const deliveries = yield* Effect.forEach(
        candidates,
        (process) => process.signal(signal, requester).pipe(
          Effect.match({
            onFailure: (error) => ({ delivered: false as const, error }),
            onSuccess: () => ({ delivered: true as const }),
          })
        ),
        { concurrency: 'unbounded' }
      );
      if (deliveries.some((delivery) => delivery.delivered)) return;
      const denied = deliveries.find(
        (delivery): delivery is {
          readonly delivered: false;
          readonly error: TraceKernelProcessPermissionError;
        } => !delivery.delivered
      );
      if (denied) return yield* Effect.fail(denied.error);
    });
  }

  openNullDevice(
    process: TraceKernelProcess,
    access: TraceKernelDeviceAccess,
    fd?: number
  ): Effect.Effect<number, TraceKernelProcessStateError | TraceKernelDescriptorLimitError> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const descriptorId = `null-${process.pid}-${fd ?? 'auto'}-${this.nextResourceId++}`;
      return yield* this.installDescriptor(
        process,
        makeTraceKernelNullDescriptor(descriptorId, access),
        fd
      );
    });
  }

  attachNullStandardIo(
    process: TraceKernelProcess
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return Effect.gen(this, function* () {
      const installed: number[] = [];
      return yield* Effect.gen(this, function* () {
        installed.push(yield* this.openNullDevice(process, 'read', 0));
        installed.push(yield* this.openNullDevice(process, 'write', 1));
        installed.push(yield* this.openNullDevice(process, 'write', 2));
        return Object.freeze({
          stdinFd: 0 as const,
          stdoutFd: 1 as const,
          stderrFd: 2 as const,
        });
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            installed,
            (installedFd) =>
              process.close(installedFd).pipe(
                Effect.catchAll(() => Effect.void)
              ),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
    });
  }

  ensureNullStandardIo(
    process: TraceKernelProcess
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const existing = new Set(
        process.descriptors.snapshots().map((descriptor) => descriptor.fd)
      );
      const installed: number[] = [];
      return yield* Effect.gen(this, function* () {
        if (!existing.has(0)) {
          installed.push(yield* this.openNullDevice(process, 'read', 0));
        }
        if (!existing.has(1)) {
          installed.push(yield* this.openNullDevice(process, 'write', 1));
        }
        if (!existing.has(2)) {
          installed.push(yield* this.openNullDevice(process, 'write', 2));
        }
        return Object.freeze({
          stdinFd: 0 as const,
          stdoutFd: 1 as const,
          stderrFd: 2 as const,
        });
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            installed,
            (installedFd) =>
              process.close(installedFd).pipe(
                Effect.catchAll(() => Effect.void)
              ),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
    });
  }

  replaceNullStandardIo(
    process: TraceKernelProcess
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const resourcePrefix =
        `null-${process.pid}-replace-${this.nextResourceId++}`;
      yield* process.descriptors.replaceMany([
        {
          fd: 0,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-0`,
            'read'
          ),
        },
        {
          fd: 1,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-1`,
            'write'
          ),
        },
        {
          fd: 2,
          descriptor: makeTraceKernelNullDescriptor(
            `${resourcePrefix}-2`,
            'write'
          ),
        },
      ]);
      return Object.freeze({
        stdinFd: 0 as const,
        stdoutFd: 1 as const,
        stderrFd: 2 as const,
      });
    });
  }

  configureProcessWatchdog(
    process: TraceKernelProcess,
    action: 'arm' | 'pet' | 'disarm' | 'status',
    options: {
      readonly timeoutMs?: number;
      readonly signal?: TraceKernelWatchdogSignal;
    } = {}
  ): Effect.Effect<TraceKernelWatchdogSnapshot | undefined, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const current = this.processWatchdogs.get(process.pid);
      if (action === 'status') return current
        ? Object.freeze({
            timeoutMs: current.timeoutMs,
            signal: current.signal,
            deadlineAt: current.deadlineAt,
          })
        : undefined;
      if (action === 'disarm') {
        yield* this.clearProcessWatchdog(process);
        return undefined;
      }
      const timeoutMs = action === 'pet'
        ? current?.timeoutMs
        : options.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: action === 'pet' ? 'watchdog' : 'timeoutMs',
          message: action === 'pet'
            ? 'EINVAL: cannot pet a disarmed watchdog'
            : 'EINVAL: watchdog timeout must be a positive integer',
        }));
      }
      const signal = action === 'pet'
        ? current?.signal
        : options.signal ?? 'SIGTERM';
      if (!signal) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'watchdog',
          message: 'EINVAL: cannot pet a disarmed watchdog',
        }));
      }
      yield* this.clearProcessWatchdog(process);
      const token = Symbol(`watchdog-${process.pid}`);
      const deadlineAt = Date.now() + timeoutMs;
      const fiber = yield* Effect.forkIn(
        Effect.sleep(timeoutMs).pipe(
          Effect.andThen(Effect.suspend(() => {
            if (this.processWatchdogs.get(process.pid)?.token !== token) {
              return Effect.void;
            }
            this.processWatchdogs.delete(process.pid);
            process.setWatchdog(undefined);
            return process.signal(signal);
          })),
          Effect.ensuring(Effect.sync(() => {
            if (this.processWatchdogs.get(process.pid)?.token === token) {
              this.processWatchdogs.delete(process.pid);
              process.setWatchdog(undefined);
            }
          }))
        ),
        this.scope
      );
      const snapshot = Object.freeze({ timeoutMs, signal, deadlineAt });
      this.processWatchdogs.set(process.pid, {
        token,
        timeoutMs,
        signal,
        deadlineAt,
        fiber,
      });
      process.setWatchdog(snapshot);
      return snapshot;
    });
  }

  private clearProcessWatchdog(
    process: TraceKernelProcess
  ): Effect.Effect<void> {
    const watchdog = this.processWatchdogs.get(process.pid);
    this.processWatchdogs.delete(process.pid);
    process.setWatchdog(undefined);
    return watchdog ? Fiber.interrupt(watchdog.fiber).pipe(Effect.asVoid) : Effect.void;
  }

  createPipe(
    reader: TraceKernelProcess,
    writer: TraceKernelProcess,
    options: TraceKernelPipeOptions = {}
  ): Effect.Effect<{
    readonly resourceId: string;
    readonly readFd: number;
    readonly writeFd: number;
  }, TraceKernelProcessStateError | TraceKernelDescriptorLimitError> {
    return this.createPipeAt(reader, writer, options).pipe(
      Effect.mapError((error) =>
        error instanceof TraceKernelProcessStateError ||
        error instanceof TraceKernelDescriptorLimitError
          ? error
          : new TraceKernelDescriptorLimitError({
              code: 'EMFILE',
              maxDescriptors: Math.min(
                reader.descriptors.maxDescriptors,
                writer.descriptors.maxDescriptors
              ),
              message: error.message,
            })
      )
    );
  }

  private createPipeAt(
    reader: TraceKernelProcess,
    writer: TraceKernelProcess,
    options: TraceKernelPipeOptions = {},
    readerFd?: number,
    writerFd?: number
  ): Effect.Effect<{
    readonly resourceId: string;
    readonly readFd: number;
    readonly writeFd: number;
  }, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(reader);
      yield* this.assertOwnedProcess(writer);
      const resourceId = `pipe-${this.nextResourceId++}`;
      const pipe = yield* TraceKernelPipe.make(
        resourceId,
        options,
        (closedId) => this.resources.delete(closedId)
      );
      this.resources.set(resourceId, pipe);
      return yield* Effect.gen(this, function* () {
        const descriptorOptions = {
          closeOnExec: options.closeOnExec === true,
          nonblocking: options.nonblocking === true,
        };
        const readFd = yield* this.installDescriptor(
          reader,
          pipe.reader(),
          readerFd,
          descriptorOptions
        );
        const writeFd = yield* this.installDescriptor(
          writer,
          pipe.writer(),
          writerFd,
          descriptorOptions
        ).pipe(
          Effect.tapError(() =>
            reader.descriptors.close(readFd).pipe(Effect.catchAll(() => Effect.void))
          )
        );
        return Object.freeze({ resourceId, readFd, writeFd });
      }).pipe(
        Effect.onError(() => pipe.dispose())
      );
    });
  }

  private configureChildStdio(
    parent: TraceKernelProcess,
    child: TraceKernelProcess,
    stdio: TraceKernelSpawnStdio
  ): Effect.Effect<TraceKernelSpawnParentStdio | undefined, Error> {
    return Effect.gen(this, function* () {
      const parentDescriptors: number[] = [];
      const configured: {
        stdinFd?: number;
        stdoutFd?: number;
        stderrFd?: number;
      } = {};
      return yield* Effect.gen(this, function* () {
        for (const [fd, mode] of [
          [0, stdio.stdin],
          [1, stdio.stdout],
          [2, stdio.stderr],
        ] as const) {
          if (
            mode === 'inherit' &&
            !child.descriptors.snapshots().some((snapshot) => snapshot.fd === fd)
          ) {
            yield* child.descriptors.inherit(parent.descriptors, [fd]);
          }
        }
        if (stdio.stdin === 'pipe') {
          const pipe = yield* this.createPipeAt(child, parent, {}, 0);
          configured.stdinFd = pipe.writeFd;
          parentDescriptors.push(pipe.writeFd);
        }
        if (stdio.stdout === 'pipe') {
          const pipe = yield* this.createPipeAt(parent, child, {}, undefined, 1);
          configured.stdoutFd = pipe.readFd;
          parentDescriptors.push(pipe.readFd);
        }
        if (stdio.stderr === 'pipe') {
          const pipe = yield* this.createPipeAt(parent, child, {}, undefined, 2);
          configured.stderrFd = pipe.readFd;
          parentDescriptors.push(pipe.readFd);
        }
        return Object.keys(configured).length === 0
          ? undefined
          : Object.freeze({ ...configured });
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            parentDescriptors,
            (fd) => parent.close(fd).pipe(Effect.catchAll(() => Effect.void)),
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
    });
  }

  private flushProcessStandardOutput(
    process: TraceKernelProcess,
    snapshot: TraceKernelProcessSnapshot
  ): Effect.Effect<void, Error> {
    const writes: Effect.Effect<unknown, Error>[] = [];
    if (
      snapshot.stdout.length > 0 &&
      process.descriptors.snapshots().some(({ fd }) => fd === 1)
    ) {
      writes.push(process.write(1, new TextEncoder().encode(snapshot.stdout)));
    }
    if (
      snapshot.stderr.length > 0 &&
      process.descriptors.snapshots().some(({ fd }) => fd === 2)
    ) {
      writes.push(process.write(2, new TextEncoder().encode(snapshot.stderr)));
    }
    return Effect.forEach(writes, (write) => write, {
      concurrency: 1,
      discard: true,
    });
  }

  resourceIds(): readonly string[] {
    return [
      ...this.resources.keys(),
      ...this.networkNamespace.resourceIds(),
    ].sort();
  }

  createTcpSocket(
    process: TraceKernelProcess
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError |
      TraceKernelNetworkError |
      TraceKernelDescriptorLimitError
  > {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const socket = yield* this.networkNamespace.createSocket();
      return yield* this.installDescriptor(process, socket.descriptor());
    });
  }

  bindTcp(
    process: TraceKernelProcess,
    fd: number,
    address: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpAddress, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.bind(address))
    );
  }

  listenTcp(
    process: TraceKernelProcess,
    fd: number,
    options: TraceKernelTcpListenOptions = {}
  ): Effect.Effect<void, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.listen(options))
    );
  }

  acceptTcp(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<{
    readonly fd: number;
    readonly localAddress: TraceKernelTcpAddress;
    readonly remoteAddress: TraceKernelTcpAddress;
  }, Error> {
    return Effect.all({
      socket: this.tcpSocketFor(process, fd),
      nonblocking: process.descriptors.getNonblocking(fd),
    }).pipe(
      Effect.flatMap(({ socket, nonblocking }) =>
        nonblocking ? socket.acceptNonblocking() : socket.accept()
      ),
      Effect.flatMap((accepted: TraceKernelTcpAcceptResult) =>
        this.installDescriptor(process, accepted.socket.descriptor()).pipe(
          Effect.map((fd) => Object.freeze({
            fd,
            localAddress: accepted.localAddress,
            remoteAddress: accepted.remoteAddress,
          }))
        )
      )
    );
  }

  connectTcp(
    process: TraceKernelProcess,
    fd: number,
    address: TraceKernelTcpAddress
  ): Effect.Effect<TraceKernelTcpConnectResult, Error> {
    return Effect.all({
      socket: this.tcpSocketFor(process, fd),
      nonblocking: process.descriptors.getNonblocking(fd),
    }).pipe(
      Effect.flatMap(({ socket, nonblocking }) =>
        nonblocking
          ? socket.connectNonblocking(address)
          : socket.connect(address)
      )
    );
  }

  tcpSocketError(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<TraceKernelNetworkError['code'] | undefined, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.takeConnectError())
    );
  }

  shutdownTcp(
    process: TraceKernelProcess,
    fd: number,
    how: TraceKernelTcpShutdownHow
  ): Effect.Effect<void, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.shutdown(how))
    );
  }

  tcpLocalAddress(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<TraceKernelTcpAddress, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.localAddress())
    );
  }

  tcpRemoteAddress(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<TraceKernelTcpAddress, Error> {
    return this.tcpSocketFor(process, fd).pipe(
      Effect.flatMap((socket) => socket.remoteAddress())
    );
  }

  openFile(
    process: TraceKernelProcess,
    path: string,
    options: TraceKernelOpenFileOptions = {}
  ): Effect.Effect<number, TraceKernelProcessStateError | Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const resourceId = `file-${this.nextResourceId++}`;
      const description = yield* TraceKernelOpenFileDescription.make(
        resourceId,
        this.fileSystem,
        path,
        process.snapshot().cwd,
        options,
        (closedId) => this.resources.delete(closedId)
      );
      this.resources.set(resourceId, description);
      return yield* this.installDescriptor(process, description.descriptor());
    });
  }

  authorizeFileSystem(
    process: TraceKernelProcess,
    accesses: readonly {
      readonly path: string;
      readonly permission: TraceKernelFileSystemPermission;
    }[]
  ): Effect.Effect<void, Error> {
    if (!this.fileSystemPolicy || accesses.length === 0) return Effect.void;
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const snapshot = process.snapshot();
      const normalized = yield* Effect.forEach(
        accesses,
        (access): Effect.Effect<TraceKernelFileSystemAccess, Error> =>
          this.normalizePolicyAccess(access.path, access.permission, snapshot.cwd)
      );
      yield* this.fileSystemPolicy!.authorize(Object.freeze({
        pid: snapshot.pid,
        cwd: snapshot.cwd,
        owner: snapshot.owner,
        accesses: Object.freeze(normalized),
      }));
    });
  }

  watchFile(
    process: TraceKernelProcess,
    path: string,
    options: TraceKernelWatchOptions = {}
  ): Effect.Effect<number, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const resolved = yield* this.fileSystem.resolve(path, process.snapshot().cwd);
      const stat = yield* this.fileSystem.stat(resolved, '/');
      const descriptor = yield* this.watchRegistry.create(
        resolved,
        stat.kind === 'directory',
        options
      );
      return yield* this.installDescriptor(process, descriptor);
    });
  }

  readFile(path: string): Effect.Effect<Uint8Array, Error> {
    return this.fileSystem.readFile(path, this.cwd);
  }

  writeFile(path: string, contents: Uint8Array): Effect.Effect<void, Error> {
    return this.fileSystem.writeFile(path, contents, this.cwd);
  }

  stat(path: string): Effect.Effect<TraceKernelStat, Error> {
    return this.fileSystem.stat(path, this.cwd);
  }

  lstat(path: string): Effect.Effect<TraceKernelStat, Error> {
    return this.fileSystem.lstat(path, this.cwd);
  }

  realpath(path: string): Effect.Effect<string, Error> {
    return this.fileSystem.realpath(path, this.cwd);
  }

  readdir(path: string): Effect.Effect<readonly TraceKernelDirectoryEntry[], Error> {
    return this.fileSystem.readdir(path, this.cwd);
  }

  mkdir(
    path: string,
    options: TraceKernelMkdirOptions = {}
  ): Effect.Effect<void, Error> {
    return this.fileSystem.mkdir(path, options, this.cwd);
  }

  rmdir(path: string): Effect.Effect<void, Error> {
    return this.fileSystem.rmdir(path, this.cwd);
  }

  unlink(path: string): Effect.Effect<void, Error> {
    return this.fileSystem.unlink(path, this.cwd);
  }

  link(existingPath: string, newPath: string): Effect.Effect<void, Error> {
    return this.fileSystem.link(existingPath, newPath, this.cwd);
  }

  symlink(target: string, linkPath: string): Effect.Effect<void, Error> {
    return this.fileSystem.symlink(target, linkPath, this.cwd);
  }

  readlink(path: string): Effect.Effect<string, Error> {
    return this.fileSystem.readlink(path, this.cwd);
  }

  rename(sourcePath: string, destinationPath: string): Effect.Effect<void, Error> {
    return this.fileSystem.rename(sourcePath, destinationPath, this.cwd);
  }

  fileSnapshots(): readonly TraceKernelFileSnapshot[] {
    return this.fileSystem.snapshots();
  }

  get fileSystemGeneration(): number {
    return this.fileSystem.mutationGeneration;
  }

  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      const processes = [...this.processes.values()];
      return Effect.forEach(
        processes,
        (process) => process.signal('SIGKILL'),
        { concurrency: 'unbounded', discard: true }
      ).pipe(
        Effect.andThen(Effect.forEach(
          [...this.resources.values()],
          (resource) => resource.dispose(),
          { concurrency: 'unbounded', discard: true }
        )),
        Effect.andThen(this.networkNamespace.dispose()),
        Effect.andThen(Scope.close(this.scope, Exit.void)),
        Effect.ensuring(Effect.sync(() => {
          this.stopWatchingFileSystemMutations();
          this.processes.clear();
          this.exitedChildren.clear();
          this.waitingChildren.clear();
          this.reapedBeforeUnregister.clear();
          this.childWaiters.clear();
          this.processWatchdogs.clear();
          this.controllingTerminalsBySession.clear();
          this.resources.clear();
          if (this.ownsFileSystem) this.fileSystem.clear();
          this.host.unregisterSession(
            this.id,
            this.ownsFileSystem ? undefined : this.fileSystem
          );
        }))
      );
    });
  }

  private registerProcess(
    spec: TraceKernelProcessSpec,
    started: Deferred.Deferred<void, TraceKernelProcessStateError>
  ): TraceKernelProcess {
    if (this.closed) {
      throw new TraceKernelSessionClosedError({
        sessionId: this.id,
        message: `TraceKernel session ${this.id} is closed.`,
      });
    }
    if (this.processes.size + this.exitedChildren.size >= this.maxProcesses) {
      throw new TraceKernelProcessLimitError({
        code: 'EAGAIN',
        maxProcesses: this.maxProcesses,
        message: `EAGAIN: session process limit ${this.maxProcesses} reached`,
      });
    }
    const ppid = spec.parentPid ?? 1;
    const parent = ppid === 1 ? undefined : this.processes.get(ppid);
    if (ppid !== 1 && !parent) {
      throw new TraceKernelProcessStateError({
        pid: ppid,
        message: `ESRCH: parent process ${ppid} does not exist in session ${this.id}`,
      });
    }
    const pid = this.nextPid;
    const parentSnapshot = parent?.snapshot();
    if (
      spec.sessionId !== undefined &&
      (!Number.isSafeInteger(spec.sessionId) || spec.sessionId < 0)
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'sessionId',
        message: `EINVAL: invalid session id ${spec.sessionId}`,
      });
    }
    if (
      spec.processGroupId !== undefined &&
      (!Number.isSafeInteger(spec.processGroupId) || spec.processGroupId < 0)
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'processGroupId',
        message: `EINVAL: invalid process group id ${spec.processGroupId}`,
      });
    }
    const startsNewSession = spec.sessionId === 0;
    const inheritedSid = parentSnapshot?.sid ?? pid;
    if (
      parent &&
      spec.sessionId !== undefined &&
      !startsNewSession &&
      spec.sessionId !== inheritedSid
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'sessionId',
        message: `EINVAL: child session ${spec.sessionId} does not match parent session ${inheritedSid}`,
      });
    }
    const sid = startsNewSession
      ? pid
      : parent
        ? inheritedSid
        : spec.sessionId ?? inheritedSid;
    const pgid = startsNewSession || spec.processGroupId === 0
      ? pid
      : spec.processGroupId ?? parentSnapshot?.pgid ?? pid;
    if (
      pgid !== pid &&
      ![...this.processes.values()].some((candidate) => {
        const snapshot = candidate.snapshot();
        return snapshot.pgid === pgid && snapshot.sid === sid;
      })
    ) {
      throw new TraceKernelInvalidArgumentError({
        code: 'EINVAL',
        argument: 'processGroupId',
        message: `EINVAL: process group ${pgid} does not exist in session ${sid}`,
      });
    }
    this.nextPid += 1;
    const controllingTerminalId = !startsNewSession
      ? parentSnapshot?.controllingTerminalId ??
        this.controllingTerminalsBySession.get(sid)
      : undefined;
    const record: MutableProcessRecord = {
      pid,
      ppid,
      pgid,
      sid,
      ...(controllingTerminalId === undefined
        ? {}
        : { controllingTerminalId }),
      phase: 'created',
      runtime: spec.runtime,
      command: spec.command,
      args: Object.freeze([...(spec.args ?? [])]),
      cwd: spec.cwd ?? this.cwd,
      env: Object.freeze({ ...this.env, ...(spec.env ?? {}) }),
      owner: spec.owner ?? SYSTEM_PRINCIPAL,
      protected: spec.protected ?? false,
      visible: spec.visible ?? true,
      stdout: '',
      stderr: '',
    };
    const process = new TraceKernelProcess(
      record,
      started,
      this.maxDescriptorsPerProcess,
      this.signalGracePeriodMs
    );
    this.processes.set(pid, process);
    return process;
  }

  private normalizePolicyAccess(
    path: string,
    permission: TraceKernelFileSystemPermission,
    cwd: string
  ): Effect.Effect<TraceKernelFileSystemAccess, Error> {
    return Effect.gen(this, function* () {
      const requestedPath = yield* this.fileSystem.resolve(path, cwd);
      const resolved = yield* Effect.either(this.fileSystem.realpath(requestedPath, '/'));
      if (resolved._tag === 'Right') {
        return Object.freeze({
          requestedPath,
          path: resolved.right,
          permission,
        });
      }
      if (resolved.left.code !== 'ENOENT') return yield* Effect.fail(resolved.left);
      const separator = requestedPath.lastIndexOf('/');
      const parent = separator <= 0 ? '/' : requestedPath.slice(0, separator);
      const name = requestedPath.slice(separator + 1);
      const realParent = yield* this.fileSystem.realpath(parent, '/');
      return Object.freeze({
        requestedPath,
        path: realParent === '/' ? `/${name}` : `${realParent}/${name}`,
        permission,
      });
    });
  }

  private unregisterProcess(pid: number): void {
    const exited = this.processes.get(pid);
    this.processes.delete(pid);
    const alreadyReaped = this.reapedBeforeUnregister.delete(pid);
    if (exited) {
      const snapshot = exited.snapshot();
      if (snapshot.ppid !== 1 && !alreadyReaped) {
        this.exitedChildren.set(pid, exited);
      }
    }
    for (const process of this.processes.values()) {
      process.reparent(pid, 1);
    }
    for (const [childPid, child] of this.exitedChildren) {
      if (childPid === pid) continue;
      if (child.snapshot().ppid === pid) {
        child.reparent(pid, 1);
        this.exitedChildren.delete(childPid);
      }
    }
    Effect.runSync(this.notifyChildWaiters());
  }

  private notifyChildWaiters(): Effect.Effect<void> {
    return Effect.forEach(
      [...this.childWaiters],
      (waiter) => Deferred.succeed(waiter, undefined),
      { concurrency: 'unbounded', discard: true }
    );
  }

  private inheritProcessDescriptors(
    process: TraceKernelProcess,
    spec: TraceKernelProcessSpec
  ): Effect.Effect<void, TraceKernelProcessStateError | TraceKernelDescriptorInheritanceError> {
    if (
      spec.inheritDescriptors === undefined &&
      (spec.descriptorMappings?.length ?? 0) === 0
    ) {
      return Effect.void;
    }
    const parentPid = spec.parentPid ?? 1;
    const parent = this.processes.get(parentPid);
    if (!parent || parent === process) {
      return Effect.fail(new TraceKernelProcessStateError({
        pid: parentPid,
        message: `ESRCH: descriptor inheritance requires a live parent process in session ${this.id}`,
      }));
    }
    return Effect.gen(function* () {
      if (spec.inheritDescriptors !== undefined) {
        yield* process.descriptors.inherit(
          parent.descriptors,
          spec.inheritDescriptors === 'all' ? undefined : spec.inheritDescriptors
        );
      }
      if (spec.descriptorMappings && spec.descriptorMappings.length > 0) {
        yield* process.descriptors.inheritMapped(
          parent.descriptors,
          spec.descriptorMappings.map(({ parentFd, childFd }) => ({
            sourceFd: parentFd,
            targetFd: childFd,
          }))
        );
      }
    });
  }

  private applyProcessDescriptorActions(
    process: TraceKernelProcess,
    spec: TraceKernelProcessSpec
  ): Effect.Effect<void, TraceKernelDescriptorInheritanceError> {
    return Effect.forEach(
      spec.descriptorActions ?? [],
      (action) => action.op === 'dup2'
        ? process.dup2(action.fd, action.targetFd).pipe(Effect.asVoid)
        : process.close(action.fd),
      { concurrency: 1, discard: true }
    );
  }

  private assertOwnedProcess(
    process: TraceKernelProcess
  ): Effect.Effect<void, TraceKernelProcessStateError> {
    return !this.closed && this.processes.get(process.pid) === process
      ? Effect.void
      : Effect.fail(new TraceKernelProcessStateError({
          pid: process.pid,
          message: this.closed
            ? `Session ${this.id} is closed.`
            : `Process ${process.pid} is not running in session ${this.id}.`,
        }));
  }

  private tcpSocketFor(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<
    TraceKernelTcpSocket,
    TraceKernelProcessStateError | TraceKernelBadFileDescriptorError | TraceKernelNetworkError
  > {
    return this.assertOwnedProcess(process).pipe(
      Effect.andThen(process.descriptors.lookup(fd)),
      Effect.flatMap((descriptor) => descriptor.resource instanceof TraceKernelTcpSocket
        ? Effect.succeed(descriptor.resource)
        : Effect.fail(new TraceKernelNetworkError({
            code: 'EOPNOTSUPP',
            message: `EOPNOTSUPP: descriptor ${fd} is not a TCP socket`,
          })))
    );
  }

  private terminalById(
    terminalId: string
  ): Effect.Effect<TraceKernelTerminal, TraceKernelTerminalError> {
    const resource = this.resources.get(terminalId);
    return resource instanceof TraceKernelTerminal
      ? Effect.succeed(resource)
      : Effect.fail(new TraceKernelTerminalError({
          code: 'ENOTTY',
          message: `ENOTTY: terminal ${terminalId} does not exist`,
        }));
  }

  private controllingTerminalForDescriptor(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<TraceKernelTerminal, Error> {
    return Effect.gen(this, function* () {
      yield* this.assertOwnedProcess(process);
      const descriptor = yield* process.descriptors.lookup(fd);
      if (!(descriptor.resource instanceof TraceKernelTerminal)) {
        return yield* Effect.fail(new TraceKernelTerminalError({
          code: 'ENOTTY',
          message: `ENOTTY: descriptor ${fd} is not a terminal`,
        }));
      }
      const snapshot = process.snapshot();
      if (
        snapshot.sid !== descriptor.resource.sessionId ||
        snapshot.controllingTerminalId !== descriptor.resource.id
      ) {
        return yield* Effect.fail(new TraceKernelTerminalError({
          code: 'ENOTTY',
          message: `ENOTTY: terminal descriptor ${fd} is not controlling process ${process.pid}`,
        }));
      }
      return descriptor.resource;
    });
  }

  private runtimeContext(process: TraceKernelProcess): TraceKernelRuntimeProcessContext {
    const snapshot = process.snapshot();
    return Object.freeze({
      pid: snapshot.pid,
      ppid: snapshot.ppid,
      pgid: snapshot.pgid,
      sid: snapshot.sid,
      ...(snapshot.controllingTerminalId === undefined
        ? {}
        : { controllingTerminalId: snapshot.controllingTerminalId }),
      command: snapshot.command,
      args: snapshot.args,
      cwd: snapshot.cwd,
      env: snapshot.env,
    });
  }

  private installDescriptor(
    process: TraceKernelProcess,
    descriptor: TraceKernelDescriptor,
    fd?: number,
    options: {
      readonly closeOnExec?: boolean;
      readonly nonblocking?: boolean;
    } = {}
  ): Effect.Effect<number, TraceKernelDescriptorLimitError> {
    return Effect.try({
      try: () => fd === undefined
        ? process.descriptors.install(descriptor, options)
        : process.descriptors.installAt(fd, descriptor, options),
      catch: (error) => error instanceof TraceKernelDescriptorLimitError
        ? error
        : new TraceKernelDescriptorLimitError({
            code: 'EMFILE',
            maxDescriptors: process.descriptors.maxDescriptors,
            message: error instanceof Error ? error.message : String(error),
          }),
    }).pipe(
      Effect.tapError(() => descriptor.close())
    );
  }
}

export class TraceKernelHost {
  private readonly sessions = new Map<string, TraceKernelSession>();
  private readonly claimedFileSystems = new WeakSet<TraceKernelFileSystem>();
  private nextSessionId = 1;
  private closed = false;

  constructor(
    private readonly providerSlots: ReadonlyMap<TraceKernelRuntimeName, TraceKernelRuntimeProviderSlot>
  ) {}

  openSession(
    options: TraceKernelSessionOptions = {}
  ): Effect.Effect<
    TraceKernelSession,
    TraceKernelHostClosedError | TraceKernelFileSystemError,
    Scope.Scope
  > {
    return Effect.gen(this, function* () {
      if (this.closed) {
        return yield* Effect.fail(new TraceKernelHostClosedError({
          message: 'TraceKernel host is closed.',
        }));
      }
      const cwd = options.cwd ?? '/workspace';
      if (options.fileSystem && options.fileSystemImage) {
        return yield* Effect.fail(new TraceKernelFileSystemError({
          code: 'EINVAL',
          path: cwd,
          message: 'EINVAL: fileSystem and fileSystemImage are mutually exclusive',
        }));
      }
      const ownsFileSystem = options.fileSystem === undefined;
      const fileSystem = options.fileSystem ??
        (options.fileSystemImage
          ? yield* TraceKernelFileSystem.fromImage(options.fileSystemImage)
          : yield* TraceKernelFileSystem.make());
      const cwdStat = yield* fileSystem.stat(cwd, '/');
      if (cwdStat.kind !== 'directory') {
        return yield* Effect.fail(new TraceKernelFileSystemError({
          code: 'ENOTDIR',
          path: cwd,
          message: `ENOTDIR: session cwd is not a directory ${JSON.stringify(cwd)}`,
        }));
      }
      const networkNamespace = yield* TraceKernelNetworkNamespace.make();
      const sessionScope = yield* Scope.make();
      return yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (!ownsFileSystem) {
              if (this.claimedFileSystems.has(fileSystem)) {
                throw new TraceKernelFileSystemError({
                  code: 'EBUSY',
                  path: cwd,
                  message: 'EBUSY: TKFS is already claimed by a live session',
                });
              }
              this.claimedFileSystems.add(fileSystem);
            }
            const id = `session-${this.nextSessionId++}`;
            try {
              const session = new TraceKernelSession(
                id,
                this,
                sessionScope,
                fileSystem,
                networkNamespace,
                cwd,
                Object.freeze({ ...(options.env ?? {}) }),
                normalizeDescriptorLimit(options.maxDescriptorsPerProcess),
                normalizeProcessLimit(options.maxProcesses),
                normalizeSignalGracePeriod(options.signalGracePeriodMs),
                ownsFileSystem,
                options.fileSystemPolicy
              );
              this.sessions.set(id, session);
              return session;
            } catch (error) {
              if (!ownsFileSystem) this.claimedFileSystems.delete(fileSystem);
              throw error;
            }
          },
          catch: (error) =>
            error instanceof TraceKernelFileSystemError
              ? error
              : new TraceKernelFileSystemError({
                  code: 'EINVAL',
                  path: cwd,
                  message: error instanceof Error ? error.message : String(error),
                }),
        }),
        (session) => session.shutdown()
      );
    });
  }

  sessionIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  acquireRuntimeLease(
    runtime: TraceKernelRuntimeName,
    process: TraceKernelRuntimeProcessContext
  ): Effect.Effect<
    TraceKernelRuntimeLease,
    TraceKernelRuntimeUnavailableError | Error,
    Scope.Scope
  > {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(new TraceKernelHostClosedError({
          message: 'TraceKernel host is closed.',
        }));
      }
      const slot = this.providerSlots.get(runtime);
      if (!slot) {
        return Effect.fail(new TraceKernelRuntimeUnavailableError({
          runtime,
          message: `Runtime provider ${JSON.stringify(runtime)} is not registered.`,
        }));
      }
      return slot.initialize.pipe(
        Effect.flatMap((factory) => factory.acquire(process))
      );
    });
  }

  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      return Effect.forEach(
        [...this.sessions.values()],
        (session) => session.shutdown(),
        { concurrency: 'unbounded', discard: true }
      ).pipe(
        Effect.ensuring(Effect.sync(() => this.sessions.clear()))
      );
    });
  }

  unregisterSession(id: string, fileSystem?: TraceKernelFileSystem): void {
    this.sessions.delete(id);
    if (fileSystem) this.claimedFileSystems.delete(fileSystem);
  }
}

function makeProviderSlots(
  providers: readonly TraceKernelRuntimeProvider[]
): Effect.Effect<ReadonlyMap<TraceKernelRuntimeName, TraceKernelRuntimeProviderSlot>> {
  return Effect.forEach(providers, (provider) =>
    Effect.cached(provider.initialize).pipe(
      Effect.map((initialize) => [provider.runtime, { provider, initialize }] as const)
    )
  ).pipe(
    Effect.map((entries) => new Map(entries))
  );
}

/**
 * Acquire a host as a scoped resource.
 *
 * Provider initialization is memoized but remains lazy: constructing a host or
 * opening a session does not initialize any language runtime.
 */
export function makeTraceKernelHost(
  options: TraceKernelHostOptions = {}
): Effect.Effect<TraceKernelHost, never, Scope.Scope> {
  return Effect.acquireRelease(
    makeProviderSlots(options.providers ?? []).pipe(
      Effect.map((slots) => new TraceKernelHost(slots))
    ),
    (host) => host.shutdown()
  );
}
