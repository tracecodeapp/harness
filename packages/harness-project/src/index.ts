import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Bash,
  defineCommand,
  InMemoryFs,
} from 'just-bash/browser';
import {
  applyRuntimeCommandResultFiles,
  assertRuntimeFinalDiffBudget,
  canCreateRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  createRuntimeProjectIoBridge,
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  runtimeHttpBodyFromText,
  runtimeHttpBodyText,
  runtimeHttpRequestBytes,
  runtimeHttpRequestText,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
  runtimeWorkspaceActorPreset,
  runtimeWorkspaceHttpCapabilitiesPreset,
  runtimeCommandStdinPipeClosed,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
  RuntimeProjectLiveIoController,
  runtimeFileChangePath,
  runRuntimeProjectWorkerBridge,
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
  publicRuntimeKernelInfo,
  publicRuntimeKernelVirtualFiles,
  readPublicRuntimeProcFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '../../harness-core/src/runtime-kernel';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import type { Language } from '../../harness-core/src/runtime-types';
import type {
  BashOptions,
  Command,
  CommandContext,
  CustomCommand,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import packageJson from '../package.json' with { type: 'json' };
import type {
  RuntimeCommandOptions,
  RuntimeCommandCompletion,
  RuntimeCommandCompletionMatch,
  RuntimeCommandCompletionOptions,
  RuntimeCommandError,
  RuntimeCommandResult,
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandEventStream,
  RuntimeCommandExecutionLimits,
  RuntimeCommandFileChangeEvent,
  RuntimeCommandOutputEvent,
  RuntimeCommandStatusEvent,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelHostConfig,
  RuntimeKernelHostInfo,
  RuntimeKernelInfo,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpBodyInit,
  RuntimeKernelHttpBodyPayload,
  RuntimeKernelHttpDispatchOptions,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeWorkspaceHttpClient,
  RuntimeWorkspaceHttpJsonRequestOptions,
  RuntimeWorkspaceHttpJsonResponse,
  RuntimeWorkspaceHttpRequestOptions,
  RuntimeKernelUserConfig,
  RuntimeKernelUserInfo,
  RuntimeKernelWorkspaceConfig,
  RuntimeKernelWorkspaceInfo,
  RuntimeTraceKernelConfig,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandOptions,
  RuntimeProjectCommandRunner,
  RuntimeProjectTerminalPrompt,
  RuntimeProjectTerminalEvent,
  RuntimeProjectTerminalEventHandler,
  RuntimeProjectTerminalInputState,
  RuntimeProjectTerminalInputStateReason,
  RuntimeProjectTerminalRunOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionCommandStep,
  RuntimeProjectSessionLifecycle,
  RuntimeProjectSessionFile,
  RuntimeProjectSessionInfo,
  RuntimeProjectIoBridge,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchDirectoryCreate,
  RuntimeProjectPatchDirectoryDelete,
  RuntimeProjectPatchFileDelete,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectPatchOptions,
  RuntimeProjectLiveIoControllerOptions,
  RuntimeProjectWorkerBridgeOptions,
  RuntimeProjectSnapshot,
  RuntimeWorkspace,
  RuntimeWorkspaceActor,
  RuntimeWorkspaceActorKind,
  RuntimeWorkspaceCapabilities,
  RuntimeWorkspaceEvent,
  RuntimeWorkspaceEventHandler,
  RuntimeWorkspaceKernel,
  RuntimeWorkspaceRemoveOptions,
  RuntimeWorkspaceStat,
  RuntimeWorkspaceUnsubscribe,
} from '../../harness-core/src/runtime-project';

export type ProjectWorkspaceCommand = unknown;

export interface ProjectWorkspaceJavaScriptConfig {
  bootstrap?: string;
  invokeTool?: (path: string, argsJson: string) => Promise<string>;
}

export interface ProjectWorkspaceExecutionLimits extends RuntimeCommandExecutionLimits {}

export type RuntimePackageManagerName = 'npm';

export interface RuntimePackageManifest {
  path: string;
  directory: string;
  json: Record<string, unknown>;
}

export interface RuntimePackageInstallRequest {
  manager: RuntimePackageManagerName;
  command: 'install' | 'ci' | 'add';
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  manifest: RuntimePackageManifest;
  project: RuntimeProjectSnapshot;
  signal?: AbortSignal;
}

export interface RuntimePackageDependencyProvider {
  install(request: RuntimePackageInstallRequest): Promise<RuntimeCommandResult>;
}

export interface RuntimePackageManagerConfig {
  managers?: readonly RuntimePackageManagerName[];
  dependencyProvider?: RuntimePackageDependencyProvider;
  autoLinkBins?: boolean;
  npmVersion?: string;
}

export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;

export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;

export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;

export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;

export type TypeScriptProjectCommandRequest = RuntimeProjectCommandRequest<'compile'>;

export type TypeScriptProjectCommandRunner = RuntimeProjectCommandRunner<TypeScriptProjectCommandRequest>;

export type JavaProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type JavaProjectCommandRunner = RuntimeProjectCommandRunner<JavaProjectCommandRequest>;

export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CppProjectCommandRunner = RuntimeProjectCommandRunner<CppProjectCommandRequest>;

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;

export interface RuntimeTraceKernelControlOptions {
  reset?: () => Promise<void> | void;
}

export interface CreateRuntimeWorkspaceOptions {
  projectSession?: RuntimeProjectSession;
  files?: readonly RuntimeFile[];
  directories?: readonly string[];
  skills?: readonly RuntimeFile[];
  entrypoint?: string;
  cwd?: string;
  env?: Record<string, string>;
  commands?: readonly string[];
  customCommands?: readonly ProjectWorkspaceCommand[];
  pythonRunner?: PythonProjectCommandRunner;
  nodeRunner?: JavaScriptProjectCommandRunner;
  javaRunner?: JavaProjectCommandRunner;
  typescriptRunner?: TypeScriptProjectCommandRunner;
  cppRunner?: CppProjectCommandRunner;
  csharpRunner?: CSharpProjectCommandRunner;
  packageManager?: boolean | RuntimePackageManagerConfig;
  python?: boolean;
  javascript?: boolean | ProjectWorkspaceJavaScriptConfig;
  executionLimits?: ProjectWorkspaceExecutionLimits;
  kernel?: RuntimeTraceKernelConfig;
  kernelControl?: RuntimeTraceKernelControlOptions;
}

export class RuntimeProjectWorkspaceTerminalSession implements RuntimeProjectTerminalSession {
  private currentCwd: string;
  private readonly env: Record<string, string>;
  private currentInputState: RuntimeProjectTerminalInputState;
  private activeStdinPipe: RuntimeCommandOptions['stdinPipe'] | null = null;
  private activeTerminalEventHandler?: RuntimeProjectTerminalEventHandler;
  private activeStdinPrompt = '';
  private activeCommand = '';
  private activeRun = false;
  private readonly onTerminalEvent?: RuntimeProjectTerminalEventHandler;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      kernelInfo: RuntimeKernelInfo;
      resolveCwd: (currentCwd: string, target: string) => Promise<string>;
      runCommand: (command: string, options?: RuntimeCommandOptions) => Promise<RuntimeCommandResult>;
      jobRecords: () => readonly RuntimeProjectTerminalJobRecord[];
      isVerbose: () => boolean;
    },
    sessionOptions: RuntimeProjectTerminalSessionOptions = {}
  ) {
    this.currentCwd = sessionOptions.cwd ?? options.workspaceRoot;
    this.env = { ...(sessionOptions.env ?? {}) };
    this.onTerminalEvent = sessionOptions.onTerminalEvent;
    this.currentInputState = this.createInputState('command');
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get prompt(): RuntimeProjectTerminalPrompt {
    const user = this.options.kernelInfo.user.username;
    const host = this.options.kernelInfo.host.hostname;
    const label = terminalCwdLabel(this.options.workspaceRoot, this.currentCwd, this.options.kernelInfo.home);
    return {
      user,
      host,
      cwd: this.currentCwd,
      label,
      text: `${user}@${host} ${label} %`,
    };
  }

  get inputState(): RuntimeProjectTerminalInputState {
    return this.currentInputState;
  }

  writeStdin(data: string): boolean {
    if (!this.activeStdinPipe || this.currentInputState.mode !== 'stdin') return false;
    this.activeStdinPipe.write(data);
    this.activeStdinPrompt = '';
    this.setInputState('busy', 'stdin-submit');
    return true;
  }

  private createInputState(
    mode: RuntimeProjectTerminalInputState['mode'],
    label = this.prompt.text,
    command = this.activeCommand
  ): RuntimeProjectTerminalInputState {
    return {
      mode,
      prompt: this.prompt,
      label,
      hidden: mode === 'busy',
      disabled: mode === 'busy',
      ...(command ? { command } : {}),
    };
  }

  private emitTerminalEvent(reason: RuntimeProjectTerminalInputStateReason): void {
    const event = { type: 'input-state' as const, reason, state: this.currentInputState };
    this.onTerminalEvent?.(event);
    this.activeTerminalEventHandler?.(event);
  }

  private setInputState(
    mode: RuntimeProjectTerminalInputState['mode'],
    reason: RuntimeProjectTerminalInputStateReason,
    label = this.prompt.text
  ): RuntimeProjectTerminalInputState {
    this.currentInputState = this.createInputState(mode, label);
    this.emitTerminalEvent(reason);
    return this.currentInputState;
  }

  async run(command: string, options: RuntimeProjectTerminalRunOptions = {}): Promise<RuntimeCommandResult> {
    const trimmed = command.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };
    if (this.activeRun) {
      return {
        stdout: '',
        stderr: 'terminal: foreground command already running\n',
        exitCode: 16,
        error: {
          code: 'EBUSY',
          errno: 16,
          syscall: 'run',
          path: this.currentCwd,
          message: `EBUSY: terminal foreground command already running, ${this.currentCwd}`,
        },
      };
    }

    const commandList = parseTerminalCommandList(trimmed);
    if (commandList.some((segment) => segment.background)) {
      return this.runTerminalCommandList(trimmed, commandList, options);
    }

    return this.runForegroundTerminalSubmission(trimmed, options);
  }

  private async runTerminalCommandList(
    submittedCommand: string,
    segments: readonly TerminalCommandListSegment[],
    options: RuntimeProjectTerminalRunOptions
  ): Promise<RuntimeCommandResult> {
    this.activeRun = true;

    const previousStdinPipe = this.activeStdinPipe;
    const previousTerminalEventHandler = this.activeTerminalEventHandler;
    const previousStdinPrompt = this.activeStdinPrompt;
    const previousCommand = this.activeCommand;
    const ownedStdinPipe = options.stdinPipe
      ? undefined
      : canCreateRuntimeCommandStdinPipe()
        ? createRuntimeCommandStdinPipe()
        : undefined;
    const commandStdinPipe = options.stdinPipe ?? ownedStdinPipe;
    this.activeStdinPipe = commandStdinPipe ?? null;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = submittedCommand;
    this.setInputState('busy', 'command-start');

    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let error: RuntimeCommandError | undefined;
      for (const segment of segments) {
        if (segment.background) {
          stdout += this.startTerminalBackgroundCommand(segment.command, options, this.currentCwd);
          continue;
        }
        const result = await this.runForegroundTerminalCommand(segment.command, options, commandStdinPipe);
        stdout += result.stdout;
        stderr += result.stderr;
        exitCode = result.exitCode;
        error = result.error;
      }
      return {
        stdout,
        stderr,
        exitCode,
        ...(error ? { error } : {}),
      };
    } finally {
      ownedStdinPipe?.close();
      this.activeStdinPipe = previousStdinPipe;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      this.activeRun = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private async runForegroundTerminalSubmission(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions
  ): Promise<RuntimeCommandResult> {
    this.activeRun = true;

    const previousStdinPipe = this.activeStdinPipe;
    const previousTerminalEventHandler = this.activeTerminalEventHandler;
    const previousStdinPrompt = this.activeStdinPrompt;
    const previousCommand = this.activeCommand;
    const ownedStdinPipe = options.stdinPipe
      ? undefined
      : canCreateRuntimeCommandStdinPipe()
        ? createRuntimeCommandStdinPipe()
        : undefined;
    const commandStdinPipe = options.stdinPipe ?? ownedStdinPipe;
    this.activeStdinPipe = commandStdinPipe ?? null;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = trimmed;
    this.setInputState('busy', 'command-start');

    try {
      return await this.runForegroundTerminalCommand(trimmed, options, commandStdinPipe);
    } finally {
      ownedStdinPipe?.close();
      this.activeStdinPipe = previousStdinPipe;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      this.activeRun = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private async runForegroundTerminalCommand(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions,
    commandStdinPipe: RuntimeCommandOptions['stdinPipe']
  ): Promise<RuntimeCommandResult> {
    const words = parseSimpleCommandWords(trimmed);
    if (words?.[0] === 'cd') {
      if (words.length > 2) {
        return { stdout: '', stderr: 'cd: too many arguments\n', exitCode: 1 };
      }
      try {
        this.currentCwd = await this.options.resolveCwd(this.currentCwd, words[1] ?? this.options.workspaceRoot);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (error) {
        return { stdout: '', stderr: `cd: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    }

    if (words?.[0] === 'pwd' && words.length === 1) {
      return { stdout: `${this.currentCwd}\n`, stderr: '', exitCode: 0 };
    }

    let nextCwd: string | null = null;
    const leadingCdTarget = leadingPersistentCdTarget(trimmed);
    if (leadingCdTarget !== null) {
      try {
        nextCwd = await this.options.resolveCwd(this.currentCwd, leadingCdTarget ?? this.options.workspaceRoot);
      } catch {
        nextCwd = null;
      }
    }

    const handleCommandEvent = (event: RuntimeCommandEvent): void => {
      if (event.type === 'status' && !this.options.isVerbose()) return;
      if (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        this.activeStdinPipe &&
        !event.data.endsWith('\n')
      ) {
        this.activeStdinPrompt += event.data;
        const inputState = this.setInputState('stdin', 'stdin-prompt', this.activeStdinPrompt);
        options.onEvent?.({ ...event, terminal: { role: 'stdin-prompt', inputState } });
        return;
      }
      options.onEvent?.(event);
    };

    const result = await this.options.runCommand(trimmed, {
      ...options,
      stdinPipe: commandStdinPipe,
      presentation: 'terminal',
      foreground: true,
      cwd: this.currentCwd,
      env: {
        ...this.env,
        ...(options.env ?? {}),
        PWD: this.currentCwd,
      },
      onEvent: handleCommandEvent,
    });
    if (nextCwd) {
      this.currentCwd = nextCwd;
    }
    return result;
  }

  private startTerminalBackgroundCommand(
    command: string,
    options: RuntimeProjectTerminalRunOptions,
    cwd: string
  ): string {
    const previousJobPids = new Set(this.options.jobRecords().map((job) => job.pid));
    const handleBackgroundEvent = (event: RuntimeCommandEvent): void => {
      if (event.type === 'status' && !this.options.isVerbose()) return;
      options.onEvent?.(event);
    };
    const backgroundRun = this.options.runCommand(command, {
      ...options,
      stdinPipe: undefined,
      presentation: 'terminal',
      foreground: false,
      retainOnExit: true,
      cwd,
      env: {
        ...this.env,
        ...(options.env ?? {}),
        PWD: cwd,
      },
      onEvent: handleBackgroundEvent,
    });
    void backgroundRun.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ type: 'output', stream: 'stderr', data: `${message}\n` });
    });
    const job = this.options.jobRecords().find((candidate) =>
      !previousJobPids.has(candidate.pid) && candidate.command === command
    );
    if (!job) return '';
    const line = `[${job.index}] ${job.pid}\n`;
    options.onEvent?.({ type: 'output', stream: 'stdout', data: line });
    return line;
  }
}

interface RuntimeProjectTerminalJobRecord {
  index: number;
  pid: number;
  command: string;
}

const DEFAULT_CWD = '/workspace';
const TRACE_KERNEL_NAME = 'tracekernel';
const TRACEKERNEL_BIN_PATH = '/tracekernel/bin';
const TRACEKERNEL_SKILLS_ROOT = '/skills';
const CPP_COMPILER_COMMANDS = new Set(['clang++', 'clang', 'gcc', 'cc', 'g++', 'c++']);
const TRACEKERNEL_EXEC_COMMAND = 'tracekernel-exec';
const TRACEKERNEL_SHELL_COMMAND_PREFIX = 'tracekernel-shell-';
const TRACEKERNEL_SHELL_COMMAND_REWRITES = new Map([
  ['bg', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}bg`],
  ['command', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}command`],
  ['fg', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}fg`],
  ['jobs', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}jobs`],
  ['kill', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}kill`],
  ['ps', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}ps`],
  ['wait', `${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`],
]);
const PRINCIPAL_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('principal');
const SYSTEM_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('system');
const TRACEKERNEL_EVENT_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_LISTENER_LIMIT = 128;
const TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS = 256;
const TRACEKERNEL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;
const TRACEKERNEL_HTTP_MAX_HEADER_COUNT = 128;
const TRACEKERNEL_HTTP_MAX_HEADER_BYTES = 64 * 1024;
const TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH = 4096;
const TRACEKERNEL_ZOMBIE_RETENTION_MS = 30_000;
const TRACEKERNEL_SIGNAL_NUMBERS = new Map<string, number>([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGQUIT', 3],
  ['SIGKILL', 9],
  ['SIGTERM', 15],
]);
const TRACEKERNEL_SIGNAL_NAMES_BY_NUMBER = new Map([...TRACEKERNEL_SIGNAL_NUMBERS.entries()].map(([name, number]) => [number, name]));
const TRACEKERNEL_SENSITIVE_URL_PARAM_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'code',
  'key',
  'password',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
]);
type TraceKernelCommandKind = 'control' | 'runtime' | 'package-manager' | 'tool' | 'virtual-executable';

interface TraceKernelCommandInfo {
  name: string;
  path: string;
  kind: TraceKernelCommandKind;
  adapter: string;
  available: boolean;
  language?: Language;
  displayName?: string;
  versionLabel?: string;
  description?: string;
}

interface TraceKernelRuntimeInfo {
  language: Language;
  displayName: string;
  versionLabel: string;
  available: boolean;
  adapter: string;
  commands: string[];
  paths: string[];
  runtime: ReturnType<typeof getLanguageRuntimeInfo>['runtime'];
  compiler?: ReturnType<typeof getLanguageRuntimeInfo>['compiler'];
  standard?: string;
}

function traceKernelCommandPath(command: string): string {
  return `${TRACEKERNEL_BIN_PATH}/${command}`;
}

function traceKernelTsv(value: unknown): string {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
}

function normalizeTraceKernelVirtualPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  return normalizeTerminalAbsolutePath(path);
}

function isTraceKernelVirtualNamespacePath(path: string): boolean {
  const normalized = normalizeTraceKernelVirtualPath(path);
  return normalized === '/tracekernel' || normalized?.startsWith('/tracekernel/') === true;
}

function traceKernelBinCommandName(path: string): string | null {
  const normalized = normalizeTraceKernelVirtualPath(path);
  if (!normalized?.startsWith(`${TRACEKERNEL_BIN_PATH}/`)) return null;
  const name = normalized.slice(TRACEKERNEL_BIN_PATH.length + 1);
  return name && !name.includes('/') ? name : null;
}

function normalizeRuntimeSkillPath(path: string): string {
  assertNoNul(path, 'Skill path');
  const raw = path.replace(/\\/g, '/');
  if (raw === TRACEKERNEL_SKILLS_ROOT || raw === `${TRACEKERNEL_SKILLS_ROOT}/`) {
    throw new Error('Skill path must point to a file.');
  }
  if (raw.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)) {
    return normalizeRuntimeProjectPath(raw.slice(TRACEKERNEL_SKILLS_ROOT.length + 1));
  }
  if (raw.startsWith('/')) {
    throw new Error(`Skill path must stay inside ${TRACEKERNEL_SKILLS_ROOT}: ${path}`);
  }
  return normalizeRuntimeProjectPath(raw);
}

function runtimeSkillAbsolutePath(path: string): string {
  return `${TRACEKERNEL_SKILLS_ROOT}/${normalizeRuntimeSkillPath(path)}`;
}

function normalizeRuntimeSkillsVirtualPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const normalized = normalizeTerminalAbsolutePath(path);
  return normalized === TRACEKERNEL_SKILLS_ROOT || normalized.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)
    ? normalized
    : null;
}

function isRuntimeSkillsNamespacePath(path: string): boolean {
  return normalizeRuntimeSkillsVirtualPath(path) !== null;
}

type VirtualExecutableKind = 'cpp';

interface RuntimeCommandExecutionContext {
  readonly eventHandler?: RuntimeCommandEventHandler;
  readonly actor: RuntimeWorkspaceActor;
  readonly process: RuntimeKernelProcessRecord;
  readonly stdinPipe?: RuntimeCommandOptions['stdinPipe'];
  readonly includeHiddenFiles?: boolean;
  readonly runtimeIo: RuntimeProjectLiveIoController;
  readonly generationBaseline: RuntimeFileSystemGenerationSnapshot;
  readonly mutatedGenerationPaths: Set<string>;
  kernelError?: RuntimeCommandError;
  executableTransformCwd?: string;
  deviceStdout: string;
  deviceStderr: string;
  outputBytes: Record<RuntimeCommandEventStream, number>;
  truncatedOutputStreams: Set<RuntimeCommandEventStream>;
}

type RuntimeFileSystemGenerationSnapshot = ReadonlyMap<string, number>;
interface RuntimeFileSystemCommandGenerationContext {
  readonly baseline: RuntimeFileSystemGenerationSnapshot;
  readonly mutatedPaths: Set<string>;
  readonly pid: number;
  readonly signal: AbortSignal;
  setError(error: RuntimeCommandError): void;
}

interface RuntimeFileSystemSyscallEvent {
  type:
    | 'fs-syscall-start'
    | 'fs-syscall-commit'
    | 'fs-syscall-abort'
    | 'fs-transaction-start'
    | 'fs-transaction-commit'
    | 'fs-transaction-abort';
  pid?: number;
  detail: Record<string, unknown>;
}

type RuntimeKernelProcessState = 'queued' | 'running' | 'signaled' | 'zombie' | 'exited';
type RuntimeKernelTtyName = RuntimeKernelDevicePath | '?';

interface RuntimeKernelProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly fds: readonly RuntimeKernelFileDescriptorRecord[];
  tty: RuntimeKernelTtyName;
  readonly command: string;
  readonly cwd: string;
  readonly actor: RuntimeWorkspaceActor;
  readonly startedAt: string;
  readonly abortController?: AbortController;
  state: RuntimeKernelProcessState;
  signal?: string;
  signalCode?: number;
  foreground: boolean;
  exitCode?: number;
  endedAt?: string;
}

interface RuntimeKernelFileDescriptorRecord {
  fd: number;
  target: RuntimeKernelDevicePath;
  flags: 'r' | 'w' | 'rw';
}

interface RuntimeDynamicProcEntry {
  name: string;
  kind: 'file' | 'directory';
}

interface RuntimeDynamicProcProvider {
  readFile(path: string): string | null;
  readDir(path: string): RuntimeDynamicProcEntry[] | null;
  entryKind(path: string): 'file' | 'directory' | null;
  stat(path: string): RuntimeKernelVirtualStat | null;
  readonlyNamespace(path: string): boolean;
}

interface RuntimeKernelZombieRecord {
  process: RuntimeKernelProcessRecord;
  expiresAtMs: number;
}

interface RuntimeKernelEventRecord {
  seq: number;
  time: string;
  type: string;
  pid?: number;
  detail?: Record<string, unknown>;
}

interface RuntimeKernelHttpListenerRecord {
  info: RuntimeKernelHttpListenerInfo;
  handler: RuntimeKernelHttpHandler;
  actor: RuntimeWorkspaceActor;
}

interface RuntimeKernelHttpListenerOwner {
  pid: number;
  idPrefix: string;
  actor?: RuntimeWorkspaceActor;
}

interface RuntimeKernelHttpRequestRecord {
  seq: number;
  time: string;
  listenerId?: string;
  pid?: number;
  method: string;
  url: string;
  status?: number;
  error?: string;
}

function redactRuntimeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const [name] of url.searchParams) {
      if (TRACEKERNEL_SENSITIVE_URL_PARAM_NAMES.has(name.toLowerCase())) {
        url.searchParams.set(name, 'redacted');
      }
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:access_token|api_key|apikey|auth|authorization|code|key|password|secret|session|sig|signature|token)=)[^&#\s]*/gi, '$1redacted');
  }
}

interface RuntimeLazyCommand {
  name: string;
  load: () => Promise<Command>;
}

interface VirtualExecutableRecord {
  path: string;
  kind: VirtualExecutableKind;
}

function assertNoNul(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes.`);
  }
}

function normalizeTraceKernelSignal(value: string | undefined): { name: string; code: number } | null {
  const raw = (value ?? 'SIGTERM').trim().toUpperCase();
  if (!raw) return null;
  if (/^[0-9]+$/.test(raw)) {
    const code = Number(raw);
    const name = TRACEKERNEL_SIGNAL_NAMES_BY_NUMBER.get(code);
    return name ? { name, code } : null;
  }
  const name = raw.startsWith('SIG') ? raw : `SIG${raw}`;
  const code = TRACEKERNEL_SIGNAL_NUMBERS.get(name);
  return code === undefined ? null : { name, code };
}

function isRuntimeCommand(command: CustomCommand): command is Command {
  return typeof (command as Command).execute === 'function';
}

function isRuntimeLazyCommand(command: CustomCommand): command is RuntimeLazyCommand {
  return typeof (command as RuntimeLazyCommand).load === 'function';
}

export function normalizeRuntimeProjectPath(path: string): string {
  assertNoNul(path, 'Project path');
  const normalized = path.replace(/\\/g, '/');
  if (normalized.trim().length === 0) {
    throw new Error('Project path must not be empty.');
  }
  if (normalized.startsWith('/')) {
    throw new Error(`Project path must be relative: ${path}`);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${path}`);
  }

  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Project path must not escape the workspace: ${path}`);
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new Error(`Project path must point to a file: ${path}`);
  }
  return parts.join('/');
}

function normalizeWorkspaceCwd(cwd: string | undefined): string {
  const raw = cwd ?? DEFAULT_CWD;
  assertNoNul(raw, 'Workspace cwd');
  if (!raw.startsWith('/')) {
    throw new Error(`Workspace cwd must be absolute: ${raw}`);
  }

  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Workspace cwd must not contain '..': ${raw}`);
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function normalizeKernelNamePart(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function normalizeIsoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}

function normalizeOptionalIsoTimestamp(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeIsoTimestamp(value);
}

function createWorkspaceId(workspaceName: string, startedAt: string): string {
  return `${normalizeKernelNamePart(workspaceName, 'workspace')}-${startedAt.replace(/[:.]/g, '-')}`;
}

function createTraceKernelInfo(config: RuntimeTraceKernelConfig | undefined, cwdOption: string | undefined): RuntimeKernelInfo {
  const username = normalizeKernelNamePart(config?.user?.username ?? 'user', 'user');
  const home = normalizeWorkspaceCwd(config?.user?.home ?? `/home/${username}`);
  const workspaceName = normalizeKernelNamePart(config?.workspace?.name ?? 'workspace', 'workspace');
  const workspaceRoot = normalizeWorkspaceCwd(
    cwdOption ?? config?.workspace?.root ?? (config ? `${home}/${workspaceName}` : DEFAULT_CWD)
  );
  const startedAt = normalizeIsoTimestamp(config?.workspace?.startedAt);
  const workspaceAlias = config?.workspaceAlias === false
    ? undefined
    : normalizeWorkspaceCwd(config?.workspaceAlias ?? DEFAULT_CWD);

  return {
    name: TRACE_KERNEL_NAME,
    version: config?.version ?? packageJson.version,
    user: {
      id: config?.user?.id ?? username,
      username,
      home,
    },
    host: {
      hostname: normalizeKernelNamePart(config?.host?.hostname ?? 'tracevm', 'tracevm'),
      osName: config?.host?.osName ?? 'tracecode',
    },
    workspace: {
      id: config?.workspace?.id ?? createWorkspaceId(workspaceName, startedAt),
      name: workspaceName,
      root: workspaceRoot,
      startedAt,
    },
    home,
    cwd: workspaceRoot,
    workspaceRoot,
    ...(workspaceAlias ? { workspaceAlias } : {}),
  };
}

function normalizeRuntimeSchedulerConfig(config: RuntimeTraceKernelSchedulerConfig | undefined): RuntimeCommandSchedulerOptions {
  const configuredMaxConcurrentCommands = Number.isFinite(config?.maxConcurrentCommands)
    ? Math.max(1, Math.floor(config?.maxConcurrentCommands ?? 0))
    : 32;
  const maxQueuedCommands = config?.maxQueuedCommands === undefined || !Number.isFinite(config.maxQueuedCommands)
    ? undefined
    : Math.max(0, Math.floor(config.maxQueuedCommands));
  return {
    maxConcurrentCommands: configuredMaxConcurrentCommands,
    ...(maxQueuedCommands !== undefined ? { maxQueuedCommands } : {}),
  };
}

const TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS = 64;

function normalizeProjectSessionCommand(
  command: RuntimeProjectSessionCommandDefinition
): RuntimeProjectSessionCommand {
  if (typeof command === 'string') {
    return { command };
  }
  if ('steps' in command) {
    const steps = command.steps.flatMap((step): RuntimeProjectSessionCommandStep[] => {
      const normalized = normalizeProjectSessionCommand(step);
      return 'steps' in normalized ? [...normalized.steps] : [normalized];
    });
    return {
      steps,
      ...(command.hidden === true ? { hidden: true } : {}),
      ...(command.label ? { label: command.label } : {}),
      ...(command.description ? { description: command.description } : {}),
    };
  }
  return { ...command, ...(command.env ? { env: { ...command.env } } : {}) };
}

function normalizeProjectSessionCommands(
  commands: Record<string, RuntimeProjectSessionCommandDefinition> | undefined
): Record<string, RuntimeProjectSessionCommand> {
  const normalized: Record<string, RuntimeProjectSessionCommand> = {};
  for (const [name, command] of Object.entries(commands ?? {})) {
    if (!name.trim()) throw new Error('Project session command names must not be empty.');
    const normalizedCommand = normalizeProjectSessionCommand(command);
    if ('steps' in normalizedCommand) {
      if (normalizedCommand.steps.length === 0) {
        throw new Error(`Project session command "${name}" must include at least one step.`);
      }
      if (normalizedCommand.steps.length > TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS) {
        throw new Error(
          `Project session command "${name}" must include at most ${TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS} steps.`
        );
      }
      for (const step of normalizedCommand.steps) {
        if (!step.command.trim()) {
          throw new Error(`Project session command "${name}" must not include an empty step.`);
        }
      }
    } else if (!normalizedCommand.command.trim()) {
      throw new Error(`Project session command "${name}" must not be empty.`);
    }
    normalized[name] = normalizedCommand;
  }
  return normalized;
}

function normalizeProjectSessionHiddenFiles(session: RuntimeProjectSession): string[] {
  return [...new Set((session.files ?? [])
    .filter((file) => file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))].sort((left, right) => left.localeCompare(right));
}

function normalizeProjectSessionReadonlyFiles(session: RuntimeProjectSession): string[] {
  return [...new Set((session.files ?? [])
    .filter((file) => file.readonly === true || file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))].sort((left, right) => left.localeCompare(right));
}

function mergeProjectSessionKernelConfig(
  options: CreateRuntimeWorkspaceOptions
): RuntimeTraceKernelConfig | undefined {
  const session = options.projectSession;
  if (!session) return options.kernel;
  const workspaceName = session.projectSlug ?? session.name;
  const workspaceId = session.id;
  return {
    ...(options.kernel ?? {}),
    workspace: {
      ...(workspaceName ? { name: workspaceName } : {}),
      ...(workspaceId ? { id: workspaceId } : {}),
      ...(session.workspaceRoot ? { root: session.workspaceRoot } : {}),
      ...(options.kernel?.workspace ?? {}),
    },
  };
}

function normalizeRuntimeWorkspaceOptions(
  options: CreateRuntimeWorkspaceOptions
): CreateRuntimeWorkspaceOptions {
  const session = options.projectSession;
  if (!session) {
    return options;
  }
  return {
    ...options,
    kernel: mergeProjectSessionKernelConfig(options),
    cwd: options.cwd ?? session.workspaceRoot,
    entrypoint: options.entrypoint ?? session.entrypoint,
    env: {
      ...(session.env ?? {}),
      ...(options.env ?? {}),
    },
    directories: [
      ...(session.directories ?? []),
      ...(options.directories ?? []),
    ],
    files: [
      ...(session.files ?? []),
      ...(options.files ?? []),
    ],
    skills: [
      ...(session.skills ?? []),
      ...(options.skills ?? []),
    ],
  };
}

function createProjectSessionInfo(session: RuntimeProjectSession, kernelInfo: RuntimeKernelInfo): RuntimeProjectSessionInfo {
  const cwd = session.cwd
    ? (session.cwd.startsWith('/') ? normalizeWorkspaceCwd(session.cwd) : normalizeWorkspaceCwd(`${kernelInfo.workspaceRoot}/${session.cwd}`))
    : kernelInfo.workspaceRoot;
  if (!isWithinWorkspace(kernelInfo.workspaceRoot, cwd)) {
    throw new Error(`Project session cwd must stay inside the workspace: ${session.cwd}`);
  }
  const createdAt = normalizeIsoTimestamp(session.createdAt);
  const lastOpenedAt = normalizeIsoTimestamp(session.lastOpenedAt);
  const expiresAt = normalizeOptionalIsoTimestamp(session.expiresAt);
  return {
    id: session.id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
    ...(session.name ? { name: session.name } : {}),
    ...(session.language ? { language: session.language } : {}),
    workspaceRoot: kernelInfo.workspaceRoot,
    cwd,
    ...(session.entrypoint ? { entrypoint: normalizeRuntimeProjectPath(session.entrypoint) } : {}),
    ...(session.env ? { env: { ...session.env } } : {}),
    commands: normalizeProjectSessionCommands(session.commands),
    readonlyFiles: normalizeProjectSessionReadonlyFiles(session),
    hiddenFiles: normalizeProjectSessionHiddenFiles(session),
    lifecycle: {
      createdAt,
      lastOpenedAt,
      ...(expiresAt ? { expiresAt } : {}),
      expirationBehavior: session.expirationBehavior ?? 'none',
    },
    ...(session.metadata ? { metadata: { ...session.metadata } } : {}),
  };
}

function normalizeProcPath(path: string): string | null {
  assertNoNul(path, 'Kernel path');
  return normalizeRuntimeProcPath(path);
}

function kernelWriteTarget(path: string): ReturnType<typeof runtimeKernelWriteTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelWriteTarget(path);
}

function throwKernelWriteTargetError(path: string, target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>): never {
  throw new Error(runtimeKernelWriteErrorMessage(path, target));
}

function kernelMutationTarget(path: string): ReturnType<typeof runtimeKernelMutationTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMutationTarget(path);
}

function kernelLinkTarget(existingPath: string, newPath: string): ReturnType<typeof runtimeKernelLinkTarget> {
  assertNoNul(existingPath, 'Kernel path');
  assertNoNul(newPath, 'Kernel path');
  return runtimeKernelLinkTarget(existingPath, newPath);
}

function kernelRenameTarget(sourcePath: string, destinationPath: string): ReturnType<typeof runtimeKernelRenameTarget> {
  assertNoNul(sourcePath, 'Kernel path');
  assertNoNul(destinationPath, 'Kernel path');
  return runtimeKernelRenameTarget(sourcePath, destinationPath);
}

function kernelSymlinkTarget(linkPath: string): ReturnType<typeof runtimeKernelSymlinkTarget> {
  assertNoNul(linkPath, 'Kernel path');
  return runtimeKernelSymlinkTarget(linkPath);
}

function kernelRemoveTarget(path: string): ReturnType<typeof runtimeKernelRemoveTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelRemoveTarget(path);
}

function kernelMkdirTarget(path: string): ReturnType<typeof runtimeKernelMkdirTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMkdirTarget(path);
}

function throwKernelMutationTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMutationTarget>, { kind: 'error' }>,
  deviceMessage = `Kernel device namespace is read-only: ${path}`
): never {
  throw new Error(runtimeKernelMutationErrorMessage(path, target, { deviceMessage }));
}

function kernelMetadataTarget(path: string): ReturnType<typeof runtimeKernelMetadataTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelMetadataTarget(path);
}

function kernelAccessTarget(path: string): ReturnType<typeof runtimeKernelAccessTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelAccessTarget(path);
}

function kernelReadTarget(path: string): ReturnType<typeof runtimeKernelReadTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelReadTarget(path);
}

function kernelFileReadTarget(path: string): ReturnType<typeof runtimeKernelFileReadTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelFileReadTarget(path);
}

function kernelFileCopyTarget(source: string, destination: string): ReturnType<typeof runtimeKernelFileCopyTarget> {
  assertNoNul(source, 'Kernel path');
  assertNoNul(destination, 'Kernel path');
  return runtimeKernelFileCopyTarget(source, destination);
}

function kernelStatTarget(path: string, info: RuntimeKernelInfo): ReturnType<typeof runtimeKernelStatTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelStatTarget(path, info);
}

function throwKernelReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelReadTarget>, { kind: 'error' }>
): never {
  throw new Error(runtimeKernelReadErrorMessage(path, target));
}

function throwKernelFileReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>
): never {
  throw new Error(runtimeKernelFileReadErrorMessage(path, target));
}

function kernelDirectoryTarget(path: string): ReturnType<typeof runtimeKernelDirectoryTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelDirectoryTarget(path);
}

function throwKernelMetadataTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>
): never {
  throw new Error(runtimeKernelMetadataErrorMessage(path, target));
}

function mapWorkspaceAlias(workspaceRoot: string, workspaceAlias: string | undefined, absolutePath: string): string {
  if (!workspaceAlias || workspaceAlias === workspaceRoot) return absolutePath;
  if (absolutePath === workspaceAlias) return workspaceRoot;
  if (absolutePath.startsWith(`${workspaceAlias}/`)) {
    return `${workspaceRoot}${absolutePath.slice(workspaceAlias.length)}`;
  }
  return absolutePath;
}

function toWorkspacePath(cwd: string, path: string, workspaceAlias?: string): string {
  if (path.startsWith('/')) {
    const absolutePath = mapWorkspaceAlias(cwd, workspaceAlias, normalizeWorkspaceCwd(path));
    if (!isWithinWorkspace(cwd, absolutePath)) {
      throw new Error(`Project path must stay inside the workspace: ${path}`);
    }
    return absolutePath;
  }
  const relativePath = normalizeRuntimeProjectPath(path);
  return cwd === '/' ? `/${relativePath}` : `${cwd}/${relativePath}`;
}

function toWorkspaceEntryPath(cwd: string, path: string, workspaceAlias?: string): string {
  assertNoNul(path, 'Project path');
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    const absolutePath = mapWorkspaceAlias(cwd, workspaceAlias, normalizeWorkspaceCwd(normalized));
    if (!isWithinWorkspace(cwd, absolutePath)) {
      throw new Error(`Project path must stay inside the workspace: ${path}`);
    }
    return absolutePath;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${path}`);
  }

  const parts = cwd.split('/').filter(Boolean);
  const rootParts = cwd.split('/').filter(Boolean);
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === rootParts.length) {
        throw new Error(`Project path must not escape the workspace: ${path}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
}

function resolveWorkspaceCommandPath(workspaceRoot: string, cwd: string, path: string, workspaceAlias?: string): string {
  assertNoNul(path, 'Project path');
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    const absolutePath = mapWorkspaceAlias(workspaceRoot, workspaceAlias, normalizeWorkspaceCwd(normalized));
    if (!isWithinWorkspace(workspaceRoot, absolutePath)) {
      throw new Error(`Project path must stay inside the workspace: ${path}`);
    }
    return absolutePath;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${path}`);
  }

  const rootParts = workspaceRoot.split('/').filter(Boolean);
  const parts = cwd.split('/').filter(Boolean);
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === rootParts.length) {
        throw new Error(`Project path must not escape the workspace: ${path}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const absolutePath = `/${parts.join('/')}`;
  if (!isWithinWorkspace(workspaceRoot, absolutePath)) {
    throw new Error(`Project path must stay inside the workspace: ${path}`);
  }
  return absolutePath;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}

function commandInputTokenBounds(input: string, cursor: number): { start: number; end: number } {
  let start = Math.max(0, Math.min(cursor, input.length));
  while (start > 0 && !/\s/.test(input[start - 1] ?? '')) start -= 1;

  let end = Math.max(0, Math.min(cursor, input.length));
  while (end < input.length && !/\s/.test(input[end] ?? '')) end += 1;

  return { start, end };
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

type RuntimeFileSystemLockMode = 'shared' | 'exclusive';

interface RuntimeFileSystemLockRequest {
  path: string;
  mode: RuntimeFileSystemLockMode;
  reason: string;
}

interface RuntimeFileSystemLockQueueEntry {
  mode: RuntimeFileSystemLockMode;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface RuntimeFileSystemLockState {
  readers: number;
  writer: boolean;
  queue: RuntimeFileSystemLockQueueEntry[];
}

class RuntimeFileSystemLockCoordinator {
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

class RuntimeFileGenerationConflictError extends Error {
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

class RuntimeKernelInterruptedError extends Error {
  readonly code = 'EINTR';
  readonly errno = 4;

  constructor(
    readonly syscall: string,
    readonly path: string
  ) {
    super(`EINTR: interrupted system call, ${syscall} '${path}'`);
  }
}

class RuntimeKernelAdmissionRejectedError extends Error {
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

interface RuntimeCommandSchedulerOptions {
  maxConcurrentCommands: number;
  maxQueuedCommands?: number;
}

interface RuntimeCommandSchedulerJob {
  pid: number;
  command: string;
  signal?: AbortSignal;
}

interface RuntimeCommandSchedulerQueueEntry {
  readonly job: RuntimeCommandSchedulerJob;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  abortListener?: () => void;
}

interface RuntimeCommandSchedulerSnapshot {
  running: number;
  queued: number;
  maxConcurrentCommands: number;
  maxQueuedCommands: number | null;
}

class RuntimeCommandScheduler {
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

function normalizeFsLockPath(path: string): string {
  const normalized = path.startsWith('/')
    ? normalizeTerminalAbsolutePath(path)
    : path.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function fsMutationLockPaths(workspaceRoot: string, absolutePath: string): string[] {
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

type RuntimeFileSystemMutationKind =
  | 'file-write'
  | 'file-create'
  | 'directory-create'
  | 'delete'
  | 'recursive-delete'
  | 'copy'
  | 'rename'
  | 'subtree';

function fsAncestorLockRequests(
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

function fsParentStructureLockRequests(
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

function fsFileMutationLockRequests(
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

function fsMutationLockRequests(
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

function fsMutationGenerationPaths(
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

function isWithinWorkspace(cwd: string, absolutePath: string): boolean {
  return absolutePath === cwd || absolutePath.startsWith(`${cwd}/`);
}

function toProjectPath(cwd: string, absolutePath: string): string {
  if (absolutePath === cwd) return '';
  return absolutePath.slice(cwd.length + 1);
}

function toProjectDirectoryPath(cwd: string, absolutePath: string): string | null {
  const relativePath = toProjectPath(cwd, absolutePath);
  return relativePath || null;
}

function toWorkspaceRelativePath(cwd: string, path: string, workspaceAlias?: string): string {
  const relativePath = toProjectPath(cwd, toWorkspacePath(cwd, path, workspaceAlias));
  if (!relativePath) {
    throw new Error(`Project path must point to a file: ${path}`);
  }
  return relativePath;
}

function isRuntimeDirectoryChange(change: RuntimeFileChange): change is RuntimeDirectoryChange {
  return (change as RuntimeDirectoryChange).directory === true;
}

function resolveWorkspaceContextPath(
  ctx: CommandContext,
  workspaceRoot: string,
  path: string,
  label: string
): string {
  const absolutePath = ctx.fs.resolvePath(ctx.cwd, path);
  if (!isWithinWorkspace(workspaceRoot, absolutePath)) {
    throw new Error(`${label} must stay inside the workspace: ${path}`);
  }
  return absolutePath;
}

function runtimeFileSystemEntryKey(path: string, stat: unknown): string {
  const entry = stat as { dev?: unknown; ino?: unknown };
  if (typeof entry.dev === 'number' && typeof entry.ino === 'number') return `${entry.dev}:${entry.ino}`;
  if (typeof entry.ino === 'number') return `ino:${entry.ino}`;
  return `path:${path}`;
}

function runtimeFileSystemEntryIsSymlink(stat: unknown): boolean {
  return (stat as { isSymbolicLink?: unknown }).isSymbolicLink === true;
}

async function collectSnapshotFiles(
  fs: CommandContext['fs'],
  cwd: string,
  absolutePath: string,
  files: RuntimeFile[],
  directories: string[],
  seenDirectories = new Set<string>()
): Promise<void> {
  if (!isWithinWorkspace(cwd, absolutePath)) {
    throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
  }

  const stat = await fs.lstat(absolutePath);
  if (runtimeFileSystemEntryIsSymlink(stat)) return;
  if (stat.isFile) {
    const bytes = await fs.readFileBuffer(absolutePath);
    const text = decodeUtf8(bytes);
    files.push({
      path: toProjectPath(cwd, absolutePath),
      contents: text ?? base64FromBytes(bytes),
      encoding: text === null ? 'base64' : 'utf8',
    });
    return;
  }

  if (!stat.isDirectory) return;
  const directoryKey = runtimeFileSystemEntryKey(absolutePath, stat);
  if (seenDirectories.has(directoryKey)) return;
  seenDirectories.add(directoryKey);
  const directoryPath = toProjectDirectoryPath(cwd, absolutePath);
  if (directoryPath !== null) directories.push(directoryPath);

  for (const entry of await fs.readdir(absolutePath)) {
    await collectSnapshotFiles(fs, cwd, `${absolutePath}/${entry}`, files, directories, seenDirectories);
  }
}

async function collectKernelProcSnapshotFiles(
  fs: CommandContext['fs'],
  path: string,
  files: RuntimeFile[],
  seen = new Set<string>()
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  const stat = await fs.stat(path).catch(() => null);
  if (!stat) return;
  if (stat.isFile) {
    files.push({ path, contents: await fs.readFile(path) });
    return;
  }
  if (!stat.isDirectory) return;
  const entries = await fs.readdir(path).catch(() => []);
  for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
    await collectKernelProcSnapshotFiles(fs, `${path}/${entry}`, files, seen);
  }
}

async function snapshotRuntimeKernelVirtualFiles(
  fs: CommandContext['fs'],
  info: RuntimeKernelInfo,
  options: { publicView?: boolean } = {}
): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  await collectKernelProcSnapshotFiles(fs, '/proc', files);
  await collectKernelProcSnapshotFiles(fs, TRACEKERNEL_SKILLS_ROOT, files);
  const virtualFiles = options.publicView === false
    ? runtimeKernelVirtualFiles(info)
    : publicRuntimeKernelVirtualFiles(info);
  if (files.length === 0) return virtualFiles;
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of virtualFiles) byPath.set(file.path, file);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotCommandContext(
  ctx: CommandContext,
  workspaceRoot: string,
  entrypoint?: string,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles = false
): Promise<RuntimeProjectSnapshot> {
  const files: RuntimeFile[] = [];
  const directories: string[] = [];
  await collectSnapshotFiles(ctx.fs, workspaceRoot, workspaceRoot, files, directories);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.localeCompare(right));
  const publicKernel = kernel ? publicRuntimeKernelInfo(kernel) : undefined;
  const kernelFiles = kernel ? await snapshotRuntimeKernelVirtualFiles(ctx.fs, kernel) : undefined;
  const snapshot: RuntimeProjectSnapshot = {
    cwd: workspaceRoot,
    workspaceRoot,
    ...(workspaceAlias ? { workspaceAlias } : {}),
    ...(publicKernel ? { kernel: publicKernel } : {}),
    ...(kernel ? { kernelDevices: runtimeKernelVirtualDevices() } : {}),
    ...(kernelFiles ? { kernelFiles } : {}),
    files,
    ...(directories.length > 0 ? { directories } : {}),
    ...(readonlyFiles && readonlyFiles.length > 0 ? { readonlyFiles: [...readonlyFiles] } : {}),
    ...(includeHiddenFiles && hiddenFiles && hiddenFiles.length > 0 ? { hiddenFiles: [...hiddenFiles] } : {}),
    ...(entrypoint ? { entrypoint } : {}),
  };
  return includeHiddenFiles ? snapshot : filterHiddenSnapshotFiles(snapshot, hiddenFiles);
}

function filterReadonlySnapshotFiles(
  snapshot: RuntimeProjectSnapshot,
  readonlyFiles?: readonly string[],
  keepFiles?: readonly string[]
): RuntimeProjectSnapshot {
  if (!readonlyFiles || readonlyFiles.length === 0) return snapshot;
  const keep = new Set((keepFiles ?? []).map((path) => normalizeRuntimeProjectPath(path)));
  const readonly = new Set(readonlyFiles
    .map((path) => normalizeRuntimeProjectPath(path))
    .filter((path) => path.includes('/') && !keep.has(path)));
  if (readonly.size === 0) return snapshot;
  const files = snapshot.files.filter((file) => !readonly.has(normalizeRuntimeProjectPath(file.path)));
  return files.length === snapshot.files.length ? snapshot : { ...snapshot, files };
}

function filterHiddenSnapshotFiles(
  snapshot: RuntimeProjectSnapshot,
  hiddenFiles?: readonly string[]
): RuntimeProjectSnapshot {
  if (!hiddenFiles || hiddenFiles.length === 0) return snapshot;
  const hidden = new Set(hiddenFiles.map((path) => normalizeRuntimeProjectPath(path)));
  if (hidden.size === 0) return snapshot;
  const files = snapshot.files.filter((file) => !hidden.has(normalizeRuntimeProjectPath(file.path)));
  const directories = snapshot.directories?.filter((directory) => {
    const normalized = normalizeRuntimeProjectPath(directory);
    return ![...hidden].some((hiddenPath) => hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`));
  });
  const { directories: _directories, hiddenFiles: _hiddenFiles, ...rest } = snapshot;
  return {
    ...rest,
    files,
    ...(directories && directories.length > 0 ? { directories } : {}),
  };
}

function filterReadonlySnapshotDeletions(
  result: RuntimeCommandResult,
  readonlyFiles?: readonly string[]
): RuntimeCommandResult {
  if (!result.files?.length || !readonlyFiles || readonlyFiles.length === 0) return result;
  const readonly = new Set(readonlyFiles
    .map((path) => normalizeRuntimeProjectPath(path))
    .filter((path) => path.includes('/')));
  if (readonly.size === 0) return result;
  const files = result.files.filter((change) => {
    if ((change as RuntimeFileDeletion | RuntimeDirectoryChange).deleted !== true) return true;
    const path = normalizeRuntimeProjectPath(change.path);
    if (isRuntimeDirectoryChange(change)) {
      return ![...readonly].some((readonlyPath) => readonlyPath === path || readonlyPath.startsWith(`${path}/`));
    }
    return !readonly.has(path);
  });
  if (files.length === result.files.length) return result;
  if (files.length > 0) return { ...result, files };
  const { files: _files, ...rest } = result;
  return rest;
}

type RuntimeFileChangeObserver = (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => void;

interface RuntimeFinalDiffPreparedChange {
  change: RuntimeFileChange;
  absolutePath: string;
  kind: RuntimeFileSystemMutationKind;
  apply(base: IFileSystem): Promise<void>;
}

type RuntimeFileSystemRollbackEntry =
  | { kind: 'missing'; path: string }
  | { kind: 'file'; path: string; contents: Uint8Array }
  | { kind: 'symlink'; path: string; target: string }
  | {
      kind: 'directory';
      path: string;
      directories: string[];
      files: Array<{ path: string; contents: Uint8Array }>;
      symlinks: Array<{ path: string; target: string }>;
    };

interface RuntimeFileSystemRollbackState {
  entries: RuntimeFileSystemRollbackEntry[];
  createdAncestors: string[];
}

function isKernelReadonlyError(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'EROFS'
    && error instanceof Error
    && error.message.startsWith('EROFS: readonly project ');
}

function kernelCommandFailure(error: unknown): RuntimeCommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const commandError = runtimeCommandError(error);
  return {
    stdout: '',
    stderr: message ? `${message}\n` : 'EIO: input/output error\n',
    exitCode: commandError?.errno ?? 1,
    ...(commandError ? { error: commandError } : {}),
  };
}

function isRuntimeFileGenerationConflict(error: unknown): boolean {
  return error instanceof RuntimeFileGenerationConflictError || (error as { code?: unknown }).code === 'ESTALE';
}

function runtimeCommandError(error: unknown): RuntimeCommandError | undefined {
  if (error instanceof RuntimeFileGenerationConflictError) return error.toCommandError();
  if (error instanceof RuntimeKernelInterruptedError) {
    return {
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      path: error.path,
      message: error.message,
    };
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const errno = (error as { errno?: unknown }).errno;
  const syscall = (error as { syscall?: unknown }).syscall;
  const path = (error as { path?: unknown }).path;
  return {
    code,
    message,
    ...(typeof errno === 'number' ? { errno } : {}),
    ...(typeof syscall === 'string' ? { syscall } : {}),
    ...(typeof path === 'string' ? { path } : {}),
  };
}

async function applyCommandResultFiles(
  ctx: CommandContext,
  workspaceRoot: string,
  result: RuntimeCommandResult,
  onFileChange?: RuntimeFileChangeObserver
): Promise<RuntimeCommandResult> {
  try {
    assertRuntimeFinalDiffBudget(result.files);
    if (ctx.fs instanceof KernelObservedFileSystem && result.files?.length) {
      const committed = await ctx.fs.applyFinalDiffTransaction(result.files, (file) =>
        prepareFinalDiffChange(workspaceRoot, file)
      );
      for (const file of committed) {
        onFileChange?.(file, 'final-diff');
      }
      const { files: _files, ...commandResult } = result;
      return commandResult;
    }
    return await applyRuntimeCommandResultFiles(result, async (file, phase) => {
      await withSuspendedFsNotifications(ctx.fs, async () => {
        if (ctx.fs instanceof KernelObservedFileSystem) {
          ctx.fs.assertFileChangeGenerationFresh(file, phase);
        }
        const absolutePath = toWorkspacePath(workspaceRoot, file.path);
        if (isRuntimeDirectoryChange(file)) {
          if (file.deleted === true) {
            await ctx.fs.rm(absolutePath, { force: true, recursive: true });
          } else {
            await ctx.fs.mkdir(absolutePath, { recursive: true });
          }
          onFileChange?.(file, phase);
          return;
        }
        if ((file as { deleted?: boolean }).deleted === true) {
          await ctx.fs.rm(absolutePath, { force: true });
          onFileChange?.(file, phase);
          return;
        }
        const changedFile = file as RuntimeFile;
        await ctx.fs.mkdir(dirname(absolutePath), { recursive: true });
        if ((changedFile.encoding ?? 'utf8') === 'base64') {
          await ctx.fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
        } else {
          await ctx.fs.writeFile(absolutePath, changedFile.contents);
        }
        onFileChange?.(changedFile, phase);
      });
    });
  } catch (error) {
    if (isKernelReadonlyError(error) || isRuntimeFileGenerationConflict(error)) {
      if (ctx.fs instanceof KernelObservedFileSystem) ctx.fs.recordCommandError(error);
      return kernelCommandFailure(error);
    }
    throw error;
  }
}

function prepareFinalDiffChange(workspaceRoot: string, file: RuntimeFileChange): RuntimeFinalDiffPreparedChange {
  const absolutePath = isRuntimeDirectoryChange(file)
    ? toWorkspaceEntryPath(workspaceRoot, file.path)
    : (file as RuntimeFileDeletion).deleted === true
      ? toWorkspacePath(workspaceRoot, file.path)
      : toWorkspacePath(workspaceRoot, (file as RuntimeFile).path);
  const kind: RuntimeFileSystemMutationKind = isRuntimeDirectoryChange(file)
    ? file.deleted === true ? 'recursive-delete' : 'directory-create'
    : (file as RuntimeFileDeletion).deleted === true
      ? 'delete'
      : 'file-write';
  return {
    change: file,
    absolutePath,
    kind,
    apply: async (fs) => {
      if (isRuntimeDirectoryChange(file)) {
        if (file.deleted === true) {
          await fs.rm(absolutePath, { force: true, recursive: true });
        } else {
          await fs.mkdir(absolutePath, { recursive: true });
        }
        return;
      }
      if ((file as RuntimeFileDeletion).deleted === true) {
        await fs.rm(absolutePath, { force: true });
        return;
      }
      const changedFile = file as RuntimeFile;
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      if ((changedFile.encoding ?? 'utf8') === 'base64') {
        await fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
      } else {
        await fs.writeFile(absolutePath, changedFile.contents);
      }
    },
  };
}

async function withSuspendedFsNotifications<T>(fs: CommandContext['fs'], fn: () => Promise<T>): Promise<T> {
  if (fs instanceof KernelObservedFileSystem) {
    return fs.suspendNotifications(fn);
  }
  return fn();
}

async function applyWorkspaceCommandResultFiles(
  workspace: JustBashRuntimeWorkspace,
  result: RuntimeCommandResult
): Promise<RuntimeCommandResult> {
  return workspace.applyFinalDiffResultFiles(result);
}

function assertSupportedEncoding(encoding: RuntimeFileEncoding | undefined): RuntimeFileEncoding {
  return encoding ?? 'utf8';
}

function normalizeRuntimeFileEncoding(encoding: RuntimeFileEncoding | undefined, label: string): RuntimeFileEncoding {
  if (encoding === undefined || encoding === 'utf8') return 'utf8';
  if (encoding === 'base64') return 'base64';
  throw new Error(`${label}.encoding must be "utf8" or "base64".`);
}

function bytesFromBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64');
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function textToByteString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let byteString = '';
  for (const byte of bytes) {
    byteString += String.fromCharCode(byte);
  }
  return byteString;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function contentToText(content: FileContent): string {
  if (typeof content === 'string') return content;
  return decodeUtf8(content) ?? Array.from(content, (byte) => String.fromCharCode(byte)).join('');
}

function contentToBytes(content: FileContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function contentToBytesForRuntimeFile(file: RuntimeFile): Uint8Array {
  return (file.encoding ?? 'utf8') === 'base64'
    ? bytesFromBase64(file.contents)
    : new TextEncoder().encode(file.contents);
}

interface RuntimeProjectPatchSnapshotFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  hash: string;
}

interface RuntimeProjectPatchSnapshotView {
  manifestHash: string;
  files: Map<string, RuntimeProjectPatchSnapshotFile>;
  directories: Set<string>;
  entrypoint?: string;
}

const RUNTIME_PROJECT_PATCH_VERSION = 1;
const RUNTIME_PROJECT_PATCH_HASH_PATTERN = /^[0-9a-f]{64}$/;

async function createRuntimeProjectPatchSnapshotView(
  snapshot: RuntimeProjectSnapshot,
  label: string
): Promise<RuntimeProjectPatchSnapshotView> {
  const files = new Map<string, RuntimeProjectPatchSnapshotFile>();
  for (const [index, file] of (snapshot.files ?? []).entries()) {
    const path = normalizeRuntimeProjectPath(file.path);
    if (files.has(path)) throw new Error(`${label}.files[${index}] duplicates project path: ${path}`);
    if (typeof file.contents !== 'string') throw new Error(`${label}.files[${index}].contents must be a string.`);
    const encoding = normalizeRuntimeFileEncoding(file.encoding, `${label}.files[${index}]`);
    const normalizedFile: RuntimeFile = {
      path,
      contents: file.contents,
      ...(encoding === 'base64' ? { encoding } : {}),
    };
    files.set(path, {
      ...normalizedFile,
      hash: await runtimeProjectPatchFileHash(normalizedFile),
    });
  }

  const directories = new Set<string>();
  for (const [index, directory] of (snapshot.directories ?? []).entries()) {
    if (typeof directory !== 'string') throw new Error(`${label}.directories[${index}] must be a string.`);
    const path = normalizeRuntimeProjectPath(directory);
    if (files.has(path)) throw new Error(`${label}.directories[${index}] conflicts with file path: ${path}`);
    directories.add(path);
  }

  const entrypoint = snapshot.entrypoint === undefined ? undefined : normalizeRuntimeProjectPath(snapshot.entrypoint);
  const manifestHash = await runtimeProjectPatchHashJson({
    version: RUNTIME_PROJECT_PATCH_VERSION,
    entrypoint: entrypoint ?? null,
    files: [...files.values()]
      .map((file) => ({ path: file.path, hash: file.hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
  });

  return {
    manifestHash,
    files,
    directories,
    ...(entrypoint ? { entrypoint } : {}),
  };
}

async function runtimeProjectPatchFileHash(file: RuntimeFile): Promise<string> {
  return runtimeProjectPatchHashBytes(contentToBytesForRuntimeFile(file));
}

async function runtimeProjectPatchHashJson(value: unknown): Promise<string> {
  return runtimeProjectPatchHashBytes(new TextEncoder().encode(JSON.stringify(value)));
}

async function runtimeProjectPatchHashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Runtime project patch hashing requires Web Crypto SHA-256 support.');
  }
  const digestSource = new Uint8Array(bytes.byteLength);
  digestSource.set(bytes);
  return runtimeProjectPatchBytesToHex(new Uint8Array(await subtle.digest('SHA-256', digestSource.buffer as ArrayBuffer)));
}

function runtimeProjectPatchBytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertRuntimeProjectPatchHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUNTIME_PROJECT_PATCH_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function staleRuntimeProjectPatchError(message: string, path?: string): Error {
  return Object.assign(new Error(`ESTALE: ${message}`), {
    code: 'ESTALE',
    errno: 116,
    syscall: 'patch',
    ...(path ? { path } : {}),
  });
}

function normalizeRuntimeProjectPatch(patch: RuntimeProjectPatch): RuntimeProjectPatch {
  if (!patch || typeof patch !== 'object') throw new Error('Runtime project patch must be an object.');
  if (patch.version !== RUNTIME_PROJECT_PATCH_VERSION) {
    throw new Error(`Unsupported runtime project patch version: ${(patch as { version?: unknown }).version}`);
  }
  if (!patch.base || typeof patch.base !== 'object') throw new Error('Runtime project patch base is required.');
  const base = {
    ...(typeof patch.base.id === 'string' ? { id: patch.base.id } : {}),
    ...(typeof patch.base.version === 'string' ? { version: patch.base.version } : {}),
    manifestHash: assertRuntimeProjectPatchHash(patch.base.manifestHash, 'Runtime project patch base manifestHash'),
  };
  if (!Array.isArray(patch.changes)) throw new Error('Runtime project patch changes must be an array.');

  const seen = new Set<string>();
  const changes = patch.changes.map((change, index): RuntimeProjectPatchChange => {
    if (!change || typeof change !== 'object') {
      throw new Error(`Runtime project patch changes[${index}] must be an object.`);
    }
    const kind = (change as { kind?: unknown }).kind;
    const rawPath = (change as { path?: unknown }).path;
    if (typeof rawPath !== 'string') throw new Error(`Runtime project patch changes[${index}].path must be a string.`);
    const path = normalizeRuntimeProjectPath(rawPath);
    if (seen.has(path)) throw new Error(`Runtime project patch contains duplicate change for path: ${path}`);
    seen.add(path);

    if (kind === 'write') {
      const write = change as RuntimeProjectPatchFileWrite;
      if (typeof write.contents !== 'string') {
        throw new Error(`Runtime project patch changes[${index}].contents must be a string.`);
      }
      const encoding = normalizeRuntimeFileEncoding(write.encoding, `Runtime project patch changes[${index}]`);
      const baseHash = write.baseHash === null
        ? null
        : assertRuntimeProjectPatchHash(write.baseHash, `Runtime project patch changes[${index}].baseHash`);
      return {
        kind,
        path,
        contents: write.contents,
        ...(encoding === 'base64' ? { encoding } : {}),
        baseHash,
      };
    }

    if (kind === 'delete') {
      return {
        kind,
        path,
        baseHash: assertRuntimeProjectPatchHash(
          (change as RuntimeProjectPatchFileDelete).baseHash,
          `Runtime project patch changes[${index}].baseHash`
        ),
      };
    }

    if (kind === 'mkdir' || kind === 'rmdir') return { kind, path };
    throw new Error(`Runtime project patch changes[${index}].kind is unsupported: ${String(kind)}`);
  });

  return {
    version: RUNTIME_PROJECT_PATCH_VERSION,
    base,
    changes: sortRuntimeProjectPatchChanges(changes),
  };
}

function sortRuntimeProjectPatchChanges(changes: readonly RuntimeProjectPatchChange[]): RuntimeProjectPatchChange[] {
  const rank = (change: RuntimeProjectPatchChange): number => {
    if (change.kind === 'delete') return 0;
    if (change.kind === 'rmdir') return 1;
    if (change.kind === 'mkdir') return 2;
    return 3;
  };
  return [...changes].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    if (left.kind === 'rmdir' && right.kind === 'rmdir') return right.path.localeCompare(left.path);
    return left.path.localeCompare(right.path);
  });
}

function validateRuntimeProjectPatchAgainstBase(
  base: RuntimeProjectPatchSnapshotView,
  patch: RuntimeProjectPatch
): void {
  if (patch.base.manifestHash !== base.manifestHash) {
    throw staleRuntimeProjectPatchError(
      `patch base manifest ${patch.base.manifestHash} does not match provided base ${base.manifestHash}`
    );
  }

  for (const change of patch.changes) {
    if (change.kind === 'write') {
      const baseFile = base.files.get(change.path);
      if (change.baseHash === null) {
        if (baseFile || base.directories.has(change.path)) {
          throw staleRuntimeProjectPatchError(`patch expected '${change.path}' to be absent in the base`, change.path);
        }
      } else if (!baseFile || baseFile.hash !== change.baseHash) {
        throw staleRuntimeProjectPatchError(`patch write precondition failed for '${change.path}'`, change.path);
      }
      continue;
    }

    if (change.kind === 'delete') {
      const baseFile = base.files.get(change.path);
      if (!baseFile || baseFile.hash !== change.baseHash) {
        throw staleRuntimeProjectPatchError(`patch delete precondition failed for '${change.path}'`, change.path);
      }
      continue;
    }

    if (change.kind === 'mkdir') {
      if (base.files.has(change.path) || base.directories.has(change.path)) {
        throw staleRuntimeProjectPatchError(`patch expected directory '${change.path}' to be absent in the base`, change.path);
      }
      continue;
    }

    if (!base.directories.has(change.path)) {
      throw staleRuntimeProjectPatchError(`patch expected directory '${change.path}' to exist in the base`, change.path);
    }
  }
}

function runtimeProjectPatchChangesToFileChanges(changes: readonly RuntimeProjectPatchChange[]): RuntimeFileChange[] {
  return changes.map((change): RuntimeFileChange => {
    if (change.kind === 'write') {
      return {
        path: change.path,
        contents: change.contents,
        ...(change.encoding === 'base64' ? { encoding: change.encoding } : {}),
      };
    }
    if (change.kind === 'delete') return { path: change.path, deleted: true };
    if (change.kind === 'mkdir') return { path: change.path, directory: true };
    return { path: change.path, directory: true, deleted: true };
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type FsReadFileOptions = Parameters<IFileSystem['readFile']>[1];
type FsWriteFileOptions = Parameters<IFileSystem['writeFile']>[2];
type FsMkdirOptions = Parameters<IFileSystem['mkdir']>[1];
type FsRmOptions = Parameters<IFileSystem['rm']>[1];
type FsCpOptions = Parameters<IFileSystem['cp']>[2];

class KernelObservedFileSystem implements IFileSystem {
  private suspendDepth = 0;
  private nextGeneration = 1;
  private nextInode = 10_000;
  private readonly generations = new Map<string, number>();
  private readonly inodes = new Map<string, number>();

  constructor(
    private readonly base: IFileSystem,
    private readonly locks: RuntimeFileSystemLockCoordinator,
    private readonly workspaceRoot: () => string,
    private readonly workspaceAlias: () => string | undefined,
    private readonly kernelInfo: () => RuntimeKernelInfo,
    private readonly assertWritable: (absolutePath: string, operation: string) => void,
    private readonly assertSubtreeWritable: (absolutePath: string, operation: string) => void,
    private readonly generationBaseline: () => RuntimeFileSystemGenerationSnapshot | undefined,
    private readonly commandGenerationContext: () => RuntimeFileSystemCommandGenerationContext | undefined,
    private readonly onSyscallEvent: (event: RuntimeFileSystemSyscallEvent) => void,
    private readonly dynamicProc: RuntimeDynamicProcProvider,
    private readonly onFileChange: (change: RuntimeFileChange) => void,
    private readonly readDevice: (device: RuntimeKernelDevicePath) => string,
    private readonly writeDevice: (device: RuntimeKernelDevicePath, data: string) => void
  ) {}

  suspendNotifications<T>(fn: () => Promise<T>): Promise<T> {
    this.suspendDepth += 1;
    return fn().finally(() => {
      this.suspendDepth -= 1;
    });
  }

  snapshotGenerations(): RuntimeFileSystemGenerationSnapshot {
    return new Map(this.generations);
  }

  inodeForPath(path: string): number {
    const normalizedPath = normalizeFsLockPath(this.mapPath(path));
    const existing = this.inodes.get(normalizedPath);
    if (existing !== undefined) return existing;
    const inode = this.nextInode++;
    this.inodes.set(normalizedPath, inode);
    return inode;
  }

  moveInode(source: string, destination: string): void {
    const normalizedSource = normalizeFsLockPath(this.mapPath(source));
    const normalizedDestination = normalizeFsLockPath(this.mapPath(destination));
    const inode = this.inodes.get(normalizedSource) ?? this.inodeForPath(normalizedSource);
    this.inodes.delete(normalizedSource);
    this.inodes.set(normalizedDestination, inode);
  }

  forgetInodePath(path: string): void {
    this.inodes.delete(normalizeFsLockPath(this.mapPath(path)));
  }

  renderInodes(): string {
    const rows = [...this.inodes.entries()]
      .filter(([path]) => isWithinWorkspace(this.workspaceRoot(), path))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, inode]) => `${inode}\t${toProjectPath(this.workspaceRoot(), path)}`);
    return ['ino\tpath', ...rows].join('\n') + '\n';
  }

  assertFileChangeGenerationFresh(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): void {
    if (phase !== 'final-diff') return;
    const baseline = this.generationBaseline();
    if (!baseline) return;
    const path = this.mapPath(runtimeFileChangePath(change));
    const kind = this.finalDiffMutationKind(change, path);
    this.assertCommandMutationFresh([path], kind);
  }

  async applyFinalDiffTransaction(
    changes: readonly RuntimeFileChange[],
    prepare: (change: RuntimeFileChange) => RuntimeFinalDiffPreparedChange
  ): Promise<RuntimeFileChange[]> {
    if (changes.length === 0) return [];
    const prepared = changes.map((change) => {
      const preparedChange = prepare(change);
      return {
        ...preparedChange,
        kind: this.finalDiffMutationKind(preparedChange.change, preparedChange.absolutePath),
      };
    });
    const generationContext = this.commandGenerationContext();
    const normalizedPaths = prepared.map((change) => normalizeFsLockPath(change.absolutePath));
    const detail = {
      kind: 'final-diff-transaction',
      paths: normalizedPaths.map((path) => isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path),
      absolutePaths: normalizedPaths,
      changes: prepared.length,
    };
    let rolledBack = false;
    this.onSyscallEvent({ type: 'fs-transaction-start', pid: generationContext?.pid, detail });
    try {
      return await this.locks.withLocks(
        prepared.flatMap((change) => this.mutationLockRequests([change.absolutePath], change.kind)),
        async () => {
          for (const change of prepared) {
            this.assertCommandMutationFresh([change.absolutePath], change.kind);
            await this.validateFinalDiffPreparedChange(change);
          }
          await this.validateFinalDiffDirectoryDeletes(prepared);
          const rollback = await this.snapshotRollbackState(prepared.map((change) => change.absolutePath));
          const committed: RuntimeFileChange[] = [];
          try {
            await this.suspendNotifications(async () => {
              for (const change of prepared) {
                await change.apply(this.base);
                committed.push(change.change);
              }
            });
          } catch (error) {
            await this.restoreRollbackState(rollback);
            rolledBack = true;
            throw error;
          }
          await this.recordFinalDiffInodeMutations(prepared, rollback);
          for (const change of prepared) {
            this.recordMutation([change.absolutePath], change.kind);
          }
          this.onSyscallEvent({ type: 'fs-transaction-commit', pid: generationContext?.pid, detail });
          return committed;
        },
        generationContext?.signal
      );
    } catch (error) {
      const commandError = runtimeCommandError(error);
      this.recordCommandError(error);
      this.onSyscallEvent({
        type: 'fs-transaction-abort',
        pid: generationContext?.pid,
        detail: {
          ...detail,
          rolledBack,
          ...(commandError
            ? { error: { code: commandError.code, message: commandError.message, ...(commandError.errno !== undefined ? { errno: commandError.errno } : {}), ...(commandError.syscall ? { syscall: commandError.syscall } : {}), ...(commandError.path ? { path: commandError.path } : {}) } }
            : { error: { message: error instanceof Error ? error.message : String(error) } }),
        },
      });
      throw error;
    }
  }

  recordCommandError(error: unknown): void {
    const commandError = runtimeCommandError(error);
    if (commandError) this.commandGenerationContext()?.setError(commandError);
  }

  private mutationGenerationPaths(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): string[] {
    return fsMutationGenerationPaths(this.workspaceRoot(), paths, kind);
  }

  private mutationLockRequests(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): RuntimeFileSystemLockRequest[] {
    return fsMutationLockRequests(this.workspaceRoot(), paths.map((path) => normalizeFsLockPath(path)), kind);
  }

  private finalDiffMutationKind(change: RuntimeFileChange, absolutePath: string): RuntimeFileSystemMutationKind {
    if (isRuntimeDirectoryChange(change)) return change.deleted === true ? 'recursive-delete' : 'directory-create';
    if ((change as RuntimeFileDeletion).deleted === true) return 'delete';
    return this.currentGeneration(absolutePath) > 0 ? 'file-write' : 'file-create';
  }

  private async validateFinalDiffPreparedChange(change: RuntimeFinalDiffPreparedChange): Promise<void> {
    if (isRuntimeDirectoryChange(change.change)) {
      if (change.change.deleted === true) {
        this.assertSubtreeWritable(change.absolutePath, 'delete');
      } else {
        this.assertWritable(change.absolutePath, 'mkdir');
      }
      return;
    }
    if ((change.change as RuntimeFileDeletion).deleted === true) {
      this.assertWritable(change.absolutePath, 'delete');
      return;
    }
    try {
      this.assertWritable(change.absolutePath, 'write');
    } catch (error) {
      const changedFile = change.change as RuntimeFile;
      if ((error as { code?: unknown }).code === 'EROFS' && await this.fileContentEquals(change.absolutePath, contentToBytesForRuntimeFile(changedFile))) {
        return;
      }
      throw error;
    }
  }

  private async validateFinalDiffDirectoryDeletes(changes: readonly RuntimeFinalDiffPreparedChange[]): Promise<void> {
    const deletedPaths = new Set(
      changes
        .filter((change) => isRuntimeDirectoryChange(change.change) ? change.change.deleted === true : (change.change as RuntimeFileDeletion).deleted === true)
        .map((change) => normalizeFsLockPath(change.absolutePath))
    );
    for (const change of changes) {
      if (!isRuntimeDirectoryChange(change.change) || change.change.deleted !== true) continue;
      await this.assertFinalDiffDirectoryDeleteIsExplicit(change.absolutePath, deletedPaths);
    }
  }

  private async assertFinalDiffDirectoryDeleteIsExplicit(path: string, deletedPaths: ReadonlySet<string>): Promise<void> {
    const normalizedPath = normalizeFsLockPath(path);
    const generationContext = this.commandGenerationContext();
    const stat = await this.base.lstat(normalizedPath).catch(() => null);
    if (!stat || (stat as { isSymbolicLink?: boolean }).isSymbolicLink || !stat.isDirectory) return;
    for (const entry of await this.base.readdir(normalizedPath)) {
      const childPath = normalizeFsLockPath(`${normalizedPath}/${entry}`);
      const childStat = await this.base.lstat(childPath).catch(() => null);
      if (!childStat) continue;
      if (childStat.isDirectory && !(childStat as { isSymbolicLink?: boolean }).isSymbolicLink) {
        await this.assertFinalDiffDirectoryDeleteIsExplicit(childPath, deletedPaths);
      }
      if (!deletedPaths.has(childPath) && !this.finalDiffDirectoryDeleteDescendantIsFresh(childPath, generationContext)) {
        this.throwFinalDiffDirectoryDeleteConflict(childPath);
      }
    }
  }

  private finalDiffDirectoryDeleteDescendantIsFresh(
    path: string,
    generationContext: RuntimeFileSystemCommandGenerationContext | undefined
  ): boolean {
    if (!generationContext) return false;
    const normalizedPath = normalizeFsLockPath(path);
    if (generationContext.mutatedPaths.has(normalizedPath)) return true;
    return this.currentGeneration(normalizedPath) === (generationContext.baseline.get(normalizedPath) ?? 0);
  }

  private throwFinalDiffDirectoryDeleteConflict(path: string): never {
    const displayPath = isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path;
    throw Object.assign(
      new Error(`ESTALE: final-diff directory delete omitted descendant '${displayPath}'`),
      {
        code: 'ESTALE',
        errno: 116,
        syscall: 'write',
        path: displayPath,
      }
    );
  }

  private async snapshotRollbackState(paths: readonly string[]): Promise<RuntimeFileSystemRollbackState> {
    const workspaceRoot = this.workspaceRoot();
    const normalizedPaths = [...new Set(paths.map((path) => normalizeFsLockPath(path)))]
      .filter((path) => isWithinWorkspace(workspaceRoot, path))
      .sort((left, right) => left.localeCompare(right));
    const targetPaths = normalizedPaths.filter((path, index) =>
      !normalizedPaths.slice(0, index).some((candidate) => path.startsWith(`${candidate}/`))
    );
    const entries: RuntimeFileSystemRollbackEntry[] = [];
    const createdAncestors = new Set<string>();
    for (const path of targetPaths) {
      entries.push(await this.snapshotRollbackEntry(path));
      for (const directoryPath of await this.collectMissingDirectories(dirname(path))) {
        createdAncestors.add(directoryPath);
      }
    }
    return {
      entries,
      createdAncestors: [...createdAncestors].sort((left, right) => right.length - left.length),
    };
  }

  private async snapshotRollbackEntry(path: string): Promise<RuntimeFileSystemRollbackEntry> {
    if (!(await this.base.exists(path))) return { kind: 'missing', path };
    const stat = await this.base.lstat(path);
    if ((stat as { isSymbolicLink?: boolean }).isSymbolicLink) {
      return { kind: 'symlink', path, target: await this.base.readlink(path) };
    }
    if (stat.isFile) {
      return { kind: 'file', path, contents: new Uint8Array(await this.base.readFileBuffer(path)) };
    }
    if (!stat.isDirectory) return { kind: 'missing', path };
    const directories: string[] = [];
    const files: Array<{ path: string; contents: Uint8Array }> = [];
    const symlinks: Array<{ path: string; target: string }> = [];
    await this.collectRollbackDirectory(path, directories, files, symlinks);
    return { kind: 'directory', path, directories, files, symlinks };
  }

  private async collectRollbackDirectory(
    path: string,
    directories: string[],
    files: Array<{ path: string; contents: Uint8Array }>,
    symlinks: Array<{ path: string; target: string }>
  ): Promise<void> {
    const stat = await this.base.lstat(path);
    if ((stat as { isSymbolicLink?: boolean }).isSymbolicLink) {
      symlinks.push({ path, target: await this.base.readlink(path) });
      return;
    }
    if (stat.isFile) {
      files.push({ path, contents: new Uint8Array(await this.base.readFileBuffer(path)) });
      return;
    }
    if (!stat.isDirectory) return;
    if (path !== this.workspaceRoot()) directories.push(path);
    for (const entry of await this.base.readdir(path)) {
      await this.collectRollbackDirectory(`${path}/${entry}`, directories, files, symlinks);
    }
  }

  private async restoreRollbackState(state: RuntimeFileSystemRollbackState): Promise<void> {
    for (const entry of state.entries) {
      await this.removeRollbackPath(entry.path);
      if (entry.kind === 'missing') continue;
      if (entry.kind === 'file') {
        await this.base.mkdir(dirname(entry.path), { recursive: true });
        await this.base.writeFile(entry.path, entry.contents);
        continue;
      }
      if (entry.kind === 'symlink') {
        await this.base.mkdir(dirname(entry.path), { recursive: true });
        await this.base.symlink(entry.target, entry.path);
        continue;
      }
      await this.base.mkdir(entry.path, { recursive: true });
      for (const directoryPath of [...entry.directories].sort((left, right) => left.length - right.length)) {
        await this.base.mkdir(directoryPath, { recursive: true });
      }
      for (const file of entry.files) {
        await this.base.mkdir(dirname(file.path), { recursive: true });
        await this.base.writeFile(file.path, file.contents);
      }
      for (const symlink of entry.symlinks) {
        await this.base.mkdir(dirname(symlink.path), { recursive: true });
        await this.base.symlink(symlink.target, symlink.path);
      }
    }
    for (const directoryPath of state.createdAncestors) {
      await this.removeDirectoryIfEmpty(directoryPath);
    }
  }

  private async removeRollbackPath(path: string): Promise<void> {
    if (path === this.workspaceRoot()) {
      for (const entry of await this.base.readdir(path).catch(() => [])) {
        await this.base.rm(`${path}/${entry}`, { force: true, recursive: true });
      }
      return;
    }
    await this.base.rm(path, { force: true, recursive: true });
  }

  private async recordFinalDiffInodeMutations(
    changes: readonly RuntimeFinalDiffPreparedChange[],
    rollback: RuntimeFileSystemRollbackState
  ): Promise<void> {
    const deletedPaths = new Set<string>();
    for (const directoryPath of rollback.createdAncestors) {
      if (await this.base.exists(directoryPath).catch(() => false)) this.inodeForPath(directoryPath);
    }
    for (const change of changes) {
      if (isRuntimeDirectoryChange(change.change)) {
        if (change.change.deleted === true) {
          for (const path of this.rollbackSnapshotPathsFor(change.absolutePath, rollback)) {
            deletedPaths.add(path);
          }
        } else {
          for (const directoryPath of await this.collectExistingDirectories(change.absolutePath)) {
            this.inodeForPath(directoryPath);
          }
        }
        continue;
      }
      if ((change.change as RuntimeFileDeletion).deleted === true) {
        for (const path of this.rollbackSnapshotPathsFor(change.absolutePath, rollback)) {
          deletedPaths.add(path);
        }
        continue;
      }
      this.inodeForPath(change.absolutePath);
    }
    if (deletedPaths.size > 0) this.forgetInodes([...deletedPaths]);
  }

  private rollbackSnapshotPathsFor(path: string, rollback: RuntimeFileSystemRollbackState): string[] {
    const normalizedPath = normalizeFsLockPath(path);
    const entry = rollback.entries.find((candidate) =>
      normalizedPath === candidate.path || normalizedPath.startsWith(`${candidate.path}/`)
    );
    if (!entry || entry.kind === 'missing') return [normalizedPath];
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      return normalizedPath === entry.path ? [entry.path] : [normalizedPath];
    }
    const paths = [
      entry.path,
      ...entry.directories,
      ...entry.files.map((file) => file.path),
      ...entry.symlinks.map((symlink) => symlink.path),
    ];
    return paths.filter((candidate) =>
      candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)
    );
  }

  private async removeDirectoryIfEmpty(path: string): Promise<void> {
    if (path === this.workspaceRoot() || !(await this.base.exists(path))) return;
    const stat = await this.base.stat(path);
    if (!stat.isDirectory) return;
    if ((await this.base.readdir(path)).length > 0) return;
    await this.base.rm(path, { force: true, recursive: true });
  }

  private withReadLocks<T>(paths: readonly string[], reason: string, fn: () => Promise<T>): Promise<T> {
    const generationContext = this.commandGenerationContext();
    return this.locks.withLocks(
      paths.map((path) => ({ path: normalizeFsLockPath(path), mode: 'shared', reason })),
      fn,
      generationContext?.signal
    ).catch((error) => {
      this.recordCommandError(error);
      throw error;
    });
  }

  private withMutationLocks<T>(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind,
    fn: () => Promise<T>
  ): Promise<T> {
    const generationContext = this.commandGenerationContext();
    const normalizedPaths = paths.map((path) => normalizeFsLockPath(path));
    const detail = {
      kind,
      paths: normalizedPaths.map((path) => isWithinWorkspace(this.workspaceRoot(), path) ? toProjectPath(this.workspaceRoot(), path) : path),
      absolutePaths: normalizedPaths,
    };
    this.onSyscallEvent({ type: 'fs-syscall-start', pid: generationContext?.pid, detail });
    return this.locks.withLocks(this.mutationLockRequests(paths, kind), async () => {
      this.assertCommandMutationFresh(paths, kind);
      return fn();
    }, generationContext?.signal).then((result) => {
      this.onSyscallEvent({ type: 'fs-syscall-commit', pid: generationContext?.pid, detail });
      return result;
    }).catch((error) => {
      const commandError = runtimeCommandError(error);
      this.recordCommandError(error);
      this.onSyscallEvent({
        type: 'fs-syscall-abort',
        pid: generationContext?.pid,
        detail: {
          ...detail,
          ...(commandError
            ? { error: { code: commandError.code, message: commandError.message, ...(commandError.errno !== undefined ? { errno: commandError.errno } : {}), ...(commandError.syscall ? { syscall: commandError.syscall } : {}), ...(commandError.path ? { path: commandError.path } : {}) } }
            : { error: { message: error instanceof Error ? error.message : String(error) } }),
        },
      });
      throw error;
    });
  }

  withBaseMutation<T>(
    paths: readonly string[],
    fn: (base: IFileSystem) => Promise<T>,
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): Promise<T> {
    return this.withMutationLocks(paths, kind, async () => {
      const result = await fn(this.base);
      this.recordMutation(paths, kind);
      return result;
    });
  }

  private currentGeneration(path: string): number {
    return this.generations.get(normalizeFsLockPath(path)) ?? 0;
  }

  private recordMutation(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind = 'file-write'
  ): void {
    const generationPaths = [...new Set(this.mutationGenerationPaths(paths, kind))];
    if (generationPaths.length === 0) return;
    const generation = this.nextGeneration++;
    for (const path of generationPaths) {
      this.generations.set(path, generation);
    }
    this.recordCommandMutation(generationPaths);
  }

  private forgetInodes(paths: readonly string[]): void {
    for (const path of paths) {
      this.inodes.delete(normalizeFsLockPath(path));
    }
  }

  private moveInodeSubtree(source: string, destination: string, paths: readonly string[]): void {
    const existingInodes = new Map<number, number>();
    for (const path of paths) {
      const inode = this.inodes.get(normalizeFsLockPath(path)) ?? this.inodeForPath(path);
      existingInodes.set(paths.indexOf(path), inode);
    }
    for (const [index, inode] of existingInodes) {
      const oldPath = paths[index]!;
      const newPath = oldPath === source ? destination : `${destination}/${oldPath.slice(source.length + 1)}`;
      this.inodes.delete(normalizeFsLockPath(oldPath));
      this.inodes.set(normalizeFsLockPath(newPath), inode);
    }
  }

  private assertCommandMutationFresh(
    paths: readonly string[],
    kind: RuntimeFileSystemMutationKind
  ): void {
    const generationContext = this.commandGenerationContext();
    if (!generationContext) return;
    const generationPaths = [...new Set(this.mutationGenerationPaths(paths, kind))];
    for (const path of generationPaths.map(normalizeFsLockPath)) {
      if (generationContext.mutatedPaths.has(path)) continue;
      const expectedGeneration = generationContext.baseline.get(path) ?? 0;
      const actualGeneration = this.currentGeneration(path);
      if (actualGeneration !== expectedGeneration) {
        const displayPath = path === normalizeFsLockPath(this.workspaceRoot()) && paths[0]
          ? normalizeFsLockPath(paths[0])
          : path;
        throw new RuntimeFileGenerationConflictError(
          isWithinWorkspace(this.workspaceRoot(), displayPath) ? toProjectPath(this.workspaceRoot(), displayPath) : displayPath,
          expectedGeneration,
          actualGeneration
        );
      }
    }
  }

  private recordCommandMutation(paths: readonly string[]): void {
    const generationContext = this.commandGenerationContext();
    if (!generationContext) return;
    for (const path of paths) {
      generationContext.mutatedPaths.add(normalizeFsLockPath(path));
    }
  }

  private readDynamicVirtualFile(path: string, options?: FsReadFileOptions): string | null {
    const content = this.dynamicProc.readFile(this.mapPath(path));
    if (content === null) return null;
    if ((options as { encoding?: unknown } | undefined)?.encoding === 'base64') {
      throw new Error(`Kernel virtual path does not support base64 reads: ${path}`);
    }
    return content;
  }

  private assertDynamicVirtualWritable(path: string, operation: string): void {
    if (!this.dynamicProc.readonlyNamespace(this.mapPath(path))) return;
    throw Object.assign(
      new Error(`EROFS: kernel virtual path is read-only, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    const dynamicProcFile = this.readDynamicVirtualFile(path, options);
    if (dynamicProcFile !== null) return Promise.resolve(dynamicProcFile);
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(this.readDeviceFile(readTarget.path, options));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(this.readProcFile(readTarget.path, options));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(throwKernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () => this.base.readFile(mappedPath, options));
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
    const dynamicProcFile = this.readDynamicVirtualFile(path);
    if (dynamicProcFile !== null) {
      return Promise.resolve(textToByteString(dynamicProcFile)) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') {
      return Promise.resolve(textToByteString(this.readDeviceFile(readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') {
      return Promise.resolve(textToByteString(this.readProcFile(readTarget.path))) as unknown as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
    }
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(throwKernelReadTargetError(path, readTarget));
    if (!this.base.readFileBytes) return Promise.reject(new Error('readFileBytes is not supported by this filesystem.'));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () =>
      this.base.readFileBytes!(mappedPath) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>
    );
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    const dynamicProcFile = this.readDynamicVirtualFile(path);
    if (dynamicProcFile !== null) return Promise.resolve(new TextEncoder().encode(dynamicProcFile));
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(new TextEncoder().encode(this.readDeviceFile(readTarget.path)));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(new TextEncoder().encode(this.readProcFile(readTarget.path)));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(throwKernelReadTargetError(path, readTarget));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'read-file', () => this.base.readFileBuffer(mappedPath));
  }

  async writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'write');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedPath], mutationKind, async () => {
      try {
        this.assertWritable(mappedPath, 'write');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EROFS' && await this.fileContentEquals(mappedPath, content)) return;
        throw error;
      }
      await this.base.writeFile(mappedPath, content, options);
      this.inodeForPath(mappedPath);
      this.recordMutation([mappedPath], mutationKind);
      await this.emitFileWrite(mappedPath);
    });
  }

  async appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'append');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedPath) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedPath], mutationKind, async () => {
      this.assertWritable(mappedPath, 'append');
      await this.base.appendFile(mappedPath, content, options);
      this.inodeForPath(mappedPath);
      this.recordMutation([mappedPath], mutationKind);
      await this.emitFileWrite(mappedPath);
    });
  }

  exists(path: string): Promise<boolean> {
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) return Promise.resolve(true);
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return Promise.resolve(true);
    if (accessTarget.kind === 'denied') return Promise.resolve(false);
    return this.base.exists(this.mapPath(path));
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path));
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'stat', () => this.base.stat(mappedPath)).then((stat) => {
      if (isWithinWorkspace(this.workspaceRoot(), mappedPath)) this.inodeForPath(mappedPath);
      return stat;
    });
  }

  async mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'mkdir');
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') return Promise.reject(new Error(
      mkdirTarget.reason === 'proc-read-only'
        ? `Kernel proc path is read-only: ${path}`
        : `Kernel device namespace is read-only: ${path}`
    ));
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks([mappedPath], 'directory-create', async () => {
      const createdDirectories = await this.collectMissingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'mkdir');
      await this.base.mkdir(mappedPath, options);
      for (const directoryPath of createdDirectories) {
        this.inodeForPath(directoryPath);
      }
      if (createdDirectories.length > 0) this.recordMutation(createdDirectories, 'directory-create');
      for (const directoryPath of createdDirectories) {
        this.emitDirectoryCreate(directoryPath);
      }
    });
  }

  readdir(path: string): Promise<string[]> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path));
    if (dynamicEntries) return Promise.resolve(dynamicEntries.map((entry) => entry.name));
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return Promise.resolve(directoryTarget.entries.map((entry) => entry.name));
    if (directoryTarget.kind === 'error') {
      return Promise.reject(new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      ));
    }
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'readdir', () => this.base.readdir(mappedPath));
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
    const dynamicEntries = this.dynamicProc.readDir(this.mapPath(path));
    if (dynamicEntries) {
      return Promise.resolve(dynamicEntries.map((entry) => ({
        name: entry.name,
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'directory',
        isSymbolicLink: false,
      }))) as Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>>;
    }
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') {
      return Promise.resolve(directoryTarget.entries.map((entry) => ({
        name: entry.name,
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'directory',
        isSymbolicLink: false,
      })));
    }
    if (directoryTarget.kind === 'error') {
      return Promise.reject(new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      ));
    }
    if (!this.base.readdirWithFileTypes) return Promise.reject(new Error('readdirWithFileTypes is not supported by this filesystem.'));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'readdir', () => this.base.readdirWithFileTypes!(mappedPath));
  }

  async rm(path: string, options?: FsRmOptions): Promise<void> {
    this.assertDynamicVirtualWritable(path, options?.recursive ? 'recursive-delete' : 'delete');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const mappedPath = this.mapPath(path);
    await this.withMutationLocks([mappedPath], options?.recursive ? 'recursive-delete' : 'delete', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedPath);
      const deletedDirectories = await this.collectExistingDirectories(mappedPath);
      this.assertWritable(mappedPath, 'remove');
      this.assertWritableFiles(deletedFiles, 'remove');
      await this.base.rm(mappedPath, options);
      this.forgetInodes([mappedPath, ...deletedFiles, ...deletedDirectories]);
      this.recordMutation([mappedPath, ...deletedFiles, ...deletedDirectories], options?.recursive ? 'recursive-delete' : 'delete');
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(deletedPath);
      }
    });
  }

  async cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    this.assertDynamicVirtualWritable(dest, 'copy');
    const dynamicSourceFile = this.readDynamicVirtualFile(src);
    if (dynamicSourceFile !== null) {
      await this.copyDynamicVirtualFile(dest, dynamicSourceFile);
      return;
    }
    const copyTarget = kernelFileCopyTarget(src, dest);
    if (copyTarget.kind === 'virtual-source' || copyTarget.kind === 'device-destination') {
      await this.copyFileLike(src, dest, copyTarget);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${src}`
          : copyTarget.side === 'destination'
            ? `Kernel virtual destination is not writable: ${dest}`
            : `Kernel virtual path not found: ${src}`
      );
    }
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks([mappedSource, mappedDestination], 'copy', async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.cp(mappedSource, mappedDestination, options);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedSource, mappedDestination], 'copy');
      await this.emitExistingDirectories(mappedDestination);
      await this.emitExistingFiles(mappedDestination);
    });
  }

  private async copyFileLike(
    src: string,
    dest: string,
    copyTarget: Exclude<ReturnType<typeof runtimeKernelFileCopyTarget>, { kind: 'workspace' | 'error' }>
  ): Promise<void> {
    const sourceBytes = await this.readKernelCopySource(src, copyTarget.source);
    if (copyTarget.kind === 'device-destination') {
      this.writeDevice(copyTarget.device, contentToText(sourceBytes));
      return;
    }
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks([mappedDestination], 'file-create', async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, sourceBytes);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedDestination], 'file-create');
      await this.emitFileWrite(mappedDestination);
    });
  }

  private async readKernelCopySource(
    path: string,
    sourceTarget: ReturnType<typeof runtimeKernelFileReadTarget> = kernelFileReadTarget(path)
  ): Promise<FileContent> {
    if (sourceTarget.kind === 'device-file') return this.readDeviceFile(sourceTarget.path);
    if (sourceTarget.kind === 'proc-file') return readPublicRuntimeProcFile(sourceTarget.path, this.kernelInfo());
    if (sourceTarget.kind === 'error') throwKernelFileReadTargetError(path, sourceTarget);
    return this.base.readFileBuffer(this.mapPath(path));
  }

  private async copyDynamicVirtualFile(dest: string, content: string): Promise<void> {
    const writeTarget = kernelWriteTarget(dest);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(dest, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, content);
      return;
    }
    const mappedDestination = this.mapPath(dest);
    const mutationKind: RuntimeFileSystemMutationKind = await this.base.exists(mappedDestination) ? 'file-write' : 'file-create';
    await this.withMutationLocks([mappedDestination], mutationKind, async () => {
      this.assertWritable(mappedDestination, 'copy');
      await this.base.writeFile(mappedDestination, content);
      this.inodeForPath(mappedDestination);
      this.recordMutation([mappedDestination], mutationKind);
      await this.emitFileWrite(mappedDestination);
    });
  }

  private assertWritableFiles(paths: readonly string[], operation: string): void {
    for (const path of paths) {
      this.assertWritable(path, operation);
    }
  }

  private async fileContentEquals(path: string, content: FileContent): Promise<boolean> {
    try {
      return bytesEqual(await this.base.readFileBuffer(path), contentToBytes(content));
    } catch {
      return false;
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.assertDynamicVirtualWritable(src, 'move');
    this.assertDynamicVirtualWritable(dest, 'move');
    const sourceMutationTarget = kernelMutationTarget(src);
    if (sourceMutationTarget.kind === 'error') throwKernelMutationTargetError(src, sourceMutationTarget, 'Kernel device namespace is read-only.');
    const destinationMutationTarget = kernelMutationTarget(dest);
    if (destinationMutationTarget.kind === 'error') throwKernelMutationTargetError(dest, destinationMutationTarget, 'Kernel device namespace is read-only.');
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.withMutationLocks([mappedSource, mappedDestination], 'rename', async () => {
      const deletedFiles = await this.collectExistingFiles(mappedSource);
      const deletedDirectories = await this.collectExistingDirectories(mappedSource);
      const movedPaths = [...deletedDirectories, ...deletedFiles];
      this.assertWritableFiles(deletedFiles, 'move');
      this.assertWritable(mappedDestination, 'move');
      this.assertSubtreeWritable(mappedDestination, 'move');
      await this.base.mv(mappedSource, mappedDestination);
      this.moveInodeSubtree(mappedSource, mappedDestination, movedPaths.length > 0 ? movedPaths : [mappedSource]);
      this.recordMutation([mappedSource, mappedDestination], 'rename');
      if (deletedFiles.length > 0 || deletedDirectories.length > 0) {
        this.recordMutation([...deletedFiles, ...deletedDirectories], 'recursive-delete');
      }
      await this.emitExistingDirectories(mappedDestination);
      await this.emitExistingFiles(mappedDestination);
      for (const deletedPath of deletedFiles) {
        this.emitFileDelete(deletedPath);
      }
      for (const deletedPath of deletedDirectories) {
        this.emitDirectoryDelete(deletedPath);
      }
    });
  }

  resolvePath(base: string, path: string): string {
    if (isRuntimeKernelVirtualNamespacePath(path) || isRuntimeKernelVirtualNamespacePath(base)) {
      return this.base.resolvePath(base, path);
    }
    return this.mapPath(this.base.resolvePath(this.mapPath(base), path));
  }

  getAllPaths(): string[] {
    const paths = this.base.getAllPaths();
    const alias = this.workspaceAlias();
    const root = this.workspaceRoot();
    const aliasPaths = !alias || alias === root
      ? paths
      : paths.flatMap((path) => {
          if (path === root) return [path, alias];
          if (path.startsWith(`${root}/`)) return [path, `${alias}${path.slice(root.length)}`];
          return [path];
        });
    const traceKernelBinPaths = (this.dynamicProc.readDir(TRACEKERNEL_BIN_PATH) ?? [])
      .map((entry) => `${TRACEKERNEL_BIN_PATH}/${entry.name}`);
    const skillPaths = this.dynamicProc.readDir(TRACEKERNEL_SKILLS_ROOT) === null
      ? []
      : this.dynamicVirtualPaths(TRACEKERNEL_SKILLS_ROOT);
    return Array.from(new Set([
      ...aliasPaths,
      ...runtimeKernelVirtualPaths(),
      '/tracekernel',
      TRACEKERNEL_BIN_PATH,
      ...traceKernelBinPaths,
      TRACEKERNEL_SKILLS_ROOT,
      ...skillPaths,
    ])).sort((left, right) => left.localeCompare(right));
  }

  chmod(path: string, mode: number): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'chmod');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks([mappedPath], 'file-write', async () => {
      this.assertWritable(mappedPath, 'chmod');
      await this.base.chmod(mappedPath, mode);
      this.recordMutation([mappedPath], 'file-write');
    });
  }

  symlink(target: string, linkPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(linkPath, 'symlink');
    const symlinkTarget = kernelSymlinkTarget(linkPath);
    if (symlinkTarget.kind === 'error') throwKernelMutationTargetError(linkPath, symlinkTarget);
    const mappedPath = this.mapPath(linkPath);
    return this.withMutationLocks([mappedPath], 'file-create', async () => {
      this.assertWritable(mappedPath, 'symlink');
      await this.base.symlink(target, mappedPath);
      this.recordMutation([mappedPath], 'file-create');
    });
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.assertDynamicVirtualWritable(existingPath, 'link');
    this.assertDynamicVirtualWritable(newPath, 'link');
    const linkTarget = kernelLinkTarget(existingPath, newPath);
    if (linkTarget.kind === 'error') throwKernelMutationTargetError(linkTarget.side === 'source' ? existingPath : newPath, linkTarget);
    const mappedNewPath = this.mapPath(newPath);
    const mappedExistingPath = this.mapPath(existingPath);
    return this.withMutationLocks([mappedExistingPath, mappedNewPath], 'copy', async () => {
      this.assertWritable(mappedNewPath, 'link');
      await this.base.link(mappedExistingPath, mappedNewPath);
      this.recordMutation([mappedExistingPath, mappedNewPath], 'copy');
    });
  }

  readlink(path: string): Promise<string> {
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) {
      return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    }
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind !== 'workspace') return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'readlink', () => this.base.readlink(mappedPath));
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    const dynamicStat = this.dynamicProc.stat(this.mapPath(path));
    if (dynamicStat) return Promise.resolve(this.virtualStat(dynamicStat));
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    const mappedPath = this.mapPath(path);
    return this.withReadLocks([mappedPath], 'stat', () => this.base.lstat(mappedPath));
  }

  realpath(path: string): Promise<string> {
    assertNoNul(path, 'Kernel path');
    if (this.dynamicProc.entryKind(this.mapPath(path)) !== null) return Promise.resolve(this.mapPath(path));
    if (isRuntimeKernelVirtualNamespacePath(path)) return Promise.resolve(path);
    return this.base.realpath(this.mapPath(path));
  }

  private dynamicVirtualPaths(path: string, seen = new Set<string>()): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const kind = this.dynamicProc.entryKind(path);
    if (!kind) return [];
    if (kind === 'file') return [path];
    const entries = this.dynamicProc.readDir(path) ?? [];
    return [
      path,
      ...entries.flatMap((entry) => this.dynamicVirtualPaths(`${path}/${entry.name}`, seen)),
    ];
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.assertDynamicVirtualWritable(path, 'utimes');
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    const mappedPath = this.mapPath(path);
    return this.withMutationLocks([mappedPath], 'file-write', async () => {
      await this.base.utimes(mappedPath, atime, mtime);
      this.recordMutation([mappedPath], 'file-write');
    });
  }

  private mapPath(path: string): string {
    if (!path.startsWith('/')) return path;
    return mapWorkspaceAlias(this.workspaceRoot(), this.workspaceAlias(), path);
  }

  private async emitExistingFiles(path: string): Promise<void> {
    for (const filePath of await this.collectExistingFiles(path)) {
      await this.emitFileWrite(filePath);
    }
  }

  private async emitExistingDirectories(path: string): Promise<void> {
    for (const directoryPath of await this.collectExistingDirectories(path)) {
      this.emitDirectoryCreate(directoryPath);
    }
  }

  private async collectMissingDirectories(path: string): Promise<string[]> {
    const root = this.workspaceRoot();
    if (!isWithinWorkspace(root, path)) return [];
    if (path === root) return [];
    const relativeParts = toProjectPath(root, path).split('/').filter(Boolean);
    const missing: string[] = [];
    let current = root;
    for (const part of relativeParts) {
      current = `${current}/${part}`;
      if (!(await this.base.exists(current))) missing.push(current);
    }
    return missing;
  }

  private async collectExistingFiles(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.base.exists(path))) return [];
    const stat = await this.base.stat(path);
    if (stat.isFile) return [path];
    if (!stat.isDirectory) return [];
    const files: string[] = [];
    for (const entry of await this.base.readdir(path)) {
      files.push(...await this.collectExistingFiles(`${path}/${entry}`));
    }
    return files;
  }

  private async collectExistingDirectories(path: string): Promise<string[]> {
    if (!isWithinWorkspace(this.workspaceRoot(), path) || !(await this.base.exists(path))) return [];
    const stat = await this.base.stat(path);
    if (!stat.isDirectory) return [];
    const directories: string[] = [];
    for (const entry of await this.base.readdir(path)) {
      directories.push(...await this.collectExistingDirectories(`${path}/${entry}`));
    }
    directories.push(path);
    return directories.filter((directoryPath) => directoryPath !== this.workspaceRoot());
  }

  private async emitFileWrite(path: string): Promise<void> {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    const bytes = await this.base.readFileBuffer(path);
    const text = decodeUtf8(bytes);
    this.onFileChange({
      path: toProjectPath(this.workspaceRoot(), path),
      contents: text ?? base64FromBytes(bytes),
      ...(text === null ? { encoding: 'base64' as const } : {}),
    });
  }

  private emitFileDelete(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path)) return;
    this.onFileChange({ path: toProjectPath(this.workspaceRoot(), path), deleted: true });
  }

  private emitDirectoryCreate(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    this.onFileChange({ path: toProjectPath(this.workspaceRoot(), path), directory: true });
  }

  private emitDirectoryDelete(path: string): void {
    if (this.suspendDepth > 0 || !isWithinWorkspace(this.workspaceRoot(), path) || path === this.workspaceRoot()) return;
    this.onFileChange({ path: toProjectPath(this.workspaceRoot(), path), directory: true, deleted: true });
  }

  private readDeviceFile(device: '/dev' | RuntimeKernelDevicePath, options?: FsReadFileOptions): string {
    if (device === '/dev') throw new Error('Kernel device path is a directory: /dev');
    const inputDevice = runtimeDeviceInputSource(device);
    if (!inputDevice) throw new Error(`Kernel device is not readable: ${device}`);
    const content = this.readDevice(inputDevice);
    if (options === 'base64' || (typeof options === 'object' && options?.encoding === 'base64')) {
      return base64FromBytes(new TextEncoder().encode(content));
    }
    return content;
  }

  private readProcFile(path: string, options?: FsReadFileOptions): string {
    const content = readPublicRuntimeProcFile(path, this.kernelInfo());
    if (options === 'base64' || (typeof options === 'object' && options?.encoding === 'base64')) {
      return base64FromBytes(new TextEncoder().encode(content));
    }
    return content;
  }

  private writeDeviceFile(device: '/dev' | RuntimeKernelDevicePath, content: FileContent): void {
    if (device === '/dev') throw new Error('Kernel device path is a directory: /dev');
    const outputDevice = runtimeDeviceOutputTarget(device);
    if (!outputDevice) throw new Error(`Kernel device is read-only: ${device}`);
    this.writeDevice(device, contentToText(content));
  }

  private virtualStat(stat: RuntimeKernelVirtualStat): Awaited<ReturnType<IFileSystem['stat']>> {
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: false,
      mode: stat.mode,
      size: stat.size,
      mtime: new Date(0),
      ...(stat.uid !== undefined ? { uid: stat.uid } : {}),
      ...(stat.gid !== undefined ? { gid: stat.gid } : {}),
      ...(stat.owner !== undefined ? { owner: stat.owner } : {}),
      ...(stat.group !== undefined ? { group: stat.group } : {}),
      ...(stat.isCharacterDevice ? { isCharacterDevice: true } : {}),
    };
  }
}

function decodeCommandStdin(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (Array.isArray(value)) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return '';
}

interface ParsedPythonInvocation {
  code: string | null;
  module: string | null;
  scriptFile: string | null;
  showVersion: boolean;
  scriptArgs: string[];
}

type PythonParseResult = ParsedPythonInvocation | RuntimeCommandResult;

function isIgnoredPythonFlag(arg: string): boolean {
  return [
    '-u',
    '-B',
    '-E',
    '-I',
    '-O',
    '-OO',
    '-P',
    '-q',
    '-s',
    '-S',
  ].includes(arg);
}

function pythonFlagConsumesNext(arg: string): boolean {
  return arg === '-W' || arg === '-X' || arg === '--check-hash-based-pycs';
}

function isInlinePythonFlagWithValue(arg: string): boolean {
  return /^-[WX].+/.test(arg);
}

function parsePythonInvocation(args: string[]): PythonParseResult {
  const parsed: ParsedPythonInvocation = {
    code: null,
    module: null,
    scriptFile: null,
    showVersion: false,
    scriptArgs: [],
  };

  if (args.length === 0) return parsed;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: "python3: option requires an argument -- 'c'\n", exitCode: 2 };
      }
      parsed.code = code;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '-m' || arg === '--module') {
      const moduleName = args[index + 1];
      if (moduleName === undefined) {
        return { stdout: '', stderr: `python3: option requires an argument -- '${arg === '-m' ? 'm' : 'module'}'\n`, exitCode: 2 };
      }
      parsed.module = moduleName;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '--') {
      if (index + 1 < args.length) {
        parsed.scriptFile = args[index + 1] ?? null;
        parsed.scriptArgs = args.slice(index + 2);
      }
      return parsed;
    }
    if (arg === '-') {
      parsed.scriptFile = '-';
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
    if (arg === '--version' || arg === '-V') {
      parsed.showVersion = true;
      return parsed;
    }
    if (isIgnoredPythonFlag(arg) || isInlinePythonFlagWithValue(arg)) {
      continue;
    }
    if (pythonFlagConsumesNext(arg)) {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: `python3: option requires an argument -- '${arg.slice(1)}'\n`, exitCode: 2 };
      }
      index += 1;
      continue;
    }
    if (arg?.startsWith('-') && arg !== '-') {
      return { stdout: '', stderr: `python3: unrecognized option '${arg}'\n`, exitCode: 2 };
    }

    if (arg !== undefined) {
      parsed.scriptFile = arg;
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
  }

  return parsed;
}

function isCommandResult(value: PythonParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

interface ParsedNodeInvocation {
  code: string | null;
  scriptFile: string | null;
  inputType: string | null;
  requireModules: string[];
  showVersion: boolean;
  scriptArgs: string[];
}

type NodeParseResult = ParsedNodeInvocation | RuntimeCommandResult;

function parseNodeInvocation(args: string[]): NodeParseResult {
  const parsed: ParsedNodeInvocation = {
    code: null,
    scriptFile: null,
    inputType: null,
    requireModules: [],
    showVersion: false,
    scriptArgs: [],
  };

  if (args.length === 0) return parsed;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-e' || arg === '--eval') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.code = code;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '-p' || arg === '--print') {
      const code = args[index + 1];
      if (code === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.code = `console.log(${code})`;
      parsed.scriptArgs = args.slice(index + 2);
      return parsed;
    }
    if (arg === '--') {
      if (index + 1 < args.length) {
        parsed.scriptFile = args[index + 1] ?? null;
        parsed.scriptArgs = args.slice(index + 2);
      }
      return parsed;
    }
    if (arg === '-') {
      parsed.scriptFile = '-';
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
    if (arg === '--version' || arg === '-v') {
      parsed.showVersion = true;
      return parsed;
    }
    if (arg === '--input-type') {
      const inputType = args[index + 1];
      if (inputType === undefined) {
        return { stdout: '', stderr: 'node: --input-type requires an argument\n', exitCode: 9 };
      }
      parsed.inputType = inputType;
      index += 1;
      continue;
    }
    if (arg.startsWith('--input-type=')) {
      parsed.inputType = arg.slice('--input-type='.length);
      continue;
    }
    if (arg === '-r' || arg === '--require') {
      const moduleName = args[index + 1];
      if (moduleName === undefined) {
        return { stdout: '', stderr: `node: ${arg} requires an argument\n`, exitCode: 9 };
      }
      parsed.requireModules.push(moduleName);
      index += 1;
      continue;
    }
    if (arg.startsWith('--require=')) {
      parsed.requireModules.push(arg.slice('--require='.length));
      continue;
    }
    if (
      arg === '--no-warnings' ||
      arg === '--trace-warnings' ||
      arg === '--trace-deprecation' ||
      arg === '--throw-deprecation' ||
      arg === '--enable-source-maps' ||
      arg === '--experimental-vm-modules' ||
      arg === '--experimental-default-type=module' ||
      arg === '--experimental-default-type=commonjs'
    ) {
      continue;
    }
    if (arg?.startsWith('-') && arg !== '-') {
      return { stdout: '', stderr: `node: bad option: ${arg}\n`, exitCode: 9 };
    }

    if (arg !== undefined) {
      parsed.scriptFile = arg;
      parsed.scriptArgs = args.slice(index + 1);
      return parsed;
    }
  }

  return parsed;
}

function isNodeCommandResult(value: NodeParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function parseTscInvocation(args: string[]): RuntimeCommandResult | { args: string[]; showVersion: boolean } {
  if (args.some((arg) => arg === '--version' || arg === '-v')) {
    return { args: [], showVersion: true };
  }
  const unsupported = args.find((arg) => arg === '--watch' || arg === '-w' || arg === '--build' || arg === '-b');
  if (unsupported) {
    return {
      stdout: '',
      stderr: `tracekernel: tsc ${unsupported} is not supported in the emulated project environment\n`,
      exitCode: 2,
    };
  }
  return { args, showVersion: false };
}

function isTscCommandResult(value: ReturnType<typeof parseTscInvocation>): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  if (needle.length === 0) return start;
  for (let index = start; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function extractStoredJarMainClass(bytes: Uint8Array): string | null {
  const manifestName = new TextEncoder().encode('META-INF/MANIFEST.MF');
  const manifestOffset = findBytes(bytes, manifestName);
  if (manifestOffset < 0) return null;
  const headerOffset = Math.max(0, manifestOffset - 30);
  for (let index = headerOffset; index >= 0; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x03 &&
      bytes[index + 3] === 0x04
    ) {
      const method = bytes[index + 8] | (bytes[index + 9] << 8);
      const compressedSize = bytes[index + 18] | (bytes[index + 19] << 8) | (bytes[index + 20] << 16) | (bytes[index + 21] << 24);
      const fileNameLength = bytes[index + 26] | (bytes[index + 27] << 8);
      const extraLength = bytes[index + 28] | (bytes[index + 29] << 8);
      const nameStart = index + 30;
      const nameEnd = nameStart + fileNameLength;
      if (manifestOffset < nameStart || manifestOffset >= nameEnd || method !== 0) {
        return null;
      }
      const dataStart = nameEnd + extraLength;
      const manifest = decodeUtf8(bytes.slice(dataStart, dataStart + compressedSize));
      if (manifest === null) return null;
      const unfolded = manifest.replace(/\r\n /g, '').replace(/\n /g, '');
      const match = /^Main-Class:\s*(.+?)\s*$/im.exec(unfolded);
      return match?.[1]?.trim() || null;
    }
  }
  return null;
}

interface ParsedJavacInvocation {
  args: string[];
  showVersion: boolean;
}

interface ParsedJavaInvocation {
  mainClass: string | null;
  showVersion: boolean;
  programArgs: string[];
  classpath: string | null;
  jarPath: string | null;
  systemProperties: Record<string, string>;
  enablePreview: boolean;
  enableAssertions: boolean;
}

type JavacParseResult = ParsedJavacInvocation | RuntimeCommandResult;
type JavaParseResult = ParsedJavaInvocation | RuntimeCommandResult;

function parseJavacInvocation(args: string[]): JavacParseResult {
  if (args.includes('-version') || args.includes('--version')) {
    return { args: [], showVersion: true };
  }
  if (args.length === 0) {
    return { stdout: '', stderr: 'javac: no source files\n', exitCode: 2 };
  }
  return { args, showVersion: false };
}

function parseJavaArgFile(contents: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;
  for (const ch of contents) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

async function expandJavaCommandArgfiles(args: string[], ctx: CommandContext, workspaceRoot: string): Promise<string[]> {
  const expand = async (items: string[], seen: Set<string>): Promise<string[]> => {
    const expanded: string[] = [];
    for (const item of items) {
      if (!item.startsWith('@') || item === '@') {
        expanded.push(item);
        continue;
      }

      const argfilePath = ctx.fs.resolvePath(ctx.cwd, item.slice(1));
      if (!isWithinWorkspace(workspaceRoot, argfilePath)) {
        throw new Error(`Java argfile path must stay inside the workspace: ${item.slice(1)}`);
      }
      if (seen.has(argfilePath)) {
        throw new Error(`Recursive Java argfile reference: ${toProjectPath(workspaceRoot, argfilePath)}`);
      }
      if (!(await ctx.fs.exists(argfilePath))) {
        throw new Error(`Java argfile not found: ${toProjectPath(workspaceRoot, argfilePath)}`);
      }

      seen.add(argfilePath);
      expanded.push(...await expand(parseJavaArgFile(await ctx.fs.readFile(argfilePath)), seen));
      seen.delete(argfilePath);
    }
    return expanded;
  };
  return expand(args, new Set());
}

function parseJavaInvocation(args: string[]): JavaParseResult {
  let classpath: string | null = null;
  let jarPath: string | null = null;
  let enablePreview = false;
  let enableAssertions = false;
  const systemProperties: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === '-version' || arg === '--version') {
      return { mainClass: null, showVersion: true, programArgs: [], classpath, jarPath, systemProperties, enablePreview, enableAssertions };
    }

    if (arg === '--enable-preview') {
      enablePreview = true;
      continue;
    }

    if (arg === '-ea' || arg === '-enableassertions') {
      enableAssertions = true;
      continue;
    }

    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: `java: option requires an argument -- ${arg}\n`, exitCode: 2 };
      }
      classpath = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith('--class-path=')) {
      classpath = arg.slice('--class-path='.length);
      continue;
    }

    if (arg.startsWith('-D')) {
      const rawProperty = arg.slice(2);
      if (!rawProperty) {
        return { stdout: '', stderr: 'java: option requires property name -- -D\n', exitCode: 2 };
      }
      const equalsIndex = rawProperty.indexOf('=');
      const key = equalsIndex >= 0 ? rawProperty.slice(0, equalsIndex) : rawProperty;
      if (!key) {
        return { stdout: '', stderr: 'java: option requires property name -- -D\n', exitCode: 2 };
      }
      systemProperties[key] = equalsIndex >= 0 ? rawProperty.slice(equalsIndex + 1) : '';
      continue;
    }

    if (arg === '-jar') {
      if (args[index + 1] === undefined) {
        return { stdout: '', stderr: 'java: option requires an argument -- -jar\n', exitCode: 2 };
      }
      jarPath = args[index + 1] ?? null;
      return {
        mainClass: null,
        showVersion: false,
        programArgs: args.slice(index + 2),
        classpath,
        jarPath,
        systemProperties,
        enablePreview,
        enableAssertions,
      };
    }

    if (arg.startsWith('-')) {
      return { stdout: '', stderr: `java: unsupported option ${arg}\n`, exitCode: 2 };
    }

    return {
      mainClass: arg,
      showVersion: false,
      programArgs: args.slice(index + 1),
      classpath,
      jarPath,
      systemProperties,
      enablePreview,
      enableAssertions,
    };
  }

  return { stdout: '', stderr: 'Usage: java <mainclass> [args...]\n', exitCode: 2 };
}

function isJavacCommandResult(value: JavacParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function isJavaCommandResult(value: JavaParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function primaryJavacSourceArg(args: string[]): string {
  return args.find((arg) => /\.java$/i.test(arg)) ?? args[0] ?? '<javac>';
}

interface ParsedCppCompileInvocation {
  args: string[];
  showVersion: boolean;
}

type CppCompileParseResult = ParsedCppCompileInvocation | RuntimeCommandResult;

function parseCppCompileInvocation(args: string[]): CppCompileParseResult {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { args: [], showVersion: true };
  }
  if (args.length === 0) {
    return { stdout: '', stderr: 'clang++: error: no input files\n', exitCode: 1 };
  }
  return { args, showVersion: false };
}

function isCppCompileCommandResult(value: CppCompileParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function cppOutputPathFromArgs(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o' && typeof args[index + 1] === 'string') {
      return args[index + 1];
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      return arg.slice(2);
    }
  }
  return 'a.out';
}

function parseSimpleCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;
  let sawWord = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      sawWord = true;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      sawWord = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      sawWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (sawWord) {
        words.push(current);
        current = '';
        sawWord = false;
      }
      continue;
    }
    if ('|&;<>(){}~`$!#'.includes(ch)) {
      return null;
    }
    current += ch;
    sawWord = true;
  }

  if (escaping || quote !== null) return null;
  if (sawWord) words.push(current);
  return words.length > 0 ? words : null;
}

function leadingPersistentCdTarget(command: string): string | undefined | null {
  let quote: string | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    const next = command[index + 1];
    const isPersistentSeparator = ch === ';' || (ch === '&' && next === '&') || (ch === '|' && next === '|');
    if (!isPersistentSeparator) continue;

    const words = parseSimpleCommandWords(command.slice(0, index).trim());
    if (words?.[0] !== 'cd' || words.length > 2) return null;
    return words[1];
  }

  return null;
}

interface TerminalCommandListSegment {
  command: string;
  background: boolean;
}

function parseTerminalCommandList(command: string): TerminalCommandListSegment[] {
  const segments: TerminalCommandListSegment[] = [];
  let quote: string | null = null;
  let escaping = false;
  let segmentStart = 0;

  const pushSegment = (end: number, background: boolean): void => {
    const segment = command.slice(segmentStart, end).trim();
    if (segment) segments.push({ command: segment, background });
    segmentStart = end + 1;
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      pushSegment(index, false);
      continue;
    }
    if (ch === '&') {
      if (command[index - 1] === '&' || command[index + 1] === '&') continue;
      pushSegment(index, true);
    }
  }

  const trailingSegment = command.slice(segmentStart).trim();
  if (trailingSegment) segments.push({ command: trailingSegment, background: false });
  return segments.length > 0 ? segments : [{ command, background: false }];
}

function literalWordValue(word: unknown): string | null {
  const candidate = word as { type?: unknown; parts?: Array<{ type?: unknown; value?: unknown }> };
  if (candidate?.type !== 'Word' || !Array.isArray(candidate.parts)) return null;
  let value = '';
  for (const part of candidate.parts) {
    if (part?.type !== 'Literal' || typeof part.value !== 'string') return null;
    value += part.value;
  }
  return value;
}

function literalWord(value: string): { type: 'Word'; parts: Array<{ type: 'Literal'; value: string }> } {
  return {
    type: 'Word',
    parts: [{ type: 'Literal', value }],
  };
}

function rewriteKernelShellCommandInvocationsInAst(ast: unknown): void {
  const transformStatements = (statements: unknown): void => {
    if (!Array.isArray(statements)) return;
    for (const statement of statements) transformStatement(statement);
  };

  const transformCommand = (command: unknown): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        const rewrite = name ? TRACEKERNEL_SHELL_COMMAND_REWRITES.get(name) : undefined;
        if (rewrite) candidate.name = literalWord(rewrite);
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition);
          transformStatements(clause.body);
        }
        transformStatements(candidate.elseBody);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown): void => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return;
    for (const pipeline of candidate.pipelines) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command);
      }
    }
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') transformStatements(script.statements);
}

function rewriteTraceKernelBinInvocationsInAst(ast: unknown, commandNames: ReadonlySet<string>): void {
  const transformStatements = (statements: unknown): void => {
    if (!Array.isArray(statements)) return;
    for (const statement of statements) transformStatement(statement);
  };

  const transformCommand = (command: unknown): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        const commandName = name ? traceKernelBinCommandName(name) : null;
        if (commandName && commandNames.has(commandName)) candidate.name = literalWord(commandName);
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition);
          transformStatements(clause.body);
        }
        transformStatements(candidate.elseBody);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown): void => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return;
    for (const pipeline of candidate.pipelines) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command);
      }
    }
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') transformStatements(script.statements);
}

function rewriteVirtualExecutableInvocationsInAst(
  ast: unknown,
  initialCwd: string,
  workspaceRoot: string,
  workspaceAlias: string | undefined,
  executableRecords: ReadonlyMap<string, VirtualExecutableRecord>
): void {
  const availableExecutableRecords = new Map(executableRecords);

  const resolveExecutablePath = (cwd: string, executable: string): string | null => {
    if (!executable.includes('/') && !executable.startsWith('/')) return null;
    try {
      return toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, cwd, executable, workspaceAlias));
    } catch {
      return null;
    }
  };

  const commandArgs = (command: { args?: unknown[] }): string[] | null => {
    const args: string[] = [];
    for (const arg of command.args ?? []) {
      const value = literalWordValue(arg);
      if (value === null) return null;
      args.push(value);
    }
    return args;
  };

  const transformStatements = (statements: unknown, cwd: string): string => {
    if (!Array.isArray(statements)) return cwd;
    let currentCwd = cwd;
    for (const statement of statements) {
      currentCwd = transformStatement(statement, currentCwd);
    }
    return currentCwd;
  };

  const transformCommand = (command: unknown, cwd: string): void => {
    const candidate = command as {
      type?: unknown;
      name?: unknown;
      args?: unknown[];
      clauses?: Array<{ condition?: unknown; body?: unknown }>;
      elseBody?: unknown;
      body?: unknown;
      items?: Array<{ body?: unknown }>;
    };
    switch (candidate?.type) {
      case 'SimpleCommand': {
        const name = literalWordValue(candidate.name);
        if (!name) return;
        const resolvedExecutablePath = resolveExecutablePath(cwd, name);
        if (resolvedExecutablePath && availableExecutableRecords.has(resolvedExecutablePath)) {
          candidate.args = [literalWord(name), ...(candidate.args ?? [])];
          candidate.name = literalWord(TRACEKERNEL_EXEC_COMMAND);
        }
        return;
      }
      case 'If':
        for (const clause of candidate.clauses ?? []) {
          transformStatements(clause.condition, cwd);
          transformStatements(clause.body, cwd);
        }
        transformStatements(candidate.elseBody, cwd);
        return;
      case 'For':
      case 'While':
      case 'Until':
      case 'Subshell':
      case 'Group':
        transformStatements(candidate.body, cwd);
        return;
      case 'Case':
        for (const item of candidate.items ?? []) {
          transformStatements(item.body, cwd);
        }
        return;
      case 'FunctionDef':
        transformCommand(candidate.body, cwd);
        return;
      default:
        return;
    }
  };

  const transformStatement = (statement: unknown, cwd: string): string => {
    const candidate = statement as {
      type?: unknown;
      pipelines?: Array<{ commands?: unknown[] }>;
      operators?: unknown[];
    };
    if (candidate?.type !== 'Statement' || !Array.isArray(candidate.pipelines)) return cwd;

    let currentCwd = cwd;
    for (const [index, pipeline] of candidate.pipelines.entries()) {
      for (const command of pipeline.commands ?? []) {
        transformCommand(command, currentCwd);
      }

      const simpleCommand = pipeline.commands?.length === 1
        ? pipeline.commands[0] as { type?: unknown; name?: unknown; args?: unknown[] }
        : null;
      const name = simpleCommand?.type === 'SimpleCommand' ? literalWordValue(simpleCommand.name) : null;
      const args = simpleCommand ? commandArgs(simpleCommand) : null;
      if (name && args) {
        if (CPP_COMPILER_COMMANDS.has(name)) {
          const parsed = parseCppCompileInvocation(args);
          if (!isCppCompileCommandResult(parsed) && !parsed.showVersion) {
            const outputPath = resolveExecutablePath(currentCwd, cppOutputPathFromArgs(parsed.args));
            if (outputPath) availableExecutableRecords.set(outputPath, { path: outputPath, kind: 'cpp' });
          }
        } else if (name === 'cd') {
          const target = args[0] ?? workspaceRoot;
          const nextOperator = candidate.operators?.[index];
          if (nextOperator !== '||') {
            try {
              currentCwd = resolveWorkspaceCommandPath(workspaceRoot, currentCwd, target, workspaceAlias);
            } catch {
              // Keep the static cwd unchanged if the target cannot be represented in this workspace.
            }
          }
        }
      }
    }
    return currentCwd;
  };

  const script = ast as { type?: unknown; statements?: unknown };
  if (script?.type === 'Script') {
    transformStatements(script.statements, initialCwd);
  }
}

function normalizeTerminalAbsolutePath(path: string): string {
  assertNoNul(path, 'Terminal path');
  if (!path.startsWith('/')) throw new Error(`Terminal path must be absolute: ${path}`);
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function terminalCwdLabel(workspaceRoot: string, cwd: string, home: string): string {
  if (cwd === workspaceRoot) {
    const workspaceName = workspaceRoot.split('/').filter(Boolean).at(-1);
    return workspaceName || '/';
  }
  if (cwd === home) return '~';
  const cwdName = cwd.split('/').filter(Boolean).at(-1);
  return cwdName || '/';
}

interface RuntimeLsOptions {
  showAll: boolean;
  showAlmostAll: boolean;
  longFormat: boolean;
  humanReadable: boolean;
  recursive: boolean;
  reverse: boolean;
  sortBySize: boolean;
  sortByTime: boolean;
  classify: boolean;
  directoryOnly: boolean;
  positional: string[];
}

interface RuntimeLsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  isCharacterDevice?: boolean;
  mode?: number;
  size?: number;
  mtime?: Date;
  mtimeMs?: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
}

interface RuntimeLsEntry {
  name: string;
  path: string;
  stat: RuntimeLsStat;
}

function parseRuntimeLsArgs(args: readonly string[]): RuntimeLsOptions | RuntimeCommandResult {
  const options: RuntimeLsOptions = {
    showAll: false,
    showAlmostAll: false,
    longFormat: false,
    humanReadable: false,
    recursive: false,
    reverse: false,
    sortBySize: false,
    sortByTime: false,
    classify: false,
    directoryOnly: false,
    positional: [],
  };
  let parsingFlags = true;
  for (const arg of args) {
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && arg === '--help') {
      return {
        stdout: [
          'Usage: ls [OPTION]... [FILE]...',
          '  -a, --all            do not ignore entries starting with .',
          '  -A, --almost-all     do not list implied . and ..',
          '  -d, --directory      list directories themselves',
          '  -F, --classify       append indicator (one of */@)',
          '  -h, --human-readable with -l, print human-readable sizes',
          '  -l                   use a long listing format',
          '  -r, --reverse        reverse order while sorting',
          '  -R, --recursive      list subdirectories recursively',
          '  -S                   sort by file size, largest first',
          '  -t                   sort by modification time, newest first',
          '  -1                   list one file per line',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (parsingFlags && arg.startsWith('--') && arg.length > 2) {
      const long = arg.slice(2);
      if (long === 'all') options.showAll = true;
      else if (long === 'almost-all') options.showAlmostAll = true;
      else if (long === 'directory') options.directoryOnly = true;
      else if (long === 'classify') options.classify = true;
      else if (long === 'human-readable') options.humanReadable = true;
      else if (long === 'recursive') options.recursive = true;
      else if (long === 'reverse') options.reverse = true;
      else return { stdout: '', stderr: `ls: unrecognized option '--${long}'\n`, exitCode: 2 };
      continue;
    }
    if (parsingFlags && arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === 'a') options.showAll = true;
        else if (flag === 'A') options.showAlmostAll = true;
        else if (flag === 'd') options.directoryOnly = true;
        else if (flag === 'F') options.classify = true;
        else if (flag === 'h') options.humanReadable = true;
        else if (flag === 'l') options.longFormat = true;
        else if (flag === 'r') options.reverse = true;
        else if (flag === 'R') options.recursive = true;
        else if (flag === 'S') options.sortBySize = true;
        else if (flag === 't') options.sortByTime = true;
        else if (flag === '1') {
          // One-entry-per-line is already the only layout this harness exposes.
        } else {
          return { stdout: '', stderr: `ls: invalid option -- '${flag}'\n`, exitCode: 2 };
        }
      }
      continue;
    }
    options.positional.push(arg);
  }
  if (options.positional.length === 0) options.positional.push('.');
  return options;
}

function runtimeLsMode(stat: RuntimeLsStat): string {
  const type = stat.isDirectory ? 'd' : stat.isSymbolicLink ? 'l' : stat.isCharacterDevice ? 'c' : '-';
  const mode = stat.mode ?? (stat.isDirectory ? 0o755 : 0o644);
  const bits = [
    0o400, 0o200, 0o100,
    0o040, 0o020, 0o010,
    0o004, 0o002, 0o001,
  ];
  const chars: string[] = bits.map((bit, index) => {
    const value = (mode & bit) !== 0;
    if (index % 3 === 0) return value ? 'r' : '-';
    if (index % 3 === 1) return value ? 'w' : '-';
    return value ? 'x' : '-';
  });
  if ((mode & 0o4000) !== 0) chars[2] = chars[2] === 'x' ? 's' : 'S';
  if ((mode & 0o2000) !== 0) chars[5] = chars[5] === 'x' ? 's' : 'S';
  if ((mode & 0o1000) !== 0) chars[8] = chars[8] === 'x' ? 't' : 'T';
  return `${type}${chars.join('')}`;
}

function runtimeLsHumanSize(size: number): string {
  if (size < 1024) return String(size);
  if (size < 1024 * 1024) {
    const kib = size / 1024;
    return kib < 10 ? `${kib.toFixed(1)}K` : `${Math.round(kib)}K`;
  }
  if (size < 1024 * 1024 * 1024) {
    const mib = size / (1024 * 1024);
    return mib < 10 ? `${mib.toFixed(1)}M` : `${Math.round(mib)}M`;
  }
  const gib = size / (1024 * 1024 * 1024);
  return gib < 10 ? `${gib.toFixed(1)}G` : `${Math.round(gib)}G`;
}

function runtimeLsDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()] ?? 'Jan';
  const day = String(date.getDate()).padStart(2, ' ');
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  if (date > sixMonthsAgo) {
    return `${month} ${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${month} ${day}  ${date.getFullYear()}`;
}

function runtimeLsIndicator(stat: RuntimeLsStat): string {
  if (stat.isDirectory) return '/';
  if (stat.isSymbolicLink) return '@';
  return ((stat.mode ?? 0) & 0o111) !== 0 ? '*' : '';
}

function runtimeLsIdentity(path: string, stat: RuntimeLsStat, info: RuntimeKernelInfo): { owner: string; group: string; uid: number; gid: number } {
  if (typeof stat.owner === 'string' || typeof stat.group === 'string' || typeof stat.uid === 'number' || typeof stat.gid === 'number') {
    return {
      owner: stat.owner ?? (stat.uid === 0 ? 'root' : info.user.username),
      group: stat.group ?? (stat.gid === 0 ? 'root' : info.user.username),
      uid: stat.uid ?? (stat.owner === 'root' ? 0 : 1000),
      gid: stat.gid ?? (stat.group === 'root' ? 0 : 1000),
    };
  }
  const normalized = normalizeTerminalAbsolutePath(path);
  if (
    normalized === '/' ||
    normalized === '/home' ||
    normalized === '/dev' ||
    normalized.startsWith('/dev/') ||
    normalized === '/proc' ||
    normalized.startsWith('/proc/') ||
    normalized === '/tracekernel' ||
    normalized.startsWith('/tracekernel/') ||
    normalized === TRACEKERNEL_SKILLS_ROOT ||
    normalized.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)
  ) {
    return { owner: 'root', group: 'root', uid: 0, gid: 0 };
  }
  return { owner: info.user.username, group: info.user.username, uid: 1000, gid: 1000 };
}

function runtimeLsFormatLine(path: string, name: string, stat: RuntimeLsStat, options: RuntimeLsOptions, info: RuntimeKernelInfo): string {
  const identity = runtimeLsIdentity(path, stat, info);
  const size = stat.size ?? 0;
  const renderedSize = options.humanReadable ? runtimeLsHumanSize(size).padStart(5) : String(size).padStart(5);
  const mtime = stat.mtime ?? new Date(stat.mtimeMs ?? 0);
  const suffix = options.classify ? runtimeLsIndicator(stat) : stat.isDirectory ? '/' : '';
  return [
    runtimeLsMode(stat),
    String(stat.nlink ?? 1),
    identity.owner,
    identity.group,
    renderedSize,
    runtimeLsDate(mtime),
    `${name}${suffix}`,
  ].join(' ') + '\n';
}

function hasWorkspaceGlob(value: string): boolean {
  return /[*?[]/.test(value);
}

function globSegmentToRegExp(segment: string): RegExp {
  let source = '^';
  for (let index = 0; index < segment.length; index += 1) {
    const ch = segment[index];
    if (ch === '*') {
      source += '[^/]*';
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if (ch === '[') {
      const closeIndex = segment.indexOf(']', index + 1);
      if (closeIndex > index + 1) {
        source += segment.slice(index, closeIndex + 1);
        index = closeIndex;
        continue;
      }
    }
    source += ch.replace(/[\\^$+?.()|{}]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source);
}

function formatExpandedGlobPath(original: string, workspaceRoot: string, absolutePath: string): string {
  if (original.startsWith('/')) return absolutePath;
  return toProjectPath(workspaceRoot, absolutePath);
}

async function expandWorkspaceGlobArg(
  ctx: CommandContext,
  workspaceRoot: string,
  arg: string,
  workspaceAlias?: string
): Promise<string[]> {
  if (!hasWorkspaceGlob(arg)) return [arg];

  const normalized = arg.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${arg}`);
  }

  const absolutePattern = normalized.startsWith('/')
    ? mapWorkspaceAlias(workspaceRoot, workspaceAlias, normalizeWorkspaceCwd(normalized))
    : resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, normalized, workspaceAlias);
  if (!isWithinWorkspace(workspaceRoot, absolutePattern)) {
    throw new Error(`Project path must stay inside the workspace: ${arg}`);
  }

  const parts = absolutePattern.split('/').filter(Boolean);
  const rootParts = workspaceRoot.split('/').filter(Boolean);
  const patternParts = parts.slice(rootParts.length);
  let matches = [workspaceRoot];

  for (const part of patternParts) {
    const nextMatches: string[] = [];
    if (hasWorkspaceGlob(part)) {
      const pattern = globSegmentToRegExp(part);
      for (const basePath of matches) {
        let entries: string[];
        try {
          entries = await ctx.fs.readdir(basePath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (pattern.test(entry)) {
            nextMatches.push(`${basePath}/${entry}`);
          }
        }
      }
    } else {
      for (const basePath of matches) {
        nextMatches.push(`${basePath}/${part}`);
      }
    }
    matches = nextMatches;
  }

  const existingMatches: string[] = [];
  for (const match of matches) {
    try {
      const stat = await ctx.fs.stat(match);
      if (stat.isFile || stat.isDirectory) {
        existingMatches.push(match);
      }
    } catch {
      // Keep bash-like behavior below: unmatched globs remain literal.
    }
  }

  if (existingMatches.length === 0) return [arg];
  existingMatches.sort((left, right) => left.localeCompare(right));
  return existingMatches.map((match) => formatExpandedGlobPath(normalized, workspaceRoot, match));
}

async function expandWorkspaceGlobArgs(
  args: string[],
  ctx: CommandContext,
  workspaceRoot: string,
  workspaceAlias?: string
): Promise<string[]> {
  const expanded: string[] = [];
  for (const arg of args) {
    expanded.push(...await expandWorkspaceGlobArg(ctx, workspaceRoot, arg, workspaceAlias));
  }
  return expanded;
}

async function expandParsedScriptInvocation(
  ctx: CommandContext,
  workspaceRoot: string,
  scriptFile: string | null,
  scriptArgs: string[],
  workspaceAlias?: string
): Promise<{ scriptFile: string | null; scriptArgs: string[] }> {
  const expandedScriptArgs = await expandWorkspaceGlobArgs(scriptArgs, ctx, workspaceRoot, workspaceAlias);
  if (scriptFile === null || scriptFile === '-') {
    return { scriptFile, scriptArgs: expandedScriptArgs };
  }

  const expandedScriptFile = await expandWorkspaceGlobArg(ctx, workspaceRoot, scriptFile, workspaceAlias);
  return {
    scriptFile: expandedScriptFile[0] ?? scriptFile,
    scriptArgs: [...expandedScriptFile.slice(1), ...expandedScriptArgs],
  };
}

interface ParsedDotnetInvocation {
  source: CSharpProjectCommandRequest['source'];
  scriptPath: string;
  args: string[];
  buildArgs?: string[];
  noBuild?: boolean;
  showVersion: boolean;
}

type DotnetParseResult = ParsedDotnetInvocation | RuntimeCommandResult;

function collectDotnetBuildArg(args: string[], index: number, buildArgs: string[]): number {
  const arg = args[index];
  if (arg === '-p' || arg === '--property') {
    const value = args[index + 1];
    if (typeof value === 'string') {
      buildArgs.push(`${arg}:${value}`);
      return index + 1;
    }
    return index;
  }
  if (
    arg.startsWith('-p:') ||
    arg.startsWith('/p:') ||
    arg.startsWith('-property:') ||
    arg.startsWith('--property:')
  ) {
    buildArgs.push(arg);
    return index;
  }
  if (arg.startsWith('--property=')) {
    buildArgs.push(`--property:${arg.slice('--property='.length)}`);
    return index;
  }
  buildArgs.push(arg);
  return index;
}

function dotnetRunBuildOptionConsumesNext(arg: string): boolean {
  return [
    '-c',
    '--configuration',
    '-f',
    '--framework',
    '-r',
    '--runtime',
    '--arch',
    '--os',
    '-v',
    '--verbosity',
  ].includes(arg);
}

function collectDotnetRunBuildOption(args: string[], index: number, buildArgs: string[]): number {
  const arg = args[index];
  if (
    dotnetRunBuildOptionConsumesNext(arg) ||
    arg === '--no-restore' ||
    arg === '--self-contained' ||
    arg === '--no-self-contained'
  ) {
    buildArgs.push(arg);
    const value = args[index + 1];
    if (dotnetRunBuildOptionConsumesNext(arg) && typeof value === 'string') {
      buildArgs.push(value);
      return index + 1;
    }
    return index;
  }
  if (
    arg.startsWith('--configuration=') ||
    arg.startsWith('--framework=') ||
    arg.startsWith('--runtime=') ||
    arg.startsWith('--arch=') ||
    arg.startsWith('--os=') ||
    arg.startsWith('--verbosity=') ||
    arg.startsWith('--self-contained=')
  ) {
    buildArgs.push(arg);
    return index;
  }
  return index;
}

function parseDotnetInvocation(args: string[]): DotnetParseResult {
  if (args.includes('--version') || args.includes('--info')) {
    return { source: 'run', scriptPath: '<dotnet>', args: [], showVersion: true };
  }
  const command = args[0];
  if (command === 'build') {
    const rest = args.slice(1);
    const project = rest.find((arg) => !arg.startsWith('-') && arg.endsWith('.csproj')) ?? '<project>';
    const buildArgs: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === project) continue;
      index = collectDotnetBuildArg(rest, index, buildArgs);
    }
    return { source: 'compile', scriptPath: project, args: buildArgs, showVersion: false };
  }
  if (command === 'run') {
    let project = '<project>';
    const buildArgs: string[] = [];
    const programArgs: string[] = [];
    let noBuild = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--') {
        programArgs.push(...args.slice(index + 1));
        break;
      }
      if (arg === '--no-build') {
        noBuild = true;
        continue;
      }
      if (arg === '--no-launch-profile') {
        continue;
      }
      if (arg === '--launch-profile') {
        if (args[index + 1] === undefined) {
          return { stdout: '', stderr: 'dotnet: --launch-profile requires an argument\n', exitCode: 2 };
        }
        index += 1;
        continue;
      }
      if (arg.startsWith('--launch-profile=')) {
        continue;
      }
      if (arg === '--project') {
        project = args[index + 1] ?? '<project>';
        index += 1;
        continue;
      }
      if (arg === '-p' && typeof args[index + 1] === 'string' && args[index + 1]!.endsWith('.csproj')) {
        project = args[index + 1]!;
        index += 1;
        continue;
      }
      if (arg.startsWith('--project=')) {
        project = arg.slice('--project='.length);
        continue;
      }
      if (
        arg === '-p' ||
        arg === '--property' ||
        arg.startsWith('-p:') ||
        arg.startsWith('/p:') ||
        arg.startsWith('-property:') ||
        arg.startsWith('--property:') ||
        arg.startsWith('--property=')
      ) {
        index = collectDotnetBuildArg(args, index, buildArgs);
        continue;
      }
      const previousIndex = index;
      const previousBuildArgCount = buildArgs.length;
      index = collectDotnetRunBuildOption(args, index, buildArgs);
      if (index !== previousIndex || buildArgs.length !== previousBuildArgCount) {
        continue;
      }
      if (arg && !arg.startsWith('-')) {
        programArgs.push(arg);
      }
    }
    return { source: 'run', scriptPath: project, args: programArgs, buildArgs, noBuild, showVersion: false };
  }
  return { stdout: '', stderr: `dotnet: unsupported project command '${command ?? ''}'\n`, exitCode: 2 };
}

function isDotnetCommandResult(value: DotnetParseResult): value is RuntimeCommandResult {
  return typeof (value as RuntimeCommandResult).exitCode === 'number';
}

function commandEnv(ctx: CommandContext): Record<string, string> {
  return Object.fromEntries(ctx.env.entries());
}

function commandStdinPipe(ctx: CommandContext) {
  const stdin = decodeCommandStdin(ctx.stdin);
  return stdin ? createRuntimeCommandStdinPipeFromText(stdin) : undefined;
}

interface NormalizedRuntimePackageManagerConfig {
  managers: readonly RuntimePackageManagerName[];
  dependencyProvider?: RuntimePackageDependencyProvider;
  autoLinkBins: boolean;
  npmVersion: string;
}

type PackageManagerCommandName = RuntimePackageManagerName | 'npx';
type PackageManagerOutputEmitter = (stream: RuntimeCommandEventStream, data: string) => void;

interface ParsedPackageManagerInvocation {
  kind: 'version' | 'run' | 'exec' | 'install' | 'list' | 'unsupported';
  command: string;
  scriptName?: string;
  scriptArgs: string[];
  execCommand?: string;
  execArgs: string[];
  installCommand?: 'install' | 'ci' | 'add';
  installArgs: string[];
  prefix?: string;
  workspace?: string;
  ifPresent: boolean;
  silent: boolean;
  ignoreScripts: boolean;
}

const DEFAULT_PACKAGE_MANAGERS: readonly RuntimePackageManagerName[] = ['npm'];
const NPM_SCRIPT_ALIASES = new Map<string, string>([
  ['t', 'test'],
  ['test', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);
const NPM_LIFECYCLE_LIST_SCRIPT_NAMES = new Set(['test', 'start', 'stop', 'restart']);

function normalizePackageManagerConfig(
  config: boolean | RuntimePackageManagerConfig | undefined,
  defaultEnabled: boolean
): NormalizedRuntimePackageManagerConfig | null {
  if (config === false) return null;
  if (config === undefined && !defaultEnabled) return null;
  const source = typeof config === 'object' ? config : {};
  const managers = [...new Set((source.managers ?? DEFAULT_PACKAGE_MANAGERS)
    .filter((manager): manager is RuntimePackageManagerName => DEFAULT_PACKAGE_MANAGERS.includes(manager)))];
  if (managers.length === 0) return null;
  return {
    managers,
    ...(source.dependencyProvider ? { dependencyProvider: source.dependencyProvider } : {}),
    autoLinkBins: source.autoLinkBins !== false,
    npmVersion: source.npmVersion ?? '11.12.1',
  };
}

function commandInfo(
  name: string,
  kind: TraceKernelCommandKind,
  adapter: string,
  options: Omit<TraceKernelCommandInfo, 'name' | 'path' | 'kind' | 'adapter' | 'available'> = {}
): TraceKernelCommandInfo {
  return {
    name,
    path: traceKernelCommandPath(name),
    kind,
    adapter,
    available: true,
    ...options,
  };
}

function languageCommandInfo(
  language: Language,
  name: string,
  adapter: string,
  description?: string
): TraceKernelCommandInfo {
  const info = getLanguageRuntimeInfo(language);
  return commandInfo(name, 'runtime', adapter, {
    language,
    displayName: info.displayName,
    versionLabel: info.versionLabel,
    ...(description ? { description } : {}),
  });
}

function createTraceKernelCommandRegistry(
  options: CreateRuntimeWorkspaceOptions,
  packageManagerConfig: NormalizedRuntimePackageManagerConfig | null
): TraceKernelCommandInfo[] {
  const commands: TraceKernelCommandInfo[] = [
    commandInfo('bg', 'control', 'tracekernel job control'),
    commandInfo('curl', 'tool', 'tracekernel HTTP bridge'),
    commandInfo('fg', 'control', 'tracekernel job control'),
    commandInfo('jobs', 'control', 'tracekernel job control'),
    commandInfo('kill', 'control', 'tracekernel process control'),
    commandInfo('ls', 'tool', 'tracekernel-aware directory listing'),
    commandInfo('ps', 'control', 'tracekernel process table'),
    commandInfo('tracekernelctl', 'control', 'tracekernel control plane'),
    commandInfo(TRACEKERNEL_EXEC_COMMAND, 'control', 'tracekernel virtual executable dispatcher'),
    commandInfo('wait', 'control', 'tracekernel process control'),
    commandInfo('which', 'tool', 'tracekernel command resolver'),
    commandInfo('command', 'tool', 'tracekernel command resolver'),
  ];

  if (options.pythonRunner) {
    commands.push(
      languageCommandInfo('python', 'python3', 'Python project command adapter'),
      languageCommandInfo('python', 'python', 'Python project command adapter')
    );
  }
  if (options.nodeRunner) {
    commands.push(languageCommandInfo(
      'javascript',
      'node',
      'Node-compatible JavaScript project command adapter',
      'Adapter command for JavaScript project execution; browser workspaces run this through the worker-backed JavaScript lane.'
    ));
  }
  if (options.typescriptRunner) {
    commands.push(languageCommandInfo('typescript', 'tsc', 'TypeScript project compile adapter'));
  }
  if (options.javaRunner) {
    commands.push(
      languageCommandInfo('java', 'javac', 'Java project compile adapter'),
      languageCommandInfo('java', 'java', 'Java project run adapter')
    );
  }
  if (options.cppRunner) {
    for (const compiler of ['clang++', 'clang', 'gcc', 'cc', 'g++', 'c++']) {
      commands.push(languageCommandInfo('cpp', compiler, 'C/C++ project compile adapter'));
    }
    commands.push(commandInfo('a.out', 'virtual-executable', 'C++ virtual executable adapter', {
      language: 'cpp',
      displayName: getLanguageRuntimeInfo('cpp').displayName,
      versionLabel: getLanguageRuntimeInfo('cpp').versionLabel,
      description: 'Default C++ project executable produced by compile commands.',
    }));
  }
  if (options.csharpRunner) {
    commands.push(languageCommandInfo('csharp', 'dotnet', '.NET/C# project command adapter'));
  }
  if (packageManagerConfig?.managers.includes('npm')) {
    commands.push(
      commandInfo('npm', 'package-manager', 'npm-compatible project package manager adapter'),
      commandInfo('npx', 'package-manager', 'npm-compatible project executable adapter')
    );
  }

  const deduped = new Map<string, TraceKernelCommandInfo>();
  for (const command of commands) {
    if (!deduped.has(command.name)) deduped.set(command.name, command);
  }
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function traceKernelRuntimeRegistry(commands: readonly TraceKernelCommandInfo[]): TraceKernelRuntimeInfo[] {
  const runtimes: TraceKernelRuntimeInfo[] = [];
  const runtimeLanguages: Language[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
  for (const language of runtimeLanguages) {
    const info = getLanguageRuntimeInfo(language);
    const languageCommands = commands.filter((command) => command.language === language && command.kind === 'runtime');
    runtimes.push({
      language,
      displayName: info.displayName,
      versionLabel: info.versionLabel,
      available: languageCommands.length > 0,
      adapter: languageCommands.map((command) => command.adapter).filter(Boolean)[0] ?? 'not configured',
      commands: languageCommands.map((command) => command.name),
      paths: languageCommands.map((command) => command.path),
      runtime: info.runtime,
      ...(info.compiler ? { compiler: info.compiler } : {}),
      ...(info.standard ? { standard: info.standard } : {}),
    });
  }
  return runtimes;
}

function cleanPackageManagerPassthroughArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

function parsePackageManagerInvocation(
  manager: PackageManagerCommandName,
  args: string[]
): ParsedPackageManagerInvocation {
  if (manager === 'npx') {
    if (args[0] === '--version' || args[0] === '-v') {
      return { kind: 'version', command: 'version', scriptArgs: [], execArgs: [], installArgs: [], ifPresent: false, silent: false, ignoreScripts: false };
    }
    const execArgs = cleanPackageManagerPassthroughArgs(args);
    return {
      kind: execArgs.length > 0 ? 'exec' : 'unsupported',
      command: 'exec',
      execCommand: execArgs[0],
      execArgs: execArgs.slice(1),
      scriptArgs: [],
      installArgs: [],
      ifPresent: false,
      silent: false,
      ignoreScripts: false,
    };
  }

  let prefix: string | undefined;
  let workspace: string | undefined;
  let ifPresent = false;
  let silent = false;
  let ignoreScripts = false;
  const installFlags: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      positional.push(...args.slice(index));
      break;
    }
    if (arg === '--version' || arg === '-v') {
      return { kind: 'version', command: 'version', scriptArgs: [], execArgs: [], installArgs: [], ifPresent, silent, ignoreScripts };
    }
    if (arg === '--if-present') {
      ifPresent = true;
      continue;
    }
    if (arg === '--silent' || arg === '-s') {
      silent = true;
      continue;
    }
    if (arg === '--prefix' || arg === '-C' || arg === '--cwd') {
      const value = args[index + 1];
      if (value !== undefined) {
        prefix = value;
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length);
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      prefix = arg.slice('--cwd='.length);
      continue;
    }
    if (arg === '--workspace' || arg === '-w') {
      const value = args[index + 1];
      if (value !== undefined) {
        workspace = value;
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
      continue;
    }
    if (arg === '--ignore-scripts' || arg.startsWith('--ignore-scripts=')) {
      ignoreScripts = true;
      installFlags.push(arg);
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0] ?? '';
  const rest = positional.slice(1);
  const common = { command, prefix, workspace, ifPresent, silent, ignoreScripts };

  if (command === '' || command === 'run' || command === 'run-script') {
    const scriptName = command === '' ? undefined : rest[0];
    return {
      ...common,
      kind: 'run',
      scriptName,
      scriptArgs: cleanPackageManagerPassthroughArgs(command === '' ? [] : rest.slice(1)),
      execArgs: [],
      installArgs: [],
    };
  }

  const aliasedScript = NPM_SCRIPT_ALIASES.get(command);
  if (aliasedScript) {
    return {
      ...common,
      kind: 'run',
      scriptName: aliasedScript,
      scriptArgs: cleanPackageManagerPassthroughArgs(rest),
      execArgs: [],
      installArgs: [],
    };
  }

  if (command === 'exec' || command === 'x' || command === 'dlx') {
    const execArgs = cleanPackageManagerPassthroughArgs(rest);
    return {
      ...common,
      kind: 'exec',
      execCommand: execArgs[0],
      execArgs: execArgs.slice(1),
      scriptArgs: [],
      installArgs: [],
    };
  }

  if (command === 'install' || command === 'i' || command === 'ci' || command === 'add') {
    return {
      ...common,
      kind: 'install',
      installCommand: command === 'i' ? 'install' : command,
      installArgs: [...installFlags, ...rest],
      scriptArgs: [],
      execArgs: [],
    };
  }

  if (command === 'list' || command === 'ls') {
    return {
      ...common,
      kind: 'list',
      scriptArgs: [],
      execArgs: [],
      installArgs: [],
    };
  }

  return {
    ...common,
    kind: 'unsupported',
    scriptArgs: [],
    execArgs: [],
    installArgs: [],
  };
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function packageNameDefaultBinName(name: string): string {
  return name.startsWith('@') ? basename(name) : name;
}

function packageScripts(manifest: RuntimePackageManifest): Record<string, string> {
  const scripts = manifest.json.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  const normalized: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string') normalized[name] = command;
  }
  return normalized;
}

function packageDependencies(manifest: RuntimePackageManifest): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const record = manifest.json[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const [name, version] of Object.entries(record)) {
      if (typeof version === 'string') dependencies[name] = version;
    }
  }
  return dependencies;
}

async function readPackageManifestAt(
  ctx: CommandContext,
  directory: string
): Promise<RuntimePackageManifest | null> {
  const manifestPath = `${directory}/package.json`;
  if (!(await ctx.fs.exists(manifestPath))) return null;
  try {
    return {
      path: manifestPath,
      directory,
      json: JSON.parse(await ctx.fs.readFile(manifestPath)) as Record<string, unknown>,
    };
  } catch (error) {
    throw new Error(`Invalid package.json at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findNearestPackageManifest(
  ctx: CommandContext,
  workspaceRoot: string,
  startDirectory: string
): Promise<RuntimePackageManifest | null> {
  let current = startDirectory;
  while (isWithinWorkspace(workspaceRoot, current)) {
    const manifest = await readPackageManifestAt(ctx, current);
    if (manifest) return manifest;
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return null;
}

function workspacePatterns(manifest: RuntimePackageManifest | null): string[] {
  const workspaces = manifest?.json.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === 'string');
  }
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((value): value is string => typeof value === 'string');
    }
  }
  return [];
}

function normalizeWorkspacePattern(pattern: string): string | null {
  assertNoNul(pattern, 'Workspace pattern');
  const normalized = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '';
  if (/^[A-Za-z]:\//.test(normalized)) return null;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}

async function packageWorkspaceCandidates(
  ctx: CommandContext,
  workspaceRoot: string,
  rootManifest: RuntimePackageManifest | null
): Promise<RuntimePackageManifest[]> {
  const manifests: RuntimePackageManifest[] = [];
  for (const pattern of workspacePatterns(rootManifest)) {
    const normalized = normalizeWorkspacePattern(pattern);
    if (normalized === null) continue;
    if (!normalized.includes('*')) {
      const manifest = await readPackageManifestAt(ctx, normalized ? toWorkspacePath(workspaceRoot, normalized) : workspaceRoot);
      if (manifest) manifests.push(manifest);
      continue;
    }
    const parts = normalized.split('/');
    const starIndex = parts.indexOf('*');
    if (starIndex === -1 || parts.indexOf('*', starIndex + 1) !== -1) continue;
    const parentPath = parts.slice(0, starIndex).join('/');
    const childSuffix = parts.slice(starIndex + 1).join('/');
    const parentDirectory = parentPath ? toWorkspacePath(workspaceRoot, parentPath) : workspaceRoot;
    if (!(await ctx.fs.exists(parentDirectory))) continue;
    for (const entry of await ctx.fs.readdir(parentDirectory)) {
      const candidateDirectory = childSuffix
        ? `${parentDirectory}/${entry}/${childSuffix}`
        : `${parentDirectory}/${entry}`;
      const manifest = await readPackageManifestAt(ctx, candidateDirectory);
      if (manifest) manifests.push(manifest);
    }
  }
  return manifests;
}

async function resolveWorkspacePackageManifest(
  ctx: CommandContext,
  workspaceRoot: string,
  workspace: string,
  workspaceAlias?: string
): Promise<RuntimePackageManifest | null> {
  const rootManifest = await readPackageManifestAt(ctx, workspaceRoot);
  const directPath = (() => {
    try {
      return resolveWorkspaceCommandPath(workspaceRoot, workspaceRoot, workspace, workspaceAlias);
    } catch {
      return null;
    }
  })();
  if (directPath) {
    const manifest = await readPackageManifestAt(ctx, directPath);
    if (manifest) return manifest;
  }
  for (const manifest of await packageWorkspaceCandidates(ctx, workspaceRoot, rootManifest)) {
    if (manifest.json.name === workspace || toProjectPath(workspaceRoot, manifest.directory) === workspace) {
      return manifest;
    }
  }
  return null;
}

async function resolvePackageManifestForInvocation(
  ctx: CommandContext,
  workspaceRoot: string,
  invocation: ParsedPackageManagerInvocation,
  workspaceAlias?: string
): Promise<RuntimePackageManifest> {
  if (invocation.workspace) {
    const workspaceManifest = await resolveWorkspacePackageManifest(ctx, workspaceRoot, invocation.workspace, workspaceAlias);
    if (!workspaceManifest) {
      throw new Error(`Package workspace not found: ${invocation.workspace}`);
    }
    return workspaceManifest;
  }

  const startDirectory = invocation.prefix
    ? resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, invocation.prefix, workspaceAlias)
    : ctx.cwd;
  const stat = await ctx.fs.stat(startDirectory).catch(() => null);
  const manifest = await findNearestPackageManifest(
    ctx,
    workspaceRoot,
    stat?.isFile ? dirname(startDirectory) : startDirectory
  );
  if (!manifest) {
    throw new Error(`package.json not found from ${startDirectory}`);
  }
  return manifest;
}

function packageBinSearchPaths(workspaceRoot: string, packageDirectory: string): string[] {
  const paths: string[] = [];
  let current = packageDirectory;
  while (isWithinWorkspace(workspaceRoot, current)) {
    paths.push(`${current}/node_modules/.bin`);
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return paths;
}

function withPackageScriptPath(env: Record<string, string>, workspaceRoot: string, packageDirectory: string): string {
  return [
    ...packageBinSearchPaths(workspaceRoot, packageDirectory),
    env.PATH,
    '/usr/bin',
    '/bin',
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).join(':');
}

function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appendScriptArgs(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  return `${command} ${args.map(shellQuote).join(' ')}`;
}

function npmExecLifecycleScript(command: string): string {
  return JSON.stringify(command);
}

function lifecycleScriptNames(scriptName: string, scripts: Record<string, string>): string[] {
  const names: string[] = [];
  const pre = `pre${scriptName}`;
  const post = `post${scriptName}`;
  if (scripts[pre] !== undefined) names.push(pre);
  if (scripts[scriptName] !== undefined) names.push(scriptName);
  if (scripts[post] !== undefined) names.push(post);
  return names;
}

function packageDisplayName(manifest: RuntimePackageManifest): string {
  const name = typeof manifest.json.name === 'string' && manifest.json.name.trim()
    ? manifest.json.name.trim()
    : basename(manifest.directory);
  const version = typeof manifest.json.version === 'string' && manifest.json.version.trim()
    ? manifest.json.version.trim()
    : '0.0.0';
  return `${name}@${version}`;
}

function npmMissingScriptError(scriptName: string): string {
  return [
    `npm error Missing script: "${scriptName}"`,
    'npm error',
    'npm error To see a list of scripts, run:',
    'npm error   npm run',
    '',
  ].join('\n');
}

function npmScriptBanner(manifest: RuntimePackageManifest, eventName: string, command: string): string {
  return `\n> ${packageDisplayName(manifest)} ${eventName}\n> ${command}\n\n`;
}

function packageBinEntries(manifest: RuntimePackageManifest): Array<{ name: string; target: string }> {
  const bin = manifest.json.bin;
  const packageName = typeof manifest.json.name === 'string' ? manifest.json.name : '';
  if (typeof bin === 'string' && packageName) {
    return [{ name: packageNameDefaultBinName(packageName), target: bin }];
  }
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.entries(bin)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0)
    .map(([name, target]) => ({ name, target }));
}

async function packageManifestsInNodeModules(
  ctx: CommandContext,
  nodeModulesDirectory: string
): Promise<RuntimePackageManifest[]> {
  if (!(await ctx.fs.exists(nodeModulesDirectory))) return [];
  const manifests: RuntimePackageManifest[] = [];
  for (const entry of await ctx.fs.readdir(nodeModulesDirectory)) {
    if (entry === '.bin') continue;
    const entryPath = `${nodeModulesDirectory}/${entry}`;
    if (entry.startsWith('@')) {
      for (const scopedEntry of await ctx.fs.readdir(entryPath).catch(() => [])) {
        const manifest = await readPackageManifestAt(ctx, `${entryPath}/${scopedEntry}`);
        if (manifest) manifests.push(manifest);
      }
      continue;
    }
    const manifest = await readPackageManifestAt(ctx, entryPath);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

async function ensurePackageBinShims(
  ctx: CommandContext,
  workspaceRoot: string,
  packageDirectory: string
): Promise<void> {
  for (const binDirectory of packageBinSearchPaths(workspaceRoot, packageDirectory)) {
    const nodeModulesDirectory = dirname(binDirectory);
    if (!(await ctx.fs.exists(nodeModulesDirectory))) continue;
    await ctx.fs.mkdir(binDirectory, { recursive: true });
    for (const manifest of await packageManifestsInNodeModules(ctx, nodeModulesDirectory)) {
      for (const bin of packageBinEntries(manifest)) {
        if (bin.name.includes('/') || bin.name.includes('\0')) continue;
        const shimPath = `${binDirectory}/${bin.name}`;
        if (await ctx.fs.exists(shimPath)) continue;
        const targetPath = resolveWorkspaceCommandPath(workspaceRoot, manifest.directory, bin.target);
        if (!isWithinWorkspace(manifest.directory, targetPath)) continue;
        await ctx.fs.writeFile(shimPath, `#!/bin/sh\nnode ${shellQuote(targetPath)} "$@"\n`);
        await ctx.fs.chmod(shimPath, 0o755);
      }
    }
  }
}

function packageScriptEnv(
  manager: RuntimePackageManagerName,
  manifest: RuntimePackageManifest,
  workspaceRoot: string,
  originalCwd: string,
  baseEnv: Record<string, string>,
  eventName: string,
  script: string
): Record<string, string> {
  return {
    ...baseEnv,
    INIT_CWD: originalCwd,
    PWD: manifest.directory,
    PATH: withPackageScriptPath(baseEnv, workspaceRoot, manifest.directory),
    npm_lifecycle_event: eventName,
    npm_lifecycle_script: script,
    npm_package_name: typeof manifest.json.name === 'string' ? manifest.json.name : '',
    npm_package_version: typeof manifest.json.version === 'string' ? manifest.json.version : '',
    npm_config_user_agent: `${manager}/tracekernel`,
    npm_execpath: `/tracekernel/${manager}`,
    npm_node_execpath: 'node',
  };
}

async function runPackageScript(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  scriptName: string,
  scriptArgs: readonly string[],
  options: NormalizedRuntimePackageManagerConfig,
  ifPresent: boolean,
  silent: boolean,
  ignoreScripts: boolean,
  emitOutput?: PackageManagerOutputEmitter
): Promise<RuntimeCommandResult> {
  const scripts = packageScripts(manifest);
  const events = ignoreScripts
    ? (scripts[scriptName] === undefined ? [] : [scriptName])
    : lifecycleScriptNames(scriptName, scripts);
  if (events.length === 0) {
    return ifPresent
      ? { stdout: '', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: npmMissingScriptError(scriptName), exitCode: 1 };
  }
  if (!ctx.exec) {
    return { stdout: '', stderr: `${manager}: package scripts require shell subcommand execution\n`, exitCode: 1 };
  }
  if (options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }

  let stdout = '';
  let stderr = '';
  for (const eventName of events) {
    const script = scripts[eventName]!;
    const command = appendScriptArgs(script, eventName === scriptName ? scriptArgs : []);
    if (!silent) {
      const banner = npmScriptBanner(manifest, eventName, command);
      stdout += banner;
      emitOutput?.('stdout', banner);
    }
    const result = await ctx.exec(command, {
      cwd: manifest.directory,
      env: packageScriptEnv(manager, manifest, workspaceRoot, ctx.cwd, commandEnv(ctx), eventName, script),
      stdin: decodeCommandStdin(ctx.stdin),
      signal: ctx.signal,
    });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) {
      return { stdout, stderr, exitCode: result.exitCode };
    }
  }
  return { stdout, stderr, exitCode: 0 };
}

async function runPackageExec(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  command: string | undefined,
  args: readonly string[],
  options: NormalizedRuntimePackageManagerConfig
): Promise<RuntimeCommandResult> {
  if (!command) return { stdout: '', stderr: `${manager} exec: missing command\n`, exitCode: 1 };
  if (!ctx.exec) return { stdout: '', stderr: `${manager} exec requires shell subcommand execution\n`, exitCode: 1 };
  if (options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }
  const baseEnv = commandEnv(ctx);
  const shellCommand = appendScriptArgs(command, args);
  return ctx.exec(shellCommand, {
    cwd: manifest.directory,
    env: {
      ...baseEnv,
      INIT_CWD: ctx.cwd,
      PWD: manifest.directory,
      PATH: withPackageScriptPath(baseEnv, workspaceRoot, manifest.directory),
      npm_lifecycle_event: 'npx',
      npm_lifecycle_script: npmExecLifecycleScript(command),
      npm_package_name: typeof manifest.json.name === 'string' ? manifest.json.name : '',
      npm_package_version: typeof manifest.json.version === 'string' ? manifest.json.version : '',
      npm_config_user_agent: `${manager}/tracekernel`,
      npm_execpath: `/tracekernel/${manager}`,
      npm_node_execpath: 'node',
    },
    stdin: decodeCommandStdin(ctx.stdin),
    signal: ctx.signal,
  });
}

function listPackageScripts(manifest: RuntimePackageManifest): RuntimeCommandResult {
  const scripts = packageScripts(manifest);
  const names = Object.keys(scripts);
  if (names.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const lifecycleNames = names.filter((name) => NPM_LIFECYCLE_LIST_SCRIPT_NAMES.has(name));
  const otherNames = names.filter((name) => !NPM_LIFECYCLE_LIST_SCRIPT_NAMES.has(name));
  const lines: string[] = [];
  if (lifecycleNames.length > 0) {
    lines.push(`Lifecycle scripts included in ${packageDisplayName(manifest)}:`);
    for (const name of lifecycleNames) lines.push(`  ${name}`, `    ${scripts[name]}`);
  }
  if (otherNames.length > 0) {
    lines.push('available via `npm run`:');
    for (const name of otherNames) lines.push(`  ${name}`, `    ${scripts[name]}`);
  }
  return {
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
    exitCode: 0,
  };
}

function listPackageDependencies(manifest: RuntimePackageManifest): RuntimeCommandResult {
  const name = typeof manifest.json.name === 'string' ? manifest.json.name : basename(manifest.directory);
  const version = typeof manifest.json.version === 'string' ? manifest.json.version : '0.0.0';
  const dependencies = packageDependencies(manifest);
  const lines = [`${name}@${version} ${manifest.directory}`];
  for (const [dependency, dependencyVersion] of Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`+-- ${dependency}@${dependencyVersion}`);
  }
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}

async function runPackageInstall(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  invocation: ParsedPackageManagerInvocation,
  options: NormalizedRuntimePackageManagerConfig,
  entrypoint: string | undefined,
  workspaceAlias: string | undefined,
  kernel: RuntimeKernelInfo | undefined,
  readonlyFiles: readonly string[] | undefined,
  hiddenFiles: readonly string[] | undefined,
  includeHiddenFiles: () => boolean,
  onFileChange: RuntimeFileChangeObserver | undefined
): Promise<RuntimeCommandResult> {
  if (!options.dependencyProvider) {
    return {
      stdout: '',
      stderr: [
        'npm ERR! code ENOTSUP',
        `npm ERR! ${manager} ${invocation.installCommand ?? 'install'} is disabled in tracekernel; provide a package dependency provider or preloaded node_modules.`,
        '',
      ].join('\n'),
      exitCode: 1,
    };
  }
  const result = await applyCommandResultFiles(ctx, workspaceRoot, await options.dependencyProvider.install({
    manager,
    command: invocation.installCommand ?? 'install',
    args: invocation.installArgs,
    cwd: manifest.directory,
    env: commandEnv(ctx),
    manifest,
    project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }), onFileChange);
  if (result.exitCode === 0 && options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }
  return result;
}

async function runPackageManagerCommand(
  commandName: PackageManagerCommandName,
  args: string[],
  ctx: CommandContext,
  workspaceRoot: string,
  options: NormalizedRuntimePackageManagerConfig,
  entrypoint: string | undefined,
  workspaceAlias: string | undefined,
  kernel: RuntimeKernelInfo | undefined,
  readonlyFiles: readonly string[] | undefined,
  hiddenFiles: readonly string[] | undefined,
  includeHiddenFiles: () => boolean,
  onFileChange: RuntimeFileChangeObserver | undefined,
  emitOutput?: PackageManagerOutputEmitter
): Promise<RuntimeCommandResult> {
  const manager: RuntimePackageManagerName = commandName === 'npx' ? 'npm' : commandName;
  const invocation = parsePackageManagerInvocation(commandName, args);
  if (invocation.kind === 'version') {
    return { stdout: `${options.npmVersion}\n`, stderr: '', exitCode: 0 };
  }

  let manifest: RuntimePackageManifest;
  try {
    manifest = await resolvePackageManifestForInvocation(ctx, workspaceRoot, invocation, workspaceAlias);
  } catch (error) {
    return { stdout: '', stderr: `${manager}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
  }

  switch (invocation.kind) {
    case 'run':
      if (!invocation.scriptName) return listPackageScripts(manifest);
      return runPackageScript(
        manager,
        ctx,
        workspaceRoot,
        manifest,
        invocation.scriptName,
        invocation.scriptArgs,
        options,
        invocation.ifPresent,
        invocation.silent,
        invocation.ignoreScripts,
        emitOutput
      );
    case 'exec':
      return runPackageExec(manager, ctx, workspaceRoot, manifest, invocation.execCommand, invocation.execArgs, options);
    case 'install':
      return runPackageInstall(manager, ctx, workspaceRoot, manifest, invocation, options, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange);
    case 'list':
      return listPackageDependencies(manifest);
    case 'unsupported':
    default:
      return { stdout: '', stderr: `${manager}: unsupported package manager command '${invocation.command}'\n`, exitCode: 1 };
  }
}

export function createPackageManagerProjectCommands(
  config: boolean | RuntimePackageManagerConfig = true,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  emitOutput?: PackageManagerOutputEmitter,
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const normalized = normalizePackageManagerConfig(config, true);
  if (!normalized) return [];
  const commands: ProjectWorkspaceCommand[] = normalized.managers.map((manager) =>
    defineCommand(manager, (args, ctx) =>
      runPackageManagerCommand(manager, args, ctx, workspaceRoot, normalized, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange, emitOutput))
  );
  if (normalized.managers.includes('npm')) {
    commands.push(defineCommand('npx', (args, ctx) =>
      runPackageManagerCommand('npx', args, ctx, workspaceRoot, normalized, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange, emitOutput)));
  }
  return commands;
}

export function createPythonProjectCommands(
  runner: PythonProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runPython = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parsePythonInvocation(args);
    if (isCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Python project command adapter\n', stderr: '', exitCode: 0 };
    }

    const stdin = decodeCommandStdin(ctx.stdin);
    let parsedScript: { scriptFile: string | null; scriptArgs: string[] };
    try {
      parsedScript = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.scriptFile, parsed.scriptArgs, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let code: string;
    let scriptPath: string;
    let source: PythonProjectCommandRequest['source'];

    if (parsed.code !== null) {
      code = parsed.code;
      scriptPath = '-c';
      source = 'argument';
    } else if (parsed.module !== null) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(parsed.module)) {
        return { stdout: '', stderr: `python3: No module named '${parsed.module.slice(0, 200)}'\n`, exitCode: 1 };
      }
      code = `import runpy; runpy.run_module(${JSON.stringify(parsed.module)}, run_name='__main__')`;
      scriptPath = parsed.module;
      source = 'module';
    } else if (parsedScript.scriptFile === '-') {
      code = stdin;
      scriptPath = '-';
      source = 'stdin';
    } else if (parsedScript.scriptFile !== null) {
      let absolutePath: string;
      try {
        absolutePath = resolveWorkspaceContextPath(ctx, workspaceRoot, parsedScript.scriptFile, 'Python script path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
      }
      if (!(await ctx.fs.exists(absolutePath))) {
        return {
          stdout: '',
          stderr: `python3: can't open file '${parsedScript.scriptFile}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }
      code = await ctx.fs.readFile(absolutePath);
      scriptPath = toProjectPath(workspaceRoot, absolutePath);
      source = 'file';
    } else if (stdin.trim().length > 0) {
      code = stdin;
      scriptPath = '<stdin>';
      source = 'stdin';
    } else {
      return {
        stdout: '',
        stderr: 'python3: no input provided (use -c CODE, -m MODULE, or provide a script file)\n',
        exitCode: 2,
      };
    }

    const stdinPipe = source === 'stdin' ? undefined : commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  return [
    defineCommand('python3', runPython),
    defineCommand('python', runPython),
  ];
}

export function createNodeProjectCommands(
  runner: JavaScriptProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runNode = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseNodeInvocation(args);
    if (isNodeCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Node project command adapter\n', stderr: '', exitCode: 0 };
    }

    const stdin = decodeCommandStdin(ctx.stdin);
    let parsedScript: { scriptFile: string | null; scriptArgs: string[] };
    try {
      parsedScript = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.scriptFile, parsed.scriptArgs, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let code: string;
    let scriptPath: string;
    let source: JavaScriptProjectCommandRequest['source'];

    if (parsed.code !== null) {
      code = parsed.code;
      scriptPath = '-e';
      source = 'argument';
    } else if (parsedScript.scriptFile === '-') {
      code = stdin;
      scriptPath = '-';
      source = 'stdin';
    } else if (parsedScript.scriptFile !== null) {
      let absolutePath: string;
      try {
        absolutePath = resolveWorkspaceContextPath(ctx, workspaceRoot, parsedScript.scriptFile, 'Node script path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 9 };
      }
      if (!(await ctx.fs.exists(absolutePath))) {
        return {
          stdout: '',
          stderr: `node: cannot find module '${parsedScript.scriptFile}'\n`,
          exitCode: 1,
        };
      }
      const stat = await ctx.fs.stat(absolutePath);
      if (!stat.isFile && !stat.isDirectory) {
        return {
          stdout: '',
          stderr: `node: cannot find module '${parsedScript.scriptFile}'\n`,
          exitCode: 1,
        };
      }
      code = stat.isFile ? await ctx.fs.readFile(absolutePath) : '';
      scriptPath = toProjectPath(workspaceRoot, absolutePath);
      source = 'file';
    } else if (stdin.trim().length > 0) {
      code = stdin;
      scriptPath = '<stdin>';
      source = 'stdin';
    } else {
      return {
        stdout: '',
        stderr: 'node: no input provided (use -e CODE or provide a script file)\n',
        exitCode: 9,
      };
    }

    const stdinPipe = source === 'stdin' ? undefined : commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(
        parsed.inputType || parsed.requireModules.length > 0
          ? {
              options: {
                ...(parsed.inputType ? { inputType: parsed.inputType } : {}),
                ...(parsed.requireModules.length > 0 ? { require: parsed.requireModules } : {}),
              },
            }
          : {}
      ),
    }), onFileChange);
  };

  return [
    defineCommand('node', runNode),
  ];
}

export function createTypeScriptProjectCommands(
  runner: TypeScriptProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runTsc = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseTscInvocation(args);
    if (isTscCommandResult(parsed)) return parsed;
    if (parsed.showVersion) {
      return { stdout: 'TypeScript project command adapter\n', stderr: '', exitCode: 0 };
    }
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'compile',
      scriptPath: 'tsconfig.json',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  return [
    defineCommand('tsc', runTsc),
  ];
}

export function createJavaProjectCommands(
  runner: JavaProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runJavac = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandJavaCommandArgfiles(args, ctx, workspaceRoot);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let globExpandedArgs: string[];
    try {
      globExpandedArgs = await expandWorkspaceGlobArgs(expandedArgs, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseJavacInvocation(globExpandedArgs);
    if (isJavacCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Java project command adapter\n', stderr: '', exitCode: 0 };
    }

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'compile',
      scriptPath: primaryJavacSourceArg(parsed.args),
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  const runJava = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandJavaCommandArgfiles(args, ctx, workspaceRoot);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseJavaInvocation(expandedArgs);
    if (isJavaCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Java project command adapter\n', stderr: '', exitCode: 0 };
    }

    let parsedJar: { scriptFile: string | null; scriptArgs: string[] };
    let programArgs: string[];
    try {
      parsedJar = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.jarPath, parsed.programArgs, workspaceAlias);
      programArgs = parsed.jarPath ? parsedJar.scriptArgs : await expandWorkspaceGlobArgs(parsed.programArgs, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const jarPath = parsed.jarPath ? parsedJar.scriptFile : null;
    let jarMainClass: string | null = null;
    if (jarPath) {
      let absoluteJarPath: string;
      try {
        absoluteJarPath = resolveWorkspaceContextPath(ctx, workspaceRoot, jarPath, 'Java jar path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
      }
      if (!(await ctx.fs.exists(absoluteJarPath))) {
        return { stdout: '', stderr: `Error: Unable to access jarfile ${jarPath}\n`, exitCode: 1 };
      }
      jarMainClass = extractStoredJarMainClass(await ctx.fs.readFileBuffer(absoluteJarPath));
    }

    const stdinPipe = commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath: jarPath ?? parsed.mainClass ?? '<main>',
      args: programArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: {
        ...(jarPath ? { jarPath, classpath: jarPath } : parsed.classpath ? { classpath: parsed.classpath } : {}),
        ...(jarMainClass ? { jarMainClass } : {}),
        ...(Object.keys(parsed.systemProperties).length > 0 ? { systemProperties: parsed.systemProperties } : {}),
        ...(parsed.enablePreview ? { enablePreview: true } : {}),
        ...(parsed.enableAssertions ? { enableAssertions: true } : {}),
      },
    }), onFileChange);
  };

  return [
    defineCommand('javac', runJavac),
    defineCommand('java', runJava),
  ];
}

export function createCppProjectCommands(
  runner: CppProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  options: {
    recordExecutablePath?: (path: string) => void;
    entrypoint?: string;
    onFileChange?: RuntimeFileChangeObserver;
    workspaceAlias?: string;
    kernel?: RuntimeKernelInfo;
    readonlyFiles?: readonly string[];
    hiddenFiles?: readonly string[];
    includeHiddenFiles?: () => boolean;
  } = {}
): ProjectWorkspaceCommand[] {
  const runCompiler = (compilerCommand: string) => async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, options.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    const parsed = parseCppCompileInvocation(expandedArgs);
    if (isCppCompileCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: `${compilerCommand} project command adapter\n`, stderr: '', exitCode: 0 };
    }

    const result = await runner({
      code: parsed.args.includes('-') ? decodeCommandStdin(ctx.stdin) : '',
      source: 'compile',
      scriptPath: parsed.args.find((arg) => /\.(?:c|cc|cpp|cxx)$/i.test(arg)) ?? '<compile>',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel, options.readonlyFiles, options.hiddenFiles, options.includeHiddenFiles?.() ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: { compilerCommand },
    });
    const commandResult = await applyCommandResultFiles(ctx, workspaceRoot, result, options.onFileChange);
    if (commandResult.exitCode === 0) {
      options.recordExecutablePath?.(toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, cppOutputPathFromArgs(parsed.args), options.workspaceAlias)));
    }
    return commandResult;
  };

  const runExecutable = (defaultPath: string) => async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, options.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    const stdinPipe = commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath: defaultPath,
      args: expandedArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel, options.readonlyFiles, options.hiddenFiles, options.includeHiddenFiles?.() ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), options.onFileChange);
  };

  return [
    defineCommand('clang++', runCompiler('clang++')),
    defineCommand('clang', runCompiler('clang')),
    defineCommand('gcc', runCompiler('gcc')),
    defineCommand('cc', runCompiler('cc')),
    defineCommand('g++', runCompiler('g++')),
    defineCommand('c++', runCompiler('c++')),
    defineCommand('./a.out', runExecutable('./a.out')),
    defineCommand('a.out', runExecutable('a.out')),
  ];
}

export function createCSharpProjectCommands(
  runner: CSharpProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runDotnet = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseDotnetInvocation(expandedArgs);
    if (isDotnetCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'C# project command adapter\n', stderr: '', exitCode: 0 };
    }

    const project = filterReadonlySnapshotFiles(
      await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      readonlyFiles,
      hiddenFiles
    );

    const stdinPipe = parsed.source === 'run' ? commandStdinPipe(ctx) : undefined;
    const result = await runner({
      code: '',
      source: parsed.source,
      scriptPath: parsed.scriptPath,
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(parsed.buildArgs || parsed.noBuild
        ? {
            options: {
              ...(parsed.buildArgs ? { buildArgs: parsed.buildArgs } : {}),
              ...(parsed.noBuild ? { noBuild: true } : {}),
            },
          }
        : {}),
    });
    return applyCommandResultFiles(
      ctx,
      workspaceRoot,
      filterReadonlySnapshotDeletions(result, readonlyFiles),
      onFileChange
    );
  };

  return [
    defineCommand('dotnet', runDotnet),
  ];
}

export class JustBashRuntimeWorkspace implements RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly projectSession?: RuntimeProjectSessionInfo;
  readonly cwd: string;
  readonly http: RuntimeWorkspaceHttpClient;
  readonly kernelInfo: RuntimeKernelInfo;
  private readonly bash: Bash;
  private readonly bashOptions: BashOptions;
  private readonly fs: KernelObservedFileSystem;
  private readonly fsLocks = new RuntimeFileSystemLockCoordinator();
  private readonly commandScheduler: RuntimeCommandScheduler;
  private readonly entrypoint?: string;
  private readonly kernelControl?: RuntimeTraceKernelControlOptions;
  private readonly cppRunner?: CppProjectCommandRunner;
  private readonly traceKernelCommandRegistry: TraceKernelCommandInfo[];
  private readonly traceKernelCommandNames: ReadonlySet<string>;
  private readonly skillFiles = new Map<string, RuntimeFile>();
  private readonly virtualExecutableRecords = new Map<string, VirtualExecutableRecord>();
  private readonly commandExecutionContexts = new AsyncLocalStorage<RuntimeCommandExecutionContext>();
  private readonly processTable = new Map<number, RuntimeKernelProcessRecord>();
  private readonly zombieProcessTable = new Map<number, RuntimeKernelZombieRecord>();
  private readonly processWaiters = new Map<number, Array<(process: RuntimeKernelProcessRecord) => void>>();
  private readonly anyProcessWaiters: Array<(process: RuntimeKernelProcessRecord) => void> = [];
  private readonly kernelEventLog: RuntimeKernelEventRecord[] = [];
  private readonly httpListeners = new Map<string, RuntimeKernelHttpListenerRecord>();
  private readonly httpRequestLog: RuntimeKernelHttpRequestRecord[] = [];
  private readonly readonlyFiles = new Set<string>();
  private readonly eventWatchers = new Set<RuntimeWorkspaceEventHandler>();
  private readonlySuspendDepth = 0;
  private nextCommandId = 1;
  private nextPid = 100;
  private nextKernelEventSeq = 1;
  private nextHttpListenerSeq = 1;
  private nextHttpRequestSeq = 1;
  private nextEphemeralHttpPort = 49152;
  private activeHttpRequests = 0;
  private destroyed = false;
  private terminalVerbose = false;

  constructor(options: CreateRuntimeWorkspaceOptions = {}) {
    this.kernelInfo = createTraceKernelInfo(options.kernel, options.cwd);
    this.http = {
      request: (requestOptions) => this.requestHttp(requestOptions),
      json: (requestOptions) => this.requestHttpJson(requestOptions),
      listen: (listenOptions, handler) => this.listenHttp(listenOptions, handler),
    };
    this.commandScheduler = new RuntimeCommandScheduler(normalizeRuntimeSchedulerConfig(options.kernel?.scheduler));
    this.cwd = this.kernelInfo.workspaceRoot;
    this.projectSession = options.projectSession ? createProjectSessionInfo(options.projectSession, this.kernelInfo) : undefined;
    for (const path of this.projectSession?.readonlyFiles ?? []) {
      this.readonlyFiles.add(path);
    }
    this.entrypoint = options.entrypoint ? this.toWorkspaceRelativePath(options.entrypoint) : undefined;
    this.kernelControl = options.kernelControl;
    this.cppRunner = options.cppRunner;
    this.kernel = this.createKernel();
    this.fs = new KernelObservedFileSystem(
      new InMemoryFs(),
      this.fsLocks,
      () => this.cwd,
      () => this.kernelInfo.workspaceAlias,
      () => this.kernelInfo,
      (absolutePath, operation) => this.assertWorkspacePathWritable(absolutePath, operation),
      (absolutePath, operation) => this.assertWorkspaceSubtreeWritable(absolutePath, operation),
      () => this.currentCommandContext()?.generationBaseline,
      () => {
        const context = this.currentCommandContext();
        return context
          ? {
              baseline: context.generationBaseline,
              mutatedPaths: context.mutatedGenerationPaths,
              pid: context.process.pid,
              signal: context.process.abortController!.signal,
              setError: (error) => {
                context.kernelError = error;
              },
            }
          : undefined;
      },
      (event) => this.recordKernelEvent(event.type, event.pid, event.detail),
      this.createDynamicProcProvider(),
      (change) => {
        if (!this.currentCommandContext()) return;
        this.emitLocalRuntimeEvent({ type: 'file-change', change, phase: 'live' });
      },
      (device) => this.readDevice(device),
      (device, data) => this.writeDevice(device, data)
    );
    const withEvents = <Request extends RuntimeProjectCommandRequest<string>>(
      runner: RuntimeProjectCommandRunner<Request>
    ): RuntimeProjectCommandRunner<Request> => (
      async (request) => {
        const commandContext = this.currentCommandContext();
        const activeStdinPipe = request.source !== 'compile' && request.source !== 'stdin'
          ? commandContext?.stdinPipe
          : undefined;
        const stdinPipe = request.stdinPipe ?? activeStdinPipe;
        const signal = commandContext?.process.abortController?.signal ?? request.signal;
        const runtimeIo = commandContext?.runtimeIo;
        let acceptingRunnerEvents = true;
        let result: RuntimeCommandResult;
        try {
          result = await runner({
            ...request,
            ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
            ...(signal ? { signal } : {}),
            kernelHttp: this.createKernelHttpBridge(),
            onEvent: (event) => {
              if (!acceptingRunnerEvents || signal?.aborted) return;
              if (runtimeIo) {
                runtimeIo.handleRuntimeEvent(event);
              } else {
                this.handleRuntimeCommandEvent(event);
              }
            },
          } as Request);
        } finally {
          acceptingRunnerEvents = false;
          runtimeIo?.close();
        }
        if (runtimeIo) {
          await runtimeIo.flush();
          return runtimeIo.filterAppliedResultFiles(result) as RuntimeCommandResult;
        }
        await this.flushRuntimeEventQueue();
        return result;
      }
    );
    const observeFileChange: RuntimeFileChangeObserver = (change, phase) => {
      this.emitLocalRuntimeEvent({ type: 'file-change', change, phase });
    };
    const packageManagerConfig = normalizePackageManagerConfig(
      options.packageManager,
      Boolean(options.nodeRunner || options.typescriptRunner)
    );
    this.traceKernelCommandRegistry = createTraceKernelCommandRegistry(options, packageManagerConfig);
    this.traceKernelCommandNames = new Set(this.traceKernelCommandRegistry.map((command) => command.name));
    const emitPackageManagerOutput: PackageManagerOutputEmitter = (stream, data) => {
      this.emitLocalRuntimeEvent({
        type: 'output',
        stream,
        device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
        data,
      });
    };
    const includeHiddenFilesForCurrentCommand = () => this.currentCommandContext()?.includeHiddenFiles === true;
    const customCommands = [
      ...(options.pythonRunner ? createPythonProjectCommands(withEvents(options.pythonRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.nodeRunner ? createNodeProjectCommands(withEvents(options.nodeRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.typescriptRunner ? createTypeScriptProjectCommands(withEvents(options.typescriptRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(packageManagerConfig ? createPackageManagerProjectCommands(packageManagerConfig, this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, emitPackageManagerOutput, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.javaRunner ? createJavaProjectCommands(withEvents(options.javaRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.cppRunner ? createCppProjectCommands(withEvents(options.cppRunner), this.cwd, {
        recordExecutablePath: (path) => this.registerVirtualExecutable({ path, kind: 'cpp' }),
        entrypoint: this.entrypoint,
        onFileChange: observeFileChange,
        workspaceAlias: this.kernelInfo.workspaceAlias,
        kernel: this.kernelInfo,
        readonlyFiles: this.projectSession?.readonlyFiles,
        hiddenFiles: this.projectSession?.hiddenFiles,
        includeHiddenFiles: includeHiddenFilesForCurrentCommand,
      }) : []),
      ...(options.csharpRunner ? createCSharpProjectCommands(withEvents(options.csharpRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      defineCommand(TRACEKERNEL_EXEC_COMMAND, (args, ctx) => this.runTraceKernelExec(args, ctx)),
      defineCommand('bg', async (args) => this.runKernelJobPlacement(args, 'bg')),
      defineCommand('curl', async (args, ctx) => this.runKernelCurl(args, ctx)),
      defineCommand('fg', async (args) => this.runKernelJobPlacement(args, 'fg')),
      defineCommand('kill', async (args) => this.runKernelKill(args, 'kill')),
      defineCommand('jobs', async (args) => this.runKernelJobs(args)),
      defineCommand('ls', async (args, ctx) => this.runKernelAwareLs(args, ctx)),
      defineCommand('ps', async (args) => this.runKernelPs(args)),
      defineCommand('tracekernelctl', (args) => this.runTraceKernelCtl(args)),
      defineCommand('wait', (args) => this.runKernelWait(args, 'wait')),
      defineCommand('which', async (args) => this.runTraceKernelWhich(args, 'which')),
      defineCommand('command', async (args) => this.runTraceKernelCommandBuiltin(args)),
      ...(options.customCommands ?? []),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}bg`, async (args) => this.runKernelJobPlacement(args, 'bg')),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}command`, async (args) => this.runTraceKernelCommandBuiltin(args)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}fg`, async (args) => this.runKernelJobPlacement(args, 'fg')),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}kill`, async (args) => this.runKernelKill(args, 'kill')),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}jobs`, async (args) => this.runKernelJobs(args)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}ps`, async (args) => this.runKernelPs(args)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`, (args) => this.runKernelWait(args, 'wait')),
    ].map((command) => this.withKernelCommandSignal(command as CustomCommand));
    this.bashOptions = {
      fs: this.fs,
      cwd: this.cwd,
      env: options.env,
      commands: options.commands as never,
      customCommands: customCommands.length > 0 ? customCommands as never : undefined,
      python: options.python,
      javascript: options.javascript as never,
      executionLimits: options.executionLimits as never,
    };
    this.bash = this.createBash();
  }

  private withKernelCommandSignal(command: CustomCommand): CustomCommand {
    if (isRuntimeCommand(command)) {
      return {
        ...command,
        execute: (args, ctx) => command.execute(args, this.withCurrentKernelSignal(ctx)),
      };
    }
    if (isRuntimeLazyCommand(command)) {
      return {
        ...command,
        load: async () => this.withKernelCommandSignal(await command.load()) as Command,
      };
    }
    return command;
  }

  private withCurrentKernelSignal(ctx: CommandContext): CommandContext {
    const signal = this.currentCommandContext()?.process.abortController?.signal;
    return signal && signal !== ctx.signal ? { ...ctx, signal } : ctx;
  }

  private createBash(executionLimits?: RuntimeCommandExecutionLimits): Bash {
    const bash = new Bash({
      ...this.bashOptions,
      ...(executionLimits ? { executionLimits: executionLimits as never } : {}),
    });
    bash.registerTransformPlugin({
      name: 'tracekernel-command-rewrite',
      transform: ({ ast }: { ast: unknown }) => {
        rewriteTraceKernelBinInvocationsInAst(ast, this.traceKernelCommandNames);
        rewriteKernelShellCommandInvocationsInAst(ast);
        const executableTransformCwd = this.currentCommandContext()?.executableTransformCwd;
        if (this.hasVirtualExecutableLoaders() && executableTransformCwd) {
          rewriteVirtualExecutableInvocationsInAst(
            ast,
            executableTransformCwd,
            this.cwd,
            this.kernelInfo.workspaceAlias,
            this.virtualExecutableRecords
          );
        }
        return { ast };
      },
    } as never);
    return bash;
  }

  private currentCommandContext(): RuntimeCommandExecutionContext | undefined {
    return this.commandExecutionContexts.getStore();
  }

  private currentCommandActor(): RuntimeWorkspaceActor | undefined {
    return this.currentCommandContext()?.actor;
  }

  private currentRuntimeIo(): RuntimeProjectLiveIoController | undefined {
    return this.currentCommandContext()?.runtimeIo;
  }

  private hasHttpCapability(actor: RuntimeWorkspaceActor, capability: keyof NonNullable<RuntimeWorkspaceCapabilities['http']>): boolean {
    return actor.capabilities?.http?.[capability] === true;
  }

  private assertHttpCapability(
    actor: RuntimeWorkspaceActor,
    capability: keyof NonNullable<RuntimeWorkspaceCapabilities['http']>
  ): void {
    if (this.hasHttpCapability(actor, capability)) return;
    throw Object.assign(
      new Error(`EACCES: TraceKernel HTTP ${capability} is not allowed for actor ${actor.kind}:${actor.id}`),
      { code: 'EACCES' }
    );
  }

  private createKernelHttpBridge(): RuntimeKernelHttpBridge {
    const actor = this.currentCommandActor() ?? SYSTEM_ACTOR;
    const context = this.currentCommandContext();
    const owner = context
      ? { pid: context.process.pid, idPrefix: 'http', actor }
      : { pid: 0, idPrefix: 'http-system', actor };
    return {
      listen: (options, handler) => {
        return this.registerHttpListener(options, handler, owner);
      },
      dispatch: (request, options) => this.dispatchHttpRequest(request, { ...options, actor }),
    };
  }

  private listenHttp(
    options: RuntimeKernelHttpListenOptions,
    handler: RuntimeKernelHttpHandler
  ): RuntimeKernelHttpListenerHandle {
    this.assertNotDestroyed();
    return this.registerHttpListener(options, handler, {
      pid: 0,
      idPrefix: 'http-system',
      actor: PRINCIPAL_ACTOR,
    });
  }

  private async requestHttp(options: RuntimeWorkspaceHttpRequestOptions): Promise<RuntimeKernelHttpResponse> {
    this.assertNotDestroyed();
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      return { status: 400, body: `TraceKernel HTTP URL rejected: ${options.url}\n` };
    }
    return this.dispatchHttpRequest({
      method: String(options.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      path: options.path ?? `${url.pathname}${url.search}`,
      headers: options.headers ?? {},
      ...(options.rawHeaders ? { rawHeaders: options.rawHeaders } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.bodyEncoding ? { bodyEncoding: options.bodyEncoding } : {}),
    }, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      actor: PRINCIPAL_ACTOR,
    });
  }

  private async requestHttpJson<T = unknown>(
    options: RuntimeWorkspaceHttpJsonRequestOptions
  ): Promise<RuntimeWorkspaceHttpJsonResponse<T>> {
    const { body, ...requestOptions } = options;
    const headers = { ...(options.headers ?? {}) };
    const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
    const hasAccept = Object.keys(headers).some((name) => name.toLowerCase() === 'accept');
    if (!hasContentType && body !== undefined) headers['content-type'] = 'application/json';
    if (!hasAccept) headers.accept = 'application/json';
    const response = await this.requestHttp({
      ...requestOptions,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = runtimeHttpBodyText(response);
    return {
      ...response,
      text,
      json: text ? JSON.parse(text) as T : null as T,
    };
  }

  private sanitizeHttpDiagnosticField(value: unknown): string {
    const text = String(value ?? '');
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    return escaped.length > TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH
      ? `${escaped.slice(0, TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH)}...`
      : escaped;
  }

  private normalizeHttpHost(host: string, kind: 'connect' | 'listen'): string {
    if (host.length > 253 || /[\u0000-\u0020\u007f]/.test(host)) {
      throw Object.assign(new Error(`EADDRNOTAVAIL: invalid ${kind} host '${this.sanitizeHttpDiagnosticField(host)}'`), {
        code: 'EADDRNOTAVAIL',
      });
    }
    return host;
  }

  private normalizeHttpMethod(method: unknown): string {
    const normalized = String(method ?? 'GET').toUpperCase();
    if (!/^[A-Z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(normalized)) {
      throw Object.assign(new Error(`EINVAL: invalid HTTP method '${this.sanitizeHttpDiagnosticField(normalized)}'`), {
        code: 'EINVAL',
      });
    }
    return normalized;
  }

  private normalizeHttpHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined;
    const entries = Object.entries(headers);
    if (entries.length > TRACEKERNEL_HTTP_MAX_HEADER_COUNT) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel HTTP header count limit exceeded'), { code: 'EMSGSIZE' });
    }
    let headerBytes = 0;
    const normalized: Record<string, string> = {};
    for (const [name, value] of entries) {
      const key = String(name).toLowerCase();
      const text = String(value);
      if (!/^[a-z0-9!#$%&'*+\-.^_`|~]{1,128}$/.test(key) || /[\r\n\u0000]/.test(text)) {
        throw Object.assign(new Error(`EINVAL: invalid HTTP header '${this.sanitizeHttpDiagnosticField(name)}'`), {
          code: 'EINVAL',
        });
      }
      headerBytes += key.length + text.length;
      if (headerBytes > TRACEKERNEL_HTTP_MAX_HEADER_BYTES) {
        throw Object.assign(new Error('EMSGSIZE: TraceKernel HTTP header byte limit exceeded'), { code: 'EMSGSIZE' });
      }
      normalized[key] = text;
    }
    return normalized;
  }

  private httpHeadersFromRawHeaders(rawHeaders: readonly [string, string][]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of rawHeaders) {
      headers[String(name).toLowerCase()] = String(value);
    }
    return headers;
  }

  private normalizeHttpRawHeaders(
    rawHeaders: readonly [string, string][] | undefined
  ): readonly [string, string][] | undefined {
    if (!rawHeaders) return undefined;
    if (rawHeaders.length > TRACEKERNEL_HTTP_MAX_HEADER_COUNT) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel HTTP raw header count limit exceeded'), { code: 'EMSGSIZE' });
    }
    let headerBytes = 0;
    const normalized: [string, string][] = [];
    for (const entry of rawHeaders) {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw Object.assign(new Error('EINVAL: invalid HTTP raw header entry'), { code: 'EINVAL' });
      }
      const [name, value] = entry;
      const key = String(name);
      const text = String(value);
      if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,128}$/.test(key) || /[\r\n\u0000]/.test(text)) {
        throw Object.assign(new Error(`EINVAL: invalid HTTP raw header '${this.sanitizeHttpDiagnosticField(name)}'`), {
          code: 'EINVAL',
        });
      }
      headerBytes += key.length + text.length;
      if (headerBytes > TRACEKERNEL_HTTP_MAX_HEADER_BYTES) {
        throw Object.assign(new Error('EMSGSIZE: TraceKernel HTTP raw header byte limit exceeded'), { code: 'EMSGSIZE' });
      }
      normalized.push([key, text]);
    }
    return normalized;
  }

  private normalizeHttpRequestPath(path: unknown, url: URL): string {
    const fallback = `${url.pathname || '/'}${url.search}`;
    const normalized = String(path ?? fallback) || fallback;
    if (!normalized.startsWith('/') || normalized.length > 8192 || /[\r\n\u0000]/.test(normalized)) {
      throw Object.assign(new Error(`EINVAL: invalid HTTP request path '${this.sanitizeHttpDiagnosticField(normalized)}'`), {
        code: 'EINVAL',
      });
    }
    return normalized;
  }

  private assertHttpBodyLimit(message: RuntimeKernelHttpBodyPayload, direction: 'request' | 'response'): void {
    let bytes: Uint8Array;
    try {
      bytes = runtimeHttpBodyBytes(message);
    } catch {
      throw Object.assign(new Error(`EINVAL: invalid TraceKernel HTTP ${direction} body encoding`), { code: 'EINVAL' });
    }
    if (bytes.byteLength > TRACEKERNEL_HTTP_MAX_BODY_BYTES) {
      throw Object.assign(new Error(`EMSGSIZE: TraceKernel HTTP ${direction} body limit exceeded`), { code: 'EMSGSIZE' });
    }
  }

  private normalizeHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequest {
    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      throw Object.assign(new Error('EINVAL: invalid TraceKernel HTTP request URL'), { code: 'EINVAL' });
    }
    const rawHeaders = this.normalizeHttpRawHeaders(request.rawHeaders);
    const explicitHeaders = this.normalizeHttpHeaders(request.headers);
    const headers = explicitHeaders ?? (rawHeaders ? this.httpHeadersFromRawHeaders(rawHeaders) : undefined);
    const normalized: RuntimeKernelHttpRequest = {
      method: this.normalizeHttpMethod(request.method),
      url: url.toString(),
      path: this.normalizeHttpRequestPath(request.path, url),
    };
    if (headers) normalized.headers = headers;
    if (explicitHeaders) {
      normalized.rawHeaders = Object.entries(explicitHeaders);
    } else if (rawHeaders) {
      normalized.rawHeaders = rawHeaders;
    }
    if (request.body !== undefined) normalized.body = String(request.body);
    if (request.bodyEncoding) normalized.bodyEncoding = request.bodyEncoding;
    if (request.signal) normalized.signal = request.signal;
    this.assertHttpBodyLimit(normalized, 'request');
    return normalized;
  }

  private normalizeHttpResponse(response: RuntimeKernelHttpResponse): RuntimeKernelHttpResponse {
    const status = Math.trunc(Number(response.status));
    if (!Number.isFinite(status) || status < 100 || status > 599) {
      throw Object.assign(new Error(`EINVAL: invalid TraceKernel HTTP response status '${response.status}'`), {
        code: 'EINVAL',
      });
    }
    const normalized: RuntimeKernelHttpResponse = { status };
    const rawHeaders = this.normalizeHttpRawHeaders(response.rawHeaders);
    const headers = rawHeaders
      ? this.httpHeadersFromRawHeaders(rawHeaders)
      : this.normalizeHttpHeaders(response.headers);
    if (headers) normalized.headers = headers;
    if (rawHeaders) {
      normalized.rawHeaders = rawHeaders;
    } else if (headers) {
      normalized.rawHeaders = Object.entries(headers);
    }
    if (response.body !== undefined) normalized.body = String(response.body);
    if (response.bodyEncoding) normalized.bodyEncoding = response.bodyEncoding;
    this.assertHttpBodyLimit(normalized, 'response');
    return normalized;
  }

  private normalizeHttpConnectHost(host: string | undefined): string {
    const normalized = (host ?? '127.0.0.1').trim().toLowerCase();
    if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '*') return '127.0.0.1';
    if (normalized === 'localhost') return '127.0.0.1';
    return this.normalizeHttpHost(normalized, 'connect');
  }

  private normalizeHttpListenHost(host: string | undefined, actor: RuntimeWorkspaceActor): string {
    const defaultHost = actor.kind === 'runtime' ? '127.0.0.1' : '0.0.0.0';
    const normalized = (host ?? defaultHost).trim().toLowerCase();
    if (!normalized) return defaultHost;
    if (normalized === '::' || normalized === '*') {
      if (actor.kind === 'runtime') {
        throw Object.assign(new Error('EACCES: TraceKernel HTTP wildcard listen is not allowed for runtime actors'), {
          code: 'EACCES',
        });
      }
      return '0.0.0.0';
    }
    if (normalized === 'localhost') return '127.0.0.1';
    if (this.isHttpWildcardHost(normalized) && actor.kind === 'runtime') {
      throw Object.assign(new Error('EACCES: TraceKernel HTTP wildcard listen is not allowed for runtime actors'), {
        code: 'EACCES',
      });
    }
    return this.normalizeHttpHost(normalized, 'listen');
  }

  private isHttpWildcardHost(host: string): boolean {
    return host === '0.0.0.0';
  }

  private normalizeHttpConnectPort(port: number): number {
    const normalized = Math.trunc(Number(port));
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 65535) {
      throw Object.assign(new Error(`EADDRNOTAVAIL: invalid port '${port}'`), { code: 'EADDRNOTAVAIL' });
    }
    return normalized;
  }

  private normalizeHttpListenPort(port: number): number {
    const normalized = Math.trunc(Number(port));
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 65535) {
      throw Object.assign(new Error(`EADDRNOTAVAIL: invalid port '${port}'`), { code: 'EADDRNOTAVAIL' });
    }
    if (normalized !== 0) return normalized;
    for (let attempt = 0; attempt < 16384; attempt += 1) {
      const candidate = this.nextEphemeralHttpPort;
      this.nextEphemeralHttpPort += 1;
      if (this.nextEphemeralHttpPort > 65535) this.nextEphemeralHttpPort = 49152;
      if (!this.hasHttpListenerOnPort(candidate, 'http')) return candidate;
    }
    throw Object.assign(new Error('EADDRNOTAVAIL: no ephemeral TraceKernel HTTP ports available'), { code: 'EADDRNOTAVAIL' });
  }

  private httpListenerKey(host: string, port: number, protocol: 'http'): string {
    return `${protocol}:${host}:${port}`;
  }

  private hasHttpListenerOnPort(port: number, protocol: 'http'): boolean {
    for (const listener of this.httpListeners.values()) {
      if (listener.info.protocol === protocol && listener.info.port === port) return true;
    }
    return false;
  }

  private findHttpBindConflict(host: string, port: number, protocol: 'http'): RuntimeKernelHttpListenerRecord | undefined {
    for (const listener of this.httpListeners.values()) {
      if (listener.info.protocol !== protocol || listener.info.port !== port) continue;
      if (
        listener.info.host === host ||
        this.isHttpWildcardHost(listener.info.host) ||
        this.isHttpWildcardHost(host)
      ) {
        return listener;
      }
    }
    return undefined;
  }

  private registerHttpListener(
    options: RuntimeKernelHttpListenOptions,
    handler: RuntimeKernelHttpHandler,
    owner?: RuntimeKernelHttpListenerOwner
  ): RuntimeKernelHttpListenerHandle {
    const context = this.currentCommandContext();
    const actor = owner?.actor ?? context?.actor ?? SYSTEM_ACTOR;
    this.assertHttpCapability(actor, 'listen');
    const listenerOwner = owner ?? (context
      ? { pid: context.process.pid, idPrefix: 'http', actor }
      : undefined);
    if (!listenerOwner) {
      throw Object.assign(new Error('EINVAL: listen requires an active tracekernel process'), { code: 'EINVAL' });
    }
    const protocol = options.protocol ?? 'http';
    if (protocol !== 'http') {
      throw Object.assign(new Error(`EPROTONOSUPPORT: unsupported TraceKernel HTTP protocol '${protocol}'`), {
        code: 'EPROTONOSUPPORT',
      });
    }
    const host = this.normalizeHttpListenHost(options.host, actor);
    const port = this.normalizeHttpListenPort(options.port);
    const key = this.httpListenerKey(host, port, protocol);
    if (!this.httpListeners.has(key) && this.httpListeners.size >= TRACEKERNEL_HTTP_LISTENER_LIMIT) {
      throw Object.assign(new Error('EAGAIN: TraceKernel HTTP listener limit reached'), { code: 'EAGAIN' });
    }
    if (this.findHttpBindConflict(host, port, protocol)) {
      throw Object.assign(new Error(`EADDRINUSE: address already in use ${host}:${port}`), { code: 'EADDRINUSE' });
    }
    const info: RuntimeKernelHttpListenerInfo = {
      id: `${listenerOwner.idPrefix}-${this.nextHttpListenerSeq++}`,
      pid: listenerOwner.pid,
      host,
      port,
      protocol,
      startedAt: new Date().toISOString(),
    };
    this.httpListeners.set(key, { info, handler, actor });
    this.recordKernelEvent('net-listen', listenerOwner.pid, { id: info.id, protocol, host, port });
    let closed = false;
    return {
      id: info.id,
      info,
      close: () => {
        if (closed) return;
        closed = true;
        const current = this.httpListeners.get(key);
        if (current?.info.id === info.id) {
          this.httpListeners.delete(key);
          this.recordKernelEvent('net-close', info.pid, { id: info.id, protocol, host, port });
        }
      },
    };
  }

  private closeHttpListenersForProcess(pid: number): void {
    for (const [key, listener] of this.httpListeners) {
      if (listener.info.pid !== pid) continue;
      this.httpListeners.delete(key);
      this.recordKernelEvent('net-close', pid, {
        id: listener.info.id,
        protocol: listener.info.protocol,
        host: listener.info.host,
        port: listener.info.port,
      });
    }
  }

  private findHttpListener(url: URL): RuntimeKernelHttpListenerRecord | undefined {
    if (url.protocol !== 'http:') return undefined;
    const host = this.normalizeHttpConnectHost(url.hostname);
    const port = this.normalizeHttpConnectPort(url.port ? Number(url.port) : 80);
    return this.httpListeners.get(this.httpListenerKey(host, port, 'http')) ??
      this.httpListeners.get(this.httpListenerKey('0.0.0.0', port, 'http'));
  }

  private recordHttpRequest(entry: Omit<RuntimeKernelHttpRequestRecord, 'seq' | 'time'>): void {
    this.httpRequestLog.push({
      seq: this.nextHttpRequestSeq++,
      time: new Date().toISOString(),
      ...entry,
      url: redactRuntimeDiagnosticUrl(entry.url),
    });
    if (this.httpRequestLog.length > TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT) {
      this.httpRequestLog.splice(0, this.httpRequestLog.length - TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT);
    }
  }

  private httpListenerErrorBody(
    listener: RuntimeKernelHttpListenerRecord,
    requester: RuntimeWorkspaceActor,
    message: string
  ): string {
    if (requester.kind === 'runtime' && listener.actor.kind !== 'runtime') {
      return 'TraceKernel HTTP listener failed\n';
    }
    return `${message}\n`;
  }

  private async dispatchHttpRequest(
    request: RuntimeKernelHttpRequest,
    options: RuntimeKernelHttpDispatchOptions & {
      timeoutBody?: string;
      actor?: RuntimeWorkspaceActor;
    } = {}
  ): Promise<RuntimeKernelHttpResponse> {
    const actor = options.actor ?? this.currentCommandActor() ?? SYSTEM_ACTOR;
    try {
      this.assertHttpCapability(actor, 'dispatch');
    } catch (error) {
      return { status: 403, body: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    let normalizedRequest: RuntimeKernelHttpRequest;
    try {
      normalizedRequest = this.normalizeHttpRequest(request);
    } catch (error) {
      return { status: 400, body: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    let url: URL;
    try {
      url = new URL(normalizedRequest.url);
    } catch {
      return { status: 400, body: 'curl: invalid URL\n' };
    }
    let listener: RuntimeKernelHttpListenerRecord | undefined;
    try {
      listener = this.findHttpListener(url);
    } catch (error) {
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 400, body: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    if (!listener) {
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'ECONNREFUSED',
      });
      return { status: 0, body: `curl: (7) Failed to connect to ${url.hostname} port ${url.port || '80'}: Connection refused\n` };
    }
    if (this.activeHttpRequests >= TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS) {
      this.recordHttpRequest({
        listenerId: listener.info.id,
        pid: listener.info.pid,
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EAGAIN',
      });
      return { status: 503, body: 'TraceKernel HTTP request limit reached\n' };
    }
    const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return { status: 400, body: `TraceKernel HTTP timeout rejected: ${options.timeoutMs}\n` };
    }
    const signal = options.signal;
    if (signal?.aborted) {
      this.recordHttpRequest({
        listenerId: listener.info.id,
        pid: listener.info.pid,
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EINTR',
      });
      return { status: 0, body: 'TraceKernel HTTP request aborted\n' };
    }

    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const requestAbortController = new AbortController();
    const abortHandlerRequest = (): void => {
      if (!requestAbortController.signal.aborted) requestAbortController.abort();
    };
    const settleFailure = (error: string, body: string): RuntimeKernelHttpResponse => {
      if (!settled) {
        settled = true;
        this.recordHttpRequest({
          listenerId: listener.info.id,
          pid: listener.info.pid,
          method: normalizedRequest.method,
          url: normalizedRequest.url,
          error,
        });
      }
      return { status: 0, body };
    };
    this.activeHttpRequests += 1;
    const handlerResponse = (async (): Promise<RuntimeKernelHttpResponse> => {
      try {
        const response = this.normalizeHttpResponse(await listener.handler({
          ...normalizedRequest,
          signal: requestAbortController.signal,
        }));
        const status = response.status;
        if (!settled) {
          this.recordHttpRequest({
            listenerId: listener.info.id,
            pid: listener.info.pid,
            method: normalizedRequest.method,
            url: normalizedRequest.url,
            status,
          });
          this.recordKernelEvent('net-request', listener.info.pid, {
            id: listener.info.id,
            method: normalizedRequest.method,
            url: redactRuntimeDiagnosticUrl(normalizedRequest.url),
            status,
          });
        }
        return {
          status,
          ...(response.headers ? { headers: response.headers } : {}),
          ...(response.rawHeaders ? { rawHeaders: response.rawHeaders } : {}),
          ...(response.body !== undefined ? { body: response.body } : {}),
          ...(response.bodyEncoding ? { bodyEncoding: response.bodyEncoding } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!settled) {
          this.recordHttpRequest({
            listenerId: listener.info.id,
            pid: listener.info.pid,
            method: normalizedRequest.method,
            url: normalizedRequest.url,
            error: message,
          });
        }
        return { status: 500, body: this.httpListenerErrorBody(listener, actor, message) };
      } finally {
        this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
      }
    })();

    const races: Array<Promise<RuntimeKernelHttpResponse>> = [handlerResponse];
    if (timeoutMs !== undefined) {
      races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
        timeoutHandle = setTimeout(() => {
          abortHandlerRequest();
          resolve(settleFailure(
            'ETIMEDOUT',
            options.timeoutBody ?? `TraceKernel HTTP request timed out after ${timeoutMs} milliseconds\n`
          ));
        }, timeoutMs);
      }));
    }
    if (signal) {
      races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
        abortListener = () => {
          abortHandlerRequest();
          resolve(settleFailure('EINTR', 'TraceKernel HTTP request aborted\n'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }));
    }

    try {
      const response = await Promise.race(races);
      settled = true;
      return response;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
  }

  recordKernelCommandError(error: unknown): void {
    const commandError = runtimeCommandError(error);
    const context = this.currentCommandContext();
    if (commandError && context) context.kernelError = commandError;
  }

  private createDynamicProcProvider(): RuntimeDynamicProcProvider {
    return {
      readFile: (path) => this.readDynamicVirtualFile(path),
      readDir: (path) => this.readDynamicVirtualDir(path),
      entryKind: (path) => this.dynamicVirtualEntryKind(path),
      stat: (path) => this.dynamicVirtualStat(path),
      readonlyNamespace: (path) =>
        Boolean(normalizeRuntimeProcPath(path)) ||
        isTraceKernelVirtualNamespacePath(path) ||
        isRuntimeSkillsNamespacePath(path),
    };
  }

  private principalProcessRecord(): RuntimeKernelProcessRecord {
    return {
      pid: 1,
      ppid: 0,
      pgid: 1,
      sid: 1,
      fds: this.standardProcessFileDescriptors(),
      tty: '/dev/tty',
      command: 'tracekernel',
      cwd: this.cwd,
      actor: SYSTEM_ACTOR,
      startedAt: this.projectSession?.lifecycle.createdAt ?? new Date(0).toISOString(),
      state: 'running',
      foreground: true,
    };
  }

  private currentProcSelfRecord(): RuntimeKernelProcessRecord {
    return this.currentCommandContext()?.process ?? this.principalProcessRecord();
  }

  private standardProcessFileDescriptors(): readonly RuntimeKernelFileDescriptorRecord[] {
    return [
      { fd: 0, target: '/dev/stdin', flags: 'r' },
      { fd: 1, target: '/dev/stdout', flags: 'w' },
      { fd: 2, target: '/dev/stderr', flags: 'w' },
    ];
  }

  private purgeZombieProcessTable(nowMs = Date.now()): void {
    for (const [pid, zombie] of this.zombieProcessTable) {
      if (zombie.expiresAtMs <= nowMs) this.zombieProcessTable.delete(pid);
    }
  }

  private findProcessRecord(pid: number): RuntimeKernelProcessRecord | undefined {
    this.purgeZombieProcessTable();
    return this.processTable.get(pid) ?? this.zombieProcessTable.get(pid)?.process;
  }

  private activeProcessRecords(): RuntimeKernelProcessRecord[] {
    this.purgeZombieProcessTable();
    return [
      ...this.processTable.values(),
      ...[...this.zombieProcessTable.values()].map((zombie) => zombie.process),
    ]
      .filter((process) => process.state !== 'exited')
      .sort((left, right) => left.pid - right.pid);
  }

  private recordKernelEvent(type: string, pid?: number, detail?: Record<string, unknown>): void {
    this.kernelEventLog.push({
      seq: this.nextKernelEventSeq++,
      time: new Date().toISOString(),
      type,
      ...(pid !== undefined ? { pid } : {}),
      ...(detail ? { detail } : {}),
    });
    if (this.kernelEventLog.length > TRACEKERNEL_EVENT_LOG_LIMIT) {
      this.kernelEventLog.splice(0, this.kernelEventLog.length - TRACEKERNEL_EVENT_LOG_LIMIT);
    }
  }

  private firstZombieProcessRecord(): RuntimeKernelProcessRecord | undefined {
    this.purgeZombieProcessTable();
    return [...this.zombieProcessTable.values()]
      .map((zombie) => zombie.process)
      .sort((left, right) => left.pid - right.pid)[0];
  }

  private signalCommandError(process: RuntimeKernelProcessRecord): RuntimeCommandError | undefined {
    if (!process.signal) return undefined;
    const message = `EINTR: interrupted system call, wait4 '${process.pid}'`;
    return {
      code: 'EINTR',
      errno: 4,
      syscall: 'wait4',
      path: String(process.pid),
      message,
      detail: {
        pid: process.pid,
        signal: process.signal,
        ...(process.signalCode !== undefined ? { signalCode: process.signalCode } : {}),
      },
    };
  }

  private signalCommandResult(process: RuntimeKernelProcessRecord): RuntimeCommandResult {
    const error = this.signalCommandError(process);
    return {
      stdout: '',
      stderr: error ? `${error.message}\n` : '',
      exitCode: 128 + (process.signalCode ?? 15),
      ...(error ? { error } : {}),
    };
  }

  private signalProcess(process: RuntimeKernelProcessRecord, signalName = 'SIGTERM'): boolean {
    const signal = normalizeTraceKernelSignal(signalName);
    if (!signal || process.state === 'exited') return false;
    process.signal = signal.name;
    process.signalCode = signal.code;
    process.state = 'signaled';
    this.recordKernelEvent('process-signal', process.pid, { signal: signal.name, signalCode: signal.code });
    if (!process.abortController?.signal.aborted) {
      process.abortController?.abort({ signal: signal.name, signalCode: signal.code, pid: process.pid });
    }
    return true;
  }

  private signalProcessGroup(pgid: number, signalName = 'SIGTERM'): number {
    const currentPid = this.currentCommandContext()?.process.pid;
    let signaled = 0;
    for (const process of this.activeProcessRecords()) {
      if (process.pgid !== pgid || process.pid === currentPid || process.pid === 1 || process.state === 'exited') continue;
      if (this.signalProcess(process, signalName)) signaled += 1;
    }
    if (signaled > 0) this.recordKernelEvent('process-group-signal', undefined, { pgid, signal: normalizeTraceKernelSignal(signalName)?.name, count: signaled });
    return signaled;
  }

  private setProcessGroupForeground(pgid: number, foreground: boolean): void {
    for (const process of this.activeProcessRecords()) {
      if (process.pgid !== pgid || process.pid === 1 || process.state === 'exited') continue;
      process.foreground = foreground;
      process.tty = foreground ? '/dev/tty' : '?';
    }
  }

  private async reapZombieProcess(pid?: number, commandName = 'tracekernelctl'): Promise<RuntimeCommandResult> {
    const process = await this.waitForZombieProcess(pid);
    if (!process) {
      return { stdout: '', stderr: `${commandName}: no child process${pid === undefined ? '' : `: ${pid}`}\n`, exitCode: 10 };
    }
    this.zombieProcessTable.delete(process.pid);
    process.state = 'exited';
    this.recordKernelEvent('process-reap', process.pid, { exitCode: process.exitCode ?? 0, signal: process.signal });
    return {
      stdout: [
        `pid\t${process.pid}`,
        `exitCode\t${process.exitCode ?? 0}`,
        ...(process.signal ? [`signal\t${process.signal}`] : []),
        ...(process.signalCode !== undefined ? [`signalCode\t${process.signalCode}`] : []),
      ].join('\n') + '\n',
      stderr: '',
      exitCode: process.exitCode ?? 0,
    };
  }

  private waitForZombieProcess(pid?: number): Promise<RuntimeKernelProcessRecord | undefined> {
    this.purgeZombieProcessTable();
    const currentPid = this.currentCommandContext()?.process.pid;
    const zombie = pid === undefined ? this.firstZombieProcessRecord() : this.zombieProcessTable.get(pid)?.process;
    if (zombie?.state === 'zombie') return Promise.resolve(zombie);
    if (pid !== undefined && (pid === currentPid || !this.processTable.has(pid))) return Promise.resolve(undefined);
    if (pid === undefined && ![...this.processTable.keys()].some((activePid) => activePid !== currentPid)) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      if (pid === undefined) {
        this.anyProcessWaiters.push(resolve);
        return;
      }
      const waiters = this.processWaiters.get(pid) ?? [];
      waiters.push(resolve);
      this.processWaiters.set(pid, waiters);
    });
  }

  private notifyZombieProcess(process: RuntimeKernelProcessRecord): void {
    const waiters = this.processWaiters.get(process.pid) ?? [];
    this.processWaiters.delete(process.pid);
    const anyWaiters = this.anyProcessWaiters.splice(0);
    for (const waiter of [...waiters, ...anyWaiters]) {
      waiter(process);
    }
  }

  private attachExternalSignal(process: RuntimeKernelProcessRecord, signal: AbortSignal | undefined): (() => void) | undefined {
    if (!signal) return undefined;
    const abort = () => {
      this.signalProcess(process, 'SIGTERM');
    };
    if (signal.aborted) {
      abort();
      return undefined;
    }
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  private traceKernelCommandInfo(nameOrPath: string): TraceKernelCommandInfo | undefined {
    const commandName = traceKernelBinCommandName(nameOrPath) ?? nameOrPath;
    return this.traceKernelCommandRegistry.find((command) => command.name === commandName);
  }

  private renderTraceKernelBinCommand(info: TraceKernelCommandInfo): string {
    return JSON.stringify({
      schema: 'tracekernel.command.v1',
      name: info.name,
      path: info.path,
      kind: info.kind,
      available: info.available,
      adapter: info.adapter,
      ...(info.language ? { language: info.language } : {}),
      ...(info.displayName ? { displayName: info.displayName } : {}),
      ...(info.versionLabel ? { versionLabel: info.versionLabel } : {}),
      ...(info.description ? { description: info.description } : {}),
    }, null, 2) + '\n';
  }

  private readDynamicTraceKernelFile(path: string): string | null {
    const commandName = traceKernelBinCommandName(path);
    if (!commandName) return null;
    const info = this.traceKernelCommandInfo(commandName);
    return info ? this.renderTraceKernelBinCommand(info) : null;
  }

  private readDynamicTraceKernelDir(path: string): RuntimeDynamicProcEntry[] | null {
    const normalized = normalizeTraceKernelVirtualPath(path);
    if (normalized === '/tracekernel') return [{ name: 'bin', kind: 'directory' }];
    if (normalized === TRACEKERNEL_BIN_PATH) {
      return this.traceKernelCommandRegistry.map((command) => ({ name: command.name, kind: 'file' as const }));
    }
    return null;
  }

  private dynamicTraceKernelEntryKind(path: string): 'file' | 'directory' | null {
    if (this.readDynamicTraceKernelDir(path)) return 'directory';
    return this.readDynamicTraceKernelFile(path) !== null ? 'file' : null;
  }

  private dynamicTraceKernelStat(path: string): RuntimeKernelVirtualStat | null {
    const kind = this.dynamicTraceKernelEntryKind(path);
    if (!kind) return null;
    const content = kind === 'file' ? this.readDynamicTraceKernelFile(path) ?? '' : '';
    return {
      isFile: kind === 'file',
      isDirectory: kind === 'directory',
      isCharacterDevice: false,
      mode: 0o555,
      size: new TextEncoder().encode(content).byteLength,
      uid: 0,
      gid: 0,
      owner: 'root',
      group: 'root',
    };
  }

  private normalizeSkillFile(file: RuntimeFile): RuntimeFile {
    const normalizedEncoding = assertSupportedEncoding(file.encoding);
    return {
      path: normalizeRuntimeSkillPath(file.path),
      contents: file.contents,
      ...(normalizedEncoding === 'base64' ? { encoding: normalizedEncoding } : {}),
    };
  }

  private skillFileContent(file: RuntimeFile): string {
    return (file.encoding ?? 'utf8') === 'base64'
      ? contentToText(bytesFromBase64(file.contents))
      : file.contents;
  }

  private skillRelativePathFromVirtualPath(path: string): string | null {
    const normalized = normalizeRuntimeSkillsVirtualPath(path);
    if (!normalized || normalized === TRACEKERNEL_SKILLS_ROOT) return null;
    return normalizeRuntimeSkillPath(normalized.slice(TRACEKERNEL_SKILLS_ROOT.length + 1));
  }

  private readDynamicSkillsFile(path: string): string | null {
    const relativePath = this.skillRelativePathFromVirtualPath(path);
    if (!relativePath) return null;
    const file = this.skillFiles.get(relativePath);
    return file ? this.skillFileContent(file) : null;
  }

  private readDynamicSkillsDir(path: string): RuntimeDynamicProcEntry[] | null {
    const normalized = normalizeRuntimeSkillsVirtualPath(path);
    if (!normalized) return null;
    const directoryPath = normalized === TRACEKERNEL_SKILLS_ROOT
      ? ''
      : normalizeRuntimeSkillPath(normalized.slice(TRACEKERNEL_SKILLS_ROOT.length + 1));
    const prefix = directoryPath ? `${directoryPath}/` : '';
    const entries = new Map<string, RuntimeDynamicProcEntry>();
    for (const skillPath of this.skillFiles.keys()) {
      if (directoryPath && skillPath === directoryPath) continue;
      if (!skillPath.startsWith(prefix)) continue;
      const remainder = skillPath.slice(prefix.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split('/');
      if (!name) continue;
      entries.set(name, { name, kind: rest.length > 0 ? 'directory' : 'file' });
    }
    if (normalized === TRACEKERNEL_SKILLS_ROOT) {
      return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
    }
    return entries.size > 0
      ? [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
      : null;
  }

  private dynamicSkillsEntryKind(path: string): 'file' | 'directory' | null {
    if (this.readDynamicSkillsDir(path)) return 'directory';
    return this.readDynamicSkillsFile(path) !== null ? 'file' : null;
  }

  private dynamicSkillsStat(path: string): RuntimeKernelVirtualStat | null {
    const kind = this.dynamicSkillsEntryKind(path);
    if (!kind) return null;
    const content = kind === 'file' ? this.readDynamicSkillsFile(path) ?? '' : '';
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

  private readDynamicVirtualFile(path: string): string | null {
    const skillFile = this.readDynamicSkillsFile(path);
    if (skillFile !== null) return skillFile;
    const traceKernelFile = this.readDynamicTraceKernelFile(path);
    if (traceKernelFile !== null) return traceKernelFile;
    return this.readDynamicProcFile(path);
  }

  private readDynamicVirtualDir(path: string): RuntimeDynamicProcEntry[] | null {
    return this.readDynamicSkillsDir(path) ?? this.readDynamicTraceKernelDir(path) ?? this.readDynamicProcDir(path);
  }

  private dynamicVirtualEntryKind(path: string): 'file' | 'directory' | null {
    return this.dynamicSkillsEntryKind(path) ?? this.dynamicTraceKernelEntryKind(path) ?? this.dynamicProcEntryKind(path);
  }

  private dynamicVirtualStat(path: string): RuntimeKernelVirtualStat | null {
    return this.dynamicSkillsStat(path) ?? this.dynamicTraceKernelStat(path) ?? this.dynamicProcStat(path);
  }

  private readDynamicProcFile(path: string): string | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc/self/status') return this.renderProcStatus(this.currentProcSelfRecord());
    if (procPath === '/proc/self/cmdline') return `${this.currentProcSelfRecord().command}\0`;
    {
      const selfFd = procPath.match(/^\/proc\/self\/fd\/([0-9]+)$/);
      if (selfFd) return this.renderProcFd(this.currentProcSelfRecord(), Number(selfFd[1]));
      const selfFdInfo = procPath.match(/^\/proc\/self\/fdinfo\/([0-9]+)$/);
      if (selfFdInfo) return this.renderProcFdInfo(this.currentProcSelfRecord(), Number(selfFdInfo[1]));
    }
    if (procPath === '/proc/tracekernel/commands') return this.renderProcCommands();
    if (procPath === '/proc/tracekernel/events') return this.renderProcEvents();
    if (procPath === '/proc/tracekernel/inodes') return this.fs.renderInodes();
    if (procPath === '/proc/tracekernel/locks') return this.renderProcLocks();
    if (procPath === '/proc/tracekernel/net/listeners') return this.renderProcHttpListeners();
    if (procPath === '/proc/tracekernel/net/requests') return this.renderProcHttpRequests();
    if (procPath === '/proc/tracekernel/processes') return this.renderProcProcesses();
    if (procPath === '/proc/tracekernel/runtimes') return this.renderProcRuntimes();
    if (procPath === '/proc/tracekernel/sched') return this.renderProcScheduler();

    const match = procPath.match(/^\/proc\/([1-9][0-9]*)\/(status|cmdline|fd\/[0-9]+|fdinfo\/[0-9]+)$/);
    if (!match) return null;
    const process = this.findProcessRecord(Number(match[1]));
    if (!process || process.state === 'exited') return null;
    const file = match[2];
    if (file === 'status') return this.renderProcStatus(process);
    if (file === 'cmdline') return `${process.command}\0`;
    const fd = Number(file.split('/')[1]);
    return file.startsWith('fdinfo/') ? this.renderProcFdInfo(process, fd) : this.renderProcFd(process, fd);
  }

  private readDynamicProcDir(path: string): RuntimeDynamicProcEntry[] | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc') {
      return [
        { name: 'kernel', kind: 'directory' },
        { name: 'self', kind: 'directory' },
        { name: 'tracekernel', kind: 'directory' },
        ...this.activeProcessRecords().map((process) => ({ name: String(process.pid), kind: 'directory' as const })),
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
    if (procPath === '/proc/self/fd') {
      return this.currentProcSelfRecord().fds.map((fd) => ({ name: String(fd.fd), kind: 'file' as const }));
    }
    if (procPath === '/proc/self/fdinfo') {
      return this.currentProcSelfRecord().fds.map((fd) => ({ name: String(fd.fd), kind: 'file' as const }));
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
    const fdDirMatch = procPath.match(/^\/proc\/([1-9][0-9]*)\/(fd|fdinfo)$/);
    if (fdDirMatch) {
      const process = this.findProcessRecord(Number(fdDirMatch[1]));
      if (!process || process.state === 'exited') return null;
      return process.fds.map((fd) => ({ name: String(fd.fd), kind: 'file' as const }));
    }
    const match = procPath.match(/^\/proc\/([1-9][0-9]*)$/);
    if (!match) return null;
    const process = this.findProcessRecord(Number(match[1]));
    if (!process || process.state === 'exited') return null;
    return [
      { name: 'cmdline', kind: 'file' },
      { name: 'fd', kind: 'directory' },
      { name: 'fdinfo', kind: 'directory' },
      { name: 'status', kind: 'file' },
    ];
  }

  private dynamicProcEntryKind(path: string): 'file' | 'directory' | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (this.readDynamicProcDir(procPath)) return 'directory';
    return this.readDynamicProcFile(procPath) !== null ? 'file' : null;
  }

  private dynamicProcStat(path: string): RuntimeKernelVirtualStat | null {
    const kind = this.dynamicProcEntryKind(path);
    if (!kind) return null;
    const content = kind === 'file' ? this.readDynamicProcFile(path) ?? '' : '';
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

  private renderProcStatus(process: RuntimeKernelProcessRecord): string {
    const state =
      process.state === 'queued'
        ? 'S (queued)'
        : process.state === 'running'
        ? 'R (running)'
        : process.state === 'signaled'
          ? 'X (signaled)'
          : process.state === 'zombie'
            ? 'Z (zombie)'
            : 'X (dead)';
    return [
      `Name:\t${process.command.split(/\s+/, 1)[0] || 'tracekernel'}`,
      `State:\t${state}`,
      `Pid:\t${process.pid}`,
      `PPid:\t${process.ppid}`,
      `PGid:\t${process.pgid}`,
      `Sid:\t${process.sid}`,
      `FDSize:\t${process.fds.length}`,
      `Tty:\t${process.tty}`,
      `Foreground:\t${process.foreground ? 1 : 0}`,
      'Uid:\t1000\t1000\t1000\t1000',
      'Gid:\t1000\t1000\t1000\t1000',
      `Cwd:\t${process.cwd}`,
      `Command:\t${process.command}`,
      `Actor:\t${process.actor.kind}:${process.actor.id}`,
      ...(process.signal ? [`Signal:\t${process.signal}`] : []),
      ...(process.signalCode !== undefined ? [`SignalCode:\t${process.signalCode}`] : []),
      `Started:\t${process.startedAt}`,
      ...(process.endedAt ? [`Ended:\t${process.endedAt}`] : []),
      ...(process.exitCode !== undefined ? [`ExitCode:\t${process.exitCode}`] : []),
    ].join('\n') + '\n';
  }

  private renderProcFd(process: RuntimeKernelProcessRecord, fd: number): string | null {
    return process.fds.find((entry) => entry.fd === fd)?.target.concat('\n') ?? null;
  }

  private renderProcFdInfo(process: RuntimeKernelProcessRecord, fd: number): string | null {
    const descriptor = process.fds.find((entry) => entry.fd === fd);
    if (!descriptor) return null;
    return [
      `pos:\t0`,
      `flags:\t${descriptor.flags}`,
      `mnt_id:\tdev`,
      `target:\t${descriptor.target}`,
    ].join('\n') + '\n';
  }

  private renderProcCommands(): string {
    const rows = this.traceKernelCommandRegistry.map((command) => [
      command.name,
      command.path,
      command.kind,
      command.language ?? '',
      command.adapter,
      command.versionLabel ?? '',
      command.description ?? '',
    ].map(traceKernelTsv).join('\t'));
    return ['name\tpath\tkind\tlanguage\tadapter\tversion\tdescription', ...rows].join('\n') + '\n';
  }

  private renderProcRuntimes(): string {
    return JSON.stringify({
      schema: 'tracekernel.runtimes.v1',
      binPath: TRACEKERNEL_BIN_PATH,
      runtimes: traceKernelRuntimeRegistry(this.traceKernelCommandRegistry),
    }, null, 2) + '\n';
  }

  private renderProcProcesses(): string {
    const rows = this.activeProcessRecords().map((process) =>
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
    return ['pid\tppid\tpgid\tsid\tstate\ttty\tfg\tcwd\tcmd', ...rows].join('\n') + '\n';
  }

  private renderProcEvents(): string {
    const rows = this.kernelEventLog.map((event) =>
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

  private renderProcLocks(): string {
    const rows = this.fsLocks.snapshot().map((lock) =>
      `${lock.path}\t${lock.active ? 1 : 0}\t${lock.waiting}\t${lock.readers}\t${lock.writer ? 1 : 0}\t${lock.waitingReaders}\t${lock.waitingWriters}`
    );
    return ['path\tactive\twaiting\treaders\twriter\twaiting_readers\twaiting_writers', ...rows].join('\n') + '\n';
  }

  private renderProcHttpListeners(): string {
    const rows = [...this.httpListeners.values()]
      .map((listener) => listener.info)
      .sort((left, right) => left.port - right.port || left.host.localeCompare(right.host))
      .map((listener) => [
        this.sanitizeHttpDiagnosticField(listener.id),
        listener.pid,
        this.sanitizeHttpDiagnosticField(listener.protocol),
        this.sanitizeHttpDiagnosticField(listener.host),
        listener.port,
        this.sanitizeHttpDiagnosticField(listener.startedAt),
      ].join('\t'));
    return ['id\tpid\tproto\thost\tport\tstarted', ...rows].join('\n') + '\n';
  }

  private renderProcHttpRequests(): string {
    const rows = this.httpRequestLog.map((request) => [
      request.seq,
      this.sanitizeHttpDiagnosticField(request.time),
      this.sanitizeHttpDiagnosticField(request.listenerId ?? ''),
      request.pid ?? '',
      this.sanitizeHttpDiagnosticField(request.method),
      this.sanitizeHttpDiagnosticField(request.url),
      request.status ?? '',
      this.sanitizeHttpDiagnosticField(request.error ?? ''),
    ].join('\t'));
    return ['seq\ttime\tlistener\tpid\tmethod\turl\tstatus\terror', ...rows].join('\n') + '\n';
  }

  private renderProcScheduler(): string {
    const active = this.activeProcessRecords();
    const scheduler = this.commandScheduler.snapshot();
    const queued = active.filter((process) => process.state === 'queued').length;
    const running = active.filter((process) => process.state === 'running').length;
    const zombies = active.filter((process) => process.state === 'zombie').length;
    return [
      `tasks\t${active.length}`,
      `queued\t${queued}`,
      `running\t${running}`,
      `zombies\t${zombies}`,
      `admitted\t${scheduler.running}`,
      `waiting\t${scheduler.queued}`,
      `max_concurrent\t${scheduler.maxConcurrentCommands}`,
      `max_queued\t${scheduler.maxQueuedCommands ?? 'unlimited'}`,
      `next_pid\t${this.nextPid}`,
      ...active.map((process) => `task\t${process.pid}\t${process.state}\t${process.command}`),
    ].join('\n') + '\n';
  }

  private hasVirtualExecutableLoaders(): boolean {
    return Boolean(this.cppRunner);
  }

  private registerVirtualExecutable(record: VirtualExecutableRecord): void {
    this.virtualExecutableRecords.set(record.path, record);
  }

  private async runTraceKernelExec(args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    const executable = args[0];
    if (!executable) {
      return { stdout: '', stderr: `${TRACEKERNEL_EXEC_COMMAND}: missing executable path\n`, exitCode: 2 };
    }
    let expandedInvocation: { scriptFile: string | null; scriptArgs: string[] };
    try {
      expandedInvocation = await expandParsedScriptInvocation(ctx, this.cwd, executable, args.slice(1), this.kernelInfo.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    if (!expandedInvocation.scriptFile) {
      return { stdout: '', stderr: `${TRACEKERNEL_EXEC_COMMAND}: missing executable path\n`, exitCode: 2 };
    }
    const result = await this.executeVirtualExecutable({
      executable: expandedInvocation.scriptFile,
      args: expandedInvocation.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdinPipe: this.currentCommandContext()?.stdinPipe,
      preserveScriptPath: true,
    });
    return result ?? { stdout: '', stderr: `bash: ${expandedInvocation.scriptFile}: Exec format error\n`, exitCode: 126 };
  }

  private async runKernelCurl(args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let method: string | undefined;
    let body: string | undefined;
    let includeHeaders = false;
    let headOnly = false;
    let failOnHttpError = false;
    let appendDataToQuery = false;
    let outputPath: string | undefined;
    let timeoutMs: number | undefined;
    const headers: Record<string, string> = {};
    const rawHeaders: Array<[string, string]> = [];
    const urls: string[] = [];
    const addHeader = (header: string): void => {
      const separator = header.indexOf(':');
      if (separator === -1) return;
      const name = header.slice(0, separator).trim();
      if (!name) return;
      const value = header.slice(separator + 1).trim();
      headers[name.toLowerCase()] = value;
      rawHeaders.push([name, value]);
    };
    const appendBody = (data: string): void => {
      body = body === undefined ? data : `${body}&${data}`;
    };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '-s' || arg === '--silent' || arg === '-L' || arg === '--location') continue;
      if (arg === '-i' || arg === '--include') {
        includeHeaders = true;
        continue;
      }
      if (arg === '-I' || arg === '--head') {
        method ??= 'HEAD';
        includeHeaders = true;
        headOnly = true;
        continue;
      }
      if (arg === '-f' || arg === '--fail') {
        failOnHttpError = true;
        continue;
      }
      if (arg === '-G' || arg === '--get') {
        appendDataToQuery = true;
        continue;
      }
      if (arg === '-o' || arg === '--output') {
        const next = args[++index];
        if (!next) return { stdout: '', stderr: 'curl: option requires an argument -- o\n', exitCode: 2 };
        outputPath = next;
        continue;
      }
      if (arg.startsWith('--output=')) {
        outputPath = arg.slice('--output='.length);
        if (!outputPath) return { stdout: '', stderr: 'curl: option requires an argument -- output\n', exitCode: 2 };
        continue;
      }
      if (arg === '--max-time') {
        const next = args[++index];
        if (!next) return { stdout: '', stderr: 'curl: option requires an argument -- max-time\n', exitCode: 2 };
        const seconds = Number(next);
        if (!Number.isFinite(seconds) || seconds < 0) return { stdout: '', stderr: `curl: invalid --max-time value: ${next}\n`, exitCode: 2 };
        timeoutMs = Math.max(1, Math.ceil(seconds * 1000));
        continue;
      }
      if (arg.startsWith('--max-time=')) {
        const value = arg.slice('--max-time='.length);
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) return { stdout: '', stderr: `curl: invalid --max-time value: ${value}\n`, exitCode: 2 };
        timeoutMs = Math.max(1, Math.ceil(seconds * 1000));
        continue;
      }
      if (arg === '-X' || arg === '--request') {
        const next = args[++index];
        if (!next) return { stdout: '', stderr: 'curl: option requires an argument -- X\n', exitCode: 2 };
        method = next.toUpperCase();
        headOnly = method === 'HEAD';
        continue;
      }
      if (arg.startsWith('-X') && arg.length > 2) {
        method = arg.slice(2).toUpperCase();
        headOnly = method === 'HEAD';
        continue;
      }
      if (arg === '-H' || arg === '--header') {
        const next = args[++index];
        if (!next) return { stdout: '', stderr: 'curl: option requires an argument -- H\n', exitCode: 2 };
        addHeader(next);
        continue;
      }
      if (arg.startsWith('--header=')) {
        addHeader(arg.slice('--header='.length));
        continue;
      }
      if (arg === '--json') {
        const next = args[++index];
        if (next === undefined) return { stdout: '', stderr: 'curl: option requires an argument -- json\n', exitCode: 2 };
        appendBody(next);
        method ??= 'POST';
        headers['content-type'] ??= 'application/json';
        headers.accept ??= 'application/json';
        continue;
      }
      if (arg.startsWith('--json=')) {
        appendBody(arg.slice('--json='.length));
        method ??= 'POST';
        headers['content-type'] ??= 'application/json';
        headers.accept ??= 'application/json';
        continue;
      }
      if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-binary') {
        const next = args[++index];
        if (next === undefined) return { stdout: '', stderr: 'curl: option requires an argument -- d\n', exitCode: 2 };
        appendBody(next);
        method ??= 'POST';
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('-d') && arg.length > 2) {
        appendBody(arg.slice(2));
        method ??= 'POST';
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('--data=')) {
        appendBody(arg.slice('--data='.length));
        method ??= 'POST';
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('--data-raw=')) {
        appendBody(arg.slice('--data-raw='.length));
        method ??= 'POST';
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
        continue;
      }
      if (arg.startsWith('-')) {
        return { stdout: '', stderr: `curl: unsupported option: ${arg}\n`, exitCode: 2 };
      }
      urls.push(arg);
    }
    if (urls.length !== 1) {
      return {
        stdout: '',
        stderr: urls.length === 0 ? 'curl: no URL specified\n' : 'curl: multiple URLs are not supported by tracekernel curl\n',
        exitCode: 2,
      };
    }
    let url: URL;
    try {
      url = new URL(urls[0]!);
    } catch {
      return { stdout: '', stderr: `curl: (3) URL rejected: ${urls[0]}\n`, exitCode: 3 };
    }
    if (appendDataToQuery && body !== undefined) {
      const params = new URLSearchParams(body);
      for (const [name, value] of params) url.searchParams.append(name, value);
      body = undefined;
      if (method === undefined || method === 'POST') method = 'GET';
    }
    const request: RuntimeKernelHttpRequest = {
      method: method ?? 'GET',
      url: url.toString(),
      path: `${url.pathname}${url.search}`,
      headers,
      ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    const response = await this.dispatchHttpRequest(request, {
      ...(timeoutMs !== undefined ? {
        timeoutMs,
        timeoutBody: `curl: (28) Operation timed out after ${timeoutMs} milliseconds\n`,
      } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (response.status === 0 && response.body?.startsWith('curl: (28)')) {
      return { stdout: '', stderr: response.body ?? 'curl: (28) Operation timed out\n', exitCode: 28 };
    }
    if (response.status === 0) {
      return { stdout: '', stderr: response.body ?? 'curl: connection failed\n', exitCode: 7 };
    }
    if (failOnHttpError && response.status >= 400) {
      return { stdout: '', stderr: `curl: (22) The requested URL returned error: ${response.status}\n`, exitCode: 22 };
    }
    const responseHeaders = includeHeaders
      ? [
          `HTTP/1.1 ${response.status}`,
          ...Object.entries(response.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\n')
      : '';
    const responseBodyBytes = headOnly ? new Uint8Array() : runtimeHttpBodyBytes(response);
    const responseBody = decodeUtf8(responseBodyBytes) ?? new TextDecoder().decode(responseBodyBytes);
    const outputBody = `${responseHeaders}${responseBody}`;
    if (outputPath !== undefined) {
      try {
        const absoluteOutputPath = resolveWorkspaceContextPath(ctx, this.cwd, outputPath, 'curl output path');
        await ctx.fs.mkdir(dirname(absoluteOutputPath), { recursive: true });
        if (responseHeaders) {
          await ctx.fs.writeFile(absoluteOutputPath, outputBody);
        } else {
          await ctx.fs.writeFile(absoluteOutputPath, responseBodyBytes);
        }
      } catch (error) {
        return { stdout: '', stderr: `curl: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 23 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: outputBody,
      stderr: '',
      exitCode: 0,
    };
  }

  private runTraceKernelWhich(args: string[], commandName: string): RuntimeCommandResult {
    const names: string[] = [];
    let endOfOptions = false;
    for (const arg of args) {
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && arg === '-a') continue;
      if (!endOfOptions && arg.startsWith('-')) {
        return { stdout: '', stderr: `usage: ${commandName} [-a] <command>...\n`, exitCode: 2 };
      }
      names.push(arg);
    }
    if (names.length === 0) {
      return { stdout: '', stderr: `usage: ${commandName} [-a] <command>...\n`, exitCode: 2 };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const name of names) {
      const info = this.traceKernelCommandInfo(name);
      if (info) {
        stdout += `${info.path}\n`;
        continue;
      }
      exitCode = 1;
      stderr += `${commandName}: no ${name} in ${TRACEKERNEL_BIN_PATH}\n`;
    }
    return { stdout, stderr, exitCode };
  }

  private runTraceKernelCommandBuiltin(args: string[]): RuntimeCommandResult {
    const option = args[0];
    if (option === '-v' || option === '-V') {
      return this.runTraceKernelWhich(args.slice(1), 'command');
    }
    return {
      stdout: '',
      stderr: 'command: only -v and -V are supported by TraceKernel command discovery\n',
      exitCode: 2,
    };
  }

  private async runTraceKernelCtl(args: string[]): Promise<RuntimeCommandResult> {
    const command = args[0] ?? 'status';
    if (command === 'status') {
      const scheduler = this.commandScheduler.snapshot();
      return {
        stdout: [
          `${this.kernelInfo.name} ${this.kernelInfo.version}`,
          `user=${this.kernelInfo.user.username}`,
          `host=${this.kernelInfo.host.hostname}`,
          `workspace=${this.kernelInfo.workspaceRoot}`,
          `verbose=${this.terminalVerbose ? 'on' : 'off'}`,
          `scheduler.maxConcurrent=${scheduler.maxConcurrentCommands}`,
          `scheduler.running=${scheduler.running}`,
          `scheduler.queued=${scheduler.queued}`,
          `scheduler.maxQueued=${scheduler.maxQueuedCommands ?? 'unlimited'}`,
          ...(this.kernelInfo.workspaceAlias ? [`alias=${this.kernelInfo.workspaceAlias}`] : []),
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'verbose') {
      if (args.length > 2) {
        return { stdout: '', stderr: 'usage: tracekernelctl verbose [on|off|status]\n', exitCode: 2 };
      }
      const mode = args[1];
      if (mode === undefined) {
        this.terminalVerbose = !this.terminalVerbose;
      } else if (mode === 'on' || mode === 'true' || mode === '1' || mode === 'enable' || mode === 'enabled') {
        this.terminalVerbose = true;
      } else if (mode === 'off' || mode === 'false' || mode === '0' || mode === 'disable' || mode === 'disabled') {
        this.terminalVerbose = false;
      } else if (mode !== 'status') {
        return { stdout: '', stderr: 'usage: tracekernelctl verbose [on|off|status]\n', exitCode: 2 };
      }
      return { stdout: `tracekernelctl: verbose ${this.terminalVerbose ? 'on' : 'off'}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'reset') {
      if (args.length > 1) {
        return { stdout: '', stderr: 'usage: tracekernelctl reset\n', exitCode: 2 };
      }
      await this.kernelControl?.reset?.();
      await this.destroyNow({ reason: 'tracekernelctl-reset', clearStorage: true });
      return { stdout: 'tracekernelctl: reset complete\n', stderr: '', exitCode: 0 };
    }
    if (command === 'kill') {
      if (args.length < 2 || args.length > 3) {
        return { stdout: '', stderr: 'usage: tracekernelctl kill <pid> [signal]\n', exitCode: 2 };
      }
      const target = Number(args[1]);
      if (!Number.isInteger(target) || target === 0) {
        return { stdout: '', stderr: `tracekernelctl: invalid pid: ${args[1]}\n`, exitCode: 22 };
      }
      const signal = normalizeTraceKernelSignal(args[2]);
      if (!signal) {
        return { stdout: '', stderr: `tracekernelctl: invalid signal: ${args[2] ?? ''}\n`, exitCode: 22 };
      }
      if (target < 0) {
        const pgid = Math.abs(target);
        const count = this.signalProcessGroup(pgid, signal.name);
        if (count === 0) return { stdout: '', stderr: `tracekernelctl: no such process group: ${pgid}\n`, exitCode: 3 };
        return { stdout: `tracekernelctl: sent ${signal.name} to process group ${pgid} (${count} process${count === 1 ? '' : 'es'})\n`, stderr: '', exitCode: 0 };
      }
      const process = this.findProcessRecord(target);
      if (!process || process.state === 'exited') {
        return { stdout: '', stderr: `tracekernelctl: no such process: ${target}\n`, exitCode: 3 };
      }
      if (!this.signalProcess(process, signal.name)) {
        return { stdout: '', stderr: `tracekernelctl: no such process: ${target}\n`, exitCode: 3 };
      }
      return { stdout: `tracekernelctl: sent ${signal.name} to ${target}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'wait') {
      if (args.length > 2) {
        return { stdout: '', stderr: 'usage: tracekernelctl wait [pid]\n', exitCode: 2 };
      }
      if (args[1] === undefined) {
        return this.reapZombieProcess(undefined, 'tracekernelctl');
      }
      const pid = Number(args[1]);
      if (!Number.isInteger(pid) || pid <= 0) {
        return { stdout: '', stderr: `tracekernelctl: invalid pid: ${args[1]}\n`, exitCode: 22 };
      }
      return this.reapZombieProcess(pid, 'tracekernelctl');
    }
    return {
      stdout: '',
      stderr: `tracekernelctl: unknown command: ${command}\nusage: tracekernelctl {status|reset|verbose [on|off|status]|kill <pid> [signal]|wait <pid>}\n`,
      exitCode: 2,
    };
  }

  private async runKernelAwareLs(args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    const parsed = parseRuntimeLsArgs(args);
    if ('exitCode' in parsed) return parsed;
    const options = parsed;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const multipleTargets = options.positional.length > 1;
    const visitedRecursiveDirectories = new Set<string>();

    const statPath = async (path: string): Promise<RuntimeLsStat> => ctx.fs.stat(path) as Promise<RuntimeLsStat>;
    const lstatPath = async (path: string): Promise<RuntimeLsStat> => ctx.fs.lstat(path) as Promise<RuntimeLsStat>;
    const sortedEntries = (entries: RuntimeLsEntry[]): RuntimeLsEntry[] => {
      entries.sort((left, right) => {
        if (options.sortBySize) return (right.stat.size ?? 0) - (left.stat.size ?? 0) || left.name.localeCompare(right.name);
        if (options.sortByTime) {
          const rightTime = right.stat.mtime instanceof Date ? right.stat.mtime.getTime() : right.stat.mtimeMs ?? 0;
          const leftTime = left.stat.mtime instanceof Date ? left.stat.mtime.getTime() : left.stat.mtimeMs ?? 0;
          return rightTime - leftTime || left.name.localeCompare(right.name);
        }
        return left.name.localeCompare(right.name);
      });
      if (options.reverse) entries.reverse();
      return entries;
    };

    const renderEntry = async (path: string, name: string): Promise<string> => {
      const stat = await lstatPath(path);
      if (options.longFormat) return runtimeLsFormatLine(path, name, stat, options, this.kernelInfo);
      return `${name}${options.classify ? runtimeLsIndicator(stat) : ''}\n`;
    };

    const renderDirectory = async (input: string, absolutePath: string, includeHeader: boolean, recursive: boolean): Promise<void> => {
      const directoryStat = await lstatPath(absolutePath);
      if (runtimeFileSystemEntryIsSymlink(directoryStat)) {
        stdout += await renderEntry(absolutePath, input);
        return;
      }
      if (recursive) {
        const directoryKey = runtimeFileSystemEntryKey(absolutePath, directoryStat);
        if (visitedRecursiveDirectories.has(directoryKey)) return;
        visitedRecursiveDirectories.add(directoryKey);
      }
      if (includeHeader) stdout += `${input}:\n`;
      let names = await ctx.fs.readdir(absolutePath);
      if (!options.showAll && !options.showAlmostAll) names = names.filter((name) => !name.startsWith('.'));
      if (options.showAll) names = ['.', '..', ...names];
      const entries: RuntimeLsEntry[] = [];
      for (const name of names) {
        if (options.showAlmostAll && (name === '.' || name === '..')) continue;
        const childPath = name === '.'
          ? absolutePath
          : name === '..'
            ? dirname(absolutePath)
            : absolutePath === '/'
              ? `/${name}`
              : `${absolutePath}/${name}`;
        try {
          entries.push({ name, path: childPath, stat: await lstatPath(childPath) });
        } catch {
          // Match ls' best-effort behavior when an entry disappears during listing.
        }
      }
      sortedEntries(entries);
      if (options.longFormat) stdout += `total ${entries.length}\n`;
      for (const entry of entries) {
        stdout += options.longFormat
          ? runtimeLsFormatLine(entry.path, entry.name, entry.stat, options, this.kernelInfo)
          : `${entry.name}${options.classify ? runtimeLsIndicator(entry.stat) : ''}\n`;
      }
      if (!recursive) return;
      const childDirectories = entries.filter((entry) =>
        entry.stat.isDirectory &&
        entry.name !== '.' &&
        entry.name !== '..'
      );
      for (const entry of childDirectories) {
        stdout += '\n';
        const childInput = input === '/' ? `/${entry.name}` : `${input.replace(/\/+$/, '')}/${entry.name}`;
        await renderDirectory(childInput, entry.path, true, true);
      }
    };

    for (const [index, input] of options.positional.entries()) {
      if (index > 0 && stdout && !stdout.endsWith('\n\n')) stdout += '\n';
      const absolutePath = ctx.fs.resolvePath(ctx.cwd, input);
      try {
        const stat = await statPath(absolutePath);
        const lstat = await lstatPath(absolutePath);
        if (options.directoryOnly || !stat.isDirectory || runtimeFileSystemEntryIsSymlink(lstat)) {
          stdout += await renderEntry(absolutePath, input);
          continue;
        }
        await renderDirectory(input, absolutePath, multipleTargets || options.recursive, options.recursive);
      } catch {
        stderr += `ls: cannot access '${input}': No such file or directory\n`;
        exitCode = 2;
      }
    }
    return { stdout, stderr, exitCode };
  }

  private runKernelPs(args: string[]): RuntimeCommandResult {
    const supported = new Set(['', '-e', '-f', '-ef', 'aux']);
    const mode = args.join('');
    if (!supported.has(mode)) {
      return { stdout: '', stderr: 'usage: ps [-e|-f|-ef|aux]\n', exitCode: 2 };
    }
    const rows = [this.principalProcessRecord(), ...this.activeProcessRecords()].map((process) =>
      [
        String(process.pid).padStart(5, ' '),
        String(process.ppid).padStart(5, ' '),
        String(process.pgid).padStart(5, ' '),
        String(process.sid).padStart(5, ' '),
        process.state.padEnd(8, ' '),
        process.foreground ? '+' : '-',
        process.tty.padEnd(8, ' '),
        process.command,
      ].join(' ')
    );
    return {
      stdout: ['  PID  PPID  PGID   SID STAT     FG TTY      CMD', ...rows].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelJobs(args: string[]): RuntimeCommandResult {
    if (args.length > 1 || (args[0] !== undefined && args[0] !== '-l')) {
      return { stdout: '', stderr: 'usage: jobs [-l]\n', exitCode: 2 };
    }
    const currentPid = this.currentCommandContext()?.process.pid;
    const rows = this.kernelJobRecords(currentPid)
      .map((process, index) => {
        const marker = process.foreground ? '+' : '-';
        const status = process.state === 'running' ? 'Running' : process.state === 'zombie' ? 'Done' : process.state;
        const placement = process.foreground ? 'foreground' : 'background';
        return args[0] === '-l'
          ? `[${index + 1}]${marker} ${process.pid}\t${status}\t${placement}\t${process.tty}\t${process.command}`
          : `[${index + 1}]${marker} ${status}\t${process.command}`;
      });
    return { stdout: rows.length > 0 ? `${rows.join('\n')}\n` : '', stderr: '', exitCode: 0 };
  }

  private terminalJobRecords(): RuntimeProjectTerminalJobRecord[] {
    return this.kernelJobRecords().map((process, index) => ({
      index: index + 1,
      pid: process.pid,
      command: process.command,
    }));
  }

  private kernelJobRecords(currentPid = this.currentCommandContext()?.process.pid): RuntimeKernelProcessRecord[] {
    return this.activeProcessRecords().filter((process) => process.pid !== currentPid && process.pid !== 1);
  }

  private resolveKernelJobTarget(target: string | undefined): RuntimeKernelProcessRecord | undefined {
    const jobs = this.kernelJobRecords();
    if (target === undefined) return jobs[0];
    const jobMatch = target.match(/^%([1-9][0-9]*)$/);
    if (jobMatch) return jobs[Number(jobMatch[1]) - 1];
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const process = this.findProcessRecord(pid);
    if (!process || process.pid === 1 || process.pid === this.currentCommandContext()?.process.pid || process.state === 'exited') {
      return undefined;
    }
    return process;
  }

  private runKernelJobPlacement(args: string[], commandName: 'bg' | 'fg'): RuntimeCommandResult {
    if (args.length > 1) {
      return { stdout: '', stderr: `usage: ${commandName} [pid|%job]\n`, exitCode: 2 };
    }
    const process = this.resolveKernelJobTarget(args[0]);
    if (!process) {
      return { stdout: '', stderr: `${commandName}: no such job${args[0] === undefined ? '' : `: ${args[0]}`}\n`, exitCode: 10 };
    }
    const foreground = commandName === 'fg';
    this.setProcessGroupForeground(process.pgid, foreground);
    this.recordKernelEvent(foreground ? 'process-foreground' : 'process-background', process.pid, {
      command: process.command,
      pgid: process.pgid,
      tty: foreground ? '/dev/tty' : '?',
    });
    return {
      stdout: `${commandName}: ${process.pid}\tpgid=${process.pgid}\t${foreground ? 'foreground' : 'background'}\t${process.command}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelKill(args: string[], commandName: string): RuntimeCommandResult {
    if (args.length === 0) {
      return { stdout: '', stderr: `usage: ${commandName} [-SIGNAL] <pid>...\n`, exitCode: 2 };
    }
    let signalName = 'SIGTERM';
    let pidArgs = args[0] === '--' ? args.slice(1) : args;
    const first = pidArgs[0] ?? '';
    if (first.startsWith('-') && first.length > 1 && !/^-?[0-9]+$/.test(first)) {
      signalName = first.slice(1);
      pidArgs = pidArgs.slice(1);
    }
    const signal = normalizeTraceKernelSignal(signalName);
    if (!signal) return { stdout: '', stderr: `${commandName}: invalid signal: ${signalName}\n`, exitCode: 22 };
    if (pidArgs.length === 0) return { stdout: '', stderr: `usage: ${commandName} [-SIGNAL] <pid>...\n`, exitCode: 2 };

    for (const pidArg of pidArgs) {
      const target = Number(pidArg);
      if (!Number.isInteger(target) || target === 0) {
        return { stdout: '', stderr: `${commandName}: invalid pid: ${pidArg}\n`, exitCode: 22 };
      }
      if (target < 0) {
        const pgid = Math.abs(target);
        if (this.signalProcessGroup(pgid, signal.name) === 0) {
          return { stdout: '', stderr: `${commandName}: no such process group: ${pgid}\n`, exitCode: 3 };
        }
        continue;
      }
      const process = this.findProcessRecord(target);
      if (!process || process.state === 'exited') {
        return { stdout: '', stderr: `${commandName}: no such process: ${target}\n`, exitCode: 3 };
      }
      this.signalProcess(process, signal.name);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private runKernelWait(args: string[], commandName: string): Promise<RuntimeCommandResult> {
    if (args.length > 1) {
      return Promise.resolve({ stdout: '', stderr: `usage: ${commandName} [pid]\n`, exitCode: 2 });
    }
    if (args[0] === undefined) return this.reapZombieProcess(undefined, commandName);
    const pid = Number(args[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return Promise.resolve({ stdout: '', stderr: `${commandName}: invalid pid: ${args[0]}\n`, exitCode: 22 });
    }
    return this.reapZombieProcess(pid, commandName);
  }

  async ensureReady(): Promise<void> {
    this.assertNotDestroyed();
    await this.fs.withBaseMutation([this.cwd], (fs) => fs.mkdir(this.cwd, { recursive: true }), 'directory-create');
  }

  async writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
    this.assertWorkspaceUsableForMutation('write');
    await this.writeFileAs(path, contents, PRINCIPAL_ACTOR, encoding, 'live');
  }

  private toWorkspacePath(path: string): string {
    return toWorkspacePath(this.cwd, path, this.kernelInfo.workspaceAlias);
  }

  private toWorkspaceEntryPath(path: string): string {
    return toWorkspaceEntryPath(this.cwd, path, this.kernelInfo.workspaceAlias);
  }

  private toWorkspaceRelativePath(path: string): string {
    return toWorkspaceRelativePath(this.cwd, path, this.kernelInfo.workspaceAlias);
  }

  isReadOnly(path: string): boolean {
    return this.isWorkspacePathReadOnly(this.toWorkspacePath(path));
  }

  private isReadonlyPolicySuspended(): boolean {
    return this.readonlySuspendDepth > 0;
  }

  private isSessionExpired(): boolean {
    return Boolean(this.projectSession?.lifecycle.expiredAt);
  }

  private assertNotDestroyed(): void {
    if (!this.destroyed) return;
    throw Object.assign(new Error('EINVAL: tracekernel session has been destroyed'), { code: 'EINVAL' });
  }

  private assertWorkspaceUsableForMutation(operation: string): void {
    this.assertNotDestroyed();
    if (this.isReadonlyPolicySuspended()) return;
    if (!this.isSessionExpired() || this.projectSession?.lifecycle.expirationBehavior !== 'readonly') return;
    throw Object.assign(
      new Error(`EROFS: project session expired, ${operation} '${this.cwd}'`),
      { code: 'EROFS' }
    );
  }

  private assertDynamicVirtualWritable(path: string, operation: string): void {
    if (!isTraceKernelVirtualNamespacePath(path) && !isRuntimeSkillsNamespacePath(path)) return;
    throw Object.assign(
      new Error(`EROFS: kernel virtual path is read-only, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  private assertWorkspaceUsableForRun(command: string): RuntimeCommandResult | null {
    if (this.destroyed) {
      return { stdout: '', stderr: 'tracekernel session has been destroyed\n', exitCode: 1 };
    }
    if (this.isSessionExpired() && this.projectSession?.lifecycle.expirationBehavior === 'readonly') {
      return { stdout: '', stderr: `project session expired; command not run: ${command}\n`, exitCode: 1 };
    }
    return null;
  }

  private isWorkspacePathReadOnly(absolutePath: string): boolean {
    if (!isWithinWorkspace(this.cwd, absolutePath) || absolutePath === this.cwd) return false;
    return this.readonlyFiles.has(toProjectPath(this.cwd, absolutePath));
  }

  private isProjectPathHidden(path: string): boolean {
    const normalized = normalizeRuntimeProjectPath(path);
    return (this.projectSession?.hiddenFiles ?? []).some((hiddenPath) =>
      hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`)
    );
  }

  private isWorkspacePathHidden(absolutePath: string): boolean {
    if (!isWithinWorkspace(this.cwd, absolutePath) || absolutePath === this.cwd) return false;
    return this.isProjectPathHidden(toProjectPath(this.cwd, absolutePath));
  }

  private assertWorkspacePathVisible(absolutePath: string, operation: string): void {
    if (!this.isWorkspacePathHidden(absolutePath)) return;
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, ${operation} '${toProjectPath(this.cwd, absolutePath)}'`),
      { code: 'ENOENT' }
    );
  }

  private isWorkspaceSubtreeReadOnly(absolutePath: string): boolean {
    if (!isWithinWorkspace(this.cwd, absolutePath)) return false;
    if (this.isWorkspacePathReadOnly(absolutePath)) return true;
    const relativePath = absolutePath === this.cwd ? '' : toProjectDirectoryPath(this.cwd, absolutePath);
    const prefix = relativePath ? `${relativePath}/` : '';
    return [...this.readonlyFiles].some((path) => path.startsWith(prefix));
  }

  private isHomePathOutsideWorkspace(absolutePath: string): boolean {
    return isWithinWorkspace(this.kernelInfo.home, absolutePath) && !isWithinWorkspace(this.cwd, absolutePath);
  }

  private assertWorkspacePathWritable(absolutePath: string, operation: string): void {
    this.assertWorkspaceUsableForMutation(operation);
    if (this.isHomePathOutsideWorkspace(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: project workspace is read-only outside '${this.cwd}', ${operation} '${absolutePath}'`),
        { code: 'EROFS' }
      );
    }
    if (this.isReadonlyPolicySuspended() || !this.isWorkspacePathReadOnly(absolutePath)) return;
    throw createRuntimeKernelReadonlyFileError(toProjectPath(this.cwd, absolutePath), operation);
  }

  private assertWorkspaceSubtreeWritable(absolutePath: string, operation: string): void {
    this.assertWorkspaceUsableForMutation(operation);
    if (this.isHomePathOutsideWorkspace(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: project workspace is read-only outside '${this.cwd}', ${operation} '${absolutePath}'`),
        { code: 'EROFS' }
      );
    }
    if (this.isReadonlyPolicySuspended() || !this.isWorkspaceSubtreeReadOnly(absolutePath)) return;
    throw Object.assign(
      new Error(`EROFS: readonly project subtree, ${operation} '${toProjectDirectoryPath(this.cwd, absolutePath)}'`),
      { code: 'EROFS' }
    );
  }

  async withSuspendedReadonlyPolicy<T>(fn: () => Promise<T>): Promise<T> {
    this.readonlySuspendDepth += 1;
    try {
      return await fn();
    } finally {
      this.readonlySuspendDepth -= 1;
    }
  }

  private resolveTerminalPathInRoot(currentCwd: string, target: string, root: string, rootLabel: string): string {
    const rawTarget = target.trim() || this.cwd;
    const normalizedTarget = rawTarget === '~' ? this.kernelInfo.home : rawTarget;
    const absolutePath = normalizedTarget.startsWith('/')
      ? normalizeTerminalAbsolutePath(mapWorkspaceAlias(this.cwd, this.kernelInfo.workspaceAlias, normalizedTarget))
      : normalizeTerminalAbsolutePath(`${currentCwd}/${normalizedTarget}`);
    if (!isWithinWorkspace(root, absolutePath)) {
      throw new Error(`path must stay inside ${rootLabel}: ${target}`);
    }
    return absolutePath;
  }

  private resolveTerminalPath(currentCwd: string, target: string): string {
    return this.resolveTerminalPathInRoot(currentCwd, target, this.cwd, 'the workspace');
  }

  private resolveTerminalNavigationPath(currentCwd: string, target: string): string {
    return this.resolveTerminalPathInRoot(currentCwd, target, this.kernelInfo.home, 'home');
  }

  private resolveCommandCwd(target: string): string {
    return isWithinWorkspace(this.kernelInfo.home, this.cwd)
      ? this.resolveTerminalNavigationPath(this.cwd, target)
      : this.toWorkspacePath(target);
  }

  private async resolveTerminalCwd(currentCwd: string, target: string): Promise<string> {
    const absolutePath = this.resolveTerminalNavigationPath(currentCwd, target);
    const statTarget = kernelStatTarget(absolutePath, this.kernelInfo);
    const stat = statTarget.kind === 'stat'
      ? { isDirectory: statTarget.stat.isDirectory }
      : await this.bash.fs.stat(absolutePath);
    if (!stat.isDirectory) {
      throw new Error(`not a directory: ${target}`);
    }
    return absolutePath;
  }

  private commandPathCompletionTarget(
    token: string,
    cwd: string
  ): { listPath: string; partial: string; replacementPrefix: string } {
    if (token === '~' || token.startsWith('~/')) {
      const afterHome = token === '~' ? '' : token.slice(2);
      const slashIndex = afterHome.lastIndexOf('/');
      if (slashIndex >= 0) {
        const parent = afterHome.slice(0, slashIndex);
        return {
          listPath: parent ? this.resolveTerminalNavigationPath(this.kernelInfo.home, parent) : this.kernelInfo.home,
          partial: afterHome.slice(slashIndex + 1),
          replacementPrefix: `~/${parent ? `${parent}/` : ''}`,
        };
      }
      return { listPath: this.kernelInfo.home, partial: afterHome, replacementPrefix: '~/' };
    }

    const slashIndex = token.lastIndexOf('/');
    if (slashIndex >= 0) {
      const parent = token.slice(0, slashIndex);
      return {
        listPath: this.resolveTerminalNavigationPath(cwd, parent || '/'),
        partial: token.slice(slashIndex + 1),
        replacementPrefix: token.slice(0, slashIndex + 1),
      };
    }

    return { listPath: cwd, partial: token, replacementPrefix: '' };
  }

  private async listTerminalDirectory(path: string): Promise<string[]> {
    const dynamicEntries = this.readDynamicVirtualDir(path);
    if (dynamicEntries) return dynamicEntries.map((entry) => entry.name).sort();
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return directoryTarget.entries.map((entry) => entry.name).sort();
    if (directoryTarget.kind === 'error') {
      throw new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      );
    }

    const entries = await this.bash.fs.readdir(path);
    return [...entries]
      .filter((entry) => {
        if (!isWithinWorkspace(this.cwd, path)) return true;
        const directoryPath = path === this.cwd ? '' : toProjectPath(this.cwd, path);
        const entryPath = directoryPath ? `${directoryPath}/${entry}` : entry;
        return !this.isProjectPathHidden(entryPath);
      })
      .sort((left, right) => left.localeCompare(right));
  }

  private async terminalPathIsDirectory(path: string): Promise<boolean> {
    const dynamicKind = this.dynamicVirtualEntryKind(path);
    if (dynamicKind) return dynamicKind === 'directory';
    const statTarget = kernelStatTarget(path, this.kernelInfo);
    if (statTarget.kind === 'stat') return statTarget.stat.isDirectory;
    if (statTarget.kind === 'error') return false;
    try {
      return (await this.bash.fs.stat(path)).isDirectory;
    } catch {
      return false;
    }
  }

  async completeCommand(
    input: string,
    cursor: number,
    options: RuntimeCommandCompletionOptions = {}
  ): Promise<RuntimeCommandCompletion | null> {
    this.assertNotDestroyed();
    const cwd = options.cwd
      ? this.resolveTerminalNavigationPath(this.cwd, options.cwd)
      : this.cwd;
    const boundedCursor = Math.max(0, Math.min(cursor, input.length));
    const { start, end } = commandInputTokenBounds(input, boundedCursor);
    const token = input.slice(start, boundedCursor);
    if (!token || token.includes('"') || token.includes("'")) return null;

    let target: { listPath: string; partial: string; replacementPrefix: string };
    try {
      target = this.commandPathCompletionTarget(token, cwd);
    } catch {
      return null;
    }

    let entries: string[];
    try {
      entries = await this.listTerminalDirectory(target.listPath);
    } catch {
      return null;
    }

    const matchingNames = entries.filter((entry) => entry.startsWith(target.partial));
    if (matchingNames.length === 0) return null;
    const matches: RuntimeCommandCompletionMatch[] = await Promise.all(
      matchingNames.map(async (name) => ({
        name,
        kind: await this.terminalPathIsDirectory(normalizeTerminalAbsolutePath(`${target.listPath}/${name}`))
          ? 'directory'
          : 'file',
      }))
    );
    const completedName = matchingNames.length === 1 ? matchingNames[0] : longestCommonPrefix(matchingNames);
    if (!completedName || (matchingNames.length > 1 && completedName === target.partial)) {
      return {
        input,
        cursor: boundedCursor,
        matches,
        replacementChanged: false,
      };
    }

    const completedPath = normalizeTerminalAbsolutePath(`${target.listPath}/${completedName}`);
    const suffix = matchingNames.length === 1 && await this.terminalPathIsDirectory(completedPath)
      ? '/'
      : matchingNames.length === 1 ? ' ' : '';
    const replacement = `${target.replacementPrefix}${completedName}${suffix}`;
    const nextInput = `${input.slice(0, start)}${replacement}${input.slice(end)}`;
    const nextCursor = start + replacement.length;
    return {
      input: nextInput,
      cursor: nextCursor,
      matches,
      replacementChanged: nextInput !== input || nextCursor !== boundedCursor,
    };
  }

  private readProcFile(path: string, encoding?: RuntimeFileEncoding, options: { publicView?: boolean } = {}): string | null {
    const procPath = normalizeProcPath(path);
    if (procPath === null) return null;
    if (encoding === 'base64') {
      throw new Error(`Kernel proc path does not support base64 reads: ${path}`);
    }
    try {
      const dynamicFile = this.readDynamicProcFile(procPath);
      if (dynamicFile !== null) return dynamicFile;
      return options.publicView === false
        ? readRuntimeProcFile(procPath, this.kernelInfo)
        : readPublicRuntimeProcFile(procPath, this.kernelInfo);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') throw new Error(`Kernel proc path not found: ${path}`);
      throw error;
    }
  }

  private readDeviceFile(path: string, encoding?: RuntimeFileEncoding): string | null {
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'workspace' || readTarget.kind === 'proc-file' || readTarget.kind === 'proc-directory') return null;
    if (readTarget.kind === 'device-directory') throw new Error(`Kernel device path is a directory: ${path}`);
    if (readTarget.kind === 'error') throwKernelReadTargetError(path, readTarget);
    if (encoding === 'base64') return base64FromBytes(new TextEncoder().encode(this.readDevice(readTarget.path)));
    return this.readDevice(readTarget.path);
  }

  private readDevice(device: RuntimeKernelDevicePath): string {
    if (!runtimeKernelDeviceInputRoute(undefined, device)) return '';
    const stdinPipe = this.currentCommandContext()?.stdinPipe;
    if (stdinPipe) {
      let text = '';
      while (true) {
        const chunk = readRuntimeCommandStdinPipeBytes(stdinPipe);
        if (chunk.byteLength > 0) {
          text += decodeUtf8(chunk) ?? Array.from(chunk, (byte) => String.fromCharCode(byte)).join('');
          continue;
        }
        if (runtimeCommandStdinPipeClosed(stdinPipe)) break;
        break;
      }
      return text;
    }
    return '';
  }

  private writeDevice(device: RuntimeKernelDevicePath, data: string, actor?: RuntimeWorkspaceActor): void {
    const route = runtimeKernelDeviceOutputRoute(undefined, device);
    if (!route) {
      if (runtimeDeviceOutputTarget(device) === '/dev/null') return;
      throw new Error(`Kernel device is read-only: ${device}`);
    }
    const commandContext = this.currentCommandContext();
    if (commandContext) {
      this.captureDeviceOutput(commandContext, route.stream, data);
    }
    this.emitLocalRuntimeEvent({
      type: 'output',
      stream: route.stream,
      device: route.outputDevice,
      ...(route.sourceDevice ? { sourceDevice: route.sourceDevice } : {}),
      data,
      ...(actor ? { actor } : {}),
    });
  }

  private captureDeviceOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): void {
    const chunk = this.captureCommandOutput(context, stream, data);
    if (stream === 'stdout') context.deviceStdout += chunk;
    if (stream === 'stderr') context.deviceStderr += chunk;
  }

  private captureCommandOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): string {
    if (!data || context.truncatedOutputStreams.has(stream)) return '';
    const used = context.outputBytes[stream];
    const remaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = runtimeProjectUtf8Bytes(data);
    if (bytes <= remaining) {
      context.outputBytes[stream] = used + bytes;
      return data;
    }
    context.truncatedOutputStreams.add(stream);
    const marker = `\n[tracekernel: ${stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
    const chunk = `${runtimeProjectTruncateUtf8(data, Math.max(0, remaining))}${marker}`;
    context.outputBytes[stream] = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + runtimeProjectUtf8Bytes(marker);
    return chunk;
  }

  private captureReturnedOutput(
    context: RuntimeCommandExecutionContext,
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>
  ): Pick<RuntimeCommandResult, 'stdout' | 'stderr'> {
    return {
      stdout: this.captureCommandOutput(context, 'stdout', result.stdout),
      stderr: this.captureCommandOutput(context, 'stderr', result.stderr),
    };
  }

  private async writeFileAs(
    path: string,
    contents: string,
    actor: RuntimeWorkspaceActor,
    encoding?: RuntimeFileEncoding,
    phase: RuntimeFileMutationPhase = 'live'
  ): Promise<void> {
    this.assertWorkspaceUsableForMutation('write');
    this.assertDynamicVirtualWritable(path, 'write');
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      const normalizedEncoding = assertSupportedEncoding(encoding);
      this.writeDevice(
        writeTarget.device,
        normalizedEncoding === 'base64'
          ? new TextDecoder().decode(bytesFromBase64(contents))
          : contents,
        actor
      );
      return;
    }
    const normalizedEncoding = assertSupportedEncoding(encoding);
    const absolutePath = this.toWorkspacePath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.bash.fs.exists(absolutePath) ? 'file-write' : 'file-create';
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'write');
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      await fs.writeFile(
        absolutePath,
        normalizedEncoding === 'base64' ? bytesFromBase64(contents) : contents
      );
    }, mutationKind);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: {
        path: toProjectPath(this.cwd, absolutePath),
        contents,
        ...(normalizedEncoding === 'base64' ? { encoding: 'base64' as const } : {}),
      },
      phase,
      actor,
    });
  }

  async writeFiles(files: readonly RuntimeFile[]): Promise<void> {
    for (const file of files) {
      await this.writeFile(file.path, file.contents, file.encoding);
    }
  }

  async writeSkillFiles(files: readonly RuntimeFile[]): Promise<void> {
    await this.writeSkillFilesAs(files, SYSTEM_ACTOR);
  }

  private async writeSkillFilesAs(
    files: readonly RuntimeFile[],
    _actor: RuntimeWorkspaceActor = SYSTEM_ACTOR
  ): Promise<void> {
    this.assertNotDestroyed();
    const nextFiles = new Map(this.skillFiles);
    for (const file of files) {
      const normalized = this.normalizeSkillFile(file);
      for (const existingPath of nextFiles.keys()) {
        if (existingPath === normalized.path) continue;
        if (existingPath.startsWith(`${normalized.path}/`) || normalized.path.startsWith(`${existingPath}/`)) {
          throw new Error(`Skill path conflicts with an existing skill path: ${runtimeSkillAbsolutePath(normalized.path)}`);
        }
      }
      nextFiles.set(normalized.path, normalized);
    }
    this.skillFiles.clear();
    for (const [path, file] of nextFiles) this.skillFiles.set(path, file);
  }

  async appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
    this.assertWorkspaceUsableForMutation('append');
    this.assertDynamicVirtualWritable(path, 'append');
    const normalizedEncoding = assertSupportedEncoding(encoding);
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(
        writeTarget.device,
        normalizedEncoding === 'base64'
          ? new TextDecoder().decode(bytesFromBase64(contents))
          : contents,
        PRINCIPAL_ACTOR
      );
      return;
    }
    const absolutePath = this.toWorkspacePath(path);
    const mutationKind: RuntimeFileSystemMutationKind = await this.bash.fs.exists(absolutePath) ? 'file-write' : 'file-create';
    const nextBytes = normalizedEncoding === 'base64'
      ? bytesFromBase64(contents)
      : new TextEncoder().encode(contents);
    const bytes = await this.fs.withBaseMutation([absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'append');
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      await fs.appendFile(absolutePath, nextBytes);
      return fs.readFileBuffer(absolutePath);
    }, mutationKind);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: normalizedEncoding === 'base64'
        ? { path: toProjectPath(this.cwd, absolutePath), contents: base64FromBytes(bytes), encoding: 'base64' }
        : { path: toProjectPath(this.cwd, absolutePath), contents: new TextDecoder().decode(bytes) },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async readFile(path: string, encoding?: RuntimeFileEncoding, options: { publicProc?: boolean } = {}): Promise<string> {
    this.assertNotDestroyed();
    const dynamicVirtualFile = this.readDynamicVirtualFile(path);
    if (dynamicVirtualFile !== null) {
      if (encoding === 'base64') throw new Error(`Kernel virtual path does not support base64 reads: ${path}`);
      return dynamicVirtualFile;
    }
    const procFile = this.readProcFile(path, encoding, { publicView: options.publicProc !== false });
    if (procFile !== null) return procFile;
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'proc-file') {
      if (encoding === 'base64') throw new Error(`Kernel proc path does not support base64 reads: ${path}`);
      return options.publicProc === false
        ? readRuntimeProcFile(readTarget.path, this.kernelInfo)
        : readPublicRuntimeProcFile(readTarget.path, this.kernelInfo);
    }
    if (readTarget.kind === 'proc-directory') throw new Error(`Kernel proc path is a directory: ${path}`);
    if (readTarget.kind === 'device-file') {
      if (encoding === 'base64') return base64FromBytes(new TextEncoder().encode(this.readDevice(readTarget.path)));
      return this.readDevice(readTarget.path);
    }
    if (readTarget.kind === 'device-directory') throw new Error(`Kernel device path is a directory: ${path}`);
    if (readTarget.kind === 'error') throwKernelReadTargetError(path, readTarget);
    const normalizedEncoding = assertSupportedEncoding(encoding);
    const absolutePath = this.toWorkspacePath(path);
    this.assertWorkspacePathVisible(absolutePath, 'open');
    if (normalizedEncoding === 'base64') {
      const bytes = await this.bash.fs.readFileBuffer(absolutePath);
      return base64FromBytes(bytes);
    }
    return this.bash.fs.readFile(absolutePath);
  }

  async exists(path: string): Promise<boolean> {
    this.assertNotDestroyed();
    if (this.dynamicVirtualEntryKind(path) !== null) return true;
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return true;
    if (accessTarget.kind === 'denied') return false;
    const absolutePath = this.toWorkspaceEntryPath(path);
    if (this.isWorkspacePathHidden(absolutePath)) return false;
    return this.bash.fs.exists(absolutePath);
  }

  async stat(path: string): Promise<RuntimeWorkspaceStat> {
    this.assertNotDestroyed();
    const dynamicStat = this.dynamicVirtualStat(path);
    if (dynamicStat) return {
      isFile: dynamicStat.isFile,
      isDirectory: dynamicStat.isDirectory,
      mode: dynamicStat.mode,
      size: dynamicStat.size,
      mtimeMs: 0,
      nlink: dynamicStat.isDirectory ? 2 : 1,
      uid: dynamicStat.uid,
      gid: dynamicStat.gid,
      owner: dynamicStat.owner,
      group: dynamicStat.group,
    };
    const statTarget = kernelStatTarget(path, this.kernelInfo);
    if (statTarget.kind === 'stat') {
      return {
        isFile: statTarget.stat.isFile,
        isDirectory: statTarget.stat.isDirectory,
        mode: statTarget.stat.mode,
        size: statTarget.stat.size,
        mtimeMs: 0,
        nlink: statTarget.stat.isDirectory ? 2 : 1,
        uid: statTarget.stat.uid,
        gid: statTarget.stat.gid,
        owner: statTarget.stat.owner,
        group: statTarget.stat.group,
      };
    }
    if (statTarget.kind === 'error') throw new Error(`Kernel virtual path not found: ${path}`);
    const absolutePath = this.toWorkspaceEntryPath(path);
    this.assertWorkspacePathVisible(absolutePath, 'stat');
    const stat = await this.bash.fs.stat(absolutePath);
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtime instanceof Date ? stat.mtime.getTime() : undefined,
      nlink: typeof (stat as { nlink?: unknown }).nlink === 'number' ? (stat as { nlink?: number }).nlink : 1,
      ino: this.fs.inodeForPath(absolutePath),
    };
  }

  async readDir(path = '.'): Promise<string[]> {
    this.assertNotDestroyed();
    const dynamicEntries = this.readDynamicVirtualDir(path);
    if (dynamicEntries) return dynamicEntries.map((entry) => entry.name);
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return directoryTarget.entries.map((entry) => entry.name);
    if (directoryTarget.kind === 'error') {
      throw new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      );
    }
    const absoluteDirectoryPath = this.toWorkspaceEntryPath(path);
    this.assertWorkspacePathVisible(absoluteDirectoryPath, 'scandir');
    const entries = await this.bash.fs.readdir(absoluteDirectoryPath);
    const directoryPath = absoluteDirectoryPath === this.cwd ? '' : toProjectPath(this.cwd, absoluteDirectoryPath);
    return [...entries]
      .filter((entry) => {
        const entryPath = directoryPath ? `${directoryPath}/${entry}` : entry;
        return !this.isProjectPathHidden(entryPath);
      })
      .sort((left, right) => left.localeCompare(right));
  }

  async mkdir(path: string): Promise<void> {
    this.assertWorkspaceUsableForMutation('mkdir');
    this.assertDynamicVirtualWritable(path, 'mkdir');
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') throwKernelMutationTargetError(path, mkdirTarget);
    const absolutePath = this.toWorkspaceEntryPath(path);
    let createdDirectories: string[] = [];
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      createdDirectories = await this.collectMissingWorkspaceDirectories(absolutePath);
      await fs.mkdir(absolutePath, { recursive: true });
    }, 'directory-create');
    for (const relativePath of createdDirectories) {
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change: { path: relativePath, directory: true },
        phase: 'live',
        actor: PRINCIPAL_ACTOR,
      });
    }
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    this.assertWorkspaceUsableForMutation('copy');
    this.assertDynamicVirtualWritable(destinationPath, 'copy');
    const dynamicSourceFile = this.readDynamicVirtualFile(sourcePath);
    if (dynamicSourceFile !== null) {
      await this.writeFileAs(destinationPath, dynamicSourceFile, PRINCIPAL_ACTOR, undefined, 'live');
      return;
    }
    const copyTarget = kernelFileCopyTarget(sourcePath, destinationPath);
    if (copyTarget.kind === 'virtual-source' || copyTarget.kind === 'device-destination') {
      await this.copyFileLike(sourcePath, destinationPath, copyTarget);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : copyTarget.side === 'destination'
            ? `Kernel virtual destination is not writable: ${destinationPath}`
            : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    const absoluteDestinationPath = this.toWorkspacePath(destinationPath);
    const absoluteSourcePath = this.toWorkspacePath(sourcePath);
    this.assertWorkspacePathVisible(absoluteSourcePath, 'open');
    const sourceBytes = await this.fs.withBaseMutation(
      [absoluteSourcePath, absoluteDestinationPath],
      async (fs) => {
        this.assertWorkspacePathWritable(absoluteDestinationPath, 'copy');
        const bytes = await fs.readFileBuffer(absoluteSourcePath);
        await fs.mkdir(dirname(absoluteDestinationPath), { recursive: true });
        await fs.writeFile(absoluteDestinationPath, bytes);
        return bytes;
      },
      'copy'
    );
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: toProjectPath(this.cwd, absoluteDestinationPath), contents: base64FromBytes(sourceBytes), encoding: 'base64' },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  private async copyFileLike(
    sourcePath: string,
    destinationPath: string,
    copyTarget: Exclude<ReturnType<typeof runtimeKernelFileCopyTarget>, { kind: 'workspace' | 'error' }>
  ): Promise<void> {
    const sourceBytes = await this.readKernelCopyBytes(sourcePath, copyTarget.source);
    if (copyTarget.kind === 'device-destination') {
      this.writeDevice(copyTarget.device, contentToText(sourceBytes), PRINCIPAL_ACTOR);
      return;
    }
    await this.writeFileAs(destinationPath, base64FromBytes(sourceBytes), PRINCIPAL_ACTOR, 'base64', 'live');
  }

  private async readKernelCopyBytes(
    sourcePath: string,
    sourceTarget: ReturnType<typeof runtimeKernelFileReadTarget> = kernelFileReadTarget(sourcePath)
  ): Promise<Uint8Array> {
    const dynamicSourceFile = this.readDynamicVirtualFile(sourcePath);
    if (dynamicSourceFile !== null) return new TextEncoder().encode(dynamicSourceFile);
    if (sourceTarget.kind === 'device-file') return new TextEncoder().encode(this.readDevice(sourceTarget.path));
    if (sourceTarget.kind === 'proc-file') return new TextEncoder().encode(readPublicRuntimeProcFile(sourceTarget.path, this.kernelInfo));
    if (sourceTarget.kind === 'error') {
      throw new Error(
        sourceTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    const absolutePath = this.toWorkspacePath(sourcePath);
    this.assertWorkspacePathVisible(absolutePath, 'open');
    return this.bash.fs.readFileBuffer(absolutePath);
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    this.assertWorkspaceUsableForMutation('move');
    this.assertDynamicVirtualWritable(sourcePath, 'move');
    this.assertDynamicVirtualWritable(destinationPath, 'move');
    const renameTarget = kernelRenameTarget(sourcePath, destinationPath);
    if (renameTarget.kind === 'error') throw new Error('Kernel virtual paths are read-only for move operations.');
    const absoluteSourcePath = this.toWorkspacePath(sourcePath);
    const absoluteDestinationPath = this.toWorkspacePath(destinationPath);
    let sourceBytes = new Uint8Array() as Awaited<ReturnType<IFileSystem['readFileBuffer']>>;
    await this.fs.withBaseMutation([absoluteSourcePath, absoluteDestinationPath], async (fs) => {
      this.assertWorkspaceSubtreeWritable(this.toWorkspaceEntryPath(sourcePath), 'move');
      this.assertWorkspaceSubtreeWritable(this.toWorkspaceEntryPath(destinationPath), 'move');
      this.assertWorkspacePathWritable(absoluteDestinationPath, 'move');
      sourceBytes = await fs.readFileBuffer(absoluteSourcePath);
      await fs.mkdir(dirname(absoluteDestinationPath), { recursive: true });
      await fs.writeFile(absoluteDestinationPath, sourceBytes);
      await fs.rm(absoluteSourcePath, { force: true });
    }, 'rename');
    this.fs.moveInode(absoluteSourcePath, absoluteDestinationPath);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: toProjectPath(this.cwd, absoluteDestinationPath), contents: base64FromBytes(sourceBytes), encoding: 'base64' },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: this.toWorkspaceRelativePath(sourcePath), deleted: true },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async deleteFile(path: string): Promise<void> {
    this.assertWorkspaceUsableForMutation('delete');
    this.assertDynamicVirtualWritable(path, 'delete');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const absolutePath = this.toWorkspacePath(path);
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'delete');
      await fs.rm(absolutePath, { force: true });
    }, 'delete');
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: this.toWorkspaceRelativePath(path), deleted: true },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async remove(path: string, options: RuntimeWorkspaceRemoveOptions = {}): Promise<void> {
    this.assertWorkspaceUsableForMutation('remove');
    this.assertDynamicVirtualWritable(path, 'remove');
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    let deletedChanges: RuntimeFileChange[] = [];
    const absolutePath = this.toWorkspaceEntryPath(path);
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      deletedChanges = await this.collectDeletedChangesForRemove(path, options, fs);
      this.assertWorkspaceSubtreeWritable(absolutePath, 'remove');
      await fs.rm(absolutePath, {
        force: options.force ?? true,
        recursive: options.recursive,
      });
    }, options.recursive ? 'recursive-delete' : 'delete');
    for (const change of deletedChanges) {
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change,
        phase: 'live',
        actor: PRINCIPAL_ACTOR,
      });
    }
  }

  async runCommand(command: string, options: RuntimeCommandOptions = {}): Promise<RuntimeCommandResult> {
    const unusable = this.assertWorkspaceUsableForRun(command);
    if (unusable) return unusable;
    const commandCwd = options.cwd ? this.resolveCommandCwd(options.cwd) : this.cwd;
    const stdinPipe = options.stdinPipe;
    const actor = this.createRuntimeActor();
    const abortController = new AbortController();
    const parentProcess = this.currentCommandContext()?.process;
    const pid = this.nextPid++;
    const terminalPresentation = options.presentation === 'terminal';
    const foreground = options.foreground ?? terminalPresentation;
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: parentProcess?.pid ?? 1,
      pgid: parentProcess?.pgid ?? pid,
      sid: parentProcess?.sid ?? 1,
      fds: this.standardProcessFileDescriptors(),
      tty: terminalPresentation ? '/dev/tty' : '?',
      command,
      cwd: commandCwd,
      actor,
      startedAt: new Date().toISOString(),
      abortController,
      state: 'queued',
      foreground,
    };
    const commandContext: RuntimeCommandExecutionContext = {
      eventHandler: this.createCommandEventHandler(options),
      actor,
      process,
      stdinPipe,
      includeHiddenFiles: options.includeHiddenFiles,
      runtimeIo: this.createRuntimeLiveIoController(actor, abortController.signal),
      generationBaseline: this.fs.snapshotGenerations(),
      mutatedGenerationPaths: new Set(),
      executableTransformCwd: commandCwd,
      deviceStdout: '',
      deviceStderr: '',
      outputBytes: { stdout: 0, stderr: 0 },
      truncatedOutputStreams: new Set(),
    };
    this.processTable.set(process.pid, process);
    this.recordKernelEvent('process-queue', process.pid, {
      ppid: process.ppid,
      pgid: process.pgid,
      sid: process.sid,
      command,
      cwd: commandCwd,
    });
    const cleanupExternalSignal = this.attachExternalSignal(process, options.signal);
    let processExitCode = 1;
    return this.commandScheduler.runCommand({ pid: process.pid, command, signal: abortController.signal }, () => this.commandExecutionContexts.run(commandContext, async () => {
      try {
        if (process.signal) {
          const result = this.signalCommandResult(process);
          const output = this.captureReturnedOutput(commandContext, result);
          processExitCode = result.exitCode;
          this.emitReturnedOutputEvents(output);
          return { ...result, ...output };
        }
        process.state = 'running';
        const schedulerSnapshot = this.commandScheduler.snapshot();
        this.recordKernelEvent('process-admit', process.pid, {
          running: schedulerSnapshot.running,
          queued: schedulerSnapshot.queued,
          maxConcurrentCommands: schedulerSnapshot.maxConcurrentCommands,
          maxQueuedCommands: schedulerSnapshot.maxQueuedCommands ?? 'unlimited',
        });
        this.recordKernelEvent('process-start', process.pid, {
          ppid: process.ppid,
          pgid: process.pgid,
          sid: process.sid,
          command,
          cwd: commandCwd,
        });
        const directExecutableResult = await this.tryRunVirtualExecutable(command, { ...options, stdinPipe, signal: abortController.signal });
        if (directExecutableResult) {
          await this.flushRuntimeEventQueue();
          const output = this.captureReturnedOutput(commandContext, directExecutableResult);
          this.emitReturnedOutputEvents(output);
          processExitCode = directExecutableResult.exitCode;
          return {
            ...directExecutableResult,
            ...output,
            ...(!directExecutableResult.error && process.signal ? { error: this.signalCommandError(process) } : {}),
          };
        }

        const result = await this.createBash(options.executionLimits).exec(command, {
          cwd: commandCwd,
          env: options.env,
          signal: abortController.signal,
          args: options.args,
        });
        await this.flushRuntimeEventQueue();
        const output = this.captureReturnedOutput(commandContext, result);
        this.emitReturnedOutputEvents(output);
        processExitCode = result.exitCode;
        if (commandContext.kernelError?.code === 'EINTR' && process.signal) {
          const signalResult = this.signalCommandResult(process);
          processExitCode = signalResult.exitCode;
          return signalResult;
        }
        return {
          stdout: `${output.stdout}${commandContext.deviceStdout}`,
          stderr: `${output.stderr}${commandContext.deviceStderr}`,
          exitCode: result.exitCode,
          ...(commandContext.kernelError ? { error: commandContext.kernelError } : {}),
          ...(!commandContext.kernelError && (result as RuntimeCommandResult).error ? { error: (result as RuntimeCommandResult).error } : {}),
          ...(!commandContext.kernelError && !(result as RuntimeCommandResult).error && process.signal ? { error: this.signalCommandError(process) } : {}),
        };
      } catch (error) {
        if (!process.signal && abortController.signal.aborted) {
          this.signalProcess(process, 'SIGTERM');
        }
        if (process.signal) {
          const result = this.signalCommandResult(process);
          const output = this.captureReturnedOutput(commandContext, result);
          processExitCode = result.exitCode;
          await this.flushRuntimeEventQueue();
          this.emitReturnedOutputEvents(output);
          return { ...result, ...output };
        }
        throw error;
      }
    })).catch((error) => {
      if (process.signal) {
        const result = this.signalCommandResult(process);
        const output = this.captureReturnedOutput(commandContext, result);
        processExitCode = result.exitCode;
        this.emitReturnedOutputEvents(output);
        return { ...result, ...output };
      }
      if (error instanceof RuntimeKernelAdmissionRejectedError) {
        const commandError = error.toCommandError();
        processExitCode = error.errno;
        this.recordKernelEvent('process-reject', process.pid, {
          command,
          code: commandError.code,
          message: commandError.message,
          running: this.commandScheduler.snapshot().running,
          queued: this.commandScheduler.snapshot().queued,
        });
        return {
          stdout: '',
          stderr: `${error.message}\n`,
          exitCode: error.errno,
          error: commandError,
        };
      }
      throw error;
    }).finally(() => {
      this.closeHttpListenersForProcess(process.pid);
      cleanupExternalSignal?.();
      const retainProcessOnExit = process.signal || options.retainOnExit === true;
      process.state = retainProcessOnExit ? 'zombie' : 'exited';
      process.exitCode = processExitCode;
      process.endedAt = new Date().toISOString();
      this.processTable.delete(process.pid);
      if (retainProcessOnExit) {
        this.zombieProcessTable.set(process.pid, { process, expiresAtMs: Date.now() + TRACEKERNEL_ZOMBIE_RETENTION_MS });
        this.recordKernelEvent('process-zombie', process.pid, {
          exitCode: process.exitCode,
          signal: process.signal,
          signalCode: process.signalCode,
        });
        this.notifyZombieProcess(process);
      } else {
        this.recordKernelEvent('process-exit', process.pid, { exitCode: process.exitCode });
      }
    });
  }

  private effectiveCommandExecutionLimits(
    override?: RuntimeCommandExecutionLimits
  ): RuntimeCommandExecutionLimits | undefined {
    return override ?? (this.bashOptions.executionLimits as RuntimeCommandExecutionLimits | undefined);
  }

  private finiteMaxCommandCount(limits: RuntimeCommandExecutionLimits | undefined): number | undefined {
    const value = limits?.maxCommandCount;
    return Number.isFinite(value) ? Math.max(1, Math.floor(Number(value))) : undefined;
  }

  private projectCommandStepLimit(limits: RuntimeCommandExecutionLimits | undefined): number {
    const maxCommandCount = this.finiteMaxCommandCount(limits);
    return maxCommandCount === undefined
      ? TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS
      : Math.min(TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS, maxCommandCount);
  }

  private projectCommandStepExecutionLimits(
    limits: RuntimeCommandExecutionLimits | undefined,
    stepCount: number
  ): RuntimeCommandExecutionLimits | undefined {
    const maxCommandCount = this.finiteMaxCommandCount(limits);
    if (maxCommandCount === undefined) return limits;
    return {
      ...limits,
      maxCommandCount: Math.max(1, Math.floor(maxCommandCount / stepCount)),
    };
  }

  async runProjectCommand(name: string, options: RuntimeProjectCommandOptions = {}): Promise<RuntimeCommandResult> {
    const unusable = this.assertWorkspaceUsableForRun(name);
    if (unusable) return unusable;
    const command = this.projectSession?.commands[name];
    if (!command) {
      return {
        stdout: '',
        stderr: `Project command not found: ${name}\n`,
        exitCode: 127,
      };
    }
    if (command.hidden === true && options.allowHidden !== true) {
      return {
        stdout: '',
        stderr: `Project command is hidden: ${name}\n`,
        exitCode: 403,
      };
    }
    const runStep = (
      step: RuntimeProjectSessionCommandStep,
      executionLimits?: RuntimeCommandExecutionLimits
    ): Promise<RuntimeCommandResult> => {
      const commandCwd = options.cwd ?? step.cwd;
      return this.runCommand(step.command, {
        ...options,
        ...(executionLimits ? { executionLimits } : {}),
        cwd: commandCwd
          ? this.resolveTerminalPath(this.cwd, commandCwd)
          : this.projectSession?.cwd,
        env: {
          ...(this.projectSession?.env ?? {}),
          ...(step.env ?? {}),
          ...(options.env ?? {}),
        },
      });
    };
    if (!('steps' in command)) {
      return runStep(command);
    }
    const commandLimits = this.effectiveCommandExecutionLimits(options.executionLimits);
    const maxStepCount = this.projectCommandStepLimit(commandLimits);
    if (command.steps.length > maxStepCount) {
      return {
        stdout: '',
        stderr: `Project command has too many steps: ${name} (${command.steps.length}/${maxStepCount})\n`,
        exitCode: 2,
      };
    }
    const stepExecutionLimits = this.projectCommandStepExecutionLimits(commandLimits, command.steps.length);
    const files: RuntimeFileChange[] = [];
    let stdout = '';
    let stderr = '';
    for (const [stepIndex, step] of command.steps.entries()) {
      this.emitCommandOptionEvent(options, {
        type: 'status',
        phase: 'project-step-start',
        message: `Starting project command step ${stepIndex + 1}/${command.steps.length}`,
        detail: {
          command: name,
          step: stepIndex + 1,
          stepCount: command.steps.length,
          shellCommand: step.command,
          ...(step.cwd ? { cwd: this.resolveTerminalPath(this.cwd, step.cwd) } : {}),
        },
        actor: SYSTEM_ACTOR,
      });
      const result = await runStep(step, stepExecutionLimits);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.files) files.push(...result.files);
      this.emitCommandOptionEvent(options, {
        type: 'status',
        phase: 'project-step-end',
        message: `Finished project command step ${stepIndex + 1}/${command.steps.length}`,
        detail: {
          command: name,
          step: stepIndex + 1,
          stepCount: command.steps.length,
          shellCommand: step.command,
          exitCode: result.exitCode,
        },
        actor: SYSTEM_ACTOR,
      });
      if (result.exitCode !== 0) {
        return {
          stdout,
          stderr,
          exitCode: result.exitCode,
          ...(files.length ? { files } : {}),
        };
      }
    }
    return {
      stdout,
      stderr,
      exitCode: 0,
      ...(files.length ? { files } : {}),
    };
  }

  createTerminalSession(options: RuntimeProjectTerminalSessionOptions = {}): RuntimeProjectTerminalSession {
    this.assertNotDestroyed();
    return new RuntimeProjectWorkspaceTerminalSession(
      {
        workspaceRoot: this.cwd,
        kernelInfo: this.kernelInfo,
        resolveCwd: (currentCwd, target) => this.resolveTerminalCwd(currentCwd, target),
        runCommand: (command, commandOptions) => this.runCommand(command, commandOptions),
        jobRecords: () => this.terminalJobRecords(),
        isVerbose: () => this.terminalVerbose,
      },
      {
        ...options,
        cwd: options.cwd ? this.resolveTerminalPath(this.cwd, options.cwd) : this.cwd,
      }
    );
  }

  async checkExpiration(now: Date | string | number = new Date()): Promise<RuntimeProjectSessionLifecycle | null> {
    this.assertNotDestroyed();
    if (!this.projectSession?.lifecycle.expiresAt) return this.projectSession?.lifecycle ?? null;
    if (this.projectSession.lifecycle.expiredAt) return this.projectSession.lifecycle;
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const expiresTime = new Date(this.projectSession.lifecycle.expiresAt).getTime();
    if (Number.isNaN(nowTime) || Number.isNaN(expiresTime) || nowTime < expiresTime) {
      return this.projectSession.lifecycle;
    }
    this.projectSession.lifecycle.expiredAt = new Date(nowTime).toISOString();
    this.emitRuntimeEvent({
      type: 'lifecycle',
      phase: 'session-expired',
      message: 'Project session expired',
      detail: {
        sessionId: this.projectSession.id,
        expiresAt: this.projectSession.lifecycle.expiresAt,
        expiredAt: this.projectSession.lifecycle.expiredAt,
        expirationBehavior: this.projectSession.lifecycle.expirationBehavior,
      },
      actor: SYSTEM_ACTOR,
    });
    if (this.projectSession.lifecycle.expirationBehavior === 'destroy') {
      await this.destroy({ reason: 'expired', clearStorage: true });
    }
    return this.projectSession.lifecycle;
  }

  async destroy(options: { reason?: string; clearStorage?: boolean } = {}): Promise<void> {
    await this.commandScheduler.runBarrier(() => this.destroyNow(options));
  }

  private async destroyNow(options: { reason?: string; clearStorage?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    if (this.projectSession) {
      this.projectSession.lifecycle.destroyedAt = new Date().toISOString();
    }
    this.emitRuntimeEvent({
      type: 'lifecycle',
      phase: 'session-destroyed',
      message: 'Project session destroyed',
      detail: {
        reason: options.reason ?? 'destroy',
        clearStorage: options.clearStorage === true,
        ...(this.projectSession ? { sessionId: this.projectSession.id } : {}),
      },
      actor: SYSTEM_ACTOR,
    });
    this.eventWatchers.clear();
    await this.withSuspendedReadonlyPolicy(() =>
      this.fs.withBaseMutation([this.cwd], (fs) => fs.rm(this.cwd, { force: true, recursive: true }), 'recursive-delete')
    );
    this.httpListeners.clear();
    this.processTable.clear();
    this.zombieProcessTable.clear();
    this.processWaiters.clear();
    this.anyProcessWaiters.splice(0);
    this.recordKernelEvent('kernel-destroy', 1, { reason: options.reason ?? 'destroy', clearStorage: options.clearStorage === true });
    this.destroyed = true;
  }

  private async tryRunVirtualExecutable(
    command: string,
    options: RuntimeCommandOptions
  ): Promise<RuntimeCommandResult | null> {
    if (!this.hasVirtualExecutableLoaders() || options.args !== undefined) return null;

    const words = parseSimpleCommandWords(command);
    if (!words || words.length === 0) return null;
    if (traceKernelBinCommandName(words[0] ?? '')) return null;

    const cwd = options.cwd ? this.resolveCommandCwd(options.cwd) : this.cwd;
    if (!isWithinWorkspace(this.cwd, cwd)) return null;
    const env = {
      ...this.bash.getEnv(),
      ...(options.env ?? {}),
    };
    const ctx = {
      fs: this.bash.fs,
      cwd,
      env: new Map(Object.entries(env)),
      stdin: '',
    } as unknown as CommandContext;
    let expandedInvocation: { scriptFile: string | null; scriptArgs: string[] };
    try {
      expandedInvocation = await expandParsedScriptInvocation(ctx, this.cwd, words[0] ?? null, words.slice(1), this.kernelInfo.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }

    const executable = expandedInvocation.scriptFile;
    if (!executable || (!executable.includes('/') && !executable.startsWith('/'))) return null;

    return this.executeVirtualExecutable({
      executable,
      args: expandedInvocation.scriptArgs,
      cwd,
      env,
      stdinPipe: options.stdinPipe,
      preserveScriptPath: false,
    });
  }

  private async executeVirtualExecutable(request: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdinPipe?: RuntimeCommandOptions['stdinPipe'];
    preserveScriptPath: boolean;
  }): Promise<RuntimeCommandResult | null> {
    const executablePath = toProjectPath(this.cwd, resolveWorkspaceCommandPath(this.cwd, request.cwd, request.executable, this.kernelInfo.workspaceAlias));
    const record = this.virtualExecutableRecords.get(executablePath);
    if (!record) return null;

    if (record.kind !== 'cpp' || !this.cppRunner) {
      return { stdout: '', stderr: `bash: ${request.executable}: Exec format error\n`, exitCode: 126 };
    }

    const scriptPath = request.preserveScriptPath
      ? request.executable
      : request.executable.startsWith('./') ? request.executable.slice(2) : request.executable;
    const result = await this.cppRunner({
      code: '',
      source: 'run',
      scriptPath,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      ...(request.stdinPipe ? { stdinPipe: { buffer: request.stdinPipe.buffer } } : {}),
      project: await this.snapshot({ includeHidden: true }),
      onEvent: (event) => {
        this.handleRuntimeCommandEvent(event);
      },
    });
    await this.flushRuntimeEventQueue();
    return applyWorkspaceCommandResultFiles(
      this,
      this.currentRuntimeIo()?.filterAppliedResultFiles(result) ?? result
    );
  }

  async snapshot(options: { entrypoint?: string; includeHidden?: boolean } = {}): Promise<RuntimeProjectSnapshot> {
    this.assertNotDestroyed();
    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    await this.collectFiles(this.cwd, files, directories);
    files.sort((left, right) => left.path.localeCompare(right.path));
    directories.sort((left, right) => left.localeCompare(right));
    const kernelFiles = await snapshotRuntimeKernelVirtualFiles(this.bash.fs, this.kernelInfo);
    const publicKernel = publicRuntimeKernelInfo(this.kernelInfo);
    const snapshot: RuntimeProjectSnapshot = {
      cwd: this.cwd,
      workspaceRoot: this.cwd,
      ...(this.kernelInfo.workspaceAlias ? { workspaceAlias: this.kernelInfo.workspaceAlias } : {}),
      kernel: publicKernel,
      kernelDevices: runtimeKernelVirtualDevices(),
      kernelFiles,
      files,
      ...(directories.length > 0 ? { directories } : {}),
      ...(this.projectSession?.readonlyFiles.length ? { readonlyFiles: [...this.projectSession.readonlyFiles] } : {}),
      ...(this.projectSession?.hiddenFiles.length ? { hiddenFiles: [...this.projectSession.hiddenFiles] } : {}),
      ...(options.entrypoint || this.entrypoint
        ? { entrypoint: options.entrypoint ? this.toWorkspaceRelativePath(options.entrypoint) : this.entrypoint }
        : {}),
    };
    return options.includeHidden ? snapshot : filterHiddenSnapshotFiles(snapshot, this.projectSession?.hiddenFiles);
  }

  async exportPatch(
    baseSnapshot: RuntimeProjectSnapshot,
    options: RuntimeProjectPatchOptions = {}
  ): Promise<RuntimeProjectPatch> {
    this.assertNotDestroyed();
    const base = await createRuntimeProjectPatchSnapshotView(baseSnapshot, 'Runtime project patch base snapshot');
    const current = await createRuntimeProjectPatchSnapshotView(await this.snapshot(), 'Runtime project patch current snapshot');
    const changes: RuntimeProjectPatchChange[] = [];

    for (const baseFile of [...base.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const currentFile = current.files.get(baseFile.path);
      if (!currentFile) {
        changes.push({ kind: 'delete', path: baseFile.path, baseHash: baseFile.hash });
      } else if (currentFile.hash !== baseFile.hash) {
        changes.push({
          kind: 'write',
          path: currentFile.path,
          contents: currentFile.contents,
          ...(currentFile.encoding === 'base64' ? { encoding: currentFile.encoding } : {}),
          baseHash: baseFile.hash,
        });
      }
    }

    for (const currentFile of [...current.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (!base.files.has(currentFile.path)) {
        changes.push({
          kind: 'write',
          path: currentFile.path,
          contents: currentFile.contents,
          ...(currentFile.encoding === 'base64' ? { encoding: currentFile.encoding } : {}),
          baseHash: null,
        });
      }
    }

    for (const directory of [...base.directories].sort((left, right) => right.localeCompare(left))) {
      if (!current.directories.has(directory)) changes.push({ kind: 'rmdir', path: directory });
    }
    for (const directory of [...current.directories].sort((left, right) => left.localeCompare(right))) {
      if (!base.directories.has(directory)) changes.push({ kind: 'mkdir', path: directory });
    }

    return {
      version: RUNTIME_PROJECT_PATCH_VERSION,
      base: {
        ...(options.base?.id ? { id: options.base.id } : {}),
        ...(options.base?.version ? { version: options.base.version } : {}),
        manifestHash: base.manifestHash,
      },
      changes: sortRuntimeProjectPatchChanges(changes),
    };
  }

  async importPatch(baseSnapshot: RuntimeProjectSnapshot, patch: RuntimeProjectPatch): Promise<void> {
    this.assertNotDestroyed();
    const normalizedPatch = normalizeRuntimeProjectPatch(patch);
    const base = await createRuntimeProjectPatchSnapshotView(baseSnapshot, 'Runtime project patch base snapshot');
    validateRuntimeProjectPatchAgainstBase(base, normalizedPatch);

    const current = await createRuntimeProjectPatchSnapshotView(await this.snapshot(), 'Runtime project patch current snapshot');
    if (current.manifestHash !== base.manifestHash) {
      throw staleRuntimeProjectPatchError(
        `current workspace manifest ${current.manifestHash} does not match patch base ${base.manifestHash}`
      );
    }

    const changes = runtimeProjectPatchChangesToFileChanges(normalizedPatch.changes);
    if (changes.length === 0) return;
    const actor = this.currentCommandActor() ?? SYSTEM_ACTOR;
    const committed = await this.fs.applyFinalDiffTransaction(changes, (change) =>
      prepareFinalDiffChange(this.cwd, change)
    );
    for (const change of committed) {
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change,
        phase: 'final-diff',
        actor,
      });
    }
  }

  dispose(): void {
    this.httpListeners.clear();
    this.eventWatchers.clear();
    // Native/just-bash workspaces currently own no external resources.
  }

  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe {
    this.eventWatchers.add(listener);
    return () => {
      this.eventWatchers.delete(listener);
    };
  }

  async applyKernelFileChange(
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase = 'final-diff',
    actor: RuntimeWorkspaceActor = this.currentCommandActor() ?? SYSTEM_ACTOR
  ): Promise<void> {
    await this.kernel.applyFileChange(change, actor, phase);
  }

  async applyFinalDiffResultFiles(result: RuntimeCommandResult): Promise<RuntimeCommandResult> {
    try {
      if (!result.files?.length) return result;
      const actor = this.currentCommandActor() ?? SYSTEM_ACTOR;
      const committed = await this.fs.applyFinalDiffTransaction(result.files, (file) =>
        prepareFinalDiffChange(this.cwd, file)
      );
      for (const file of committed) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: file,
          phase: 'final-diff',
          actor,
        });
      }
      const { files: _files, ...commandResult } = result;
      return commandResult;
    } catch (error) {
      if (isKernelReadonlyError(error) || isRuntimeFileGenerationConflict(error)) {
        this.recordKernelCommandError(error);
        return kernelCommandFailure(error);
      }
      throw error;
    }
  }

  private createKernel(): RuntimeWorkspaceKernel {
    return {
      info: this.kernelInfo,
      readFile: (path, _actor, encoding) => this.readFile(path, encoding, { publicProc: false }),
      writeFile: (path, contents, actor = PRINCIPAL_ACTOR, encoding) => this.writeFileAs(path, contents, actor, encoding, 'live'),
      writeSkillFiles: (files, actor = SYSTEM_ACTOR) => this.writeSkillFilesAs(files, actor),
      deleteFile: (path, actor = PRINCIPAL_ACTOR) => this.deleteFileAs(path, actor, 'live'),
      applyFileChange: async (change, actor = this.currentCommandActor() ?? SYSTEM_ACTOR, phase = 'final-diff') => {
        await withSuspendedFsNotifications(this.bash.fs, async () => {
          await this.applyFileChangeAs(change, actor, phase);
        });
      },
      snapshot: (options) => this.snapshot(options),
      watch: (listener) => this.watch(listener),
    };
  }

  private async applyFileChangeAs(
    change: RuntimeFileChange,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase
  ): Promise<void> {
    this.assertWorkspaceUsableForMutation('apply');
    await this.applyFileChangeToWorkspace(change, actor, phase, true);
  }

  private async deleteFileAs(
    path: string,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase
  ): Promise<void> {
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const relativePath = this.toWorkspaceRelativePath(path);
    const absolutePath = this.toWorkspacePath(path);
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'delete');
      await fs.rm(absolutePath, { force: true });
    }, 'delete');
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: relativePath, deleted: true },
      phase,
      actor,
    });
  }

  private createRuntimeActor(): RuntimeWorkspaceActor {
    return {
      id: `runtime:${this.nextCommandId++}`,
      kind: 'runtime',
      capabilities: {
        read: [`${this.cwd}/**`],
        write: [`${this.cwd}/**`],
        delete: [`${this.cwd}/**`],
        execute: true,
        http: runtimeWorkspaceHttpCapabilitiesPreset('workspace'),
      },
    };
  }

  private createRuntimeLiveIoController(actor?: RuntimeWorkspaceActor, signal?: AbortSignal): RuntimeProjectLiveIoController {
    return new RuntimeProjectLiveIoController({
      actor: actor ?? SYSTEM_ACTOR,
      applyFileChange: (change, phase) => this.applyRuntimeFileChangeSilently(change, phase),
      onEvent: (event) => this.emitRuntimeEvent(event),
      signal,
    });
  }

  private shouldEmitCommandOptionEvent(options: RuntimeCommandOptions, event: RuntimeCommandEvent): boolean {
    return options.presentation !== 'terminal' || event.type !== 'status' || this.terminalVerbose;
  }

  private createCommandEventHandler(options: RuntimeCommandOptions): RuntimeCommandEventHandler | undefined {
    if (!options.onEvent) return undefined;
    return (event) => {
      if (this.shouldEmitCommandOptionEvent(options, event)) {
        options.onEvent?.(event);
      }
    };
  }

  private emitCommandOptionEvent(options: RuntimeCommandOptions, event: RuntimeCommandEvent): void {
    if (this.shouldEmitCommandOptionEvent(options, event)) {
      options.onEvent?.(event);
    }
  }

  private handleRuntimeCommandEvent(event: RuntimeCommandEvent): void {
    const runtimeIo = this.currentRuntimeIo();
    if (runtimeIo) {
      runtimeIo.handleRuntimeEvent(event);
      return;
    }
    this.emitRuntimeEvent(event);
  }

  private async flushRuntimeEventQueue(): Promise<void> {
    await this.currentRuntimeIo()?.flush();
  }

  private async applyRuntimeFileChangeSilently(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): Promise<void> {
    await withSuspendedFsNotifications(this.bash.fs, async () => {
      await this.applyFileChangeToWorkspace(change, this.currentCommandActor() ?? SYSTEM_ACTOR, phase, false);
    });
  }

  private async applyFileChangeToWorkspace(
    change: RuntimeFileChange,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase,
    emit: boolean
  ): Promise<void> {
    const mutationTarget = kernelMutationTarget(change.path);
    if (mutationTarget.kind === 'error') {
      throwKernelMutationTargetError(change.path, mutationTarget, `Kernel device namespace is not a file-change target: ${change.path}`);
    }

    const relativePath = this.toWorkspaceRelativePath(change.path);
    if (isRuntimeDirectoryChange(change)) {
      const absolutePath = this.toWorkspaceEntryPath(change.path);
      await this.fs.withBaseMutation([absolutePath], async (fs) => {
        if (change.deleted === true) {
          this.assertWorkspaceSubtreeWritable(absolutePath, 'delete');
          await fs.rm(absolutePath, { force: true, recursive: true });
        } else {
          await fs.mkdir(absolutePath, { recursive: true });
        }
      }, change.deleted === true ? 'recursive-delete' : 'directory-create');
      if (emit) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: { path: relativePath, directory: true, ...(change.deleted === true ? { deleted: true } : {}) },
          phase,
          actor,
        });
      }
      return;
    }

    if ((change as RuntimeFileDeletion).deleted === true) {
      const absolutePath = this.toWorkspacePath(change.path);
      await this.fs.withBaseMutation([absolutePath], async (fs) => {
        this.assertWorkspacePathWritable(absolutePath, 'delete');
        await fs.rm(absolutePath, { force: true });
      }, 'delete');
      if (emit) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: { path: relativePath, deleted: true },
          phase,
          actor,
        });
      }
      return;
    }

    const changedFile = change as RuntimeFile;
    const normalizedEncoding = assertSupportedEncoding(changedFile.encoding);
    const absolutePath = this.toWorkspacePath(changedFile.path);
    if (this.isWorkspacePathReadOnly(absolutePath) && await this.runtimeFileChangeContentEquals(absolutePath, changedFile, normalizedEncoding)) {
      return;
    }
    const mutationKind: RuntimeFileSystemMutationKind = await this.bash.fs.exists(absolutePath) ? 'file-write' : 'file-create';
    await this.fs.withBaseMutation([absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'write');
      await fs.mkdir(dirname(absolutePath), { recursive: true });
      if (normalizedEncoding === 'base64') {
        await fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
      } else {
        await fs.writeFile(absolutePath, changedFile.contents);
      }
    }, mutationKind);
    if (emit) {
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change: { path: relativePath, contents: changedFile.contents, ...(normalizedEncoding === 'base64' ? { encoding: 'base64' as const } : {}) },
        phase,
        actor,
      });
    }
  }

  private async runtimeFileChangeContentEquals(
    absolutePath: string,
    changedFile: RuntimeFile,
    encoding: RuntimeFileEncoding
  ): Promise<boolean> {
    try {
      const current = await this.bash.fs.readFileBuffer(absolutePath);
      const next = encoding === 'base64'
        ? bytesFromBase64(changedFile.contents)
        : new TextEncoder().encode(changedFile.contents);
      return bytesEqual(current, next);
    } catch {
      return false;
    }
  }

  private emitLocalRuntimeEvent(event: RuntimeCommandEvent): void {
    const runtimeIo = this.currentRuntimeIo();
    if (runtimeIo) {
      runtimeIo.emit(event);
      return;
    }
    this.emitRuntimeEvent(event);
  }

  private emitRuntimeEvent(event: RuntimeCommandEvent): void {
    const commandContext = this.currentCommandContext();
    const actor = 'actor' in event && event.actor ? event.actor : commandContext?.actor;
    const enriched = this.enrichRuntimeEvent(event, actor);
    commandContext?.eventHandler?.(enriched);
    for (const watcher of this.eventWatchers) {
      watcher(enriched);
    }
  }

  private emitReturnedOutputEvents(result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>): void {
    this.currentRuntimeIo()?.emitMissingFinalOutput(result, (stream, data) => {
      this.emitLocalRuntimeEvent({
        type: 'output',
        stream,
        device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
        data,
      });
    });
  }

  private enrichRuntimeEvent(event: RuntimeCommandEvent, actor?: RuntimeWorkspaceActor): RuntimeWorkspaceEvent {
    if (event.type === 'output') {
      return {
        ...event,
        device: event.device ?? (event.stream === 'stdout' ? '/dev/stdout' : '/dev/stderr'),
        ...(actor && !event.actor ? { actor } : {}),
      };
    }
    if (event.type === 'file-change') {
      return {
        ...event,
        phase: event.phase ?? 'live',
        ...(actor && !event.actor ? { actor } : {}),
      };
    }
    return {
      ...event,
      ...(actor && !event.actor ? { actor } : {}),
    };
  }

  private async collectMissingWorkspaceDirectories(absolutePath: string): Promise<string[]> {
    if (!isWithinWorkspace(this.cwd, absolutePath) || absolutePath === this.cwd) return [];
    const relativeParts = toProjectPath(this.cwd, absolutePath).split('/').filter(Boolean);
    const missing: string[] = [];
    let current = this.cwd;
    for (const part of relativeParts) {
      current = `${current}/${part}`;
      if (!(await this.bash.fs.exists(current))) missing.push(toProjectPath(this.cwd, current));
    }
    return missing;
  }

  private async collectDeletedChangesForRemove(
    path: string,
    options: RuntimeWorkspaceRemoveOptions,
    fs: IFileSystem = this.bash.fs
  ): Promise<RuntimeFileChange[]> {
    const absolutePath = this.toWorkspaceEntryPath(path);
    if (!(await fs.exists(absolutePath))) return [];
    const stat = await fs.stat(absolutePath);
    if (stat.isFile) return [{ path: toProjectPath(this.cwd, absolutePath), deleted: true }];
    if (!stat.isDirectory || !options.recursive) return [];

    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    await collectSnapshotFiles(fs, this.cwd, absolutePath, files, directories);
    const directoryPath = toProjectDirectoryPath(this.cwd, absolutePath);
    const deletedDirectories = [
      ...directories,
      ...(directoryPath ? [directoryPath] : []),
    ].sort((left, right) => right.localeCompare(left));
    return [
      ...files.map((file): RuntimeFileDeletion => ({ path: file.path, deleted: true })),
      ...deletedDirectories.map((deletedPath): RuntimeDirectoryChange => ({
        path: deletedPath,
        directory: true,
        deleted: true,
      })),
    ];
  }

  private async collectFiles(absolutePath: string, files: RuntimeFile[], directories: string[]): Promise<void> {
    if (!isWithinWorkspace(this.cwd, absolutePath)) {
      throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
    }

    await collectSnapshotFiles(this.bash.fs, this.cwd, absolutePath, files, directories);
  }
}

export async function createRuntimeWorkspace(
  options: CreateRuntimeWorkspaceOptions = {}
): Promise<JustBashRuntimeWorkspace> {
  options = normalizeRuntimeWorkspaceOptions(options);
  const workspace = new JustBashRuntimeWorkspace(options);
  await workspace.ensureReady();
  if (options.skills) {
    await workspace.writeSkillFiles(options.skills);
  }
  if (options.directories) {
    for (const directory of options.directories) {
      await workspace.mkdir(directory);
    }
  }
  if (options.files) {
    await workspace.withSuspendedReadonlyPolicy(() => workspace.writeFiles(options.files ?? []));
  }
  return workspace;
}

export type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandEventStream,
  RuntimeCommandFileChangeEvent,
  RuntimeCommandOutputEvent,
  RuntimeCommandStatusEvent,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeKernelHostConfig,
  RuntimeKernelHostInfo,
  RuntimeKernelInfo,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpBodyInit,
  RuntimeKernelHttpBodyPayload,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelUserConfig,
  RuntimeKernelUserInfo,
  RuntimeKernelWorkspaceConfig,
  RuntimeKernelWorkspaceInfo,
  RuntimeTraceKernelSchedulerConfig,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeTraceKernelConfig,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectTerminalPrompt,
  RuntimeProjectTerminalEvent,
  RuntimeProjectTerminalEventHandler,
  RuntimeProjectTerminalInputState,
  RuntimeProjectTerminalInputStateReason,
  RuntimeProjectTerminalRunOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
  RuntimeProjectSession,
  RuntimeProjectSessionCommand,
  RuntimeProjectSessionCommandDefinition,
  RuntimeProjectSessionFile,
  RuntimeProjectSessionInfo,
  RuntimeProjectIoBridge,
  RuntimeProjectPatch,
  RuntimeProjectPatchBase,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchDirectoryCreate,
  RuntimeProjectPatchDirectoryDelete,
  RuntimeProjectPatchFileDelete,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectPatchOptions,
  RuntimeProjectWorkerBridgeOptions,
  RuntimeProjectSnapshot,
  RuntimeWorkspace,
  RuntimeWorkspaceActor,
  RuntimeWorkspaceActorKind,
  RuntimeWorkspaceCapabilities,
  RuntimeWorkspaceEvent,
  RuntimeWorkspaceEventHandler,
  RuntimeWorkspaceHttpClient,
  RuntimeWorkspaceHttpJsonRequestOptions,
  RuntimeWorkspaceHttpJsonResponse,
  RuntimeWorkspaceHttpRequestOptions,
  RuntimeWorkspaceKernel,
  RuntimeWorkspaceRemoveOptions,
  RuntimeWorkspaceStat,
  RuntimeWorkspaceUnsubscribe,
};

export {
  RuntimeProjectLiveIoController,
  createRuntimeProjectIoBridge,
  runRuntimeProjectWorkerBridge,
  runtimeHttpBodyBytes,
  runtimeHttpBodyFromBytes,
  runtimeHttpBodyFromText,
  runtimeHttpBodyText,
  runtimeHttpRequestBytes,
  runtimeHttpRequestText,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
};
