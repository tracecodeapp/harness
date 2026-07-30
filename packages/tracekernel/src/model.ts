import type * as Effect from 'effect/Effect';
import type { TraceKernelDescriptorSnapshot } from './descriptors';
import type {
  TraceKernelFileSystem,
  TraceKernelFileSystemImage,
} from './vfs';
import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
} from './syscalls';

export type TraceKernelRuntimeName = string;

export type TraceKernelProcessPhase =
  | 'created'
  | 'starting'
  | 'running'
  | 'exiting'
  | 'exited';

export type TraceKernelProcessSchedulingState =
  | 'queued'
  | 'running'
  | 'blocked';

export type TraceKernelSignal =
  | 'SIGHUP'
  | 'SIGINT'
  | 'SIGQUIT'
  | 'SIGKILL'
  | 'SIGTERM'
  | 'SIGWINCH';
export type TraceKernelTerminatingSignal = Exclude<
  TraceKernelSignal,
  'SIGWINCH'
>;
export type TraceKernelWatchdogSignal = Extract<
  TraceKernelTerminatingSignal,
  'SIGTERM' | 'SIGKILL'
>;

export interface TraceKernelWatchdogSnapshot {
  readonly timeoutMs: number;
  readonly signal: TraceKernelWatchdogSignal;
  readonly deadlineAt: number;
}

export type TraceKernelPrincipalKind = 'user' | 'agent' | 'grader' | 'system';

export interface TraceKernelPrincipal {
  readonly id: string;
  readonly kind: TraceKernelPrincipalKind;
}

export interface TraceKernelProcessTerminationExit {
  readonly kind: 'exit';
  readonly exitCode: number;
}

export interface TraceKernelProcessTerminationSignal {
  readonly kind: 'signal';
  readonly signal: TraceKernelTerminatingSignal;
  readonly exitCode: number;
}

export interface TraceKernelProcessTerminationFailure {
  readonly kind: 'failure';
  readonly exitCode: number;
  readonly message: string;
}

export type TraceKernelProcessTermination =
  | TraceKernelProcessTerminationExit
  | TraceKernelProcessTerminationSignal
  | TraceKernelProcessTerminationFailure;

export interface TraceKernelProcessSnapshot {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly controllingTerminalId?: string;
  readonly phase: TraceKernelProcessPhase;
  readonly schedulingState: TraceKernelProcessSchedulingState;
  readonly runtime: TraceKernelRuntimeName;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly owner: TraceKernelPrincipal;
  readonly protected: boolean;
  readonly visible: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly pendingSignal?: TraceKernelTerminatingSignal;
  readonly termination?: TraceKernelProcessTermination;
  readonly stdout: string;
  readonly stderr: string;
  readonly descriptors: readonly TraceKernelDescriptorSnapshot[];
  readonly watchdog?: TraceKernelWatchdogSnapshot;
}

export type TraceKernelSpawnDescriptorAction =
  | {
      readonly op: 'dup2';
      readonly fd: number;
      readonly targetFd: number;
    }
  | {
      readonly op: 'close';
      readonly fd: number;
    };

export interface TraceKernelDescriptorMapping {
  readonly parentFd: number;
  readonly childFd: number;
}

export interface TraceKernelProcessSpec {
  readonly runtime: TraceKernelRuntimeName;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly parentPid?: number;
  /**
   * Retain a top-level process as a waitable child of logical PID 1 after it
   * exits. Explicit children are always waitable by their materialized parent.
   */
  readonly retainOnExit?: boolean;
  /**
   * Descriptors to duplicate from the explicit live parent. Inherited
   * descriptors retain their numeric fd and share the same open-resource
   * description. Omitted means no inheritance.
   */
  readonly inheritDescriptors?: 'all' | readonly number[];
  /**
   * Parent descriptors to duplicate into explicit child fd identities.
   * Mappings are acquired atomically before the child table is mutated.
   */
  readonly descriptorMappings?: readonly TraceKernelDescriptorMapping[];
  /**
   * Ordered child-table mutations applied after descriptor inheritance and
   * before the runtime lease starts.
   */
  readonly descriptorActions?: readonly TraceKernelSpawnDescriptorAction[];
  readonly processGroupId?: number;
  readonly sessionId?: number;
  readonly owner?: TraceKernelPrincipal;
  readonly protected?: boolean;
  readonly visible?: boolean;
}

export interface TraceKernelRuntimeProcessContext {
  readonly sessionId: string;
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly controllingTerminalId?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Process-bound kernel authority. Runtime providers may bridge this port to
   * an in-realm adapter, Worker, or Wasm guest, but they cannot dispatch a
   * syscall as another process or reach session internals directly.
   */
  readonly syscalls: TraceKernelRuntimeSyscallPort;
}

export interface TraceKernelRuntimeSyscallPort {
  dispatch(
    request: TraceKernelSyscallRequest
  ): Effect.Effect<TraceKernelSyscallResult>;
}

export interface TraceKernelRuntimeResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /**
   * Explicit runtime-observed termination. Controlled host runtimes use this
   * to distinguish a kernel-delivered signal from an ordinary numeric exit
   * such as `exit(143)`.
   */
  readonly termination?: TraceKernelProcessTermination;
}

export type TraceKernelRuntimeLeaseReleaseDisposition =
  | {
      readonly kind: 'reuse';
      readonly reason: 'revalidated';
    }
  | {
      readonly kind: 'destroy';
      readonly reason:
        | 'unvalidated'
        | 'execution-failure'
        | 'signaled'
        | 'interrupted'
        | 'revalidation-failure';
      readonly message?: string;
    };

/**
 * Mutable language execution state held for one process.
 *
 * TraceKernel owns the acquire/use/release bracket. A lease is never reusable
 * merely because execution returned: it must expose `revalidate` and that
 * check must succeed. All other outcomes receive a destroy disposition.
 */
export interface TraceKernelRuntimeLease {
  readonly id: string;
  readonly runtime: TraceKernelRuntimeName;
  execute(
    process: TraceKernelRuntimeProcessContext
  ): Effect.Effect<TraceKernelRuntimeResult, Error>;
  /**
   * Deliver a catchable signal to the leased runtime. Resolving acknowledges
   * delivery, not process termination. TraceKernel still owns the grace
   * deadline and force-interrupts the process if execution does not finish.
   */
  signal?(signal: Exclude<TraceKernelSignal, 'SIGKILL'>): Effect.Effect<void, Error>;
  /**
   * Reset and prove that no process-visible mutable state survived execution.
   * Omit this for ephemeral leases; TraceKernel will destroy them after use.
   */
  revalidate?(): Effect.Effect<void, Error>;
  /**
   * Exactly-once finalizer. Providers may return a lease to a pool only for a
   * `reuse` disposition. Every `destroy` disposition must retire its mutable
   * execution state rather than making it available to another process.
   */
  release(
    disposition: TraceKernelRuntimeLeaseReleaseDisposition
  ): Effect.Effect<void>;
}

export interface TraceKernelRuntimeFactory {
  acquire(
    process: TraceKernelRuntimeProcessContext
  ): Effect.Effect<TraceKernelRuntimeLease, Error>;
}

/**
 * Host-level provider. `initialize` may download assets or compile immutable
 * modules. TraceKernel memoizes it lazily and shares concurrent initialization.
 */
export interface TraceKernelRuntimeProvider {
  readonly runtime: TraceKernelRuntimeName;
  readonly initialize: Effect.Effect<TraceKernelRuntimeFactory, Error>;
}

export interface TraceKernelHostOptions {
  readonly providers?: readonly TraceKernelRuntimeProvider[];
}

export interface TraceKernelSessionOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxDescriptorsPerProcess?: number;
  readonly maxProcesses?: number;
  readonly signalGracePeriodMs?: number;
  /**
   * Existing authority used by host/editor adapters and this session together.
   * A host permits at most one live session to claim a supplied filesystem.
   */
  readonly fileSystem?: TraceKernelFileSystem;
  /**
   * Committed state used to construct the session-owned TKFS before any process
   * can start. After openSession succeeds, the session is the mutable authority.
   */
  readonly fileSystemImage?: TraceKernelFileSystemImage;
  readonly fileSystemPolicy?: TraceKernelFileSystemPolicy;
}

export type TraceKernelFileSystemPermission =
  | 'read'
  | 'write'
  | 'delete'
  | 'metadata';

export interface TraceKernelFileSystemAccess {
  /** Lexically normalized path requested by the process. */
  readonly requestedPath: string;
  /**
   * Existing realpath, or the canonical nearest existing ancestor plus the
   * unresolved suffix admitted by the syscall (one basename normally; the
   * complete missing suffix for recursive namespace creation).
   */
  readonly path: string;
  readonly permission: TraceKernelFileSystemPermission;
}

export interface TraceKernelFileSystemPolicyRequest {
  readonly pid: number;
  readonly cwd: string;
  readonly owner: TraceKernelPrincipal;
  readonly accesses: readonly TraceKernelFileSystemAccess[];
}

/**
 * Session syscall authorization boundary.
 *
 * Policies decide access; TKFS remains the state/linearization mechanism.
 * Host/editor APIs enforce their own principal policy before calling TKFS.
 */
export interface TraceKernelFileSystemPolicy {
  authorize(
    request: TraceKernelFileSystemPolicyRequest
  ): Effect.Effect<void, Error>;
}
