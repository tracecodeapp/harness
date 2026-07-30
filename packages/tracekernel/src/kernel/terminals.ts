import * as Effect from 'effect/Effect';
import type { TraceKernelDescriptor } from '../descriptors';
import {
  TraceKernelBadFileDescriptorError,
  TraceKernelDescriptorLimitError,
  TraceKernelInvalidArgumentError,
  TraceKernelProcessPermissionError,
  TraceKernelProcessStateError,
  TraceKernelTerminalError,
} from '../errors';
import type { TraceKernelSignal } from '../model';
import {
  TraceKernelTerminal,
  type TraceKernelTerminalAccess,
  type TraceKernelTerminalOptions,
  type TraceKernelTerminalSnapshot,
} from '../terminal';

import type { TraceKernelProcess } from './process';
import type { TraceKernelProcessTable } from './process-table';
import type { TraceKernelResourceRegistry } from './resources';

type InstallDescriptor = (
  process: TraceKernelProcess,
  descriptor: TraceKernelDescriptor,
  fd?: number,
  options?: {
    readonly closeOnExec?: boolean;
    readonly nonblocking?: boolean;
  }
) => Effect.Effect<number, TraceKernelDescriptorLimitError>;

/**
 * Controlling-terminal ownership, job control, byte transport, and descriptor
 * attachment for one session.
 */
export class TraceKernelTerminals {
  constructor(
    private readonly processTable: TraceKernelProcessTable,
    private readonly resources: TraceKernelResourceRegistry,
    private readonly controllingTerminalsBySession: Map<number, string>,
    private readonly installDescriptor: InstallDescriptor
  ) {}

  controllingTerminalForSession(sessionId: number): string | undefined {
    return this.controllingTerminalsBySession.get(sessionId);
  }

  clear(): void {
    this.controllingTerminalsBySession.clear();
  }

  createControllingTerminal(
    process: TraceKernelProcess,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<
    TraceKernelTerminal,
    TraceKernelProcessStateError | TraceKernelProcessPermissionError
  > {
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
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
      const resourceId = this.resources.allocateId('tty');
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processTable.activeProcesses()) {
        if (candidate.snapshot().sid === snapshot.sid) {
          candidate.setControllingTerminal(resourceId);
        }
      }
      return terminal;
    });
  }

  bootstrapSessionTerminal(
    process: TraceKernelProcess,
    options: TraceKernelTerminalOptions = {}
  ): Effect.Effect<TraceKernelTerminal, Error> {
    return Effect.gen(this, function* () {
      yield* this.processTable.assertOwned(process);
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
      const resourceId = this.resources.allocateId('tty');
      const terminal = yield* TraceKernelTerminal.make(
        resourceId,
        snapshot.sid,
        snapshot.pgid,
        options
      );
      this.resources.set(resourceId, terminal);
      this.controllingTerminalsBySession.set(snapshot.sid, resourceId);
      for (const candidate of this.processTable.activeProcesses()) {
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
      yield* this.processTable.assertOwned(process);
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
      yield* this.processTable.assertOwned(process);
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
    return this.processTable.assertOwned(process).pipe(
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
      const member = [...this.processTable.activeProcesses()].find((candidate) => {
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

  terminalWindowSize(
    process: TraceKernelProcess,
    fd: number
  ): Effect.Effect<{ readonly rows: number; readonly columns: number }, Error> {
    return this.controllingTerminalForDescriptor(process, fd).pipe(
      Effect.map((terminal) => {
        const snapshot = terminal.snapshot();
        return Object.freeze({
          rows: snapshot.rows,
          columns: snapshot.columns,
        });
      })
    );
  }

  setTerminalWindowSize(
    process: TraceKernelProcess,
    fd: number,
    rows: number,
    columns: number
  ): Effect.Effect<{ readonly rows: number; readonly columns: number }, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.controllingTerminalForDescriptor(process, fd);
      const normalizedRows = Math.trunc(rows);
      const normalizedColumns = Math.trunc(columns);
      if (
        !Number.isSafeInteger(rows) ||
        !Number.isSafeInteger(columns) ||
        normalizedRows <= 0 ||
        normalizedColumns <= 0
      ) {
        return yield* Effect.fail(new TraceKernelInvalidArgumentError({
          code: 'EINVAL',
          argument: 'windowSize',
          message: `EINVAL: invalid terminal window size ${columns}x${rows}`,
        }));
      }
      terminal.resize(normalizedColumns, normalizedRows);
      yield* this.signalTerminalForeground(terminal.id, 'SIGWINCH').pipe(
        Effect.catchAll(() => Effect.void)
      );
      return Object.freeze({
        rows: normalizedRows,
        columns: normalizedColumns,
      });
    });
  }

  signalTerminalForeground(
    terminalId: string,
    signal: TraceKernelSignal
  ): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      const pgid = terminal.snapshot().foregroundProcessGroupId;
      const members = [...this.processTable.activeProcesses()].filter((candidate) => {
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
    return Effect.gen(this, function* () {
      const terminal = yield* this.terminalById(terminalId);
      terminal.resize(columns, rows);
      yield* this.signalTerminalForeground(terminalId, 'SIGWINCH').pipe(
        Effect.catchAll(() => Effect.void)
      );
      return terminal.snapshot();
    });
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

      const foregroundMembers = [...this.processTable.activeProcesses()].filter(
        (candidate) => {
          const snapshot = candidate.snapshot();
          return snapshot.sid === terminalSnapshot.sessionId &&
            snapshot.pgid === terminalSnapshot.foregroundProcessGroupId;
        }
      );
      yield* terminal.dispose();
      this.controllingTerminalsBySession.delete(terminalSnapshot.sessionId);
      for (const candidate of this.processTable.activeProcesses()) {
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
      yield* this.processTable.assertOwned(process);
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
}
