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
} from '@tracecode/runtime-core';
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
} from '@tracecode/runtime-core';
import { getLanguageRuntimeInfo } from '@tracecode/runtime-core';
import type { Language } from '@tracecode/runtime-core';
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
} from '@tracecode/runtime-core';
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
import { dirname, isWithinWorkspace, normalizeTerminalAbsolutePath } from './paths';
import { RuntimeKernelInterruptedError } from './scheduler';



export type RuntimeFileSystemLockMode = 'shared' | 'exclusive';


export interface RuntimeFileSystemLockRequest {
  path: string;
  mode: RuntimeFileSystemLockMode;
  reason: string;
}


export interface RuntimeFileSystemLockQueueEntry {
  mode: RuntimeFileSystemLockMode;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}


export interface RuntimeFileSystemLockState {
  readers: number;
  writer: boolean;
  queue: RuntimeFileSystemLockQueueEntry[];
}


export class RuntimeFileSystemLockCoordinator {
  private readonly states = new Map<string, RuntimeFileSystemLockState>();

  snapshot(): Array<{
    path: string;
    active: boolean;
    waiting: number;
    readers: number;
    writer: boolean;
    waitingReaders: number;
    waitingWriters: number;
  }> {
    return [...this.states.entries()]
      .filter(([, state]) => state.readers > 0 || state.writer || state.queue.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, state]) => ({
        path,
        active: state.readers > 0 || state.writer,
        waiting: state.queue.length,
        readers: state.readers,
        writer: state.writer,
        waitingReaders: state.queue.filter((entry) => entry.mode === 'shared').length,
        waitingWriters: state.queue.filter((entry) => entry.mode === 'exclusive').length,
      }));
  }

  async withLocks<T>(
    requests: readonly RuntimeFileSystemLockRequest[],
    fn: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const lockRequests = this.normalizeRequests(requests);
    if (lockRequests.length === 0) return fn();
    if (signal?.aborted) {
      throw new RuntimeKernelInterruptedError('flock', lockRequests.map((request) => request.path).join(','));
    }

    const releases: Array<() => void> = [];
    try {
      for (const request of lockRequests) {
        releases.push(await this.acquire(request, signal));
      }
      return await fn();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }

  async withExclusiveLocks<T>(paths: readonly string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withLocks(
      paths.map((path) => ({ path, mode: 'exclusive', reason: 'exclusive' })),
      fn,
      signal
    );
  }

  private normalizeRequests(requests: readonly RuntimeFileSystemLockRequest[]): RuntimeFileSystemLockRequest[] {
    const merged = new Map<string, RuntimeFileSystemLockRequest>();
    for (const request of requests) {
      const path = normalizeFsLockPath(request.path);
      if (!path) continue;
      const existing = merged.get(path);
      if (!existing || existing.mode === 'shared' && request.mode === 'exclusive') {
        merged.set(path, { ...request, path });
      }
    }
    return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private acquire(request: RuntimeFileSystemLockRequest, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new RuntimeKernelInterruptedError('flock', request.path));
    }
    const state = this.stateFor(request.path);
    if (this.canAcquireImmediately(state, request.mode)) {
      this.activate(state, request.mode);
      return Promise.resolve(() => this.release(request.path, request.mode));
    }

    return new Promise((resolve, reject) => {
      const entry: RuntimeFileSystemLockQueueEntry = {
        mode: request.mode,
        resolve: () => {
          this.activate(state, request.mode);
          resolve(() => this.release(request.path, request.mode));
        },
        reject,
      };
      if (signal) {
        entry.signal = signal;
        entry.abortListener = () => {
          this.removeQueueEntry(request.path, entry);
          reject(new RuntimeKernelInterruptedError('flock', request.path));
        };
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }
      state.queue.push(entry);
    });
  }

  private stateFor(path: string): RuntimeFileSystemLockState {
    const existing = this.states.get(path);
    if (existing) return existing;
    const state: RuntimeFileSystemLockState = { readers: 0, writer: false, queue: [] };
    this.states.set(path, state);
    return state;
  }

  private canAcquireImmediately(state: RuntimeFileSystemLockState, mode: RuntimeFileSystemLockMode): boolean {
    if (mode === 'shared') {
      return !state.writer && !state.queue.some((entry) => entry.mode === 'exclusive');
    }
    return !state.writer && state.readers === 0;
  }

  private activate(state: RuntimeFileSystemLockState, mode: RuntimeFileSystemLockMode): void {
    if (mode === 'shared') state.readers += 1;
    else state.writer = true;
  }

  private release(path: string, mode: RuntimeFileSystemLockMode): void {
    const state = this.states.get(path);
    if (!state) return;
    if (mode === 'shared') state.readers = Math.max(0, state.readers - 1);
    else state.writer = false;
    this.drain(path, state);
    if (state.readers === 0 && !state.writer && state.queue.length === 0) {
      this.states.delete(path);
    }
  }

  private drain(path: string, state: RuntimeFileSystemLockState): void {
    if (state.writer || state.readers > 0 || state.queue.length === 0) return;
    const first = state.queue[0];
    if (!first) return;
    if (first.mode === 'exclusive') {
      state.queue.shift();
      this.cleanupQueueEntry(first);
      first.resolve();
      return;
    }
    const exclusiveIndex = state.queue.findIndex((entry) => entry.mode === 'exclusive');
    const grantedReaders = state.queue.splice(0, exclusiveIndex === -1 ? state.queue.length : exclusiveIndex);
    for (const reader of grantedReaders) {
      this.cleanupQueueEntry(reader);
      reader.resolve();
    }
  }

  private removeQueueEntry(path: string, entry: RuntimeFileSystemLockQueueEntry): void {
    const state = this.states.get(path);
    if (!state) return;
    const index = state.queue.indexOf(entry);
    if (index >= 0) state.queue.splice(index, 1);
    this.cleanupQueueEntry(entry);
    if (state.readers === 0 && !state.writer) {
      this.drain(path, state);
    }
    if (state.readers === 0 && !state.writer && state.queue.length === 0) {
      this.states.delete(path);
    }
  }

  private cleanupQueueEntry(entry: RuntimeFileSystemLockQueueEntry): void {
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
    }
    entry.abortListener = undefined;
    entry.signal = undefined;
  }
}


export class RuntimeFileGenerationConflictError extends Error {
  readonly code = 'ESTALE';
  readonly errno = 116;
  readonly syscall = 'write';

  constructor(
    readonly path: string,
    readonly expectedGeneration: number,
    readonly actualGeneration: number
  ) {
    super(`ESTALE: stale file handle, write '${path}'`);
  }

  toCommandError(): RuntimeCommandError {
    return {
      code: this.code,
      errno: this.errno,
      syscall: this.syscall,
      path: this.path,
      message: this.message,
      detail: {
        expectedGeneration: this.expectedGeneration,
        actualGeneration: this.actualGeneration,
      },
    };
  }
}


export function normalizeFsLockPath(path: string): string {
  const normalized = path.startsWith('/')
    ? normalizeTerminalAbsolutePath(path)
    : path.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}


export function fsMutationLockPaths(workspaceRoot: string, absolutePath: string): string[] {
  const normalizedPath = normalizeFsLockPath(absolutePath);
  const normalizedRoot = normalizeFsLockPath(workspaceRoot);
  if (!isWithinWorkspace(normalizedRoot, normalizedPath)) return [normalizedPath];

  const paths = [normalizedPath];
  let current = dirname(normalizedPath);
  while (current !== normalizedRoot && isWithinWorkspace(normalizedRoot, current)) {
    paths.push(current);
    current = dirname(current);
  }
  return paths;
}


export type RuntimeFileSystemMutationKind =
  | 'file-write'
  | 'file-create'
  | 'directory-create'
  | 'delete'
  | 'recursive-delete'
  | 'copy'
  | 'rename'
  | 'subtree';


export function fsAncestorLockRequests(
  workspaceRoot: string,
  absolutePath: string,
  mode: RuntimeFileSystemLockMode,
  reason: string
): RuntimeFileSystemLockRequest[] {
  const normalizedPath = normalizeFsLockPath(absolutePath);
  const normalizedRoot = normalizeFsLockPath(workspaceRoot);
  if (!isWithinWorkspace(normalizedRoot, normalizedPath)) return [];
  const requests: RuntimeFileSystemLockRequest[] = [];
  let current = dirname(normalizedPath);
  while (isWithinWorkspace(normalizedRoot, current)) {
    requests.push({ path: current, mode, reason });
    if (current === normalizedRoot) break;
    current = dirname(current);
  }
  return requests;
}


export function fsParentStructureLockRequests(
  workspaceRoot: string,
  absolutePath: string,
  reason: string
): RuntimeFileSystemLockRequest[] {
  const parent = dirname(normalizeFsLockPath(absolutePath));
  return [
    ...fsAncestorLockRequests(workspaceRoot, parent, 'shared', reason),
    { path: parent, mode: 'exclusive', reason },
  ];
}


export function fsFileMutationLockRequests(
  workspaceRoot: string,
  absolutePath: string,
  reason: string
): RuntimeFileSystemLockRequest[] {
  const normalizedPath = normalizeFsLockPath(absolutePath);
  return [
    ...fsAncestorLockRequests(workspaceRoot, normalizedPath, 'shared', reason),
    { path: normalizedPath, mode: 'exclusive', reason },
  ];
}


export function fsMutationLockRequests(
  workspaceRoot: string,
  paths: readonly string[],
  kind: RuntimeFileSystemMutationKind
): RuntimeFileSystemLockRequest[] {
  if (kind === 'rename') {
    const [source, destination] = paths;
    if (!source || !destination) return [];
    return [
      ...fsParentStructureLockRequests(workspaceRoot, source, 'rename-source-parent'),
      ...fsParentStructureLockRequests(workspaceRoot, destination, 'rename-destination-parent'),
      { path: source, mode: 'exclusive', reason: 'rename-source' },
      { path: destination, mode: 'exclusive', reason: 'rename-destination' },
    ];
  }
  if (kind === 'copy') {
    const [source, destination] = paths;
    if (!source || !destination) return [];
    return [
      ...fsAncestorLockRequests(workspaceRoot, source, 'shared', 'copy-source'),
      { path: source, mode: 'shared', reason: 'copy-source' },
      ...fsParentStructureLockRequests(workspaceRoot, destination, 'copy-destination-parent'),
      { path: destination, mode: 'exclusive', reason: 'copy-destination' },
    ];
  }
  return paths.flatMap((path) => {
    if (kind === 'file-write') return fsFileMutationLockRequests(workspaceRoot, path, kind);
    if (kind === 'file-create') {
      return [
        ...fsParentStructureLockRequests(workspaceRoot, path, 'file-create-parent'),
        { path, mode: 'exclusive', reason: 'file-create' },
      ];
    }
    if (kind === 'directory-create' || kind === 'delete' || kind === 'recursive-delete') {
      return [
        ...fsParentStructureLockRequests(workspaceRoot, path, kind),
        { path, mode: 'exclusive', reason: kind },
      ];
    }
    return [
      ...fsAncestorLockRequests(workspaceRoot, path, 'shared', kind),
      { path, mode: 'exclusive', reason: kind },
    ];
  });
}


export function fsMutationGenerationPaths(
  workspaceRoot: string,
  paths: readonly string[],
  kind: RuntimeFileSystemMutationKind
): string[] {
  const normalizedPaths = paths.map(normalizeFsLockPath);
  const parentPath = (path: string): string | null => {
    const normalizedRoot = normalizeFsLockPath(workspaceRoot);
    const parent = dirname(path);
    return isWithinWorkspace(normalizedRoot, parent) ? parent : null;
  };
  const withParents = (selectedPaths: readonly string[]): string[] => [
    ...selectedPaths,
    ...selectedPaths.map(parentPath).filter((path): path is string => Boolean(path)),
  ];
  if (kind === 'file-write') return normalizedPaths;
  if (kind === 'copy') {
    const destination = normalizedPaths[1];
    return destination ? withParents([destination]) : [];
  }
  if (kind === 'rename') {
    const [source, destination] = normalizedPaths;
    return source && destination ? withParents([source, destination]) : [];
  }
  if (kind === 'file-create' || kind === 'directory-create' || kind === 'delete' || kind === 'recursive-delete') {
    return withParents(normalizedPaths);
  }
  return normalizedPaths.flatMap((path) => fsMutationLockPaths(workspaceRoot, path));
}
