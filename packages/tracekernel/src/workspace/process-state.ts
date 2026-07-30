import type * as Scope from 'effect/Scope';
import type {
  RuntimeKernelDevicePath,
  RuntimeKernelSignalBridge,
  RuntimeKernelSignalNotification,
  RuntimeWorkspaceActor,
  RuntimeWorkspaceProcessSignalPolicy,
} from '@tracecode/runtime-contracts';
import type {
  TraceKernelHost,
  TraceKernelHostStandardIo,
  TraceKernelProcess,
  TraceKernelSession,
  TraceKernelSignal,
} from '..';
import type { RuntimeCommandExecutionContext } from './fs-observed';

export const TRACEKERNEL_SIGNAL_NUMBERS = new Map<string, number>([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGQUIT', 3],
  ['SIGKILL', 9],
  ['SIGTERM', 15],
  ['SIGWINCH', 28],
]);

const TRACEKERNEL_SIGNAL_NAMES_BY_NUMBER = new Map(
  [...TRACEKERNEL_SIGNAL_NUMBERS.entries()].map(([name, number]) => [number, name])
);

export function normalizeTraceKernelSignal(
  value: string | undefined
): { name: TraceKernelSignal; code: number } | null {
  const raw = (value ?? 'SIGTERM').trim().toUpperCase();
  if (!raw) return null;
  if (/^[0-9]+$/.test(raw)) {
    const code = Number(raw);
    const name = TRACEKERNEL_SIGNAL_NAMES_BY_NUMBER.get(code);
    return name ? { name: name as TraceKernelSignal, code } : null;
  }
  const name = raw.startsWith('SIG') ? raw : `SIG${raw}`;
  const code = TRACEKERNEL_SIGNAL_NUMBERS.get(name);
  return code === undefined
    ? null
    : { name: name as TraceKernelSignal, code };
}

export type RuntimeKernelProcessState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'signaled'
  | 'zombie'
  | 'exited';

export type RuntimeKernelTtyName = RuntimeKernelDevicePath | '?';

export interface RuntimeKernelFileDescriptorRecord {
  fd: number;
  target: RuntimeKernelDevicePath;
  flags: 'r' | 'w' | 'rw';
}

export interface RuntimeKernelProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly fds: readonly RuntimeKernelFileDescriptorRecord[];
  readonly tty: RuntimeKernelTtyName;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly actor: RuntimeWorkspaceActor;
  readonly signalPolicy: RuntimeWorkspaceProcessSignalPolicy;
  readonly startedAt: string;
  readonly state: RuntimeKernelProcessState;
  readonly signal?: string;
  readonly signalCode?: number;
  readonly foreground: boolean;
  readonly exitCode?: number;
  readonly endedAt?: string;
}

export interface RuntimeKernelExecutionHandle {
  readonly kernelProcess: TraceKernelProcess;
  readonly abortController?: AbortController;
  readonly signalChannel?: RuntimeKernelProcessSignalChannel;
  readonly hostStandardIo?: TraceKernelHostStandardIo;
  descriptorStdio?: boolean;
  hostOutputContext?: RuntimeCommandExecutionContext;
  hostStdinPumpStarted?: boolean;
  stopHostStdinPump?: boolean;
  hostStdinPump?: Promise<void>;
  hostStdoutDrain?: Promise<void>;
  hostStderrDrain?: Promise<void>;
  pendingSignal?: {
    readonly name: string;
    readonly code: number;
  };
}

export class RuntimeKernelProcessSignalChannel implements RuntimeKernelSignalBridge {
  readonly mailbox = Object.freeze({
    buffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
  });
  private readonly listeners = new Set<
    (notification: RuntimeKernelSignalNotification) => void
  >();
  private readonly pending: RuntimeKernelSignalNotification[] = [];
  private closed = false;

  subscribe(
    listener: (notification: RuntimeKernelSignalNotification) => void
  ): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    for (const notification of this.pending.splice(0)) {
      try {
        listener(notification);
      } catch {
        // A runtime adapter cannot make kernel signal publication fail.
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(
    notification: RuntimeKernelSignalNotification
  ): 'delivered' | 'queued' | 'closed' {
    if (this.closed) return 'closed';
    const mailbox = new Int32Array(this.mailbox.buffer);
    Atomics.store(mailbox, 1, notification.code);
    Atomics.add(mailbox, 0, 1);
    Atomics.notify(mailbox, 0);
    if (this.listeners.size === 0) {
      // Signals are not an unbounded event log. Retaining the short startup
      // window prevents a resize racing runner subscription from disappearing.
      if (this.pending.length === 16) this.pending.shift();
      this.pending.push(notification);
      return 'queued';
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch {
        // Delivery failures preserve the signal's default disposition.
      }
    }
    return 'delivered';
  }

  close(): void {
    this.closed = true;
    this.pending.length = 0;
    this.listeners.clear();
  }
}

export interface RuntimeKernelZombieRecord {
  readonly process: RuntimeKernelProcessRecord;
  readonly outcome: {
    readonly exitCode: number;
    readonly endedAt: string;
    readonly signal?: string;
    readonly signalCode?: number;
  };
  readonly expiresAtMs: number;
}

export interface RuntimeTraceKernelAuthority {
  readonly scope: Scope.CloseableScope;
  readonly host: TraceKernelHost;
  readonly session: TraceKernelSession;
  /**
   * Invisible kernel process that owns host-side descriptors and services.
   *
   * Keeping this process in the session means a workspace consumer and a
   * language runtime share one descriptor table model and one network
   * namespace instead of communicating across a PID-0 compatibility island.
   */
  readonly hostServiceProcess: TraceKernelProcess;
}

export interface RuntimeKernelProcessLaunchHooks {
  readonly kernelProcess?: TraceKernelProcess;
  readonly kernelProcessGroupId?: number;
  readonly kernelSessionId?: number;
  /**
   * The kernel spawn operation has already placed fd 0/1/2. Preserve those
   * descriptors even when the child inherits a controlling-terminal context.
   */
  readonly preserveKernelStandardIo?: boolean;
  initialize?: (
    process: RuntimeKernelProcessRecord,
    context: RuntimeCommandExecutionContext
  ) => Promise<void>;
  ready?: (process: RuntimeKernelProcessRecord) => void;
  beforeDescriptorClose?: (
    process: RuntimeKernelProcessRecord,
    context: RuntimeCommandExecutionContext
  ) => Promise<void>;
  afterDescriptorClose?: (
    process: RuntimeKernelProcessRecord,
    context: RuntimeCommandExecutionContext
  ) => Promise<void>;
}

export interface RuntimeKernelSpawnedChild {
  readonly process: RuntimeKernelProcessRecord;
  readonly stdio?: {
    readonly stdinFd?: number;
    readonly stdoutFd?: number;
    readonly stderrFd?: number;
  };
}

/**
 * Mutable process bookkeeping for one workspace session.
 *
 * Process mechanics still live behind the compatibility workspace façade, but
 * their state now has one owner that can move into TraceKernel independently
 * of shell, HTTP, or filesystem state.
 */
export class WorkspaceProcessState {
  readonly table = new Map<number, RuntimeKernelProcessRecord>();
  readonly executionHandles = new Map<number, RuntimeKernelExecutionHandle>();
  readonly terminalForeground = new Map<string, number>();
  readonly controlPlaneDisposals = new Set<Promise<void>>();
  readonly zombies = new Map<number, RuntimeKernelZombieRecord>();
  readonly waitRequests = new Set<number>();
  readonly waiters = new Map<
    number,
    Array<(process: RuntimeKernelProcessRecord) => void>
  >();
  readonly anyWaiters: Array<(process: RuntimeKernelProcessRecord) => void> = [];
  readonly childSelectorWaiters: Array<() => void> = [];
  readonly childWaits = new Set<number>();
  nextPid = 100;
}
