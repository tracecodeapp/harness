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
  createRuntimeProjectHiddenCommandAccess,
  createRuntimeProjectIoBridge,
  peekRuntimeCommandStdinPipeBytes,
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES,
  RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES,
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
  writeRuntimeCommandStdinPipeBytes,
  runtimeProjectUtf8Bytes,
  RuntimeProjectLiveIoController,
  runtimeFileChangePath,
  runRuntimeProjectWorkerBridge,
  isRuntimeProjectHiddenCommandAccess,
} from '@tracecode/harness-core';
import {
  createDefaultExternalHttpFetch,
  isBlockedExternalHttpHost,
  RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES,
  type RuntimeExternalHttpConfig,
  type RuntimeExternalHttpRequest,
} from '@tracecode/harness-core';
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
  runtimeKernelIdentityDirEntries,
  runtimeKernelIdentityEntryKind,
  runtimeKernelIdentityStat,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorMessage,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorMessage,
  runtimeKernelMutationTarget,
  runtimeKernelMounts,
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
  readRuntimeKernelIdentityFile,
  readRuntimeProcFile,
  createRuntimeKernelReadonlyFileError,
  type RuntimeKernelVirtualStat,
} from '@tracecode/harness-core';
import { getLanguageRuntimeInfo, TRACECODE_HARNESS_VERSION } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
import {
  encodeTraceKernelHttp1Request,
  encodeTraceKernelHttp1Response,
  makeTraceKernelPromiseSyscallHandler,
  makeTraceKernelSharedSyscallChannel,
  TraceKernelHttp1Decoder,
  TraceKernelSharedSyscallServer,
  type TraceKernelHttp1Header,
  type TraceKernelHttp1Message,
  type TraceKernelHttp1Request,
  type TraceKernelHttp1Response,
  type TraceKernelSyscallErrorCode,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
} from '@tracecode/tracekernel';
import type {
  BashOptions,
  Command,
  CommandContext,
  CustomCommand,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
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
  KernelJournalRecord,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeSymlink,
  RuntimeDirectory,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelHostConfig,
  RuntimeKernelHostInfo,
  RuntimeKernelInfo,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpBodyInit,
  RuntimeKernelHttpBodyPayload,
  RuntimeKernelHttpDispatchOptions,
  RuntimeKernelHttpError,
  RuntimeKernelHttpHandler,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenerInfo,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelSyscallBridge,
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
  RuntimeProjectHiddenCommandAccess,
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
  RuntimeProjectPatchDirectoryWrite,
  RuntimeProjectPatchDirectoryDelete,
  RuntimeProjectPatchFileDelete,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectPatchSymlinkWrite,
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
  RuntimeWorkspaceProcess,
  RuntimeWorkspaceProcessOptions,
  RuntimeWorkspaceProcessSignalPolicy,
  RuntimeWorkspaceRemoveOptions,
  RuntimeWorkspaceStat,
  RuntimeWorkspaceUnsubscribe,
} from '@tracecode/harness-core';
import {
  CPP_COMPILER_COMMANDS,
  DEFAULT_CWD,
  TRACE_KERNEL_ARCHITECTURE,
  TRACE_KERNEL_NAME,
  TRACEKERNEL_BIN_PATH,
  TRACEKERNEL_COMMAND_DISPATCH_PREFIX,
  TRACEKERNEL_EXEC_COMMAND,
  TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS,
  TRACEKERNEL_SHELL_COMMAND_PREFIX,
  TRACEKERNEL_SKILLS_ROOT,
} from './constants';
import {
  CURL_PROTOCOLS,
  resolveCurlUrl,
} from './curl-url';
import {
  assertNoNul,
  dirname,
  expandParsedScriptInvocation,
  isRuntimeSkillsNamespacePath,
  isTraceKernelVirtualNamespacePath,
  isWithinWorkspace,
  mapWorkspaceAlias,
  normalizeRuntimeSkillPath,
  normalizeRuntimeProjectPath,
  normalizeRuntimeSkillsVirtualPath,
  normalizeTraceKernelVirtualPath,
  normalizeTerminalAbsolutePath,
  normalizeWorkspaceCwd,
  resolveWorkspaceCommandPath,
  resolveWorkspaceContextPath,
  runtimeSkillAbsolutePath,
  terminalCwdLabel,
  toProjectDirectoryPath,
  toWorkspaceEntryPath,
  toProjectPath,
  toWorkspaceRelativePath,
  toWorkspacePath,
  traceKernelBinCommandName,
} from './paths';
import {
  createProjectSessionInfo,
  createWorkspaceId,
  normalizeIsoTimestamp,
  normalizeKernelNamePart,
  normalizeRuntimeWorkspaceOptions,
  publicProjectSessionInfo,
} from './session';
import {
  RuntimeFileGenerationConflictError,
  RuntimeFileSystemLockCoordinator,
  fsAncestorLockRequests,
  fsFileMutationLockRequests,
  fsMutationGenerationPaths,
  fsMutationLockRequests,
  fsParentStructureLockRequests,
  normalizeFsLockPath,
  type RuntimeFileSystemMutationKind,
  type RuntimeFileSystemLockRequest,
} from './locks';
import {
  RuntimeCommandScheduler,
  RuntimeKernelAdmissionRejectedError,
  RuntimeKernelInterruptedError,
  normalizeRuntimeSchedulerConfig,
  type RuntimeCommandSchedulerOptions,
} from './scheduler';
import { RuntimeKernelDescriptorManager } from './runtime-kernel-descriptors';
import { RuntimeKernelNetworkManager } from './runtime-kernel-network';
import {
  RUNTIME_PROJECT_PATCH_HASH_PATTERN,
  RUNTIME_PROJECT_PATCH_VERSION,
  assertRuntimeProjectPatchHash,
  createRuntimeProjectPatchSnapshotView,
  normalizeRuntimeProjectPatch,
  runtimeProjectPatchChangesToFileChanges,
  runtimeProjectPatchHashJson,
  sortRuntimeProjectPatchChanges,
  staleRuntimeProjectPatchError,
  validateRuntimeProjectPatchAgainstBase,
  type RuntimeProjectPatchSnapshotView,
} from './patches';
import {
  KernelObservedFileSystem,
  CommandBoundFileSystem,
  applyWorkspaceCommandResultFiles,
  assertSupportedEncoding,
  base64FromBytes,
  bytesEqual,
  bytesFromBase64,
  collectKernelProcSnapshotFiles,
  collectSnapshotFiles,
  contentToBytes,
  contentToBytesForRuntimeFile,
  contentToText,
  decodeUtf8,
  filterHiddenSnapshotFiles,
  filterReadonlySnapshotDeletions,
  filterReadonlySnapshotFiles,
  isRuntimeDirectoryChange,
  isRuntimeSymlinkChange,
  isKernelReadonlyError,
  isKernelVirtualFilesystemError,
  isRuntimeFileGenerationConflict,
  isRuntimeWorkspaceStorageLimitError,
  kernelAccessTarget,
  kernelCommandFailure,
  kernelDirectoryTarget,
  kernelFileCopyTarget,
  kernelFileReadTarget,
  kernelMkdirTarget,
  kernelMutationTarget,
  kernelReadTarget,
  kernelRemoveTarget,
  kernelRenameTarget,
  kernelStatTarget,
  kernelWriteTarget,
  normalizeProcPath,
  normalizeRuntimeFileEncoding,
  prepareFinalDiffChange,
  runtimeCommandError,
  runtimeFileSystemEntryIsSymlink,
  runtimeFileSystemEntryKey,
  snapshotRuntimeKernelVirtualFiles,
  textToByteString,
  withSuspendedFsNotifications,
  commandContextForFs,
  registerCommandContext,
  throwKernelMutationTargetError,
  throwKernelReadTargetError,
  throwKernelWriteTargetError,
  type RuntimeDynamicProcEntry,
  type RuntimeDynamicProcProvider,
  type RuntimeCommandExecutionContext,
  type RuntimeFileChangeObserver,
  type RuntimeFileSystemCommandGenerationContext,
  type RuntimeFileSystemGenerationSnapshot,
  type RuntimeFileSystemSyscallEvent,
  type RuntimeFinalDiffPreparedChange,
} from './fs-observed';
import {
  decodeCommandStdin,
  leadingPersistentCdTarget,
  parseSimpleCommandWords,
  parseTerminalCommandList,
  rewriteKernelShellCommandInvocationsInAst,
  rewriteTraceKernelBinInvocationsInAst,
  rewriteVirtualExecutableInvocationsInAst,
  type TerminalCommandListSegment,
  type VirtualExecutableRecord,
} from './arg-parsers';
import {
  createPackageManagerProjectCommands,
  normalizePackageManagerConfig,
  shellQuote,
  type PackageManagerOutputEmitter,
  type NormalizedRuntimePackageManagerConfig,
} from './package-manager';
import {
  commandEnv,
  createCppProjectCommands,
  createCSharpProjectCommands,
  createJavaProjectCommands,
  createNodeProjectCommands,
  createPythonProjectCommands,
  createTraceKernelCommandRegistry,
  createTypeScriptProjectCommands,
  traceKernelCommandPath,
  traceKernelRuntimeRegistry,
  type TraceKernelCommandInfo,
  type TraceKernelRuntimeInfo,
} from './language-commands';
import {
  parseRuntimeLsArgs,
  runtimeLsIndicator,
  runtimeLsFormatLine,
  runtimeLsHumanSize,
  runtimeLsMode,
  type RuntimeLsEntry,
  type RuntimeLsStat,
} from './ls';
import {
  RuntimeProjectWorkspaceTerminalSession,
  commandInputTokenBounds,
  longestCommonPrefix,
  type RuntimeProjectTerminalJobRecord,
} from './terminal-session';


export type ProjectWorkspaceCommand = CustomCommand;

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
  hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  files?: readonly RuntimeFile[];
  symlinks?: readonly RuntimeSymlink[];
  directories?: readonly string[];
  directoryMetadata?: readonly RuntimeDirectory[];
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
  /**
   * Logical storage limits for the in-browser project filesystem. Limits are
   * enforced for every filesystem entry under the workspace root (including
   * hidden/session files) before a mutation is committed.
   */
  storageLimits?: RuntimeWorkspaceStorageLimits;
  externalHttp?: RuntimeExternalHttpConfig;
  kernel?: RuntimeTraceKernelConfig;
  kernelControl?: RuntimeTraceKernelControlOptions;
}

export interface RuntimeWorkspaceStorageLimits {
  /** Maximum logical bytes across files and symbolic-link targets. */
  maxWorkspaceBytes?: number;
  /** Maximum logical bytes stored by any single regular file. */
  maxFileBytes?: number;
  /** Maximum files, directories, and symbolic links below the workspace root. */
  maxEntryCount?: number;
}

export interface NormalizedRuntimeWorkspaceStorageLimits {
  maxWorkspaceBytes: number;
  maxFileBytes: number;
  maxEntryCount: number;
}

export const RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT = 10_000;

function normalizeRuntimeWorkspaceStorageLimit(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return normalized;
}

export function normalizeRuntimeWorkspaceStorageLimits(
  limits: RuntimeWorkspaceStorageLimits | undefined
): NormalizedRuntimeWorkspaceStorageLimits {
  return Object.freeze({
    maxWorkspaceBytes: normalizeRuntimeWorkspaceStorageLimit(
      limits?.maxWorkspaceBytes,
      RUNTIME_WORKSPACE_DEFAULT_MAX_BYTES,
      'storageLimits.maxWorkspaceBytes'
    ),
    maxFileBytes: normalizeRuntimeWorkspaceStorageLimit(
      limits?.maxFileBytes,
      RUNTIME_WORKSPACE_DEFAULT_MAX_FILE_BYTES,
      'storageLimits.maxFileBytes'
    ),
    maxEntryCount: normalizeRuntimeWorkspaceStorageLimit(
      limits?.maxEntryCount,
      RUNTIME_WORKSPACE_DEFAULT_MAX_ENTRY_COUNT,
      'storageLimits.maxEntryCount'
    ),
  });
}

const PRINCIPAL_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('principal');
const RUNTIME_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('runtime');
const SYSTEM_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('system');
const TRACEKERNEL_EVENT_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_LISTENER_LIMIT = 128;
const TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS = 256;
const TRACEKERNEL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;
const TRACEKERNEL_HTTP_MAX_HEADER_COUNT = 128;
const TRACEKERNEL_HTTP_MAX_HEADER_BYTES = 64 * 1024;
const TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH = 4096;
const TRACEKERNEL_HTTP_TCP_READ_BYTES = 64 * 1024;
const TRACEKERNEL_HTTP_REQUEST_FRAME_TIMEOUT_MS = 30_000;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_REQUESTS_PER_COMMAND = 64;
const TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS = 60_000;
const TRACEKERNEL_HTTP_STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});
const TRACEKERNEL_SYSCALL_ERROR_CODES: ReadonlySet<TraceKernelSyscallErrorCode> = new Set([
  'E2BIG',
  'EAGAIN',
  'EACCES',
  'EADDRINUSE',
  'EAFNOSUPPORT',
  'EBADF',
  'EBUSY',
  'ECHILD',
  'ECONNREFUSED',
  'EDESTADDRREQ',
  'ELOOP',
  'ENAMETOOLONG',
  'EMFILE',
  'EEXIST',
  'EISDIR',
  'EISCONN',
  'EINVAL',
  'EIO',
  'ENOENT',
  'ENOTCONN',
  'ENOSYS',
  'ENOTDIR',
  'ENOTEMPTY',
  'EOPNOTSUPP',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EROFS',
  'ESRCH',
]);

interface NormalizedRuntimeExternalHttpHostRule {
  hostname: string;
  wildcardSubdomains: boolean;
  port?: number;
}

interface NormalizedRuntimeExternalHttpConfig {
  fetch: RuntimeExternalHttpConfig['fetch'];
  hosts: readonly NormalizedRuntimeExternalHttpHostRule[] | ((url: URL) => boolean);
  allowHttp: boolean;
  timeoutMs: number;
  maxConcurrentRequests: number;
  maxRequestsPerCommand: number;
}

export type HostResolution =
  | { reachable: true; via: 'loopback' | 'listener' | 'external'; ip: string; latencyMs: number }
  | { reachable: false; reason: 'unknown-host' };

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

function traceKernelTsv(value: unknown): string {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ');
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
  readonly env: Readonly<Record<string, string>>;
  readonly actor: RuntimeWorkspaceActor;
  readonly signalPolicy: RuntimeWorkspaceProcessSignalPolicy;
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

interface RuntimeKernelZombieRecord {
  process: RuntimeKernelProcessRecord;
  expiresAtMs: number;
}

interface RuntimeKernelWatchdogRecord {
  readonly token: symbol;
  readonly timeoutMs: number;
  readonly signal: 'SIGTERM' | 'SIGKILL';
  readonly deadlineAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RuntimeKernelProcessLaunchHooks {
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

interface RuntimeKernelSpawnedChild {
  readonly process: RuntimeKernelProcessRecord;
  readonly stdio?: {
    readonly stdinFd?: number;
    readonly stdoutFd?: number;
    readonly stderrFd?: number;
  };
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
  ready: Promise<void>;
  listenerFd?: number;
  transportAddress?: { host: string; port: number };
  closed: boolean;
  listening: boolean;
  readonly connectionControllers: Map<number, AbortController>;
}

interface RuntimeKernelHttpTcpDispatchContext {
  readonly url: URL;
  readonly actor: RuntimeWorkspaceActor;
  readonly signal: AbortSignal;
  readonly response: Promise<RuntimeKernelHttpResponse>;
  resolve(response: RuntimeKernelHttpResponse): void;
  reject(error: unknown): void;
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
  external?: true;
}

type RuntimeKernelHttpPathResult =
  | { ok: true; path: string }
  | { ok: false; error: RuntimeKernelHttpError };

type RuntimeKernelHttpRequestResult =
  | { ok: true; request: RuntimeKernelHttpRequest }
  | { ok: false; error: RuntimeKernelHttpError };

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type KernelJournalEntry = DistributiveOmit<KernelJournalRecord, 'seq' | 'ts'>;

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

function clampRuntimeExternalHttpPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const normalized = Math.trunc(Number(value));
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(max, Math.max(1, normalized));
}

function defaultRuntimeExternalHttpPort(protocol: string): number {
  return protocol === 'http:' ? 80 : 443;
}

function stableHostnameHash(hostname: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < hostname.length; index += 1) {
    hash ^= hostname.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function stableKernelJournalFingerprint(value: string): string {
  return stableHostnameHash(value).toString(16).padStart(8, '0').slice(0, 8);
}

export function syntheticIp(hostname: string): string {
  const hash = stableHostnameHash(hostname.toLowerCase());
  return `192.0.2.${(hash % 254) + 1}`;
}

export function syntheticLatency(hostname: string): number {
  const hash = stableHostnameHash(hostname.toLowerCase());
  return Number((0.1 + (hash % 291) / 100).toFixed(2));
}

function formatPingLatency(latencyMs: number): string {
  return latencyMs.toFixed(2);
}

function isBareHostnameForExternalResolution(hostname: string): boolean {
  return !!hostname && !/[\u0000-\u0020\u007f:/@[\]]/.test(hostname);
}

function normalizeRuntimeExternalHttpHostEntry(entry: string): NormalizedRuntimeExternalHttpHostRule {
  const raw = entry.trim();
  if (!raw || raw === '*') {
    throw new TypeError('Runtime external HTTP host entries must not be empty or "*". Use a predicate for full-wildcard egress.');
  }
  const wildcardSubdomains = raw.startsWith('*.');
  const hostAndPort = wildcardSubdomains ? raw.slice(2) : raw;
  const lastColon = hostAndPort.lastIndexOf(':');
  const hasPort = lastColon > -1 && /^[0-9]+$/.test(hostAndPort.slice(lastColon + 1));
  const hostname = (hasPort ? hostAndPort.slice(0, lastColon) : hostAndPort).toLowerCase();
  if (!hostname || hostname.includes('/') || hostname.includes('@') || hostname.includes('*')) {
    throw new TypeError(`Invalid Runtime external HTTP host entry "${entry}".`);
  }
  let port: number | undefined;
  if (hasPort) {
    port = Math.trunc(Number(hostAndPort.slice(lastColon + 1)));
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new TypeError(`Invalid Runtime external HTTP host port in "${entry}".`);
    }
  }
  return {
    hostname,
    wildcardSubdomains,
    ...(port !== undefined ? { port } : {}),
  };
}

function normalizeRuntimeExternalHttpConfig(
  config: RuntimeExternalHttpConfig | undefined
): NormalizedRuntimeExternalHttpConfig | undefined {
  if (config === undefined) return undefined;
  if (typeof config.fetch !== 'function') {
    throw new TypeError('Runtime external HTTP config requires a fetch delegate.');
  }
  const hosts = typeof config.hosts === 'function'
    ? config.hosts
    : Array.isArray(config.hosts)
      ? config.hosts.map(normalizeRuntimeExternalHttpHostEntry)
      : undefined;
  if (!hosts) {
    throw new TypeError('Runtime external HTTP config requires a hosts allowlist or predicate.');
  }
  return {
    fetch: config.fetch,
    hosts,
    allowHttp: config.allowHttp === true,
    timeoutMs: clampRuntimeExternalHttpPositiveInteger(
      config.timeoutMs,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_TIMEOUT_MS,
      TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS
    ),
    maxConcurrentRequests: clampRuntimeExternalHttpPositiveInteger(
      config.maxConcurrentRequests,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_CONCURRENT_REQUESTS,
      Number.MAX_SAFE_INTEGER
    ),
    maxRequestsPerCommand: clampRuntimeExternalHttpPositiveInteger(
      config.maxRequestsPerCommand,
      TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_REQUESTS_PER_COMMAND,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

interface RuntimeLazyCommand {
  name: string;
  load: () => Promise<Command>;
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

function runtimeCommandEnvChanges(
  baselineEnv: Record<string, string>,
  finalEnv: Record<string, string> | undefined
): Record<string, string | undefined> {
  const changes: Record<string, string | undefined> = {};
  if (!finalEnv) return changes;
  for (const [key, value] of Object.entries(finalEnv)) {
    if (baselineEnv[key] !== value) changes[key] = value;
  }
  for (const key of Object.keys(baselineEnv)) {
    if (!(key in finalEnv)) changes[key] = undefined;
  }
  return changes;
}

function isRuntimeCommand(command: CustomCommand): command is Command {
  return typeof (command as Command).execute === 'function';
}

function isRuntimeLazyCommand(command: CustomCommand): command is RuntimeLazyCommand {
  return typeof (command as RuntimeLazyCommand).load === 'function';
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
    version: config?.version ?? TRACECODE_HARNESS_VERSION,
    user: {
      id: config?.user?.id ?? username,
      username,
      home,
    },
    host: {
      hostname: normalizeKernelNamePart(config?.host?.hostname ?? 'tracevm', 'tracevm'),
      osName: config?.host?.osName ?? 'tracekernel',
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

function createTraceKernelEnvironment(info: RuntimeKernelInfo): Record<string, string> {
  return {
    HOME: info.home,
    USER: info.user.username,
    LOGNAME: info.user.username,
    HOSTNAME: info.host.hostname,
    SHELL: '/bin/bash',
    PATH: `${TRACEKERNEL_BIN_PATH}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    OSTYPE: 'tracekernel',
    MACHTYPE: `${TRACE_KERNEL_ARCHITECTURE}-tracekernel`,
    HOSTTYPE: TRACE_KERNEL_ARCHITECTURE,
  };
}

export class RuntimeProjectWorkspace implements RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly projectSession?: RuntimeProjectSessionInfo;
  readonly cwd: string;
  readonly http: RuntimeWorkspaceHttpClient;
  readonly kernelInfo: RuntimeKernelInfo;
  private readonly bash: Bash;
  private readonly bashOptions: BashOptions;
  private readonly baseEnv: Record<string, string>;
  private readonly fs: KernelObservedFileSystem;
  private readonly kernelDescriptors: RuntimeKernelDescriptorManager;
  private readonly kernelNetwork: RuntimeKernelNetworkManager;
  // Cached RuntimeFile objects are immutable; consumers must shallow-copy arrays before filtering.
  private snapshotCache: { version: number; files: RuntimeFile[]; directories: string[]; directoryMetadata: RuntimeDirectory[]; symlinks: RuntimeSymlink[]; kernelFiles: RuntimeFile[] } | null = null;
  private readonly fsLocks = new RuntimeFileSystemLockCoordinator();
  private readonly commandScheduler: RuntimeCommandScheduler;
  private readonly maxProcesses: number | null;
  private readonly externalHttp?: NormalizedRuntimeExternalHttpConfig;
  private readonly entrypoint?: string;
  private readonly kernelControl?: RuntimeTraceKernelControlOptions;
  private readonly cppRunner?: CppProjectCommandRunner;
  private readonly projectSessionCommands?: Record<string, RuntimeProjectSessionCommand>;
  private readonly hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  private readonly traceKernelCommandRegistry: TraceKernelCommandInfo[];
  private readonly traceKernelCommandDispatchNames: ReadonlyMap<string, string>;
  private readonly skillFiles = new Map<string, RuntimeFile>();
  private readonly virtualExecutableRecords = new Map<string, VirtualExecutableRecord>();
  private readonly processTable = new Map<number, RuntimeKernelProcessRecord>();
  private readonly zombieProcessTable = new Map<number, RuntimeKernelZombieRecord>();
  private readonly processWaiters = new Map<number, Array<(process: RuntimeKernelProcessRecord) => void>>();
  private readonly anyProcessWaiters: Array<(process: RuntimeKernelProcessRecord) => void> = [];
  private readonly runtimeChildWaits = new Set<number>();
  private readonly processWatchdogs = new Map<number, RuntimeKernelWatchdogRecord>();
  private readonly kernelEventLog: RuntimeKernelEventRecord[] = [];
  private readonly kernelJournalLog: KernelJournalRecord[] = [];
  private readonly httpListeners = new Map<string, RuntimeKernelHttpListenerRecord>();
  private readonly retiredHttpListeners = new Set<RuntimeKernelHttpListenerRecord>();
  private readonly httpTcpDispatches = new Map<number, RuntimeKernelHttpTcpDispatchContext>();
  private readonly httpRequestLog: RuntimeKernelHttpRequestRecord[] = [];
  private readonly httpLifecycleAbortController = new AbortController();
  private readonly readonlyFiles = new Set<string>();
  private readonly eventWatchers = new Set<RuntimeWorkspaceEventHandler>();
  private kernelSyscallGenerationBuffer?: SharedArrayBuffer;
  private kernelSyscallGenerationUnsubscribe?: RuntimeWorkspaceUnsubscribe;
  private readonlySuspendDepth = 0;
  private nextCommandId = 1;
  private nextPid = 100;
  private nextKernelEventSeq = 1;
  private nextJournalSeq = 1;
  private nextHttpListenerSeq = 1;
  private nextHttpRequestSeq = 1;
  private nextEphemeralHttpPort = 49152;
  private nextTemporaryEntry = 1;
  private activeHttpRequests = 0;
  private activeExternalHttpRequests = 0;
  private workspaceExternalHttpRequestCount = 0;
  private destroyed = false;
  private expirationDestroyScheduled = false;
  private terminalVerbose = false;

  constructor(options: CreateRuntimeWorkspaceOptions = {}) {
    this.kernelInfo = createTraceKernelInfo(options.kernel, options.cwd);
    this.baseEnv = { ...createTraceKernelEnvironment(this.kernelInfo), ...(options.env ?? {}) };
    this.externalHttp = normalizeRuntimeExternalHttpConfig(options.externalHttp);
    this.http = {
      request: (requestOptions) => this.requestHttp(requestOptions),
      json: (requestOptions) => this.requestHttpJson(requestOptions),
      listen: (listenOptions, handler) => this.listenHttp(listenOptions, handler),
    };
    this.commandScheduler = new RuntimeCommandScheduler(normalizeRuntimeSchedulerConfig(options.kernel?.scheduler));
    this.maxProcesses = Number.isFinite(options.kernel?.maxProcesses)
      ? Math.max(1, Math.floor(options.kernel?.maxProcesses ?? 1))
      : null;
    this.cwd = this.kernelInfo.workspaceRoot;
    const projectSession = options.projectSession ? createProjectSessionInfo(options.projectSession, this.kernelInfo) : undefined;
    this.projectSessionCommands = projectSession?.commands;
    this.projectSession = projectSession ? publicProjectSessionInfo(projectSession) : undefined;
    this.hiddenCommandAccess = options.hiddenCommandAccess;
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
      (absolutePath) => this.isWorkspacePathHidden(absolutePath),
      (event) => this.recordKernelEvent(event.type, event.pid, event.detail),
      this.createDynamicProcProvider(),
      (context, change) => {
        if (!context) return;
        this.emitLocalRuntimeEvent({ type: 'file-change', change, phase: 'live' }, context);
      },
      (context, device) => this.readDevice(device, context),
      (context, device, data) => this.writeDevice(device, data, context),
      normalizeRuntimeWorkspaceStorageLimits(options.storageLimits)
    );
    this.kernelDescriptors = new RuntimeKernelDescriptorManager(this.fs);
    this.kernelNetwork = new RuntimeKernelNetworkManager(this.kernelDescriptors);
    const withEvents = <Request extends RuntimeProjectCommandRequest<string>>(
      runner: RuntimeProjectCommandRunner<Request>,
      options: { kernelSyscalls?: boolean } = {}
    ): RuntimeProjectCommandRunner<Request> => (
      async (request, ctx?: CommandContext) => {
        const commandContext = this.resolveCommandContext(ctx);
        const activeStdinPipe = request.source !== 'compile' && request.source !== 'stdin'
          ? commandContext?.stdinPipe
          : undefined;
        const stdinPipe = request.stdinPipe ?? activeStdinPipe;
        const signal = commandContext?.process.abortController?.signal ?? request.signal;
        const runtimeIo = commandContext?.runtimeIo;
        let acceptingRunnerEvents = true;
        let result: RuntimeCommandResult;
        const kernelSyscalls = options.kernelSyscalls
          ? this.createKernelSyscallBridge(commandContext)
          : undefined;
        try {
          result = await runner({
            ...request,
            ...(commandContext?.process
              ? {
                  process: {
                    pid: commandContext.process.pid,
                    ppid: commandContext.process.ppid,
                    pgid: commandContext.process.pgid,
                    sid: commandContext.process.sid,
                  },
                }
              : {}),
            ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
            ...(commandContext?.terminal ? { terminal: commandContext.terminal } : {}),
            ...(signal ? { signal } : {}),
            kernelHttp: this.createKernelHttpBridge(commandContext),
            ...(kernelSyscalls ? { kernelSyscalls } : {}),
            onEvent: (event) => {
              if (!acceptingRunnerEvents) return;
              this.handleRuntimeCommandEvent(event, commandContext);
            },
          } as Request);
        } finally {
          acceptingRunnerEvents = false;
          kernelSyscalls?.close();
        }
        if (result.handledSignal && commandContext) {
          commandContext.handledSignal = result.handledSignal;
        }
        // just-bash preserves the standard stdout/stderr/exitCode fields from a
        // custom command but does not retain harness-specific result metadata.
        // Carry structured runner failures on the command context so the outer
        // workspace result can expose them to the host without printing them in
        // the learner's terminal.
        if (result.error && commandContext && !commandContext.kernelError) {
          commandContext.kernelError = result.error;
        }
        if (runtimeIo) {
          await runtimeIo.flush();
          return runtimeIo.filterAppliedResultFiles(result) as RuntimeCommandResult;
        }
        await this.flushRuntimeEventQueue();
        return result;
      }
    ) as RuntimeProjectCommandRunner<Request>;
    const observeFileChange: RuntimeFileChangeObserver = (change, phase, context) => {
      this.emitLocalRuntimeEvent({ type: 'file-change', change, phase }, context);
    };
    const packageManagerConfig = normalizePackageManagerConfig(
      options.packageManager,
      Boolean(options.nodeRunner || options.typescriptRunner)
    );
    this.traceKernelCommandRegistry = createTraceKernelCommandRegistry(options, packageManagerConfig);
    const emitPackageManagerOutput: PackageManagerOutputEmitter = (stream, data, context) => {
      this.emitLocalRuntimeEvent({
        type: 'output',
        stream,
        device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
        data,
      }, this.resolveCommandContext(context));
    };
    const includeHiddenFilesForCurrentCommand = (ctx?: CommandContext) => this.resolveCommandContext(ctx)?.includeHiddenFiles === true;
    const snapshotProjectForCurrentCommand = (_ctx: CommandContext, includeHiddenFiles: boolean) =>
      this.snapshotForCommand(includeHiddenFiles);
    const exposedCustomCommands: CustomCommand[] = [
      ...(options.pythonRunner ? createPythonProjectCommands(withEvents(options.pythonRunner, { kernelSyscalls: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.nodeRunner ? createNodeProjectCommands(withEvents(options.nodeRunner, { kernelSyscalls: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.typescriptRunner ? createTypeScriptProjectCommands(withEvents(options.typescriptRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(packageManagerConfig ? createPackageManagerProjectCommands(packageManagerConfig, this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, emitPackageManagerOutput, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.javaRunner ? createJavaProjectCommands(withEvents(options.javaRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.cppRunner ? createCppProjectCommands(withEvents(options.cppRunner, { kernelSyscalls: true }), this.cwd, {
        recordExecutablePath: (path) => this.registerVirtualExecutable({ path, kind: 'cpp' }),
        entrypoint: this.entrypoint,
        onFileChange: observeFileChange,
        workspaceAlias: this.kernelInfo.workspaceAlias,
        kernel: this.kernelInfo,
        readonlyFiles: this.projectSession?.readonlyFiles,
        hiddenFiles: this.projectSession?.hiddenFiles,
        includeHiddenFiles: includeHiddenFilesForCurrentCommand,
        snapshotProject: snapshotProjectForCurrentCommand,
      }) : []),
      ...(options.csharpRunner ? createCSharpProjectCommands(withEvents(options.csharpRunner, { kernelSyscalls: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      defineCommand(TRACEKERNEL_EXEC_COMMAND, (args, ctx) => this.runTraceKernelExec(args, ctx)),
      defineCommand('bg', async (args, ctx) => this.runKernelJobPlacement(args, 'bg', ctx)),
      defineCommand('curl', async (args, ctx) => this.runKernelCurl(args, ctx)),
      defineCommand('df', async (args, ctx) => this.runKernelDf(args, ctx)),
      defineCommand('du', async (args, ctx) => this.runKernelDu(args, ctx)),
      defineCommand('fastfetch', async (args, ctx) => this.runKernelFastfetch(args, ctx)),
      defineCommand('fg', async (args, ctx) => this.runKernelJobPlacement(args, 'fg', ctx)),
      defineCommand('getconf', async (args) => this.runKernelGetconf(args)),
      defineCommand('getent', async (args) => this.runKernelGetent(args)),
      defineCommand('groups', async (args) => this.runKernelGroups(args)),
      defineCommand('kill', async (args, ctx) => this.runKernelKill(args, 'kill', ctx)),
      defineCommand('jobs', async (args, ctx) => this.runKernelJobs(args, ctx)),
      defineCommand('hostname', async (args) => this.runKernelHostname(args)),
      defineCommand('id', async (args) => this.runKernelId(args)),
      defineCommand('lsof', async (args, ctx) => this.runKernelLsof(args, ctx)),
      defineCommand('locale', async (args) => this.runKernelLocale(args)),
      defineCommand('ls', async (args, ctx) => this.runKernelAwareLs(args, ctx)),
      defineCommand('man', async (args) => this.runKernelMan(args)),
      defineCommand('mktemp', async (args, ctx) => this.runKernelMktemp(args, ctx)),
      defineCommand('mount', async (args) => this.runKernelMount(args)),
      defineCommand('neofetch', async (args, ctx) => this.runKernelFastfetch(args, ctx)),
      defineCommand('pgrep', async (args, ctx) => this.runKernelProcessMatch(args, 'pgrep', ctx)),
      defineCommand('ping', async (args, ctx) => this.runKernelPing(args, ctx)),
      defineCommand('pkill', async (args, ctx) => this.runKernelProcessMatch(args, 'pkill', ctx)),
      defineCommand('ps', async (args, ctx) => this.runKernelPs(args, ctx)),
      defineCommand('ss', async (args, ctx) => this.runKernelSs(args, ctx)),
      defineCommand('stat', async (args, ctx) => this.runKernelStat(args, ctx)),
      defineCommand('stty', async (args, ctx) => this.runKernelStty(args, ctx)),
      defineCommand('tput', async (args, ctx) => this.runKernelTput(args, ctx)),
      defineCommand('tracekernelctl', (args, ctx) => this.runTraceKernelCtl(args, ctx)),
      defineCommand('tty', async (args, ctx) => this.runKernelTty(args, ctx)),
      defineCommand('umask', async (args, ctx) => this.runKernelUmask(args, ctx)),
      defineCommand('uname', async (args) => this.runKernelUname(args)),
      defineCommand('wait', (args, ctx) => this.runKernelWait(args, 'wait', ctx)),
      defineCommand('wget', async (args, ctx) => this.runKernelWget(args, ctx)),
      defineCommand('which', async (args, ctx) => this.runTraceKernelWhich(args, 'which', ctx)),
      defineCommand('whoami', async (args) => this.runKernelWhoami(args)),
      defineCommand('command', async (args, ctx) => this.runTraceKernelCommandBuiltin(args, ctx)),
      ...(options.customCommands ?? []),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}bg`, async (args, ctx) => this.runKernelJobPlacement(args, 'bg', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}command`, async (args, ctx) => this.runTraceKernelCommandBuiltin(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}fg`, async (args, ctx) => this.runKernelJobPlacement(args, 'fg', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}kill`, async (args, ctx) => this.runKernelKill(args, 'kill', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}jobs`, async (args, ctx) => this.runKernelJobs(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}lsof`, async (args, ctx) => this.runKernelLsof(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}pgrep`, async (args, ctx) => this.runKernelProcessMatch(args, 'pgrep', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}pkill`, async (args, ctx) => this.runKernelProcessMatch(args, 'pkill', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}ps`, async (args, ctx) => this.runKernelPs(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}ss`, async (args, ctx) => this.runKernelSs(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}test`, async (args, ctx) => this.runKernelTestBuiltin(args, 'test', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}test-bracket`, async (args, ctx) => this.runKernelTestBuiltin(args, '[', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`, (args, ctx) => this.runKernelWait(args, 'wait', ctx)),
    ];
    this.traceKernelCommandDispatchNames = new Map(
      exposedCustomCommands.map((command) => [
        command.name,
        `${TRACEKERNEL_COMMAND_DISPATCH_PREFIX}${command.name}`,
      ])
    );
    const customCommands: CustomCommand[] = [
      ...exposedCustomCommands,
      ...exposedCustomCommands.map((command) => this.aliasKernelCommand(
        command,
        this.traceKernelCommandDispatchNames.get(command.name)!
      )),
    ].map((command) => this.withKernelCommandSignal(command));
    this.bashOptions = {
      fs: this.fs,
      cwd: this.cwd,
      env: this.baseEnv,
      commands: options.commands as never,
      customCommands: customCommands.length > 0 ? customCommands : undefined,
      python: options.python,
      javascript: options.javascript,
      executionLimits: options.executionLimits as never,
    };
    this.bash = this.createBash();
  }

  private withKernelCommandSignal(command: CustomCommand): CustomCommand {
    if (isRuntimeCommand(command)) {
      return {
        ...command,
        execute: (args, ctx) => {
          const help = this.traceKernelCommandHelp(command.name, args);
          if (help) return Promise.resolve(help);
          return command.execute(args, this.withCurrentKernelSignal(ctx));
        },
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

  private aliasKernelCommand(command: CustomCommand, name: string): CustomCommand {
    if (isRuntimeCommand(command)) return { ...command, name };
    return {
      name,
      load: async () => ({ ...(await command.load()), name }),
    };
  }

  private withCurrentKernelSignal(ctx: CommandContext): CommandContext {
    const signal = this.resolveCommandContext(ctx)?.process.abortController?.signal;
    return signal && signal !== ctx.signal ? { ...ctx, signal } : ctx;
  }

  private createBash(
    executionLimits?: RuntimeCommandExecutionLimits,
    commandContext?: RuntimeCommandExecutionContext,
    fs?: IFileSystem
  ): Bash {
    const bash = new Bash({
      ...this.bashOptions,
      ...(fs ? { fs } : {}),
      ...(executionLimits ? { executionLimits: executionLimits as never } : {}),
    });
    bash.registerTransformPlugin({
      name: 'tracekernel-command-rewrite',
      transform: ({ ast }: { ast: unknown }) => {
        const executableTransformCwd = commandContext?.executableTransformCwd;
        if (executableTransformCwd) {
          rewriteVirtualExecutableInvocationsInAst(
            ast,
            executableTransformCwd,
            this.cwd,
            this.kernelInfo.workspaceAlias,
            this.virtualExecutableRecords,
            true
          );
        }
        rewriteKernelShellCommandInvocationsInAst(ast);
        rewriteTraceKernelBinInvocationsInAst(ast, this.traceKernelCommandDispatchNames);
        return { ast };
      },
    } as never);
    return bash;
  }

  private resolveCommandContext(ctx?: CommandContext): RuntimeCommandExecutionContext | undefined {
    return ctx?.fs ? commandContextForFs(ctx.fs) : undefined;
  }

  private hasHttpCapability(actor: RuntimeWorkspaceActor, capability: keyof NonNullable<RuntimeWorkspaceCapabilities['http']>): boolean {
    return actor.capabilities?.http?.[capability] === true;
  }

  private actorCapabilityPath(path: string): string {
    if (path.startsWith('/')) return normalizeFsLockPath(mapWorkspaceAlias(this.cwd, this.kernelInfo.workspaceAlias, path));
    return normalizeFsLockPath(this.toWorkspaceEntryPath(path));
  }

  private actorCapabilityPattern(pattern: string): string {
    const trimmed = pattern.trim();
    if (trimmed === '**' || trimmed === '*') return `${this.cwd}/**`;
    if (trimmed.startsWith('/')) {
      return normalizeFsLockPath(mapWorkspaceAlias(this.cwd, this.kernelInfo.workspaceAlias, trimmed));
    }
    return normalizeFsLockPath(`${this.cwd}/${trimmed}`);
  }

  private actorCapabilityMatches(pattern: string, path: string): boolean {
    const normalizedPattern = this.actorCapabilityPattern(pattern);
    if (normalizedPattern.endsWith('/**')) {
      const root = normalizedPattern.slice(0, -3);
      return path === root || path.startsWith(`${root}/`);
    }
    if (normalizedPattern.endsWith('/*')) {
      const root = normalizedPattern.slice(0, -2);
      if (!path.startsWith(`${root}/`)) return false;
      return !path.slice(root.length + 1).includes('/');
    }
    if (normalizedPattern.includes('*')) return false;
    return path === normalizedPattern;
  }

  private assertActorFileCapability(
    actor: RuntimeWorkspaceActor,
    capability: 'read' | 'write' | 'delete',
    path: string
  ): void {
    const rules = actor.capabilities?.[capability];
    if (rules === undefined) return;
    const candidate = this.actorCapabilityPath(path);
    if (rules.some((pattern) => this.actorCapabilityMatches(pattern, candidate))) return;
    throw Object.assign(
      new Error(`EACCES: ${capability} is not allowed for actor ${actor.kind}:${actor.id}, '${path}'`),
      { code: 'EACCES', path }
    );
  }

  private assertHttpCapability(
    actor: RuntimeWorkspaceActor,
    capability: keyof NonNullable<RuntimeWorkspaceCapabilities['http']>
  ): void {
    if (this.hasHttpCapability(actor, capability)) return;
    throw Object.assign(
      new Error(`EACCES: network ${capability} is not permitted`),
      { code: 'EACCES' }
    );
  }

  private createKernelHttpBridge(context?: RuntimeCommandExecutionContext): RuntimeKernelHttpBridge {
    const actor = context?.actor ?? SYSTEM_ACTOR;
    const owner = context
      ? { pid: context.process.pid, idPrefix: 'http', actor }
      : { pid: 0, idPrefix: 'http-system', actor };
    return {
      listen: (options, handler) => {
        return this.registerHttpListener(options, handler, owner);
      },
      dispatch: (request, options) => this.dispatchHttpRequest(request, { ...options, actor, commandContext: context }),
    };
  }

  private createKernelSyscallBridge(
    context?: RuntimeCommandExecutionContext
  ): RuntimeKernelSyscallBridge | undefined {
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
      return undefined;
    }
    const channel = makeTraceKernelSharedSyscallChannel();
    const generationBuffer = this.ensureKernelSyscallGenerationBuffer();
    const server = new TraceKernelSharedSyscallServer(
      channel,
      makeTraceKernelPromiseSyscallHandler((request) =>
        this.dispatchRuntimeKernelSyscall(request, context)
      )
    );
    let closed = false;
    return {
      channel,
      ...(generationBuffer ? { generationBuffer } : {}),
      dispatch: (request) => this.dispatchRuntimeKernelSyscall(
        request as TraceKernelSyscallRequest,
        context
      ),
      service: () => server.servicePromise(),
      close: () => {
        if (closed) return;
        closed = true;
        server.close();
      },
    };
  }

  private ensureKernelSyscallGenerationBuffer(): SharedArrayBuffer | undefined {
    if (typeof SharedArrayBuffer === 'undefined') return undefined;
    if (this.kernelSyscallGenerationBuffer) return this.kernelSyscallGenerationBuffer;
    const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const generation = new Int32Array(buffer);
    Atomics.store(generation, 0, this.fs.mutationVersion | 0);
    this.kernelSyscallGenerationUnsubscribe = this.fs.watchMutations((revision) => {
      Atomics.store(generation, 0, revision | 0);
      Atomics.notify(generation, 0);
    });
    this.kernelSyscallGenerationBuffer = buffer;
    return buffer;
  }

  private async dispatchRuntimeKernelSyscall(
    request: TraceKernelSyscallRequest,
    context?: RuntimeCommandExecutionContext
  ): Promise<TraceKernelSyscallResult> {
    const actor = context?.actor ?? SYSTEM_ACTOR;
    const workspacePath = (path: string): string => this.toWorkspacePath(path);
    if (context) {
      context.liveKernelSyscallDepth = (context.liveKernelSyscallDepth ?? 0) + 1;
    }
    try {
      switch (request.op) {
        case 'watch': {
          const process = this.runtimeSyscallProcess(context);
          this.assertActorFileCapability(actor, 'read', request.path);
          const fd = await this.kernelDescriptors.watch(
            process.pid,
            context,
            workspacePath(request.path),
            request.options
          );
          return { ok: true, value: { op: 'watch', fd } };
        }
        case 'watchdog': {
          const process = this.runtimeSyscallProcess(context);
          const watchdog = this.configureRuntimeProcessWatchdog(
            process,
            request.action,
            request.timeoutMs,
            request.signal
          );
          return {
            ok: true,
            value: {
              op: 'watchdog',
              armed: watchdog !== undefined,
              ...(watchdog
                ? {
                    timeoutMs: watchdog.timeoutMs,
                    signal: watchdog.signal,
                    deadlineAt: watchdog.deadlineAt,
                  }
                : {}),
            },
          };
        }
        case 'pipe': {
          const process = this.runtimeSyscallProcess(context);
          const pipe = await this.kernelDescriptors.createPipe(
            process.pid,
            request.options
          );
          return {
            ok: true,
            value: {
              op: 'pipe',
              readFd: pipe.readFd,
              writeFd: pipe.writeFd,
            },
          };
        }
        case 'spawn': {
          const process = this.runtimeSyscallProcess(context);
          const spawned = await this.spawnRuntimeSyscallChild(
            process,
            request,
            context
          );
          return {
            ok: true,
            value: {
              op: 'spawn',
              pid: spawned.process.pid,
              ...(spawned.stdio ? { stdio: spawned.stdio } : {}),
            },
          };
        }
        case 'wait': {
          const process = this.runtimeSyscallProcess(context);
          const child = await this.waitRuntimeSyscallChild(
            process,
            request.pid
          );
          const exitCode = child.exitCode ?? 1;
          const signal = child.signal === 'SIGINT' ||
            child.signal === 'SIGTERM' ||
            child.signal === 'SIGKILL'
            ? child.signal
            : undefined;
          return {
            ok: true,
            value: {
              op: 'wait',
              pid: child.pid,
              termination: signal
                ? {
                    kind: 'signal',
                    signal,
                    exitCode,
                  }
                : {
                    kind: 'exit',
                    exitCode,
                  },
            },
          };
        }
        case 'kill': {
          const process = this.runtimeSyscallProcess(context);
          const target = this.findProcessRecord(request.pid);
          if (!target || target.state === 'exited') {
            throw Object.assign(
              new Error(`ESRCH: process ${request.pid} does not exist`),
              { code: 'ESRCH' }
            );
          }
          if (
            target.signalPolicy === 'system-only' &&
            process.actor.kind !== 'system'
          ) {
            throw Object.assign(
              new Error(`EACCES: process ${request.pid} is protected`),
              { code: 'EACCES' }
            );
          }
          this.signalProcess(target, request.signal);
          return { ok: true, value: { op: 'kill' } };
        }
        case 'socket': {
          const fd = await this.kernelNetwork.socket(
            context?.process.pid ?? 0
          );
          return { ok: true, value: { op: 'socket', fd } };
        }
        case 'bind': {
          this.assertHttpCapability(actor, 'listen');
          const address = await this.kernelNetwork.bind(
            context?.process.pid ?? 0,
            request.fd,
            request.address
          );
          return { ok: true, value: { op: 'bind', address } };
        }
        case 'listen':
          this.assertHttpCapability(actor, 'listen');
          await this.kernelNetwork.listen(
            context?.process.pid ?? 0,
            request.fd,
            request.options
          );
          return { ok: true, value: { op: 'listen' } };
        case 'accept': {
          this.assertHttpCapability(actor, 'listen');
          const accepted = await this.kernelNetwork.accept(
            context?.process.pid ?? 0,
            request.fd
          );
          return {
            ok: true,
            value: {
              op: 'accept',
              fd: accepted.fd,
              localAddress: accepted.localAddress,
              remoteAddress: accepted.remoteAddress,
            },
          };
        }
        case 'connect': {
          this.assertHttpCapability(actor, 'dispatch');
          const connected = await this.kernelNetwork.connect(
            context?.process.pid ?? 0,
            request.fd,
            request.address
          );
          return {
            ok: true,
            value: {
              op: 'connect',
              localAddress: connected.localAddress,
              remoteAddress: connected.remoteAddress,
            },
          };
        }
        case 'send': {
          const bytesWritten = await this.kernelDescriptors.write(
            context?.process.pid ?? 0,
            context,
            request.fd,
            request.bytes
          );
          return { ok: true, value: { op: 'send', bytesWritten } };
        }
        case 'recv': {
          const bytes = await this.kernelDescriptors.read(
            context?.process.pid ?? 0,
            context,
            request.fd,
            request.maxBytes
          );
          return { ok: true, value: { op: 'recv', bytes } };
        }
        case 'shutdown':
          await this.kernelNetwork.shutdown(
            context?.process.pid ?? 0,
            request.fd,
            request.how
          );
          return { ok: true, value: { op: 'shutdown' } };
        case 'getsockname': {
          const address = await this.kernelNetwork.localAddress(
            context?.process.pid ?? 0,
            request.fd
          );
          return { ok: true, value: { op: 'getsockname', address } };
        }
        case 'getpeername': {
          const address = await this.kernelNetwork.remoteAddress(
            context?.process.pid ?? 0,
            request.fd
          );
          return { ok: true, value: { op: 'getpeername', address } };
        }
        case 'open': {
          const access = request.options?.access ?? 'read';
          if (access === 'read' || access === 'read-write') {
            this.assertActorFileCapability(actor, 'read', request.path);
          }
          if (
            access === 'write' ||
            access === 'read-write' ||
            request.options?.create ||
            request.options?.truncate ||
            request.options?.append
          ) {
            this.assertActorFileCapability(actor, 'write', request.path);
          }
          const fd = await this.kernelDescriptors.open(
            context?.process.pid ?? 0,
            context,
            workspacePath(request.path),
            request.options
          );
          return { ok: true, value: { op: 'open', fd } };
        }
        case 'read': {
          const bytes = await this.kernelDescriptors.read(
            context?.process.pid ?? 0,
            context,
            request.fd,
            request.maxBytes,
            request.position
          );
          return { ok: true, value: { op: 'read', bytes } };
        }
        case 'write': {
          const bytesWritten = await this.kernelDescriptors.write(
            context?.process.pid ?? 0,
            context,
            request.fd,
            request.bytes,
            request.position
          );
          return { ok: true, value: { op: 'write', bytesWritten } };
        }
        case 'close':
          await this.kernelDescriptors.close(context?.process.pid ?? 0, request.fd);
          return { ok: true, value: { op: 'close' } };
        case 'dup': {
          const fd = await this.kernelDescriptors.dup(
            context?.process.pid ?? 0,
            request.fd
          );
          return { ok: true, value: { op: 'dup', fd } };
        }
        case 'fstat': {
          const stat = await this.kernelDescriptors.fstat(
            context?.process.pid ?? 0,
            context,
            request.fd
          );
          return { ok: true, value: { op: 'fstat', stat } };
        }
        case 'ftruncate':
          await this.kernelDescriptors.ftruncate(
            context?.process.pid ?? 0,
            context,
            request.fd,
            request.length
          );
          return { ok: true, value: { op: 'ftruncate' } };
        case 'readFile': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const path = workspacePath(request.path);
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const cacheGeneration = this.fs.mutationVersion | 0;
            const fileBytes = await this.fs.readFileBufferWithContext(context, path);
            if (cacheGeneration === (this.fs.mutationVersion | 0)) {
              return {
                ok: true,
                value: {
                  op: 'readFile',
                  bytes: fileBytes,
                  cacheGeneration,
                },
              };
            }
            if (attempt === 1) {
              return {
                ok: true,
                value: {
                  op: 'readFile',
                  bytes: fileBytes,
                  cacheGeneration: -1,
                },
              };
            }
          }
          break;
        }
        case 'writeFile': {
          this.assertActorFileCapability(actor, 'write', request.path);
          await this.fs.writeFileByInodeWithContext(
            context,
            workspacePath(request.path),
            request.bytes
          );
          return { ok: true, value: { op: 'writeFile' } };
        }
        case 'stat': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const path = workspacePath(request.path);
          const stat = await this.fs.statWithContext(context, path);
          const identityPath = await this.fs.inodeIdentityPathWithContext(context, path);
          const modifiedAt = stat.mtime instanceof Date ? stat.mtime.getTime() : 0;
          return {
            ok: true,
            value: {
              op: 'stat',
              stat: {
                path: request.path,
                kind: stat.isDirectory ? 'directory' : 'file',
                inode: this.fs.inodeForPath(identityPath),
                nlink: stat.isDirectory ? 2 : this.fs.inodeLinkCount(identityPath),
                mode: stat.mode ?? (stat.isDirectory ? 0o40755 : 0o100644),
                size: stat.size ?? 0,
                generation: this.fs.mutationVersion,
                createdAt: modifiedAt,
                modifiedAt,
                changedAt: modifiedAt,
              },
            },
          };
        }
        case 'lstat': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const path = workspacePath(request.path);
          const stat = await this.fs.lstatWithContext(context, path);
          const symbolicLink = runtimeFileSystemEntryIsSymlink(stat);
          const modifiedAt = stat.mtime instanceof Date ? stat.mtime.getTime() : 0;
          return {
            ok: true,
            value: {
              op: 'lstat',
              stat: {
                path: request.path,
                kind: symbolicLink
                  ? 'symlink'
                  : stat.isDirectory
                    ? 'directory'
                    : 'file',
                inode: this.fs.inodeForPath(path),
                nlink: symbolicLink
                  ? 1
                  : stat.isDirectory
                    ? 2
                    : this.fs.inodeLinkCount(path),
                mode: stat.mode ?? (
                  symbolicLink
                    ? 0o120777
                    : stat.isDirectory
                      ? 0o40755
                      : 0o100644
                ),
                size: stat.size ?? 0,
                generation: this.fs.mutationVersion,
                createdAt: modifiedAt,
                modifiedAt,
                changedAt: modifiedAt,
              },
            },
          };
        }
        case 'realpath': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const path = await this.fs.realpathWithContext(
            context,
            workspacePath(request.path)
          );
          return { ok: true, value: { op: 'realpath', path } };
        }
        case 'readdir': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const path = workspacePath(request.path);
          const entries = await this.fs.readdirWithFileTypesWithContext(
            context,
            path
          );
          return {
            ok: true,
            value: {
              op: 'readdir',
              entries: Object.freeze(entries
                .map((entry) => Object.freeze({
                  name: entry.name,
                  kind: entry.isSymbolicLink
                    ? 'symlink' as const
                    : entry.isDirectory
                      ? 'directory' as const
                      : 'file' as const,
                  inode: this.fs.inodeForPath(
                    path === '.'
                      ? entry.name
                      : `${path.replace(/\/+$/, '')}/${entry.name}`
                  ),
                }))
                .sort((left, right) => left.name.localeCompare(right.name))),
            },
          };
        }
        case 'mkdir': {
          this.assertActorFileCapability(actor, 'write', request.path);
          const path = workspacePath(request.path);
          await this.fs.mkdirWithContext(context, path, {
            recursive: request.options?.recursive,
          });
          if (request.options?.mode !== undefined) {
            await this.fs.chmodWithContext(context, path, request.options.mode);
          }
          return { ok: true, value: { op: 'mkdir' } };
        }
        case 'rmdir': {
          this.assertActorFileCapability(actor, 'delete', request.path);
          const path = workspacePath(request.path);
          const stat = await this.fs.statWithContext(context, path);
          if (!stat.isDirectory) {
            throw Object.assign(
              new Error(`ENOTDIR: not a directory, rmdir '${request.path}'`),
              { code: 'ENOTDIR' }
            );
          }
          await this.fs.rmWithContext(context, path, {
            force: false,
            recursive: false,
          });
          return { ok: true, value: { op: 'rmdir' } };
        }
        case 'unlink': {
          this.assertActorFileCapability(actor, 'delete', request.path);
          const path = workspacePath(request.path);
          const stat = await this.fs.lstatWithContext(context, path);
          if (stat.isDirectory) {
            throw Object.assign(
              new Error(`EISDIR: illegal operation on a directory, unlink '${request.path}'`),
              { code: 'EISDIR' }
            );
          }
          await this.fs.rmWithContext(context, path, {
            force: false,
            recursive: false,
          });
          return { ok: true, value: { op: 'unlink' } };
        }
        case 'link': {
          this.assertActorFileCapability(actor, 'read', request.existingPath);
          this.assertActorFileCapability(actor, 'write', request.newPath);
          await this.fs.linkWithContext(
            context,
            workspacePath(request.existingPath),
            workspacePath(request.newPath)
          );
          return { ok: true, value: { op: 'link' } };
        }
        case 'symlink': {
          this.assertActorFileCapability(actor, 'write', request.linkPath);
          await this.fs.symlinkWithContext(
            context,
            request.target,
            workspacePath(request.linkPath)
          );
          return { ok: true, value: { op: 'symlink' } };
        }
        case 'readlink': {
          this.assertActorFileCapability(actor, 'read', request.path);
          const target = await this.fs.readlinkWithContext(
            context,
            workspacePath(request.path)
          );
          return { ok: true, value: { op: 'readlink', target } };
        }
        case 'rename': {
          this.assertActorFileCapability(actor, 'delete', request.sourcePath);
          this.assertActorFileCapability(actor, 'write', request.destinationPath);
          await this.fs.mvWithContext(
            context,
            workspacePath(request.sourcePath),
            workspacePath(request.destinationPath)
          );
          return { ok: true, value: { op: 'rename' } };
        }
        default:
          return {
            ok: false,
            error: {
              code: 'ENOSYS',
              message: `ENOSYS: ${(request as { op: string }).op} is not available through the transitional workspace bridge`,
            },
          };
      }
      return {
        ok: false,
        error: { code: 'EIO', message: 'EIO: unreachable syscall state' },
      };
    } catch (error) {
      return this.runtimeKernelSyscallFailure(error);
    } finally {
      if (context) {
        context.liveKernelSyscallDepth = Math.max(
          0,
          (context.liveKernelSyscallDepth ?? 1) - 1
        );
      }
    }
  }

  private runtimeKernelSyscallFailure(error: unknown): TraceKernelSyscallResult {
    const explicitCode = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const detectedCode = typeof explicitCode === 'string'
      ? explicitCode
      : /^([A-Z][A-Z0-9]+):/.exec(message)?.[1];
    const code = detectedCode && TRACEKERNEL_SYSCALL_ERROR_CODES.has(detectedCode as TraceKernelSyscallErrorCode)
      ? detectedCode as TraceKernelSyscallErrorCode
      : 'EIO';
    return {
      ok: false,
      error: { code, message },
    };
  }

  private runtimeSyscallProcess(
    context?: RuntimeCommandExecutionContext
  ): RuntimeKernelProcessRecord {
    const process = context?.process as RuntimeKernelProcessRecord | undefined;
    if (!process || this.processTable.get(process.pid) !== process) {
      throw Object.assign(
        new Error('ESRCH: runtime syscall is not attached to a live process'),
        { code: 'ESRCH' }
      );
    }
    return process;
  }

  private async spawnRuntimeSyscallChild(
    parent: RuntimeKernelProcessRecord,
    request: Extract<TraceKernelSyscallRequest, { op: 'spawn' }>,
    parentContext?: RuntimeCommandExecutionContext
  ): Promise<RuntimeKernelSpawnedChild> {
    const command = [request.command, ...(request.args ?? [])]
      .map(shellQuote)
      .join(' ');
    const admissionError = this.processAdmissionError(command);
    if (admissionError) throw admissionError;

    let created = false;
    let resolveCreated!: (process: RuntimeKernelSpawnedChild) => void;
    let rejectCreated!: (error: unknown) => void;
    const childCreated = new Promise<RuntimeKernelSpawnedChild>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });
    const stdinPipe = request.stdio?.stdin === 'pipe'
      ? createRuntimeCommandStdinPipe()
      : request.stdio?.stdin === 'inherit'
        ? parentContext?.stdinPipe
        : undefined;
    const parentStdio: {
      stdinFd?: number;
      stdoutFd?: number;
      stderrFd?: number;
    } = {};
    let childContext: RuntimeCommandExecutionContext | undefined;
    let stdinPump: Promise<void> | undefined;
    let outputTail = Promise.resolve();
    const routeOutput = (
      stream: 'stdout' | 'stderr',
      data: string
    ): void => {
      const mode = request.stdio?.[stream];
      if (mode === 'inherit') {
        parentContext?.runtimeIo.handleRuntimeEvent({
          type: 'output',
          stream,
          device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
          data,
        });
        return;
      }
      if (mode !== 'pipe' || !childContext) return;
      const fd = stream === 'stdout' ? 1 : 2;
      const bytes = new TextEncoder().encode(data);
      outputTail = outputTail.then(async () => {
        try {
          await this.kernelDescriptors.write(
            childContext!.process.pid,
            childContext,
            fd,
            bytes
          );
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code !== 'EPIPE' && code !== 'EBADF') throw error;
        }
      });
    };
    const completion = this.runCommandAs(
      command,
      {
        cwd: request.cwd ?? parent.cwd,
        env: {
          ...parent.env,
          ...(request.env ?? {}),
        },
        ...(stdinPipe ? { stdinPipe } : {}),
        retainOnExit: true,
        onEvent: (event) => {
          if (event.type === 'output') routeOutput(event.stream, event.data);
        },
      },
      parent,
      {
        initialize: async (child, context) => {
          childContext = context;
          try {
            if (request.inheritDescriptors !== undefined) {
              const replacedStdioFds = new Set<number>(
                ([
                  [0, request.stdio?.stdin],
                  [1, request.stdio?.stdout],
                  [2, request.stdio?.stderr],
                ] as const)
                  .filter(([, mode]) => mode === 'pipe' || mode === 'ignore')
                  .map(([fd]) => fd)
              );
              const inherited = (
                request.inheritDescriptors === 'all'
                  ? this.kernelDescriptors.descriptorNumbers(parent.pid)
                  : request.inheritDescriptors
              ).filter((fd) => !replacedStdioFds.has(fd));
              await this.kernelDescriptors.inherit(
                child.pid,
                parent.pid,
                inherited
              );
            }
            if (request.stdio?.stdin === 'pipe' && stdinPipe) {
              const pipe = await this.kernelDescriptors.createPipeBetween(
                { pid: child.pid, fd: 0 },
                { pid: parent.pid },
                { capacityChunks: 16 }
              );
              parentStdio.stdinFd = pipe.writeFd;
              stdinPump = (async () => {
                try {
                  while (true) {
                    const bytes = await this.kernelDescriptors.read(
                      child.pid,
                      context,
                      0,
                      16 * 1024
                    );
                    if (bytes.byteLength === 0) break;
                    await writeRuntimeCommandStdinPipeBytes(stdinPipe, bytes);
                  }
                } catch (error) {
                  const code = (error as { code?: unknown } | null)?.code;
                  if (code !== 'EBADF') throw error;
                } finally {
                  stdinPipe.close();
                }
              })();
              void stdinPump.catch(() => undefined);
            }
            if (request.stdio?.stdout === 'pipe') {
              const pipe = await this.kernelDescriptors.createPipeBetween(
                { pid: parent.pid },
                { pid: child.pid, fd: 1 },
                { capacityChunks: 16 }
              );
              parentStdio.stdoutFd = pipe.readFd;
            }
            if (request.stdio?.stderr === 'pipe') {
              const pipe = await this.kernelDescriptors.createPipeBetween(
                { pid: parent.pid },
                { pid: child.pid, fd: 2 },
                { capacityChunks: 16 }
              );
              parentStdio.stderrFd = pipe.readFd;
            }
          } catch (error) {
            await Promise.all(
              Object.values(parentStdio).map((fd) =>
                this.kernelDescriptors.close(parent.pid, fd).catch(() => undefined)
              )
            );
            throw error;
          }
        },
        ready: (child) => {
          created = true;
          resolveCreated({
            process: child,
            ...(Object.keys(parentStdio).length > 0
              ? { stdio: Object.freeze({ ...parentStdio }) }
              : {}),
          });
        },
        beforeDescriptorClose: async () => {
          await outputTail;
        },
        afterDescriptorClose: async () => {
          await stdinPump?.catch(() => undefined);
        },
      }
    );
    void completion.then(
      (result) => {
        if (!created) {
          rejectCreated(Object.assign(
            new Error(
              result.error?.message ??
              `EIO: child process '${command}' completed before admission`
            ),
            { code: result.error?.code ?? 'EIO' }
          ));
        }
      },
      (error) => {
        if (!created) rejectCreated(error);
      }
    );
    return childCreated;
  }

  private async waitRuntimeSyscallChild(
    parent: RuntimeKernelProcessRecord,
    pid: number
  ): Promise<RuntimeKernelProcessRecord> {
    const child = this.findProcessRecord(pid);
    if (
      !child ||
      child.ppid !== parent.pid ||
      this.runtimeChildWaits.has(pid)
    ) {
      throw Object.assign(
        new Error(
          `ECHILD: process ${pid} is not an unreaped child of process ${parent.pid}`
        ),
        { code: 'ECHILD' }
      );
    }
    this.runtimeChildWaits.add(pid);
    try {
      const zombie = await this.waitForZombieProcess(pid, parent.pid);
      if (!zombie || zombie.ppid !== parent.pid) {
        throw Object.assign(
          new Error(
            `ECHILD: process ${pid} is not an unreaped child of process ${parent.pid}`
          ),
          { code: 'ECHILD' }
        );
      }
      this.zombieProcessTable.delete(pid);
      this.recordKernelEvent('process-reap', pid, {
        exitCode: zombie.exitCode ?? 0,
        signal: zombie.signal,
        parentPid: parent.pid,
      });
      return zombie;
    } finally {
      this.runtimeChildWaits.delete(pid);
    }
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
      return this.httpErrorResponse(
        400,
        this.createHttpError('EINVAL', `EINVAL: invalid URL: ${options.url}`)
      );
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

  private createHttpError(code: string, message: string): RuntimeKernelHttpError {
    return { code, message };
  }

  private httpErrorFromThrown(error: unknown, fallbackCode: string): RuntimeKernelHttpError {
    const message = error instanceof Error ? error.message : String(error);
    const taggedCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    const parsedCode = /^([A-Z][A-Z0-9_]*):/.exec(message)?.[1] ?? '';
    return this.createHttpError(taggedCode || parsedCode || fallbackCode, message);
  }

  private httpErrorResponse(status: number, error: RuntimeKernelHttpError, body = `${error.message}\n`): RuntimeKernelHttpResponse {
    return { status, body, error };
  }

  private httpHostUnreachableResponse(
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    reason: string
  ): RuntimeKernelHttpResponse {
    if (reason === 'unknown-host') {
      const message = `getaddrinfo ENOTFOUND ${url.hostname}`;
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'ENOTFOUND',
      });
      return {
        status: 0,
        body: `${message}\n`,
        error: this.createHttpError('ENOTFOUND', message),
      };
    }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const message = `EHOSTUNREACH: host ${url.hostname} is unreachable (${reason})`;
    this.recordHttpRequest({
      method: normalizedRequest.method,
      url: normalizedRequest.url,
      error: 'EHOSTUNREACH',
    });
    return {
      status: 0,
      body: `curl: (7) Failed to connect to ${url.hostname} port ${port}: Host unreachable\n`,
      error: this.createHttpError('EHOSTUNREACH', message),
    };
  }

  public resolveHost(hostname: string): HostResolution {
    const host = String(hostname).trim().toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return { reachable: true, via: 'loopback', ip: '127.0.0.1', latencyMs: 0.05 };
    }
    for (const listener of this.httpListeners.values()) {
      if (listener.info.host === host) {
        return { reachable: true, via: 'listener', ip: syntheticIp(host), latencyMs: syntheticLatency(host) };
      }
    }
    if (this.externalHttp && this.isExternalHttpHostReachable(this.externalHttp, host)) {
      return { reachable: true, via: 'external', ip: syntheticIp(host), latencyMs: syntheticLatency(host) };
    }
    return { reachable: false, reason: 'unknown-host' };
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
    if (entries.length === 0) return undefined;
    if (entries.length > TRACEKERNEL_HTTP_MAX_HEADER_COUNT) {
      throw Object.assign(new Error('EMSGSIZE: HTTP header count limit exceeded'), { code: 'EMSGSIZE' });
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
        throw Object.assign(new Error('EMSGSIZE: HTTP header byte limit exceeded'), { code: 'EMSGSIZE' });
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
      throw Object.assign(new Error('EMSGSIZE: HTTP raw header count limit exceeded'), { code: 'EMSGSIZE' });
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
        throw Object.assign(new Error('EMSGSIZE: HTTP raw header byte limit exceeded'), { code: 'EMSGSIZE' });
      }
      normalized.push([key, text]);
    }
    return normalized;
  }

  private normalizeHttpRequestPath(path: unknown, url: URL): RuntimeKernelHttpPathResult {
    const fallback = `${url.pathname || '/'}${url.search}`;
    const normalized = String(path ?? fallback) || fallback;
    if (!normalized.startsWith('/') || normalized.length > 8192 || /[\r\n\u0000]/.test(normalized)) {
      return {
        ok: false,
        error: this.createHttpError('EINVAL', `EINVAL: invalid HTTP request path '${this.sanitizeHttpDiagnosticField(normalized)}'`),
      };
    }
    return { ok: true, path: normalized };
  }

  private assertHttpBodyLimit(message: RuntimeKernelHttpBodyPayload, direction: 'request' | 'response'): void {
    let bytes: Uint8Array;
    try {
      bytes = runtimeHttpBodyBytes(message);
    } catch {
      throw Object.assign(new Error(`EINVAL: invalid HTTP ${direction} body encoding`), { code: 'EINVAL' });
    }
    if (bytes.byteLength > TRACEKERNEL_HTTP_MAX_BODY_BYTES) {
      throw Object.assign(new Error(`EMSGSIZE: HTTP ${direction} body limit exceeded`), { code: 'EMSGSIZE' });
    }
  }

  private normalizeHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequestResult {
    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      return { ok: false, error: this.createHttpError('EINVAL', 'EINVAL: invalid HTTP request URL') };
    }
    let rawHeaders: readonly [string, string][] | undefined;
    let explicitHeaders: Record<string, string> | undefined;
    try {
      rawHeaders = this.normalizeHttpRawHeaders(request.rawHeaders);
      explicitHeaders = this.normalizeHttpHeaders(request.headers);
    } catch (error) {
      return { ok: false, error: this.httpErrorFromThrown(error, 'EINVAL') };
    }
    const headers = explicitHeaders ?? (rawHeaders ? this.httpHeadersFromRawHeaders(rawHeaders) : undefined);
    const path = this.normalizeHttpRequestPath(request.path, url);
    if (!path.ok) {
      return { ok: false, error: path.error };
    }
    let method: string;
    try {
      method = this.normalizeHttpMethod(request.method);
    } catch (error) {
      return { ok: false, error: this.httpErrorFromThrown(error, 'EINVAL') };
    }
    const normalized: RuntimeKernelHttpRequest = {
      method,
      url: url.toString(),
      path: path.path,
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
    try {
      this.assertHttpBodyLimit(normalized, 'request');
    } catch (error) {
      return { ok: false, error: this.httpErrorFromThrown(error, 'EINVAL') };
    }
    return { ok: true, request: normalized };
  }

  private normalizeHttpResponse(response: RuntimeKernelHttpResponse): RuntimeKernelHttpResponse {
    const status = Math.trunc(Number(response.status));
    if (!Number.isFinite(status) || status < 100 || status > 599) {
      throw Object.assign(new Error(`EINVAL: invalid HTTP response status '${response.status}'`), {
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
    if (response.annotation !== undefined) normalized.annotation = response.annotation;
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
        throw Object.assign(new Error('EACCES: wildcard listen is not permitted'), {
          code: 'EACCES',
        });
      }
      return '0.0.0.0';
    }
    if (normalized === 'localhost') return '127.0.0.1';
    if (this.isHttpWildcardHost(normalized) && actor.kind === 'runtime') {
      throw Object.assign(new Error('EACCES: wildcard listen is not permitted'), {
        code: 'EACCES',
      });
    }
    return this.normalizeHttpHost(normalized, 'listen');
  }

  private isHttpWildcardHost(host: string): boolean {
    return host === '0.0.0.0';
  }

  private isHttpWildcardConnectHost(host: string): boolean {
    return host === '127.0.0.1';
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
    throw Object.assign(new Error('EADDRNOTAVAIL: no ephemeral ports available'), { code: 'EADDRNOTAVAIL' });
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
    const actor = owner?.actor ?? SYSTEM_ACTOR;
    this.assertHttpCapability(actor, 'listen');
    const listenerOwner = owner;
    if (!listenerOwner) {
      throw Object.assign(new Error('EINVAL: listen requires an active process context'), { code: 'EINVAL' });
    }
    const protocol = options.protocol ?? 'http';
    if (protocol !== 'http') {
      throw Object.assign(new Error(`EPROTONOSUPPORT: unsupported protocol '${protocol}'`), {
        code: 'EPROTONOSUPPORT',
      });
    }
    const host = this.normalizeHttpListenHost(options.host, actor);
    const port = this.normalizeHttpListenPort(options.port);
    const key = this.httpListenerKey(host, port, protocol);
    if (!this.httpListeners.has(key) && this.httpListeners.size >= TRACEKERNEL_HTTP_LISTENER_LIMIT) {
      throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
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
    const listener: RuntimeKernelHttpListenerRecord = {
      info,
      handler,
      actor,
      ready: Promise.resolve(),
      closed: false,
      listening: false,
      connectionControllers: new Map(),
    };
    this.httpListeners.set(key, listener);
    listener.ready = this.initializeHttpTcpListener(key, listener);
    // Direct workspace consumers historically did not have to observe a
    // readiness promise. Keep asynchronous bind failures available to callers
    // without turning an intentionally ignored handle into an unhandled
    // rejection.
    void listener.ready.catch(() => undefined);
    return {
      id: info.id,
      info,
      ready: listener.ready.then(() => info),
      close: () => {
        this.closeHttpListener(key, listener);
      },
    };
  }

  private async initializeHttpTcpListener(
    key: string,
    listener: RuntimeKernelHttpListenerRecord
  ): Promise<void> {
    let fd: number | undefined;
    try {
      fd = await this.kernelNetwork.socket(listener.info.pid);
      listener.listenerFd = fd;
      if (listener.closed || this.httpListeners.get(key) !== listener) {
        await this.kernelDescriptors.close(listener.info.pid, fd).catch(() => undefined);
        listener.listenerFd = undefined;
        return;
      }
      const localTransportHost =
        listener.info.host === '127.0.0.1' || listener.info.host === '0.0.0.0';
      listener.transportAddress = await this.kernelNetwork.bind(
        listener.info.pid,
        fd,
        localTransportHost
          ? { host: listener.info.host, port: listener.info.port }
          : { host: '127.0.0.1', port: 0 }
      );
      await this.kernelNetwork.listen(listener.info.pid, fd, {
        backlog: TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS,
      });
      if (listener.closed || this.httpListeners.get(key) !== listener) {
        await this.kernelDescriptors.close(listener.info.pid, fd).catch(() => undefined);
        listener.listenerFd = undefined;
        listener.transportAddress = undefined;
        return;
      }
      listener.listening = true;
      this.recordKernelEvent('net-listen', listener.info.pid, {
        id: listener.info.id,
        protocol: listener.info.protocol,
        host: listener.info.host,
        port: listener.info.port,
      });
      void this.serveHttpTcpListener(listener).catch((error) => {
        if (listener.closed) return;
        this.recordKernelEvent('net-error', listener.info.pid, {
          id: listener.info.id,
          protocol: listener.info.protocol,
          error: this.sanitizeHttpDiagnosticField(
            error instanceof Error ? error.message : String(error)
          ),
        });
      });
    } catch (error) {
      if (this.httpListeners.get(key) === listener) this.httpListeners.delete(key);
      listener.closed = true;
      if (fd !== undefined) {
        await this.kernelDescriptors.close(listener.info.pid, fd).catch(() => undefined);
      }
      listener.listenerFd = undefined;
      listener.transportAddress = undefined;
      throw error;
    }
  }

  private closeHttpListener(
    key: string,
    listener: RuntimeKernelHttpListenerRecord,
    forceConnections = false
  ): void {
    if (listener.closed) {
      if (forceConnections) this.forceCloseHttpConnections(listener);
      return;
    }
    listener.closed = true;
    if (this.httpListeners.get(key) === listener) this.httpListeners.delete(key);
    if (listener.listening) {
      listener.listening = false;
      this.recordKernelEvent('net-close', listener.info.pid, {
        id: listener.info.id,
        protocol: listener.info.protocol,
        host: listener.info.host,
        port: listener.info.port,
      });
    }
    if (forceConnections) this.forceCloseHttpConnections(listener);
    else if (listener.connectionControllers.size > 0) {
      this.retiredHttpListeners.add(listener);
    }
    if (listener.listenerFd !== undefined) {
      void this.kernelDescriptors
        .close(listener.info.pid, listener.listenerFd)
        .catch(() => undefined);
    }
  }

  private forceCloseHttpConnections(listener: RuntimeKernelHttpListenerRecord): void {
    this.retiredHttpListeners.delete(listener);
    for (const [fd, controller] of listener.connectionControllers) {
      if (!controller.signal.aborted) controller.abort();
      void this.kernelDescriptors.close(listener.info.pid, fd).catch(() => undefined);
    }
    listener.connectionControllers.clear();
  }

  private async serveHttpTcpListener(
    listener: RuntimeKernelHttpListenerRecord
  ): Promise<void> {
    const listenerFd = listener.listenerFd;
    if (listenerFd === undefined) return;
    while (!listener.closed) {
      let accepted: Awaited<ReturnType<RuntimeKernelNetworkManager['accept']>>;
      try {
        accepted = await this.kernelNetwork.accept(listener.info.pid, listenerFd);
      } catch (error) {
        if (listener.closed) return;
        throw error;
      }
      if (listener.closed) {
        await this.kernelDescriptors
          .close(listener.info.pid, accepted.fd)
          .catch(() => undefined);
        return;
      }
      if (
        listener.connectionControllers.size >=
        TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS
      ) {
        await this.kernelDescriptors
          .close(listener.info.pid, accepted.fd)
          .catch(() => undefined);
        this.recordKernelEvent('net-reject', listener.info.pid, {
          id: listener.info.id,
          protocol: listener.info.protocol,
          error: 'EAGAIN',
          reason: 'HTTP connection limit reached',
        });
        continue;
      }
      const controller = new AbortController();
      listener.connectionControllers.set(accepted.fd, controller);
      void this.serveHttpTcpConnection(
        listener,
        accepted.fd,
        accepted.remoteAddress.port,
        controller
      )
        .catch((error) => {
          if (listener.closed || controller.signal.aborted) return;
          this.recordKernelEvent('net-error', listener.info.pid, {
            id: listener.info.id,
            protocol: listener.info.protocol,
            error: this.sanitizeHttpDiagnosticField(
              error instanceof Error ? error.message : String(error)
            ),
          });
        })
        .finally(() => {
          listener.connectionControllers.delete(accepted.fd);
          if (listener.closed && listener.connectionControllers.size === 0) {
            this.retiredHttpListeners.delete(listener);
          }
          void this.kernelDescriptors
            .close(listener.info.pid, accepted.fd)
            .catch(() => undefined);
        });
    }
  }

  private httpTcpRequestUrl(
    listener: RuntimeKernelHttpListenerRecord,
    request: TraceKernelHttp1Request,
    headers: Record<string, string> | undefined,
    context: RuntimeKernelHttpTcpDispatchContext | undefined
  ): string {
    if (context) return new URL(request.target, context.url).toString();
    const defaultAuthority = listener.info.port === 80
      ? listener.info.host
      : `${listener.info.host}:${listener.info.port}`;
    const authority = headers?.host ?? defaultAuthority;
    try {
      return new URL(request.target, `http://${authority}/`).toString();
    } catch {
      return new URL(request.target, `http://${defaultAuthority}/`).toString();
    }
  }

  private async serveHttpTcpConnection(
    listener: RuntimeKernelHttpListenerRecord,
    fd: number,
    remotePort: number,
    controller: AbortController
  ): Promise<void> {
    const context = this.httpTcpDispatches.get(remotePort);
    const forwardAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(context?.signal.reason);
    };
    if (context) {
      context.signal.addEventListener('abort', forwardAbort, { once: true });
      if (context.signal.aborted) forwardAbort();
    }
    let response: RuntimeKernelHttpResponse;
    try {
      let requestHeadTimeout: ReturnType<typeof setTimeout> | undefined;
      const requestHeadTimedOut = new Promise<never>((_resolve, reject) => {
        requestHeadTimeout = setTimeout(() => {
          if (!controller.signal.aborted) controller.abort();
          void this.kernelDescriptors
            .close(listener.info.pid, fd)
            .catch(() => undefined);
          reject(Object.assign(
            new Error('ETIMEDOUT: HTTP request head timed out'),
            { code: 'ETIMEDOUT' }
          ));
        }, TRACEKERNEL_HTTP_REQUEST_FRAME_TIMEOUT_MS);
      });
      let decodedRequest: TraceKernelHttp1Request;
      try {
        decodedRequest = await Promise.race([
          this.readHttp1Message('request', listener.info.pid, fd),
          requestHeadTimedOut,
        ]);
      } finally {
        if (requestHeadTimeout !== undefined) clearTimeout(requestHeadTimeout);
      }
      const headers = this.httpHeadersFromHttp1(decodedRequest.headers);
      const body = decodedRequest.body.byteLength > 0
        ? runtimeHttpBodyFromBytes(decodedRequest.body)
        : {};
      const request: RuntimeKernelHttpRequest = {
        method: decodedRequest.method,
        url: this.httpTcpRequestUrl(listener, decodedRequest, headers, context),
        path: decodedRequest.target,
        ...(headers ? { headers } : {}),
        ...(decodedRequest.headers.length > 0
          ? {
              rawHeaders: decodedRequest.headers.map(
                ({ name, value }): [string, string] => [name, value]
              ),
            }
          : {}),
        ...body,
        signal: controller.signal,
      };
      try {
        response = this.normalizeHttpResponse(await listener.handler(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = {
          status: 500,
          body: this.httpListenerErrorBody(
            listener,
            context?.actor ?? RUNTIME_ACTOR,
            message
          ),
        };
      }
      context?.resolve(response);
    } catch (error) {
      context?.reject(error);
      response = {
        status: 400,
        body: 'Bad Request\n',
      };
    } finally {
      context?.signal.removeEventListener('abort', forwardAbort);
    }

    const responseBytes = encodeTraceKernelHttp1Response({
      status: response.status,
      statusText: TRACEKERNEL_HTTP_STATUS_TEXT[response.status] ?? '',
      headers: this.http1Headers(response.rawHeaders, response.headers),
      body: runtimeHttpResponseBytes(response),
    }, this.traceKernelHttp1Limits());
    await this.kernelDescriptors.write(
      listener.info.pid,
      undefined,
      fd,
      responseBytes
    );
    await this.kernelNetwork.shutdown(listener.info.pid, fd, 'write');
  }

  private closeHttpListenersForProcess(pid: number): void {
    for (const [key, listener] of this.httpListeners) {
      if (listener.info.pid !== pid) continue;
      this.closeHttpListener(key, listener, true);
    }
    for (const listener of this.retiredHttpListeners) {
      if (listener.info.pid === pid) this.forceCloseHttpConnections(listener);
    }
  }

  private closeAllHttpListeners(): void {
    for (const [key, listener] of this.httpListeners) {
      this.closeHttpListener(key, listener, true);
    }
    for (const listener of this.retiredHttpListeners) {
      this.forceCloseHttpConnections(listener);
    }
    this.httpTcpDispatches.clear();
  }

  private findHttpListener(url: URL): RuntimeKernelHttpListenerRecord | undefined {
    if (url.protocol !== 'http:') return undefined;
    const host = this.normalizeHttpConnectHost(url.hostname);
    const port = this.normalizeHttpConnectPort(url.port ? Number(url.port) : 80);
    const exact = this.httpListeners.get(this.httpListenerKey(host, port, 'http'));
    if (exact) return exact;
    return this.isHttpWildcardConnectHost(host)
      ? this.httpListeners.get(this.httpListenerKey('0.0.0.0', port, 'http'))
      : undefined;
  }

  private traceKernelHttp1Limits(): {
    maxStartLineBytes: number;
    maxHeaderBytes: number;
    maxHeaderCount: number;
    maxBodyBytes: number;
  } {
    return {
      maxStartLineBytes: 8 * 1024,
      maxHeaderBytes: TRACEKERNEL_HTTP_MAX_HEADER_BYTES,
      maxHeaderCount: TRACEKERNEL_HTTP_MAX_HEADER_COUNT,
      maxBodyBytes: TRACEKERNEL_HTTP_MAX_BODY_BYTES,
    };
  }

  private http1Headers(
    rawHeaders: readonly [string, string][] | undefined,
    headers: Record<string, string> | undefined
  ): TraceKernelHttp1Header[] {
    const entries = rawHeaders ?? Object.entries(headers ?? {});
    return entries.map(([name, value]) => ({ name, value }));
  }

  private httpHeadersFromHttp1(
    headers: readonly TraceKernelHttp1Header[]
  ): Record<string, string> | undefined {
    if (headers.length === 0) return undefined;
    const normalized: Record<string, string> = {};
    for (const header of headers) {
      normalized[header.name.toLowerCase()] = header.value;
    }
    return normalized;
  }

  private readHttp1Message(
    kind: 'request',
    pid: number,
    fd: number,
    context?: RuntimeCommandExecutionContext
  ): Promise<TraceKernelHttp1Request>;
  private readHttp1Message(
    kind: 'response',
    pid: number,
    fd: number,
    context?: RuntimeCommandExecutionContext
  ): Promise<TraceKernelHttp1Response>;
  private async readHttp1Message(
    kind: 'request' | 'response',
    pid: number,
    fd: number,
    context?: RuntimeCommandExecutionContext
  ): Promise<TraceKernelHttp1Message> {
    const decoder = new TraceKernelHttp1Decoder(kind, this.traceKernelHttp1Limits());
    while (true) {
      const bytes = await this.kernelDescriptors.read(
        pid,
        context,
        fd,
        TRACEKERNEL_HTTP_TCP_READ_BYTES
      );
      if (bytes.byteLength === 0) {
        return decoder.finish();
      }
      const message = decoder.push(bytes);
      if (message) return message;
    }
  }

  private runtimeHttpResponseFromHttp1(
    response: TraceKernelHttp1Response
  ): RuntimeKernelHttpResponse {
    const headers = this.httpHeadersFromHttp1(response.headers);
    return {
      status: response.status,
      ...(headers ? { headers } : {}),
      ...(response.headers.length > 0
        ? {
            rawHeaders: response.headers.map(
              ({ name, value }): [string, string] => [name, value]
            ),
          }
        : {}),
      ...(response.body.byteLength > 0
        ? runtimeHttpBodyFromBytes(response.body)
        : {}),
    };
  }

  private isLocalTcpHttpTarget(url: URL): boolean {
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0';
  }

  private async dispatchUnmanagedHttpOverTcp(
    request: RuntimeKernelHttpRequest,
    url: URL,
    signal: AbortSignal,
    commandContext?: RuntimeCommandExecutionContext
  ): Promise<RuntimeKernelHttpResponse> {
    const pid = commandContext?.process.pid ?? 0;
    let fd: number | undefined;
    let abortReject: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortReject = reject;
    });
    const abortError = Object.assign(new Error('EINTR: HTTP request interrupted'), {
      code: 'EINTR',
    });
    const onAbort = (): void => {
      if (fd !== undefined) {
        void this.kernelDescriptors.close(pid, fd).catch(() => undefined);
      }
      abortReject?.(abortError);
    };
    try {
      fd = await this.kernelNetwork.socket(pid);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      await Promise.race([
        this.kernelNetwork.connect(pid, fd, {
          host: this.normalizeHttpConnectHost(url.hostname),
          port: this.normalizeHttpConnectPort(url.port ? Number(url.port) : 80),
        }),
        aborted,
      ]);
      const headers = this.http1Headers(request.rawHeaders, request.headers);
      if (!headers.some((header) => header.name.toLowerCase() === 'host')) {
        headers.push({ name: 'Host', value: url.host });
      }
      const bytes = encodeTraceKernelHttp1Request({
        method: request.method,
        target: request.path,
        headers,
        body: runtimeHttpRequestBytes(request),
      }, this.traceKernelHttp1Limits());
      await Promise.race([
        this.kernelDescriptors.write(pid, commandContext, fd, bytes),
        aborted,
      ]);
      await Promise.race([
        this.kernelNetwork.shutdown(pid, fd, 'write'),
        aborted,
      ]);
      const response = await Promise.race([
        this.readHttp1Message('response', pid, fd, commandContext),
        aborted,
      ]);
      return this.runtimeHttpResponseFromHttp1(response);
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (fd !== undefined) {
        await this.kernelDescriptors.close(pid, fd).catch(() => undefined);
      }
    }
  }

  private async dispatchLocalHttpOverTcp(
    listener: RuntimeKernelHttpListenerRecord,
    request: RuntimeKernelHttpRequest,
    url: URL,
    actor: RuntimeWorkspaceActor,
    handlerSignal: AbortSignal,
    commandContext?: RuntimeCommandExecutionContext
  ): Promise<RuntimeKernelHttpResponse> {
    await listener.ready;
    const transportAddress = listener.transportAddress;
    if (listener.closed || listener.listenerFd === undefined || transportAddress === undefined) {
      throw Object.assign(new Error('ECONNREFUSED: HTTP listener is closed'), {
        code: 'ECONNREFUSED',
      });
    }

    const clientPid = commandContext?.process.pid ?? 0;
    let clientFd: number | undefined;
    let clientPort: number | undefined;
    let resolveControl!: (response: RuntimeKernelHttpResponse) => void;
    let rejectControl!: (error: unknown) => void;
    const controlResponse = new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      resolveControl = resolve;
      rejectControl = reject;
    });
    void controlResponse.catch(() => undefined);
    const dispatchContext: RuntimeKernelHttpTcpDispatchContext = {
      url,
      actor,
      signal: handlerSignal,
      response: controlResponse,
      resolve: resolveControl,
      reject: rejectControl,
    };
    const abortError = Object.assign(new Error('EINTR: HTTP request interrupted'), {
      code: 'EINTR',
    });
    let abortReject: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortReject = reject;
    });
    const onAbort = (): void => {
      if (clientFd !== undefined) {
        void this.kernelDescriptors.close(clientPid, clientFd).catch(() => undefined);
      }
      abortReject?.(abortError);
    };

    try {
      clientFd = await this.kernelNetwork.socket(clientPid);
      const localAddress = await this.kernelNetwork.bind(clientPid, clientFd, {
        host: '127.0.0.1',
        port: 0,
      });
      clientPort = localAddress.port;
      this.httpTcpDispatches.set(clientPort, dispatchContext);
      await this.kernelNetwork.connect(clientPid, clientFd, {
        host: transportAddress.host === '0.0.0.0'
          ? '127.0.0.1'
          : transportAddress.host,
        port: transportAddress.port,
      });

      const requestHeaders = this.http1Headers(request.rawHeaders, request.headers);
      if (!requestHeaders.some((header) => header.name.toLowerCase() === 'host')) {
        requestHeaders.push({ name: 'Host', value: url.host });
      }
      const requestBytes = encodeTraceKernelHttp1Request({
        method: request.method,
        target: request.path,
        headers: requestHeaders,
        body: runtimeHttpRequestBytes(request),
      }, this.traceKernelHttp1Limits());
      await this.kernelDescriptors.write(
        clientPid,
        commandContext,
        clientFd,
        requestBytes
      );
      await this.kernelNetwork.shutdown(clientPid, clientFd, 'write');

      handlerSignal.addEventListener('abort', onAbort, { once: true });
      if (handlerSignal.aborted) onAbort();

      const decodedResponse = await Promise.race([
        this.readHttp1Message('response', clientPid, clientFd, commandContext),
        aborted,
      ]);
      const control = await Promise.race([controlResponse, aborted]);
      return {
        ...this.runtimeHttpResponseFromHttp1(decodedResponse),
        ...(control.annotation !== undefined
          ? { annotation: control.annotation }
          : {}),
      };
    } finally {
      handlerSignal.removeEventListener('abort', onAbort);
      if (
        clientPort !== undefined &&
        this.httpTcpDispatches.get(clientPort) === dispatchContext
      ) {
        this.httpTcpDispatches.delete(clientPort);
      }
      if (clientFd !== undefined) {
        await this.kernelDescriptors.close(clientPid, clientFd).catch(() => undefined);
      }
    }
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
      return 'Internal Server Error\n';
    }
    return `${message}\n`;
  }

  private runtimeExternalHttpAllowlistReason(config: NormalizedRuntimeExternalHttpConfig, url: URL): string | null {
    if (typeof config.hosts === 'function') {
      try {
        return config.hosts(url) ? null : `host ${url.hostname} is not allowlisted`;
      } catch (error) {
        return `host allowlist predicate failed: ${this.sanitizeHttpDiagnosticField(error instanceof Error ? error.message : String(error))}`;
      }
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? Number(url.port) : defaultRuntimeExternalHttpPort(url.protocol);
    const defaultPort = defaultRuntimeExternalHttpPort(url.protocol);
    for (const rule of config.hosts) {
      if (rule.port !== undefined) {
        if (port !== rule.port) continue;
      } else if (port !== defaultPort) {
        continue;
      }
      if (rule.wildcardSubdomains) {
        if (hostname !== rule.hostname && hostname.endsWith(`.${rule.hostname}`)) return null;
      } else if (hostname === rule.hostname) {
        return null;
      }
    }
    return `host ${url.hostname} is not allowlisted`;
  }

  private isExternalHttpHostReachable(config: NormalizedRuntimeExternalHttpConfig, hostname: string): boolean {
    if (!isBareHostnameForExternalResolution(hostname)) return false;
    const protocols = config.allowHttp ? ['https:', 'http:'] : ['https:'];
    if (typeof config.hosts !== 'function') {
      let routable = false;
      for (const protocol of protocols) {
        try {
          if (!isBlockedExternalHttpHost(new URL(`${protocol}//${hostname}/`))) routable = true;
        } catch {
          continue;
        }
      }
      if (!routable) return false;
      const normalized = hostname.toLowerCase();
      for (const rule of config.hosts) {
        if (rule.wildcardSubdomains) {
          if (normalized !== rule.hostname && normalized.endsWith(`.${rule.hostname}`)) return true;
        } else if (normalized === rule.hostname) {
          return true;
        }
      }
      return false;
    }
    for (const protocol of protocols) {
      let url: URL;
      try {
        url = new URL(`${protocol}//${hostname}/`);
      } catch {
        continue;
      }
      if (isBlockedExternalHttpHost(url)) continue;
      if (!this.runtimeExternalHttpAllowlistReason(config, url)) return true;
    }
    return false;
  }

  private consumeExternalHttpBudget(
    config: NormalizedRuntimeExternalHttpConfig,
    context: RuntimeCommandExecutionContext | undefined
  ): boolean {
    if (context) {
      const count = context.externalHttpRequestCount ?? 0;
      if (count >= config.maxRequestsPerCommand) return false;
      context.externalHttpRequestCount = count + 1;
      return true;
    }
    if (this.workspaceExternalHttpRequestCount >= config.maxRequestsPerCommand) return false;
    this.workspaceExternalHttpRequestCount += 1;
    return true;
  }

  private async runHttpDispatchWithAbortRace(
    options: RuntimeKernelHttpDispatchOptions & { timeoutBody?: string },
    timeoutMs: number | undefined,
    invoke: (signal: AbortSignal) => Promise<RuntimeKernelHttpResponse>,
    settleFailure: (error: string, body: string) => RuntimeKernelHttpResponse,
    onInvocationSkipped?: () => void
  ): Promise<RuntimeKernelHttpResponse> {
    const signal = options.signal;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let lifecycleAbortListener: (() => void) | undefined;
    const requestAbortController = new AbortController();
    const abortHandlerRequest = (): void => {
      if (!requestAbortController.signal.aborted) requestAbortController.abort();
    };
    if (this.httpLifecycleAbortController.signal.aborted) {
      abortHandlerRequest();
      onInvocationSkipped?.();
      return settleFailure('EINTR', 'Network request interrupted\n');
    }
    const handlerResponse = invoke(requestAbortController.signal);
    const races: Array<Promise<RuntimeKernelHttpResponse>> = [handlerResponse];
    if (timeoutMs !== undefined) {
      races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
        timeoutHandle = setTimeout(() => {
          abortHandlerRequest();
          resolve(settleFailure(
            'ETIMEDOUT',
            options.timeoutBody ?? `Network request timed out after ${timeoutMs} milliseconds\n`
          ));
        }, timeoutMs);
      }));
    }
    if (signal) {
      races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
        abortListener = () => {
          abortHandlerRequest();
          resolve(settleFailure('EINTR', 'Network request aborted\n'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }));
    }
    races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
      lifecycleAbortListener = () => {
        abortHandlerRequest();
        resolve(settleFailure('EINTR', 'Network request interrupted\n'));
      };
      this.httpLifecycleAbortController.signal.addEventListener('abort', lifecycleAbortListener, { once: true });
    }));
    try {
      return await Promise.race(races);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (lifecycleAbortListener) {
        this.httpLifecycleAbortController.signal.removeEventListener('abort', lifecycleAbortListener);
      }
    }
  }

  private externalHttpBlockedResponse(
    normalizedRequest: RuntimeKernelHttpRequest,
    _status: 403 | 429,
    error: string,
    reason: string
  ): RuntimeKernelHttpResponse {
    this.recordHttpRequest({
      method: normalizedRequest.method,
      url: normalizedRequest.url,
      error: this.sanitizeHttpDiagnosticField(`${error}:${reason}`),
      external: true,
    });
    const url = new URL(normalizedRequest.url);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const publicCode = error === 'EPROTONOSUPPORT'
      ? error
      : error === 'EAGAIN' || error === 'ERATELIMIT'
        ? 'EAGAIN'
        : 'EHOSTUNREACH';
    const publicMessage = publicCode === 'EPROTONOSUPPORT'
      ? `Protocol "${url.protocol.replace(/:$/, '')}" not supported`
      : publicCode === 'EAGAIN'
        ? 'Resource temporarily unavailable'
        : `Failed to connect to ${url.hostname} port ${port}: Host unreachable`;
    return {
      // Policy denial is a transport failure, not a response produced by the
      // requested host. Browser fetch/http and curl translate this separately.
      status: 0,
      body: `${publicMessage}\n`,
      error: this.createHttpError(publicCode, `${publicCode}: ${publicMessage}`),
    };
  }

  private async dispatchExternalHttpRequest(
    config: NormalizedRuntimeExternalHttpConfig,
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    actor: RuntimeWorkspaceActor,
    options: RuntimeKernelHttpDispatchOptions & {
      timeoutBody?: string;
      commandContext?: RuntimeCommandExecutionContext;
    }
  ): Promise<RuntimeKernelHttpResponse> {
    if (actor.capabilities?.http?.externalFetch === false) {
      return this.externalHttpBlockedResponse(
        normalizedRequest,
        403,
        'EACCES',
        `external fetch is not allowed for actor ${actor.kind}:${actor.id}`
      );
    }
    if (url.protocol !== 'https:' && !(config.allowHttp && url.protocol === 'http:')) {
      return this.externalHttpBlockedResponse(
        normalizedRequest,
        403,
        'EPROTONOSUPPORT',
        url.protocol === 'http:' ? 'http URLs require allowHttp' : `unsupported URL scheme ${url.protocol}`
      );
    }
    const blocklistReason = isBlockedExternalHttpHost(url);
    if (blocklistReason) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (!hostname.includes('.') && !hostname.includes(':') && hostname !== 'localhost' && !/^\d+(?:\.\d+){3}$/.test(hostname)) {
        const message = `getaddrinfo ENOTFOUND ${hostname}`;
        this.recordHttpRequest({
          method: normalizedRequest.method,
          url: normalizedRequest.url,
          error: this.sanitizeHttpDiagnosticField(`ENOTFOUND:${blocklistReason}`),
          external: true,
        });
        this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: 'ENOTFOUND' });
        return {
          status: 0,
          body: `${message}\n`,
          error: this.createHttpError('ENOTFOUND', message),
        };
      }
      return this.externalHttpBlockedResponse(normalizedRequest, 403, 'EHOSTBLOCKED', blocklistReason);
    }
    const hostResolution = this.resolveHost(url.hostname.replace(/^\[|\]$/g, ''));
    if (!hostResolution.reachable) {
      const allowlistReason = this.runtimeExternalHttpAllowlistReason(config, url);
      if (!allowlistReason && hostResolution.reason === 'unknown-host') {
        const message = `getaddrinfo ENOTFOUND ${url.hostname}`;
        this.recordHttpRequest({
          method: normalizedRequest.method,
          url: normalizedRequest.url,
          error: 'ENOTFOUND',
          external: true,
        });
        this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: 'ENOTFOUND' });
        return {
          status: 0,
          body: `${message}\n`,
          error: this.createHttpError('ENOTFOUND', message),
        };
      }
      return this.externalHttpBlockedResponse(
        normalizedRequest,
        403,
        'EHOSTUNREACH',
        allowlistReason ?? `host ${url.hostname} is unreachable (${hostResolution.reason})`
      );
    }
    const allowlistReason = this.runtimeExternalHttpAllowlistReason(config, url);
    if (allowlistReason) {
      return this.externalHttpBlockedResponse(normalizedRequest, 403, 'EHOSTUNREACH', allowlistReason);
    }
    if (options.signal?.aborted || this.httpLifecycleAbortController.signal.aborted) {
      const body = this.httpLifecycleAbortController.signal.aborted
        ? 'Network request interrupted\n'
        : 'Network request aborted\n';
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EINTR',
        external: true,
      });
      this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: 'EINTR' });
      return {
        status: 0,
        body,
        error: this.createHttpError('EINTR', body.trim()),
      };
    }
    if (!this.consumeExternalHttpBudget(config, options.commandContext)) {
      return this.externalHttpBlockedResponse(
        normalizedRequest,
        429,
        'ERATELIMIT',
        `external fetch request budget exceeded (${config.maxRequestsPerCommand})`
      );
    }
    if (this.activeExternalHttpRequests >= config.maxConcurrentRequests) {
      return this.externalHttpBlockedResponse(
        normalizedRequest,
        429,
        'EAGAIN',
        `external fetch concurrency limit reached (${config.maxConcurrentRequests})`
      );
    }
    const requestedTimeoutMs = options.timeoutMs === undefined
      ? config.timeoutMs
      : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (!Number.isFinite(requestedTimeoutMs)) {
      return this.httpErrorResponse(
        400,
        this.createHttpError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
      );
    }
    const timeoutMs = Math.min(config.timeoutMs, requestedTimeoutMs);
    let settled = false;
    const settleFailure = (error: string, body: string): RuntimeKernelHttpResponse => {
      if (!settled) {
        settled = true;
        this.recordHttpRequest({
          method: normalizedRequest.method,
          url: normalizedRequest.url,
          error,
          external: true,
        });
        this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error });
      }
      return { status: 0, body, error: this.createHttpError(error, body.trim()) };
    };
    this.activeExternalHttpRequests += 1;
    const response = await this.runHttpDispatchWithAbortRace(options, timeoutMs, async (signal) => {
      try {
        const externalRequest: RuntimeExternalHttpRequest = {
          method: normalizedRequest.method,
          url: normalizedRequest.url,
          headers: normalizedRequest.headers ?? {},
          ...(normalizedRequest.body !== undefined ? { body: normalizedRequest.body } : {}),
          ...(normalizedRequest.bodyEncoding ? { bodyEncoding: normalizedRequest.bodyEncoding } : {}),
          signal,
        };
        const normalizedResponse = this.normalizeHttpResponse(await config.fetch(externalRequest));
        if (!settled) {
          this.recordHttpRequest({
            method: normalizedRequest.method,
            url: normalizedRequest.url,
            status: normalizedResponse.status,
            external: true,
          });
          this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, {
            status: normalizedResponse.status,
            ...(normalizedResponse.annotation !== undefined ? { annotation: normalizedResponse.annotation } : {}),
            response: normalizedResponse,
          });
        }
        return normalizedResponse;
      } catch (error) {
        const message = this.sanitizeHttpDiagnosticField(error instanceof Error ? error.message : String(error));
        const rawCode = typeof (error as { code?: unknown } | null)?.code === 'string'
          ? String((error as { code: string }).code).toUpperCase()
          : '';
        const publicCode = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']
          .includes(rawCode)
          ? rawCode
          : 'ECONNRESET';
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        const publicMessage = `connect ${publicCode} ${url.hostname}:${port}`;
        if (!settled) {
          this.recordHttpRequest({
            method: normalizedRequest.method,
            url: normalizedRequest.url,
            error: message,
            external: true,
          });
          this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: message });
        }
        return {
          status: 0,
          body: `${publicMessage}\n`,
          error: this.createHttpError(publicCode, publicMessage),
        };
      } finally {
        this.activeExternalHttpRequests = Math.max(0, this.activeExternalHttpRequests - 1);
      }
    }, settleFailure, () => {
      this.activeExternalHttpRequests = Math.max(0, this.activeExternalHttpRequests - 1);
    });
    settled = true;
    return response;
  }

  private async dispatchUnmanagedLocalHttpRequest(
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    actor: RuntimeWorkspaceActor,
    options: RuntimeKernelHttpDispatchOptions & {
      timeoutBody?: string;
      commandContext?: RuntimeCommandExecutionContext;
    }
  ): Promise<RuntimeKernelHttpResponse> {
    if (this.activeHttpRequests >= TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS) {
      return {
        status: 503,
        body: 'Resource temporarily unavailable\n',
        error: this.createHttpError('EAGAIN', 'Resource temporarily unavailable'),
      };
    }
    const timeoutMs = options.timeoutMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return this.httpErrorResponse(
        400,
        this.createHttpError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
      );
    }
    if (options.signal?.aborted) {
      return {
        status: 0,
        body: 'Network request aborted\n',
        error: this.createHttpError('EINTR', 'Network request aborted'),
      };
    }

    let settled = false;
    const recordFailure = (error: string): void => {
      if (settled) return;
      settled = true;
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error,
      });
      this.recordHttpJournal(
        normalizedRequest,
        url,
        'loopback',
        actor,
        options.commandContext,
        { error }
      );
    };
    const settleFailure = (error: string, body: string): RuntimeKernelHttpResponse => {
      recordFailure(error);
      return {
        status: 0,
        body,
        error: this.createHttpError(error, body.trim()),
      };
    };

    this.activeHttpRequests += 1;
    const response = await this.runHttpDispatchWithAbortRace(
      options,
      timeoutMs,
      async (signal) => {
        try {
          const rawResponse = await this.dispatchUnmanagedHttpOverTcp(
            normalizedRequest,
            url,
            signal,
            options.commandContext
          );
          if (!settled) {
            settled = true;
            this.recordHttpRequest({
              method: normalizedRequest.method,
              url: normalizedRequest.url,
              status: rawResponse.status,
            });
            this.recordKernelEvent('net-request', options.commandContext?.process.pid, {
              protocol: 'http',
              method: normalizedRequest.method,
              url: redactRuntimeDiagnosticUrl(normalizedRequest.url),
              status: rawResponse.status,
              transport: 'tcp',
            });
            this.recordHttpJournal(
              normalizedRequest,
              url,
              'loopback',
              actor,
              options.commandContext,
              { status: rawResponse.status, response: rawResponse }
            );
          }
          return rawResponse;
        } catch (error) {
          const failure = this.runtimeKernelSyscallFailure(error);
          const rawCode = failure.ok ? 'EIO' : failure.error.code;
          const code = rawCode === 'ECONNREFUSED'
            ? rawCode
            : 'ECONNRESET';
          const port = url.port || '80';
          const body = code === 'ECONNREFUSED'
            ? `curl: (7) Failed to connect to ${url.hostname} port ${port}: Connection refused\n`
            : `connect ${code} ${url.hostname}:${port}\n`;
          return settleFailure(code, body);
        } finally {
          this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
        }
      },
      settleFailure,
      () => {
        this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
      }
    );
    settled = true;
    return response;
  }

  private async dispatchHttpRequest(
    request: RuntimeKernelHttpRequest,
    options: RuntimeKernelHttpDispatchOptions & {
      timeoutBody?: string;
      actor?: RuntimeWorkspaceActor;
      commandContext?: RuntimeCommandExecutionContext;
    } = {}
  ): Promise<RuntimeKernelHttpResponse> {
    const actor = options.actor ?? SYSTEM_ACTOR;
    try {
      this.assertHttpCapability(actor, 'dispatch');
    } catch (error) {
      return this.httpErrorResponse(403, this.httpErrorFromThrown(error, 'EACCES'));
    }
    const normalizedResult = this.normalizeHttpRequest(request);
    if (!normalizedResult.ok) {
      return this.httpErrorResponse(400, normalizedResult.error);
    }
    const normalizedRequest = normalizedResult.request;
    let url: URL;
    try {
      url = new URL(normalizedRequest.url);
    } catch {
      return this.httpErrorResponse(400, this.createHttpError('EINVAL', 'curl: invalid URL'));
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
      return this.httpErrorResponse(400, this.httpErrorFromThrown(error, 'EINVAL'));
    }
    if (this.httpLifecycleAbortController.signal.aborted) {
      this.recordHttpRequest({
        ...(listener ? { listenerId: listener.info.id, pid: listener.info.pid } : {}),
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EINTR',
        ...(!listener && this.externalHttp ? { external: true as const } : {}),
      });
      if (listener || this.externalHttp) {
        this.recordHttpJournal(
          normalizedRequest,
          url,
          listener ? 'listener' : 'external',
          actor,
          options.commandContext,
          { error: 'EINTR' }
        );
      }
      return {
        status: 0,
        body: 'Network request interrupted\n',
        error: this.createHttpError('EINTR', 'Network request interrupted'),
      };
    }
    if (!listener) {
      if (this.isLocalTcpHttpTarget(url)) {
        return this.dispatchUnmanagedLocalHttpRequest(
          normalizedRequest,
          url,
          actor,
          options
        );
      }
      if (this.externalHttp) {
        return this.dispatchExternalHttpRequest(this.externalHttp, normalizedRequest, url, actor, options);
      }
      const hostResolution = this.resolveHost(url.hostname.replace(/^\[|\]$/g, ''));
      if (!hostResolution.reachable) {
        return this.httpHostUnreachableResponse(normalizedRequest, url, hostResolution.reason);
      }
      this.recordHttpRequest({
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'ECONNREFUSED',
      });
      return {
        status: 0,
        body: `curl: (7) Failed to connect to ${url.hostname} port ${url.port || '80'}: Connection refused\n`,
        error: this.createHttpError('ECONNREFUSED', `ECONNREFUSED: Failed to connect to ${url.hostname} port ${url.port || '80'}`),
      };
    }
    if (this.activeHttpRequests >= TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS) {
      this.recordHttpRequest({
        listenerId: listener.info.id,
        pid: listener.info.pid,
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EAGAIN',
      });
      return {
        status: 503,
        body: 'Resource temporarily unavailable\n',
        error: this.createHttpError('EAGAIN', 'Resource temporarily unavailable'),
      };
    }
    const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return this.httpErrorResponse(
        400,
        this.createHttpError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
      );
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
      this.recordHttpJournal(normalizedRequest, url, 'listener', actor, options.commandContext, { error: 'EINTR' });
      return {
        status: 0,
        body: 'Network request aborted\n',
        error: this.createHttpError('EINTR', 'Network request aborted'),
      };
    }

    let settled = false;
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
        this.recordHttpJournal(normalizedRequest, url, 'listener', actor, options.commandContext, { error });
      }
      return { status: 0, body, error: this.createHttpError(error, body.trim()) };
    };
    this.activeHttpRequests += 1;
    const response = await this.runHttpDispatchWithAbortRace(options, timeoutMs, async (handlerSignal) => {
      try {
        const response = await this.dispatchLocalHttpOverTcp(
          listener,
          normalizedRequest,
          url,
          actor,
          handlerSignal,
          options.commandContext
        );
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
          this.recordHttpJournal(normalizedRequest, url, 'listener', actor, options.commandContext, {
            status,
            ...(listener.actor.kind !== 'runtime' && response.annotation !== undefined
              ? { annotation: response.annotation }
              : {}),
            response,
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
          this.recordHttpJournal(normalizedRequest, url, 'listener', actor, options.commandContext, { error: message });
        }
        return { status: 500, body: this.httpListenerErrorBody(listener, actor, message) };
      } finally {
        this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
      }
    }, settleFailure, () => {
      this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
    });
    settled = true;
    return response;
  }

  recordKernelCommandError(error: unknown): void {
    const commandError = runtimeCommandError(error);
    if (!commandError) return;
  }

  private createDynamicProcProvider(): RuntimeDynamicProcProvider {
    return {
      readFile: (path, context) => this.readDynamicVirtualFile(path, context),
      readDir: (path, context) => this.readDynamicVirtualDir(path, context),
      entryKind: (path, context) => this.dynamicVirtualEntryKind(path, context),
      stat: (path, context) => this.dynamicVirtualStat(path, context),
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
      env: Object.freeze({ ...this.baseEnv }),
      actor: SYSTEM_ACTOR,
      signalPolicy: 'system-only',
      startedAt: this.projectSession?.lifecycle.createdAt ?? new Date(0).toISOString(),
      state: 'running',
      foreground: true,
    };
  }

  private currentProcSelfRecord(context?: RuntimeCommandExecutionContext): RuntimeKernelProcessRecord {
    return (context?.process as RuntimeKernelProcessRecord | undefined) ?? this.principalProcessRecord();
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

  /** PID 1 occupies a real process-table slot even though it is not mutable. */
  private processTableUsage(): number {
    return 1 + this.activeProcessRecords().length;
  }

  private processAdmissionError(command: string): RuntimeKernelAdmissionRejectedError | null {
    if (this.maxProcesses === null || this.processTableUsage() < this.maxProcesses) return null;
    return new RuntimeKernelAdmissionRejectedError(
      command,
      `EAGAIN: resource temporarily unavailable, fork '${command}'`,
      'fork'
    );
  }

  private recordProcessAdmissionRejection(
    command: string,
    error: RuntimeKernelAdmissionRejectedError,
    actor?: RuntimeWorkspaceActor
  ): void {
    this.recordKernelEvent('process-reject', undefined, {
      command,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      activeProcesses: this.processTableUsage(),
      maxProcesses: this.maxProcesses ?? 'unlimited',
      ...(actor ? { actor: this.journalActorId(actor) } : {}),
    });
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

  private dispatchRuntimeEvent(event: RuntimeCommandEvent, commandContext?: RuntimeCommandExecutionContext): void {
    commandContext?.eventHandler?.(event);
    for (const watcher of this.eventWatchers) {
      watcher(event);
    }
  }

  private journalActorId(actor: RuntimeWorkspaceActor | undefined): string | undefined {
    return actor ? `${actor.kind}:${actor.id}` : undefined;
  }

  private recordJournal(
    entry: KernelJournalEntry,
    commandContext?: RuntimeCommandExecutionContext,
    actor?: RuntimeWorkspaceActor
  ): KernelJournalRecord {
    const record = {
      seq: this.nextJournalSeq++,
      ...entry,
    } as KernelJournalRecord;
    this.kernelJournalLog.push(record);
    if (this.kernelJournalLog.length > TRACEKERNEL_EVENT_LOG_LIMIT) {
      this.kernelJournalLog.splice(0, this.kernelJournalLog.length - TRACEKERNEL_EVENT_LOG_LIMIT);
    }
    this.handleRuntimeCommandEvent({
      type: 'kernel-journal',
      record,
      ...(actor ? { actor } : {}),
    }, commandContext);
    return record;
  }

  private recordFileChangeJournal(
    event: RuntimeCommandFileChangeEvent,
    commandContext?: RuntimeCommandExecutionContext,
    process: RuntimeKernelProcessRecord | undefined = commandContext?.process as RuntimeKernelProcessRecord | undefined
  ): void {
    const actor = event.actor ?? commandContext?.actor ?? SYSTEM_ACTOR;
    const change = event.change;
    const op = isRuntimeDirectoryChange(change)
      ? change.deleted === true ? 'rmdir' : 'mkdir'
      : (change as RuntimeFileDeletion).deleted === true ? 'delete' : 'write';
    this.recordJournal({
      kind: 'fs',
      op,
      path: change.path,
      actor: this.journalActorId(actor) ?? 'system:system',
      ...(process?.pid !== undefined ? { pid: process.pid } : {}),
      ...(event.phase ? { phase: event.phase } : {}),
    }, commandContext, actor);
  }

  private journalHttpAuth(headers: Record<string, string> | undefined): Pick<Extract<KernelJournalRecord, { kind: 'http' }>, 'authPresent' | 'authFingerprint'> {
    const authorization = headers?.authorization;
    if (!authorization) return { authPresent: false };
    return {
      authPresent: true,
      authFingerprint: stableKernelJournalFingerprint(authorization),
    };
  }

  private journalHttpError(error: string, headers: Record<string, string> | undefined): string {
    let message = this.sanitizeHttpDiagnosticField(error);
    const authorization = headers?.authorization;
    if (authorization) {
      message = message.split(authorization).join('redacted');
    }
    return message;
  }

  private httpHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const needle = name.toLowerCase();
    for (const [headerName, value] of Object.entries(headers)) {
      if (headerName.toLowerCase() === needle) return value;
    }
    return undefined;
  }

  private journalHttpMeta(
    normalizedRequest: RuntimeKernelHttpRequest,
    normalizedResponse?: RuntimeKernelHttpResponse
  ): Extract<KernelJournalRecord, { kind: 'http' }>['meta'] | undefined {
    const meta: NonNullable<Extract<KernelJournalRecord, { kind: 'http' }>['meta']> = {};
    const idempotencyKey = this.httpHeaderValue(normalizedRequest.headers, 'idempotency-key');
    const contentType = this.httpHeaderValue(normalizedRequest.headers, 'content-type');
    const retryAfter = this.httpHeaderValue(normalizedResponse?.headers, 'retry-after');
    const rateLimitLimit = this.httpHeaderValue(normalizedResponse?.headers, 'x-ratelimit-limit');
    const rateLimitRemaining = this.httpHeaderValue(normalizedResponse?.headers, 'x-ratelimit-remaining');
    const rateLimitReset = this.httpHeaderValue(normalizedResponse?.headers, 'x-ratelimit-reset');
    if (idempotencyKey !== undefined) meta.idempotencyKeyFingerprint = stableKernelJournalFingerprint(idempotencyKey);
    if (normalizedRequest.body !== undefined) {
      meta.requestBodyFingerprint = stableKernelJournalFingerprint(runtimeHttpRequestText(normalizedRequest));
    }
    if (normalizedResponse?.body !== undefined && (idempotencyKey !== undefined || normalizedRequest.body !== undefined)) {
      meta.responseBodyFingerprint = stableKernelJournalFingerprint(runtimeHttpResponseText(normalizedResponse));
    }
    if (contentType !== undefined) meta.contentType = contentType;
    if (retryAfter !== undefined) meta.retryAfter = retryAfter;
    const rateLimit: NonNullable<NonNullable<Extract<KernelJournalRecord, { kind: 'http' }>['meta']>['rateLimit']> = {};
    if (rateLimitLimit !== undefined) rateLimit.limit = rateLimitLimit;
    if (rateLimitRemaining !== undefined) rateLimit.remaining = rateLimitRemaining;
    if (rateLimitReset !== undefined) rateLimit.reset = rateLimitReset;
    if (Object.keys(rateLimit).length > 0) meta.rateLimit = rateLimit;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private recordHttpJournal(
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    via: Extract<KernelJournalRecord, { kind: 'http' }>['via'],
    actor: RuntimeWorkspaceActor,
    commandContext: RuntimeCommandExecutionContext | undefined,
    result: { status?: number; annotation?: unknown; error?: string; response?: RuntimeKernelHttpResponse }
  ): void {
    const meta = this.journalHttpMeta(normalizedRequest, result.response);
    this.recordJournal({
      kind: 'http',
      op: 'request',
      method: normalizedRequest.method,
      host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      path: url.pathname || '/',
      ...(result.status !== undefined ? { status: result.status } : {}),
      via,
      ...(this.journalActorId(actor) ? { actor: this.journalActorId(actor) } : {}),
      ...(commandContext?.process.pid !== undefined ? { pid: commandContext.process.pid } : {}),
      ...this.journalHttpAuth(normalizedRequest.headers),
      ...(result.annotation !== undefined ? { annotation: result.annotation } : {}),
      ...(result.error !== undefined ? { error: this.journalHttpError(result.error, normalizedRequest.headers) } : {}),
      ...(meta ? { meta } : {}),
    }, commandContext, actor);
  }

  journal(sinceSeq?: number): readonly KernelJournalRecord[] {
    if (sinceSeq === undefined) return [...this.kernelJournalLog];
    return this.kernelJournalLog.filter((record) => record.seq > sinceSeq);
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
      // wait4/EINTR describes TraceKernel's parent-side bookkeeping. A real
      // foreground shell does not print that syscall detail as child stderr.
      stderr: '',
      exitCode: 128 + (process.signalCode ?? 15),
      ...(error ? { error } : {}),
    };
  }

  private signalProcess(
    process: RuntimeKernelProcessRecord,
    signalName = 'SIGTERM',
    authority: 'workspace' | 'system' = 'workspace'
  ): boolean {
    const signal = normalizeTraceKernelSignal(signalName);
    if (!signal || process.state === 'exited') return false;
    if (process.signalPolicy === 'system-only' && authority !== 'system') return false;
    process.signal = signal.name;
    process.signalCode = signal.code;
    process.state = 'signaled';
    this.recordKernelEvent('process-signal', process.pid, { signal: signal.name, signalCode: signal.code });
    if (!process.abortController?.signal.aborted) {
      process.abortController?.abort({ signal: signal.name, signalCode: signal.code, pid: process.pid });
    }
    return true;
  }

  private configureRuntimeProcessWatchdog(
    process: RuntimeKernelProcessRecord,
    action: 'arm' | 'pet' | 'disarm' | 'status',
    timeoutMs?: number,
    requestedSignal?: 'SIGTERM' | 'SIGKILL'
  ): RuntimeKernelWatchdogRecord | undefined {
    const current = this.processWatchdogs.get(process.pid);
    if (action === 'status') return current;
    if (action === 'disarm') {
      this.clearRuntimeProcessWatchdog(process.pid);
      this.recordKernelEvent('watchdog-disarm', process.pid);
      return undefined;
    }

    const effectiveTimeoutMs = action === 'pet' ? current?.timeoutMs : timeoutMs;
    if (
      effectiveTimeoutMs === undefined ||
      !Number.isSafeInteger(effectiveTimeoutMs) ||
      effectiveTimeoutMs <= 0
    ) {
      throw Object.assign(
        new Error(
          action === 'pet'
            ? 'EINVAL: cannot pet a disarmed watchdog'
            : 'EINVAL: watchdog timeout must be a positive integer'
        ),
        { code: 'EINVAL' }
      );
    }
    const signal = action === 'pet'
      ? current?.signal
      : requestedSignal ?? 'SIGTERM';
    if (!signal) {
      throw Object.assign(
        new Error('EINVAL: cannot pet a disarmed watchdog'),
        { code: 'EINVAL' }
      );
    }

    this.clearRuntimeProcessWatchdog(process.pid);
    const token = Symbol(`watchdog-${process.pid}`);
    const deadlineAt = Date.now() + effectiveTimeoutMs;
    const timer = setTimeout(() => {
      if (this.processWatchdogs.get(process.pid)?.token !== token) return;
      this.processWatchdogs.delete(process.pid);
      this.recordKernelEvent('watchdog-expire', process.pid, {
        timeoutMs: effectiveTimeoutMs,
        signal,
      });
      this.signalProcess(process, signal);
    }, effectiveTimeoutMs);
    const watchdog = {
      token,
      timeoutMs: effectiveTimeoutMs,
      signal,
      deadlineAt,
      timer,
    } as const;
    this.processWatchdogs.set(process.pid, watchdog);
    this.recordKernelEvent(
      action === 'pet' ? 'watchdog-pet' : 'watchdog-arm',
      process.pid,
      {
        timeoutMs: effectiveTimeoutMs,
        signal,
        deadlineAt,
      }
    );
    return watchdog;
  }

  private clearRuntimeProcessWatchdog(pid: number): void {
    const watchdog = this.processWatchdogs.get(pid);
    if (!watchdog) return;
    this.processWatchdogs.delete(pid);
    clearTimeout(watchdog.timer);
  }

  private clearAllRuntimeProcessWatchdogs(): void {
    for (const watchdog of this.processWatchdogs.values()) {
      clearTimeout(watchdog.timer);
    }
    this.processWatchdogs.clear();
  }

  private signalProcessGroup(
    pgid: number,
    signalName = 'SIGTERM',
    currentPid?: number
  ): { signaled: number; denied: number } {
    let signaled = 0;
    let denied = 0;
    for (const process of this.activeProcessRecords()) {
      if (process.pgid !== pgid || process.pid === currentPid || process.pid === 1 || process.state === 'exited') continue;
      if (process.signalPolicy === 'system-only') {
        denied += 1;
        continue;
      }
      if (this.signalProcess(process, signalName)) signaled += 1;
    }
    if (signaled > 0) this.recordKernelEvent('process-group-signal', undefined, { pgid, signal: normalizeTraceKernelSignal(signalName)?.name, count: signaled });
    return { signaled, denied };
  }

  private setProcessGroupForeground(pgid: number, foreground: boolean): void {
    for (const process of this.activeProcessRecords()) {
      if (process.pgid !== pgid || process.pid === 1 || process.state === 'exited') continue;
      process.foreground = foreground;
      process.tty = foreground ? '/dev/tty' : '?';
    }
  }

  private async reapZombieProcess(pid?: number, commandName = 'tracekernelctl', currentPid?: number): Promise<RuntimeCommandResult> {
    const process = await this.waitForZombieProcess(pid, currentPid);
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

  private runKernelWaitForParent(
    args: readonly string[],
    commandName: 'wait' | 'tracekernelctl',
    currentPid?: number
  ): Promise<RuntimeCommandResult> {
    if (args.length > 1) {
      const usage = commandName === 'wait' ? 'wait [pid]' : 'tracekernelctl wait [pid]';
      return Promise.resolve({ stdout: '', stderr: `usage: ${usage}\n`, exitCode: 2 });
    }
    if (args[0] === undefined) return this.reapZombieProcess(undefined, commandName, currentPid);
    const pid = Number(args[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return Promise.resolve({ stdout: '', stderr: `${commandName}: invalid pid: ${args[0]}\n`, exitCode: 22 });
    }
    return this.reapZombieProcess(pid, commandName, currentPid);
  }

  /**
   * `wait` is a shell builtin backed by wait4, not a child process. Execute a
   * lone, static wait command in the existing parent (or PID 1 for direct
   * workspace calls) so a full process table can still reap its zombies.
   */
  private tryRunInProcessWaitCommand(
    command: string,
    parent?: RuntimeKernelProcessRecord
  ): Promise<RuntimeCommandResult> | null {
    const words = parseSimpleCommandWords(command);
    if (!words || words.length === 0) return null;
    const rawCommandName = words[0] ?? '';
    const commandName = traceKernelBinCommandName(rawCommandName) ?? rawCommandName;
    const currentPid = parent?.pid ?? 1;
    if (commandName === 'wait' || commandName === `${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`) {
      const help = this.traceKernelCommandHelp('wait', words.slice(1));
      if (help) return Promise.resolve(help);
      return this.runKernelWaitForParent(words.slice(1), 'wait', currentPid);
    }
    if (commandName === 'tracekernelctl' && words[1] === 'wait') {
      return this.runKernelWaitForParent(words.slice(2), 'tracekernelctl', currentPid);
    }
    return null;
  }

  private waitForZombieProcess(pid?: number, currentPid?: number): Promise<RuntimeKernelProcessRecord | undefined> {
    this.purgeZombieProcessTable();
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
      const reason = signal.reason as { signal?: unknown } | undefined;
      const signalName = typeof reason?.signal === 'string' ? reason.signal : 'SIGTERM';
      this.signalProcess(process, signalName);
    };
    if (signal.aborted) {
      abort();
      return undefined;
    }
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  private traceKernelCommandInfo(nameOrPath: string): TraceKernelCommandInfo | undefined {
    const rawCommandName = traceKernelBinCommandName(nameOrPath) ?? nameOrPath;
    const dispatchCommandName = rawCommandName.startsWith(TRACEKERNEL_COMMAND_DISPATCH_PREFIX)
      ? rawCommandName.slice(TRACEKERNEL_COMMAND_DISPATCH_PREFIX.length)
      : rawCommandName;
    const commandName = dispatchCommandName.startsWith(TRACEKERNEL_SHELL_COMMAND_PREFIX)
      ? dispatchCommandName.slice(TRACEKERNEL_SHELL_COMMAND_PREFIX.length)
      : dispatchCommandName;
    return this.traceKernelCommandRegistry.find((command) => command.name === commandName);
  }

  private renderTraceKernelBinCommand(info: TraceKernelCommandInfo): string {
    const dispatchName = this.traceKernelCommandDispatchNames.get(info.name)
      ?? `${TRACEKERNEL_COMMAND_DISPATCH_PREFIX}${info.name}`;
    return `#!/bin/sh\nexec ${dispatchName} "$@"\n`;
  }

  private traceKernelCommandHelp(name: string, args: readonly string[]): RuntimeCommandResult | null {
    const info = this.traceKernelCommandInfo(name);
    const help = info?.help;
    if (!help || args.length !== 1 || !(help.flags ?? ['--help']).includes(args[0]!)) return null;
    const flags = help.flags ?? ['--help'];
    const helpFlags = flags.join(', ');
    const helpOption = `${helpFlags}${' '.repeat(Math.max(1, 20 - helpFlags.length))}display this help and exit`;
    return {
      stdout: [
        `${info.name} - ${help.summary}`,
        '',
        `Usage: ${help.usage}`,
        ...((help.options?.length ?? 0) > 0 || flags.length > 0
          ? ['', 'Options:', ...(help.options ?? []).map((option) => `  ${option}`), `  ${helpOption}`]
          : []),
        ...((help.notes?.length ?? 0) > 0
          ? ['', 'Notes:', ...help.notes!.map((note) => `  ${note}`)]
          : []),
      ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private readDynamicTraceKernelFile(path: string): string | null {
    const commandName = traceKernelBinCommandName(path);
    if (!commandName) return null;
    if (commandName.startsWith(TRACEKERNEL_COMMAND_DISPATCH_PREFIX)) return null;
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

  private readDynamicIdentityFile(path: string): string | null {
    return runtimeKernelIdentityEntryKind(path) === 'file'
      ? readRuntimeKernelIdentityFile(path, this.kernelInfo)
      : null;
  }

  private readDynamicIdentityDir(path: string): RuntimeDynamicProcEntry[] | null {
    const entries = runtimeKernelIdentityDirEntries(path);
    return entries?.map((name) => ({ name, kind: 'file' as const })) ?? null;
  }

  private readDynamicVirtualFile(path: string, context?: RuntimeCommandExecutionContext): string | null {
    const identityFile = this.readDynamicIdentityFile(path);
    if (identityFile !== null) return identityFile;
    const skillFile = this.readDynamicSkillsFile(path);
    if (skillFile !== null) return skillFile;
    const traceKernelFile = this.readDynamicTraceKernelFile(path);
    if (traceKernelFile !== null) return traceKernelFile;
    return this.readDynamicProcFile(path, context);
  }

  private readDynamicVirtualDir(path: string, context?: RuntimeCommandExecutionContext): RuntimeDynamicProcEntry[] | null {
    return this.readDynamicIdentityDir(path) ??
      this.readDynamicSkillsDir(path) ??
      this.readDynamicTraceKernelDir(path) ??
      this.readDynamicProcDir(path, context);
  }

  private dynamicVirtualEntryKind(path: string, context?: RuntimeCommandExecutionContext): 'file' | 'directory' | null {
    return runtimeKernelIdentityEntryKind(path) ??
      this.dynamicSkillsEntryKind(path) ??
      this.dynamicTraceKernelEntryKind(path) ??
      this.dynamicProcEntryKind(path, context);
  }

  private dynamicVirtualStat(path: string, context?: RuntimeCommandExecutionContext): RuntimeKernelVirtualStat | null {
    return runtimeKernelIdentityStat(path, this.kernelInfo) ??
      this.dynamicSkillsStat(path) ??
      this.dynamicTraceKernelStat(path) ??
      this.dynamicProcStat(path, context);
  }

  private readDynamicProcFile(path: string, context?: RuntimeCommandExecutionContext): string | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc/self/status') return this.renderProcStatus(this.currentProcSelfRecord(context));
    if (procPath === '/proc/self/cmdline') return `${this.currentProcSelfRecord(context).command}\0`;
    {
      const selfFd = procPath.match(/^\/proc\/self\/fd\/([0-9]+)$/);
      if (selfFd) return this.renderProcFd(this.currentProcSelfRecord(context), Number(selfFd[1]));
      const selfFdInfo = procPath.match(/^\/proc\/self\/fdinfo\/([0-9]+)$/);
      if (selfFdInfo) return this.renderProcFdInfo(this.currentProcSelfRecord(context), Number(selfFdInfo[1]));
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

  private readDynamicProcDir(path: string, context?: RuntimeCommandExecutionContext): RuntimeDynamicProcEntry[] | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (procPath === '/proc') {
      return [
        { name: 'kernel', kind: 'directory' },
        { name: 'mounts', kind: 'file' },
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
      return this.currentProcSelfRecord(context).fds.map((fd) => ({ name: String(fd.fd), kind: 'file' as const }));
    }
    if (procPath === '/proc/self/fdinfo') {
      return this.currentProcSelfRecord(context).fds.map((fd) => ({ name: String(fd.fd), kind: 'file' as const }));
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

  private dynamicProcEntryKind(path: string, context?: RuntimeCommandExecutionContext): 'file' | 'directory' | null {
    const procPath = normalizeRuntimeProcPath(path);
    if (!procPath) return null;
    if (this.readDynamicProcDir(procPath, context)) return 'directory';
    return this.readDynamicProcFile(procPath, context) !== null ? 'file' : null;
  }

  private dynamicProcStat(path: string, context?: RuntimeCommandExecutionContext): RuntimeKernelVirtualStat | null {
    const kind = this.dynamicProcEntryKind(path, context);
    if (!kind) return null;
    const content = kind === 'file' ? this.readDynamicProcFile(path, context) ?? '' : '';
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
      `Name:\t${process.command.split(/\s+/, 1)[0] || 'bash'}`,
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
      request.external ? 'external' : '',
    ].join('\t'));
    return ['seq\ttime\tlistener\tpid\tmethod\turl\tstatus\terror\texternal', ...rows].join('\n') + '\n';
  }

  private renderProcScheduler(): string {
    const active = this.activeProcessRecords();
    const scheduler = this.commandScheduler.snapshot();
    const processTableUsage = 1 + active.length;
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
      `processes\t${processTableUsage}`,
      `max_processes\t${this.maxProcesses ?? 'unlimited'}`,
      `available_processes\t${this.maxProcesses === null ? 'unlimited' : Math.max(0, this.maxProcesses - processTableUsage)}`,
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
    const commandContext = this.resolveCommandContext(ctx);
    if (!commandContext) {
      return { stdout: '', stderr: `${TRACEKERNEL_EXEC_COMMAND}: missing command context\n`, exitCode: 1 };
    }
    const result = await this.executeVirtualExecutable({
      executable: expandedInvocation.scriptFile,
      args: expandedInvocation.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdinPipe: commandContext.stdinPipe,
      commandContext,
    });
    if (result) return result;
    return this.executeWorkspaceScript(
      expandedInvocation.scriptFile,
      expandedInvocation.scriptArgs,
      ctx
    );
  }

  private async executeWorkspaceScript(
    executable: string,
    args: readonly string[],
    ctx: CommandContext
  ): Promise<RuntimeCommandResult> {
    let absolutePath: string;
    try {
      absolutePath = resolveWorkspaceContextPath(ctx, this.cwd, executable, 'Executable path');
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 126 };
    }
    const stat = await ctx.fs.stat(absolutePath).catch(() => null);
    if (!stat) {
      return { stdout: '', stderr: `bash: ${executable}: No such file or directory\n`, exitCode: 127 };
    }
    if (!stat.isFile) {
      return { stdout: '', stderr: `bash: ${executable}: Is a directory\n`, exitCode: 126 };
    }
    if ((stat.mode & 0o111) === 0) {
      return { stdout: '', stderr: `bash: ${executable}: Permission denied\n`, exitCode: 126 };
    }

    const source = await ctx.fs.readFile(absolutePath);
    const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
    const shebang = firstLine.startsWith('#!') ? firstLine.slice(2).trim() : '';
    const invocation = this.workspaceScriptInterpreterInvocation(shebang, executable, args);
    if (invocation === null) {
      return {
        stdout: '',
        stderr: `bash: ${executable}: cannot execute: required file not found\n`,
        exitCode: 127,
      };
    }
    if (!ctx.exec) {
      return { stdout: '', stderr: 'bash: internal error: exec function not available\n', exitCode: 1 };
    }
    return ctx.exec(invocation, {
      env: Object.fromEntries(ctx.env.entries()),
      cwd: ctx.cwd,
      stdin: String(ctx.stdin),
      stdinKind: 'bytes',
      signal: this.withCurrentKernelSignal(ctx).signal,
    });
  }

  private workspaceScriptInterpreterInvocation(
    shebang: string,
    executable: string,
    args: readonly string[]
  ): string | null {
    const scriptAndArgs = [executable, ...args].map(shellQuote).join(' ');
    if (!shebang) return `bash ${scriptAndArgs}`;

    const words = shebang.split(/\s+/).filter(Boolean);
    const interpreterPath = words.shift();
    if (!interpreterPath?.startsWith('/')) return null;
    let interpreter = interpreterPath.split('/').pop() ?? '';
    let interpreterArgs = words;
    if (interpreter === 'env') {
      if (interpreterArgs[0] === '-S') interpreterArgs = interpreterArgs.slice(1);
      while (interpreterArgs[0] === '-i' || interpreterArgs[0] === '--ignore-environment') {
        interpreterArgs = interpreterArgs.slice(1);
      }
      interpreter = interpreterArgs.shift() ?? '';
    }
    const supported = this.traceKernelCommandInfo(interpreter);
    if (!supported && interpreter !== 'bash' && interpreter !== 'sh') return null;
    const command = interpreter === 'sh' ? 'bash' : interpreter;
    return [command, ...interpreterArgs, executable, ...args].map(shellQuote).join(' ');
  }

  private kernelCurlErrorResult(response: RuntimeKernelHttpResponse): RuntimeCommandResult | undefined {
    const error = response.error;
    if (!error) return undefined;
    if (error.code === 'EINVAL') {
      return { stdout: '', stderr: 'curl: (3) URL malformed\n', exitCode: 3 };
    }
    if (error.code === 'EPROTONOSUPPORT') {
      const protocol = /Protocol "([^"]+)"/.exec(error.message)?.[1] ?? /'([^']+)'/.exec(error.message)?.[1] ?? 'unknown';
      return { stdout: '', stderr: `curl: (1) Protocol "${protocol}" not supported\n`, exitCode: 1 };
    }
    if (error.code === 'ETIMEDOUT') {
      return { stdout: '', stderr: response.body?.startsWith('curl: (28)') ? response.body : 'curl: (28) Operation timed out\n', exitCode: 28 };
    }
    if (error.code === 'ENOTFOUND') {
      const host = /\s([^\s:]+)(?::\d+)?$/.exec(error.message)?.[1] ?? 'unknown';
      return { stdout: '', stderr: `curl: (6) Could not resolve host: ${host}\n`, exitCode: 6 };
    }
    if (
      error.code === 'EACCES' ||
      error.code === 'EHOSTBLOCKED' ||
      error.code === 'EHOSTUNREACH' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ENETUNREACH' ||
      error.code === 'EAGAIN' ||
      error.code === 'ERATELIMIT'
    ) {
      if (response.body?.startsWith('curl: (7)')) return { stdout: '', stderr: response.body, exitCode: 7 };
      const message = error.message.replace(/^[A-Z][A-Z0-9_]*:\s*/, '').replace(/^tracekernel:\s*/, '');
      return { stdout: '', stderr: `curl: (7) ${message}\n`, exitCode: 7 };
    }
    return undefined;
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
    let verbose = false;
    let silent = false;
    let showError = false;
    let followLocation = false;
    let writeOut: string | undefined;
    let failWithBody = false;
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
      if (arg === '--silent') {
        silent = true;
        continue;
      }
      if (arg === '--show-error') {
        showError = true;
        continue;
      }
      if (arg === '--location') {
        followLocation = true;
        continue;
      }
      if (arg === '--insecure') continue;
      if (/^-[sSfLiIkv]+$/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === 's') silent = true;
          else if (flag === 'S') showError = true;
          else if (flag === 'f') failOnHttpError = true;
          else if (flag === 'i') includeHeaders = true;
          else if (flag === 'I') {
            method ??= 'HEAD';
            includeHeaders = true;
            headOnly = true;
          } else if (flag === 'v') verbose = true;
          else if (flag === 'L') followLocation = true;
          // -k is an accepted no-op in TraceKernel's deterministic network.
        }
        continue;
      }
      if (arg === '-v' || arg === '--verbose') {
        verbose = true;
        continue;
      }
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
      if (arg === '--fail-with-body') {
        failOnHttpError = true;
        failWithBody = true;
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
      if (arg === '-w' || arg === '--write-out') {
        const next = args[++index];
        if (next === undefined) return { stdout: '', stderr: 'curl: option requires an argument -- w\n', exitCode: 2 };
        writeOut = next;
        continue;
      }
      if (arg.startsWith('--write-out=')) {
        writeOut = arg.slice('--write-out='.length);
        continue;
      }
      if (arg === '--max-time' || arg === '--connect-timeout') {
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
      if (arg.startsWith('--connect-timeout=')) {
        const value = arg.slice('--connect-timeout='.length);
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) return { stdout: '', stderr: `curl: invalid --connect-timeout value: ${value}\n`, exitCode: 2 };
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
        stderr: urls.length === 0 ? 'curl: no URL specified\n' : 'curl: (2) multiple URLs are not supported\n',
        exitCode: 2,
      };
    }
    const resolved = resolveCurlUrl(urls[0]!);
    if (!(resolved.scheme in CURL_PROTOCOLS)) {
      return { stdout: '', stderr: `curl: (1) Protocol "${resolved.scheme}" not supported\n`, exitCode: 1 };
    }
    let url: URL;
    try {
      url = new URL(resolved.url);
    } catch {
      return { stdout: '', stderr: `curl: (3) URL rejected: ${urls[0]}\n`, exitCode: 3 };
    }
    if (appendDataToQuery && body !== undefined) {
      const params = new URLSearchParams(body);
      for (const [name, value] of params) url.searchParams.append(name, value);
      body = undefined;
      if (method === undefined || method === 'POST') method = 'GET';
    }
    const commandContext = this.resolveCommandContext(ctx);
    let effectiveUrl = url;
    let effectiveMethod = method ?? 'GET';
    let effectiveBody = body;
    let response!: RuntimeKernelHttpResponse;
    let request!: RuntimeKernelHttpRequest;
    let redirectCount = 0;
    const credentialOrigin = effectiveUrl.origin;
    while (true) {
      const requestHeaders = { ...headers };
      let requestRawHeaders = [...rawHeaders];
      if (effectiveUrl.origin !== credentialOrigin) {
        delete requestHeaders.authorization;
        delete requestHeaders.cookie;
        delete requestHeaders['proxy-authorization'];
        requestRawHeaders = requestRawHeaders.filter(([name]) =>
          !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())
        );
      }
      request = {
        method: effectiveMethod,
        url: effectiveUrl.toString(),
        path: `${effectiveUrl.pathname}${effectiveUrl.search}`,
        headers: requestHeaders,
        ...(requestRawHeaders.length > 0 ? { rawHeaders: requestRawHeaders } : {}),
        ...(effectiveBody !== undefined ? { body: effectiveBody } : {}),
      };
      response = await this.dispatchHttpRequest(request, {
        ...(timeoutMs !== undefined ? {
          timeoutMs,
          timeoutBody: `curl: (28) Operation timed out after ${timeoutMs} milliseconds\n`,
        } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(commandContext?.actor ? { actor: commandContext.actor } : {}),
        ...(commandContext ? { commandContext } : {}),
      });
      const kernelError = this.kernelCurlErrorResult(response);
      if (kernelError) {
        return silent && !showError ? { ...kernelError, stderr: '' } : kernelError;
      }
      if (response.status === 0 && response.body?.startsWith('curl: (28)')) {
        return {
          stdout: '',
          stderr: silent && !showError ? '' : response.body ?? 'curl: (28) Operation timed out\n',
          exitCode: 28,
        };
      }
      if (response.status === 0) {
        return {
          stdout: '',
          stderr: silent && !showError ? '' : response.body ?? 'curl: connection failed\n',
          exitCode: 7,
        };
      }
      const location = this.httpHeaderValue(response.headers, 'location');
      if (!followLocation || !location || ![301, 302, 303, 307, 308].includes(response.status)) break;
      redirectCount += 1;
      if (redirectCount > 20) {
        return {
          stdout: '',
          stderr: silent && !showError ? '' : 'curl: (47) Maximum (20) redirects followed\n',
          exitCode: 47,
        };
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, effectiveUrl);
      } catch {
        return {
          stdout: '',
          stderr: silent && !showError ? '' : `curl: (3) The redirect target URL could not be parsed: ${location}\n`,
          exitCode: 3,
        };
      }
      effectiveUrl = nextUrl;
      if (effectiveMethod !== 'HEAD' && (response.status === 303 || ([301, 302].includes(response.status) && effectiveMethod === 'POST'))) {
        effectiveMethod = 'GET';
        effectiveBody = undefined;
      }
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
    const writeOutText = writeOut === undefined
      ? ''
      : writeOut
          .replace(/%\{http_code\}/g, String(response.status).padStart(3, '0'))
          .replace(/%\{url_effective\}/g, effectiveUrl.toString())
          .replace(/%\{size_download\}/g, String(responseBodyBytes.byteLength))
          .replace(/%\{content_type\}/g, response.headers?.['content-type'] ?? '')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t');
    const verboseOutput = verbose
      ? [
          `* Connected to ${effectiveUrl.hostname} (${effectiveUrl.hostname}) port ${effectiveUrl.port || (effectiveUrl.protocol === 'https:' ? '443' : '80')}`,
          `> ${request.method} ${request.path} HTTP/1.1`,
          `> Host: ${effectiveUrl.host}`,
          ...rawHeaders.map(([name, value]) => `> ${name}: ${value}`),
          '>',
          `< HTTP/1.1 ${response.status}`,
          ...Object.entries(response.headers ?? {}).map(([name, value]) => `< ${name}: ${value}`),
          '<',
        ].join('\n') + '\n'
      : '';
    if (failOnHttpError && response.status >= 400) {
      return {
        stdout: `${failWithBody ? outputBody : ''}${writeOutText}`,
        stderr: `${verboseOutput}${silent && !showError ? '' : `curl: (22) The requested URL returned error: ${response.status}\n`}`,
        exitCode: 22,
      };
    }
    if (outputPath !== undefined) {
      try {
        if (outputPath !== '/dev/null') {
          const absoluteOutputPath = resolveWorkspaceContextPath(ctx, this.cwd, outputPath, 'curl output path');
          const parent = await ctx.fs.stat(dirname(absoluteOutputPath));
          if (!parent.isDirectory) throw new Error('Output parent is not a directory');
          if (responseHeaders) {
            await ctx.fs.writeFile(absoluteOutputPath, outputBody);
          } else {
            await ctx.fs.writeFile(absoluteOutputPath, responseBodyBytes);
          }
        }
      } catch {
        return {
          stdout: '',
          stderr: silent && !showError ? '' : 'curl: (23) Failed writing received data to disk/application\n',
          exitCode: 23,
        };
      }
      return { stdout: writeOutText, stderr: verboseOutput, exitCode: 0 };
    }
    return {
      stdout: `${outputBody}${writeOutText}`,
      stderr: verboseOutput,
      exitCode: 0,
    };
  }

  private runKernelPing(args: string[], _ctx: CommandContext): RuntimeCommandResult {
    let count = 3;
    const hosts: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '-c') {
        const next = args[++index];
        if (!next) return { stdout: '', stderr: 'ping: option requires an argument -- c\n', exitCode: 2 };
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { stdout: '', stderr: `ping: invalid count: ${next}\n`, exitCode: 2 };
        }
        count = parsed;
        continue;
      }
      if (arg.startsWith('-c') && arg.length > 2) {
        const value = arg.slice(2);
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return { stdout: '', stderr: `ping: invalid count: ${value}\n`, exitCode: 2 };
        }
        count = parsed;
        continue;
      }
      if (arg.startsWith('-')) {
        return { stdout: '', stderr: `ping: unsupported option: ${arg}\n`, exitCode: 2 };
      }
      hosts.push(arg);
    }
    if (hosts.length !== 1) {
      return {
        stdout: '',
        stderr: hosts.length === 0 ? 'ping: missing host operand\n' : 'ping: multiple hosts are not supported\n',
        exitCode: 2,
      };
    }
    const host = hosts[0]!;
    const resolution = this.resolveHost(host);
    if (!resolution.reachable) {
      return { stdout: '', stderr: `ping: cannot resolve ${host}: Unknown host\n`, exitCode: 68 };
    }
    const latency = formatPingLatency(resolution.latencyMs);
    const lines = [
      `PING ${host} (${resolution.ip}): 56 data bytes`,
      ...Array.from({ length: count }, (_value, seq) =>
        `64 bytes from ${resolution.ip}: icmp_seq=${seq} ttl=64 time=${latency} ms`
      ),
      `--- ${host} ping statistics ---`,
      `${count} packets transmitted, ${count} received, 0% packet loss`,
      `round-trip min/avg/max = ${latency}/${latency}/${latency} ms`,
    ];
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
  }

  private async runKernelStat(args: readonly string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let dereference = false;
    let format: string | undefined;
    const paths: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-L' || arg === '--dereference') dereference = true;
      else if (arg === '-c' || arg === '--format') {
        const value = args[++index];
        if (value === undefined) return { stdout: '', stderr: `stat: option requires an argument -- '${arg === '-c' ? 'c' : 'format'}'\n`, exitCode: 1 };
        format = value;
      } else if (arg.startsWith('--format=')) format = arg.slice('--format='.length);
      else if (arg.startsWith('-')) return { stdout: '', stderr: `stat: invalid option -- '${arg.slice(1)}'\n`, exitCode: 1 };
      else paths.push(arg);
    }
    if (paths.length === 0) return { stdout: '', stderr: 'stat: missing operand\n', exitCode: 1 };

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const path of paths) {
      const absolutePath = mapWorkspaceAlias(
        this.cwd,
        this.kernelInfo.workspaceAlias,
        normalizeTerminalAbsolutePath(ctx.fs.resolvePath(ctx.cwd, path))
      );
      const stat = await (dereference ? ctx.fs.stat(absolutePath) : ctx.fs.lstat(absolutePath)).catch(() => null) as (RuntimeLsStat & { ino?: number }) | null;
      if (!stat) {
        stderr += `stat: cannot stat '${path}': No such file or directory\n`;
        exitCode = 1;
        continue;
      }
      const isLink = stat.isSymbolicLink === true;
      const linkTarget = isLink ? await ctx.fs.readlink(absolutePath).catch(() => null) : null;
      const mode = stat.mode ?? (stat.isDirectory ? 0o755 : 0o644);
      const mtimeMs = stat.mtime instanceof Date ? stat.mtime.getTime() : stat.mtimeMs ?? 0;
      const type = isLink ? 'symbolic link' : stat.isDirectory ? 'directory' : stat.isCharacterDevice ? 'character special file' : 'regular file';
      const quotedName = `'${path}'${linkTarget === null ? '' : ` -> '${linkTarget}'`}`;
      const formattedTime = `${new Date(mtimeMs).toISOString().replace('T', ' ').replace('Z', '')} +0000`;
      const renderFormat = (template: string) => template.replace(/%([%nNsFaAuUgGYyih])/g, (_match, directive: string) => {
        switch (directive) {
          case '%': return '%';
          case 'n': return path;
          case 'N': return quotedName;
          case 's': return String(stat.size ?? 0);
          case 'F': return type;
          case 'a': return (mode & 0o7777).toString(8);
          case 'A': return runtimeLsMode(stat);
          case 'u': return String(stat.uid ?? 1000);
          case 'U': return stat.owner ?? this.kernelInfo.user.username;
          case 'g': return String(stat.gid ?? 1000);
          case 'G': return stat.group ?? this.kernelInfo.user.username;
          case 'Y': return String(Math.floor(mtimeMs / 1000));
          case 'y': return formattedTime;
          case 'i': return String(stat.ino ?? 0);
          case 'h': return String(stat.nlink ?? 1);
          default: return `%${directive}`;
        }
      });
      if (format !== undefined) {
        stdout += `${renderFormat(format)}\n`;
      } else {
        stdout += [
          `  File: ${quotedName}`,
          `  Size: ${stat.size ?? 0}\t\tBlocks: ${Math.ceil((stat.size ?? 0) / 512)}`,
          `Access: (${(mode & 0o7777).toString(8).padStart(4, '0')}/${runtimeLsMode(stat)})`,
          `Modify: ${formattedTime}`,
        ].join('\n') + '\n';
      }
    }
    return { stdout, stderr, exitCode };
  }

  private async runKernelDf(args: readonly string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let humanReadable = false;
    let inodes = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === '--human-readable') humanReadable = true;
      else if (arg === '--inodes') inodes = true;
      else if (/^-[hkiP]+$/.test(arg)) {
        humanReadable ||= arg.includes('h');
        inodes ||= arg.includes('i');
      } else if (arg.startsWith('-')) {
        return { stdout: '', stderr: `df: unrecognized option '${arg}'\n`, exitCode: 1 };
      } else {
        paths.push(arg);
      }
    }
    for (const path of paths.length > 0 ? paths : [ctx.cwd]) {
      if (!(await ctx.fs.exists(path))) {
        return { stdout: '', stderr: `df: ${path}: No such file or directory\n`, exitCode: 1 };
      }
    }
    const usage = await this.fs.storageUsage();
    if (inodes) {
      const percent = usage.capacityEntries === 0
        ? (usage.usedEntries === 0 ? 0 : 100)
        : Math.min(100, Math.ceil((usage.usedEntries / usage.capacityEntries) * 100));
      return {
        stdout: [
          'Filesystem Inodes IUsed IFree IUse% Mounted on',
          `tracekernel ${usage.capacityEntries} ${usage.usedEntries} ${usage.availableEntries} ${percent}% ${this.cwd}`,
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    const capacityBlocks = Math.ceil(usage.capacityBytes / 1024);
    const usedBlocks = Math.ceil(usage.usedBytes / 1024);
    const availableBlocks = Math.max(0, capacityBlocks - usedBlocks);
    const percent = usage.capacityBytes === 0
      ? (usage.usedBytes === 0 ? 0 : 100)
      : Math.min(100, Math.ceil((usage.usedBytes / usage.capacityBytes) * 100));
    const capacity = humanReadable ? runtimeLsHumanSize(usage.capacityBytes) : String(capacityBlocks);
    const used = humanReadable ? runtimeLsHumanSize(usage.usedBytes) : String(usedBlocks);
    const available = humanReadable ? runtimeLsHumanSize(usage.availableBytes) : String(availableBlocks);
    return {
      stdout: [
        `Filesystem ${humanReadable ? 'Size' : '1K-blocks'} Used Available Use% Mounted on`,
        `tracekernel ${capacity} ${used} ${available} ${percent}% ${this.cwd}`,
      ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private async runKernelDu(args: readonly string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let allEntries = false;
    let bytes = false;
    let humanReadable = false;
    let summarize = false;
    let total = false;
    let maxDepth: number | undefined;
    let endOfOptions = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && arg.startsWith('--max-depth=')) {
        const value = arg.slice('--max-depth='.length);
        if (!/^\d+$/.test(value)) {
          return { stdout: '', stderr: `du: invalid maximum depth '${value}'\n`, exitCode: 1 };
        }
        maxDepth = Number(value);
        continue;
      }
      if (!endOfOptions && arg === '--all') allEntries = true;
      else if (!endOfOptions && arg === '--bytes') bytes = true;
      else if (!endOfOptions && arg === '--human-readable') humanReadable = true;
      else if (!endOfOptions && arg === '--summarize') summarize = true;
      else if (!endOfOptions && arg === '--total') total = true;
      else if (!endOfOptions && /^-[abhksc]+$/.test(arg)) {
        allEntries ||= arg.includes('a');
        bytes ||= arg.includes('b');
        humanReadable ||= arg.includes('h');
        summarize ||= arg.includes('s');
        total ||= arg.includes('c');
      } else if (!endOfOptions && arg.startsWith('-')) {
        return { stdout: '', stderr: `du: unrecognized option '${arg}'\n`, exitCode: 1 };
      } else {
        paths.push(arg);
      }
    }
    if (summarize && maxDepth !== undefined) {
      return { stdout: '', stderr: 'du: warning: summarizing conflicts with --max-depth\n', exitCode: 1 };
    }

    const formatSize = (size: number): string => {
      if (bytes) return String(size);
      if (humanReadable) return runtimeLsHumanSize(size);
      return String(Math.ceil(size / 1024));
    };
    const rows: Array<{ path: string; size: number }> = [];
    const visit = async (absolutePath: string, displayPath: string, depth: number): Promise<number> => {
      let stat: Awaited<ReturnType<CommandContext['fs']['lstat']>>;
      try {
        stat = await ctx.fs.lstat(absolutePath);
      } catch {
        throw new Error(`du: cannot access '${displayPath}': No such file or directory`);
      }
      if (!stat.isDirectory) {
        if (depth === 0 || allEntries) rows.push({ path: displayPath, size: stat.size });
        return stat.size;
      }
      let size = 0;
      for (const entry of (await ctx.fs.readdir(absolutePath)).sort()) {
        const childAbsolutePath = absolutePath === '/' ? `/${entry}` : `${absolutePath.replace(/\/$/, '')}/${entry}`;
        const childDisplayPath = displayPath === '/'
          ? `/${entry}`
          : displayPath === '.'
            ? `./${entry}`
            : `${displayPath.replace(/\/$/, '')}/${entry}`;
        size += await visit(childAbsolutePath, childDisplayPath, depth + 1);
      }
      if (!summarize && (maxDepth === undefined || depth <= maxDepth)) rows.push({ path: displayPath, size });
      else if (depth === 0) rows.push({ path: displayPath, size });
      return size;
    };

    let grandTotal = 0;
    try {
      for (const path of paths.length > 0 ? paths : ['.']) {
        const absolutePath = resolveWorkspaceContextPath(ctx, this.cwd, path, 'du path');
        grandTotal += await visit(absolutePath, path, 0);
      }
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    if (total) rows.push({ path: 'total', size: grandTotal });
    return {
      stdout: rows.map((row) => `${formatSize(row.size)}\t${row.path}`).join('\n') + (rows.length > 0 ? '\n' : ''),
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelMount(args: readonly string[]): RuntimeCommandResult {
    let endOfOptions = false;
    const operands: string[] = [];
    for (const arg of args) {
      if (!endOfOptions && arg === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && (arg === '-l' || arg === '--show-labels')) {
        continue;
      }
      if (!endOfOptions && arg.startsWith('-')) {
        return { stdout: '', stderr: `mount: unrecognized option '${arg}'\n`, exitCode: 1 };
      }
      operands.push(arg);
    }
    if (operands.length > 0) {
      return {
        stdout: '',
        stderr: 'mount: TraceKernel filesystem topology is fixed for the lifetime of a workspace\n',
        exitCode: 32,
      };
    }
    const rows = runtimeKernelMounts(this.kernelInfo).map((mount) => {
      const options = mount.options.join(',');
      return `${mount.source} on ${mount.target} type ${mount.type} (${options})`;
    });
    return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 };
  }

  private runTraceKernelWhich(args: string[], commandName: string, _ctx: CommandContext): RuntimeCommandResult {
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

  private async runTraceKernelCommandBuiltin(
    args: string[],
    ctx: CommandContext
  ): Promise<RuntimeCommandResult> {
    const option = args[0];
    if (option === '-v') {
      return this.runTraceKernelWhich(args.slice(1), 'command', ctx);
    }
    if (option === '-V') {
      const discovered = this.runTraceKernelWhich(args.slice(1), 'command', ctx);
      return discovered.exitCode === 0
        ? {
            ...discovered,
            stdout: discovered.stdout.trimEnd().split('\n').map((path) => {
              const name = path.slice(path.lastIndexOf('/') + 1);
              return `${name} is ${path}`;
            }).join('\n') + '\n',
          }
        : discovered;
    }
    let commandIndex = 0;
    while (args[commandIndex] === '-p' || args[commandIndex] === '--') {
      commandIndex += 1;
    }
    const executable = args[commandIndex];
    if (!executable) return { stdout: '', stderr: '', exitCode: 0 };
    if (!ctx.exec) {
      return {
        stdout: '',
        stderr: `command: ${executable}: command not found\n`,
        exitCode: 127,
      };
    }
    const standardPathCommand = /^\/(?:usr\/)?bin\/([^/]+)$/u.exec(executable)?.[1];
    const resolvedExecutable =
      traceKernelBinCommandName(executable) ?? standardPathCommand ?? executable;
    return ctx.exec(resolvedExecutable, {
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      replaceEnv: true,
      stdin: decodeCommandStdin(ctx.stdin),
      stdinKind: 'bytes',
      signal: ctx.signal,
      args: args.slice(commandIndex + 1),
    });
  }

  private async runTraceKernelCtl(args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
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
          `processes.active=${this.processTableUsage()}`,
          `processes.max=${this.maxProcesses ?? 'unlimited'}`,
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
      if (this.activeProcessRecords().some((process) => process.signalPolicy === 'system-only')) {
        return {
          stdout: '',
          stderr: 'tracekernelctl: reset: Operation not permitted\n',
          exitCode: 1,
        };
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
        const result = this.signalProcessGroup(pgid, signal.name, this.resolveCommandContext(ctx)?.process.pid);
        if (result.denied > 0 && result.signaled === 0) {
          return { stdout: '', stderr: `tracekernelctl: kill ${pgid}: Operation not permitted\n`, exitCode: 1 };
        }
        if (result.signaled === 0) return { stdout: '', stderr: `tracekernelctl: no such process group: ${pgid}\n`, exitCode: 3 };
        return { stdout: `tracekernelctl: sent ${signal.name} to process group ${pgid} (${result.signaled} process${result.signaled === 1 ? '' : 'es'})\n`, stderr: '', exitCode: 0 };
      }
      const process = this.findProcessRecord(target);
      if (!process || process.state === 'exited') {
        return { stdout: '', stderr: `tracekernelctl: no such process: ${target}\n`, exitCode: 3 };
      }
      if (process.signalPolicy === 'system-only') {
        return { stdout: '', stderr: `tracekernelctl: kill ${target}: Operation not permitted\n`, exitCode: 1 };
      }
      if (!this.signalProcess(process, signal.name)) {
        return { stdout: '', stderr: `tracekernelctl: no such process: ${target}\n`, exitCode: 3 };
      }
      return { stdout: `tracekernelctl: sent ${signal.name} to ${target}\n`, stderr: '', exitCode: 0 };
    }
    if (command === 'wait') {
      return this.runKernelWaitForParent(args.slice(1), 'tracekernelctl', this.resolveCommandContext(ctx)?.process.pid);
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
      const absolutePath = ctx.fs.resolvePath(ctx.cwd, input);
      try {
        const stat = await statPath(absolutePath);
        const lstat = await lstatPath(absolutePath);
        if (options.directoryOnly || !stat.isDirectory || runtimeFileSystemEntryIsSymlink(lstat)) {
          stdout += await renderEntry(absolutePath, input);
          continue;
        }
        if (index > 0 && stdout && !stdout.endsWith('\n\n')) stdout += '\n';
        await renderDirectory(input, absolutePath, multipleTargets || options.recursive, options.recursive);
      } catch {
        stderr += `ls: cannot access '${input}': No such file or directory\n`;
        exitCode = 2;
      }
    }
    return { stdout, stderr, exitCode };
  }

  private processDisplayName(process: RuntimeKernelProcessRecord): string {
    const executable = process.command.trim().split(/\s+/, 1)[0] ?? process.command;
    return executable.split('/').pop() || executable || 'process';
  }

  private processStat(process: RuntimeKernelProcessRecord): string {
    const state = process.state === 'running'
      ? 'R'
      : process.state === 'queued'
        ? 'S'
        : process.state === 'zombie'
          ? 'Z'
          : process.state === 'signaled'
            ? 'X'
            : 'S';
    return `${state}${process.foreground ? '+' : ''}`;
  }

  private processStartLabel(process: RuntimeKernelProcessRecord): string {
    const startedAt = new Date(process.startedAt);
    if (Number.isNaN(startedAt.getTime())) return '--:--';
    return startedAt.toISOString().slice(11, 16);
  }

  private processRecordsForInspection(ctx?: CommandContext): RuntimeKernelProcessRecord[] {
    const currentPid = this.resolveCommandContext(ctx)?.process.pid;
    return [this.principalProcessRecord(), ...this.activeProcessRecords()]
      .filter((process) => process.pid !== currentPid);
  }

  private runKernelSs(args: string[], _ctx: CommandContext): RuntimeCommandResult {
    const longFlags = new Map([
      ['--listening', 'l'],
      ['--tcp', 't'],
      ['--numeric', 'n'],
      ['--processes', 'p'],
    ]);
    let flags = '';
    let invalid = false;
    for (const arg of args) {
      const longFlag = longFlags.get(arg);
      if (longFlag) {
        flags += longFlag;
        continue;
      }
      if (/^-[ltnp]+$/.test(arg)) {
        flags += arg.slice(1);
        continue;
      }
      invalid = true;
      break;
    }
    if (invalid) {
      return { stdout: '', stderr: 'Usage: ss [-ltnp]\n', exitCode: 2 };
    }
    const showListeners = flags.includes('l');
    const showProcesses = flags.includes('p');
    const listeners = [...this.httpListeners.values()]
      .map((listener) => listener.info)
      .sort((left, right) => left.port - right.port || left.host.localeCompare(right.host));
    const rows = listeners
      .filter(() => showListeners || flags.length === 0)
      .map((listener) => {
        const process = this.findProcessRecord(listener.pid);
        const processColumn = showProcesses
          ? ` users:((\"${this.processDisplayName(process ?? this.principalProcessRecord())}\",pid=${listener.pid},fd=3))`
          : '';
        return `LISTEN 0      511    ${listener.host}:${listener.port}      0.0.0.0:*${processColumn}`;
      });
    return {
      stdout: [
        `State  Recv-Q Send-Q Local Address:Port Peer Address:Port${showProcesses ? ' Process' : ''}`,
        ...rows,
      ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelLsof(args: string[], _ctx: CommandContext): RuntimeCommandResult {
    let port: number | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      if (arg === '-i') {
        const selector = args[++index];
        if (!selector) return { stdout: '', stderr: 'lsof: option requires an argument -- i\n', exitCode: 1 };
        const match = /^:(\d+)$/.exec(selector);
        if (!match) return { stdout: '', stderr: `lsof: unsupported network selector: ${selector}\n`, exitCode: 1 };
        port = Number(match[1]);
        continue;
      }
      const match = /^-i:(\d+)$/.exec(arg);
      if (match) {
        port = Number(match[1]);
        continue;
      }
      return { stdout: '', stderr: `lsof: unsupported option: ${arg}\n`, exitCode: 1 };
    }
    if (port === undefined) {
      return { stdout: '', stderr: 'lsof: usage: lsof -i :PORT\n', exitCode: 1 };
    }
    const listeners = [...this.httpListeners.values()]
      .map((listener) => listener.info)
      .filter((listener) => listener.port === port)
      .sort((left, right) => left.pid - right.pid);
    if (listeners.length === 0) return { stdout: '', stderr: '', exitCode: 1 };
    const rows = listeners.map((listener) => {
      const process = this.findProcessRecord(listener.pid);
      return [
        this.processDisplayName(process ?? this.principalProcessRecord()).padEnd(9, ' '),
        String(listener.pid).padStart(5, ' '),
        this.kernelInfo.user.username.padEnd(8, ' '),
        '3u',
        'IPv4',
        '-'.padStart(8, ' '),
        '0t0'.padStart(8, ' '),
        'TCP',
        `${listener.host}:${listener.port} (LISTEN)`,
      ].join(' ');
    });
    return {
      stdout: ['COMMAND     PID USER     FD TYPE   DEVICE SIZE/OFF NODE NAME', ...rows].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelProcessMatch(
    args: string[],
    commandName: 'pgrep' | 'pkill',
    ctx: CommandContext
  ): RuntimeCommandResult {
    let fullCommand = false;
    let exact = false;
    let listName = false;
    let listFull = false;
    let signalName = 'SIGTERM';
    const positional: string[] = [];
    for (const arg of args) {
      if (arg === '--') {
        positional.push(...args.slice(args.indexOf(arg) + 1));
        break;
      }
      if (arg === '-f') {
        fullCommand = true;
        continue;
      }
      if (arg === '-x') {
        exact = true;
        continue;
      }
      if (commandName === 'pgrep' && arg === '-l') {
        listName = true;
        continue;
      }
      if (commandName === 'pgrep' && arg === '-a') {
        listFull = true;
        continue;
      }
      if (commandName === 'pgrep' && /^-[aflx]+$/.test(arg)) {
        fullCommand ||= arg.includes('f');
        exact ||= arg.includes('x');
        listName ||= arg.includes('l');
        listFull ||= arg.includes('a');
        continue;
      }
      if (commandName === 'pkill' && /^-[fx]+$/.test(arg)) {
        fullCommand ||= arg.includes('f');
        exact ||= arg.includes('x');
        continue;
      }
      if (commandName === 'pkill' && arg.startsWith('-') && arg.length > 1) {
        const signal = normalizeTraceKernelSignal(arg.slice(1));
        if (!signal) return { stdout: '', stderr: `${commandName}: invalid signal: ${arg.slice(1)}\n`, exitCode: 2 };
        signalName = signal.name;
        continue;
      }
      if (arg.startsWith('-')) {
        return { stdout: '', stderr: `usage: ${commandName} [-f] [-x]${commandName === 'pgrep' ? ' [-a|-l]' : ' [-SIGNAL]'} pattern\n`, exitCode: 2 };
      }
      positional.push(arg);
    }
    if (positional.length !== 1) {
      return { stdout: '', stderr: `usage: ${commandName} [-f] [-x]${commandName === 'pgrep' ? ' [-a|-l]' : ' [-SIGNAL]'} pattern\n`, exitCode: 2 };
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(exact ? `^(?:${positional[0]})$` : positional[0]);
    } catch {
      return { stdout: '', stderr: `${commandName}: invalid regular expression\n`, exitCode: 2 };
    }
    const matches = this.processRecordsForInspection(ctx).filter((process) => {
      const candidate = fullCommand ? process.command : this.processDisplayName(process);
      return pattern.test(candidate);
    });
    if (matches.length === 0) return { stdout: '', stderr: '', exitCode: 1 };
    if (commandName === 'pgrep') {
      const rows = matches.map((process) => listFull
        ? `${process.pid} ${process.command}`
        : listName
          ? `${process.pid} ${this.processDisplayName(process)}`
          : String(process.pid));
      return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 };
    }
    let denied = 0;
    let signaled = 0;
    for (const process of matches) {
      if (this.signalProcess(process, signalName)) signaled += 1;
      else denied += 1;
    }
    if (signaled === 0 && denied > 0) {
      return { stdout: '', stderr: `${commandName}: Operation not permitted\n`, exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private runKernelPs(args: string[], _ctx: CommandContext): RuntimeCommandResult {
    const supported = new Set(['', '-e', '-f', '-ef', 'aux']);
    const mode = args.join('');
    if (!supported.has(mode)) {
      return { stdout: '', stderr: 'usage: ps [-e|-f|-ef|aux]\n', exitCode: 2 };
    }
    const processes = [this.principalProcessRecord(), ...this.activeProcessRecords()];
    if (mode === 'aux') {
      const rows = processes.map((process) => [
        this.kernelInfo.user.username.padEnd(8, ' '),
        String(process.pid).padStart(5, ' '),
        '0.0'.padStart(4, ' '),
        '0.0'.padStart(4, ' '),
        '0'.padStart(7, ' '),
        '0'.padStart(5, ' '),
        (process.tty === '?' ? '?' : process.tty.replace('/dev/', '')).padEnd(7, ' '),
        this.processStat(process).padEnd(4, ' '),
        this.processStartLabel(process).padEnd(5, ' '),
        '0:00'.padStart(5, ' '),
        process.command,
      ].join(' '));
      return {
        stdout: ['USER       PID %CPU %MEM    VSZ   RSS TTY     STAT START  TIME COMMAND', ...rows].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    const rows = processes.map((process) =>
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

  private runKernelJobs(args: string[], ctx: CommandContext): RuntimeCommandResult {
    if (args.length > 1 || (args[0] !== undefined && args[0] !== '-l')) {
      return { stdout: '', stderr: 'usage: jobs [-l]\n', exitCode: 2 };
    }
    const currentPid = this.resolveCommandContext(ctx)?.process.pid;
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

  private kernelJobRecords(currentPid?: number): RuntimeKernelProcessRecord[] {
    return this.activeProcessRecords().filter((process) => process.pid !== currentPid && process.pid !== 1);
  }

  private resolveKernelJobTarget(target: string | undefined, currentPid?: number): RuntimeKernelProcessRecord | undefined {
    const jobs = this.kernelJobRecords(currentPid);
    if (target === undefined) return jobs[0];
    const jobMatch = target.match(/^%([1-9][0-9]*)$/);
    if (jobMatch) return jobs[Number(jobMatch[1]) - 1];
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const process = this.findProcessRecord(pid);
    if (!process || process.pid === 1 || process.pid === currentPid || process.state === 'exited') {
      return undefined;
    }
    return process;
  }

  private runKernelJobPlacement(args: string[], commandName: 'bg' | 'fg', ctx: CommandContext): RuntimeCommandResult {
    if (args.length > 1) {
      return { stdout: '', stderr: `usage: ${commandName} [pid|%job]\n`, exitCode: 2 };
    }
    const process = this.resolveKernelJobTarget(args[0], this.resolveCommandContext(ctx)?.process.pid);
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

  private runKernelKill(args: string[], commandName: string, ctx: CommandContext): RuntimeCommandResult {
    if (args.length === 0) {
      return { stdout: '', stderr: `usage: ${commandName} [-SIGNAL] <pid>...\n`, exitCode: 2 };
    }
    if (args[0] === '-l' || args[0] === '--list') {
      if (args.length === 1) {
        const signals = [...TRACEKERNEL_SIGNAL_NUMBERS.entries()]
          .map(([name, number]) => `${number}) ${name.slice(3)}`)
          .join(' ');
        return { stdout: `${signals}\n`, stderr: '', exitCode: 0 };
      }
      if (args.length === 2) {
        const signal = normalizeTraceKernelSignal(args[1]);
        if (!signal) return { stdout: '', stderr: `${commandName}: invalid signal: ${args[1]}\n`, exitCode: 1 };
        return {
          stdout: /^\d+$/.test(args[1]!) ? `${signal.name.slice(3)}\n` : `${signal.code}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: `usage: ${commandName} -l [SIGNAL]\n`, exitCode: 2 };
    }
    let signalName = 'SIGTERM';
    let pidArgs = args[0] === '--' ? args.slice(1) : args;
    const first = pidArgs[0] ?? '';
    const probeOnly = first === '-0';
    if (probeOnly) pidArgs = pidArgs.slice(1);
    if (first.startsWith('-') && first.length > 1 && !/^-?[0-9]+$/.test(first)) {
      signalName = first.slice(1);
      pidArgs = pidArgs.slice(1);
    }
    const signal = probeOnly ? { name: '0', code: 0 } : normalizeTraceKernelSignal(signalName);
    if (!signal) return { stdout: '', stderr: `${commandName}: invalid signal: ${signalName}\n`, exitCode: 22 };
    if (pidArgs.length === 0) return { stdout: '', stderr: `usage: ${commandName} [-SIGNAL] <pid>...\n`, exitCode: 2 };

    for (const pidArg of pidArgs) {
      const target = Number(pidArg);
      if (!Number.isInteger(target) || target === 0) {
        return { stdout: '', stderr: `${commandName}: invalid pid: ${pidArg}\n`, exitCode: 22 };
      }
      if (target < 0) {
        const pgid = Math.abs(target);
        if (probeOnly) {
          const exists = this.activeProcessRecords().some((process) => process.pgid === pgid);
          if (!exists) return { stdout: '', stderr: `${commandName}: no such process group: ${pgid}\n`, exitCode: 3 };
          continue;
        }
        const groupResult = this.signalProcessGroup(pgid, signal.name, this.resolveCommandContext(ctx)?.process.pid);
        if (groupResult.denied > 0 && groupResult.signaled === 0) {
          return { stdout: '', stderr: `${commandName}: (${pgid}) - Operation not permitted\n`, exitCode: 1 };
        }
        if (groupResult.signaled === 0) {
          return { stdout: '', stderr: `${commandName}: no such process group: ${pgid}\n`, exitCode: 3 };
        }
        continue;
      }
      const process = this.findProcessRecord(target);
      if (!process || process.state === 'exited') {
        return { stdout: '', stderr: `${commandName}: no such process: ${target}\n`, exitCode: 3 };
      }
      if (process.signalPolicy === 'system-only') {
        return { stdout: '', stderr: `${commandName}: (${target}) - Operation not permitted\n`, exitCode: 1 };
      }
      if (!probeOnly) this.signalProcess(process, signal.name);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private runKernelWait(args: string[], commandName: string, _ctx: CommandContext): Promise<RuntimeCommandResult> {
    return this.runKernelWaitForParent(
      args,
      commandName === 'tracekernelctl' ? 'tracekernelctl' : 'wait',
      this.resolveCommandContext(_ctx)?.process.pid
    );
  }

  private runKernelWhoami(args: readonly string[]): RuntimeCommandResult {
    if (args.length > 0) {
      return { stdout: '', stderr: `whoami: extra operand '${args[0]}'\n`, exitCode: 1 };
    }
    return { stdout: `${this.kernelInfo.user.username}\n`, stderr: '', exitCode: 0 };
  }

  private runKernelHostname(args: readonly string[]): RuntimeCommandResult {
    if (args.length > 1 || (args.length === 1 && args[0] !== '-s' && args[0] !== '-f')) {
      return { stdout: '', stderr: 'usage: hostname [-s|-f]\n', exitCode: 1 };
    }
    return { stdout: `${this.kernelInfo.host.hostname}\n`, stderr: '', exitCode: 0 };
  }

  private runKernelId(args: readonly string[]): RuntimeCommandResult {
    const username = this.kernelInfo.user.username;
    const userId = 1000;
    const groupId = 1000;
    if (args.length === 0) {
      return {
        stdout: `uid=${userId}(${username}) gid=${groupId}(${username}) groups=${groupId}(${username})\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    const flags = new Set(args.filter((arg) => arg.startsWith('-')).flatMap((arg) => arg.slice(1).split('')));
    const operands = args.filter((arg) => !arg.startsWith('-'));
    if (operands.length > 1 || (operands[0] !== undefined && operands[0] !== username)) {
      const operand = operands[0] ?? '';
      return { stdout: '', stderr: `id: '${operand}': no such user\n`, exitCode: 1 };
    }
    if ([...flags].some((flag) => !'ugn'.includes(flag)) || flags.has('n') && !flags.has('u') && !flags.has('g')) {
      return { stdout: '', stderr: 'usage: id [-u|-g] [-n] [USER]\n', exitCode: 1 };
    }
    if (flags.has('u')) return { stdout: `${flags.has('n') ? username : userId}\n`, stderr: '', exitCode: 0 };
    if (flags.has('g')) return { stdout: `${flags.has('n') ? username : groupId}\n`, stderr: '', exitCode: 0 };
    return {
      stdout: `uid=${userId}(${username}) gid=${groupId}(${username}) groups=${groupId}(${username})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelGroups(args: readonly string[]): RuntimeCommandResult {
    const username = this.kernelInfo.user.username;
    if (args.length > 1 || (args[0] !== undefined && args[0] !== username)) {
      const operand = args[0] ?? '';
      return { stdout: '', stderr: `groups: '${operand}': no such user\n`, exitCode: 1 };
    }
    return {
      stdout: args.length === 0 ? `${username}\n` : `${username} : ${username}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelGetconf(args: readonly string[]): RuntimeCommandResult {
    const values: Record<string, string> = {
      PATH: `${TRACEKERNEL_BIN_PATH}:/usr/local/bin:/usr/bin:/bin`,
      ARG_MAX: '2097152',
      OPEN_MAX: '1024',
      PAGESIZE: '65536',
      PAGE_SIZE: '65536',
      _NPROCESSORS_ONLN: '1',
    };
    if (args.length !== 1) {
      return { stdout: '', stderr: 'usage: getconf NAME\n', exitCode: 2 };
    }
    const value = values[args[0]!];
    if (value === undefined) {
      return { stdout: '', stderr: `getconf: Unrecognized variable '${args[0]}'\n`, exitCode: 2 };
    }
    return { stdout: `${value}\n`, stderr: '', exitCode: 0 };
  }

  private runKernelGetent(args: readonly string[]): RuntimeCommandResult {
    const database = args[0];
    const keys = args.slice(1);
    const username = this.kernelInfo.user.username;
    if (!database) return { stdout: '', stderr: 'usage: getent database [key ...]\n', exitCode: 2 };
    if (database === 'passwd') {
      if (keys.length > 1) return { stdout: '', stderr: '', exitCode: 2 };
      if (keys[0] !== undefined && keys[0] !== username && keys[0] !== '1000') {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      return {
        stdout: `${username}:x:1000:1000:TraceKernel user:${this.baseEnv.HOME}:/bin/bash\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (database === 'group') {
      if (keys.length > 1) return { stdout: '', stderr: '', exitCode: 2 };
      if (keys[0] !== undefined && keys[0] !== username && keys[0] !== '1000') {
        return { stdout: '', stderr: '', exitCode: 2 };
      }
      return { stdout: `${username}:x:1000:${username}\n`, stderr: '', exitCode: 0 };
    }
    if (database === 'hosts' || database === 'ahosts') {
      if (keys.length !== 1) return { stdout: '', stderr: '', exitCode: 2 };
      const host = keys[0]!;
      const resolution = this.resolveHost(host);
      if (!resolution.reachable) return { stdout: '', stderr: '', exitCode: 2 };
      return { stdout: `${resolution.ip} ${host}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `Unknown database: ${database}\n`, exitCode: 1 };
  }

  private runKernelLocale(args: readonly string[]): RuntimeCommandResult {
    if (args.length === 1 && args[0] === '-a') {
      return { stdout: 'C\nC.utf8\nPOSIX\n', stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === 'charmap') {
      return { stdout: 'UTF-8\n', stderr: '', exitCode: 0 };
    }
    if (args.length > 0) {
      return { stdout: '', stderr: `locale: unknown name '${args[0]}'\n`, exitCode: 1 };
    }
    const lang = this.baseEnv.LANG ?? 'C.UTF-8';
    return {
      stdout: [
        `LANG=${lang}`,
        'LANGUAGE=',
        `LC_CTYPE="${lang}"`,
        `LC_NUMERIC="${lang}"`,
        `LC_TIME="${lang}"`,
        `LC_COLLATE="${lang}"`,
        `LC_MONETARY="${lang}"`,
        `LC_MESSAGES="${lang}"`,
        `LC_PAPER="${lang}"`,
        `LC_NAME="${lang}"`,
        `LC_ADDRESS="${lang}"`,
        `LC_TELEPHONE="${lang}"`,
        `LC_MEASUREMENT="${lang}"`,
        `LC_IDENTIFICATION="${lang}"`,
        'LC_ALL=',
      ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private runKernelTty(args: readonly string[], ctx: CommandContext): RuntimeCommandResult {
    if (args.length > 0 && (args.length !== 1 || args[0] !== '-s')) {
      return { stdout: '', stderr: 'usage: tty [-s]\n', exitCode: 2 };
    }
    if (!this.terminalForCommand(ctx)?.isTTY) {
      return { stdout: args[0] === '-s' ? '' : 'not a tty\n', stderr: '', exitCode: 1 };
    }
    return { stdout: args[0] === '-s' ? '' : '/dev/tty\n', stderr: '', exitCode: 0 };
  }

  private runKernelTestBuiltin(
    args: string[],
    commandName: 'test' | '[',
    ctx: CommandContext
  ): RuntimeCommandResult {
    const expression = commandName === '[' && args.at(-1) === ']' ? args.slice(0, -1) : args;
    const bracketClosed = commandName !== '[' || args.at(-1) === ']';
    const negated = expression[0] === '!';
    const ttyExpression = negated ? expression.slice(1) : expression;
    if (bracketClosed && ttyExpression.length === 2 && ttyExpression[0] === '-t') {
      const rawFd = ttyExpression[1] ?? '';
      const fd = /^\d+$/.test(rawFd) ? Number(rawFd) : -1;
      const attached = this.terminalForCommand(ctx)?.isTTY === true && fd >= 0 && fd <= 2;
      return { stdout: '', stderr: '', exitCode: (negated ? !attached : attached) ? 0 : 1 };
    }
    return { stdout: '', stderr: `${commandName}: invalid terminal test\n`, exitCode: 2 };
  }

  private runKernelUname(args: readonly string[]): RuntimeCommandResult {
    const fields = {
      s: 'TraceKernel',
      n: this.kernelInfo.host.hostname,
      r: this.kernelInfo.version,
      v: `TraceKernel ${this.kernelInfo.version}`,
      m: TRACE_KERNEL_ARCHITECTURE,
      p: TRACE_KERNEL_ARCHITECTURE,
      i: TRACE_KERNEL_ARCHITECTURE,
      o: 'TraceKernel',
    } as const;
    const requested = args.length === 0 ? ['s'] : args.flatMap((arg) => {
      if (arg === '--all') return ['a'];
      if (arg.startsWith('--')) {
        const names: Record<string, keyof typeof fields> = {
          '--kernel-name': 's',
          '--nodename': 'n',
          '--kernel-release': 'r',
          '--kernel-version': 'v',
          '--machine': 'm',
          '--processor': 'p',
          '--hardware-platform': 'i',
          '--operating-system': 'o',
        };
        return names[arg] ? [names[arg]!] : ['?'];
      }
      return arg.startsWith('-') ? arg.slice(1).split('') : ['?'];
    });
    if (requested.includes('?') || requested.some((flag) => flag !== 'a' && !(flag in fields))) {
      return { stdout: '', stderr: 'uname: invalid option\n', exitCode: 1 };
    }
    const order: Array<keyof typeof fields> = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'];
    const selected = requested.includes('a') ? order : order.filter((flag) => requested.includes(flag));
    return { stdout: `${selected.map((flag) => fields[flag]).join(' ')}\n`, stderr: '', exitCode: 0 };
  }

  private runKernelFastfetch(args: readonly string[], ctx: CommandContext): RuntimeCommandResult {
    if (args.length === 1 && args[0] === '--version') {
      return {
        stdout: `fastfetch ${this.kernelInfo.version} (TraceKernel)\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length > 0) {
      return {
        stdout: '',
        stderr: `fastfetch: unknown option: ${args[0]}\n`,
        exitCode: 1,
      };
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(this.kernelInfo.workspace.startedAt)) / 1_000)
    );
    const uptimeParts: string[] = [];
    const hours = Math.floor(elapsedSeconds / 3_600);
    const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
    const seconds = elapsedSeconds % 60;
    if (hours > 0) uptimeParts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (minutes > 0) uptimeParts.push(`${minutes} min`);
    if (hours === 0 && minutes === 0) uptimeParts.push(`${seconds} sec`);

    const terminal = this.terminalForCommand(ctx);
    const availableRuntimes = traceKernelRuntimeRegistry(this.traceKernelCommandRegistry)
      .filter((runtime) => runtime.available).length;
    // Generated from the TraceCode app icon at 36x36 pixels, then packed into
    // Unicode Braille cells. Ordinary spaces keep the mark aligned even when
    // the terminal falls back from its primary monospace font.
    const logo = [
      '    ⣀            ⣀',
      '   ⣾⠋⠱⢦⣄⣀      ⠈⠙⣷',
      '  ⣸⡏      ⠈⠙⠛⢶⣤⡀  ⢹⣇',
      '  ⣿     ⢀⣠⡴⠾⠛⠉     ⣿',
      '  ⢹⣇    ⠛⠷⣤⣀⡀      ⣸⡏',
      '   ⢿⣄⡀      ⠉⠙⠿⢆⣠⡿',
      '    ⠉            ⠉',
    ];
    const heading = `${this.kernelInfo.user.username}@${this.kernelInfo.host.hostname}`;
    const details = [
      heading,
      '-'.repeat(heading.length),
      `OS: ${this.kernelInfo.host.osName === 'tracekernel' ? 'TraceKernel' : this.kernelInfo.host.osName}`,
      `Host: ${this.kernelInfo.host.hostname}`,
      `Kernel: ${this.kernelInfo.version}`,
      `Uptime: ${uptimeParts.join(', ')}`,
      `Shell: /bin/bash`,
      `Terminal: ${terminal?.term ?? 'dumb'} (${terminal?.columns ?? 80}x${terminal?.rows ?? 24})`,
      `Architecture: ${TRACE_KERNEL_ARCHITECTURE}`,
      `Workspace: ${this.kernelInfo.workspace.name}`,
      `Runtimes: ${availableRuntimes} available`,
      `Commands: ${this.traceKernelCommandRegistry.length}`,
    ];
    const rows = Array.from(
      { length: Math.max(logo.length, details.length) },
      (_, index) => `${(logo[index] ?? '').padEnd(24)}${details[index] ?? ''}`.trimEnd()
    );
    return { stdout: `${rows.join('\n')}\n`, stderr: '', exitCode: 0 };
  }

  private runKernelUmask(args: readonly string[], ctx: CommandContext): RuntimeCommandResult {
    const commandContext = this.resolveCommandContext(ctx);
    const current = commandContext?.umask ?? 0o022;
    if (args.length === 0) {
      return { stdout: `${current.toString(8).padStart(4, '0')}\n`, stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === '-p') {
      return { stdout: `umask ${current.toString(8).padStart(4, '0')}\n`, stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === '-S') {
      const allowed = 0o777 & ~current;
      const permissions = (bits: number) => `${bits & 4 ? 'r' : ''}${bits & 2 ? 'w' : ''}${bits & 1 ? 'x' : ''}`;
      return {
        stdout: `u=${permissions((allowed >> 6) & 7)},g=${permissions((allowed >> 3) & 7)},o=${permissions(allowed & 7)}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (args.length !== 1) {
      return { stdout: '', stderr: `bash: umask: ${args.join(' ')}: invalid symbolic mode operator\n`, exitCode: 1 };
    }
    const rawMode = args[0]!;
    let next: number;
    if (/^[0-7]{1,4}$/.test(rawMode)) {
      next = Number.parseInt(rawMode, 8);
      if (next > 0o777) {
        return { stdout: '', stderr: `bash: umask: ${rawMode}: octal number out of range\n`, exitCode: 1 };
      }
    } else {
      const clauses = rawMode.split(',');
      let allowed = 0o777 & ~current;
      for (const clause of clauses) {
        const match = /^([ugoa]*)([+=-][rwx]*)+$/.exec(clause);
        if (!match) {
          return { stdout: '', stderr: `bash: umask: ${rawMode}: invalid symbolic mode operator\n`, exitCode: 1 };
        }
        const whoText = match[1] || 'a';
        const classes = new Set(whoText.includes('a') ? ['u', 'g', 'o'] : [...whoText]);
        const classMask = (classes.has('u') ? 0o700 : 0) |
          (classes.has('g') ? 0o070 : 0) |
          (classes.has('o') ? 0o007 : 0);
        const operations = clause.slice(match[1]!.length).match(/[+=-][rwx]*/g) ?? [];
        for (const operation of operations) {
          const permissionText = operation.slice(1);
          const permissionBits = (permissionText.includes('r') ? 4 : 0) |
            (permissionText.includes('w') ? 2 : 0) |
            (permissionText.includes('x') ? 1 : 0);
          const requested = (classes.has('u') ? permissionBits << 6 : 0) |
            (classes.has('g') ? permissionBits << 3 : 0) |
            (classes.has('o') ? permissionBits : 0);
          if (operation[0] === '=') allowed = (allowed & ~classMask) | requested;
          else if (operation[0] === '+') allowed |= requested;
          else allowed &= ~requested;
        }
      }
      next = 0o777 & ~allowed;
    }
    if (commandContext) {
      commandContext.umask = next;
      commandContext.onUmaskChange?.(next);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private runKernelMan(args: readonly string[]): RuntimeCommandResult {
    const command = args.find((arg) => !arg.startsWith('-'));
    if (!command) {
      return { stdout: '', stderr: 'What manual page do you want?\n', exitCode: 1 };
    }
    const info = this.traceKernelCommandInfo(command);
    if (!info?.help) {
      return { stdout: '', stderr: `No manual entry for ${command}\n`, exitCode: 1 };
    }
    return this.traceKernelCommandHelp(info.name, ['--help']) ?? {
      stdout: '',
      stderr: `No manual entry for ${command}\n`,
      exitCode: 1,
    };
  }

  private terminalForCommand(ctx: CommandContext): RuntimeCommandOptions['terminal'] | undefined {
    return this.resolveCommandContext(ctx)?.terminal;
  }

  private runKernelStty(args: readonly string[], ctx: CommandContext): RuntimeCommandResult {
    const terminal = this.terminalForCommand(ctx);
    if (!terminal?.isTTY) {
      return {
        stdout: '',
        stderr: 'stty: standard input: Inappropriate ioctl for device\n',
        exitCode: 1,
      };
    }
    if (args.length === 0) {
      return { stdout: `speed 38400 baud; rows ${terminal.rows}; columns ${terminal.columns}; line = 0;\n`, stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === 'size') {
      return { stdout: `${terminal.rows} ${terminal.columns}\n`, stderr: '', exitCode: 0 };
    }
    if (args.length === 1 && args[0] === '-a') {
      return {
        stdout: [
          `speed 38400 baud; rows ${terminal.rows}; columns ${terminal.columns}; line = 0;`,
          'intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D;',
          'echo icanon isig',
        ].join('\n') + '\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: '',
      stderr: `stty: unsupported terminal setting: ${args.join(' ')}\n`,
      exitCode: 1,
    };
  }

  private runKernelTput(args: readonly string[], ctx: CommandContext): RuntimeCommandResult {
    const terminal = this.terminalForCommand(ctx);
    if (!terminal?.isTTY) {
      return { stdout: '', stderr: 'tput: No value for $TERM and no -T specified\n', exitCode: 2 };
    }
    const capability = args[0];
    if (!capability) return { stdout: '', stderr: 'tput: missing operand\n', exitCode: 2 };
    if (capability === 'cols') return { stdout: `${terminal.columns}\n`, stderr: '', exitCode: 0 };
    if (capability === 'lines') return { stdout: `${terminal.rows}\n`, stderr: '', exitCode: 0 };
    if (capability === 'colors') {
      const colors = [-1, 16, 256, 16_777_216][terminal.colorLevel] ?? -1;
      return { stdout: `${colors}\n`, stderr: '', exitCode: 0 };
    }
    if (capability === 'longname') return { stdout: `${terminal.columns}-column ${terminal.term} terminal\n`, stderr: '', exitCode: 0 };
    // TERM=dumb deliberately has no cursor-addressing or styling sequences.
    if (['clear', 'el', 'ed', 'cup', 'bold', 'sgr0', 'setaf', 'setab'].includes(capability)) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `tput: unknown terminfo capability '${capability}'\n`, exitCode: 4 };
  }

  private async runKernelWget(args: readonly string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let outputDocument: string | undefined;
    let spider = false;
    let quiet = false;
    let url: string | undefined;
    const curlArgs: string[] = ['-L'];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-q' || arg === '--quiet') quiet = true;
      else if (arg === '--spider') spider = true;
      else if (arg === '-O' || arg === '--output-document') {
        outputDocument = args[index + 1];
        if (outputDocument === undefined) return { stdout: '', stderr: 'wget: option requires an argument -- O\n', exitCode: 2 };
        index += 1;
      } else if (arg.startsWith('--output-document=')) outputDocument = arg.slice('--output-document='.length);
      else if (arg.startsWith('-O') && arg.length > 2) outputDocument = arg.slice(2);
      else if (arg === '-T' || arg === '--timeout') {
        const timeout = args[index + 1];
        if (timeout === undefined) return { stdout: '', stderr: 'wget: option requires an argument -- T\n', exitCode: 2 };
        curlArgs.push('--max-time', timeout);
        index += 1;
      } else if (arg.startsWith('--timeout=')) curlArgs.push('--max-time', arg.slice('--timeout='.length));
      else if (arg === '--header') {
        const header = args[index + 1];
        if (header === undefined) return { stdout: '', stderr: 'wget: option requires an argument -- header\n', exitCode: 2 };
        curlArgs.push('--header', header);
        index += 1;
      } else if (arg.startsWith('--header=')) curlArgs.push('--header', arg.slice('--header='.length));
      else if (arg === '--post-data') {
        const data = args[index + 1];
        if (data === undefined) return { stdout: '', stderr: 'wget: option requires an argument -- post-data\n', exitCode: 2 };
        curlArgs.push('--data', data);
        index += 1;
      } else if (arg.startsWith('--post-data=')) curlArgs.push('--data', arg.slice('--post-data='.length));
      else if (arg === '--') {
        if (args[index + 1] !== undefined) url = args[++index];
      } else if (arg === '-qO-' || arg === '-O-') {
        quiet ||= arg.startsWith('-q');
        outputDocument = '-';
      } else if (arg.startsWith('-')) {
        return { stdout: '', stderr: `wget: unrecognized option '${arg}'\n`, exitCode: 2 };
      } else if (!url) url = arg;
      else return { stdout: '', stderr: `wget: multiple URLs are not supported in one invocation\n`, exitCode: 2 };
    }
    if (!url) return { stdout: '', stderr: 'wget: missing URL\n', exitCode: 1 };
    if (quiet) curlArgs.push('--silent');
    if (spider) {
      curlArgs.push('--head', '--fail');
      outputDocument = '-';
    }
    if (outputDocument === undefined) {
      try {
        const parsed = new URL(url);
        outputDocument = parsed.pathname.split('/').filter(Boolean).pop() || 'index.html';
      } catch {
        return { stdout: '', stderr: `wget: invalid URL '${url}'\n`, exitCode: 1 };
      }
    }
    if (outputDocument !== '-') curlArgs.push('--output', outputDocument);
    curlArgs.push(url);
    if (!ctx.exec) return { stdout: '', stderr: 'wget: HTTP transport is unavailable\n', exitCode: 1 };
    return ctx.exec('curl', {
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      replaceEnv: true,
      stdin: decodeCommandStdin(ctx.stdin),
      stdinKind: 'bytes',
      signal: ctx.signal,
      args: curlArgs,
    });
  }

  private async runKernelMktemp(args: readonly string[], ctx: CommandContext): Promise<RuntimeCommandResult> {
    let directory = false;
    let dryRun = false;
    let quiet = false;
    let parent = ctx.env.get('TMPDIR') || '/tmp';
    let suffix = '';
    let template: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '-d' || arg === '--directory') directory = true;
      else if (arg === '-u' || arg === '--dry-run') dryRun = true;
      else if (arg === '-q' || arg === '--quiet') quiet = true;
      else if (arg === '-t') continue;
      else if (arg === '-p' || arg === '--tmpdir') {
        const value = args[index + 1];
        if (!value) return { stdout: '', stderr: 'mktemp: option requires an argument\n', exitCode: 1 };
        parent = value;
        index += 1;
      } else if (arg.startsWith('--tmpdir=')) parent = arg.slice('--tmpdir='.length) || parent;
      else if (arg.startsWith('--suffix=')) suffix = arg.slice('--suffix='.length);
      else if (arg.startsWith('-')) return { stdout: '', stderr: `mktemp: invalid option -- '${arg}'\n`, exitCode: 1 };
      else if (template === undefined) template = arg;
      else return { stdout: '', stderr: `mktemp: extra operand '${arg}'\n`, exitCode: 1 };
    }
    const rawTemplate = template ?? 'tmp.XXXXXXXXXX';
    const slashIndex = rawTemplate.lastIndexOf('/');
    if (slashIndex >= 0) {
      parent = rawTemplate.slice(0, slashIndex) || '/';
      template = rawTemplate.slice(slashIndex + 1);
    } else {
      template = rawTemplate;
    }
    const match = template.match(/X{3,}(?!.*X)/);
    if (!match || match.index === undefined) {
      return { stdout: '', stderr: `mktemp: too few X's in template '${rawTemplate}'\n`, exitCode: 1 };
    }
    const normalizedParent = parent.startsWith('/')
      ? normalizeWorkspaceCwd(parent)
      : normalizeWorkspaceCwd(`${ctx.cwd}/${parent}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const token = (this.nextTemporaryEntry++).toString(36).padStart(match[0].length, '0').slice(-match[0].length);
      const name = `${template.slice(0, match.index)}${token}${template.slice(match.index + match[0].length)}${suffix}`;
      const path = normalizeWorkspaceCwd(`${normalizedParent}/${name}`);
      if (await ctx.fs.exists(path)) continue;
      if (!dryRun) {
        try {
          if (directory) await ctx.fs.mkdir(path);
          else await ctx.fs.writeFile(path, '');
        } catch (error) {
          if (quiet) return { stdout: '', stderr: '', exitCode: 1 };
          return { stdout: '', stderr: `mktemp: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
        }
      }
      return { stdout: `${path}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: quiet ? '' : 'mktemp: failed to create a unique temporary entry\n', exitCode: 1 };
  }

  async ensureReady(): Promise<void> {
    this.assertNotDestroyed();
    const systemDirectories = [
      '/home',
      this.kernelInfo.home,
      '/tmp',
      '/var',
      '/var/tmp',
      this.cwd,
    ];
    await this.fs.withBaseMutation(systemDirectories, async (fs) => {
      for (const path of systemDirectories) await fs.mkdir(path, { recursive: true });
      await fs.chmod('/tmp', 0o1777);
      await fs.chmod('/var/tmp', 0o1777);
    }, 'directory-create');
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

  private transitionExpiredIfDue(nowMs: number): boolean {
    const session = this.projectSession;
    if (!session) return false;
    const lifecycle = session.lifecycle;
    if (!lifecycle?.expiresAt) return false;
    if (lifecycle.expiredAt) return true;
    const expiresTime = new Date(lifecycle.expiresAt).getTime();
    if (Number.isNaN(nowMs) || Number.isNaN(expiresTime) || nowMs < expiresTime) return false;
    lifecycle.expiredAt = new Date(nowMs).toISOString();
    this.emitRuntimeEvent({
      type: 'lifecycle',
      phase: 'session-expired',
      message: 'Project session expired',
      detail: {
        sessionId: session.id,
        expiresAt: lifecycle.expiresAt,
        expiredAt: lifecycle.expiredAt,
        expirationBehavior: lifecycle.expirationBehavior,
      },
      actor: SYSTEM_ACTOR,
    });
    return true;
  }

  private scheduleDestroyAfterExpiration(): void {
    if (this.expirationDestroyScheduled) return;
    this.expirationDestroyScheduled = true;
    queueMicrotask(() => {
      void this.destroy({ reason: 'expired', clearStorage: true }).catch(() => undefined);
    });
  }

  private expiredCommandResult(command: string): RuntimeCommandResult {
    return { stdout: '', stderr: `project session expired; command not run: ${command}\n`, exitCode: 1 };
  }

  private assertNotDestroyed(): void {
    if (!this.destroyed) return;
    throw Object.assign(new Error('EINVAL: project session is no longer available'), { code: 'EINVAL' });
  }

  private assertWorkspaceUsableForMutation(operation: string): void {
    this.assertNotDestroyed();
    if (this.isReadonlyPolicySuspended()) return;
    const lifecycle = this.projectSession?.lifecycle;
    if (lifecycle?.expiresAt && !lifecycle.expiredAt) {
      this.transitionExpiredIfDue(Date.now());
    }
    if (!this.isSessionExpired()) return;
    const expirationBehavior = this.projectSession?.lifecycle.expirationBehavior;
    if (expirationBehavior === 'none') return;
    if (expirationBehavior === 'destroy') {
      this.scheduleDestroyAfterExpiration();
    } else if (expirationBehavior !== 'readonly') {
      return;
    }
    throw Object.assign(
      new Error(`EROFS: project session expired, ${operation} '${this.cwd}'`),
      { code: 'EROFS' }
    );
  }

  private assertDynamicVirtualWritable(path: string, operation: string): void {
    if (!isTraceKernelVirtualNamespacePath(path) && !isRuntimeSkillsNamespacePath(path)) return;
    throw Object.assign(
      new Error(`EROFS: read-only file system, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  private assertWorkspaceUsableForRun(command: string): RuntimeCommandResult | null {
    if (this.destroyed) {
      return { stdout: '', stderr: 'project session is no longer available\n', exitCode: 1 };
    }
    const lifecycle = this.projectSession?.lifecycle;
    if (lifecycle?.expiresAt && !lifecycle.expiredAt) {
      this.transitionExpiredIfDue(Date.now());
    }
    if (this.isSessionExpired()) {
      if (this.projectSession?.lifecycle.expirationBehavior === 'readonly') {
        return this.expiredCommandResult(command);
      }
      if (this.projectSession?.lifecycle.expirationBehavior === 'destroy') {
        this.scheduleDestroyAfterExpiration();
        return this.expiredCommandResult(command);
      }
    }
    return null;
  }

  private isWorkspacePathReadOnly(absolutePath: string): boolean {
    if (!isWithinWorkspace(this.cwd, absolutePath) || absolutePath === this.cwd) return false;
    const relativePath = toProjectPath(this.cwd, absolutePath);
    return [...this.readonlyFiles].some((path) => path === relativePath || relativePath.startsWith(`${path}/`));
  }

  private isProjectPathHidden(path: string): boolean {
    const normalized = normalizeRuntimeProjectPath(path);
    return (this.projectSession?.hiddenFiles ?? []).some((hiddenPath) => {
      if (hiddenPath === normalized || hiddenPath.startsWith(`${normalized}/`)) return true;
      const separatorIndex = hiddenPath.lastIndexOf('/');
      if (separatorIndex <= 0) return false;
      const hiddenDirectory = hiddenPath.slice(0, separatorIndex);
      return normalized === hiddenDirectory || normalized.startsWith(`${hiddenDirectory}/`);
    });
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

  private isPathOutsideWritableMounts(absolutePath: string): boolean {
    return !isWithinWorkspace(this.cwd, absolutePath) &&
      !isWithinWorkspace('/tmp', absolutePath) &&
      !isWithinWorkspace('/var/tmp', absolutePath);
  }

  private assertWorkspacePathWritable(absolutePath: string, operation: string): void {
    this.assertWorkspaceUsableForMutation(operation);
    if (this.isPathOutsideWritableMounts(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: read-only file system, ${operation} '${absolutePath}'`),
        { code: 'EROFS' }
      );
    }
    if (!this.isReadonlyPolicySuspended() && this.isWorkspacePathHidden(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: hidden project path is read-only, ${operation} '${toProjectPath(this.cwd, absolutePath)}'`),
        { code: 'EROFS' }
      );
    }
    if (this.isReadonlyPolicySuspended() || !this.isWorkspacePathReadOnly(absolutePath)) return;
    throw createRuntimeKernelReadonlyFileError(toProjectPath(this.cwd, absolutePath), operation);
  }

  private assertWorkspaceSubtreeWritable(absolutePath: string, operation: string): void {
    this.assertWorkspaceUsableForMutation(operation);
    if (this.isPathOutsideWritableMounts(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: read-only file system, ${operation} '${absolutePath}'`),
        { code: 'EROFS' }
      );
    }
    if (!this.isReadonlyPolicySuspended() && this.isWorkspacePathHidden(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: hidden project subtree is read-only, ${operation} '${toProjectDirectoryPath(this.cwd, absolutePath)}'`),
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
    const absolutePath = isWithinWorkspace(this.kernelInfo.home, this.cwd)
      ? this.resolveTerminalNavigationPath(currentCwd, target)
      : this.resolveTerminalPath(currentCwd, target);
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

  private readDevice(device: RuntimeKernelDevicePath, context?: RuntimeCommandExecutionContext): string {
    if (!runtimeKernelDeviceInputRoute(undefined, device)) return '';
    const stdinPipe = context?.stdinPipe;
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

  private writeDevice(
    device: RuntimeKernelDevicePath,
    data: string,
    contextOrActor?: RuntimeCommandExecutionContext | RuntimeWorkspaceActor
  ): void {
    const route = runtimeKernelDeviceOutputRoute(undefined, device);
    if (!route) {
      if (runtimeDeviceOutputTarget(device) === '/dev/null') return;
      throw new Error(`Kernel device is read-only: ${device}`);
    }
    const commandContext = contextOrActor && 'process' in contextOrActor
      ? contextOrActor
      : undefined;
    const actor = contextOrActor && 'kind' in contextOrActor
      ? contextOrActor
      : undefined;
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
    }, commandContext);
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
    const marker = `\n[${stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
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
    phase: RuntimeFileMutationPhase = 'live',
    process?: RuntimeKernelProcessRecord
  ): Promise<void> {
    this.assertActorFileCapability(actor, 'write', path);
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
    }, undefined, process);
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
    actor: RuntimeWorkspaceActor = SYSTEM_ACTOR
  ): Promise<void> {
    this.assertNotDestroyed();
    const nextFiles = new Map(this.skillFiles);
    for (const file of files) {
      const normalized = this.normalizeSkillFile(file);
      this.assertActorFileCapability(actor, 'write', runtimeSkillAbsolutePath(normalized.path));
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
    this.snapshotCache = null;
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
      this.assertWorkspacePathWritable(absolutePath, 'mkdir');
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
      await fs.mv(absoluteSourcePath, absoluteDestinationPath);
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
    return this.runCommandAs(command, options);
  }

  private async runCommandAs(
    command: string,
    options: RuntimeCommandOptions = {},
    parent?: RuntimeKernelProcessRecord,
    launchHooks?: RuntimeKernelProcessLaunchHooks
  ): Promise<RuntimeCommandResult> {
    const unusable = this.assertWorkspaceUsableForRun(command);
    if (unusable) return unusable;
    const inProcessWait = this.tryRunInProcessWaitCommand(command, parent);
    if (inProcessWait) return inProcessWait;
    const actor = parent?.actor ?? this.createRuntimeActor();
    const admissionError = this.processAdmissionError(command);
    if (admissionError) {
      this.recordProcessAdmissionRejection(command, admissionError, actor);
      return {
        stdout: '',
        stderr: 'bash: fork: Resource temporarily unavailable\n',
        exitCode: admissionError.errno,
        error: admissionError.toCommandError(),
      };
    }
    const commandCwd = options.cwd ? this.resolveCommandCwd(options.cwd) : this.cwd;
    const stdinPipe = options.stdinPipe;
    const abortController = new AbortController();
    const pid = this.nextPid++;
    const terminalPresentation = options.presentation === 'terminal';
    const foreground = options.foreground ?? terminalPresentation;
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: parent?.pid ?? 1,
      pgid: pid,
      sid: 1,
      fds: this.standardProcessFileDescriptors(),
      tty: terminalPresentation ? '/dev/tty' : '?',
      command,
      cwd: commandCwd,
      env: Object.freeze({
        ...(parent?.env ?? this.baseEnv),
        ...(options.env ?? {}),
      }),
      actor,
      signalPolicy: 'standard',
      startedAt: new Date().toISOString(),
      abortController,
      state: 'queued',
      foreground,
    };
    let commandContext!: RuntimeCommandExecutionContext;
    commandContext = {
      eventHandler: this.createCommandEventHandler(options),
      actor,
      process,
      stdinPipe,
      terminal: options.terminal,
      umask: Number.isInteger(options.umask) && options.umask !== undefined && options.umask >= 0 && options.umask <= 0o777
        ? options.umask
        : 0o022,
      onUmaskChange: options.onUmaskChange,
      includeHiddenFiles: options.includeHiddenFiles,
      runtimeIo: this.createRuntimeLiveIoController(actor, abortController.signal, () => commandContext),
      generationBaseline: this.fs.snapshotGenerations(),
      mutatedGenerationPaths: new Set(),
      executableTransformCwd: commandCwd,
      deviceStdout: '',
      deviceStderr: '',
      outputBytes: { stdout: 0, stderr: 0 },
      truncatedOutputStreams: new Set(),
      externalHttpRequestCount: 0,
    };
    const commandFs = new CommandBoundFileSystem(this.fs, commandContext);
    registerCommandContext(commandFs, commandContext);
    this.processTable.set(process.pid, process);
    try {
      await launchHooks?.initialize?.(process, commandContext);
      launchHooks?.ready?.(process);
    } catch (error) {
      this.processTable.delete(process.pid);
      await this.kernelDescriptors.closeProcess(process.pid);
      process.state = 'exited';
      process.exitCode = 126;
      process.endedAt = new Date().toISOString();
      throw error;
    }
    this.recordKernelEvent('process-queue', process.pid, {
      ppid: process.ppid,
      pgid: process.pgid,
      sid: process.sid,
      command,
      cwd: commandCwd,
    });
    const cleanupExternalSignal = this.attachExternalSignal(process, options.signal);
    let processExitCode = 1;
    return this.commandScheduler.runCommand({ pid: process.pid, command, signal: abortController.signal }, async () => {
      try {
        if (process.signal) {
          const result = this.signalCommandResult(process);
          const output = this.captureReturnedOutput(commandContext, result);
          processExitCode = result.exitCode;
          this.emitReturnedOutputEvents(output, commandContext);
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
        this.recordJournal({
          kind: 'process',
          op: 'exec',
          pid: process.pid,
          ppid: process.ppid,
          argv: command,
          cwd: commandCwd,
          actor: this.journalActorId(process.actor),
        }, commandContext, process.actor);
        const directExecutableResult = await this.tryRunVirtualExecutable(command, { ...options, stdinPipe, signal: abortController.signal }, commandContext, commandFs);
        if (directExecutableResult) {
          await this.flushRuntimeEventQueue(commandContext);
          const output = this.captureReturnedOutput(commandContext, directExecutableResult);
          this.emitReturnedOutputEvents(output, commandContext);
          if (commandContext.handledSignal && process.signal === commandContext.handledSignal) {
            delete process.signal;
            delete process.signalCode;
            process.state = 'running';
            this.recordKernelEvent('process-signal-handled', process.pid, {
              signal: commandContext.handledSignal,
            });
          }
          if (process.signal) {
            const signalResult = this.signalCommandResult(process);
            processExitCode = signalResult.exitCode;
            return {
              ...signalResult,
              ...output,
            };
          }
          processExitCode = directExecutableResult.exitCode;
          return {
            ...directExecutableResult,
            ...output,
          };
        }

        const bash = this.createBash(options.executionLimits, commandContext, commandFs);
        const commandEnv = { ...process.env };
        const baselineEnv = options.onEnvChanges ? { ...bash.getEnv(), ...commandEnv } : undefined;
        // Closed stdin pipes represent complete input supplied with a command
        // (for example a captured file, fixture, or non-interactive API call).
        // Feed that input into just-bash so every command in the shell program
        // sees normal shell stdin. Keep open pipes on the command context for
        // live terminal/runtime input, where bytes can arrive after execution
        // has started.
        const shellStdin = stdinPipe && runtimeCommandStdinPipeClosed(stdinPipe)
          ? new TextDecoder().decode(peekRuntimeCommandStdinPipeBytes(stdinPipe))
          : undefined;
        const result = await bash.exec(command, {
          cwd: commandCwd,
          env: commandEnv,
          signal: abortController.signal,
          args: options.args,
          ...(shellStdin !== undefined ? { stdin: shellStdin } : {}),
        });
        if (baselineEnv && options.onEnvChanges) {
          options.onEnvChanges(runtimeCommandEnvChanges(baselineEnv, result.env));
        }
        await this.flushRuntimeEventQueue(commandContext);
        const output = this.captureReturnedOutput(commandContext, result);
        this.emitReturnedOutputEvents(output, commandContext);
        processExitCode = result.exitCode;
        if (commandContext.handledSignal && process.signal === commandContext.handledSignal) {
          delete process.signal;
          delete process.signalCode;
          process.state = 'running';
          this.recordKernelEvent('process-signal-handled', process.pid, {
            signal: commandContext.handledSignal,
          });
        }
        const commandError = commandContext.kernelError ?? (result as RuntimeCommandResult).error;
        if (commandError?.code === 'EINTR') {
          const interruptedBy = commandError.detail?.signal;
          const interruptedSignal = typeof interruptedBy === 'string'
            ? normalizeTraceKernelSignal(interruptedBy)
            : null;
          if (!process.signal && interruptedSignal) {
            process.signal = interruptedSignal.name;
            process.signalCode = interruptedSignal.code;
          }
          if (process.signal) {
            const signalResult = this.signalCommandResult(process);
            processExitCode = signalResult.exitCode;
            return signalResult;
          }
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
          await this.flushRuntimeEventQueue(commandContext);
          this.emitReturnedOutputEvents(output, commandContext);
          return { ...result, ...output };
        }
        if (
          isKernelReadonlyError(error) ||
          isKernelVirtualFilesystemError(error) ||
          isRuntimeFileGenerationConflict(error) ||
          isRuntimeWorkspaceStorageLimitError(error)
        ) {
          this.recordKernelCommandError(error);
          const result = kernelCommandFailure(error);
          const output = this.captureReturnedOutput(commandContext, result);
          processExitCode = result.exitCode;
          await this.flushRuntimeEventQueue(commandContext);
          this.emitReturnedOutputEvents(output, commandContext);
          return { ...result, ...output };
        }
        throw error;
      }
    }).catch((error) => {
      if (process.signal) {
        const result = this.signalCommandResult(process);
        const output = this.captureReturnedOutput(commandContext, result);
        processExitCode = result.exitCode;
        this.emitReturnedOutputEvents(output, commandContext);
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
    }).then((result) => {
      // A runtime can resolve concurrently with host-side signal delivery.
      // Arbitrate termination once more at the scheduler boundary so the
      // kernel's unhandled signal owns the exit status, regardless of which
      // promise continuation won inside the runner.
      if (!process.signal) return result;
      const signalResult = this.signalCommandResult(process);
      processExitCode = signalResult.exitCode;
      return {
        ...result,
        ...signalResult,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }).finally(async () => {
      this.clearRuntimeProcessWatchdog(process.pid);
      this.closeHttpListenersForProcess(process.pid);
      try {
        await launchHooks?.beforeDescriptorClose?.(process, commandContext);
      } finally {
        await this.kernelDescriptors.closeProcess(process.pid);
      }
      await launchHooks?.afterDescriptorClose?.(process, commandContext);
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
        this.recordJournal({
          kind: 'process',
          op: 'exit',
          pid: process.pid,
          exitCode: process.exitCode,
          actor: this.journalActorId(process.actor),
        }, commandContext, process.actor);
        this.notifyZombieProcess(process);
      } else {
        this.recordKernelEvent('process-exit', process.pid, { exitCode: process.exitCode });
        this.recordJournal({
          kind: 'process',
          op: 'exit',
          pid: process.pid,
          exitCode: process.exitCode,
          actor: this.journalActorId(process.actor),
        }, commandContext, process.actor);
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
    stepCount: number,
    remaining?: {
      timeoutMs?: number;
      maxOutputBytes?: number;
    }
  ): RuntimeCommandExecutionLimits | undefined {
    if (!limits) return limits;
    const maxCommandCount = this.finiteMaxCommandCount(limits);
    const timeoutMs = remaining?.timeoutMs !== undefined
      ? remaining.timeoutMs
      : Number.isFinite(limits.timeoutMs)
        ? Math.max(1, Math.floor(Number(limits.timeoutMs)))
        : undefined;
    const maxOutputBytes = remaining?.maxOutputBytes !== undefined
      ? remaining.maxOutputBytes
      : Number.isFinite(limits.maxOutputBytes)
        ? Math.max(1, Math.floor(Number(limits.maxOutputBytes)))
        : undefined;
    if (maxCommandCount === undefined && timeoutMs === undefined && maxOutputBytes === undefined) return limits;
    return {
      ...limits,
      ...(maxCommandCount !== undefined ? { maxCommandCount: Math.max(1, Math.floor(maxCommandCount / stepCount)) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs: Math.max(1, Math.floor(timeoutMs)) } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes: Math.max(1, Math.floor(maxOutputBytes)) } : {}),
    };
  }

  private finiteProjectCommandTimeoutMs(limits: RuntimeCommandExecutionLimits | undefined): number | undefined {
    return Number.isFinite(limits?.timeoutMs)
      ? Math.max(1, Math.floor(Number(limits?.timeoutMs)))
      : undefined;
  }

  private finiteProjectCommandMaxOutputBytes(limits: RuntimeCommandExecutionLimits | undefined): number | undefined {
    return Number.isFinite(limits?.maxOutputBytes)
      ? Math.max(1, Math.floor(Number(limits?.maxOutputBytes)))
      : undefined;
  }

  private projectCommandLimitResult(
    stdout: string,
    stderr: string,
    code: 'ETIMEDOUT' | 'EMSGSIZE',
    message: string,
    exitCode: number
  ): RuntimeCommandResult {
    return {
      stdout,
      stderr,
      exitCode,
      error: {
        code,
        message,
      },
    };
  }

  async runProjectCommand(name: string, options: RuntimeProjectCommandOptions = {}): Promise<RuntimeCommandResult> {
    return this.runProjectCommandAs(name, options);
  }

  private async runProjectCommandAs(
    name: string,
    options: RuntimeProjectCommandOptions = {},
    parent?: RuntimeKernelProcessRecord
  ): Promise<RuntimeCommandResult> {
    const unusable = this.assertWorkspaceUsableForRun(name);
    if (unusable) return unusable;
    const command = this.projectSessionCommands?.[name];
    if (!command) {
      return {
        stdout: '',
        stderr: `Project command not found: ${name}\n`,
        exitCode: 127,
      };
    }
    if (
      command.hidden === true &&
      (
        !this.hiddenCommandAccess ||
        options.hiddenCommandAccess !== this.hiddenCommandAccess ||
        !isRuntimeProjectHiddenCommandAccess(options.hiddenCommandAccess)
      )
    ) {
      return {
        stdout: '',
        stderr: `Project command is hidden: ${name}\n`,
        exitCode: 126,
      };
    }
    const runStep = (
      step: RuntimeProjectSessionCommandStep,
      executionLimits?: RuntimeCommandExecutionLimits
    ): Promise<RuntimeCommandResult> => {
      const commandCwd = options.cwd ?? step.cwd;
      return this.runCommandAs(step.command, {
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
      }, parent);
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
    const aggregateTimeoutMs = this.finiteProjectCommandTimeoutMs(commandLimits);
    const aggregateTimeoutDeadlineMs = aggregateTimeoutMs === undefined ? undefined : Date.now() + aggregateTimeoutMs;
    const aggregateOutputLimitBytes = this.finiteProjectCommandMaxOutputBytes(commandLimits);
    const files: RuntimeFileChange[] = [];
    const outputBytes: Record<RuntimeCommandEventStream, number> = { stdout: 0, stderr: 0 };
    const truncatedOutputStreams = new Set<RuntimeCommandEventStream>();
    let aggregateOutputBytes = 0;
    let aggregateOutputExceeded = false;
    const appendOutput = (stream: RuntimeCommandEventStream, current: string, data: string): string => {
      if (!data || truncatedOutputStreams.has(stream) || aggregateOutputExceeded) return current;
      const used = outputBytes[stream];
      const streamRemaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
      const aggregateRemaining = aggregateOutputLimitBytes === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, aggregateOutputLimitBytes - aggregateOutputBytes);
      const remaining = Math.min(streamRemaining, aggregateRemaining);
      const bytes = runtimeProjectUtf8Bytes(data);
      if (bytes <= remaining) {
        outputBytes[stream] = used + bytes;
        aggregateOutputBytes += bytes;
        return `${current}${data}`;
      }
      const truncated = runtimeProjectTruncateUtf8(data, Math.max(0, remaining));
      const truncatedBytes = runtimeProjectUtf8Bytes(truncated);
      outputBytes[stream] = used + truncatedBytes;
      aggregateOutputBytes += truncatedBytes;
      if (aggregateRemaining <= streamRemaining) {
        aggregateOutputExceeded = true;
        const marker = `\n[command output truncated after ${aggregateOutputLimitBytes} bytes]\n`;
        outputBytes[stream] += runtimeProjectUtf8Bytes(marker);
        aggregateOutputBytes += runtimeProjectUtf8Bytes(marker);
        return `${current}${truncated}${marker}`;
      }
      truncatedOutputStreams.add(stream);
      const marker = `\n[${stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
      outputBytes[stream] = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + runtimeProjectUtf8Bytes(marker);
      aggregateOutputBytes += runtimeProjectUtf8Bytes(marker);
      return `${current}${truncated}${marker}`;
    };
    let stdout = '';
    let stderr = '';
    for (const [stepIndex, step] of command.steps.entries()) {
      const remainingTimeoutMs = aggregateTimeoutDeadlineMs === undefined
        ? undefined
        : aggregateTimeoutDeadlineMs - Date.now();
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        const message = `ETIMEDOUT: Project command "${name}" timed out after ${aggregateTimeoutMs} milliseconds`;
        stderr = appendOutput('stderr', stderr, `${message}\n`);
        return this.projectCommandLimitResult(stdout, stderr, 'ETIMEDOUT', message, 124);
      }
      const remainingOutputBytes = aggregateOutputLimitBytes === undefined
        ? undefined
        : aggregateOutputLimitBytes - aggregateOutputBytes;
      if (remainingOutputBytes !== undefined && remainingOutputBytes <= 0) {
        const message = `EMSGSIZE: Project command "${name}" output exceeded ${aggregateOutputLimitBytes} bytes`;
        stderr = appendOutput('stderr', stderr, `${message}\n`);
        return this.projectCommandLimitResult(stdout, stderr, 'EMSGSIZE', message, 1);
      }
      const stepExecutionLimits = this.projectCommandStepExecutionLimits(commandLimits, command.steps.length, {
        ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
        ...(remainingOutputBytes !== undefined ? { maxOutputBytes: remainingOutputBytes } : {}),
      });
      const commandCwd = options.cwd ?? step.cwd;
      this.emitCommandOptionEvent(options, {
        type: 'status',
        phase: 'project-step-start',
        message: `Starting project command step ${stepIndex + 1}/${command.steps.length}`,
        detail: {
          command: name,
          step: stepIndex + 1,
          stepCount: command.steps.length,
          shellCommand: step.command,
          ...(commandCwd ? { cwd: this.resolveTerminalPath(this.cwd, commandCwd) } : {}),
        },
        actor: SYSTEM_ACTOR,
      });
      const result = await runStep(step, stepExecutionLimits);
      stdout = appendOutput('stdout', stdout, result.stdout);
      stderr = appendOutput('stderr', stderr, result.stderr);
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
      if (aggregateOutputExceeded) {
        const message = `EMSGSIZE: Project command "${name}" output exceeded ${aggregateOutputLimitBytes} bytes`;
        return this.projectCommandLimitResult(stdout, stderr, 'EMSGSIZE', message, 1);
      }
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
    return this.createTerminalSessionAs(options);
  }

  private createTerminalSessionAs(
    options: RuntimeProjectTerminalSessionOptions = {},
    parent?: RuntimeKernelProcessRecord
  ): RuntimeProjectTerminalSession {
    this.assertNotDestroyed();
    return new RuntimeProjectWorkspaceTerminalSession(
      {
        workspaceRoot: this.cwd,
        kernelInfo: this.kernelInfo,
        resolveCwd: (currentCwd, target) => this.resolveTerminalCwd(currentCwd, target),
        runCommand: (command, commandOptions) => this.runCommandAs(command, commandOptions, parent),
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
    const wasExpired = Boolean(this.projectSession.lifecycle.expiredAt);
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const expired = this.transitionExpiredIfDue(nowTime);
    if (expired && !wasExpired && this.projectSession.lifecycle.expirationBehavior === 'destroy') {
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
    this.closeAllHttpListeners();
    if (!this.httpLifecycleAbortController.signal.aborted) this.httpLifecycleAbortController.abort();
    this.kernelSyscallGenerationUnsubscribe?.();
    this.kernelSyscallGenerationUnsubscribe = undefined;
    await this.kernelDescriptors.dispose();
    await this.kernelNetwork.dispose();
    this.clearAllRuntimeProcessWatchdogs();
    this.processTable.clear();
    this.zombieProcessTable.clear();
    this.processWaiters.clear();
    this.anyProcessWaiters.splice(0);
    this.runtimeChildWaits.clear();
    this.recordKernelEvent('kernel-destroy', 1, { reason: options.reason ?? 'destroy', clearStorage: options.clearStorage === true });
    this.destroyed = true;
  }

  private async tryRunVirtualExecutable(
    command: string,
    options: RuntimeCommandOptions,
    commandContext: RuntimeCommandExecutionContext,
    commandFs: IFileSystem
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
      fs: commandFs,
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
      commandContext,
    });
  }

  private async executeVirtualExecutable(request: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdinPipe?: RuntimeCommandOptions['stdinPipe'];
    commandContext: RuntimeCommandExecutionContext;
  }): Promise<RuntimeCommandResult | null> {
    const executablePath = toProjectPath(this.cwd, resolveWorkspaceCommandPath(this.cwd, request.cwd, request.executable, this.kernelInfo.workspaceAlias));
    const record = this.virtualExecutableRecords.get(executablePath);
    if (!record) return null;

    if (record.kind !== 'cpp' || !this.cppRunner) {
      return { stdout: '', stderr: `bash: ${request.executable}: Exec format error\n`, exitCode: 126 };
    }

    const scriptPath = request.executable.startsWith('./')
      ? request.executable.slice(2)
      : request.executable;
    const kernelSyscalls = this.createKernelSyscallBridge(request.commandContext);
    const signal = request.commandContext.process.abortController?.signal;
    let result: RuntimeCommandResult;
    try {
      result = await this.cppRunner({
        code: '',
        source: 'run',
        scriptPath,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        process: {
          pid: request.commandContext.process.pid,
          ppid: request.commandContext.process.ppid,
          pgid: request.commandContext.process.pgid,
          sid: request.commandContext.process.sid,
        },
        ...(request.stdinPipe ? { stdinPipe: { buffer: request.stdinPipe.buffer } } : {}),
        ...(request.commandContext.terminal
          ? { terminal: request.commandContext.terminal }
          : {}),
        signal,
        project: await this.snapshotForCommand(request.commandContext.includeHiddenFiles === true),
        kernelHttp: this.createKernelHttpBridge(request.commandContext),
        ...(kernelSyscalls ? { kernelSyscalls } : {}),
        onEvent: (event) => {
          this.handleRuntimeCommandEvent(event, request.commandContext);
        },
      });
    } finally {
      kernelSyscalls?.close();
    }
    if (result.handledSignal) {
      request.commandContext.handledSignal = result.handledSignal;
    }
    if (result.error && !request.commandContext.kernelError) {
      request.commandContext.kernelError = result.error;
    }
    await this.flushRuntimeEventQueue(request.commandContext);
    return applyWorkspaceCommandResultFiles(
      this,
      request.commandContext.runtimeIo.filterAppliedResultFiles(result) ?? result
    );
  }

  async snapshot(options: { entrypoint?: string; includeHidden?: boolean } = {}): Promise<RuntimeProjectSnapshot> {
    this.assertNotDestroyed();
    return this.snapshotFromCachedFiles(options);
  }

  private async snapshotForCommand(includeHidden: boolean): Promise<RuntimeProjectSnapshot> {
    this.assertNotDestroyed();
    return this.snapshotFromCachedFiles({ includeHidden });
  }

  private async snapshotFromCachedFiles(options: { entrypoint?: string; includeHidden?: boolean } = {}): Promise<RuntimeProjectSnapshot> {
    const cached = await this.collectWorkspaceFilesCached();
    const storage = await this.fs.storageUsage();
    const files = [...cached.files];
    const directories = [...cached.directories];
    const directoryMetadata = [...cached.directoryMetadata];
    const symlinks = [...cached.symlinks];
    const kernelFiles = [...cached.kernelFiles];
    const publicKernel = publicRuntimeKernelInfo(this.kernelInfo);
    const snapshot: RuntimeProjectSnapshot = {
      cwd: this.cwd,
      workspaceRoot: this.cwd,
      ...(this.kernelInfo.workspaceAlias ? { workspaceAlias: this.kernelInfo.workspaceAlias } : {}),
      kernel: publicKernel,
      kernelDevices: runtimeKernelVirtualDevices(),
      kernelFiles,
      storage,
      files,
      ...(symlinks.length > 0 ? { symlinks } : {}),
      ...(directories.length > 0 ? { directories } : {}),
      ...(directoryMetadata.length > 0 ? { directoryMetadata } : {}),
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
      const currentSymlink = current.symlinks.get(baseFile.path);
      if (currentSymlink) {
        changes.push({ kind: 'symlink', path: currentSymlink.path, target: currentSymlink.target, baseHash: baseFile.hash });
      } else if (!currentFile) {
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
      if (!base.files.has(currentFile.path) && !base.symlinks.has(currentFile.path)) {
        changes.push({
          kind: 'write',
          path: currentFile.path,
          contents: currentFile.contents,
          ...(currentFile.encoding === 'base64' ? { encoding: currentFile.encoding } : {}),
          baseHash: null,
        });
      }
    }

    for (const baseSymlink of [...base.symlinks.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const currentSymlink = current.symlinks.get(baseSymlink.path);
      const currentFile = current.files.get(baseSymlink.path);
      if (currentFile) {
        changes.push({
          kind: 'write',
          path: currentFile.path,
          contents: currentFile.contents,
          ...(currentFile.encoding === 'base64' ? { encoding: currentFile.encoding } : {}),
          baseHash: baseSymlink.hash,
        });
      } else if (!currentSymlink) {
        changes.push({ kind: 'delete', path: baseSymlink.path, baseHash: baseSymlink.hash });
      } else if (currentSymlink.hash !== baseSymlink.hash) {
        changes.push({ kind: 'symlink', path: currentSymlink.path, target: currentSymlink.target, baseHash: baseSymlink.hash });
      }
    }

    for (const currentSymlink of [...current.symlinks.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (!base.files.has(currentSymlink.path) && !base.symlinks.has(currentSymlink.path)) {
        changes.push({ kind: 'symlink', path: currentSymlink.path, target: currentSymlink.target, baseHash: null });
      }
    }

    for (const directory of [...base.directories.keys()].sort((left, right) => right.localeCompare(left))) {
      if (!current.directories.has(directory)) changes.push({ kind: 'rmdir', path: directory });
    }
    for (const directory of [...current.directories.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const baseDirectory = base.directories.get(directory.path);
      if (!baseDirectory) {
        changes.push({
          kind: 'mkdir',
          path: directory.path,
          ...(directory.mode !== undefined ? { mode: directory.mode } : {}),
          ...(directory.atimeMs !== undefined ? { atimeMs: directory.atimeMs } : {}),
          ...(directory.mtimeMs !== undefined ? { mtimeMs: directory.mtimeMs } : {}),
        });
      } else if (baseDirectory.hash !== directory.hash) {
        changes.push({
          kind: 'directory',
          path: directory.path,
          ...(directory.mode !== undefined ? { mode: directory.mode } : {}),
          ...(directory.atimeMs !== undefined ? { atimeMs: directory.atimeMs } : {}),
          ...(directory.mtimeMs !== undefined ? { mtimeMs: directory.mtimeMs } : {}),
          baseHash: baseDirectory.hash,
        });
      }
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

  async importPatch(
    baseSnapshot: RuntimeProjectSnapshot,
    patch: RuntimeProjectPatch,
    options: RuntimeProjectPatchOptions = {}
  ): Promise<void> {
    this.assertNotDestroyed();
    const normalizedPatch = normalizeRuntimeProjectPatch(patch);
    const metadataVersion = this.projectSession?.metadata?.version;
    const expectedIdentity = {
      id: options.base?.id ?? this.projectSession?.projectId,
      version: options.base?.version ?? (typeof metadataVersion === 'string' ? metadataVersion : undefined),
    };
    for (const field of ['id', 'version'] as const) {
      const declared = normalizedPatch.base[field];
      const expected = expectedIdentity[field];
      if (declared === undefined && expected === undefined) continue;
      if (declared !== expected) {
        throw staleRuntimeProjectPatchError(
          declared === undefined
            ? `patch base ${field} is missing; expected ${expected}`
            : expected === undefined
              ? `patch base ${field} ${declared} cannot be verified by this workspace`
              : `patch base ${field} ${declared} does not match expected ${expected}`
        );
      }
    }
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
    const actor = SYSTEM_ACTOR;
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
    if (!this.httpLifecycleAbortController.signal.aborted) this.httpLifecycleAbortController.abort();
    this.closeAllHttpListeners();
    this.eventWatchers.clear();
    this.kernelSyscallGenerationUnsubscribe?.();
    this.kernelSyscallGenerationUnsubscribe = undefined;
    this.clearAllRuntimeProcessWatchdogs();
    void Promise.all([
      this.kernelDescriptors.dispose(),
      this.kernelNetwork.dispose(),
    ]);
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
    actor: RuntimeWorkspaceActor = SYSTEM_ACTOR
  ): Promise<void> {
    await this.kernel.applyFileChange(change, actor, phase);
  }

  async applyFinalDiffResultFiles(result: RuntimeCommandResult): Promise<RuntimeCommandResult> {
    try {
      if (!result.files?.length) return result;
      const actor = SYSTEM_ACTOR;
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
      if (
        isKernelReadonlyError(error) ||
        isKernelVirtualFilesystemError(error) ||
        isRuntimeFileGenerationConflict(error) ||
        isRuntimeWorkspaceStorageLimitError(error)
      ) {
        this.recordKernelCommandError(error);
        return kernelCommandFailure(error);
      }
      throw error;
    }
  }

  private createWorkspaceProcess(options: RuntimeWorkspaceProcessOptions): RuntimeWorkspaceProcess {
    this.assertNotDestroyed();
    const name = options.name.trim();
    if (!name) throw new Error('Runtime workspace process name must not be empty.');
    const admissionError = this.processAdmissionError(name);
    if (admissionError) {
      this.recordProcessAdmissionRejection(name, admissionError, options.actor);
      throw admissionError;
    }
    const cwd = options.cwd ? this.resolveCommandCwd(options.cwd) : this.cwd;
    const pid = this.nextPid++;
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: 1,
      pgid: pid,
      sid: 1,
      fds: this.standardProcessFileDescriptors(),
      tty: '?',
      command: name,
      cwd,
      env: Object.freeze({
        ...this.baseEnv,
        ...(options.env ?? {}),
      }),
      actor: options.actor,
      signalPolicy: options.signalPolicy ?? 'standard',
      startedAt: new Date().toISOString(),
      state: 'running',
      foreground: false,
    };
    this.processTable.set(process.pid, process);
    this.recordKernelEvent('process-start', process.pid, {
      ppid: process.ppid,
      pgid: process.pgid,
      sid: process.sid,
      command: name,
      cwd,
      signalPolicy: process.signalPolicy,
    });
    this.recordJournal({
      kind: 'process',
      op: 'exec',
      pid: process.pid,
      ppid: process.ppid,
      argv: name,
      cwd,
      actor: this.journalActorId(process.actor),
    }, undefined, process.actor);
    let disposed = false;
    const assertActive = (): void => {
      if (disposed || !this.processTable.has(process.pid)) {
        throw new Error(`Runtime workspace process is no longer active: ${name} (${process.pid})`);
      }
    };
    return {
      pid: process.pid,
      name,
      actor: process.actor,
      signalPolicy: process.signalPolicy,
      readFile: (path, encoding) => {
        assertActive();
        this.assertActorFileCapability(process.actor, 'read', path);
        return this.readFile(path, encoding, { publicProc: false });
      },
      writeFile: (path, contents, encoding) => {
        assertActive();
        return this.writeFileAs(path, contents, process.actor, encoding, 'live', process);
      },
      deleteFile: (path) => {
        assertActive();
        return this.deleteFileAs(path, process.actor, 'live', process);
      },
      applyFileChange: (change, phase = 'live') => {
        assertActive();
        return withSuspendedFsNotifications(this.bash.fs, async () => {
          await this.applyFileChangeAs(change, process.actor, phase, process);
        });
      },
      runCommand: (command, commandOptions = {}) => {
        assertActive();
        return this.runCommandAs(command, {
          ...commandOptions,
          cwd: commandOptions.cwd ?? cwd,
          env: { ...(options.env ?? {}), ...(commandOptions.env ?? {}) },
        }, process);
      },
      runProjectCommand: (commandName, commandOptions = {}) => {
        assertActive();
        return this.runProjectCommandAs(commandName, {
          ...commandOptions,
          cwd: commandOptions.cwd ?? cwd,
          env: { ...(options.env ?? {}), ...(commandOptions.env ?? {}) },
        }, process);
      },
      createTerminalSession: (sessionOptions = {}) => {
        assertActive();
        return this.createTerminalSessionAs({
          ...sessionOptions,
          cwd: sessionOptions.cwd ?? cwd,
          env: { ...(options.env ?? {}), ...(sessionOptions.env ?? {}) },
        }, process);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const child of this.activeProcessRecords()) {
          if (child.ppid === process.pid) this.signalProcess(child, 'SIGTERM', 'system');
        }
        void this.kernelDescriptors.closeProcess(process.pid);
        this.processTable.delete(process.pid);
        process.state = 'exited';
        process.exitCode = 0;
        process.endedAt = new Date().toISOString();
        this.recordKernelEvent('process-exit', process.pid, { exitCode: 0, authority: 'system' });
        this.recordJournal({
          kind: 'process',
          op: 'exit',
          pid: process.pid,
          exitCode: 0,
          actor: this.journalActorId(process.actor),
        }, undefined, process.actor);
      },
    };
  }

  private createKernel(): RuntimeWorkspaceKernel {
    const workspace = this;
    return {
      info: this.kernelInfo,
      get mutationVersion() {
        return workspace.fs.mutationVersion;
      },
      readFile: (path, actor = PRINCIPAL_ACTOR, encoding) => {
        this.assertActorFileCapability(actor, 'read', path);
        return this.readFile(path, encoding, { publicProc: false });
      },
      createProcess: (options) => this.createWorkspaceProcess(options),
      writeFile: (path, contents, actor = PRINCIPAL_ACTOR, encoding) => this.writeFileAs(path, contents, actor, encoding, 'live'),
      writeSkillFiles: (files, actor = SYSTEM_ACTOR) => this.writeSkillFilesAs(files, actor),
      deleteFile: (path, actor = PRINCIPAL_ACTOR) => this.deleteFileAs(path, actor, 'live'),
      applyFileChange: async (change, actor = SYSTEM_ACTOR, phase = 'final-diff') => {
        await withSuspendedFsNotifications(this.bash.fs, async () => {
          await this.applyFileChangeAs(change, actor, phase);
        });
      },
      snapshot: (options) => this.snapshot(options),
      watch: (listener) => this.watch(listener),
      watchMutations: (listener) => this.fs.watchMutations(listener),
    };
  }

  private async applyFileChangeAs(
    change: RuntimeFileChange,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase,
    process?: RuntimeKernelProcessRecord
  ): Promise<void> {
    this.assertActorFileCapability(
      actor,
      (isRuntimeDirectoryChange(change) && change.deleted === true) ||
        (!isRuntimeDirectoryChange(change) && (change as RuntimeFileDeletion).deleted === true)
        ? 'delete'
        : 'write',
      change.path
    );
    this.assertWorkspaceUsableForMutation('apply');
    await this.applyFileChangeToWorkspace(change, actor, phase, true, process);
  }

  private async deleteFileAs(
    path: string,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase,
    process?: RuntimeKernelProcessRecord
  ): Promise<void> {
    this.assertActorFileCapability(actor, 'delete', path);
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
    }, undefined, process);
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

  private createRuntimeLiveIoController(
    actor?: RuntimeWorkspaceActor,
    signal?: AbortSignal,
    context?: () => RuntimeCommandExecutionContext | undefined
  ): RuntimeProjectLiveIoController {
    return new RuntimeProjectLiveIoController({
      actor: actor ?? SYSTEM_ACTOR,
      applyFileChange: (change, phase) => this.applyRuntimeFileChangeSilently(change, phase, context?.()),
      onEvent: (event) => this.emitRuntimeEvent(event, context?.()),
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

  private handleRuntimeCommandEvent(event: RuntimeCommandEvent, context?: RuntimeCommandExecutionContext): void {
    const runtimeIo = context?.runtimeIo;
    if (runtimeIo) {
      if (event.type === 'file-change') {
        const actor = event.actor ?? context?.actor;
        const enriched = this.enrichRuntimeEvent(event, actor) as RuntimeCommandFileChangeEvent;
        this.recordFileChangeJournal(enriched, context);
        event = enriched;
      }
      runtimeIo.handleRuntimeEvent(event);
      return;
    }
    this.emitRuntimeEvent(event, context);
  }

  private async flushRuntimeEventQueue(context?: RuntimeCommandExecutionContext): Promise<void> {
    await context?.runtimeIo.flush();
  }

  private async applyRuntimeFileChangeSilently(
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    context?: RuntimeCommandExecutionContext
  ): Promise<void> {
    await withSuspendedFsNotifications(this.bash.fs, async () => {
      await this.applyFileChangeToWorkspace(change, SYSTEM_ACTOR, phase, false, undefined, context);
    });
  }

  private async applyFileChangeToWorkspace(
    change: RuntimeFileChange,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase,
    emit: boolean,
    process?: RuntimeKernelProcessRecord,
    context?: RuntimeCommandExecutionContext
  ): Promise<void> {
    const mutationTarget = kernelMutationTarget(change.path);
    if (mutationTarget.kind === 'error') {
      throwKernelMutationTargetError(change.path, mutationTarget, `Kernel device namespace is not a file-change target: ${change.path}`);
    }

    const relativePath = this.toWorkspaceRelativePath(change.path);
    if (isRuntimeDirectoryChange(change)) {
      const absolutePath = this.toWorkspaceEntryPath(change.path);
      await this.fs.withBaseMutationWithContext(context, [absolutePath], async (fs) => {
        if (change.deleted === true) {
          this.assertWorkspaceSubtreeWritable(absolutePath, 'delete');
          await fs.rm(absolutePath, { force: true, recursive: true });
        } else {
          await fs.mkdir(absolutePath, { recursive: true });
          if (change.mode !== undefined) await fs.chmod(absolutePath, change.mode);
          if (change.atimeMs !== undefined || change.mtimeMs !== undefined) {
            const stat = await fs.stat(absolutePath);
            const currentMtime = stat.mtime instanceof Date ? stat.mtime.getTime() : 0;
            await fs.utimes(
              absolutePath,
              new Date(change.atimeMs ?? currentMtime),
              new Date(change.mtimeMs ?? currentMtime)
            );
          }
        }
      }, change.deleted === true ? 'recursive-delete' : 'directory-create');
      if (emit) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: {
            path: relativePath,
            directory: true,
            ...(change.mode !== undefined ? { mode: change.mode } : {}),
            ...(change.atimeMs !== undefined ? { atimeMs: change.atimeMs } : {}),
            ...(change.mtimeMs !== undefined ? { mtimeMs: change.mtimeMs } : {}),
            ...(change.deleted === true ? { deleted: true } : {}),
          },
          phase,
          actor,
        }, undefined, process);
      }
      return;
    }

    if ((change as RuntimeFileDeletion).deleted === true) {
      const absolutePath = this.toWorkspacePath(change.path);
      await this.fs.withBaseMutationWithContext(context, [absolutePath], async (fs) => {
        this.assertWorkspacePathWritable(absolutePath, 'delete');
        await fs.rm(absolutePath, { force: true });
      }, 'delete');
      if (emit) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: { path: relativePath, deleted: true },
          phase,
          actor,
        }, undefined, process);
      }
      return;
    }

    if (isRuntimeSymlinkChange(change)) {
      const absolutePath = this.toWorkspaceEntryPath(change.path);
      const mutationKind: RuntimeFileSystemMutationKind = await this.bash.fs.exists(absolutePath) ? 'file-write' : 'file-create';
      await this.fs.withBaseMutationWithContext(context, [absolutePath], async (fs) => {
        this.assertWorkspacePathWritable(absolutePath, 'symlink');
        await fs.mkdir(dirname(absolutePath), { recursive: true });
        await fs.rm(absolutePath, { force: true, recursive: true });
        await fs.symlink(change.target, absolutePath);
      }, mutationKind);
      if (emit) {
        this.emitLocalRuntimeEvent({
          type: 'file-change',
          change: { path: relativePath, symlink: true, target: change.target },
          phase,
          actor,
        }, undefined, process);
      }
      return;
    }

    const changedFile = change as RuntimeFile;
    const normalizedEncoding = assertSupportedEncoding(changedFile.encoding);
    const absolutePath = this.toWorkspacePath(changedFile.path);
    if (
      this.isWorkspacePathReadOnly(absolutePath) &&
      changedFile.mode === undefined && changedFile.atimeMs === undefined && changedFile.mtimeMs === undefined &&
      await this.runtimeFileChangeContentEquals(absolutePath, changedFile, normalizedEncoding)
    ) {
      return;
    }
    const mutationKind: RuntimeFileSystemMutationKind = await this.bash.fs.exists(absolutePath) ? 'file-write' : 'file-create';
    // A create still takes structural parent locks and records the new directory
    // membership. Freshness is path-scoped, though: a sibling created by a
    // different live runtime must not make this independent target stale.
    const freshnessKind: RuntimeFileSystemMutationKind = mutationKind === 'file-create' ? 'file-write' : mutationKind;
    await this.fs.withBaseMutationWithContext(context, [absolutePath], async (fs) => {
      this.assertWorkspacePathWritable(absolutePath, 'write');
      if (normalizedEncoding === 'base64') {
        await fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
      } else {
        await fs.writeFile(absolutePath, changedFile.contents);
      }
      if (changedFile.mode !== undefined) await fs.chmod(absolutePath, changedFile.mode);
      if (changedFile.atimeMs !== undefined || changedFile.mtimeMs !== undefined) {
        const stat = await fs.stat(absolutePath);
        const currentMtime = stat.mtime instanceof Date ? stat.mtime.getTime() : 0;
        await fs.utimes(
          absolutePath,
          new Date(changedFile.atimeMs ?? currentMtime),
          new Date(changedFile.mtimeMs ?? currentMtime)
        );
      }
    }, mutationKind, freshnessKind);
    if (emit) {
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change: {
          path: relativePath,
          contents: changedFile.contents,
          ...(normalizedEncoding === 'base64' ? { encoding: 'base64' as const } : {}),
          ...(changedFile.mode !== undefined ? { mode: changedFile.mode } : {}),
          ...(changedFile.atimeMs !== undefined ? { atimeMs: changedFile.atimeMs } : {}),
          ...(changedFile.mtimeMs !== undefined ? { mtimeMs: changedFile.mtimeMs } : {}),
        },
        phase,
        actor,
      }, undefined, process);
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

  private emitLocalRuntimeEvent(
    event: RuntimeCommandEvent,
    context?: RuntimeCommandExecutionContext,
    process?: RuntimeKernelProcessRecord
  ): void {
    if (event.type === 'file-change') {
      const actor = event.actor ?? context?.actor;
      const enriched = this.enrichRuntimeEvent(event, actor) as RuntimeCommandFileChangeEvent;
      this.recordFileChangeJournal(enriched, context, process);
      event = enriched;
    }
    const runtimeIo = context?.runtimeIo;
    if (runtimeIo) {
      runtimeIo.emit(event);
      return;
    }
    this.emitRuntimeEvent(event, context);
  }

  private emitRuntimeEvent(event: RuntimeCommandEvent, commandContext?: RuntimeCommandExecutionContext): void {
    const actor = 'actor' in event && event.actor ? event.actor : commandContext?.actor;
    const enriched = this.enrichRuntimeEvent(event, actor);
    this.dispatchRuntimeEvent(enriched, commandContext);
  }

  private emitReturnedOutputEvents(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    context?: RuntimeCommandExecutionContext
  ): void {
    context?.runtimeIo.emitMissingFinalOutput(result, (stream, data) => {
      this.emitLocalRuntimeEvent({
        type: 'output',
        stream,
        device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
        data,
      }, context);
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
    const symlinks: RuntimeSymlink[] = [];
    await collectSnapshotFiles(fs, this.cwd, absolutePath, files, directories, symlinks);
    const directoryPath = toProjectDirectoryPath(this.cwd, absolutePath);
    const deletedDirectories = [
      ...directories,
      ...(directoryPath ? [directoryPath] : []),
    ].sort((left, right) => right.localeCompare(left));
    return [
      ...files.map((file): RuntimeFileDeletion => ({ path: file.path, deleted: true })),
      ...symlinks.map((symlink): RuntimeFileDeletion => ({ path: symlink.path, deleted: true })),
      ...deletedDirectories.map((deletedPath): RuntimeDirectoryChange => ({
        path: deletedPath,
        directory: true,
        deleted: true,
      })),
    ];
  }

  private async collectWorkspaceFilesCached(): Promise<{ files: RuntimeFile[]; directories: string[]; directoryMetadata: RuntimeDirectory[]; symlinks: RuntimeSymlink[]; kernelFiles: RuntimeFile[] }> {
    if (this.snapshotCache !== null && this.snapshotCache.version === this.fs.mutationVersion) {
      return this.snapshotCache;
    }

    let lastWalk: { files: RuntimeFile[]; directories: string[]; directoryMetadata: RuntimeDirectory[]; symlinks: RuntimeSymlink[]; kernelFiles: RuntimeFile[] } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const version = this.fs.mutationVersion;
      const files: RuntimeFile[] = [];
      const directories: string[] = [];
      const directoryMetadata: RuntimeDirectory[] = [];
      const symlinks: RuntimeSymlink[] = [];
      await this.collectFiles(this.cwd, files, directories, symlinks, directoryMetadata);
      files.sort((left, right) => left.path.localeCompare(right.path));
      directories.sort((left, right) => left.localeCompare(right));
      symlinks.sort((left, right) => left.path.localeCompare(right.path));
      directoryMetadata.sort((left, right) => left.path.localeCompare(right.path));
      const kernelFiles = await snapshotRuntimeKernelVirtualFiles(this.bash.fs, this.kernelInfo);
      lastWalk = { files, directories, directoryMetadata, symlinks, kernelFiles };
      if (this.fs.mutationVersion === version) {
        this.snapshotCache = { version, ...lastWalk };
        return this.snapshotCache;
      }
    }

    return lastWalk!;
  }

  private async collectFiles(absolutePath: string, files: RuntimeFile[], directories: string[], symlinks: RuntimeSymlink[], directoryMetadata: RuntimeDirectory[]): Promise<void> {
    if (!isWithinWorkspace(this.cwd, absolutePath)) {
      throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
    }

    await collectSnapshotFiles(this.bash.fs, this.cwd, absolutePath, files, directories, symlinks, directoryMetadata);
  }
}

export async function createRuntimeWorkspace(
  options: CreateRuntimeWorkspaceOptions = {}
): Promise<RuntimeProjectWorkspace> {
  const sessionDirectories = options.projectSession?.directories ?? [];
  const sessionDirectoryMetadata = options.projectSession?.directoryMetadata ?? [];
  const sessionFiles = options.projectSession?.files ?? [];
  const sessionSymlinks = options.projectSession?.symlinks ?? [];
  const suppliedDirectories = options.directories ?? [];
  const suppliedDirectoryMetadata = options.directoryMetadata ?? [];
  const suppliedFiles = options.files ?? [];
  const suppliedSymlinks = options.symlinks ?? [];
  options = normalizeRuntimeWorkspaceOptions(options);
  const workspace = new RuntimeProjectWorkspace(options);
  await workspace.ensureReady();
  if (options.skills) {
    await workspace.writeSkillFiles(options.skills);
  }
  if (sessionDirectories.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(async () => {
      for (const directory of sessionDirectories) {
        await workspace.mkdir(directory);
      }
    });
  }
  if (sessionDirectoryMetadata.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(async () => {
      for (const directory of sessionDirectoryMetadata) {
        await workspace.applyKernelFileChange({ ...directory, directory: true });
      }
    });
  }
  for (const directory of suppliedDirectories) {
    await workspace.mkdir(directory);
  }
  for (const directory of suppliedDirectoryMetadata) {
    await workspace.applyKernelFileChange({ ...directory, directory: true });
  }
  if (sessionFiles.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(() => workspace.writeFiles(sessionFiles));
  }
  if (sessionSymlinks.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(async () => {
      for (const symlink of sessionSymlinks) await workspace.applyKernelFileChange(symlink);
    });
  }
  if (suppliedFiles.length > 0) {
    const authoritativeFiles = new Map(
      (await workspace.snapshot({ includeHidden: true })).files.map((file) => [file.path, file])
    );
    for (const file of suppliedFiles) {
      const path = normalizeRuntimeProjectPath(file.path);
      if (workspace.isReadOnly(path)) {
        const authoritative = authoritativeFiles.get(path);
        if (authoritative && bytesEqual(
          contentToBytesForRuntimeFile(authoritative),
          contentToBytesForRuntimeFile({ ...file, path })
        )) {
          continue;
        }
        throw createRuntimeKernelReadonlyFileError(path, 'hydrate');
      }
      await workspace.writeFile(path, file.contents, file.encoding);
    }
  }
  for (const symlink of suppliedSymlinks) await workspace.applyKernelFileChange(symlink);
  return workspace;
}

/** @deprecated Use RuntimeProjectWorkspace. */
export { RuntimeProjectWorkspace as JustBashRuntimeWorkspace };

export type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandEventStream,
  RuntimeCommandFileChangeEvent,
  RuntimeCommandOutputEvent,
  RuntimeCommandStatusEvent,
  KernelJournalRecord,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileDeletion,
  RuntimeSymlink,
  RuntimeDirectory,
  RuntimeDirectoryChange,
  RuntimeFileEncoding,
  RuntimeKernelHostConfig,
  RuntimeKernelHostInfo,
  RuntimeKernelInfo,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpBodyInit,
  RuntimeKernelHttpBodyPayload,
  RuntimeKernelHttpError,
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
  RuntimeProjectPatchDirectoryWrite,
  RuntimeProjectPatchDirectoryDelete,
  RuntimeProjectPatchFileDelete,
  RuntimeProjectPatchFileWrite,
  RuntimeProjectPatchSymlinkWrite,
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
  RuntimeWorkspaceHttpClient,
  RuntimeWorkspaceHttpJsonRequestOptions,
  RuntimeWorkspaceHttpJsonResponse,
  RuntimeWorkspaceHttpRequestOptions,
  RuntimeWorkspaceKernel,
  RuntimeWorkspaceProcess,
  RuntimeWorkspaceProcessOptions,
  RuntimeWorkspaceProcessSignalPolicy,
  RuntimeWorkspaceRemoveOptions,
  RuntimeWorkspaceStat,
  RuntimeWorkspaceUnsubscribe,
};

export type {
  RuntimeExternalHttpConfig,
  RuntimeExternalHttpRequest,
} from '@tracecode/harness-core';

export { normalizeRuntimeProjectPath } from './paths';
export { RuntimeProjectWorkspaceTerminalSession } from './terminal-session';
export { createPackageManagerProjectCommands } from './package-manager';
export {
  createPythonProjectCommands,
  createNodeProjectCommands,
  createTypeScriptProjectCommands,
  createJavaProjectCommands,
  createCppProjectCommands,
  createCSharpProjectCommands,
} from './language-commands';

export {
  RuntimeProjectLiveIoController,
  createRuntimeProjectHiddenCommandAccess,
  createRuntimeProjectIoBridge,
  createDefaultExternalHttpFetch,
  isBlockedExternalHttpHost,
  RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES,
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
