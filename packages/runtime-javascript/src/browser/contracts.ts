import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectFileChangeApplyOptions,
  RuntimeProjectSnapshot,
} from "@tracecode/runtime-core";

import type {
  TraceKernelDirectoryEntry,
  TraceKernelMkdirOptions,
  TraceKernelOpenFileOptions,
  TraceKernelStat,
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
} from "@tracecode/tracekernel";

import {
  type TypeScriptProjectCompiler,
} from "../typescript-project";

export type JavaScriptProjectFileEncoding = RuntimeFileEncoding;

export type JavaScriptProjectFile = RuntimeFile;

export type JavaScriptProjectSnapshot = RuntimeProjectSnapshot;

export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;

export type JavaScriptProjectCommandResult = RuntimeCommandResult;

export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;

export type BrowserJavaScriptProjectCommandRunner = JavaScriptProjectCommandRunner & {
  /** Retires an unused prewarmed worker owned by this runner. */
  dispose?: () => void;
};

export type BrowserJavaScriptProjectWorkerIsolation = 'shared' | 'per-command';

export interface BrowserJavaScriptProjectWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type BrowserJavaScriptProjectWorkerFactory = (
  url: string | URL,
  options?: WorkerOptions
) => BrowserJavaScriptProjectWorkerLike;

export interface BrowserJavaScriptProjectRunnerOptions {
  /** Verifies the consumer-owned project worker before it is constructed. */
  assetPreflight?: () => Promise<void>;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
  allowDynamicEval?: boolean;
  allowMainThreadExecution?: boolean;
  hardened?: boolean;
  trustedMainThreadExecution?: boolean;
  trustedReusableWorker?: boolean;
  /** @internal Set by the worker-backed runner; disposable workers require permanent mode. */
  projectUserAuthorityMode?: 'temporary' | 'permanent';
  /** Prepare one clean disposable worker in the background for the next command. */
  prewarm?: boolean;
  /** @internal Allows the owning workspace to retire an unused prewarmed worker. */
  registerPrewarmCleanup?: (cleanup: () => void) => void;
  timeoutMs?: number;
  workerIsolation?: BrowserJavaScriptProjectWorkerIsolation;
  workerFactory?: BrowserJavaScriptProjectWorkerFactory;
  workerUrl?: string;
}

export interface BrowserTypeScriptProjectRunnerOptions {
  allowDomCompilerScript?: boolean;
  allowExternalDomCompilerScript?: boolean;
  compiler?: TypeScriptProjectCompiler;
  /** Verifies the consumer-owned compiler asset immediately before lazy loading. */
  compilerPreflight?: () => Promise<void>;
  compilerUrl?: string;
  /** Load the trusted compiler in the background without delaying workspace creation. */
  prewarmCompiler?: boolean;
}

export interface BrowserJavaScriptProjectExecutionState {
  cancelled: boolean;
  abortController: AbortController;
  cleanupHostGlobals?: () => void;
  dispatchSignal?: (signal: string) => boolean;
  handledSignal?: string;
  kernelFileSystem?: BrowserTraceKernelFileSystem;
  kernelNetwork?: BrowserTraceKernelNetwork;
  kernelSyscalls?: {
    dispatchSync(request: TraceKernelSyscallRequest): TraceKernelSyscallResult;
  };
}

export interface BrowserTraceKernelNetwork {
  dispatch(request: TraceKernelSyscallRequest): Promise<TraceKernelSyscallResult>;
}

export interface BrowserTraceKernelFileSystem {
  open(path: string, options?: TraceKernelOpenFileOptions): number;
  read(fd: number, maxBytes: number, position?: number): Uint8Array;
  write(fd: number, bytes: Uint8Array, position?: number): number;
  closeDescriptor(fd: number): void;
  dup(fd: number): number;
  getCloseOnExec(fd: number): boolean;
  setCloseOnExec(fd: number, closeOnExec: boolean): void;
  fstat(fd: number): TraceKernelStat;
  ftruncate(fd: number, length: number): void;
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
  stat(path: string): TraceKernelStat;
  lstat(path: string): TraceKernelStat;
  realpath(path: string): string;
  readdir(path: string): readonly TraceKernelDirectoryEntry[];
  mkdir(path: string, options?: TraceKernelMkdirOptions): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  link(existingPath: string, newPath: string): void;
  symlink(target: string, linkPath: string): void;
  readlink(path: string): string;
  rename(sourcePath: string, destinationPath: string): void;
}
