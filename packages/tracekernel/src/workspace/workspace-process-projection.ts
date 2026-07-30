import * as Effect from 'effect/Effect';
import type {
  RuntimeWorkspaceActor,
} from '@tracecode/runtime-core';
import type {
  TraceKernelPrincipal,
  TraceKernelProcess,
  TraceKernelProcessSnapshot,
} from '..';
import type { RuntimeCommandExecutionContext } from './fs-observed';
import {
  RuntimeKernelAdmissionRejectedError,
} from './scheduler';
import {
  TRACEKERNEL_SIGNAL_NUMBERS,
  type RuntimeKernelExecutionHandle,
  type RuntimeKernelFileDescriptorRecord,
  type RuntimeKernelProcessRecord,
  type RuntimeKernelProcessState,
  type RuntimeKernelTtyName,
  type RuntimeTraceKernelAuthority,
  type WorkspaceProcessState,
} from './process-state';

export interface WorkspaceProcessProjectionOptions {
  readonly state: WorkspaceProcessState;
  readonly systemActor: RuntimeWorkspaceActor;
  readonly cwd: string;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly projectCreatedAt?: string;
  readonly maxProcesses: number | null;
  readonly authority: () => RuntimeTraceKernelAuthority | undefined;
  readonly principal: (
    actor: RuntimeWorkspaceActor
  ) => TraceKernelPrincipal;
  readonly actorFromProcess: (
    process: TraceKernelProcessSnapshot,
    hintedActor?: RuntimeWorkspaceActor
  ) => RuntimeWorkspaceActor;
}

/**
 * Authoritative process-table projection for workspace userland and runtime
 * adapters.
 *
 * TraceKernel owns live process mechanics. This boundary combines its process
 * and terminal snapshots with the workspace's product metadata, preserves
 * unreaped zombies, and exposes one consistent view to `/proc`, shell
 * commands, journals, and runtime bridges.
 */
export class WorkspaceProcessProjection {
  constructor(
    private readonly options: WorkspaceProcessProjectionOptions
  ) {}

  principalRecord(): RuntimeKernelProcessRecord {
    return {
      pid: 1,
      ppid: 0,
      pgid: 1,
      sid: 1,
      fds: this.standardFileDescriptors(),
      tty: '/dev/tty',
      command: 'tracekernel',
      cwd: this.options.cwd,
      env: Object.freeze({ ...this.options.baseEnv }),
      actor: this.options.systemActor,
      signalPolicy: 'system-only',
      startedAt:
        this.options.projectCreatedAt ??
        new Date(0).toISOString(),
      state: 'running',
      foreground: true,
    };
  }

  currentRecord(
    context?: RuntimeCommandExecutionContext
  ): RuntimeKernelProcessRecord {
    return (
      (context?.process as
        | RuntimeKernelProcessRecord
        | undefined) ??
      this.principalRecord()
    );
  }

  executionHandle(
    process: { readonly pid: number }
  ): RuntimeKernelExecutionHandle | undefined {
    return this.options.state.executionHandles.get(process.pid);
  }

  kernelProcess(
    process: { readonly pid: number }
  ): TraceKernelProcess | undefined {
    return this.executionHandle(process)?.kernelProcess;
  }

  authoritativeSnapshot(
    process: { readonly pid: number }
  ): TraceKernelProcessSnapshot | undefined {
    return (
      this.kernelProcess(process)?.snapshot() ??
      this.options
        .authority()
        ?.session.processTableSnapshots()
        .find((snapshot) => snapshot.pid === process.pid)
    );
  }

  bindAuthoritativeRecord(
    process: RuntimeKernelProcessRecord,
    fallback: TraceKernelProcessSnapshot
  ): RuntimeKernelProcessRecord {
    const fallbackActor = process.actor;
    const fallbackStartedAt = process.startedAt;
    const snapshot = (): TraceKernelProcessSnapshot =>
      this.authoritativeSnapshot(process) ?? fallback;
    const tty = (): RuntimeKernelTtyName =>
      snapshot().descriptors.some(
        (descriptor) =>
          descriptor.fd >= 0 &&
          descriptor.fd <= 2 &&
          descriptor.kind === 'terminal'
      )
        ? '/dev/tty'
        : '?';
    const signal = ():
      | { readonly name: string; readonly code?: number }
      | undefined => {
      const pending = snapshot().pendingSignal;
      if (pending) {
        return {
          name: pending,
          code: TRACEKERNEL_SIGNAL_NUMBERS.get(pending),
        };
      }
      const zombie =
        this.options.state.zombies.get(process.pid)?.outcome;
      if (zombie?.signal) {
        return {
          name: zombie.signal,
          ...(zombie.signalCode === undefined
            ? {}
            : { code: zombie.signalCode }),
        };
      }
      const termination = snapshot().termination;
      if (termination?.kind !== 'signal') return undefined;
      return {
        name: termination.signal,
        code: TRACEKERNEL_SIGNAL_NUMBERS.get(
          termination.signal
        ),
      };
    };

    Object.defineProperties(process, {
      ppid: {
        enumerable: true,
        get: () => snapshot().ppid,
      },
      pgid: {
        enumerable: true,
        get: () => snapshot().pgid,
      },
      sid: {
        enumerable: true,
        get: () => snapshot().sid,
      },
      command: {
        enumerable: true,
        get: () => snapshot().command,
      },
      cwd: {
        enumerable: true,
        get: () => snapshot().cwd,
      },
      env: {
        enumerable: true,
        get: () => snapshot().env,
      },
      actor: {
        enumerable: true,
        get: () =>
          this.options.actorFromProcess(
            snapshot(),
            fallbackActor
          ),
      },
      signalPolicy: {
        enumerable: true,
        get: () =>
          snapshot().protected ? 'system-only' : 'standard',
      },
      startedAt: {
        enumerable: true,
        get: () => {
          const startedAt = snapshot().startedAt;
          return startedAt === undefined
            ? fallbackStartedAt
            : new Date(startedAt).toISOString();
        },
      },
      tty: {
        enumerable: true,
        get: tty,
      },
      foreground: {
        enumerable: true,
        get: () => {
          const current = snapshot();
          if (tty() === '?') return false;
          const terminal = current.controllingTerminalId
            ? this.options
                .authority()
                ?.session.terminalSnapshots()
                .find(
                  (candidate) =>
                    candidate.id ===
                    current.controllingTerminalId
                )
            : undefined;
          return (
            terminal?.foregroundProcessGroupId === current.pgid
          );
        },
      },
      state: {
        enumerable: true,
        get: (): RuntimeKernelProcessState => {
          const current = this.authoritativeSnapshot(process);
          if (current?.phase === 'exited') return 'zombie';
          if (current?.pendingSignal) return 'signaled';
          if (current?.schedulingState === 'queued') {
            return 'queued';
          }
          if (current?.schedulingState === 'blocked') {
            return 'blocked';
          }
          if (current) return 'running';
          return this.options.state.zombies.has(process.pid)
            ? 'zombie'
            : fallback.phase === 'exited'
              ? 'zombie'
              : fallback.schedulingState;
        },
      },
      signal: {
        enumerable: true,
        get: () => signal()?.name,
      },
      signalCode: {
        enumerable: true,
        get: () => signal()?.code,
      },
      exitCode: {
        enumerable: true,
        get: () =>
          this.authoritativeSnapshot(process)?.termination
            ?.exitCode ??
          this.options.state.zombies.get(process.pid)?.outcome
            .exitCode,
      },
      endedAt: {
        enumerable: true,
        get: () => {
          const endedAt =
            this.authoritativeSnapshot(process)?.endedAt;
          return endedAt === undefined
            ? this.options.state.zombies.get(process.pid)?.outcome
                .endedAt
            : new Date(endedAt).toISOString();
        },
      },
    });
    return process;
  }

  purgeZombies(nowMs = Date.now()): void {
    for (const [pid, zombie] of this.options.state.zombies) {
      if (zombie.expiresAtMs > nowMs) continue;
      this.options.state.zombies.delete(pid);
      this.options.state.waitRequests.delete(pid);
      const authority = this.options.authority();
      if (!authority) continue;
      const zombieSnapshot = this.authoritativeSnapshot(
        zombie.process
      );
      const parentPid =
        zombieSnapshot?.ppid ?? zombie.process.ppid;
      const parent =
        this.options.state.table.get(parentPid) ??
        this.options.state.zombies.get(parentPid)?.process;
      const parentKernelProcess = parent
        ? this.kernelProcess(parent)
        : undefined;
      const liveParent =
        parentKernelProcess &&
        authority.session
          .processSnapshots()
          .some(
            (snapshot) =>
              snapshot.pid === parentKernelProcess.pid
          )
          ? parentKernelProcess
          : undefined;
      Effect.runFork(
        (
          liveParent
            ? authority.session.waitChild(
                liveParent,
                zombie.process.pid,
                { noHang: true }
              )
            : authority.session.waitInitChild(
                zombie.process.pid,
                { noHang: true }
              )
        ).pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }

  find(
    pid: number
  ): RuntimeKernelProcessRecord | undefined {
    this.purgeZombies();
    return (
      this.options.state.table.get(pid) ??
      this.options.state.zombies.get(pid)?.process
    );
  }

  activeRecords(): RuntimeKernelProcessRecord[] {
    this.purgeZombies();
    return [
      ...this.options.state.table.values(),
      ...[...this.options.state.zombies.values()].map(
        (zombie) => zombie.process
      ),
    ].sort((left, right) => left.pid - right.pid);
  }

  presentationRecords(
    actor?: RuntimeWorkspaceActor
  ): RuntimeKernelProcessRecord[] {
    const authority = this.options.authority();
    if (!authority) return this.activeRecords();
    const terminals = new Map(
      authority.session.terminalSnapshots().map((terminal) => [
        terminal.id,
        terminal,
      ])
    );
    const project = (
      snapshot: TraceKernelProcessSnapshot
    ): RuntimeKernelProcessRecord | undefined => {
      const record =
        this.options.state.table.get(snapshot.pid) ??
        this.options.state.zombies.get(snapshot.pid)?.process;
      if (!record) return undefined;
      const terminal = snapshot.controllingTerminalId
        ? terminals.get(snapshot.controllingTerminalId)
        : undefined;
      const hasTerminalStdio = snapshot.descriptors.some(
        (descriptor) =>
          descriptor.fd >= 0 &&
          descriptor.fd <= 2 &&
          descriptor.kind === 'terminal'
      );
      const terminationSignal =
        snapshot.termination?.kind === 'signal'
          ? snapshot.termination.signal
          : undefined;
      const signalCode = terminationSignal
        ? TRACEKERNEL_SIGNAL_NUMBERS.get(terminationSignal)
        : undefined;
      const state: RuntimeKernelProcessState =
        snapshot.phase === 'exited'
          ? 'zombie'
          : snapshot.pendingSignal
            ? 'signaled'
            : snapshot.schedulingState === 'queued'
              ? 'queued'
              : snapshot.schedulingState === 'blocked'
                ? 'blocked'
                : 'running';
      return {
        ...record,
        ppid: snapshot.ppid,
        pgid: snapshot.pgid,
        sid: snapshot.sid,
        command: snapshot.command,
        cwd: snapshot.cwd,
        env: snapshot.env,
        state,
        tty: hasTerminalStdio ? '/dev/tty' : '?',
        foreground:
          hasTerminalStdio &&
          terminal?.foregroundProcessGroupId === snapshot.pgid,
        ...(snapshot.startedAt === undefined
          ? {}
          : {
              startedAt: new Date(
                snapshot.startedAt
              ).toISOString(),
            }),
        ...(snapshot.endedAt === undefined
          ? {}
          : {
              endedAt: new Date(
                snapshot.endedAt
              ).toISOString(),
            }),
        ...(snapshot.termination === undefined
          ? {}
          : { exitCode: snapshot.termination.exitCode }),
        ...(terminationSignal === undefined
          ? {}
          : {
              signal: terminationSignal,
              ...(signalCode === undefined
                ? {}
                : { signalCode }),
            }),
      };
    };

    return authority.session
      .processTableSnapshots(
        actor === undefined
          ? undefined
          : this.options.principal(actor)
      )
      .map(project)
      .filter(
        (
          record
        ): record is RuntimeKernelProcessRecord =>
          record !== undefined
      );
  }

  findPresentationRecord(
    pid: number,
    actor?: RuntimeWorkspaceActor
  ): RuntimeKernelProcessRecord | undefined {
    return this.presentationRecords(actor).find(
      (process) => process.pid === pid
    );
  }

  tableUsage(): number {
    return (
      this.options
        .authority()
        ?.session.processTableSnapshots().length ??
      1 + this.activeRecords().length
    );
  }

  tableLimit(): number | null {
    return (
      this.options.authority()?.session.maxProcesses ??
      this.options.maxProcesses
    );
  }

  admissionError(
    command: string
  ): RuntimeKernelAdmissionRejectedError | null {
    const limit = this.tableLimit();
    if (limit === null || this.tableUsage() < limit) {
      return null;
    }
    return new RuntimeKernelAdmissionRejectedError(
      command,
      `EAGAIN: resource temporarily unavailable, fork '${command}'`,
      'fork'
    );
  }

  firstZombie(): RuntimeKernelProcessRecord | undefined {
    this.purgeZombies();
    return [...this.options.state.zombies.values()]
      .map((zombie) => zombie.process)
      .sort((left, right) => left.pid - right.pid)[0];
  }

  standardFileDescriptors():
    readonly RuntimeKernelFileDescriptorRecord[] {
    return [
      { fd: 0, target: '/dev/stdin', flags: 'r' },
      { fd: 1, target: '/dev/stdout', flags: 'w' },
      { fd: 2, target: '/dev/stderr', flags: 'w' },
    ];
  }
}
