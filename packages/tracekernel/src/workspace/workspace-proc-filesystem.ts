import type {
  RuntimeKernelHttpListenerInfo,
  RuntimeWorkspaceActor,
} from '@tracecode/runtime-core';
import {
  normalizeRuntimeProcPath,
  type RuntimeKernelVirtualStat,
} from '@tracecode/runtime-core';
import type {
  TraceKernelProcessSnapshot,
} from '..';
import type {
  RuntimeCommandExecutionContext,
  RuntimeDynamicProcEntry,
} from './fs-observed';
import type {
  RuntimeKernelHttpRequestRecord,
} from './http-state';
import { workspaceHttpPolicy } from './http-policy';
import type {
  RuntimeKernelProcessRecord,
} from './process-state';
import type {
  RuntimeCommandSchedulerSnapshot,
} from './scheduler';
import type {
  WorkspaceKernelEventRecord,
} from './workspace-event-state';
import type {
  WorkspaceCommandCatalog,
} from './workspace-command-catalog';

export interface WorkspaceProcLockRecord {
  readonly path: string;
  readonly active: boolean;
  readonly waiting: number;
  readonly readers: number;
  readonly writer: boolean;
  readonly waitingReaders: number;
  readonly waitingWriters: number;
}

export interface WorkspaceProcFileSystemOptions {
  readonly commandCatalog: WorkspaceCommandCatalog;
  readonly currentProcess: (
    context?: RuntimeCommandExecutionContext
  ) => RuntimeKernelProcessRecord;
  readonly processes: (
    actor?: RuntimeWorkspaceActor
  ) => readonly RuntimeKernelProcessRecord[];
  readonly findProcess: (
    pid: number,
    actor?: RuntimeWorkspaceActor
  ) => RuntimeKernelProcessRecord | undefined;
  readonly authoritativeProcessSnapshot: (
    process: RuntimeKernelProcessRecord
  ) => TraceKernelProcessSnapshot | undefined;
  readonly renderInodes: () => string;
  readonly events: () => readonly WorkspaceKernelEventRecord[];
  readonly locks: () => readonly WorkspaceProcLockRecord[];
  readonly httpListeners: () => readonly RuntimeKernelHttpListenerInfo[];
  readonly httpRequests: () => readonly RuntimeKernelHttpRequestRecord[];
  readonly scheduler: () => RuntimeCommandSchedulerSnapshot;
  readonly processTableUsage: () => number;
  readonly processTableLimit: () => number | null;
  readonly nextPid: () => number;
}

/**
 * Read-only `/proc` projection for a live workspace.
 *
 * This class never owns process, scheduler, filesystem, or HTTP state. It
 * renders authoritative snapshots supplied by the workspace so reads cannot
 * mutate kernel state or accidentally create a second source of truth.
 */
export class WorkspaceProcFileSystem {
  constructor(private readonly options: WorkspaceProcFileSystemOptions) {}

  readFile(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): string | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc/self/status') {
      return this.renderStatus(this.options.currentProcess(context));
    }
    if (procPath === '/proc/self/cmdline') {
      return `${this.options.currentProcess(context).command}\0`;
    }
    const selfFd = procPath.match(/^\/proc\/self\/fd\/([0-9]+)$/);
    if (selfFd) {
      return this.renderFd(
        this.options.currentProcess(context),
        Number(selfFd[1])
      );
    }
    const selfFdInfo = procPath.match(/^\/proc\/self\/fdinfo\/([0-9]+)$/);
    if (selfFdInfo) {
      return this.renderFdInfo(
        this.options.currentProcess(context),
        Number(selfFdInfo[1])
      );
    }
    if (procPath === '/proc/tracekernel/commands') {
      return this.options.commandCatalog.renderCommands();
    }
    if (procPath === '/proc/tracekernel/events') return this.renderEvents();
    if (procPath === '/proc/tracekernel/inodes') {
      return this.options.renderInodes();
    }
    if (procPath === '/proc/tracekernel/locks') return this.renderLocks();
    if (procPath === '/proc/tracekernel/net/listeners') {
      return this.renderHttpListeners();
    }
    if (procPath === '/proc/tracekernel/net/requests') {
      return this.renderHttpRequests();
    }
    if (procPath === '/proc/tracekernel/processes') {
      return this.renderProcesses(context?.actor);
    }
    if (procPath === '/proc/tracekernel/runtimes') {
      return this.options.commandCatalog.renderRuntimes();
    }
    if (procPath === '/proc/tracekernel/sched') return this.renderScheduler();

    const match = procPath.match(
      /^\/proc\/([1-9][0-9]*)\/(status|cmdline|fd\/[0-9]+|fdinfo\/[0-9]+)$/
    );
    if (!match) return null;
    const process = this.options.findProcess(Number(match[1]), context?.actor);
    if (!process) return null;
    const file = match[2]!;
    if (file === 'status') return this.renderStatus(process);
    if (file === 'cmdline') return `${process.command}\0`;
    const fd = Number(file.split('/')[1]);
    return file.startsWith('fdinfo/')
      ? this.renderFdInfo(process, fd)
      : this.renderFd(process, fd);
  }

  readDir(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): RuntimeDynamicProcEntry[] | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc') {
      return [
        { name: 'kernel', kind: 'directory' },
        { name: 'mounts', kind: 'file' },
        { name: 'self', kind: 'directory' },
        { name: 'tracekernel', kind: 'directory' },
        ...this.options.processes(context?.actor).map((process) => ({
          name: String(process.pid),
          kind: 'directory' as const,
        })),
      ];
    }
    if (procPath === '/proc/self') {
      return [
        { name: 'cmdline', kind: 'file' },
        { name: 'fd', kind: 'directory' },
        { name: 'fdinfo', kind: 'directory' },
        { name: 'mountinfo', kind: 'file' },
        { name: 'status', kind: 'file' },
      ];
    }
    if (procPath === '/proc/self/fd' || procPath === '/proc/self/fdinfo') {
      return this.descriptorNumbers(this.options.currentProcess(context)).map(
        (fd) => ({ name: String(fd), kind: 'file' as const })
      );
    }
    if (procPath === '/proc/tracekernel') {
      return [
        { name: 'commands', kind: 'file' },
        { name: 'events', kind: 'file' },
        { name: 'inodes', kind: 'file' },
        { name: 'locks', kind: 'file' },
        { name: 'net', kind: 'directory' },
        { name: 'processes', kind: 'file' },
        { name: 'runtimes', kind: 'file' },
        { name: 'sched', kind: 'file' },
      ];
    }
    if (procPath === '/proc/tracekernel/net') {
      return [
        { name: 'listeners', kind: 'file' },
        { name: 'requests', kind: 'file' },
      ];
    }
    const fdDirMatch = procPath.match(
      /^\/proc\/([1-9][0-9]*)\/(fd|fdinfo)$/
    );
    if (fdDirMatch) {
      const process = this.options.findProcess(
        Number(fdDirMatch[1]),
        context?.actor
      );
      if (!process) return null;
      return this.descriptorNumbers(process).map((fd) => ({
        name: String(fd),
        kind: 'file' as const,
      }));
    }
    const match = procPath.match(/^\/proc\/([1-9][0-9]*)$/);
    if (!match) return null;
    const process = this.options.findProcess(Number(match[1]), context?.actor);
    if (!process) return null;
    return [
      { name: 'cmdline', kind: 'file' },
      { name: 'fd', kind: 'directory' },
      { name: 'fdinfo', kind: 'directory' },
      { name: 'status', kind: 'file' },
    ];
  }

  entryKind(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): 'file' | 'directory' | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (this.readDir(procPath, context)) return 'directory';
    return this.readFile(procPath, context) !== null ? 'file' : null;
  }

  stat(
    path: string,
    context?: RuntimeCommandExecutionContext
  ): RuntimeKernelVirtualStat | null {
    const kind = this.entryKind(path, context);
    if (!kind) return null;
    const content = kind === 'file' ? this.readFile(path, context) ?? '' : '';
    return {
      isFile: kind === 'file',
      isDirectory: kind === 'directory',
      isCharacterDevice: false,
      mode: kind === 'directory' ? 0o555 : 0o444,
      size: new TextEncoder().encode(content).byteLength,
      uid: 0,
      gid: 0,
      owner: 'root',
      group: 'root',
    };
  }

  private renderStatus(process: RuntimeKernelProcessRecord): string {
    const state =
      process.state === 'queued'
        ? 'S (queued)'
        : process.state === 'blocked'
          ? 'S (blocked)'
          : process.state === 'running'
            ? 'R (running)'
            : process.state === 'signaled'
              ? 'X (signaled)'
              : process.state === 'zombie'
                ? 'Z (zombie)'
                : 'X (dead)';
    return (
      [
        `Name:\t${process.command.split(/\s+/, 1)[0] || 'bash'}`,
        `State:\t${state}`,
        `Pid:\t${process.pid}`,
        `PPid:\t${process.ppid}`,
        `PGid:\t${process.pgid}`,
        `Sid:\t${process.sid}`,
        `FDSize:\t${this.descriptorNumbers(process).length}`,
        `Tty:\t${process.tty}`,
        `Foreground:\t${process.foreground ? 1 : 0}`,
        'Uid:\t1000\t1000\t1000\t1000',
        'Gid:\t1000\t1000\t1000\t1000',
        `Cwd:\t${process.cwd}`,
        `Command:\t${process.command}`,
        `Actor:\t${process.actor.kind}:${process.actor.id}`,
        ...(process.signal ? [`Signal:\t${process.signal}`] : []),
        ...(process.signalCode !== undefined
          ? [`SignalCode:\t${process.signalCode}`]
          : []),
        `Started:\t${process.startedAt}`,
        ...(process.endedAt ? [`Ended:\t${process.endedAt}`] : []),
        ...(process.exitCode !== undefined
          ? [`ExitCode:\t${process.exitCode}`]
          : []),
      ].join('\n') + '\n'
    );
  }

  private renderFd(
    process: RuntimeKernelProcessRecord,
    fd: number
  ): string | null {
    const snapshot = this.options.authoritativeProcessSnapshot(process);
    const descriptor = snapshot?.descriptors.find((entry) => entry.fd === fd);
    if (descriptor) {
      const target =
        descriptor.kind === 'device'
          ? fd === 0
            ? '/dev/stdin'
            : fd === 1
              ? '/dev/stdout'
              : fd === 2
                ? '/dev/stderr'
                : '/dev/null'
          : descriptor.kind === 'terminal'
            ? '/dev/tty'
            : descriptor.kind === 'tcp-socket'
              ? `socket:[${descriptor.resourceId}]`
              : descriptor.kind === 'pipe-reader' ||
                  descriptor.kind === 'pipe-writer'
                ? `pipe:[${descriptor.resourceId}]`
                : descriptor.kind === 'fs-watch'
                  ? `anon_inode:[${descriptor.resourceId}]`
                  : `tkfs:[${descriptor.resourceId}]`;
      return `${target}\n`;
    }
    if (snapshot) return null;
    return process.fds.find((entry) => entry.fd === fd)?.target.concat('\n') ?? null;
  }

  private renderFdInfo(
    process: RuntimeKernelProcessRecord,
    fd: number
  ): string | null {
    const snapshot = this.options.authoritativeProcessSnapshot(process);
    const descriptor = snapshot?.descriptors.find((entry) => entry.fd === fd);
    if (descriptor) {
      const target = this.renderFd(process, fd)?.trim() ?? '';
      const flags =
        descriptor.kind === 'device' && fd === 0
          ? 'r'
          : descriptor.kind === 'device' && (fd === 1 || fd === 2)
            ? 'w'
            : descriptor.kind === 'pipe-reader' ||
                descriptor.kind === 'fs-watch'
              ? 'r'
              : descriptor.kind === 'pipe-writer'
                ? 'w'
                : 'rw';
      return (
        [
          'pos:\t0',
          `flags:\t${flags}`,
          `close_on_exec:\t${descriptor.closeOnExec ? 1 : 0}`,
          `nonblocking:\t${descriptor.nonblocking ? 1 : 0}`,
          `kind:\t${descriptor.kind}`,
          `resource:\t${descriptor.resourceId}`,
          `target:\t${target}`,
        ].join('\n') + '\n'
      );
    }
    if (snapshot) return null;
    const descriptorFallback = process.fds.find((entry) => entry.fd === fd);
    if (!descriptorFallback) return null;
    return (
      [
        'pos:\t0',
        `flags:\t${descriptorFallback.flags}`,
        'mnt_id:\tdev',
        `target:\t${descriptorFallback.target}`,
      ].join('\n') + '\n'
    );
  }

  descriptorNumbers(
    process: RuntimeKernelProcessRecord
  ): readonly number[] {
    const snapshot = this.options.authoritativeProcessSnapshot(process);
    return snapshot
      ? snapshot.descriptors.map((descriptor) => descriptor.fd)
      : process.fds.map((descriptor) => descriptor.fd);
  }

  private renderProcesses(actor?: RuntimeWorkspaceActor): string {
    const rows = this.options.processes(actor).map((process) =>
      [
        process.pid,
        process.ppid,
        process.pgid,
        process.sid,
        process.state,
        process.tty,
        process.foreground ? 1 : 0,
        process.cwd,
        process.command,
      ].join('\t')
    );
    return ['pid\tppid\tpgid\tsid\tstate\ttty\tfg\tcwd\tcmd', ...rows].join(
      '\n'
    ) + '\n';
  }

  private renderEvents(): string {
    const rows = this.options.events().map((event) =>
      [
        event.seq,
        event.time,
        event.type,
        event.pid ?? '',
        event.detail ? JSON.stringify(event.detail) : '',
      ].join('\t')
    );
    return ['seq\ttime\ttype\tpid\tdetail', ...rows].join('\n') + '\n';
  }

  private renderLocks(): string {
    const rows = this.options.locks().map(
      (lock) =>
        `${lock.path}\t${lock.active ? 1 : 0}\t${lock.waiting}\t${lock.readers}\t${lock.writer ? 1 : 0}\t${lock.waitingReaders}\t${lock.waitingWriters}`
    );
    return [
      'path\tactive\twaiting\treaders\twriter\twaiting_readers\twaiting_writers',
      ...rows,
    ].join('\n') + '\n';
  }

  private renderHttpListeners(): string {
    const rows = [...this.options.httpListeners()]
      .sort(
        (left, right) =>
          left.port - right.port || left.host.localeCompare(right.host)
      )
      .map((listener) =>
        [
          workspaceHttpPolicy.sanitizeDiagnosticField(listener.id),
          listener.pid,
          workspaceHttpPolicy.sanitizeDiagnosticField(listener.protocol),
          workspaceHttpPolicy.sanitizeDiagnosticField(listener.host),
          listener.port,
          workspaceHttpPolicy.sanitizeDiagnosticField(listener.startedAt),
        ].join('\t')
      );
    return ['id\tpid\tproto\thost\tport\tstarted', ...rows].join('\n') + '\n';
  }

  private renderHttpRequests(): string {
    const rows = this.options.httpRequests().map((request) =>
      [
        request.seq,
        workspaceHttpPolicy.sanitizeDiagnosticField(request.time),
        workspaceHttpPolicy.sanitizeDiagnosticField(request.listenerId ?? ''),
        request.pid ?? '',
        workspaceHttpPolicy.sanitizeDiagnosticField(request.method),
        workspaceHttpPolicy.sanitizeDiagnosticField(request.url),
        request.status ?? '',
        workspaceHttpPolicy.sanitizeDiagnosticField(request.error ?? ''),
        request.external ? 'external' : '',
      ].join('\t')
    );
    return [
      'seq\ttime\tlistener\tpid\tmethod\turl\tstatus\terror\texternal',
      ...rows,
    ].join('\n') + '\n';
  }

  private renderScheduler(): string {
    const active = this.options.processes();
    const scheduler = this.options.scheduler();
    const processTableUsage = this.options.processTableUsage();
    const processTableLimit = this.options.processTableLimit();
    const queued = active.filter((process) => process.state === 'queued').length;
    const running = active.filter((process) => process.state === 'running').length;
    const blocked = active.filter((process) => process.state === 'blocked').length;
    const zombies = active.filter((process) => process.state === 'zombie').length;
    return (
      [
        `tasks\t${active.length}`,
        `queued\t${queued}`,
        `running\t${running}`,
        `blocked\t${blocked}`,
        `zombies\t${zombies}`,
        `admitted\t${scheduler.running}`,
        `waiting\t${scheduler.queued}`,
        `processes\t${processTableUsage}`,
        `max_processes\t${processTableLimit ?? 'unlimited'}`,
        `available_processes\t${
          processTableLimit === null
            ? 'unlimited'
            : Math.max(0, processTableLimit - processTableUsage)
        }`,
        `max_concurrent\t${scheduler.maxConcurrentCommands}`,
        `max_queued\t${scheduler.maxQueuedCommands ?? 'unlimited'}`,
        `next_pid\t${this.options.nextPid()}`,
        ...active.map(
          (process) =>
            `task\t${process.pid}\t${process.state}\t${process.command}`
        ),
      ].join('\n') + '\n'
    );
  }
}
