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
}

export interface TraceKernelProcessSpec {
  readonly runtime: TraceKernelRuntimeName;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly parentPid?: number;
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
}
