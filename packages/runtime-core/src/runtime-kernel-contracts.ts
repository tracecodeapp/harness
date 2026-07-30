export interface RuntimeKernelUserConfig {
  id?: string;
  username?: string;
  home?: string;
}

export interface RuntimeKernelHostConfig {
  hostname?: string;
  osName?: string;
}

export interface RuntimeKernelWorkspaceConfig {
  id?: string;
  name?: string;
  root?: string;
  startedAt?: string | Date;
}

export interface RuntimeTraceKernelSchedulerConfig {
  maxConcurrentCommands?: number;
  maxQueuedCommands?: number;
}

export interface RuntimeTraceKernelConfig {
  version?: string;
  user?: RuntimeKernelUserConfig;
  host?: RuntimeKernelHostConfig;
  workspace?: RuntimeKernelWorkspaceConfig;
  workspaceAlias?: string | false;
  /**
   * Maximum number of processes in the workspace process table, including the
   * kernel's PID 1, persistent host-created processes, queued/running commands,
   * and unreaped zombies. Omit for no explicit process-table limit.
   */
  maxProcesses?: number;
  scheduler?: RuntimeTraceKernelSchedulerConfig;
}

export interface RuntimeKernelUserInfo {
  id: string;
  username: string;
  home: string;
}

export interface RuntimeKernelHostInfo {
  hostname: string;
  osName: string;
}

export interface RuntimeKernelWorkspaceInfo {
  id: string;
  name: string;
  root: string;
  startedAt: string;
}

export interface RuntimeKernelInfo {
  name: 'tracekernel';
  version: string;
  user: RuntimeKernelUserInfo;
  host: RuntimeKernelHostInfo;
  workspace: RuntimeKernelWorkspaceInfo;
  home: string;
  cwd: string;
  workspaceRoot: string;
  workspaceAlias?: string;
}

/**
 * Product-integration wrapper around one process-bound TraceKernel syscall
 * channel. Runtime workers receive only the shared channel and generation
 * buffer; servicing and lifecycle remain host-owned.
 */
export interface RuntimeKernelSyscallBridge {
  readonly channel: {
    readonly buffer: SharedArrayBuffer;
    readonly byteCapacity: number;
  };
  readonly generationBuffer?: SharedArrayBuffer;
  /**
   * Asynchronous runtime operations use the command MessagePort so blocking
   * kernel work never stalls the language worker's event loop. Requests and
   * results are the plain TraceKernel syscall wire contract.
   */
  dispatch(request: unknown): Promise<unknown>;
  service(): Promise<void>;
  close(): void;
}

export interface RuntimeKernelSignalNotification {
  readonly signal: string;
  readonly code: number;
}

export interface RuntimeKernelSignalMailbox {
  /**
   * Int32 layout: [monotonic sequence, latest signal number].
   * Standard POSIX notifications may coalesce before the runtime's next safe
   * point; they are not an ordered application event log.
   */
  readonly buffer: SharedArrayBuffer;
}

/**
 * Host-owned, non-terminating process notification stream.
 *
 * This is deliberately separate from `AbortSignal`: abort represents
 * cancellation and may retire a runtime worker, while POSIX notifications
 * such as SIGWINCH have a default disposition of ignore and must leave the
 * process and its engine lease alive.
 */
export interface RuntimeKernelSignalBridge {
  readonly mailbox: RuntimeKernelSignalMailbox;
  subscribe(
    listener: (notification: RuntimeKernelSignalNotification) => void
  ): () => void;
}

export type RuntimeKernelDevicePath = `/dev/${string}`;

export interface RuntimeKernelDeviceInfo {
  path: RuntimeKernelDevicePath;
  readable: boolean;
  writable: boolean;
  inputDevice?: RuntimeKernelDevicePath;
  outputDevice?: RuntimeKernelDevicePath;
}
