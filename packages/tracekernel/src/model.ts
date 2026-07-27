import type * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';
import type { TraceKernelDescriptorSnapshot } from './descriptors';

export type TraceKernelRuntimeName = string;

export type TraceKernelProcessPhase =
  | 'created'
  | 'starting'
  | 'running'
  | 'exiting'
  | 'exited';

export type TraceKernelSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
export type TraceKernelWatchdogSignal = Extract<
  TraceKernelSignal,
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
  readonly signal: TraceKernelSignal;
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
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly controllingTerminalId?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface TraceKernelRuntimeResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Mutable language execution state held for one process.
 *
 * Implementations acquire leases with `Effect.acquireRelease`; release/reset
 * therefore remains attached to the scope that owns the process.
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
}

export interface TraceKernelRuntimeFactory {
  acquire(
    process: TraceKernelRuntimeProcessContext
  ): Effect.Effect<TraceKernelRuntimeLease, Error, Scope.Scope>;
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
}
