import { AsyncLocalStorage } from 'node:async_hooks';
import {
  defineCommand,
} from 'just-bash/browser';
import {
  applyRuntimeCommandResultFiles,
  canCreateRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeCommandStdinPipeClosed,
  runtimeFileChangePath,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
} from '../../harness-core/src/runtime-project';
import {
  isRuntimeKernelVirtualNamespacePath,
  normalizeRuntimeProcPath,
  runtimeDeviceDirEntries,
  runtimeDeviceEntryKind,
  runtimeDeviceInputSource,
  runtimeDeviceOutputTarget,
  runtimeKernelAccessTarget,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileReadErrorMessage,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorMessage,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorMessage,
  runtimeKernelMutationTarget,
  runtimeKernelReadErrorMessage,
  runtimeKernelReadTarget,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkTarget,
  runtimeKernelVirtualDevices,
  runtimeKernelVirtualFiles,
  runtimeKernelVirtualPaths,
  runtimeKernelWriteErrorMessage,
  runtimeKernelWriteTarget,
  publicRuntimeKernelVirtualFiles,
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '../../harness-core/src/runtime-kernel';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import type { Language } from '../../harness-core/src/runtime-types';
import type {
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventStream,
  RuntimeCommandExecutionLimits,
  RuntimeCommandError,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelInfo,
  RuntimeTraceKernelConfig,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionCommandStep,
  RuntimeProjectSessionInfo,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectSnapshot,
  RuntimeWorkspaceActor,
} from '../../harness-core/src/runtime-project';
import type {
  CppProjectCommandRunner,
  CSharpProjectCommandRunner,
  CreateRuntimeWorkspaceOptions,
  JavaProjectCommandRunner,
  JavaScriptProjectCommandRunner,
  ProjectWorkspaceCommand,
  PythonProjectCommandRunner,
  RuntimePackageDependencyProvider,
  RuntimePackageInstallRequest,
  RuntimePackageManagerConfig,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  TypeScriptProjectCommandRunner,
} from './index';



export function isBrowserAsyncLocalStorageSingleFlight(): boolean {
  return (AsyncLocalStorage as typeof AsyncLocalStorage & { __tracecodeBrowserSingleFlight?: unknown })
    .__tracecodeBrowserSingleFlight === true;
}


export function normalizeRuntimeSchedulerConfig(config: RuntimeTraceKernelSchedulerConfig | undefined): RuntimeCommandSchedulerOptions {
  const forceSingleFlight = isBrowserAsyncLocalStorageSingleFlight();
  const defaultMaxConcurrentCommands = forceSingleFlight
    ? 1
    : typeof (globalThis as { process?: unknown }).process === 'object'
      ? 32
      : 1;
  const configuredMaxConcurrentCommands = Number.isFinite(config?.maxConcurrentCommands)
    ? Math.max(1, Math.floor(config?.maxConcurrentCommands ?? 0))
    : defaultMaxConcurrentCommands;
  const maxQueuedCommands = config?.maxQueuedCommands === undefined || !Number.isFinite(config.maxQueuedCommands)
    ? undefined
    : Math.max(0, Math.floor(config.maxQueuedCommands));
  return {
    maxConcurrentCommands: forceSingleFlight ? 1 : configuredMaxConcurrentCommands,
    ...(maxQueuedCommands !== undefined ? { maxQueuedCommands } : {}),
  };
}


export class RuntimeKernelInterruptedError extends Error {
  readonly code = 'EINTR';
  readonly errno = 4;

  constructor(
    readonly syscall: string,
    readonly path: string
  ) {
    super(`EINTR: interrupted system call, ${syscall} '${path}'`);
  }
}


export class RuntimeKernelAdmissionRejectedError extends Error {
  readonly code = 'EAGAIN';
  readonly errno = 11;
  readonly syscall = 'sched';

  constructor(
    readonly path: string,
    message = `EAGAIN: resource temporarily unavailable, ${path}`
  ) {
    super(message);
  }

  toCommandError(): RuntimeCommandError {
    return {
      code: this.code,
      errno: this.errno,
      syscall: this.syscall,
      path: this.path,
      message: this.message,
    };
  }
}


export interface RuntimeCommandSchedulerOptions {
  maxConcurrentCommands: number;
  maxQueuedCommands?: number;
}


export interface RuntimeCommandSchedulerJob {
  pid: number;
  command: string;
  signal?: AbortSignal;
}


export interface RuntimeCommandSchedulerQueueEntry {
  readonly job: RuntimeCommandSchedulerJob;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  abortListener?: () => void;
}


export interface RuntimeCommandSchedulerSnapshot {
  running: number;
  queued: number;
  maxConcurrentCommands: number;
  maxQueuedCommands: number | null;
}


export class RuntimeCommandScheduler {
  private barrier = Promise.resolve();
  private runningCommands = 0;
  private readonly queue: RuntimeCommandSchedulerQueueEntry[] = [];
  private readonly activeCommands = new Set<Promise<unknown>>();

  constructor(private readonly options: RuntimeCommandSchedulerOptions) {}

  snapshot(): RuntimeCommandSchedulerSnapshot {
    return {
      running: this.runningCommands,
      queued: this.queue.length,
      maxConcurrentCommands: this.options.maxConcurrentCommands,
      maxQueuedCommands: this.options.maxQueuedCommands ?? null,
    };
  }

  runCommand<T>(job: RuntimeCommandSchedulerJob, fn: () => Promise<T>): Promise<T> {
    const waitForBarrier = this.barrier.catch(() => undefined);
    const command = waitForBarrier
      .then(() => this.acquire(job))
      .then(async () => {
        try {
          return await fn();
        } finally {
          this.release();
        }
      });
    this.activeCommands.add(command);
    command.then(() => {
      this.activeCommands.delete(command);
    }, () => {
      this.activeCommands.delete(command);
    });
    return command;
  }

  runBarrier<T>(fn: () => Promise<T>): Promise<T> {
    const previousBarrier = this.barrier.catch(() => undefined);
    const commandsBeforeBarrier = [...this.activeCommands];
    const barrier = previousBarrier.then(async () => {
      await Promise.allSettled(commandsBeforeBarrier);
      return fn();
    });
    this.barrier = barrier.then(() => undefined, () => undefined);
    return barrier;
  }

  private acquire(job: RuntimeCommandSchedulerJob): Promise<void> {
    if (job.signal?.aborted) {
      return Promise.reject(new RuntimeKernelInterruptedError('sched', String(job.pid)));
    }
    if (this.runningCommands < this.options.maxConcurrentCommands) {
      this.runningCommands += 1;
      return Promise.resolve();
    }
    if (this.options.maxQueuedCommands !== undefined && this.queue.length >= this.options.maxQueuedCommands) {
      return Promise.reject(new RuntimeKernelAdmissionRejectedError(String(job.pid), `EAGAIN: command scheduler queue full, ${job.command}`));
    }

    return new Promise((resolve, reject) => {
      const entry: RuntimeCommandSchedulerQueueEntry = {
        job,
        resolve: () => {
          this.runningCommands += 1;
          resolve();
        },
        reject,
      };
      if (job.signal) {
        entry.abortListener = () => {
          this.removeQueueEntry(entry);
          reject(new RuntimeKernelInterruptedError('sched', String(job.pid)));
        };
        job.signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private release(): void {
    this.runningCommands = Math.max(0, this.runningCommands - 1);
    this.drain();
  }

  private drain(): void {
    while (this.runningCommands < this.options.maxConcurrentCommands && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.abortListener) entry.job.signal?.removeEventListener('abort', entry.abortListener);
      if (entry.job.signal?.aborted) {
        entry.reject(new RuntimeKernelInterruptedError('sched', String(entry.job.pid)));
        continue;
      }
      entry.resolve();
    }
  }

  private removeQueueEntry(entry: RuntimeCommandSchedulerQueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    if (entry.abortListener) entry.job.signal?.removeEventListener('abort', entry.abortListener);
  }
}
