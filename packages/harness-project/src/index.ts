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
} from '@tracecode/harness-core';
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
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
  KernelJournalRecord,
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
  RuntimeKernelHttpError,
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
} from '@tracecode/harness-core';
import {
  CPP_COMPILER_COMMANDS,
  DEFAULT_CWD,
  TRACE_KERNEL_NAME,
  TRACEKERNEL_BIN_PATH,
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
  isKernelReadonlyError,
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
const SYSTEM_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('system');
const TRACEKERNEL_EVENT_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_LISTENER_LIMIT = 128;
const TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT = 256;
const TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS = 256;
const TRACEKERNEL_HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;
const TRACEKERNEL_HTTP_MAX_HEADER_COUNT = 128;
const TRACEKERNEL_HTTP_MAX_HEADER_BYTES = 64 * 1024;
const TRACEKERNEL_HTTP_MAX_DIAGNOSTIC_FIELD_LENGTH = 4096;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const TRACEKERNEL_EXTERNAL_HTTP_DEFAULT_MAX_REQUESTS_PER_COMMAND = 64;
const TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS = 60_000;

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

export class RuntimeProjectWorkspace implements RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly projectSession?: RuntimeProjectSessionInfo;
  readonly cwd: string;
  readonly http: RuntimeWorkspaceHttpClient;
  readonly kernelInfo: RuntimeKernelInfo;
  private readonly bash: Bash;
  private readonly bashOptions: BashOptions;
  private readonly fs: KernelObservedFileSystem;
  // Cached RuntimeFile objects are immutable; consumers must shallow-copy arrays before filtering.
  private snapshotCache: { version: number; files: RuntimeFile[]; directories: string[]; kernelFiles: RuntimeFile[] } | null = null;
  private readonly fsLocks = new RuntimeFileSystemLockCoordinator();
  private readonly commandScheduler: RuntimeCommandScheduler;
  private readonly externalHttp?: NormalizedRuntimeExternalHttpConfig;
  private readonly entrypoint?: string;
  private readonly kernelControl?: RuntimeTraceKernelControlOptions;
  private readonly cppRunner?: CppProjectCommandRunner;
  private readonly projectSessionCommands?: Record<string, RuntimeProjectSessionCommand>;
  private readonly hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  private readonly traceKernelCommandRegistry: TraceKernelCommandInfo[];
  private readonly traceKernelCommandNames: ReadonlySet<string>;
  private readonly skillFiles = new Map<string, RuntimeFile>();
  private readonly virtualExecutableRecords = new Map<string, VirtualExecutableRecord>();
  private readonly processTable = new Map<number, RuntimeKernelProcessRecord>();
  private readonly zombieProcessTable = new Map<number, RuntimeKernelZombieRecord>();
  private readonly processWaiters = new Map<number, Array<(process: RuntimeKernelProcessRecord) => void>>();
  private readonly anyProcessWaiters: Array<(process: RuntimeKernelProcessRecord) => void> = [];
  private readonly kernelEventLog: RuntimeKernelEventRecord[] = [];
  private readonly kernelJournalLog: KernelJournalRecord[] = [];
  private readonly httpListeners = new Map<string, RuntimeKernelHttpListenerRecord>();
  private readonly httpRequestLog: RuntimeKernelHttpRequestRecord[] = [];
  private readonly httpLifecycleAbortController = new AbortController();
  private readonly readonlyFiles = new Set<string>();
  private readonly eventWatchers = new Set<RuntimeWorkspaceEventHandler>();
  private readonlySuspendDepth = 0;
  private nextCommandId = 1;
  private nextPid = 100;
  private nextKernelEventSeq = 1;
  private nextJournalSeq = 1;
  private nextHttpListenerSeq = 1;
  private nextHttpRequestSeq = 1;
  private nextEphemeralHttpPort = 49152;
  private activeHttpRequests = 0;
  private activeExternalHttpRequests = 0;
  private workspaceExternalHttpRequestCount = 0;
  private destroyed = false;
  private expirationDestroyScheduled = false;
  private terminalVerbose = false;

  constructor(options: CreateRuntimeWorkspaceOptions = {}) {
    this.kernelInfo = createTraceKernelInfo(options.kernel, options.cwd);
    this.externalHttp = normalizeRuntimeExternalHttpConfig(options.externalHttp);
    this.http = {
      request: (requestOptions) => this.requestHttp(requestOptions),
      json: (requestOptions) => this.requestHttpJson(requestOptions),
      listen: (listenOptions, handler) => this.listenHttp(listenOptions, handler),
    };
    this.commandScheduler = new RuntimeCommandScheduler(normalizeRuntimeSchedulerConfig(options.kernel?.scheduler));
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
    const withEvents = <Request extends RuntimeProjectCommandRequest<string>>(
      runner: RuntimeProjectCommandRunner<Request>
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
        try {
          result = await runner({
            ...request,
            ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
            ...(signal ? { signal } : {}),
            kernelHttp: this.createKernelHttpBridge(commandContext),
            onEvent: (event) => {
              if (!acceptingRunnerEvents || signal?.aborted) return;
              this.handleRuntimeCommandEvent(event, commandContext);
            },
          } as Request);
        } finally {
          acceptingRunnerEvents = false;
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
    this.traceKernelCommandNames = new Set(this.traceKernelCommandRegistry.map((command) => command.name));
    const emitPackageManagerOutput: PackageManagerOutputEmitter = (stream, data) => {
      this.emitLocalRuntimeEvent({
        type: 'output',
        stream,
        device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr',
        data,
      });
    };
    const includeHiddenFilesForCurrentCommand = (ctx?: CommandContext) => this.resolveCommandContext(ctx)?.includeHiddenFiles === true;
    const snapshotProjectForCurrentCommand = (_ctx: CommandContext, includeHiddenFiles: boolean) =>
      this.snapshotForCommand(includeHiddenFiles);
    const customCommands: CustomCommand[] = [
      ...(options.pythonRunner ? createPythonProjectCommands(withEvents(options.pythonRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.nodeRunner ? createNodeProjectCommands(withEvents(options.nodeRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.typescriptRunner ? createTypeScriptProjectCommands(withEvents(options.typescriptRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(packageManagerConfig ? createPackageManagerProjectCommands(packageManagerConfig, this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, emitPackageManagerOutput, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.javaRunner ? createJavaProjectCommands(withEvents(options.javaRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.cppRunner ? createCppProjectCommands(withEvents(options.cppRunner), this.cwd, {
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
      ...(options.csharpRunner ? createCSharpProjectCommands(withEvents(options.csharpRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      defineCommand(TRACEKERNEL_EXEC_COMMAND, (args, ctx) => this.runTraceKernelExec(args, ctx)),
      defineCommand('bg', async (args, ctx) => this.runKernelJobPlacement(args, 'bg', ctx)),
      defineCommand('curl', async (args, ctx) => this.runKernelCurl(args, ctx)),
      defineCommand('fg', async (args, ctx) => this.runKernelJobPlacement(args, 'fg', ctx)),
      defineCommand('kill', async (args, ctx) => this.runKernelKill(args, 'kill', ctx)),
      defineCommand('jobs', async (args, ctx) => this.runKernelJobs(args, ctx)),
      defineCommand('ls', async (args, ctx) => this.runKernelAwareLs(args, ctx)),
      defineCommand('ping', async (args, ctx) => this.runKernelPing(args, ctx)),
      defineCommand('ps', async (args, ctx) => this.runKernelPs(args, ctx)),
      defineCommand('tracekernelctl', (args, ctx) => this.runTraceKernelCtl(args, ctx)),
      defineCommand('wait', (args, ctx) => this.runKernelWait(args, 'wait', ctx)),
      defineCommand('which', async (args, ctx) => this.runTraceKernelWhich(args, 'which', ctx)),
      defineCommand('command', async (args, ctx) => this.runTraceKernelCommandBuiltin(args, ctx)),
      ...(options.customCommands ?? []),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}bg`, async (args, ctx) => this.runKernelJobPlacement(args, 'bg', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}command`, async (args, ctx) => this.runTraceKernelCommandBuiltin(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}fg`, async (args, ctx) => this.runKernelJobPlacement(args, 'fg', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}kill`, async (args, ctx) => this.runKernelKill(args, 'kill', ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}jobs`, async (args, ctx) => this.runKernelJobs(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}ps`, async (args, ctx) => this.runKernelPs(args, ctx)),
      defineCommand(`${TRACEKERNEL_SHELL_COMMAND_PREFIX}wait`, (args, ctx) => this.runKernelWait(args, 'wait', ctx)),
    ].map((command) => this.withKernelCommandSignal(command as CustomCommand));
    this.bashOptions = {
      fs: this.fs,
      cwd: this.cwd,
      env: options.env,
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
        rewriteTraceKernelBinInvocationsInAst(ast, this.traceKernelCommandNames);
        rewriteKernelShellCommandInvocationsInAst(ast);
        const executableTransformCwd = commandContext?.executableTransformCwd;
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
      new Error(`EACCES: TraceKernel HTTP ${capability} is not allowed for actor ${actor.kind}:${actor.id}`),
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
        this.createHttpError('EINVAL', `TraceKernel HTTP URL rejected: ${options.url}`)
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
      throw Object.assign(new Error(`EINVAL: invalid TraceKernel HTTP ${direction} body encoding`), { code: 'EINVAL' });
    }
    if (bytes.byteLength > TRACEKERNEL_HTTP_MAX_BODY_BYTES) {
      throw Object.assign(new Error(`EMSGSIZE: TraceKernel HTTP ${direction} body limit exceeded`), { code: 'EMSGSIZE' });
    }
  }

  private normalizeHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequestResult {
    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      return { ok: false, error: this.createHttpError('EINVAL', 'EINVAL: invalid TraceKernel HTTP request URL') };
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
    const actor = owner?.actor ?? SYSTEM_ACTOR;
    this.assertHttpCapability(actor, 'listen');
    const listenerOwner = owner;
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
    const exact = this.httpListeners.get(this.httpListenerKey(host, port, 'http'));
    if (exact) return exact;
    return this.isHttpWildcardConnectHost(host)
      ? this.httpListeners.get(this.httpListenerKey('0.0.0.0', port, 'http'))
      : undefined;
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
      return settleFailure('EINTR', 'TraceKernel HTTP workspace has been disposed\n');
    }
    const handlerResponse = invoke(requestAbortController.signal);
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
    races.push(new Promise<RuntimeKernelHttpResponse>((resolve) => {
      lifecycleAbortListener = () => {
        abortHandlerRequest();
        resolve(settleFailure('EINTR', 'TraceKernel HTTP workspace has been disposed\n'));
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
    status: 403 | 429,
    error: string,
    reason: string
  ): RuntimeKernelHttpResponse {
    this.recordHttpRequest({
      method: normalizedRequest.method,
      url: normalizedRequest.url,
      error,
      external: true,
    });
    return {
      status,
      body: `tracekernel: external fetch blocked: ${reason}\n`,
      error: this.createHttpError(error, `tracekernel: external fetch blocked: ${reason}`),
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
      return this.externalHttpBlockedResponse(normalizedRequest, 403, 'EHOSTBLOCKED', blocklistReason);
    }
    const hostResolution = this.resolveHost(url.hostname.replace(/^\[|\]$/g, ''));
    if (!hostResolution.reachable) {
      const allowlistReason = this.runtimeExternalHttpAllowlistReason(config, url);
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
        ? 'TraceKernel HTTP workspace has been disposed\n'
        : 'TraceKernel HTTP request aborted\n';
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
        this.createHttpError('EINVAL', `TraceKernel HTTP timeout rejected: ${options.timeoutMs}`)
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
        if (!settled) {
          this.recordHttpRequest({
            method: normalizedRequest.method,
            url: normalizedRequest.url,
            error: message,
            external: true,
          });
          this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: message });
        }
        return { status: 502, body: `tracekernel: external fetch failed: ${message}\n` };
      } finally {
        this.activeExternalHttpRequests = Math.max(0, this.activeExternalHttpRequests - 1);
      }
    }, settleFailure, () => {
      this.activeExternalHttpRequests = Math.max(0, this.activeExternalHttpRequests - 1);
    });
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
        body: 'TraceKernel HTTP workspace has been disposed\n',
        error: this.createHttpError('EINTR', 'TraceKernel HTTP workspace has been disposed'),
      };
    }
    if (!listener) {
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
        body: 'TraceKernel HTTP request limit reached\n',
        error: this.createHttpError('EAGAIN', 'TraceKernel HTTP request limit reached'),
      };
    }
    const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return this.httpErrorResponse(
        400,
        this.createHttpError('EINVAL', `TraceKernel HTTP timeout rejected: ${options.timeoutMs}`)
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
        body: 'TraceKernel HTTP request aborted\n',
        error: this.createHttpError('EINTR', 'TraceKernel HTTP request aborted'),
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
        const response = this.normalizeHttpResponse(await listener.handler({
          ...normalizedRequest,
          signal: handlerSignal,
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
          this.recordHttpJournal(normalizedRequest, url, 'listener', actor, options.commandContext, {
            status,
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
      actor: SYSTEM_ACTOR,
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
    commandContext?: RuntimeCommandExecutionContext
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
      ...(commandContext?.process.pid !== undefined ? { pid: commandContext.process.pid } : {}),
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

  private signalProcessGroup(pgid: number, signalName = 'SIGTERM', currentPid?: number): number {
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

  private readDynamicVirtualFile(path: string, context?: RuntimeCommandExecutionContext): string | null {
    const skillFile = this.readDynamicSkillsFile(path);
    if (skillFile !== null) return skillFile;
    const traceKernelFile = this.readDynamicTraceKernelFile(path);
    if (traceKernelFile !== null) return traceKernelFile;
    return this.readDynamicProcFile(path, context);
  }

  private readDynamicVirtualDir(path: string, context?: RuntimeCommandExecutionContext): RuntimeDynamicProcEntry[] | null {
    return this.readDynamicSkillsDir(path) ?? this.readDynamicTraceKernelDir(path) ?? this.readDynamicProcDir(path, context);
  }

  private dynamicVirtualEntryKind(path: string, context?: RuntimeCommandExecutionContext): 'file' | 'directory' | null {
    return this.dynamicSkillsEntryKind(path) ?? this.dynamicTraceKernelEntryKind(path) ?? this.dynamicProcEntryKind(path, context);
  }

  private dynamicVirtualStat(path: string, context?: RuntimeCommandExecutionContext): RuntimeKernelVirtualStat | null {
    return this.dynamicSkillsStat(path) ?? this.dynamicTraceKernelStat(path) ?? this.dynamicProcStat(path, context);
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
      request.external ? 'external' : '',
    ].join('\t'));
    return ['seq\ttime\tlistener\tpid\tmethod\turl\tstatus\terror\texternal', ...rows].join('\n') + '\n';
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
      preserveScriptPath: true,
      commandContext,
    });
    return result ?? { stdout: '', stderr: `bash: ${expandedInvocation.scriptFile}: Exec format error\n`, exitCode: 126 };
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
    if (
      error.code === 'EACCES' ||
      error.code === 'EHOSTBLOCKED' ||
      error.code === 'EHOSTUNREACH' ||
      error.code === 'ECONNREFUSED'
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
    const request: RuntimeKernelHttpRequest = {
      method: method ?? 'GET',
      url: url.toString(),
      path: `${url.pathname}${url.search}`,
      headers,
      ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
      ...(body !== undefined ? { body } : {}),
    };
    const commandContext = this.resolveCommandContext(ctx);
    const response = await this.dispatchHttpRequest(request, {
      ...(timeoutMs !== undefined ? {
        timeoutMs,
        timeoutBody: `curl: (28) Operation timed out after ${timeoutMs} milliseconds\n`,
      } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(commandContext?.actor ? { actor: commandContext.actor } : {}),
      ...(commandContext ? { commandContext } : {}),
    });
    const kernelError = this.kernelCurlErrorResult(response);
    if (kernelError) return kernelError;
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
        stderr: hosts.length === 0 ? 'ping: missing host operand\n' : 'ping: multiple hosts are not supported by tracekernel ping\n',
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

  private runTraceKernelCommandBuiltin(args: string[], ctx: CommandContext): RuntimeCommandResult {
    const option = args[0];
    if (option === '-v' || option === '-V') {
      return this.runTraceKernelWhich(args.slice(1), 'command', ctx);
    }
    return {
      stdout: '',
      stderr: 'command: only -v and -V are supported by TraceKernel command discovery\n',
      exitCode: 2,
    };
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
        const count = this.signalProcessGroup(pgid, signal.name, this.resolveCommandContext(ctx)?.process.pid);
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
        return this.reapZombieProcess(undefined, 'tracekernelctl', this.resolveCommandContext(ctx)?.process.pid);
      }
      const pid = Number(args[1]);
      if (!Number.isInteger(pid) || pid <= 0) {
        return { stdout: '', stderr: `tracekernelctl: invalid pid: ${args[1]}\n`, exitCode: 22 };
      }
      return this.reapZombieProcess(pid, 'tracekernelctl', this.resolveCommandContext(ctx)?.process.pid);
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

  private runKernelPs(args: string[], _ctx: CommandContext): RuntimeCommandResult {
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
        if (this.signalProcessGroup(pgid, signal.name, this.resolveCommandContext(ctx)?.process.pid) === 0) {
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

  private runKernelWait(args: string[], commandName: string, _ctx: CommandContext): Promise<RuntimeCommandResult> {
    if (args.length > 1) {
      return Promise.resolve({ stdout: '', stderr: `usage: ${commandName} [pid]\n`, exitCode: 2 });
    }
    if (args[0] === undefined) return this.reapZombieProcess(undefined, commandName, this.resolveCommandContext(_ctx)?.process.pid);
    const pid = Number(args[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return Promise.resolve({ stdout: '', stderr: `${commandName}: invalid pid: ${args[0]}\n`, exitCode: 22 });
    }
    return this.reapZombieProcess(pid, commandName, this.resolveCommandContext(_ctx)?.process.pid);
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
    throw Object.assign(new Error('EINVAL: tracekernel session has been destroyed'), { code: 'EINVAL' });
  }

  private assertWorkspaceUsableForMutation(operation: string): void {
    this.assertNotDestroyed();
    const lifecycle = this.projectSession?.lifecycle;
    if (lifecycle?.expiresAt && !lifecycle.expiredAt) {
      this.transitionExpiredIfDue(Date.now());
    }
    if (this.isReadonlyPolicySuspended()) return;
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
      new Error(`EROFS: kernel virtual path is read-only, ${operation} '${path}'`),
      { code: 'EROFS' }
    );
  }

  private assertWorkspaceUsableForRun(command: string): RuntimeCommandResult | null {
    if (this.destroyed) {
      return { stdout: '', stderr: 'tracekernel session has been destroyed\n', exitCode: 1 };
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
    if (this.isHomePathOutsideWorkspace(absolutePath)) {
      throw Object.assign(
        new Error(`EROFS: project workspace is read-only outside '${this.cwd}', ${operation} '${absolutePath}'`),
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
    const unusable = this.assertWorkspaceUsableForRun(command);
    if (unusable) return unusable;
    const commandCwd = options.cwd ? this.resolveCommandCwd(options.cwd) : this.cwd;
    const stdinPipe = options.stdinPipe;
    const actor = this.createRuntimeActor();
    const abortController = new AbortController();
    const pid = this.nextPid++;
    const terminalPresentation = options.presentation === 'terminal';
    const foreground = options.foreground ?? terminalPresentation;
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: 1,
      pgid: pid,
      sid: 1,
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
    let commandContext!: RuntimeCommandExecutionContext;
    commandContext = {
      eventHandler: this.createCommandEventHandler(options),
      actor,
      process,
      stdinPipe,
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
          processExitCode = directExecutableResult.exitCode;
          return {
            ...directExecutableResult,
            ...output,
            ...(!directExecutableResult.error && process.signal ? { error: this.signalCommandError(process) } : {}),
          };
        }

        const bash = this.createBash(options.executionLimits, commandContext, commandFs);
        const baselineEnv = options.onEnvChanges ? { ...bash.getEnv(), ...(options.env ?? {}) } : undefined;
        const result = await bash.exec(command, {
          cwd: commandCwd,
          env: options.env,
          signal: abortController.signal,
          args: options.args,
        });
        if (baselineEnv && options.onEnvChanges) {
          options.onEnvChanges(runtimeCommandEnvChanges(baselineEnv, result.env));
        }
        await this.flushRuntimeEventQueue(commandContext);
        const output = this.captureReturnedOutput(commandContext, result);
        this.emitReturnedOutputEvents(output, commandContext);
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
          await this.flushRuntimeEventQueue(commandContext);
          this.emitReturnedOutputEvents(output, commandContext);
          return { ...result, ...output };
        }
        if (isRuntimeWorkspaceStorageLimitError(error)) {
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
        const marker = `\n[tracekernel: project command output truncated after ${aggregateOutputLimitBytes} bytes]\n`;
        outputBytes[stream] += runtimeProjectUtf8Bytes(marker);
        aggregateOutputBytes += runtimeProjectUtf8Bytes(marker);
        return `${current}${truncated}${marker}`;
      }
      truncatedOutputStreams.add(stream);
      const marker = `\n[tracekernel: ${stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
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
    this.httpListeners.clear();
    if (!this.httpLifecycleAbortController.signal.aborted) this.httpLifecycleAbortController.abort();
    this.processTable.clear();
    this.zombieProcessTable.clear();
    this.processWaiters.clear();
    this.anyProcessWaiters.splice(0);
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
      preserveScriptPath: false,
      commandContext,
    });
  }

  private async executeVirtualExecutable(request: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdinPipe?: RuntimeCommandOptions['stdinPipe'];
    preserveScriptPath: boolean;
    commandContext: RuntimeCommandExecutionContext;
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
      project: await this.snapshotForCommand(request.commandContext.includeHiddenFiles === true),
      onEvent: (event) => {
        this.handleRuntimeCommandEvent(event, request.commandContext);
      },
    });
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
    const files = [...cached.files];
    const directories = [...cached.directories];
    const kernelFiles = [...cached.kernelFiles];
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
        isRuntimeFileGenerationConflict(error) ||
        isRuntimeWorkspaceStorageLimitError(error)
      ) {
        this.recordKernelCommandError(error);
        return kernelCommandFailure(error);
      }
      throw error;
    }
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
    phase: RuntimeFileMutationPhase
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
    await this.applyFileChangeToWorkspace(change, actor, phase, true);
  }

  private async deleteFileAs(
    path: string,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase
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

  private createRuntimeLiveIoController(
    actor?: RuntimeWorkspaceActor,
    signal?: AbortSignal,
    context?: () => RuntimeCommandExecutionContext | undefined
  ): RuntimeProjectLiveIoController {
    return new RuntimeProjectLiveIoController({
      actor: actor ?? SYSTEM_ACTOR,
      applyFileChange: (change, phase) => this.applyRuntimeFileChangeSilently(change, phase),
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

  private async applyRuntimeFileChangeSilently(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): Promise<void> {
    await withSuspendedFsNotifications(this.bash.fs, async () => {
      await this.applyFileChangeToWorkspace(change, SYSTEM_ACTOR, phase, false);
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

  private emitLocalRuntimeEvent(event: RuntimeCommandEvent, context?: RuntimeCommandExecutionContext): void {
    if (event.type === 'file-change') {
      const actor = event.actor ?? context?.actor;
      const enriched = this.enrichRuntimeEvent(event, actor) as RuntimeCommandFileChangeEvent;
      this.recordFileChangeJournal(enriched, context);
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

  private async collectWorkspaceFilesCached(): Promise<{ files: RuntimeFile[]; directories: string[]; kernelFiles: RuntimeFile[] }> {
    if (this.snapshotCache !== null && this.snapshotCache.version === this.fs.mutationVersion) {
      return this.snapshotCache;
    }

    let lastWalk: { files: RuntimeFile[]; directories: string[]; kernelFiles: RuntimeFile[] } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const version = this.fs.mutationVersion;
      const files: RuntimeFile[] = [];
      const directories: string[] = [];
      await this.collectFiles(this.cwd, files, directories);
      files.sort((left, right) => left.path.localeCompare(right.path));
      directories.sort((left, right) => left.localeCompare(right));
      const kernelFiles = await snapshotRuntimeKernelVirtualFiles(this.bash.fs, this.kernelInfo);
      lastWalk = { files, directories, kernelFiles };
      if (this.fs.mutationVersion === version) {
        this.snapshotCache = { version, ...lastWalk };
        return this.snapshotCache;
      }
    }

    return lastWalk!;
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
): Promise<RuntimeProjectWorkspace> {
  const sessionDirectories = options.projectSession?.directories ?? [];
  const sessionFiles = options.projectSession?.files ?? [];
  const suppliedDirectories = options.directories ?? [];
  const suppliedFiles = options.files ?? [];
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
  for (const directory of suppliedDirectories) {
    await workspace.mkdir(directory);
  }
  if (sessionFiles.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(() => workspace.writeFiles(sessionFiles));
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
  RuntimeWorkspaceHttpClient,
  RuntimeWorkspaceHttpJsonRequestOptions,
  RuntimeWorkspaceHttpJsonResponse,
  RuntimeWorkspaceHttpRequestOptions,
  RuntimeWorkspaceKernel,
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
