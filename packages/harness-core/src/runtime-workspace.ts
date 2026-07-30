import type {
  KernelJournalRecord,
  RuntimeCommandCompletion,
  RuntimeCommandCompletionOptions,
  RuntimeCommandEvent,
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeProjectCommandOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
} from './runtime-command';
import type { RuntimeKernelInfo } from './runtime-kernel-contracts';
import type { RuntimeWorkspaceHttpClient } from './runtime-kernel-http';
import type {
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeProjectPatch,
  RuntimeProjectPatchOptions,
  RuntimeProjectSnapshot,
  RuntimeWorkspaceActor,
} from './runtime-workspace-manifest';
import type {
  RuntimeProjectSessionInfo,
  RuntimeProjectSessionLifecycle,
} from './runtime-workspace-session';

export type RuntimeWorkspaceEvent = RuntimeCommandEvent;

export type RuntimeWorkspaceEventHandler = (event: RuntimeWorkspaceEvent) => void;

export type RuntimeWorkspaceUnsubscribe = () => void;

export type RuntimeWorkspaceMutationHandler = (revision: number) => void;

export interface RuntimeWorkspaceKernel {
  readonly info: RuntimeKernelInfo;
  readonly mutationVersion: number;
  createProcess(options: RuntimeWorkspaceProcessOptions): RuntimeWorkspaceProcess;
  readFile(path: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<string>;
  writeFile(path: string, contents: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<void>;
  writeSkillFiles(files: readonly RuntimeFile[], actor?: RuntimeWorkspaceActor): Promise<void>;
  deleteFile(path: string, actor?: RuntimeWorkspaceActor): Promise<void>;
  applyFileChange(change: RuntimeFileChange, actor?: RuntimeWorkspaceActor, phase?: RuntimeFileMutationPhase): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  watchMutations(listener: RuntimeWorkspaceMutationHandler): RuntimeWorkspaceUnsubscribe;
}

export type RuntimeWorkspaceProcessSignalPolicy = 'standard' | 'system-only';

export interface RuntimeWorkspaceProcessOptions {
  /** Process name shown by ps and /proc. The kernel does not interpret this value. */
  name: string;
  actor: RuntimeWorkspaceActor;
  cwd?: string;
  env?: Record<string, string>;
  /** `system-only` processes cannot be signaled from workspace commands. */
  signalPolicy?: RuntimeWorkspaceProcessSignalPolicy;
}

/**
 * A persistent, kernel-owned process context for a host application surface.
 * Operations performed through the handle are journaled with this process's
 * actor and PID, and commands are created as its children.
 */
export interface RuntimeWorkspaceProcess {
  readonly pid: number;
  readonly name: string;
  readonly actor: RuntimeWorkspaceActor;
  readonly signalPolicy: RuntimeWorkspaceProcessSignalPolicy;
  readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string>;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  deleteFile(path: string): Promise<void>;
  applyFileChange(change: RuntimeFileChange, phase?: RuntimeFileMutationPhase): Promise<void>;
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  runProjectCommand(name: string, options?: RuntimeProjectCommandOptions): Promise<RuntimeCommandResult>;
  createTerminalSession(options?: RuntimeProjectTerminalSessionOptions): RuntimeProjectTerminalSession;
  /** System/control-plane teardown. This is not reachable through workspace signals. */
  dispose(): void;
}

export interface RuntimeWorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
  ino?: number;
  mode?: number;
  size?: number;
  mtimeMs?: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
}

export interface RuntimeWorkspaceRemoveOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly cwd: string;
  readonly http: RuntimeWorkspaceHttpClient;
  readonly projectSession?: RuntimeProjectSessionInfo;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  writeFiles(files: readonly RuntimeFile[]): Promise<void>;
  writeSkillFiles(files: readonly RuntimeFile[]): Promise<void>;
  appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<RuntimeWorkspaceStat>;
  readDir(path?: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  moveFile(sourcePath: string, destinationPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  remove(path: string, options?: RuntimeWorkspaceRemoveOptions): Promise<void>;
  isReadOnly(path: string): boolean;
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  runProjectCommand(name: string, options?: RuntimeProjectCommandOptions): Promise<RuntimeCommandResult>;
  completeCommand(input: string, cursor: number, options?: RuntimeCommandCompletionOptions): Promise<RuntimeCommandCompletion | null>;
  createTerminalSession(options?: RuntimeProjectTerminalSessionOptions): RuntimeProjectTerminalSession;
  checkExpiration(now?: Date | string | number): Promise<RuntimeProjectSessionLifecycle | null>;
  destroy(options?: { reason?: string; clearStorage?: boolean }): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  journal(sinceSeq?: number): readonly KernelJournalRecord[];
  exportPatch(base: RuntimeProjectSnapshot, options?: RuntimeProjectPatchOptions): Promise<RuntimeProjectPatch>;
  importPatch(base: RuntimeProjectSnapshot, patch: RuntimeProjectPatch, options?: RuntimeProjectPatchOptions): Promise<void>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  dispose(): void;
}
