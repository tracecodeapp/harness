import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import {
  TraceKernelPipe,
  type TraceKernelDescriptor,
  type TraceKernelDescriptorInheritanceError,
  type TraceKernelPipeOptions,
} from '../descriptors';
import {
  makeTraceKernelNullDescriptor,
  type TraceKernelDeviceAccess,
} from '../devices';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelChildProcessError,
  TraceKernelDescriptorLimitError,
  TraceKernelInvalidArgumentError,
  TraceKernelProcessLimitError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
  TraceKernelSessionClosedError,
  TraceKernelNetworkError,
} from '../errors';
import {
  TraceKernelNetworkNamespace,
  TraceKernelTcpSocket,
  type TraceKernelTcpAcceptResult,
  type TraceKernelTcpAddress,
  type TraceKernelTcpConnectResult,
  type TraceKernelTcpListenOptions,
  type TraceKernelTcpShutdownHow,
} from '../network';
import type {
  TraceKernelFileSystemAccess,
  TraceKernelFileSystemPermission,
  TraceKernelFileSystemPolicy,
  TraceKernelPrincipal,
  TraceKernelProcessSchedulingState,
  TraceKernelProcessSnapshot,
  TraceKernelProcessSpec,
  TraceKernelSignal,
  TraceKernelWatchdogSignal,
  TraceKernelWatchdogSnapshot,
} from '../model';
import {
  TraceKernelFileSystem,
  TraceKernelOpenFileDescription,
  type TraceKernelDirectoryEntry,
  type TraceKernelFileSystemImage,
  type TraceKernelFileSnapshot,
  type TraceKernelMkdirOptions,
  type TraceKernelOpenFileOptions,
  type TraceKernelStat,
} from '../vfs';
import {
  TraceKernelSyscallDispatcher,
  type TraceKernelProcessInfo,
  type TraceKernelSpawnParentStdio,
  type TraceKernelSpawnStdio,
} from '../syscalls';
import {
  TraceKernelTerminal,
  type TraceKernelTerminalAccess,
  type TraceKernelTerminalOptions,
  type TraceKernelTerminalSnapshot,
} from '../terminal';
import {
  TraceKernelWatchRegistry,
  type TraceKernelWatchOptions,
} from '../watch';

import type { TraceKernelHost } from './host';
import {
  SYSTEM_PRINCIPAL,
  TraceKernelProcess,
  type TraceKernelHostStandardIo,
} from './process';
import { TraceKernelProcessTable } from './process-table';
import { TraceKernelProcessWatchdogs } from './process-watchdogs';
import { TraceKernelResourceRegistry } from './resources';
import { executeProcessWithRuntimeLease } from './runtime-execution';
import { TraceKernelTerminals } from './terminals';

export class TraceKernelSession {
  private readonly processTable: TraceKernelProcessTable;
  private readonly processWatchdogs: TraceKernelProcessWatchdogs;
  private readonly terminals: TraceKernelTerminals;
  private readonly watchRegistry = new TraceKernelWatchRegistry();
  private readonly stopWatchingFileSystemMutations: () => void;
  private readonly resources = new TraceKernelResourceRegistry();
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
    const controllingTerminalsBySession = new Map<number, string>();
    this.processTable = new TraceKernelProcessTable({
      sessionId: id,
      cwd,
      env,
      maxDescriptorsPerProcess,
      maxProcesses,
      signalGracePeriodMs,
      controllingTerminalForSession: (sessionId) =>
        controllingTerminalsBySession.get(sessionId),
    });
    this.terminals = new TraceKernelTerminals(
      this.processTable,
      this.resources,
      controllingTerminalsBySession,
      (process, descriptor, fd, options) =>
        this.installDescriptor(process, descriptor, fd, options)
    );
    this.processWatchdogs = new TraceKernelProcessWatchdogs(scope);
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
        try: () => this.processTable.register(spec, started),
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
      yield* this.processTable.inheritDescriptors(process, spec).pipe(
        Effect.tapError(() =>
          process.descriptors.closeAll().pipe(
            Effect.ensuring(Effect.sync(() => this.processTable.unregister(process.pid)))
          )
        )
      );
      if (prepare) {
        yield* prepare(process).pipe(
          Effect.tapError(() =>
            process.descriptors.closeAll().pipe(
              Effect.ensuring(Effect.sync(() => this.processTable.unregister(process.pid)))
            )
          )
        );
      }
      yield* this.applyProcessDescriptorActions(process, spec).pipe(
        Effect.tapError(() =>
          process.descriptors.closeAll().pipe(
            Effect.ensuring(Effect.sync(() => this.processTable.unregister(process.pid)))
          )
        )
      );
      process.markStarting();

      const program = executeProcessWithRuntimeLease(
        process,
        this.id,
        new TraceKernelSyscallDispatcher(this, process),
        (context) => this.host.acquireRuntimeLease(spec.runtime, context)
      ).pipe(
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
        ),
        Effect.ensuring(this.clearProcessWatchdog(process)),
        Effect.ensuring(process.descriptors.closeAll()),
        Effect.ensuring(Effect.sync(() => this.processTable.unregister(process.pid)))
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
      yield* this.processTable.assertOwned(parent);
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
      yield* this.processTable.assertOwned(parent);
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
    return this.processTable.waitChild(parent, pid, options);
  }

  waitInitChild(
    pid: number,
    options: { readonly noHang?: boolean } = {}
  ): Effect.Effect<
    TraceKernelProcessSnapshot | undefined,
    TraceKernelProcessStateError | TraceKernelChildProcessError
  > {
    return this.processTable.waitInitChild(pid, options);
  }

  execute(
    spec: TraceKernelProcessSpec
  ): Effect.Effect<
    TraceKernelProcessSnapshot,
      TraceKernelSessionClosedError |
      TraceKernelProcessLimitError |
      TraceKernelProcessStateError |
      TraceKernelChildProcessError |
      TraceKernelInvalidArgumentError |
      TraceKernelDescriptorInheritanceError
  > {
    return Effect.gen(this, function* () {
      const process = yield* this.spawn(spec);
      const snapshot = yield* process.wait();
      if (snapshot.ppid === 1 && spec.retainOnExit === true) {
        yield* this.waitInitChild(snapshot.pid);
      }
      return snapshot;
    });
  }

  processSnapshots(
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): readonly TraceKernelProcessSnapshot[] {
    return this.processTable.processSnapshots(requester);
  }

  processTableSnapshots(
    requester: TraceKernelPrincipal = SYSTEM_PRINCIPAL
  ): readonly TraceKernelProcessSnapshot[] {
    return this.processTable.processTableSnapshots(requester);
  }

  setProcessSchedulingState(
    process: TraceKernelProcess,
    state: TraceKernelProcessSchedulingState
  ): Effect.Effect<TraceKernelProcessSchedulingState, TraceKernelProcessStateError> {
    return this.processTable.setSchedulingState(process, state);
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
    return this.processTable.processIdentity(caller, requestedPid);
  }

  processInfo(
    caller: TraceKernelProcess,
    requestedPid?: number
  ): Effect.Effect<TraceKernelProcessInfo, TraceKernelProcessStateError> {
    return this.processTable.processInfo(caller, requestedPid);
  }

  processList(
    caller: TraceKernelProcess
  ): Effect.Effect<readonly TraceKernelProcessInfo[], TraceKernelProcessStateError> {
    return this.processTable.processList(caller);
  }

  processEnvironment(
    caller: TraceKernelProcess
  ): Effect.Effect<
    Readonly<Record<string, string>>,
    TraceKernelProcessStateError
  > {
    return this.processTable.processEnvironment(caller);
  }

  createProcessSession(
    process: TraceKernelProcess
  ): Effect.Effect<
    number,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return this.processTable.createProcessSession(process);
  }

  createControllingTerminal(
    process: TraceKernelProcess,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<
    TraceKernelTerminal,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return this.terminals.createControllingTerminal(process, options);
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
    return this.terminals.bootstrapSessionTerminal(process, options);
  }

  openTerminal(
    process: TraceKernelProcess,
    terminalId: string,
    access: TraceKernelTerminalAccess = 'read-write',
    fd?: number
  ): Effect.Effect<number, Error> {
    return this.terminals.openTerminal(process, terminalId, access, fd);
  }

  attachTerminalStdio(
    process: TraceKernelProcess,
    terminalId: string
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return this.terminals.attachTerminalStdio(process, terminalId);
  }

  replaceTerminalStdio(
    process: TraceKernelProcess,
    terminalId: string
  ): Effect.Effect<{
    readonly stdinFd: 0;
    readonly stdoutFd: 1;
    readonly stderrFd: 2;
  }, Error> {
    return this.terminals.replaceTerminalStdio(process, terminalId);
  }

  isTerminal(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<
    boolean,
    TraceKernelProcessStateError | TraceKernelBadFileDescriptorError
  > {
    return this.terminals.isTerminal(process, fd);
  }

  terminalForegroundProcessGroup(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<number, Error> {
    return this.terminals.terminalForegroundProcessGroup(process, fd);
  }

  setTerminalForegroundProcessGroup(
    process: TraceKernelProcess,
    fd: number,
    processGroupId: number
  ): Effect.Effect<number, Error> {
    return this.terminals.setTerminalForegroundProcessGroup(process, fd, processGroupId);
  }

  terminalWindowSize(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<{ readonly rows: number; readonly columns: number }, Error> {
    return this.terminals.terminalWindowSize(process, fd);
  }

  setTerminalWindowSize(
    process: TraceKernelProcess,
    fd: number,
    rows: number,
    columns: number
  ): Effect.Effect<{ readonly rows: number; readonly columns: number }, Error> {
    return this.terminals.setTerminalWindowSize(process, fd, rows, columns);
  }

  signalTerminalForeground(
    terminalId: string,
    signal: TraceKernelSignal
  ): Effect.Effect<void, Error> {
    return this.terminals.signalTerminalForeground(terminalId, signal);
  }

  writeTerminalInput(
    terminalId: string,
    bytes: Uint8Array
  ): Effect.Effect<number, Error> {
    return this.terminals.writeTerminalInput(terminalId, bytes);
  }

  sendTerminalInputEof(terminalId: string): Effect.Effect<void, Error> {
    return this.terminals.sendTerminalInputEof(terminalId);
  }

  readTerminalOutput(
    terminalId: string,
    maxBytes: number,
    nonblocking = false
  ): Effect.Effect<Uint8Array, Error> {
    return this.terminals.readTerminalOutput(terminalId, maxBytes, nonblocking);
  }

  resizeTerminal(
    terminalId: string,
    columns: number,
    rows: number
  ): Effect.Effect<TraceKernelTerminalSnapshot, Error> {
    return this.terminals.resizeTerminal(terminalId, columns, rows);
  }

  releaseTerminalForegroundToHost(
    terminalId: string,
    expectedProcessGroupId: number
  ): Effect.Effect<number, Error> {
    return this.terminals.releaseTerminalForegroundToHost(terminalId, expectedProcessGroupId);
  }

  closeTerminal(terminalId: string): Effect.Effect<void, Error> {
    return this.terminals.closeTerminal(terminalId);
  }

  terminalSnapshots(): readonly TraceKernelTerminalSnapshot[] {
    return this.terminals.terminalSnapshots();
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
    return this.processTable.setProcessGroup(caller, targetPid, processGroupId);
  }

  signalProcess(
    requester: TraceKernelPrincipal,
    pid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return this.processTable.signalProcess(requester, pid, signal);
  }

  signalProcessTarget(
    requester: TraceKernelPrincipal,
    caller: TraceKernelProcess,
    targetPid: number,
    signal: TraceKernelSignal
  ): Effect.Effect<
    void,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return this.processTable.signalProcessTarget(
      requester,
      caller,
      targetPid,
      signal
    );
  }

  openNullDevice(
    process: TraceKernelProcess,
    access: TraceKernelDeviceAccess,
    fd?: number
  ): Effect.Effect<number, TraceKernelProcessStateError | TraceKernelDescriptorLimitError> {
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
      const descriptorId = this.resources.allocateId(
        `null-${process.pid}-${fd ?? 'auto'}`
      );
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
      yield* this.processTable.assertOwned(process);
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
      yield* this.processTable.assertOwned(process);
      const resourcePrefix = this.resources.allocateId(
        `null-${process.pid}-replace`
      );
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

  attachHostStandardIo(
    process: TraceKernelProcess,
    options: TraceKernelPipeOptions = {}
  ): Effect.Effect<TraceKernelHostStandardIo, Error> {
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
      const createPipe = (stream: 'stdin' | 'stdout' | 'stderr') =>
        TraceKernelPipe.make(
          this.resources.allocateId(`host-${stream}-${process.pid}`),
          options,
          (closedId) => this.resources.delete(closedId)
        ).pipe(
          Effect.tap((pipe) =>
            Effect.sync(() => this.resources.set(pipe.id, pipe))
          )
        );
      const stdin = yield* createPipe('stdin');
      const stdout = yield* createPipe('stdout').pipe(
        Effect.tapError(() => stdin.dispose())
      );
      const stderr = yield* createPipe('stderr').pipe(
        Effect.tapError(() =>
          Effect.all([stdin.dispose(), stdout.dispose()], {
            concurrency: 'unbounded',
            discard: true,
          })
        )
      );
      const hostStdin = stdin.writer();
      const hostStdout = stdout.reader();
      const hostStderr = stderr.reader();
      yield* process.descriptors.replaceMany([
        { fd: 0, descriptor: stdin.reader() },
        { fd: 1, descriptor: stdout.writer() },
        { fd: 2, descriptor: stderr.writer() },
      ]).pipe(
        Effect.tapError(() =>
          Effect.all(
            [hostStdin.close(), hostStdout.close(), hostStderr.close()],
            { concurrency: 'unbounded', discard: true }
          )
        )
      );
      return Object.freeze({
        stdinResourceId: stdin.id,
        stdoutResourceId: stdout.id,
        stderrResourceId: stderr.id,
        writeStdin: (bytes: Uint8Array) => hostStdin.write(bytes),
        closeStdin: () => hostStdin.close(),
        readStdout: (maxBytes: number) =>
          hostStdout.read(Math.max(0, Math.floor(maxBytes))),
        readStderr: (maxBytes: number) =>
          hostStderr.read(Math.max(0, Math.floor(maxBytes))),
        closeStdout: () => hostStdout.close(),
        closeStderr: () => hostStderr.close(),
        close: () =>
          Effect.all(
            [hostStdin.close(), hostStdout.close(), hostStderr.close()],
            { concurrency: 'unbounded', discard: true }
          ),
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
      yield* this.processTable.assertOwned(process);
      return yield* this.processWatchdogs.configure(process, action, options);
    });
  }

  private clearProcessWatchdog(
    process: TraceKernelProcess
  ): Effect.Effect<void> {
    return this.processWatchdogs.clear(process);
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
      yield* this.processTable.assertOwned(reader);
      yield* this.processTable.assertOwned(writer);
      const resourceId = this.resources.allocateId('pipe');
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
      yield* this.processTable.assertOwned(process);
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
      yield* this.processTable.assertOwned(process);
      const resourceId = this.resources.allocateId('file');
      const description = yield* TraceKernelOpenFileDescription.make(
        resourceId,
        this.fileSystem,
        path,
        process.snapshot().cwd,
        options,
        (closedId) => this.resources.delete(closedId),
        { origin: process.fileSystemMutationOrigin }
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
      /** Whether policy canonicalization follows the final symlink. */
      readonly followFinal?: boolean;
      /**
       * Resolve the nearest existing ancestor and preserve the unresolved
       * suffix. Only recursive namespace operations should set this.
       */
      readonly allowMissingSuffix?: boolean;
    }[]
  ): Effect.Effect<void, Error> {
    if (!this.fileSystemPolicy || accesses.length === 0) return Effect.void;
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
      const snapshot = process.snapshot();
      const normalized = yield* Effect.forEach(
        accesses,
        (access): Effect.Effect<TraceKernelFileSystemAccess, Error> =>
          this.normalizePolicyAccess(
            access.path,
            access.permission,
            snapshot.cwd,
            access.followFinal !== false,
            access.allowMissingSuffix === true
          )
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
      yield* this.processTable.assertOwned(process);
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

  /**
   * Restore one process-owned execution scope between cases in a leased
   * language runtime. Non-standard descriptors are closed before TKFS rolls
   * back, so no open file or socket can retain authority into the next case.
   */
  resetProcessExecutionScope(
    process: TraceKernelProcess,
    fileSystemImage: TraceKernelFileSystemImage,
    preservedDescriptors: readonly number[] = [0, 1, 2]
  ): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
      yield* this.clearProcessWatchdog(process);
      const descendantPids = new Set<number>([process.pid]);
      const descendants: TraceKernelProcess[] = [];
      let foundDescendant = true;
      while (foundDescendant) {
        foundDescendant = false;
        for (const candidate of this.processTable.activeProcesses()) {
          if (
            candidate === process ||
            descendantPids.has(candidate.pid) ||
            !descendantPids.has(candidate.snapshot().ppid)
          ) {
            continue;
          }
          descendantPids.add(candidate.pid);
          descendants.push(candidate);
          foundDescendant = true;
        }
      }
      yield* Effect.forEach(
        descendants.reverse(),
        (descendant) =>
          descendant.signal('SIGKILL').pipe(
            Effect.catchAll(() => Effect.void)
          ),
        { concurrency: 1, discard: true }
      );
      const preserved = new Set(preservedDescriptors);
      const descriptors = process.descriptors
        .snapshots()
        .map(({ fd }) => fd)
        .filter((fd) => !preserved.has(fd));
      yield* Effect.forEach(
        descriptors,
        (fd) =>
          process.close(fd).pipe(
            Effect.catchAll(() => Effect.void)
          ),
        { concurrency: 'unbounded', discard: true }
      );
      yield* this.fileSystem.restoreQuiescentImage(
        fileSystemImage,
        { origin: process.fileSystemMutationOrigin }
      );
    });
  }

  get fileSystemGeneration(): number {
    return this.fileSystem.mutationGeneration;
  }

  shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      this.closed = true;
      this.processTable.close();
      const processes = this.processTable.activeProcesses();
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
          this.processTable.clear();
          this.processWatchdogs.clearAll();
          this.terminals.clear();
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


  private normalizePolicyAccess(
    path: string,
    permission: TraceKernelFileSystemPermission,
    cwd: string,
    followFinal = true,
    allowMissingSuffix = false
  ): Effect.Effect<TraceKernelFileSystemAccess, Error> {
    return Effect.gen(this, function* () {
      const requestedPath = yield* this.fileSystem.resolve(path, cwd);
      const finalSeparator = requestedPath.lastIndexOf('/');
      let candidate = followFinal || requestedPath === '/'
        ? requestedPath
        : finalSeparator <= 0
          ? '/'
          : requestedPath.slice(0, finalSeparator);
      const missingSuffix: string[] = followFinal || requestedPath === '/'
        ? []
        : [requestedPath.slice(finalSeparator + 1)];
      while (true) {
        const resolved = yield* Effect.either(
          this.fileSystem.realpath(candidate, '/')
        );
        if (resolved._tag === 'Right') {
          const canonicalPath = missingSuffix.length === 0
            ? resolved.right
            : resolved.right === '/'
              ? `/${missingSuffix.join('/')}`
              : `${resolved.right}/${missingSuffix.join('/')}`;
          return Object.freeze({
            requestedPath,
            path: canonicalPath,
            permission,
          });
        }
        if (resolved.left.code !== 'ENOENT') {
          return yield* Effect.fail(resolved.left);
        }
        if (!allowMissingSuffix && missingSuffix.length > 0) {
          return yield* Effect.fail(resolved.left);
        }
        if (candidate === '/') return yield* Effect.fail(resolved.left);
        const separator = candidate.lastIndexOf('/');
        missingSuffix.unshift(candidate.slice(separator + 1));
        candidate = separator <= 0 ? '/' : candidate.slice(0, separator);
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


  private tcpSocketFor(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<
    TraceKernelTcpSocket,
    TraceKernelProcessStateError | TraceKernelBadFileDescriptorError | TraceKernelNetworkError
  > {
    return this.processTable.assertOwned(process).pipe(
      Effect.andThen(process.descriptors.lookup(fd)),
      Effect.flatMap((descriptor) => descriptor.resource instanceof TraceKernelTcpSocket
        ? Effect.succeed(descriptor.resource)
        : Effect.fail(new TraceKernelNetworkError({
            code: 'EOPNOTSUPP',
            message: `EOPNOTSUPP: descriptor ${fd} is not a TCP socket`,
          })))
    );
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
