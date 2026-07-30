import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import { Bash } from 'just-bash/browser';
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
  runtimeKernelAccessTarget,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileReadErrorMessage,
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
  createRuntimeKernelReadonlyFileError,
} from '@tracecode/harness-core';
import { getLanguageRuntimeInfo, TRACECODE_HARNESS_VERSION } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
import {
  encodeTraceKernelHttp1Request,
  encodeTraceKernelHttp1Response,
  makeTraceKernelPromiseSyscallHandler,
  makeTraceKernelSharedSyscallChannel,
  makeTraceKernelHost,
  TraceKernelControlledRuntime,
  TraceKernelChildProcessError,
  TraceKernelFileSystem,
  TraceKernelFileSystemError,
  TraceKernelHttp1Decoder,
  TraceKernelSharedSyscallServer,
  TraceKernelSyscallDispatcher,
  type TraceKernelHttp1Header,
  type TraceKernelHttp1Message,
  type TraceKernelHttp1Request,
  type TraceKernelHttp1Response,
  type TraceKernelHostStandardIo,
  type TraceKernelFileSystemMutation,
  type TraceKernelFileSystemImage,
  type TraceKernelFileSystemPolicy,
  type TraceKernelHost,
  type TraceKernelPrincipal,
  type TraceKernelProcess,
  type TraceKernelProcessSnapshot,
  type TraceKernelSession,
  type TraceKernelSignal,
  type TraceKernelTerminalSnapshot,
  type TraceKernelSyscallErrorCode,
  type TraceKernelSyscallRequest,
  type TraceKernelSyscallResult,
} from '..';
import type {
  BashOptions,
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import type {
  RuntimeCommandOptions,
  RuntimeCommandCompletion,
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
  RuntimeKernelSignalBridge,
  RuntimeKernelSignalNotification,
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
  RuntimeProjectEngineLeaseAttachment,
  RuntimeProjectEngineLeaseController,
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
  TRACEKERNEL_EXEC_COMMAND,
  TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS,
  TRACEKERNEL_SHELL_COMMAND_PREFIX,
} from './constants';
import {
  assertNoNul,
  dirname,
  expandParsedScriptInvocation,
  isRuntimeSkillsNamespacePath,
  isTraceKernelVirtualNamespacePath,
  isWithinWorkspace,
  mapWorkspaceAlias,
  normalizeRuntimeProjectPath,
  normalizeWorkspaceCwd,
  resolveWorkspaceCommandPath,
  resolveWorkspaceContextPath,
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
import { TraceKernelBackingFileSystem } from './tkfs-backing-filesystem';
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
  filterHiddenSnapshotFiles,
  filterReadonlySnapshotDeletions,
  filterReadonlySnapshotFiles,
  isRuntimeDirectoryChange,
  isRuntimeSymlinkChange,
  isKernelReadonlyError,
  isKernelVirtualFilesystemError,
  isRuntimeFileGenerationConflict,
  isRuntimeWorkspaceStorageLimitError,
  kernelCommandFailure,
  kernelMutationTarget,
  kernelRemoveTarget,
  normalizeRuntimeFileEncoding,
  prepareFinalDiffChange,
  runtimeCommandError,
  snapshotRuntimeKernelVirtualFiles,
  textToByteString,
  withSuspendedFsNotifications,
  commandContextForFs,
  registerCommandContext,
  throwKernelMutationTargetError,
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
  type TraceKernelCommandInfo,
} from './language-commands';
import {
  RuntimeProjectWorkspaceTerminalSession,
  type RuntimeProjectTerminalJobRecord,
} from './terminal-session';
import {
  type CppProjectCommandRunner,
  type CreateRuntimeWorkspaceOptions,
  type CSharpProjectCommandRunner,
  type JavaProjectCommandRunner,
  type JavaScriptProjectCommandRunner,
  type ProjectWorkspaceCommand,
  type PythonProjectCommandRunner,
  type RuntimePackageManagerConfig,
  type RuntimeTraceKernelControlOptions,
  type TypeScriptProjectCommandRunner,
} from './workspace-options';
import {
  normalizeRuntimeWorkspaceStorageLimits,
} from './workspace-storage-policy';
import {
  RuntimeKernelProcessSignalChannel,
  TRACEKERNEL_SIGNAL_NUMBERS,
  WorkspaceProcessState,
  normalizeTraceKernelSignal,
  type RuntimeKernelExecutionHandle,
  type RuntimeKernelFileDescriptorRecord,
  type RuntimeKernelProcessLaunchHooks,
  type RuntimeKernelProcessRecord,
  type RuntimeKernelProcessState,
  type RuntimeKernelSpawnedChild,
  type RuntimeKernelTtyName,
  type RuntimeTraceKernelAuthority,
} from './process-state';
import {
  TRACEKERNEL_HTTP_LISTENER_LIMIT,
  TRACEKERNEL_HTTP_MAX_BODY_BYTES,
  TRACEKERNEL_HTTP_MAX_HEADER_BYTES,
  TRACEKERNEL_HTTP_MAX_HEADER_COUNT,
  TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS,
  TRACEKERNEL_HTTP_REQUEST_FRAME_TIMEOUT_MS,
  TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT,
  TRACEKERNEL_HTTP_STATUS_TEXT,
  TRACEKERNEL_HTTP_TCP_READ_BYTES,
  WorkspaceHttpState,
  defaultRuntimeExternalHttpPort,
  isBareHostnameForExternalResolution,
  redactRuntimeDiagnosticUrl,
  syntheticIp,
  syntheticLatency,
  type HostResolution,
  type NormalizedRuntimeExternalHttpConfig,
  type RuntimeKernelHttpListenerOwner,
  type RuntimeKernelHttpListenerRecord,
  type RuntimeKernelHttpRequestRecord,
  type RuntimeKernelHttpTcpDispatchContext,
} from './http-state';
import { workspaceHttpPolicy } from './http-policy';
import {
  WorkspaceEventState,
  type KernelJournalEntry,
} from './workspace-event-state';
import { WorkspaceLifecycleState } from './workspace-lifecycle-state';
import { createWorkspaceShellCommandRegistry } from './shell-command-registry';
import { WorkspaceIdentityCommands } from './userland-identity-commands';
import { WorkspaceFilesystemCommands } from './userland-filesystem-commands';
import { WorkspaceNetworkCommands } from './userland-network-commands';
import { WorkspaceProcessInspection } from './userland-process-inspection';
import { WorkspaceTerminalCommands } from './userland-terminal-commands';
import { WorkspaceCommandCatalog } from './workspace-command-catalog';
import { WorkspaceProcFileSystem } from './workspace-proc-filesystem';
import { WorkspaceVirtualFileSystem } from './workspace-virtual-filesystem';
import { WorkspaceTerminalNavigation } from './workspace-terminal-navigation';
import { WorkspaceAccessPolicy } from './workspace-access-policy';
import { WorkspaceFileApi } from './workspace-file-api';
import { WorkspaceDeviceIo } from './workspace-device-io';
import { WorkspaceJournal } from './workspace-journal';

const PRINCIPAL_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('principal');
const RUNTIME_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('runtime');
const SYSTEM_ACTOR: RuntimeWorkspaceActor = runtimeWorkspaceActorPreset('system');
const TRACEKERNEL_SYSCALL_ERROR_CODES: ReadonlySet<TraceKernelSyscallErrorCode> = new Set([
  'E2BIG',
  'EAGAIN',
  'EACCES',
  'EADDRINUSE',
  'EAFNOSUPPORT',
  'EALREADY',
  'EBADF',
  'EBUSY',
  'ECHILD',
  'ECONNREFUSED',
  'EDESTADDRREQ',
  'EINPROGRESS',
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
  'ENOTTY',
  'EOPNOTSUPP',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'EROFS',
  'ESRCH',
]);

const TRACEKERNEL_ZOMBIE_RETENTION_MS = 30_000;

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
  private readonly traceKernelControlledRuntime =
    new TraceKernelControlledRuntime('tracecode.workspace-host');
  private readonly traceKernelFileSystem: TraceKernelFileSystem;
  private readonly traceKernelBackingFileSystem: TraceKernelBackingFileSystem;
  private readonly stopObservingExternalTraceKernelMutations: RuntimeWorkspaceUnsubscribe;
  private traceKernelAuthority?: RuntimeTraceKernelAuthority;
  private readonly fs: KernelObservedFileSystem;
  // Cached RuntimeFile objects are immutable; consumers must shallow-copy arrays before filtering.
  private snapshotCache: { version: number; files: RuntimeFile[]; directories: string[]; directoryMetadata: RuntimeDirectory[]; symlinks: RuntimeSymlink[]; kernelFiles: RuntimeFile[] } | null = null;
  private readonly fsLocks = new RuntimeFileSystemLockCoordinator();
  private readonly commandScheduler: RuntimeCommandScheduler;
  private readonly maxProcesses: number | null;
  private readonly httpState: WorkspaceHttpState;
  private readonly entrypoint?: string;
  private readonly kernelControl?: RuntimeTraceKernelControlOptions;
  private readonly cppRunner?: CppProjectCommandRunner;
  private readonly projectSessionCommands?: Record<string, RuntimeProjectSessionCommand>;
  private readonly hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  private readonly traceKernelCommandRegistry: TraceKernelCommandInfo[];
  private readonly traceKernelCommandDispatchNames: ReadonlyMap<string, string>;
  private readonly commandCatalog: WorkspaceCommandCatalog;
  private readonly procFiles: WorkspaceProcFileSystem;
  private readonly virtualFiles: WorkspaceVirtualFileSystem;
  private readonly fileApi: WorkspaceFileApi;
  private readonly deviceIo: WorkspaceDeviceIo;
  private readonly terminalNavigation: WorkspaceTerminalNavigation;
  private readonly identityCommands: WorkspaceIdentityCommands;
  private readonly virtualExecutableRecords = new Map<string, VirtualExecutableRecord>();
  private readonly processState = new WorkspaceProcessState();
  // Temporary 0.13 introspection aliases. The process state module remains
  // authoritative; these preserve existing hardening probes while 0.14 moves
  // callers onto explicit diagnostic APIs.
  private readonly processTable = this.processState.table;
  private readonly processExecutionHandles = this.processState.executionHandles;
  private readonly eventState = new WorkspaceEventState();
  private readonly journalState: WorkspaceJournal;
  private readonly lifecycleState: WorkspaceLifecycleState;
  private readonly terminalCommands = new WorkspaceTerminalCommands();
  private readonly filesystemCommands: WorkspaceFilesystemCommands;
  private readonly networkCommands: WorkspaceNetworkCommands;
  private readonly processInspection: WorkspaceProcessInspection;
  private readonly readonlyFiles = new Set<string>();
  private readonly accessPolicy: WorkspaceAccessPolicy;
  private kernelSyscallGenerationBuffer?: SharedArrayBuffer;
  private kernelSyscallGenerationUnsubscribe?: RuntimeWorkspaceUnsubscribe;

  constructor(options: CreateRuntimeWorkspaceOptions = {}) {
    this.kernelInfo = createTraceKernelInfo(options.kernel, options.cwd);
    this.baseEnv = { ...createTraceKernelEnvironment(this.kernelInfo), ...(options.env ?? {}) };
    this.httpState = new WorkspaceHttpState(options.externalHttp);
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
    this.lifecycleState = new WorkspaceLifecycleState({
      session: this.projectSession,
      workspaceRoot: this.cwd,
      isReadonlyPolicySuspended: () =>
        this.accessPolicy.isReadonlyPolicySuspended(),
      onExpired: (lifecycle) => {
        this.emitRuntimeEvent({
          type: 'lifecycle',
          phase: 'session-expired',
          message: 'Project session expired',
          detail: {
            ...(this.projectSession
              ? { sessionId: this.projectSession.id }
              : {}),
            expiresAt: lifecycle.expiresAt,
            expiredAt: lifecycle.expiredAt,
            expirationBehavior: lifecycle.expirationBehavior,
          },
          actor: SYSTEM_ACTOR,
        });
      },
      destroyExpired: () =>
        this.destroy({ reason: 'expired', clearStorage: true }),
    });
    for (const path of this.projectSession?.readonlyFiles ?? []) {
      this.readonlyFiles.add(path);
    }
    this.accessPolicy = new WorkspaceAccessPolicy({
      cwd: this.cwd,
      workspaceAlias: this.kernelInfo.workspaceAlias,
      readonlyFiles: this.readonlyFiles,
      hiddenFiles: this.projectSession?.hiddenFiles ?? [],
      ensureUsableForMutation: (operation) =>
        this.assertWorkspaceUsableForMutation(operation),
    });
    this.entrypoint = options.entrypoint ? this.toWorkspaceRelativePath(options.entrypoint) : undefined;
    this.kernelControl = options.kernelControl;
    this.cppRunner = options.cppRunner;
    this.kernel = this.createKernel();
    this.deviceIo = new WorkspaceDeviceIo({
      emitOutput: (event, context) =>
        this.emitLocalRuntimeEvent(event, context),
    });
    const storageLimits = normalizeRuntimeWorkspaceStorageLimits(options.storageLimits);
    this.traceKernelFileSystem = Effect.runSync(TraceKernelFileSystem.make({
      quota: {
        root: this.cwd,
        maxBytes: storageLimits.maxWorkspaceBytes,
        maxFileBytes: storageLimits.maxFileBytes,
        maxEntries: storageLimits.maxEntryCount,
      },
    }));
    this.traceKernelBackingFileSystem = new TraceKernelBackingFileSystem(
      this.traceKernelFileSystem
    );
    this.fs = new KernelObservedFileSystem(
      this.traceKernelBackingFileSystem,
      this.fsLocks,
      () => this.cwd,
      () => this.kernelInfo.workspaceAlias,
      () => this.kernelInfo,
      (absolutePath, operation) =>
        this.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          operation
        ),
      (absolutePath, operation) =>
        this.accessPolicy.assertWorkspaceSubtreeWritable(
          absolutePath,
          operation
        ),
      (absolutePath) =>
        this.accessPolicy.isWorkspacePathHidden(absolutePath),
      (event) => this.recordKernelEvent(event.type, event.pid, event.detail),
      this.createDynamicProcProvider(),
      (context, change) => {
        if (!context) return;
        this.emitLocalRuntimeEvent({ type: 'file-change', change, phase: 'live' }, context);
      },
      (context, device) => this.readDevice(device, context),
      (context, device, data) => this.writeDevice(device, data, context),
      storageLimits
    );
    this.filesystemCommands = new WorkspaceFilesystemCommands({
      cwd: this.cwd,
      kernelInfo: this.kernelInfo,
      storageUsage: () => this.fs.storageUsage(),
      allocateTemporaryEntry: () =>
        this.lifecycleState.allocateTemporaryEntry(),
    });
    this.networkCommands = new WorkspaceNetworkCommands({
      cwd: this.cwd,
      resolveHost: (hostname) => this.resolveHost(hostname),
      dispatchHttpRequest: (request, context, dispatchOptions) => {
        const commandContext =
          this.resolveCommandContext(context);
        return this.dispatchHttpRequest(request, {
          ...dispatchOptions,
          ...(context.signal
            ? { signal: context.signal }
            : {}),
          ...(commandContext?.actor
            ? { actor: commandContext.actor }
            : {}),
          ...(commandContext ? { commandContext } : {}),
        });
      },
    });
    this.processInspection = new WorkspaceProcessInspection({
      kernelInfo: this.kernelInfo,
      principalProcess: () => this.principalProcessRecord(),
      findProcess: (pid) => this.findProcessRecord(pid),
      signalProcess: (process, signal) =>
        this.queueKernelProcessSignal(process, signal),
    });
    this.journalState = new WorkspaceJournal({
      cwd: this.cwd,
      eventState: this.eventState,
      systemActor: SYSTEM_ACTOR,
      authoritativeProcessSnapshot: (process) =>
        this.authoritativeProcessSnapshot(process),
      resolveFileSystemMutationProcess: (mutation) => {
        const origin = mutation.origin as
          | { readonly pid?: unknown }
          | undefined;
        if (!origin || !Number.isSafeInteger(origin.pid)) {
          return undefined;
        }
        const process = this.processState.table.get(origin.pid as number);
        const kernelProcess = process
          ? this.kernelProcessFor(process)
          : undefined;
        if (
          !process ||
          kernelProcess?.fileSystemMutationOrigin !== origin
        ) {
          return undefined;
        }
        return {
          process,
          snapshot: kernelProcess.snapshot(),
        };
      },
      emitJournalEvent: (record, actor, commandContext) =>
        this.handleRuntimeCommandEvent(
          {
            type: 'kernel-journal',
            record,
            ...(actor ? { actor } : {}),
          },
          commandContext
        ),
    });
    this.stopObservingExternalTraceKernelMutations =
      this.traceKernelBackingFileSystem.watchExternalMutations((mutation) => {
        this.fs.observeExternalTraceKernelMutation(mutation);
        this.recordTraceKernelFileSystemMutation(mutation);
      });
    const withEvents = <Request extends RuntimeProjectCommandRequest<string>>(
      runner: RuntimeProjectCommandRunner<Request>,
      options: {
        kernelSyscalls?: boolean;
        descriptorStdio?: boolean;
      } = {}
    ): RuntimeProjectCommandRunner<Request> => {
      const descriptorStdio =
        options.descriptorStdio === true &&
        runner.capabilities?.descriptorStdio === true;
      return (async (request, ctx?: CommandContext) => {
        const commandContext = this.resolveCommandContext(ctx);
        const {
          stdinPipe: _legacyRequestStdinPipe,
          ...requestWithoutLegacyStdin
        } = request;
        const activeStdinPipe = request.source !== 'compile' && request.source !== 'stdin'
          ? commandContext?.stdinPipe
          : undefined;
        const stdinPipe = request.stdinPipe ?? activeStdinPipe;
        const signal = commandContext?.process
          ? this.processExecutionHandle(commandContext.process)?.abortController?.signal ??
            request.signal
          : request.signal;
        const runtimeIo = commandContext?.runtimeIo;
        let acceptingRunnerEvents = true;
        let result: RuntimeCommandResult;
        const kernelSyscalls = options.kernelSyscalls
          ? this.createKernelSyscallBridge(commandContext)
          : undefined;
        const executionHandle = commandContext
          ? this.processExecutionHandle(commandContext.process)
          : undefined;
        if (executionHandle) {
          executionHandle.descriptorStdio = descriptorStdio;
        }
        if (descriptorStdio && commandContext) {
          this.startHostStandardInputPump(commandContext);
        }
        const processSnapshot = commandContext?.process
          ? this.authoritativeProcessSnapshot(commandContext.process)
          : undefined;
        try {
          result = await runner({
            ...(descriptorStdio ? requestWithoutLegacyStdin : request),
            ...(commandContext?.process && processSnapshot
              ? {
                  process: {
                    pid: processSnapshot.pid,
                    ppid: processSnapshot.ppid,
                    pgid: processSnapshot.pgid,
                    sid: processSnapshot.sid,
                    descriptors: this.procFiles.descriptorNumbers(
                      commandContext.process as RuntimeKernelProcessRecord
                    ),
                  },
                }
              : {}),
            ...(
              stdinPipe && !descriptorStdio
                ? { stdinPipe: { buffer: stdinPipe.buffer } }
                : {}
            ),
            ...(commandContext?.terminal ? { terminal: commandContext.terminal } : {}),
            ...(commandContext?.engineLease
              ? { engineLease: commandContext.engineLease }
              : {}),
            ...(signal ? { signal } : {}),
            kernelHttp: this.createKernelHttpBridge(commandContext),
            ...(kernelSyscalls ? { kernelSyscalls } : {}),
            ...(executionHandle?.signalChannel
              ? { kernelSignals: executionHandle.signalChannel }
              : {}),
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
      }) as RuntimeProjectCommandRunner<Request>;
    };
    const observeFileChange: RuntimeFileChangeObserver = (change, phase, context) => {
      this.emitLocalRuntimeEvent({ type: 'file-change', change, phase }, context);
    };
    const packageManagerConfig = normalizePackageManagerConfig(
      options.packageManager,
      Boolean(options.nodeRunner || options.typescriptRunner)
    );
    this.traceKernelCommandRegistry = createTraceKernelCommandRegistry(options, packageManagerConfig);
    this.commandCatalog = new WorkspaceCommandCatalog(
      this.traceKernelCommandRegistry,
      () => this.traceKernelCommandDispatchNames
    );
    this.procFiles = new WorkspaceProcFileSystem({
      commandCatalog: this.commandCatalog,
      currentProcess: (context) => this.currentProcSelfRecord(context),
      processes: (actor) => this.kernelPresentationProcessRecords(actor),
      findProcess: (pid, actor) =>
        this.findKernelPresentationProcessRecord(pid, actor),
      authoritativeProcessSnapshot: (process) =>
        this.authoritativeProcessSnapshot(process),
      renderInodes: () => this.fs.renderInodes(),
      events: () => this.eventState.kernelEvents(),
      locks: () => this.fsLocks.snapshot(),
      httpListeners: () =>
        [...this.httpState.listeners.values()].map((listener) => listener.info),
      httpRequests: () => this.httpState.requestLog,
      scheduler: () => this.commandScheduler.snapshot(),
      processTableUsage: () => this.processTableUsage(),
      processTableLimit: () => this.processTableLimit(),
      nextPid: () => this.processState.nextPid,
    });
    this.virtualFiles = new WorkspaceVirtualFileSystem({
      kernelInfo: this.kernelInfo,
      commandCatalog: this.commandCatalog,
      procFiles: this.procFiles,
    });
    this.fileApi = new WorkspaceFileApi({
      cwd: this.cwd,
      kernelInfo: this.kernelInfo,
      fileSystem: this.fs,
      virtualFiles: this.virtualFiles,
      accessPolicy: this.accessPolicy,
      assertNotDestroyed: () => this.assertNotDestroyed(),
      ensureUsableForMutation: (operation) =>
        this.assertWorkspaceUsableForMutation(operation),
      assertActorFileCapability: (actor, capability, path) =>
        this.assertActorFileCapability(actor, capability, path),
      readDevice: (device) => this.readDevice(device),
      writeDevice: (device, data, actor) =>
        this.writeDevice(device, data, actor),
      emitFileChange: (event, process) =>
        this.emitLocalRuntimeEvent(event, undefined, process),
      invalidateSnapshotCache: () => {
        this.snapshotCache = null;
      },
    });
    this.terminalNavigation = new WorkspaceTerminalNavigation({
      cwd: this.cwd,
      kernelInfo: this.kernelInfo,
      fileSystem: this.fs,
      virtualFiles: this.virtualFiles,
      isProjectPathHidden: (path) =>
        this.accessPolicy.isProjectPathHidden(path),
    });
    this.identityCommands = new WorkspaceIdentityCommands({
      kernelInfo: this.kernelInfo,
      environment: this.baseEnv,
      commands: this.traceKernelCommandRegistry,
      resolveHost: (hostname) => this.resolveHost(hostname),
    });
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
    const runtimeCommands = [
      ...(options.pythonRunner ? createPythonProjectCommands(withEvents(options.pythonRunner, { kernelSyscalls: true, descriptorStdio: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.nodeRunner ? createNodeProjectCommands(withEvents(options.nodeRunner, { kernelSyscalls: true, descriptorStdio: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.typescriptRunner ? createTypeScriptProjectCommands(withEvents(options.typescriptRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(packageManagerConfig ? createPackageManagerProjectCommands(packageManagerConfig, this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, emitPackageManagerOutput, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand) : []),
      ...(options.javaRunner ? createJavaProjectCommands(withEvents(options.javaRunner, { kernelSyscalls: true, descriptorStdio: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
      ...(options.cppRunner ? createCppProjectCommands(withEvents(options.cppRunner, { kernelSyscalls: true, descriptorStdio: true }), this.cwd, {
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
      ...(options.csharpRunner ? createCSharpProjectCommands(withEvents(options.csharpRunner, { kernelSyscalls: true, descriptorStdio: true }), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo, this.projectSession?.readonlyFiles, this.projectSession?.hiddenFiles, includeHiddenFilesForCurrentCommand, snapshotProjectForCurrentCommand) : []),
    ];
    const shellCommands = createWorkspaceShellCommandRegistry({
      runtimeCommands,
      customCommands: options.customCommands,
      handlers: {
        exec: (args, context) => this.runTraceKernelExec(args, context),
        bg: (args, context) => this.runKernelJobPlacement(args, 'bg', context),
        curl: (args, context) =>
          this.networkCommands.curl(args, context),
        df: (args, context) =>
          this.filesystemCommands.df(args, context),
        du: (args, context) =>
          this.filesystemCommands.du(args, context),
        fastfetch: (args, context) =>
          this.identityCommands.fastfetch(
            args,
            this.terminalForCommand(context)
          ),
        fg: (args, context) => this.runKernelJobPlacement(args, 'fg', context),
        getconf: (args) => this.identityCommands.getconf(args),
        getent: (args) => this.identityCommands.getent(args),
        groups: (args) => this.identityCommands.groups(args),
        kill: (args, context) => this.runKernelKill(args, 'kill', context),
        jobs: (args, context) => {
          const commandContext =
            this.resolveCommandContext(context);
          return this.processInspection.jobs(
            args,
            this.kernelPresentationProcessRecords(
              commandContext?.actor
            ),
            commandContext?.process.pid
          );
        },
        hostname: (args) => this.identityCommands.hostname(args),
        id: (args) => this.identityCommands.id(args),
        lsof: (args) =>
          this.processInspection.lsof(
            args,
            [...this.httpState.listeners.values()].map(
              (listener) => listener.info
            )
          ),
        locale: (args) => this.identityCommands.locale(args),
        ls: (args, context) =>
          this.filesystemCommands.ls(args, context),
        man: (args) => this.runKernelMan(args),
        mktemp: (args, context) =>
          this.filesystemCommands.mktemp(args, context),
        mount: (args) => this.filesystemCommands.mount(args),
        neofetch: (args, context) =>
          this.identityCommands.fastfetch(
            args,
            this.terminalForCommand(context)
          ),
        pgrep: (args, context) => {
          const commandContext =
            this.resolveCommandContext(context);
          return this.processInspection.processMatch(
            args,
            'pgrep',
            [
              this.principalProcessRecord(),
              ...this.kernelPresentationProcessRecords(
                commandContext?.actor
              ),
            ].filter(
              (process) =>
                process.pid !== commandContext?.process.pid
            )
          );
        },
        ping: (args) => this.networkCommands.ping(args),
        pkill: (args, context) => {
          const commandContext =
            this.resolveCommandContext(context);
          return this.processInspection.processMatch(
            args,
            'pkill',
            [
              this.principalProcessRecord(),
              ...this.kernelPresentationProcessRecords(
                commandContext?.actor
              ),
            ].filter(
              (process) =>
                process.pid !== commandContext?.process.pid
            )
          );
        },
        ps: (args, context) => {
          const commandContext =
            this.resolveCommandContext(context);
          return this.processInspection.ps(args, [
            this.principalProcessRecord(),
            ...this.kernelPresentationProcessRecords(
              commandContext?.actor
            ),
          ]);
        },
        ss: (args) =>
          this.processInspection.ss(
            args,
            [...this.httpState.listeners.values()].map(
              (listener) => listener.info
            )
          ),
        stat: (args, context) =>
          this.filesystemCommands.stat(args, context),
        stty: (args, context) =>
          this.terminalCommands.stty(
            args,
            this.terminalForCommand(context)
          ),
        tput: (args, context) =>
          this.terminalCommands.tput(
            args,
            this.terminalForCommand(context)
          ),
        tracekernelctl: (args, context) => this.runTraceKernelCtl(args, context),
        tty: (args, context) =>
          this.terminalCommands.tty(
            args,
            this.terminalForCommand(context)
          ),
        umask: (args, context) =>
          this.terminalCommands.umask(
            args,
            this.resolveCommandContext(context)
          ),
        uname: (args) => this.identityCommands.uname(args),
        wait: (args, context) => this.runKernelWait(args, 'wait', context),
        wget: (args, context) =>
          this.networkCommands.wget(args, context),
        which: (args, context) => this.runTraceKernelWhich(args, 'which', context),
        whoami: (args) => this.identityCommands.whoami(args),
        command: (args, context) => this.runTraceKernelCommandBuiltin(args, context),
        test: (args, context) =>
          this.terminalCommands.testTerminal(
            args,
            'test',
            this.terminalForCommand(context)
          ),
        'test-bracket': (args, context) =>
          this.terminalCommands.testTerminal(
            args,
            '[',
            this.terminalForCommand(context)
          ),
      },
      help: (name, args) => this.commandCatalog.help(name, args),
      withSignalContext: (context) => this.withCurrentKernelSignal(context),
    });
    this.traceKernelCommandDispatchNames = shellCommands.dispatchNames;
    this.bashOptions = {
      fs: this.fs,
      cwd: this.cwd,
      env: this.baseEnv,
      commands: options.commands as never,
      customCommands: shellCommands.commands.length > 0
        ? [...shellCommands.commands]
        : undefined,
      python: options.python,
      javascript: options.javascript,
      executionLimits: options.executionLimits as never,
    };
    this.bash = this.createBash();
  }

  private withCurrentKernelSignal(ctx: CommandContext): CommandContext {
    const process = this.resolveCommandContext(ctx)?.process;
    const signal = process
      ? this.processExecutionHandle(process)?.abortController?.signal
      : undefined;
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
    const buffer = this.traceKernelFileSystem.sharedGenerationBuffer();
    this.kernelSyscallGenerationBuffer = buffer;
    return buffer;
  }

  private dispatchExtractedTraceKernelSyscall(
    request: TraceKernelSyscallRequest,
    context: RuntimeCommandExecutionContext | undefined
  ): Promise<TraceKernelSyscallResult> {
    const authority = this.traceKernelAuthority;
    const process = context?.process
      ? this.kernelProcessFor(context.process)
      : authority?.hostServiceProcess;
    if (!authority || !process) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'ESRCH',
          message: 'Runtime syscall is not attached to an authoritative TraceKernel process.',
        },
      });
    }
    return Effect.runPromise(
      new TraceKernelSyscallDispatcher(authority.session, process).dispatch(
        this.mapTraceKernelSyscallWorkspacePaths(request)
      )
    );
  }

  /**
   * `/workspace` is a stable process-visible mount alias, not a second TKFS
   * subtree. Resolve it at the syscall entrance so extracted runtimes and
   * product filesystem calls address the same authoritative inode namespace.
   */
  private mapTraceKernelSyscallWorkspacePaths(
    request: TraceKernelSyscallRequest
  ): TraceKernelSyscallRequest {
    const mapPath = (path: string): string =>
      path.startsWith('/')
        ? mapWorkspaceAlias(this.cwd, this.kernelInfo.workspaceAlias, path)
        : path;
    switch (request.op) {
      case 'watch':
      case 'open':
      case 'stat':
      case 'lstat':
      case 'realpath':
      case 'readdir':
      case 'mkdir':
      case 'rmdir':
      case 'unlink':
      case 'readlink':
      case 'readFile':
      case 'writeFile':
        return { ...request, path: mapPath(request.path) };
      case 'link':
        return {
          ...request,
          existingPath: mapPath(request.existingPath),
          newPath: mapPath(request.newPath),
        };
      case 'symlink':
        return {
          ...request,
          linkPath: mapPath(request.linkPath),
        };
      case 'rename':
        return {
          ...request,
          sourcePath: mapPath(request.sourcePath),
          destinationPath: mapPath(request.destinationPath),
        };
      default:
        return request;
    }
  }

  private dispatchKernelOwnedDescriptorSyscall(
    request: TraceKernelSyscallRequest,
    context: RuntimeCommandExecutionContext | undefined,
    actor: RuntimeWorkspaceActor
  ): Promise<TraceKernelSyscallResult> | undefined {
    const kernelProcess = context?.process
      ? this.kernelProcessFor(context.process)
      : this.traceKernelAuthority?.hostServiceProcess;
    if (!kernelProcess) {
      return undefined;
    }
    switch (request.op) {
      case 'watch':
        this.assertActorFileCapability(actor, 'read', request.path);
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      case 'isatty':
      case 'tcgetpgrp':
      case 'tcgetwinsize':
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      case 'tcsetpgrp':
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      case 'tcsetwinsize':
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      case 'bind':
      case 'listen':
        this.assertHttpCapability(actor, 'listen');
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      case 'connect':
        this.assertHttpCapability(actor, 'dispatch');
        return this.dispatchExtractedTraceKernelSyscall(request, context);
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
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      }
      case 'write': {
        if (!context) {
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        const descriptor = kernelProcess
          .snapshot()
          .descriptors.find(
            (candidate) => candidate.fd === request.fd
          );
        const currentHandle = this.processExecutionHandle(
          context.process as RuntimeKernelProcessRecord
        );
        const hostOutputHandle = currentHandle?.hostStandardIo &&
          (
            descriptor?.resourceId === currentHandle.hostStandardIo.stdoutResourceId ||
            descriptor?.resourceId === currentHandle.hostStandardIo.stderrResourceId
          )
          ? currentHandle
          : [...this.processState.executionHandles.values()].find((candidate) =>
              descriptor?.resourceId === candidate.hostStandardIo?.stdoutResourceId ||
              descriptor?.resourceId === candidate.hostStandardIo?.stderrResourceId
            );
        const hostStandardIo = hostOutputHandle?.hostStandardIo;
        const outputStream =
          descriptor?.kind === 'terminal'
            ? request.fd === 2 ? 'stderr' as const : 'stdout' as const
            : descriptor?.resourceId === hostStandardIo?.stdoutResourceId
              ? 'stdout' as const
              : descriptor?.resourceId === hostStandardIo?.stderrResourceId
                ? 'stderr' as const
                : undefined;
        const dispatched = this.dispatchExtractedTraceKernelSyscall(
          request,
          context
        );
        if (!outputStream || !descriptor) return dispatched;
        return dispatched.then(async (result) => {
          if (
            result.ok &&
            result.value.op === 'write' &&
            result.value.bytesWritten > 0
          ) {
            if (descriptor.kind === 'terminal') {
              await Effect.runPromise(
                this.traceKernelAuthority!.session.readTerminalOutput(
                  descriptor.resourceId,
                  result.value.bytesWritten,
                  true
                )
              );
            }
            const outputContext =
              descriptor.kind === 'terminal'
                ? context
                : hostOutputHandle?.hostOutputContext ?? context;
            const data = this.captureDeviceOutput(
              outputContext,
              outputStream,
              new TextDecoder().decode(
                request.bytes.slice(0, result.value.bytesWritten)
              )
            );
            if (data) {
              this.emitLocalRuntimeEvent({
                type: 'output',
                stream: outputStream,
                device: outputStream === 'stderr' ? '/dev/stderr' : '/dev/stdout',
                data,
                actor: context.actor,
              }, outputContext);
            }
          }
          return result;
        });
      }
      case 'pipe':
      case 'socket':
      case 'accept':
      case 'send':
      case 'recv':
      case 'shutdown':
      case 'getsockname':
      case 'getpeername':
      case 'getsockopt':
      case 'read':
      case 'seek':
      case 'close':
      case 'dup':
      case 'dup2':
      case 'dup3':
      case 'fcntl':
      case 'poll':
      case 'fstat':
      case 'ftruncate':
        return this.dispatchExtractedTraceKernelSyscall(request, context);
      default:
        return undefined;
    }
  }

  private dispatchKernelOwnedProcessControlSyscall(
    request: TraceKernelSyscallRequest,
    context: RuntimeCommandExecutionContext | undefined
  ): Promise<TraceKernelSyscallResult> | undefined {
    if (!context?.process || !this.kernelProcessFor(context.process)) {
      return undefined;
    }
    switch (request.op) {
      case 'identity':
      case 'processInfo':
      case 'processList':
      case 'environment':
      case 'kill':
      case 'setsid':
      case 'setpgid':
      case 'watchdog':
        return this.dispatchExtractedTraceKernelSyscall(request, context).then(
          (result) => {
            if (
              result.ok &&
              (request.op === 'setsid' || request.op === 'setpgid')
            ) {
              this.notifyRuntimeChildSelectorWaiters();
            }
            return result;
          }
        );
      default:
        return undefined;
    }
  }

  private async dispatchRuntimeKernelSyscall(
    request: TraceKernelSyscallRequest,
    context?: RuntimeCommandExecutionContext
  ): Promise<TraceKernelSyscallResult> {
    const actor = context?.actor ?? SYSTEM_ACTOR;
    if (context) {
      context.liveKernelSyscallDepth = (context.liveKernelSyscallDepth ?? 0) + 1;
    }
    try {
      const descriptorResult = this.dispatchKernelOwnedDescriptorSyscall(
        request,
        context,
        actor
      );
      if (descriptorResult) return descriptorResult;
      const processControlResult =
        this.dispatchKernelOwnedProcessControlSyscall(request, context);
      if (processControlResult) return processControlResult;
      switch (request.op) {
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
          const result = await this.dispatchExtractedTraceKernelSyscall(
            request,
            context
          );
          if (
            result.ok &&
            result.value.op === 'wait' &&
            result.value.termination
          ) {
            const projectedChild = await this.waitRuntimeSyscallChild(
              process,
              result.value.pid,
              false,
              true
            );
            if (!projectedChild || projectedChild.pid !== result.value.pid) {
              throw Object.assign(
                new Error(
                  `ECHILD: kernel-reaped child ${result.value.pid} has no product lifecycle projection`
                ),
                { code: 'ECHILD' }
              );
            }
          }
          return result;
        }
        case 'readFile': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'writeFile': {
          this.assertActorFileCapability(actor, 'write', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'stat': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'lstat': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'realpath': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'readdir': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'mkdir': {
          this.assertActorFileCapability(actor, 'write', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'rmdir': {
          this.assertActorFileCapability(actor, 'delete', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'unlink': {
          this.assertActorFileCapability(actor, 'delete', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'link': {
          this.assertActorFileCapability(actor, 'read', request.existingPath);
          this.assertActorFileCapability(actor, 'write', request.newPath);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'symlink': {
          this.assertActorFileCapability(actor, 'write', request.linkPath);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'readlink': {
          this.assertActorFileCapability(actor, 'read', request.path);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
        }
        case 'rename': {
          this.assertActorFileCapability(actor, 'delete', request.sourcePath);
          this.assertActorFileCapability(actor, 'write', request.destinationPath);
          return this.dispatchExtractedTraceKernelSyscall(request, context);
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
    if (!process || this.processState.table.get(process.pid) !== process) {
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
    await this.awaitControlPlaneProcessDisposals();
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
    const descriptorStdio =
      request.runtime === 'javascript' ||
      request.runtime === 'cpp' ||
      request.runtime === 'csharp' ||
      request.runtime === 'python' ||
      request.runtime === 'java';
    const stdinPipe = !descriptorStdio && request.stdio?.stdin === 'pipe'
      ? createRuntimeCommandStdinPipe()
      : !descriptorStdio && request.stdio?.stdin === 'inherit'
        ? parentContext?.stdinPipe
        : undefined;
    const parentStdio: {
      stdinFd?: number;
      stdoutFd?: number;
      stderrFd?: number;
    } = {};
    const authority = this.traceKernelAuthority;
    const parentKernelProcess = this.kernelProcessFor(parent);
    if (!authority || !parentKernelProcess) {
      throw Object.assign(
        new Error('ESRCH: parent is not attached to the authoritative TraceKernel session'),
        { code: 'ESRCH' }
      );
    }
    const parentSnapshot = parentKernelProcess.snapshot();
    const kernelChildSpec = {
      runtime: this.traceKernelControlledRuntime.runtime,
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      inheritDescriptors: request.inheritDescriptors,
      descriptorMappings: request.descriptorMappings,
      descriptorActions: request.descriptorActions,
      processGroupId: request.processGroupId,
      sessionId: request.sessionId,
    };
    const kernelSpawned = request.stdio
      ? await Effect.runPromise(
          authority.session.spawnChildWithStdio(
            parentKernelProcess,
            kernelChildSpec,
            request.stdio
          )
        )
      : {
          process: await Effect.runPromise(
            authority.session.spawnChild(parentKernelProcess, kernelChildSpec)
          ),
        };
    Object.assign(parentStdio, kernelSpawned.stdio ?? {});
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
          const childProcess = this.kernelProcessFor(
            childContext!.process as RuntimeKernelProcessRecord
          );
          if (!childProcess) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          await Effect.runPromise(
            childProcess.write(
              fd,
              bytes
            )
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
        ...(parentSnapshot.controllingTerminalId !== undefined
          ? {
              presentation: 'terminal' as const,
              foreground: false,
              terminal: parentContext?.terminal,
            }
          : {}),
        retainOnExit: true,
        onEvent: (event) => {
          if (event.type === 'output') routeOutput(event.stream, event.data);
        },
      },
      parent,
      {
        kernelProcess: kernelSpawned.process,
        preserveKernelStandardIo: request.stdio !== undefined,
        initialize: async (child, context) => {
          childContext = context;
          try {
            if (!descriptorStdio && request.stdio?.stdin === 'pipe' && stdinPipe) {
              stdinPump = (async () => {
                try {
                  while (true) {
                    const kernelChild = this.kernelProcessFor(child);
                    if (!kernelChild) {
                      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
                    }
                    const bytes = await Effect.runPromise(
                      kernelChild.read(0, 16 * 1024)
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
          } catch (error) {
            await Effect.runPromise(
              Effect.forEach(
                Object.values(parentStdio),
                (fd) =>
                parentKernelProcess.close(fd).pipe(
                  Effect.catchAll(() => Effect.void)
                ),
                { concurrency: 'unbounded', discard: true }
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
    let unadmittedCleanupStarted = false;
    const rejectUnadmittedChild = async (error: unknown): Promise<void> => {
      if (created || unadmittedCleanupStarted) return;
      unadmittedCleanupStarted = true;
      await Effect.runPromise(
        Effect.forEach(
          Object.values(parentStdio),
          (fd) =>
            parentKernelProcess.close(fd).pipe(
              Effect.catchAll(() => Effect.void)
            ),
          { concurrency: 'unbounded', discard: true }
        )
      );
      await Effect.runPromise(kernelSpawned.process.signal('SIGKILL'))
        .catch(() => undefined);
      await Effect.runPromise(kernelSpawned.process.wait())
        .catch(() => undefined);
      await this.reapControlledTraceKernelChild(parent, kernelSpawned.process.pid);
      rejectCreated(error);
    };
    void completion.then(
      async (result) => {
        if (!created) {
          await rejectUnadmittedChild(Object.assign(
            new Error(
              result.error?.message ??
              `EIO: child process '${command}' completed before admission`
            ),
            { code: result.error?.code ?? 'EIO' }
          ));
        }
      },
      async (error) => {
        if (!created) await rejectUnadmittedChild(error);
      }
    );
    return childCreated;
  }

  private async waitRuntimeSyscallChild(
    parent: RuntimeKernelProcessRecord,
    selector: number,
    noHang = false,
    kernelAlreadyReaped = false
  ): Promise<RuntimeKernelProcessRecord | undefined> {
    if (!Number.isSafeInteger(selector)) {
      throw Object.assign(
        new Error(`ECHILD: invalid child selector ${selector}`),
        { code: 'ECHILD' }
      );
    }
    const parentSnapshot = this.authoritativeProcessSnapshot(parent);
    if (!parentSnapshot) {
      throw Object.assign(
        new Error(`ECHILD: parent process ${parent.pid} does not exist`),
        { code: 'ECHILD' }
      );
    }
    const matchesSelector = (child: RuntimeKernelProcessRecord): boolean => {
      const childSnapshot = this.authoritativeProcessSnapshot(child);
      if (
        this.processState.childWaits.has(child.pid)
      ) {
        return false;
      }
      if (!childSnapshot) {
        return kernelAlreadyReaped && selector > 0 && child.pid === selector;
      }
      if (childSnapshot.ppid !== parentSnapshot.pid) return false;
      if (selector > 0) return child.pid === selector;
      if (selector === -1) return true;
      const processGroupId = selector === 0 ? parentSnapshot.pgid : -selector;
      return childSnapshot.pgid === processGroupId;
    };

    while (true) {
      const candidates = this.activeProcessRecords().filter(matchesSelector);
      if (candidates.length === 0) {
        throw Object.assign(
          new Error(
            `ECHILD: selector ${selector} has no unreaped children of process ${parent.pid}`
          ),
          { code: 'ECHILD' }
        );
      }
      const zombie = candidates.find((child) =>
        (
          kernelAlreadyReaped ||
          this.authoritativeProcessSnapshot(child)?.phase === 'exited'
        ) &&
        this.processState.zombies.has(child.pid)
      );
      if (!zombie) {
        if (noHang) return undefined;
        await new Promise<void>((resolve) => {
          this.processState.childSelectorWaiters.push(resolve);
        });
        continue;
      }

      this.processState.childWaits.add(zombie.pid);
      try {
        const outcome = this.processState.zombies.get(zombie.pid)?.outcome;
        this.processState.zombies.delete(zombie.pid);
        this.processState.waitRequests.delete(zombie.pid);
        if (!kernelAlreadyReaped) {
          await this.reapControlledTraceKernelChild(parent, zombie.pid);
        }
        this.recordKernelEvent('process-reap', zombie.pid, {
          exitCode: outcome?.exitCode ?? 0,
          signal: outcome?.signal,
          parentPid: parent.pid,
        });
        return zombie;
      } finally {
        this.processState.childWaits.delete(zombie.pid);
      }
    }
  }

  private notifyRuntimeChildSelectorWaiters(): void {
    const waiters = this.processState.childSelectorWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
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
      return workspaceHttpPolicy.errorResponse(
        400,
        workspaceHttpPolicy.createError('EINVAL', `EINVAL: invalid URL: ${options.url}`)
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
        error: workspaceHttpPolicy.createError('ENOTFOUND', message),
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
      error: workspaceHttpPolicy.createError('EHOSTUNREACH', message),
    };
  }

  public resolveHost(hostname: string): HostResolution {
    const host = String(hostname).trim().toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return { reachable: true, via: 'loopback', ip: '127.0.0.1', latencyMs: 0.05 };
    }
    for (const listener of this.httpState.listeners.values()) {
      if (listener.info.host === host) {
        return { reachable: true, via: 'listener', ip: syntheticIp(host), latencyMs: syntheticLatency(host) };
      }
    }
    if (this.httpState.external && this.isExternalHttpHostReachable(this.httpState.external, host)) {
      return { reachable: true, via: 'external', ip: syntheticIp(host), latencyMs: syntheticLatency(host) };
    }
    return { reachable: false, reason: 'unknown-host' };
  }

  private normalizeHttpListenPort(port: number): number {
    const normalized = Math.trunc(Number(port));
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 65535) {
      throw Object.assign(new Error(`EADDRNOTAVAIL: invalid port '${port}'`), { code: 'EADDRNOTAVAIL' });
    }
    if (normalized !== 0) return normalized;
    for (let attempt = 0; attempt < 16384; attempt += 1) {
      const candidate = this.httpState.nextEphemeralPort;
      this.httpState.nextEphemeralPort += 1;
      if (this.httpState.nextEphemeralPort > 65535) this.httpState.nextEphemeralPort = 49152;
      if (!this.hasHttpListenerOnPort(candidate, 'http')) return candidate;
    }
    throw Object.assign(new Error('EADDRNOTAVAIL: no ephemeral ports available'), { code: 'EADDRNOTAVAIL' });
  }

  private httpListenerKey(host: string, port: number, protocol: 'http'): string {
    return `${protocol}:${host}:${port}`;
  }

  private hasHttpListenerOnPort(port: number, protocol: 'http'): boolean {
    for (const listener of this.httpState.listeners.values()) {
      if (listener.info.protocol === protocol && listener.info.port === port) return true;
    }
    return false;
  }

  private findHttpBindConflict(host: string, port: number, protocol: 'http'): RuntimeKernelHttpListenerRecord | undefined {
    for (const listener of this.httpState.listeners.values()) {
      if (listener.info.protocol !== protocol || listener.info.port !== port) continue;
      if (
        listener.info.host === host ||
        workspaceHttpPolicy.isWildcardHost(listener.info.host) ||
        workspaceHttpPolicy.isWildcardHost(host)
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
    const host = workspaceHttpPolicy.normalizeListenHost(options.host, actor);
    const port = this.normalizeHttpListenPort(options.port);
    const key = this.httpListenerKey(host, port, protocol);
    if (!this.httpState.listeners.has(key) && this.httpState.listeners.size >= TRACEKERNEL_HTTP_LISTENER_LIMIT) {
      throw Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });
    }
    if (this.findHttpBindConflict(host, port, protocol)) {
      throw Object.assign(new Error(`EADDRINUSE: address already in use ${host}:${port}`), { code: 'EADDRINUSE' });
    }
    const info: RuntimeKernelHttpListenerInfo = {
      id: `${listenerOwner.idPrefix}-${this.httpState.nextListenerSeq++}`,
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
    this.httpState.listeners.set(key, listener);
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
      fd = await this.openHttpTcpSocket(listener.info.pid);
      listener.listenerFd = fd;
      if (listener.closed || this.httpState.listeners.get(key) !== listener) {
        await this.closeHttpTcpDescriptor(listener.info.pid, fd);
        listener.listenerFd = undefined;
        return;
      }
      const localTransportHost =
        listener.info.host === '127.0.0.1' || listener.info.host === '0.0.0.0';
      listener.transportAddress = await this.bindHttpTcpSocket(
        listener.info.pid,
        fd,
        localTransportHost
          ? { host: listener.info.host, port: listener.info.port }
          : { host: '127.0.0.1', port: 0 }
      );
      await this.listenHttpTcpSocket(listener.info.pid, fd, {
        backlog: TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS,
      });
      if (listener.closed || this.httpState.listeners.get(key) !== listener) {
        await this.closeHttpTcpDescriptor(listener.info.pid, fd);
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
          error: workspaceHttpPolicy.sanitizeDiagnosticField(
            error instanceof Error ? error.message : String(error)
          ),
        });
      });
    } catch (error) {
      if (this.httpState.listeners.get(key) === listener) this.httpState.listeners.delete(key);
      listener.closed = true;
      if (fd !== undefined) {
        await this.closeHttpTcpDescriptor(listener.info.pid, fd);
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
    if (this.httpState.listeners.get(key) === listener) this.httpState.listeners.delete(key);
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
      this.httpState.retiredListeners.add(listener);
    }
    if (listener.listenerFd !== undefined) {
      void this.closeHttpTcpDescriptor(
        listener.info.pid,
        listener.listenerFd
      );
    }
  }

  private forceCloseHttpConnections(listener: RuntimeKernelHttpListenerRecord): void {
    this.httpState.retiredListeners.delete(listener);
    for (const [fd, controller] of listener.connectionControllers) {
      if (!controller.signal.aborted) controller.abort();
      void this.closeHttpTcpDescriptor(listener.info.pid, fd);
    }
    listener.connectionControllers.clear();
  }

  private async serveHttpTcpListener(
    listener: RuntimeKernelHttpListenerRecord
  ): Promise<void> {
    const listenerFd = listener.listenerFd;
    if (listenerFd === undefined) return;
    while (!listener.closed) {
      let accepted: {
        readonly fd: number;
        readonly localAddress: { readonly host: string; readonly port: number };
        readonly remoteAddress: { readonly host: string; readonly port: number };
      };
      try {
        accepted = await this.acceptHttpTcpSocket(listener.info.pid, listenerFd);
      } catch (error) {
        if (listener.closed) return;
        throw error;
      }
      if (listener.closed) {
        await this.closeHttpTcpDescriptor(listener.info.pid, accepted.fd);
        return;
      }
      if (
        listener.connectionControllers.size >=
        TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS
      ) {
        await this.closeHttpTcpDescriptor(listener.info.pid, accepted.fd);
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
            error: workspaceHttpPolicy.sanitizeDiagnosticField(
              error instanceof Error ? error.message : String(error)
            ),
          });
        })
        .finally(() => {
          listener.connectionControllers.delete(accepted.fd);
          if (listener.closed && listener.connectionControllers.size === 0) {
            this.httpState.retiredListeners.delete(listener);
          }
          void this.closeHttpTcpDescriptor(listener.info.pid, accepted.fd);
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
    const context = this.httpState.tcpDispatches.get(remotePort);
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
          void this.closeHttpTcpDescriptor(listener.info.pid, fd);
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
        response = workspaceHttpPolicy.normalizeResponse(await listener.handler(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordKernelEvent('net-error', listener.info.pid, {
          id: listener.info.id,
          protocol: listener.info.protocol,
          phase: 'handler',
          error: workspaceHttpPolicy.sanitizeDiagnosticField(message),
        });
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
    await this.writeHttpTcpDescriptor(
      listener.info.pid,
      fd,
      responseBytes,
      undefined
    );
    await this.shutdownHttpTcpSocket(listener.info.pid, fd, 'write');
  }

  private closeHttpListenersForProcess(pid: number): void {
    for (const [key, listener] of this.httpState.listeners) {
      if (listener.info.pid !== pid) continue;
      this.closeHttpListener(key, listener, true);
    }
    for (const listener of this.httpState.retiredListeners) {
      if (listener.info.pid === pid) this.forceCloseHttpConnections(listener);
    }
  }

  private closeAllHttpListeners(): void {
    for (const [key, listener] of this.httpState.listeners) {
      this.closeHttpListener(key, listener, true);
    }
    for (const listener of this.httpState.retiredListeners) {
      this.forceCloseHttpConnections(listener);
    }
    this.httpState.tcpDispatches.clear();
  }

  private findHttpListener(url: URL): RuntimeKernelHttpListenerRecord | undefined {
    if (url.protocol !== 'http:') return undefined;
    const host = workspaceHttpPolicy.normalizeConnectHost(url.hostname);
    const port = workspaceHttpPolicy.normalizeConnectPort(url.port ? Number(url.port) : 80);
    const exact = this.httpState.listeners.get(this.httpListenerKey(host, port, 'http'));
    if (exact) return exact;
    return workspaceHttpPolicy.isWildcardConnectHost(host)
      ? this.httpState.listeners.get(this.httpListenerKey('0.0.0.0', port, 'http'))
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

  /**
   * HTTP is a protocol adapter over the same process-owned TCP descriptors
   * exposed to language runtimes. Public PID 0 denotes the trusted host, while
   * its physical descriptors belong to an invisible process in this session.
   */
  private traceKernelNetworkProcess(pid: number): TraceKernelProcess | undefined {
    return pid > 0
      ? this.processState.executionHandles.get(pid)?.kernelProcess
      : this.traceKernelAuthority?.hostServiceProcess;
  }

  private requireTraceKernelNetworkProcess(pid: number): {
    readonly authority: RuntimeTraceKernelAuthority;
    readonly process: TraceKernelProcess;
  } {
    const authority = this.traceKernelAuthority;
    const process = this.traceKernelNetworkProcess(pid);
    if (!authority || !process) {
      throw Object.assign(
        new Error(
          `ESRCH: process ${pid} is not attached to the authoritative TraceKernel network namespace`
        ),
        { code: 'ESRCH' }
      );
    }
    return { authority, process };
  }

  private async openHttpTcpSocket(pid: number): Promise<number> {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(authority.session.createTcpSocket(process));
  }

  private async bindHttpTcpSocket(
    pid: number,
    fd: number,
    address: Extract<TraceKernelSyscallRequest, { op: 'bind' }>['address']
  ) {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(authority.session.bindTcp(process, fd, address));
  }

  private async listenHttpTcpSocket(
    pid: number,
    fd: number,
    options?: Extract<TraceKernelSyscallRequest, { op: 'listen' }>['options']
  ): Promise<void> {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    await Effect.runPromise(authority.session.listenTcp(process, fd, options));
  }

  private async acceptHttpTcpSocket(pid: number, fd: number) {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(authority.session.acceptTcp(process, fd));
  }

  private async connectHttpTcpSocket(
    pid: number,
    fd: number,
    address: Extract<TraceKernelSyscallRequest, { op: 'connect' }>['address']
  ) {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(authority.session.connectTcp(process, fd, address));
  }

  private async shutdownHttpTcpSocket(
    pid: number,
    fd: number,
    how: Extract<TraceKernelSyscallRequest, { op: 'shutdown' }>['how']
  ): Promise<void> {
    const { authority, process } = this.requireTraceKernelNetworkProcess(pid);
    await Effect.runPromise(authority.session.shutdownTcp(process, fd, how));
  }

  private async readHttpTcpDescriptor(
    pid: number,
    fd: number,
    maxBytes: number,
    _context?: RuntimeCommandExecutionContext
  ): Promise<Uint8Array> {
    const { process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(process.read(fd, maxBytes));
  }

  private async writeHttpTcpDescriptor(
    pid: number,
    fd: number,
    bytes: Uint8Array,
    _context?: RuntimeCommandExecutionContext
  ): Promise<number> {
    const { process } = this.requireTraceKernelNetworkProcess(pid);
    return Effect.runPromise(process.write(fd, bytes));
  }

  private async closeHttpTcpDescriptor(pid: number, fd: number): Promise<void> {
    const { process } = this.requireTraceKernelNetworkProcess(pid);
    await Effect.runPromise(
      process.close(fd).pipe(Effect.catchAll(() => Effect.void))
    );
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
      const bytes = await this.readHttpTcpDescriptor(
        pid,
        fd,
        TRACEKERNEL_HTTP_TCP_READ_BYTES,
        context
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
        void this.closeHttpTcpDescriptor(pid, fd);
      }
      abortReject?.(abortError);
    };
    try {
      fd = await this.openHttpTcpSocket(pid);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      await Promise.race([
        this.connectHttpTcpSocket(pid, fd, {
          host: workspaceHttpPolicy.normalizeConnectHost(url.hostname),
          port: workspaceHttpPolicy.normalizeConnectPort(url.port ? Number(url.port) : 80),
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
        this.writeHttpTcpDescriptor(pid, fd, bytes, commandContext),
        aborted,
      ]);
      await Promise.race([
        this.shutdownHttpTcpSocket(pid, fd, 'write'),
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
        await this.closeHttpTcpDescriptor(pid, fd);
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
        void this.closeHttpTcpDescriptor(clientPid, clientFd);
      }
      abortReject?.(abortError);
    };

    try {
      clientFd = await this.openHttpTcpSocket(clientPid);
      const localAddress = await this.bindHttpTcpSocket(clientPid, clientFd, {
        host: '127.0.0.1',
        port: 0,
      });
      clientPort = localAddress.port;
      this.httpState.tcpDispatches.set(clientPort, dispatchContext);
      await this.connectHttpTcpSocket(clientPid, clientFd, {
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
      await this.writeHttpTcpDescriptor(
        clientPid,
        clientFd,
        requestBytes,
        commandContext
      );
      await this.shutdownHttpTcpSocket(clientPid, clientFd, 'write');

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
        this.httpState.tcpDispatches.get(clientPort) === dispatchContext
      ) {
        this.httpState.tcpDispatches.delete(clientPort);
      }
      if (clientFd !== undefined) {
        await this.closeHttpTcpDescriptor(clientPid, clientFd);
      }
    }
  }

  private recordHttpRequest(entry: Omit<RuntimeKernelHttpRequestRecord, 'seq' | 'time'>): void {
    this.httpState.requestLog.push({
      seq: this.httpState.nextRequestSeq++,
      time: new Date().toISOString(),
      ...entry,
      url: redactRuntimeDiagnosticUrl(entry.url),
    });
    if (this.httpState.requestLog.length > TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT) {
      this.httpState.requestLog.splice(0, this.httpState.requestLog.length - TRACEKERNEL_HTTP_REQUEST_LOG_LIMIT);
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
        return `host allowlist predicate failed: ${workspaceHttpPolicy.sanitizeDiagnosticField(error instanceof Error ? error.message : String(error))}`;
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
    if (this.httpState.workspaceExternalRequestCount >= config.maxRequestsPerCommand) return false;
    this.httpState.workspaceExternalRequestCount += 1;
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
    if (this.httpState.lifecycleAbortController.signal.aborted) {
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
      this.httpState.lifecycleAbortController.signal.addEventListener('abort', lifecycleAbortListener, { once: true });
    }));
    try {
      return await Promise.race(races);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (lifecycleAbortListener) {
        this.httpState.lifecycleAbortController.signal.removeEventListener('abort', lifecycleAbortListener);
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
      error: workspaceHttpPolicy.sanitizeDiagnosticField(`${error}:${reason}`),
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
      error: workspaceHttpPolicy.createError(publicCode, `${publicCode}: ${publicMessage}`),
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
          error: workspaceHttpPolicy.sanitizeDiagnosticField(`ENOTFOUND:${blocklistReason}`),
          external: true,
        });
        this.recordHttpJournal(normalizedRequest, url, 'external', actor, options.commandContext, { error: 'ENOTFOUND' });
        return {
          status: 0,
          body: `${message}\n`,
          error: workspaceHttpPolicy.createError('ENOTFOUND', message),
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
          error: workspaceHttpPolicy.createError('ENOTFOUND', message),
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
    if (options.signal?.aborted || this.httpState.lifecycleAbortController.signal.aborted) {
      const body = this.httpState.lifecycleAbortController.signal.aborted
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
        error: workspaceHttpPolicy.createError('EINTR', body.trim()),
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
    if (this.httpState.activeExternalRequests >= config.maxConcurrentRequests) {
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
      return workspaceHttpPolicy.errorResponse(
        400,
        workspaceHttpPolicy.createError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
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
      return { status: 0, body, error: workspaceHttpPolicy.createError(error, body.trim()) };
    };
    this.httpState.activeExternalRequests += 1;
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
        const normalizedResponse = workspaceHttpPolicy.normalizeResponse(await config.fetch(externalRequest));
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
        const message = workspaceHttpPolicy.sanitizeDiagnosticField(error instanceof Error ? error.message : String(error));
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
          error: workspaceHttpPolicy.createError(publicCode, publicMessage),
        };
      } finally {
        this.httpState.activeExternalRequests = Math.max(0, this.httpState.activeExternalRequests - 1);
      }
    }, settleFailure, () => {
      this.httpState.activeExternalRequests = Math.max(0, this.httpState.activeExternalRequests - 1);
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
    if (this.httpState.activeRequests >= TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS) {
      return {
        status: 503,
        body: 'Resource temporarily unavailable\n',
        error: workspaceHttpPolicy.createError('EAGAIN', 'Resource temporarily unavailable'),
      };
    }
    const timeoutMs = options.timeoutMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return workspaceHttpPolicy.errorResponse(
        400,
        workspaceHttpPolicy.createError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
      );
    }
    if (options.signal?.aborted) {
      return {
        status: 0,
        body: 'Network request aborted\n',
        error: workspaceHttpPolicy.createError('EINTR', 'Network request aborted'),
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
        error: workspaceHttpPolicy.createError(error, body.trim()),
      };
    };

    this.httpState.activeRequests += 1;
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
          this.httpState.activeRequests = Math.max(0, this.httpState.activeRequests - 1);
        }
      },
      settleFailure,
      () => {
        this.httpState.activeRequests = Math.max(0, this.httpState.activeRequests - 1);
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
      return workspaceHttpPolicy.errorResponse(403, workspaceHttpPolicy.errorFromThrown(error, 'EACCES'));
    }
    const normalizedResult = workspaceHttpPolicy.normalizeRequest(request);
    if (!normalizedResult.ok) {
      return workspaceHttpPolicy.errorResponse(400, normalizedResult.error);
    }
    const normalizedRequest = normalizedResult.request;
    let url: URL;
    try {
      url = new URL(normalizedRequest.url);
    } catch {
      return workspaceHttpPolicy.errorResponse(400, workspaceHttpPolicy.createError('EINVAL', 'curl: invalid URL'));
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
      return workspaceHttpPolicy.errorResponse(400, workspaceHttpPolicy.errorFromThrown(error, 'EINVAL'));
    }
    if (this.httpState.lifecycleAbortController.signal.aborted) {
      this.recordHttpRequest({
        ...(listener ? { listenerId: listener.info.id, pid: listener.info.pid } : {}),
        method: normalizedRequest.method,
        url: normalizedRequest.url,
        error: 'EINTR',
        ...(!listener && this.httpState.external ? { external: true as const } : {}),
      });
      if (listener || this.httpState.external) {
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
        error: workspaceHttpPolicy.createError('EINTR', 'Network request interrupted'),
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
      if (this.httpState.external) {
        return this.dispatchExternalHttpRequest(this.httpState.external, normalizedRequest, url, actor, options);
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
        error: workspaceHttpPolicy.createError('ECONNREFUSED', `ECONNREFUSED: Failed to connect to ${url.hostname} port ${url.port || '80'}`),
      };
    }
    if (this.httpState.activeRequests >= TRACEKERNEL_HTTP_MAX_IN_FLIGHT_REQUESTS) {
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
        error: workspaceHttpPolicy.createError('EAGAIN', 'Resource temporarily unavailable'),
      };
    }
    const timeoutMs = options.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(Number(options.timeoutMs)));
    if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
      return workspaceHttpPolicy.errorResponse(
        400,
        workspaceHttpPolicy.createError('EINVAL', `EINVAL: invalid network timeout: ${options.timeoutMs}`)
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
        error: workspaceHttpPolicy.createError('EINTR', 'Network request aborted'),
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
      return { status: 0, body, error: workspaceHttpPolicy.createError(error, body.trim()) };
    };
    this.httpState.activeRequests += 1;
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
        this.httpState.activeRequests = Math.max(0, this.httpState.activeRequests - 1);
      }
    }, settleFailure, () => {
      this.httpState.activeRequests = Math.max(0, this.httpState.activeRequests - 1);
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
      readFile: (path, context) => this.virtualFiles.readFile(path, context),
      readDir: (path, context) => this.virtualFiles.readDir(path, context),
      entryKind: (path, context) => this.virtualFiles.entryKind(path, context),
      stat: (path, context) => this.virtualFiles.stat(path, context),
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

  private bindAuthoritativeProcessProjection(
    process: RuntimeKernelProcessRecord,
    fallback: TraceKernelProcessSnapshot
  ): RuntimeKernelProcessRecord {
    const fallbackActor = process.actor;
    const fallbackStartedAt = process.startedAt;
    const snapshot = (): TraceKernelProcessSnapshot =>
      this.authoritativeProcessSnapshot(process) ?? fallback;
    const tty = (): RuntimeKernelTtyName =>
      snapshot().descriptors.some(
        (descriptor) =>
          descriptor.fd >= 0 &&
          descriptor.fd <= 2 &&
          descriptor.kind === 'terminal'
      )
        ? '/dev/tty'
        : '?';
    const signal = (): { readonly name: string; readonly code?: number } | undefined => {
      const pending = snapshot().pendingSignal;
      if (pending) {
        return {
          name: pending,
          code: TRACEKERNEL_SIGNAL_NUMBERS.get(pending),
        };
      }
      const zombie = this.processState.zombies.get(process.pid)?.outcome;
      if (zombie?.signal) {
        return {
          name: zombie.signal,
          ...(zombie.signalCode === undefined
            ? {}
            : { code: zombie.signalCode }),
        };
      }
      const termination = snapshot().termination;
      if (termination?.kind !== 'signal') return undefined;
      return {
        name: termination.signal,
        code: TRACEKERNEL_SIGNAL_NUMBERS.get(termination.signal),
      };
    };
    Object.defineProperties(process, {
      ppid: {
        enumerable: true,
        get: () => snapshot().ppid,
      },
      pgid: {
        enumerable: true,
        get: () => snapshot().pgid,
      },
      sid: {
        enumerable: true,
        get: () => snapshot().sid,
      },
      command: {
        enumerable: true,
        get: () => snapshot().command,
      },
      cwd: {
        enumerable: true,
        get: () => snapshot().cwd,
      },
      env: {
        enumerable: true,
        get: () => snapshot().env,
      },
      actor: {
        enumerable: true,
        get: () =>
          this.journalActorFromProcess(snapshot(), fallbackActor),
      },
      signalPolicy: {
        enumerable: true,
        get: () =>
          snapshot().protected ? 'system-only' : 'standard',
      },
      startedAt: {
        enumerable: true,
        get: () => {
          const startedAt = snapshot().startedAt;
          return startedAt === undefined
            ? fallbackStartedAt
            : new Date(startedAt).toISOString();
        },
      },
      tty: {
        enumerable: true,
        get: tty,
      },
      foreground: {
        enumerable: true,
        get: () => {
          const current = snapshot();
          if (tty() === '?') return false;
          const terminal = current.controllingTerminalId
            ? this.traceKernelAuthority?.session
                .terminalSnapshots()
                .find(
                  (candidate) =>
                    candidate.id === current.controllingTerminalId
                )
            : undefined;
          return terminal?.foregroundProcessGroupId === current.pgid;
        },
      },
      state: {
        enumerable: true,
        get: (): RuntimeKernelProcessState => {
          const current = this.authoritativeProcessSnapshot(process);
          if (current?.phase === 'exited') return 'zombie';
          if (current?.pendingSignal) return 'signaled';
          if (current?.schedulingState === 'queued') return 'queued';
          if (current?.schedulingState === 'blocked') return 'blocked';
          if (current) return 'running';
          return this.processState.zombies.has(process.pid)
            ? 'zombie'
            : fallback.phase === 'exited'
              ? 'zombie'
              : fallback.schedulingState;
        },
      },
      signal: {
        enumerable: true,
        get: () => signal()?.name,
      },
      signalCode: {
        enumerable: true,
        get: () => signal()?.code,
      },
      exitCode: {
        enumerable: true,
        get: () =>
          this.authoritativeProcessSnapshot(process)?.termination?.exitCode ??
          this.processState.zombies.get(process.pid)?.outcome.exitCode,
      },
      endedAt: {
        enumerable: true,
        get: () => {
          const endedAt = this.authoritativeProcessSnapshot(process)?.endedAt;
          return endedAt === undefined
            ? this.processState.zombies.get(process.pid)?.outcome.endedAt
            : new Date(endedAt).toISOString();
        },
      },
    });
    return process;
  }

  private purgeZombieProcessTable(nowMs = Date.now()): void {
    for (const [pid, zombie] of this.processState.zombies) {
      if (zombie.expiresAtMs > nowMs) continue;
      this.processState.zombies.delete(pid);
      this.processState.waitRequests.delete(pid);
      const authority = this.traceKernelAuthority;
      if (!authority) continue;
      const zombieSnapshot = this.authoritativeProcessSnapshot(zombie.process);
      const parentPid = zombieSnapshot?.ppid ?? zombie.process.ppid;
      const parent =
        this.processState.table.get(parentPid) ??
        this.processState.zombies.get(parentPid)?.process;
      const parentKernelProcess = parent
        ? this.kernelProcessFor(parent)
        : undefined;
      const liveParent = parentKernelProcess &&
        authority.session.processSnapshots().some(
          (snapshot) => snapshot.pid === parentKernelProcess.pid
        )
        ? parentKernelProcess
        : undefined;
      Effect.runFork(
        (
          liveParent
            ? authority.session.waitChild(
                liveParent,
                zombie.process.pid,
                { noHang: true }
              )
            : authority.session.waitInitChild(
                zombie.process.pid,
                { noHang: true }
              )
        ).pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }

  private findProcessRecord(pid: number): RuntimeKernelProcessRecord | undefined {
    this.purgeZombieProcessTable();
    return this.processState.table.get(pid) ?? this.processState.zombies.get(pid)?.process;
  }

  private observeKernelReparentedChildren(_exitedPid: number): void {
    this.notifyRuntimeChildSelectorWaiters();
  }

  private activeProcessRecords(): RuntimeKernelProcessRecord[] {
    this.purgeZombieProcessTable();
    return [
      ...this.processState.table.values(),
      ...[...this.processState.zombies.values()].map((zombie) => zombie.process),
    ]
      .sort((left, right) => left.pid - right.pid);
  }

  private processExecutionHandle(
    process: { readonly pid: number }
  ): RuntimeKernelExecutionHandle | undefined {
    return this.processState.executionHandles.get(process.pid);
  }

  private startHostStandardOutputDrains(
    handle: RuntimeKernelExecutionHandle
  ): void {
    const stdio = handle.hostStandardIo;
    if (!stdio || handle.hostStdoutDrain || handle.hostStderrDrain) return;
    const drain = async (
      read: (maxBytes: number) => Effect.Effect<Uint8Array, Error>
    ): Promise<void> => {
      while (true) {
        const bytes = await Effect.runPromise(read(64 * 1024));
        if (bytes.byteLength === 0) return;
      }
    };
    handle.hostStdoutDrain = drain(stdio.readStdout);
    handle.hostStderrDrain = drain(stdio.readStderr);
  }

  private startHostStandardInputPump(
    context: RuntimeCommandExecutionContext
  ): void {
    const handle = this.processExecutionHandle(context.process);
    const stdio = handle?.hostStandardIo;
    if (!handle || !stdio || handle.hostStdinPumpStarted) return;
    handle.hostStdinPumpStarted = true;
    handle.hostStdinPump = (async () => {
      try {
        const stdinPipe = context.stdinPipe;
        if (!stdinPipe) return;
        while (!handle.stopHostStdinPump) {
          const bytes = readRuntimeCommandStdinPipeBytes(stdinPipe);
          if (bytes.byteLength > 0) {
            await Effect.runPromise(stdio.writeStdin(bytes));
            continue;
          }
          if (runtimeCommandStdinPipeClosed(stdinPipe)) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 8));
        }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 'EPIPE' && code !== 'EBADF') throw error;
      } finally {
        await Effect.runPromise(stdio.closeStdin());
      }
    })();
  }

  private async closeHostStandardIo(
    handle: RuntimeKernelExecutionHandle | undefined
  ): Promise<void> {
    const stdio = handle?.hostStandardIo;
    if (!handle || !stdio) return;
    handle.stopHostStdinPump = true;
    await Effect.runPromise(stdio.closeStdin());
    await handle.hostStdinPump;
    await Promise.all([
      handle.hostStdoutDrain,
      handle.hostStderrDrain,
    ]);
    await Effect.runPromise(stdio.close());
  }

  private kernelProcessFor(
    process: { readonly pid: number }
  ): TraceKernelProcess | undefined {
    return this.processExecutionHandle(process)?.kernelProcess;
  }

  private authoritativeProcessSnapshot(
    process: { readonly pid: number }
  ): TraceKernelProcessSnapshot | undefined {
    return this.kernelProcessFor(process)?.snapshot() ??
      this.traceKernelAuthority?.session
      .processTableSnapshots()
      .find((snapshot) => snapshot.pid === process.pid);
  }

  private kernelPresentationProcessRecords(
    actor?: RuntimeWorkspaceActor
  ): RuntimeKernelProcessRecord[] {
    const authority = this.traceKernelAuthority;
    if (!authority) return this.activeProcessRecords();
    const terminals = new Map(
      authority.session.terminalSnapshots().map((terminal) => [
        terminal.id,
        terminal,
      ])
    );
    const project = (
      snapshot: TraceKernelProcessSnapshot
    ): RuntimeKernelProcessRecord | undefined => {
      const record =
        this.processState.table.get(snapshot.pid) ??
        this.processState.zombies.get(snapshot.pid)?.process;
      if (!record) return undefined;
      const terminal = snapshot.controllingTerminalId
        ? terminals.get(snapshot.controllingTerminalId)
        : undefined;
      const hasTerminalStdio = snapshot.descriptors.some(
        (descriptor) =>
          descriptor.fd >= 0 &&
          descriptor.fd <= 2 &&
          descriptor.kind === 'terminal'
      );
      const terminationSignal =
        snapshot.termination?.kind === 'signal'
          ? snapshot.termination.signal
          : undefined;
      const signalCode = terminationSignal
        ? TRACEKERNEL_SIGNAL_NUMBERS.get(terminationSignal)
        : undefined;
      const state: RuntimeKernelProcessState =
        snapshot.phase === 'exited'
          ? 'zombie'
          : snapshot.pendingSignal
            ? 'signaled'
          : snapshot.schedulingState === 'queued'
            ? 'queued'
            : snapshot.schedulingState === 'blocked'
              ? 'blocked'
              : 'running';
      return {
        ...record,
        ppid: snapshot.ppid,
        pgid: snapshot.pgid,
        sid: snapshot.sid,
        command: snapshot.command,
        cwd: snapshot.cwd,
        env: snapshot.env,
        state,
        tty: hasTerminalStdio ? '/dev/tty' : '?',
        foreground:
          hasTerminalStdio &&
          terminal?.foregroundProcessGroupId === snapshot.pgid,
        ...(snapshot.startedAt === undefined
          ? {}
          : { startedAt: new Date(snapshot.startedAt).toISOString() }),
        ...(snapshot.endedAt === undefined
          ? {}
          : { endedAt: new Date(snapshot.endedAt).toISOString() }),
        ...(snapshot.termination === undefined
          ? {}
          : { exitCode: snapshot.termination.exitCode }),
        ...(terminationSignal === undefined
          ? {}
          : {
              signal: terminationSignal,
              ...(signalCode === undefined ? {} : { signalCode }),
            }),
      };
    };
    return authority.session
      .processTableSnapshots(
        actor === undefined ? undefined : this.traceKernelPrincipal(actor)
      )
      .map(project)
      .filter(
        (record): record is RuntimeKernelProcessRecord => record !== undefined
      );
  }

  private findKernelPresentationProcessRecord(
    pid: number,
    actor?: RuntimeWorkspaceActor
  ): RuntimeKernelProcessRecord | undefined {
    return this.kernelPresentationProcessRecords(actor).find(
      (process) => process.pid === pid
    );
  }

  /** Read the authoritative live-plus-unreaped process capacity from TraceKernel. */
  private processTableUsage(): number {
    return this.traceKernelAuthority?.session.processTableSnapshots().length ??
      1 + this.activeProcessRecords().length;
  }

  private processTableLimit(): number | null {
    return this.traceKernelAuthority?.session.maxProcesses ??
      this.maxProcesses;
  }

  private processAdmissionError(command: string): RuntimeKernelAdmissionRejectedError | null {
    const limit = this.processTableLimit();
    if (limit === null || this.processTableUsage() < limit) return null;
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
      maxProcesses: this.processTableLimit() ?? 'unlimited',
      ...(actor ? { actor: this.journalActorId(actor) } : {}),
    });
  }

  private recordKernelEvent(
    type: string,
    pid?: number,
    detail?: Record<string, unknown>,
    attributedProcess?: TraceKernelProcessSnapshot
  ): void {
    const process = attributedProcess ??
      (pid === undefined
        ? undefined
        : this.authoritativeProcessSnapshot({ pid }));
    this.eventState.recordKernelEvent({
      type,
      ...(pid !== undefined ? { pid } : {}),
      ...(
        detail || process
          ? {
              detail: {
                ...(detail ?? {}),
                ...(process
                  ? {
                      process: {
                        pid: process.pid,
                        ppid: process.ppid,
                        pgid: process.pgid,
                        sid: process.sid,
                        owner: `${process.owner.kind}:${process.owner.id}`,
                      },
                    }
                  : {}),
              },
            }
          : {}
      ),
    });
  }

  private dispatchRuntimeEvent(event: RuntimeCommandEvent, commandContext?: RuntimeCommandExecutionContext): void {
    commandContext?.eventHandler?.(event);
    this.eventState.dispatch(event);
  }

  private journalActorId(actor: RuntimeWorkspaceActor | undefined): string | undefined {
    return this.journalState.actorId(actor);
  }

  private journalActorFromProcess(
    process: TraceKernelProcessSnapshot,
    hintedActor?: RuntimeWorkspaceActor
  ): RuntimeWorkspaceActor {
    return this.journalState.actorFromProcess(process, hintedActor);
  }

  private recordJournal(
    entry: KernelJournalEntry,
    commandContext?: RuntimeCommandExecutionContext,
    actor?: RuntimeWorkspaceActor,
    attributedProcess?: TraceKernelProcessSnapshot
  ): KernelJournalRecord {
    return this.journalState.record(
      entry,
      commandContext,
      actor,
      attributedProcess
    );
  }

  private recordFileChangeJournal(
    event: RuntimeCommandFileChangeEvent,
    commandContext?: RuntimeCommandExecutionContext,
    process: RuntimeKernelProcessRecord | undefined = commandContext?.process as RuntimeKernelProcessRecord | undefined
  ): void {
    this.journalState.recordFileChange(
      event,
      commandContext,
      process
    );
  }

  private recordTraceKernelFileSystemMutation(
    mutation: TraceKernelFileSystemMutation
  ): void {
    this.journalState.recordFileSystemMutation(mutation);
  }

  private recordHttpJournal(
    normalizedRequest: RuntimeKernelHttpRequest,
    url: URL,
    via: Extract<KernelJournalRecord, { kind: 'http' }>['via'],
    actor: RuntimeWorkspaceActor,
    commandContext: RuntimeCommandExecutionContext | undefined,
    result: { status?: number; annotation?: unknown; error?: string; response?: RuntimeKernelHttpResponse }
  ): void {
    this.journalState.recordHttp(
      normalizedRequest,
      url,
      via,
      actor,
      commandContext,
      result
    );
  }

  journal(sinceSeq?: number): readonly KernelJournalRecord[] {
    return this.journalState.journal(sinceSeq);
  }

  private firstZombieProcessRecord(): RuntimeKernelProcessRecord | undefined {
    this.purgeZombieProcessTable();
    return [...this.processState.zombies.values()]
      .map((zombie) => zombie.process)
      .sort((left, right) => left.pid - right.pid)[0];
  }

  private signalCommandError(process: RuntimeKernelProcessRecord): RuntimeCommandError | undefined {
    const signal = this.runtimeTerminationSignal(process);
    if (!signal) return undefined;
    const message = `EINTR: interrupted system call, wait4 '${process.pid}'`;
    return {
      code: 'EINTR',
      errno: 4,
      syscall: 'wait4',
      path: String(process.pid),
      message,
      detail: {
        pid: process.pid,
        signal: signal.name,
        ...(signal.code !== undefined ? { signalCode: signal.code } : {}),
      },
    };
  }

  private signalCommandResult(process: RuntimeKernelProcessRecord): RuntimeCommandResult {
    const error = this.signalCommandError(process);
    const signal = this.runtimeTerminationSignal(process);
    return {
      stdout: '',
      // wait4/EINTR describes TraceKernel's parent-side bookkeeping. A real
      // foreground shell does not print that syscall detail as child stderr.
      stderr: '',
      exitCode: 128 + (signal?.code ?? 15),
      ...(error ? { error } : {}),
    };
  }

  private runtimeTerminationSignal(
    process: RuntimeKernelProcessRecord
  ): { readonly name: string; readonly code?: number } | undefined {
    const executionHandle = this.processExecutionHandle(process);
    if (executionHandle) return executionHandle.pendingSignal;
    if (!process.signal) return undefined;
    return {
      name: process.signal,
      ...(process.signalCode === undefined ? {} : { code: process.signalCode }),
    };
  }

  private deliverRuntimeSignal(
    process: RuntimeKernelProcessRecord,
    signalName = 'SIGTERM'
  ): boolean {
    const signal = normalizeTraceKernelSignal(signalName);
    const snapshot = this.authoritativeProcessSnapshot(process);
    if (!signal || !snapshot || snapshot.phase === 'exited') return false;
    if (signal.name === 'SIGWINCH') {
      const delivery =
        this.processExecutionHandle(process)?.signalChannel?.publish({
          signal: signal.name,
          code: signal.code,
        }) ?? 'closed';
      this.recordKernelEvent('process-signal', process.pid, {
        signal: signal.name,
        signalCode: signal.code,
        disposition:
          delivery === 'closed' ? 'default-ignore' : `runtime-${delivery}`,
      });
      return true;
    }
    const executionHandle = this.processExecutionHandle(process);
    if (!executionHandle) return false;
    executionHandle.pendingSignal = {
      name: signal.name,
      code: signal.code,
    };
    this.recordKernelEvent('process-signal', process.pid, { signal: signal.name, signalCode: signal.code });
    const delivery = executionHandle.signalChannel?.publish({
      signal: signal.name,
      code: signal.code,
    }) ?? 'closed';
    if (delivery === 'delivered') {
      this.recordKernelEvent('process-signal-delivery', process.pid, {
        signal: signal.name,
        signalCode: signal.code,
        disposition: 'runtime-delivered',
      });
      return true;
    }
    // Shell builtins and adapters without a live signal subscription still
    // use AbortSignal as their interrupt boundary. Do not abort a subscribed
    // runtime: doing so cancels the parent shell before the child can run a
    // catchable signal handler and finish during TraceKernel's grace period.
    const abortController = executionHandle.abortController;
    if (abortController && !abortController.signal.aborted) {
      abortController.abort({ signal: signal.name, signalCode: signal.code, pid: process.pid });
    }
    return true;
  }

  private queueKernelProcessSignal(
    process: RuntimeKernelProcessRecord,
    signalName = 'SIGTERM',
    authority: 'workspace' | 'system' = 'workspace'
  ): boolean {
    const signal = normalizeTraceKernelSignal(signalName);
    const snapshot = this.authoritativeProcessSnapshot(process);
    const kernelProcess = this.kernelProcessFor(process);
    if (
      !signal ||
      !snapshot ||
      snapshot.phase === 'exited' ||
      !kernelProcess
    ) {
      return false;
    }
    if (snapshot.protected && authority !== 'system') return false;
    const requester = this.traceKernelPrincipal(
      authority === 'system' ? SYSTEM_ACTOR : PRINCIPAL_ACTOR
    );
    Effect.runFork(
      kernelProcess.signal(signal.name, requester).pipe(
        Effect.catchAll((error) => {
          this.recordKernelEvent('process-signal-error', process.pid, {
            signal: signal.name,
            message: error.message,
          });
          return Effect.void;
        })
      )
    );
    return true;
  }

  private signalProcessGroup(
    pgid: number,
    signalName = 'SIGTERM',
    currentPid?: number
  ): { signaled: number; denied: number } {
    let signaled = 0;
    let denied = 0;
    for (const process of this.activeProcessRecords()) {
      const snapshot = this.authoritativeProcessSnapshot(process);
      if (
        !snapshot ||
        snapshot.pgid !== pgid ||
        snapshot.pid === currentPid ||
        snapshot.pid === 1 ||
        snapshot.phase === 'exited'
      ) continue;
      if (process.signalPolicy === 'system-only') {
        denied += 1;
        continue;
      }
      if (this.queueKernelProcessSignal(process, signalName)) signaled += 1;
    }
    if (signaled > 0) this.recordKernelEvent('process-group-signal', undefined, { pgid, signal: normalizeTraceKernelSignal(signalName)?.name, count: signaled });
    return { signaled, denied };
  }

  private signalTerminalForeground(
    terminalSessionId: string,
    signal: 'SIGINT' | 'SIGQUIT'
  ): boolean {
    const foregroundPid = this.processState.terminalForeground.get(terminalSessionId);
    const foregroundProcess = foregroundPid === undefined
      ? undefined
      : this.findProcessRecord(foregroundPid);
    const foregroundSnapshot = foregroundProcess
      ? this.authoritativeProcessSnapshot(foregroundProcess)
      : undefined;
    if (foregroundSnapshot && foregroundSnapshot.phase !== 'exited') {
      const result = this.signalProcessGroup(foregroundSnapshot.pgid, signal);
      this.recordKernelEvent('process-group-signal', undefined, {
        pgid: foregroundSnapshot.pgid,
        signal,
        count: result.signaled,
        authority: 'tracekernel-terminal-session',
        terminalSessionId,
      });
      return result.signaled > 0;
    }
    const authority = this.traceKernelAuthority;
    const terminal = authority?.session.terminalSnapshots()[0];
    if (authority && terminal && !terminal.closed) {
      const count = authority.session.processSnapshots().filter(
        (process) =>
          process.sid === terminal.sessionId &&
          process.pgid === terminal.foregroundProcessGroupId
      ).length;
      this.recordKernelEvent('process-group-signal', undefined, {
        pgid: terminal.foregroundProcessGroupId,
        signal,
        count,
        authority: 'tracekernel-terminal',
      });
      Effect.runFork(
        authority.session.signalTerminalForeground(terminal.id, signal).pipe(
          Effect.catchAll(() => Effect.void)
        )
      );
      return true;
    }
    return false;
  }

  private resizeKernelTerminal(columns: number, rows: number): void {
    const authority = this.traceKernelAuthority;
    const terminal = authority?.session.terminalSnapshots()[0];
    if (!authority || !terminal || terminal.closed) return;
    Effect.runFork(
      authority.session.resizeTerminal(terminal.id, columns, rows).pipe(
        Effect.catchAll(() => Effect.void)
      )
    );
  }

  private kernelTerminalInputRoute(
    terminal: TraceKernelTerminalSnapshot
  ): 'kernel' | 'legacy' {
    const hasDescriptorConsumer = this.traceKernelAuthority?.session
      .processSnapshots()
      .some((process) =>
        process.sid === terminal.sessionId &&
        process.pgid === terminal.foregroundProcessGroupId &&
        this.processState.executionHandles.get(process.pid)?.descriptorStdio === true
      ) === true;
    return hasDescriptorConsumer ? 'kernel' : 'legacy';
  }

  private writeKernelTerminalInput(
    data: string
  ): 'kernel' | 'legacy' | 'rejected' {
    const authority = this.traceKernelAuthority;
    const terminal = authority?.session.terminalSnapshots()[0];
    if (!authority || !terminal || terminal.closed) return 'rejected';
    const signalByte = new TextEncoder().encode(data).find(
      (byte) => byte === 0x03 || byte === 0x1c
    );
    if (signalByte === undefined && this.kernelTerminalInputRoute(terminal) === 'legacy') {
      return 'legacy';
    }
    if (signalByte !== undefined) {
      const signal = signalByte === 0x03 ? 'SIGINT' : 'SIGQUIT';
      const count = authority.session.processSnapshots().filter(
        (process) =>
          process.sid === terminal.sessionId &&
          process.pgid === terminal.foregroundProcessGroupId
      ).length;
      this.recordKernelEvent('process-group-signal', undefined, {
        pgid: terminal.foregroundProcessGroupId,
        signal,
        count,
        authority: 'tracekernel-terminal-line-discipline',
      });
    }
    Effect.runFork(
      authority.session.writeTerminalInput(
        terminal.id,
        new TextEncoder().encode(data)
      ).pipe(
        Effect.catchAll(() => Effect.void)
      )
    );
    return 'kernel';
  }

  private endKernelTerminalInput(): 'kernel' | 'legacy' | 'rejected' {
    const authority = this.traceKernelAuthority;
    const terminal = authority?.session.terminalSnapshots()[0];
    if (!authority || !terminal || terminal.closed) return 'rejected';
    if (this.kernelTerminalInputRoute(terminal) === 'legacy') return 'legacy';
    Effect.runFork(
      authority.session.sendTerminalInputEof(terminal.id).pipe(
        Effect.catchAll(() => Effect.void)
      )
    );
    return 'kernel';
  }

  private async reapZombieProcess(pid?: number, commandName = 'tracekernelctl', currentPid?: number): Promise<RuntimeCommandResult> {
    const authority = this.traceKernelAuthority;
    let selectedPid = pid;
    if (authority) {
      const candidates = pid === undefined
        ? this.kernelPresentationProcessRecords().filter(
            (candidate) =>
              candidate.pid !== currentPid &&
              candidate.ppid === 1
          )
        : [this.findKernelPresentationProcessRecord(pid)].filter(
            (candidate): candidate is RuntimeKernelProcessRecord =>
              candidate !== undefined &&
              candidate.pid !== currentPid &&
              candidate.ppid === 1
      );
      for (const candidate of candidates) {
        const productRecord = this.findProcessRecord(candidate.pid);
        if (productRecord) this.processState.waitRequests.add(productRecord.pid);
      }
      const selected = await Effect.runPromise(
        Effect.either(authority.session.waitInitChild(pid ?? -1))
      );
      if (selected._tag === 'Left') {
        if (
          selected.left instanceof TraceKernelChildProcessError &&
          selected.left.code === 'ECHILD'
        ) {
          return {
            stdout: '',
            stderr: `${commandName}: no child process${pid === undefined ? '' : `: ${pid}`}\n`,
            exitCode: 10,
          };
        }
        throw selected.left;
      }
      selectedPid = selected.right?.pid;
    }
    const process = await this.waitForZombieProcess(selectedPid, currentPid);
    if (!process) {
      return { stdout: '', stderr: `${commandName}: no child process${pid === undefined ? '' : `: ${pid}`}\n`, exitCode: 10 };
    }
    const outcome = this.processState.zombies.get(process.pid)?.outcome;
    this.processState.zombies.delete(process.pid);
    this.processState.waitRequests.delete(process.pid);
    if (!authority) {
      await this.reapControlledTraceKernelChild(
        this.findProcessRecord(process.ppid),
        process.pid
      );
    }
    this.recordKernelEvent('process-reap', process.pid, {
      exitCode: outcome?.exitCode ?? 0,
      signal: outcome?.signal,
    });
    return {
      stdout: commandName === 'tracekernelctl'
        ? [
            `pid\t${process.pid}`,
            `exitCode\t${outcome?.exitCode ?? 0}`,
            ...(outcome?.signal ? [`signal\t${outcome.signal}`] : []),
            ...(outcome?.signalCode !== undefined ? [`signalCode\t${outcome.signalCode}`] : []),
          ].join('\n') + '\n'
        : '',
      stderr: '',
      exitCode: outcome?.exitCode ?? 0,
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
      const help = this.commandCatalog.help('wait', words.slice(1));
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
    const zombie = pid === undefined ? this.firstZombieProcessRecord() : this.processState.zombies.get(pid)?.process;
    if (zombie?.state === 'zombie') return Promise.resolve(zombie);
    if (pid !== undefined && (pid === currentPid || !this.processState.table.has(pid))) return Promise.resolve(undefined);
    if (pid === undefined && ![...this.processState.table.keys()].some((activePid) => activePid !== currentPid)) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      if (pid === undefined) {
        this.processState.anyWaiters.push(resolve);
        return;
      }
      const waiters = this.processState.waiters.get(pid) ?? [];
      waiters.push(resolve);
      this.processState.waiters.set(pid, waiters);
    });
  }

  private notifyZombieProcess(process: RuntimeKernelProcessRecord): void {
    const waiters = this.processState.waiters.get(process.pid) ?? [];
    this.processState.waiters.delete(process.pid);
    const anyWaiters = this.processState.anyWaiters.splice(0);
    for (const waiter of [...waiters, ...anyWaiters]) {
      waiter(process);
    }
    this.notifyRuntimeChildSelectorWaiters();
  }

  private attachExternalSignal(process: RuntimeKernelProcessRecord, signal: AbortSignal | undefined): (() => void) | undefined {
    if (!signal) return undefined;
    const abort = () => {
      const reason = signal.reason as { signal?: unknown } | undefined;
      const signalName = typeof reason?.signal === 'string' ? reason.signal : 'SIGTERM';
      this.queueKernelProcessSignal(process, signalName);
    };
    if (signal.aborted) {
      abort();
      return undefined;
    }
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
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
    const supported = this.commandCatalog.info(interpreter);
    if (!supported && interpreter !== 'bash' && interpreter !== 'sh') return null;
    const command = interpreter === 'sh' ? 'bash' : interpreter;
    return [command, ...interpreterArgs, executable, ...args].map(shellQuote).join(' ');
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
      const info = this.commandCatalog.info(name);
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
          `verbose=${this.lifecycleState.terminalVerbose ? 'on' : 'off'}`,
          `scheduler.maxConcurrent=${scheduler.maxConcurrentCommands}`,
          `scheduler.running=${scheduler.running}`,
          `scheduler.queued=${scheduler.queued}`,
          `scheduler.maxQueued=${scheduler.maxQueuedCommands ?? 'unlimited'}`,
          `processes.active=${this.processTableUsage()}`,
          `processes.max=${this.processTableLimit() ?? 'unlimited'}`,
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
        this.lifecycleState.toggleTerminalVerbose();
      } else if (mode === 'on' || mode === 'true' || mode === '1' || mode === 'enable' || mode === 'enabled') {
        this.lifecycleState.setTerminalVerbose(true);
      } else if (mode === 'off' || mode === 'false' || mode === '0' || mode === 'disable' || mode === 'disabled') {
        this.lifecycleState.setTerminalVerbose(false);
      } else if (mode !== 'status') {
        return { stdout: '', stderr: 'usage: tracekernelctl verbose [on|off|status]\n', exitCode: 2 };
      }
      return {
        stdout: `tracekernelctl: verbose ${this.lifecycleState.terminalVerbose ? 'on' : 'off'}\n`,
        stderr: '',
        exitCode: 0,
      };
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
      const snapshot = process
        ? this.authoritativeProcessSnapshot(process)
        : undefined;
      if (!process || !snapshot || snapshot.phase === 'exited') {
        return { stdout: '', stderr: `tracekernelctl: no such process: ${target}\n`, exitCode: 3 };
      }
      if (process.signalPolicy === 'system-only') {
        return { stdout: '', stderr: `tracekernelctl: kill ${target}: Operation not permitted\n`, exitCode: 1 };
      }
      if (!this.queueKernelProcessSignal(process, signal.name)) {
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

  private terminalJobRecords(): RuntimeProjectTerminalJobRecord[] {
    return this.kernelPresentationProcessRecords().map((process, index) => ({
      index: index + 1,
      pid: process.pid,
      command: process.command,
    }));
  }

  private kernelJobRecords(currentPid?: number): RuntimeKernelProcessRecord[] {
    return this.kernelPresentationProcessRecords().filter(
      (process) => process.pid !== currentPid && process.pid !== 1
    );
  }

  private resolveKernelJobTarget(target: string | undefined, currentPid?: number): RuntimeKernelProcessRecord | undefined {
    const jobs = this.kernelJobRecords(currentPid);
    if (target === undefined) return jobs[0];
    const jobMatch = target.match(/^%([1-9][0-9]*)$/);
    if (jobMatch) return jobs[Number(jobMatch[1]) - 1];
    const pid = Number(target);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const process = this.findKernelPresentationProcessRecord(pid);
    if (!process || process.pid === 1 || process.pid === currentPid) {
      return undefined;
    }
    return this.findProcessRecord(process.pid);
  }

  private async runKernelJobPlacement(
    args: string[],
    commandName: 'bg' | 'fg',
    ctx: CommandContext
  ): Promise<RuntimeCommandResult> {
    if (args.length > 1) {
      return { stdout: '', stderr: `usage: ${commandName} [pid|%job]\n`, exitCode: 2 };
    }
    const process = this.resolveKernelJobTarget(args[0], this.resolveCommandContext(ctx)?.process.pid);
    if (!process) {
      return { stdout: '', stderr: `${commandName}: no such job${args[0] === undefined ? '' : `: ${args[0]}`}\n`, exitCode: 10 };
    }
    const foreground = commandName === 'fg';
    const caller = this.resolveCommandContext(ctx)?.process as
      | RuntimeKernelProcessRecord
      | undefined;
    const authority = this.traceKernelAuthority;
    const callerKernelProcess = caller
      ? this.kernelProcessFor(caller)
      : undefined;
    const targetKernelProcess = this.kernelProcessFor(process);
    if (authority && callerKernelProcess && targetKernelProcess) {
      if (foreground) {
        const terminal = authority.session.terminalSnapshots()[0] ??
          await Effect.runPromise(
            authority.session.bootstrapSessionTerminal(callerKernelProcess, {
              name: '/dev/tty',
            })
          );
        if (
          !callerKernelProcess.snapshot().descriptors.some(
            (descriptor) =>
              descriptor.fd === 0 && descriptor.kind === 'terminal'
          )
        ) {
          await Effect.runPromise(
            authority.session.replaceTerminalStdio(
              callerKernelProcess,
              terminal.id
            )
          );
        }
        await Effect.runPromise(
          authority.session.replaceTerminalStdio(
            targetKernelProcess,
            terminal.id
          )
        );
        await Effect.runPromise(
          authority.session.setTerminalForegroundProcessGroup(
            callerKernelProcess,
            0,
            targetKernelProcess.snapshot().pgid
          )
        );
      } else {
        const targetSnapshot = targetKernelProcess.snapshot();
        if (
          targetSnapshot.descriptors.some(
            (descriptor) =>
              descriptor.fd >= 0 &&
              descriptor.fd <= 2 &&
              descriptor.kind === 'terminal'
          )
        ) {
          await Effect.runPromise(
            authority.session.replaceNullStandardIo(targetKernelProcess)
          );
        }
        const terminal = authority.session.terminalSnapshots()[0];
        if (terminal) {
          await Effect.runPromise(
            authority.session.releaseTerminalForegroundToHost(
              terminal.id,
              targetKernelProcess.snapshot().pgid
            )
          );
        }
      }
    } else {
      return {
        stdout: '',
        stderr: `${commandName}: job ${process.pid} is not attached to TraceKernel\n`,
        exitCode: 3,
      };
    }
    const placement =
      this.findKernelPresentationProcessRecord(process.pid) ?? process;
    this.recordKernelEvent(foreground ? 'process-foreground' : 'process-background', process.pid, {
      command: process.command,
      pgid: placement.pgid,
      tty: placement.tty,
    });
    return {
      stdout: `${commandName}: ${process.pid}\tpgid=${placement.pgid}\t${foreground ? 'foreground' : 'background'}\t${process.command}\n`,
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
          const exists = this.traceKernelAuthority?.session
            .processSnapshots()
            .some((process) => process.pgid === pgid);
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
      const snapshot = process
        ? this.authoritativeProcessSnapshot(process)
        : undefined;
      if (!process || !snapshot || snapshot.phase === 'exited') {
        return { stdout: '', stderr: `${commandName}: no such process: ${target}\n`, exitCode: 3 };
      }
      if (process.signalPolicy === 'system-only') {
        return { stdout: '', stderr: `${commandName}: (${target}) - Operation not permitted\n`, exitCode: 1 };
      }
      if (!probeOnly) this.queueKernelProcessSignal(process, signal.name);
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

  private runKernelMan(args: readonly string[]): RuntimeCommandResult {
    const command = args.find((arg) => !arg.startsWith('-'));
    if (!command) {
      return { stdout: '', stderr: 'What manual page do you want?\n', exitCode: 1 };
    }
    const info = this.commandCatalog.info(command);
    if (!info?.help) {
      return { stdout: '', stderr: `No manual entry for ${command}\n`, exitCode: 1 };
    }
    return this.commandCatalog.help(info.name, ['--help']) ?? {
      stdout: '',
      stderr: `No manual entry for ${command}\n`,
      exitCode: 1,
    };
  }

  private terminalForCommand(ctx: CommandContext): RuntimeCommandOptions['terminal'] | undefined {
    return this.resolveCommandContext(ctx)?.terminal;
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
      for (const path of systemDirectories) {
        await fs.mkdir(path, { recursive: true });
        await fs.chmod(path, 0o755);
      }
      await fs.chmod('/tmp', 0o1777);
      await fs.chmod('/var/tmp', 0o1777);
    }, 'directory-create');
    await this.ensureTraceKernelAuthority();
  }

  private async ensureTraceKernelAuthority(): Promise<void> {
    if (this.traceKernelAuthority) return;
    const scope = Effect.runSync(Scope.make());
    try {
      const authority = await Effect.runPromise(Scope.extend(
        Effect.gen(this, function* () {
          const host = yield* makeTraceKernelHost({
            providers: [this.traceKernelControlledRuntime.provider],
          });
          const session = yield* host.openSession({
            cwd: this.cwd,
            env: this.baseEnv,
            fileSystem: this.traceKernelFileSystem,
            fileSystemPolicy: this.createTraceKernelFileSystemPolicy(),
            ...(this.maxProcesses === null
              ? {}
              : { maxProcesses: this.maxProcesses }),
          });
          const hostServiceProcess = yield* session.spawn({
            runtime: this.traceKernelControlledRuntime.runtime,
            command: '[tracekernel-host]',
            cwd: this.cwd,
            env: this.baseEnv,
            sessionId: 1,
            processGroupId: 0,
            owner: this.traceKernelPrincipal(SYSTEM_ACTOR),
            protected: true,
            visible: false,
          });
          yield* session.attachNullStandardIo(hostServiceProcess);
          yield* hostServiceProcess.awaitStarted();
          return {
            scope,
            host,
            session,
            hostServiceProcess,
          } satisfies RuntimeTraceKernelAuthority;
        }),
        scope
      ));
      if (this.lifecycleState.destroyed) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw new Error('Runtime workspace was destroyed while TraceKernel initialized.');
      }
      this.traceKernelAuthority = authority;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(error))).catch(() => undefined);
      throw error;
    }
  }

  private async closeTraceKernelAuthority(): Promise<void> {
    const authority = this.traceKernelAuthority;
    if (!authority) return;
    try {
      await Effect.runPromise(Scope.close(authority.scope, Exit.void));
    } finally {
      if (this.traceKernelAuthority === authority) {
        this.traceKernelAuthority = undefined;
      }
    }
  }

  private traceKernelPrincipal(actor: RuntimeWorkspaceActor): TraceKernelPrincipal {
    const kind: TraceKernelPrincipal['kind'] =
      actor.kind === 'system'
        ? 'system'
        : actor.kind === 'test' || actor.kind === 'hidden-test'
          ? 'grader'
          : actor.kind === 'runtime'
            ? 'agent'
            : 'user';
    return Object.freeze({ id: actor.id, kind });
  }

  private async spawnControlledTraceKernelProcess(options: {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly actor: RuntimeWorkspaceActor;
    readonly parent?: RuntimeKernelProcessRecord;
    readonly processGroupId?: number;
    readonly sessionId?: number;
  }): Promise<TraceKernelProcess> {
    await this.ensureTraceKernelAuthority();
    const authority = this.traceKernelAuthority;
    if (!authority) {
      throw new Error('TraceKernel session authority is unavailable.');
    }
    const parentPid = options.parent
      ? this.kernelProcessFor(options.parent)?.pid
      : undefined;
    const process = await Effect.runPromise(authority.session.spawn({
      runtime: this.traceKernelControlledRuntime.runtime,
      command: options.command,
      cwd: options.cwd,
      env: options.env,
      ...(parentPid === undefined
        ? {
            sessionId: options.sessionId ?? 1,
            retainOnExit: true,
          }
        : {
            parentPid,
            ...(options.sessionId === undefined
              ? {}
              : { sessionId: options.sessionId }),
          }),
      processGroupId: options.processGroupId ?? 0,
      owner: this.traceKernelPrincipal(options.actor),
    }));
    await Effect.runPromise(authority.session.attachNullStandardIo(process));
    await Effect.runPromise(process.awaitStarted());
    return process;
  }

  private async reapControlledTraceKernelChild(
    parent: RuntimeKernelProcessRecord | undefined,
    childPid: number
  ): Promise<void> {
    const authority = this.traceKernelAuthority;
    if (!authority) return;
    const parentKernelProcess = parent
      ? this.kernelProcessFor(parent)
      : undefined;
    await Effect.runPromise(
      parentKernelProcess
        ? authority.session.waitChild(parentKernelProcess, childPid, {
            noHang: true,
          })
        : authority.session.waitInitChild(childPid, { noHang: true })
    ).catch(() => undefined);
  }

  private createTraceKernelFileSystemPolicy(): TraceKernelFileSystemPolicy {
    return {
      authorize: (request) => Effect.try({
        try: () => {
          if (request.owner.kind === 'system') return;
          for (const access of request.accesses) {
            if (access.permission === 'read' || access.permission === 'metadata') {
              this.accessPolicy.assertWorkspacePathVisible(
                access.path,
                access.permission === 'read' ? 'read' : 'stat'
              );
            } else if (access.permission === 'delete') {
              this.accessPolicy.assertWorkspaceSubtreeWritable(
                access.path,
                'delete'
              );
            } else {
              this.accessPolicy.assertWorkspacePathWritable(
                access.path,
                'write'
              );
            }
          }
        },
        catch: (error) => {
          const candidate = error as { code?: unknown };
          const code =
            candidate.code === 'EROFS' ||
            candidate.code === 'ENOENT' ||
            candidate.code === 'EACCES' ||
            candidate.code === 'EPERM'
              ? candidate.code
              : 'EACCES';
          return new TraceKernelFileSystemError({
            code,
            path: request.accesses[0]?.path ?? request.cwd,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      }),
    };
  }

  async writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
    return this.fileApi.writeFile(path, contents, encoding);
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
    return this.accessPolicy.isReadOnly(path);
  }

  private assertNotDestroyed(): void {
    this.lifecycleState.assertNotDestroyed();
  }

  private assertWorkspaceUsableForMutation(operation: string): void {
    this.lifecycleState.assertUsableForMutation(operation);
  }

  private assertWorkspaceUsableForRun(command: string): RuntimeCommandResult | null {
    return this.lifecycleState.unusableRunResult(command);
  }

  async withSuspendedReadonlyPolicy<T>(fn: () => Promise<T>): Promise<T> {
    return this.accessPolicy.withSuspendedReadonlyPolicy(fn);
  }

 async completeCommand(
    input: string,
    cursor: number,
    options: RuntimeCommandCompletionOptions = {}
  ): Promise<RuntimeCommandCompletion | null> {
    this.assertNotDestroyed();
    return this.terminalNavigation.completeCommand(input, cursor, options);
  }

  private readDevice(device: RuntimeKernelDevicePath, context?: RuntimeCommandExecutionContext): string {
    return this.deviceIo.read(device, context);
  }

  private writeDevice(
    device: RuntimeKernelDevicePath,
    data: string,
    contextOrActor?: RuntimeCommandExecutionContext | RuntimeWorkspaceActor
  ): void {
    this.deviceIo.write(device, data, contextOrActor);
  }

  private captureDeviceOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): string {
    return this.deviceIo.captureDeviceOutput(context, stream, data);
  }

  private captureCommandOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): string {
    return this.deviceIo.captureCommandOutput(context, stream, data);
  }

  private captureReturnedOutput(
    context: RuntimeCommandExecutionContext,
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>
  ): Pick<RuntimeCommandResult, 'stdout' | 'stderr'> {
    return this.deviceIo.captureReturnedOutput(context, result);
  }

  private async writeFileAs(
    path: string,
    contents: string,
    actor: RuntimeWorkspaceActor,
    encoding?: RuntimeFileEncoding,
    phase: RuntimeFileMutationPhase = 'live',
    process?: RuntimeKernelProcessRecord
  ): Promise<void> {
    return this.fileApi.writeFileAs(
      path,
      contents,
      actor,
      encoding,
      phase,
      process
    );
  }

  async writeFiles(files: readonly RuntimeFile[]): Promise<void> {
    return this.fileApi.writeFiles(files);
  }

  async writeSkillFiles(files: readonly RuntimeFile[]): Promise<void> {
    return this.fileApi.writeSkillFiles(files);
  }

  private async writeSkillFilesAs(
    files: readonly RuntimeFile[],
    actor: RuntimeWorkspaceActor = SYSTEM_ACTOR
  ): Promise<void> {
    return this.fileApi.writeSkillFilesAs(files, actor);
  }

  async appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
    return this.fileApi.appendFile(path, contents, encoding);
  }

  async readFile(path: string, encoding?: RuntimeFileEncoding, options: { publicProc?: boolean } = {}): Promise<string> {
    return this.fileApi.readFile(path, encoding, options);
  }

  async exists(path: string): Promise<boolean> {
    return this.fileApi.exists(path);
  }

  async stat(path: string): Promise<RuntimeWorkspaceStat> {
    return this.fileApi.stat(path);
  }

  async readDir(path = '.'): Promise<string[]> {
    return this.fileApi.readDir(path);
  }

  async mkdir(path: string): Promise<void> {
    return this.fileApi.mkdir(path);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this.fileApi.copyFile(sourcePath, destinationPath);
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this.fileApi.moveFile(sourcePath, destinationPath);
  }

  async deleteFile(path: string): Promise<void> {
    return this.fileApi.deleteFile(path);
  }

  async remove(path: string, options: RuntimeWorkspaceRemoveOptions = {}): Promise<void> {
    return this.fileApi.remove(path, options);
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
    await this.awaitControlPlaneProcessDisposals();
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
    const commandCwd = options.cwd
      ? this.terminalNavigation.resolveCommandCwd(options.cwd)
      : this.cwd;
    const stdinPipe = options.stdinPipe;
    const abortController = new AbortController();
    const processEnv = Object.freeze({
      ...(parent?.env ?? this.baseEnv),
      ...(options.env ?? {}),
    });
    const terminalPresentation = options.presentation === 'terminal';
    const foreground = options.foreground ?? terminalPresentation;
    const kernelProcess = launchHooks?.kernelProcess ??
      await this.spawnControlledTraceKernelProcess({
        command,
        cwd: commandCwd,
        env: processEnv,
        actor,
        parent,
        processGroupId: launchHooks?.kernelProcessGroupId,
        sessionId: launchHooks?.kernelSessionId,
      });
    const authority = this.traceKernelAuthority;
    if (!authority) {
      throw new Error('TraceKernel session authority is unavailable.');
    }
    if (launchHooks?.kernelProcess) {
      await Effect.runPromise(authority.session.ensureNullStandardIo(kernelProcess));
      await Effect.runPromise(kernelProcess.awaitStarted());
    }
    if (terminalPresentation && !launchHooks?.preserveKernelStandardIo) {
      const terminal = await Effect.runPromise(
        authority.session.bootstrapSessionTerminal(kernelProcess, {
          name: '/dev/tty',
          columns: options.terminal?.columns,
          rows: options.terminal?.rows,
        })
      );
      await Effect.runPromise(
        authority.session.replaceTerminalStdio(kernelProcess, terminal.id)
      );
      if (foreground) {
        await Effect.runPromise(
          authority.session.setTerminalForegroundProcessGroup(
            kernelProcess,
            0,
            kernelProcess.snapshot().pgid
          )
        );
      } else if (
        !parent ||
        parent.pgid !== kernelProcess.snapshot().pgid
      ) {
        await Effect.runPromise(
          authority.session.releaseTerminalForegroundToHost(
            terminal.id,
            kernelProcess.snapshot().pgid
          )
        );
      }
    }
    const hostStandardIo =
      !terminalPresentation && !launchHooks?.kernelProcess
        ? await Effect.runPromise(
            authority.session.attachHostStandardIo(kernelProcess)
          )
        : undefined;
    const kernelSnapshot = kernelProcess.snapshot();
    await Effect.runPromise(
      authority.session.setProcessSchedulingState(kernelProcess, 'queued')
    );
    const pid = kernelProcess.pid;
    this.processState.nextPid = Math.max(this.processState.nextPid, pid + 1);
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: kernelSnapshot.ppid,
      pgid: kernelSnapshot.pgid,
      sid: kernelSnapshot.sid,
      fds: this.standardProcessFileDescriptors(),
      tty: terminalPresentation ? '/dev/tty' : '?',
      command,
      cwd: commandCwd,
      env: processEnv,
      actor,
      signalPolicy: 'standard',
      startedAt: new Date().toISOString(),
      state: 'queued',
      foreground,
    };
    this.bindAuthoritativeProcessProjection(process, kernelSnapshot);
    let engineAttachment: RuntimeProjectEngineLeaseAttachment | undefined;
    let engineLeaseReleased = false;
    const engineLease: RuntimeProjectEngineLeaseController = Object.freeze({
      attach: (attachment: RuntimeProjectEngineLeaseAttachment) => {
        if (engineLeaseReleased) {
          throw new Error(
            `Runtime engine lease for process ${process.pid} was already released.`
          );
        }
        if (engineAttachment) {
          throw new Error(
            `Runtime engine lease for process ${process.pid} is already attached.`
          );
        }
        engineAttachment = attachment;
      },
    });
    let commandContext!: RuntimeCommandExecutionContext;
    commandContext = {
      eventHandler: this.createCommandEventHandler(options),
      actor,
      process,
      engineLease,
      signal: abortController.signal,
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
    const executionHandle: RuntimeKernelExecutionHandle = {
      kernelProcess,
      abortController,
      signalChannel: new RuntimeKernelProcessSignalChannel(),
      ...(hostStandardIo ? { hostStandardIo } : {}),
    };
    executionHandle.hostOutputContext = commandContext;
    this.processState.executionHandles.set(process.pid, executionHandle);
    if (foreground && options.terminalSessionId) {
      this.processState.terminalForeground.set(options.terminalSessionId, process.pid);
    }
    this.startHostStandardOutputDrains(executionHandle);
    this.processState.table.set(process.pid, process);
    options.onProcessStart?.(process.pid);
    const clearKernelSignalHandler = await Effect.runPromise(
      this.traceKernelControlledRuntime.setSignalHandler(
        process.pid,
        (signal) => {
          this.deliverRuntimeSignal(process, signal);
        }
      )
    );
    const clearKernelLeaseHandler = await Effect.runPromise(
      this.traceKernelControlledRuntime.setLeaseHandler(process.pid, {
        revalidate: async () => {
          if (!engineAttachment?.revalidate) {
            throw new Error(
              `Runtime engine for process ${process.pid} does not support validated reuse.`
            );
          }
          await engineAttachment.revalidate();
        },
        release: async (disposition) => {
          engineLeaseReleased = true;
          const attachment = engineAttachment;
          engineAttachment = undefined;
          if (disposition.kind === 'destroy' && !abortController.signal.aborted) {
            // TraceKernel never delivers SIGKILL to a catchable runtime signal
            // handler. A forced kernel exit reaches the host through lease
            // destruction instead, so destruction itself must tear down the
            // active executor. Preserve an already delivered signal when one
            // exists; otherwise this is the uncatchable SIGKILL path.
            executionHandle.pendingSignal ??= {
              name: 'SIGKILL',
              code: 9,
            };
            abortController.abort({
              signal: executionHandle.pendingSignal.name,
              signalCode: executionHandle.pendingSignal.code,
              pid: process.pid,
            });
          }
          await attachment?.release(disposition);
        },
      })
    );
    try {
      await launchHooks?.initialize?.(process, commandContext);
      launchHooks?.ready?.(process);
    } catch (error) {
      this.processState.table.delete(process.pid);
      executionHandle.signalChannel?.close();
      this.processState.executionHandles.delete(process.pid);
      if (
        options.terminalSessionId &&
        this.processState.terminalForeground.get(options.terminalSessionId) === process.pid
      ) {
        this.processState.terminalForeground.delete(options.terminalSessionId);
      }
      clearKernelSignalHandler();
      await Effect.runPromise(
        this.traceKernelControlledRuntime.fail(
          process.pid,
          error instanceof Error ? error : new Error(String(error))
        )
      );
      await Effect.runPromise(kernelProcess.wait()).catch(() => undefined);
      clearKernelLeaseHandler();
      await this.closeHostStandardIo(executionHandle);
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
        await Effect.runPromise(
          authority.session.setProcessSchedulingState(kernelProcess, 'running')
        );
        if (this.runtimeTerminationSignal(process)) {
          const result = this.signalCommandResult(process);
          const output = this.captureReturnedOutput(commandContext, result);
          processExitCode = result.exitCode;
          this.emitReturnedOutputEvents(output, commandContext);
          return { ...result, ...output };
        }
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
          const deliveredSignal = this.processExecutionHandle(process)?.pendingSignal;
          if (
            commandContext.handledSignal &&
            deliveredSignal?.name === commandContext.handledSignal
          ) {
            delete this.processExecutionHandle(process)?.pendingSignal;
            this.recordKernelEvent('process-signal-handled', process.pid, {
              signal: commandContext.handledSignal,
            });
          }
          if (this.runtimeTerminationSignal(process)) {
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
        const deliveredSignal = this.processExecutionHandle(process)?.pendingSignal;
        if (
          commandContext.handledSignal &&
          deliveredSignal?.name === commandContext.handledSignal
        ) {
          delete this.processExecutionHandle(process)?.pendingSignal;
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
          if (!this.runtimeTerminationSignal(process) && interruptedSignal) {
            const executionHandle = this.processExecutionHandle(process);
            if (executionHandle) {
              executionHandle.pendingSignal = {
                name: interruptedSignal.name,
                code: interruptedSignal.code,
              };
            }
          }
          if (this.runtimeTerminationSignal(process)) {
            const signalResult = this.signalCommandResult(process);
            processExitCode = signalResult.exitCode;
            return signalResult;
          }
        }
        return {
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: result.exitCode,
          ...(commandContext.kernelError ? { error: commandContext.kernelError } : {}),
          ...(!commandContext.kernelError && (result as RuntimeCommandResult).error ? { error: (result as RuntimeCommandResult).error } : {}),
          ...(!commandContext.kernelError && !(result as RuntimeCommandResult).error && this.runtimeTerminationSignal(process) ? { error: this.signalCommandError(process) } : {}),
        };
      } catch (error) {
        if (!this.runtimeTerminationSignal(process) && abortController.signal.aborted) {
          this.deliverRuntimeSignal(process, 'SIGTERM');
        }
        if (this.runtimeTerminationSignal(process)) {
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
      if (this.runtimeTerminationSignal(process)) {
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
      if (!this.runtimeTerminationSignal(process)) return result;
      const signalResult = this.signalCommandResult(process);
      processExitCode = signalResult.exitCode;
      return {
        ...result,
        ...signalResult,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }).finally(async () => {
      const retainProcessOnExit =
        Boolean(this.runtimeTerminationSignal(process)) ||
        options.retainOnExit === true ||
        this.processState.waitRequests.has(process.pid);
      this.closeHttpListenersForProcess(process.pid);
      try {
        await launchHooks?.beforeDescriptorClose?.(process, commandContext);
      } finally {
      }
      await launchHooks?.afterDescriptorClose?.(process, commandContext);
      const pendingSignal = this.processExecutionHandle(process)?.pendingSignal;
      const normalizedTerminationSignal = pendingSignal
        ? normalizeTraceKernelSignal(pendingSignal.name)?.name
        : undefined;
      const terminationSignal =
        normalizedTerminationSignal === 'SIGWINCH'
          ? undefined
          : normalizedTerminationSignal;
      await Effect.runPromise(
        this.traceKernelControlledRuntime.complete(process.pid, {
          exitCode: processExitCode,
          ...(terminationSignal
            ? {
                termination: {
                  kind: 'signal' as const,
                  signal: terminationSignal,
                  exitCode: processExitCode,
                },
              }
            : {}),
        })
      );
      const finalKernelSnapshot = await Effect.runPromise(
        kernelProcess.wait()
      ).catch(() => undefined);
      await this.closeHostStandardIo(
        this.processExecutionHandle(process)
      );
      if (!retainProcessOnExit) {
        await this.reapControlledTraceKernelChild(parent, process.pid);
      }
      clearKernelSignalHandler();
      clearKernelLeaseHandler();
      cleanupExternalSignal?.();
      const outcome = {
        exitCode: processExitCode,
        endedAt: new Date().toISOString(),
        ...(pendingSignal
          ? {
              signal: pendingSignal.name,
              signalCode: pendingSignal.code,
            }
          : {}),
      };
      if (retainProcessOnExit) {
        this.processState.zombies.set(process.pid, {
          process,
          outcome,
          expiresAtMs: Date.now() + TRACEKERNEL_ZOMBIE_RETENTION_MS,
        });
      }
      this.processState.table.delete(process.pid);
      executionHandle.signalChannel?.close();
      this.processState.executionHandles.delete(process.pid);
      if (
        options.terminalSessionId &&
        this.processState.terminalForeground.get(options.terminalSessionId) === process.pid
      ) {
        this.processState.terminalForeground.delete(options.terminalSessionId);
      }
      this.observeKernelReparentedChildren(process.pid);
      if (retainProcessOnExit) {
        this.recordKernelEvent('process-zombie', process.pid, {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          signalCode: outcome.signalCode,
        }, finalKernelSnapshot);
        this.recordJournal({
          kind: 'process',
          op: 'exit',
          pid: process.pid,
          exitCode: outcome.exitCode,
          actor: this.journalActorId(process.actor),
        }, commandContext, process.actor, finalKernelSnapshot);
        this.notifyZombieProcess(process);
      } else {
        this.processState.waitRequests.delete(process.pid);
        this.recordKernelEvent(
          'process-exit',
          process.pid,
          { exitCode: outcome.exitCode },
          finalKernelSnapshot
        );
        this.recordJournal({
          kind: 'process',
          op: 'exit',
          pid: process.pid,
          exitCode: outcome.exitCode,
          actor: this.journalActorId(process.actor),
        }, commandContext, process.actor, finalKernelSnapshot);
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
          ? this.terminalNavigation.resolvePath(this.cwd, commandCwd)
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
          ...(commandCwd
            ? { cwd: this.terminalNavigation.resolvePath(this.cwd, commandCwd) }
            : {}),
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
    const terminalSessionId =
      this.lifecycleState.allocateTerminalSessionId();
    return new RuntimeProjectWorkspaceTerminalSession(
      {
        workspaceRoot: this.cwd,
        kernelInfo: this.kernelInfo,
        resolveCwd: (currentCwd, target) =>
          this.terminalNavigation.resolveTerminalCwd(currentCwd, target),
        runCommand: (command, commandOptions) => this.runCommandAs(command, {
          ...commandOptions,
          terminalSessionId,
        }, parent),
        signalForeground: (signal) => this.signalTerminalForeground(terminalSessionId, signal),
        terminalInputRouter: {
          write: (data) => this.writeKernelTerminalInput(data),
          end: () => this.endKernelTerminalInput(),
        },
        resizeTerminal: (columns, rows) =>
          this.resizeKernelTerminal(columns, rows),
        jobRecords: () => this.terminalJobRecords(),
        isVerbose: () => this.lifecycleState.terminalVerbose,
      },
      {
        ...options,
        cwd: options.cwd
          ? this.terminalNavigation.resolvePath(this.cwd, options.cwd)
          : this.cwd,
      }
    );
  }

  async checkExpiration(now: Date | string | number = new Date()): Promise<RuntimeProjectSessionLifecycle | null> {
    return this.lifecycleState.checkExpiration(now);
  }

  async destroy(options: { reason?: string; clearStorage?: boolean } = {}): Promise<void> {
    await this.commandScheduler.runBarrier(() => this.destroyNow(options));
  }

  private async destroyNow(options: { reason?: string; clearStorage?: boolean } = {}): Promise<void> {
    if (this.lifecycleState.destroyed) return;
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
    this.eventState.clearWatchers();
    await this.closeTraceKernelAuthority();
    await this.withSuspendedReadonlyPolicy(() =>
      this.fs.withBaseMutation([this.cwd], (fs) => fs.rm(this.cwd, { force: true, recursive: true }), 'recursive-delete')
    );
    this.closeAllHttpListeners();
    if (!this.httpState.lifecycleAbortController.signal.aborted) this.httpState.lifecycleAbortController.abort();
    this.kernelSyscallGenerationUnsubscribe?.();
    this.kernelSyscallGenerationUnsubscribe = undefined;
    this.stopObservingExternalTraceKernelMutations();
    this.traceKernelBackingFileSystem.dispose();
    this.processState.table.clear();
    this.processState.executionHandles.clear();
    this.processState.zombies.clear();
    this.processState.waitRequests.clear();
    this.processState.waiters.clear();
    this.processState.anyWaiters.splice(0);
    this.notifyRuntimeChildSelectorWaiters();
    this.processState.childWaits.clear();
    this.recordKernelEvent('kernel-destroy', 1, { reason: options.reason ?? 'destroy', clearStorage: options.clearStorage === true });
    this.lifecycleState.destroyed = true;
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

    const cwd = options.cwd
      ? this.terminalNavigation.resolveCommandCwd(options.cwd)
      : this.cwd;
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
    const signal = this.processExecutionHandle(
      request.commandContext.process
    )?.abortController?.signal;
    const processSnapshot = this.authoritativeProcessSnapshot(
      request.commandContext.process
    );
    const executionHandle = this.processExecutionHandle(
      request.commandContext.process
    );
    const descriptorStdio =
      this.cppRunner.capabilities?.descriptorStdio === true;
    if (executionHandle) {
      executionHandle.descriptorStdio = descriptorStdio;
    }
    if (descriptorStdio) {
      this.startHostStandardInputPump(request.commandContext);
    }
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
          ppid: processSnapshot?.ppid ?? request.commandContext.process.ppid,
          pgid: processSnapshot?.pgid ?? request.commandContext.process.pgid,
          sid: processSnapshot?.sid ?? request.commandContext.process.sid,
        },
        ...(request.commandContext.engineLease
          ? { engineLease: request.commandContext.engineLease }
          : {}),
        ...(request.commandContext.terminal
          ? { terminal: request.commandContext.terminal }
          : {}),
        ...(!descriptorStdio && request.stdinPipe
          ? { stdinPipe: request.stdinPipe }
          : {}),
        signal,
        project: await this.snapshotForCommand(request.commandContext.includeHiddenFiles === true),
        kernelHttp: this.createKernelHttpBridge(request.commandContext),
        ...(kernelSyscalls ? { kernelSyscalls } : {}),
        ...(executionHandle?.signalChannel
          ? { kernelSignals: executionHandle.signalChannel }
          : {}),
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

  /**
   * Capture the complete session filesystem for persistence or crash recovery.
   *
   * Unlike a public project snapshot this intentionally includes system paths,
   * hidden entries, inode identity, links, and kernel mutation generations.
   */
  async exportTraceKernelFileSystemImage(): Promise<TraceKernelFileSystemImage> {
    this.assertNotDestroyed();
    return Effect.runPromise(this.traceKernelFileSystem.exportImage());
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
    if (this.lifecycleState.destroyed) return;
    this.lifecycleState.destroyed = true;
    if (!this.httpState.lifecycleAbortController.signal.aborted) this.httpState.lifecycleAbortController.abort();
    this.closeAllHttpListeners();
    this.eventState.clearWatchers();
    this.kernelSyscallGenerationUnsubscribe?.();
    this.kernelSyscallGenerationUnsubscribe = undefined;
    this.stopObservingExternalTraceKernelMutations();
    this.traceKernelBackingFileSystem.dispose();
    const authority = this.traceKernelAuthority;
    if (authority) {
      void Effect.runPromise(Scope.close(authority.scope, Exit.void))
        .catch(() => undefined)
        .finally(() => {
          if (this.traceKernelAuthority === authority) {
            this.traceKernelAuthority = undefined;
          }
        });
    }
  }

  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe {
    return this.eventState.watch(listener);
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
    const cwd = options.cwd
      ? this.terminalNavigation.resolveCommandCwd(options.cwd)
      : this.cwd;
    const authority = this.traceKernelAuthority;
    if (!authority) {
      throw new Error('TraceKernel session authority is unavailable.');
    }
    const processEnv = Object.freeze({
      ...this.baseEnv,
      ...(options.env ?? {}),
    });
    const kernelProcess = Effect.runSync(authority.session.spawn({
      runtime: this.traceKernelControlledRuntime.runtime,
      command: name,
      cwd,
      env: processEnv,
      sessionId: 1,
      processGroupId: 0,
      owner: this.traceKernelPrincipal(options.actor),
      protected: options.signalPolicy === 'system-only',
    }));
    Effect.runSync(authority.session.attachNullStandardIo(kernelProcess));
    const kernelSnapshot = kernelProcess.snapshot();
    const pid = kernelProcess.pid;
    this.processState.nextPid = Math.max(this.processState.nextPid, pid + 1);
    const process: RuntimeKernelProcessRecord = {
      pid,
      ppid: kernelSnapshot.ppid,
      pgid: kernelSnapshot.pgid,
      sid: kernelSnapshot.sid,
      fds: this.standardProcessFileDescriptors(),
      tty: '?',
      command: name,
      cwd,
      env: processEnv,
      actor: options.actor,
      signalPolicy: options.signalPolicy ?? 'standard',
      startedAt: new Date().toISOString(),
      state: 'running',
      foreground: false,
    };
    this.bindAuthoritativeProcessProjection(process, kernelSnapshot);
    this.processState.executionHandles.set(process.pid, { kernelProcess });
    this.processState.table.set(process.pid, process);
    let clearKernelSignalHandler: (() => void) | undefined;
    void Effect.runPromise(
      kernelProcess.awaitStarted().pipe(
        Effect.zipRight(
          this.traceKernelControlledRuntime.setSignalHandler(
            process.pid,
            (signal) => {
              this.deliverRuntimeSignal(process, signal);
            }
          )
        )
      )
    ).then((clear) => {
      clearKernelSignalHandler = clear;
    }).catch(() => undefined);
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
      if (disposed || !this.processState.table.has(process.pid)) {
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
        clearKernelSignalHandler?.();
        for (const child of this.activeProcessRecords()) {
          if (this.authoritativeProcessSnapshot(child)?.ppid === process.pid) {
            this.queueKernelProcessSignal(child, 'SIGTERM', 'system');
          }
        }
        const kernelDisposal = Effect.runPromise(
          kernelProcess.awaitStarted().pipe(
            Effect.zipRight(
              this.traceKernelControlledRuntime.complete(process.pid, {
                exitCode: 0,
              })
            ),
            Effect.zipRight(kernelProcess.wait()),
            Effect.asVoid
          )
        ).catch(() => undefined);
        this.processState.controlPlaneDisposals.add(kernelDisposal);
        void kernelDisposal.finally(() => {
          this.processState.controlPlaneDisposals.delete(kernelDisposal);
        });
        this.processState.table.delete(process.pid);
        this.processState.executionHandles.delete(process.pid);
        this.observeKernelReparentedChildren(process.pid);
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

  private async awaitControlPlaneProcessDisposals(): Promise<void> {
    while (this.processState.controlPlaneDisposals.size > 0) {
      await Promise.allSettled([...this.processState.controlPlaneDisposals]);
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
      this.accessPolicy.assertWorkspacePathWritable(
        absolutePath,
        'delete'
      );
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
      id: this.lifecycleState.allocateRuntimeActorId(),
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
    return (
      options.presentation !== 'terminal' ||
      event.type !== 'status' ||
      this.lifecycleState.terminalVerbose
    );
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
          this.accessPolicy.assertWorkspaceSubtreeWritable(
            absolutePath,
            'delete'
          );
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
        this.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'delete'
        );
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
        this.accessPolicy.assertWorkspacePathWritable(
          absolutePath,
          'symlink'
        );
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
      this.accessPolicy.isWorkspacePathReadOnly(absolutePath) &&
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
      this.accessPolicy.assertWorkspacePathWritable(
        absolutePath,
        'write'
      );
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
  for (const directory of suppliedDirectories) {
    await workspace.mkdir(directory);
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
  // Restore directory metadata only after descendants. Creating files and
  // links correctly changes their parent directory's mtime in TKFS; applying a
  // persisted directory timestamp before those entries would make hydration
  // nondeterministic and invalidate snapshot manifests.
  if (sessionDirectoryMetadata.length > 0) {
    await workspace.withSuspendedReadonlyPolicy(async () => {
      for (const directory of sessionDirectoryMetadata) {
        await workspace.applyKernelFileChange({ ...directory, directory: true });
      }
    });
  }
  for (const directory of suppliedDirectoryMetadata) {
    await workspace.applyKernelFileChange({ ...directory, directory: true });
  }
  return workspace;
}

/** @deprecated Use RuntimeProjectWorkspace. */
export { RuntimeProjectWorkspace as JustBashRuntimeWorkspace };
