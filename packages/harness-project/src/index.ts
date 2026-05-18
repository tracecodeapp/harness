import {
  Bash,
  defineCommand,
  InMemoryFs,
} from 'just-bash/browser';
import {
  applyRuntimeCommandResultFiles,
  createRuntimeProjectIoBridge,
  RuntimeProjectLiveIoController,
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
  runtimeKernelCopyTarget,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationTarget,
  runtimeKernelReadTarget,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkTarget,
  runtimeKernelVirtualDevices,
  runtimeKernelVirtualFiles,
  runtimeKernelVirtualPaths,
  runtimeKernelWriteTarget,
  readRuntimeProcFile,
  type RuntimeKernelVirtualStat,
} from '../../harness-core/src/runtime-kernel';
import type {
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import packageJson from '../package.json' with { type: 'json' };
import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
  RuntimeCommandEvent,
  RuntimeCommandEventHandler,
  RuntimeCommandEventStream,
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
  RuntimeKernelUserConfig,
  RuntimeKernelUserInfo,
  RuntimeKernelWorkspaceConfig,
  RuntimeKernelWorkspaceInfo,
  RuntimeTraceKernelConfig,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectIoBridge,
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

export interface ProjectWorkspaceExecutionLimits {
  maxCommandCount?: number;
  maxLoopIterations?: number;
  maxCallDepth?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;

export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;

export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;

export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;

export type JavaProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type JavaProjectCommandRunner = RuntimeProjectCommandRunner<JavaProjectCommandRequest>;

export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CppProjectCommandRunner = RuntimeProjectCommandRunner<CppProjectCommandRequest>;

export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;

export interface CreateRuntimeWorkspaceOptions {
  files?: readonly RuntimeFile[];
  directories?: readonly string[];
  entrypoint?: string;
  cwd?: string;
  env?: Record<string, string>;
  commands?: readonly string[];
  customCommands?: readonly ProjectWorkspaceCommand[];
  pythonRunner?: PythonProjectCommandRunner;
  nodeRunner?: JavaScriptProjectCommandRunner;
  javaRunner?: JavaProjectCommandRunner;
  cppRunner?: CppProjectCommandRunner;
  csharpRunner?: CSharpProjectCommandRunner;
  python?: boolean;
  javascript?: boolean | ProjectWorkspaceJavaScriptConfig;
  executionLimits?: ProjectWorkspaceExecutionLimits;
  kernel?: RuntimeTraceKernelConfig;
}

const DEFAULT_CWD = '/workspace';
const TRACE_KERNEL_NAME = 'tracekernel';
const PRINCIPAL_ACTOR: RuntimeWorkspaceActor = { id: 'principal', kind: 'principal' };
const SYSTEM_ACTOR: RuntimeWorkspaceActor = { id: 'system', kind: 'system' };

function assertNoNul(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes.`);
  }
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

function normalizeProcPath(path: string): string | null {
  assertNoNul(path, 'Kernel path');
  return normalizeRuntimeProcPath(path);
}

function kernelWriteTarget(path: string): ReturnType<typeof runtimeKernelWriteTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelWriteTarget(path);
}

function throwKernelWriteTargetError(path: string, target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>): never {
  if (target.reason === 'proc-read-only') throw new Error(`Kernel proc path is read-only: ${path}`);
  if (target.reason === 'device-directory') throw new Error(`Kernel device path is a directory: ${path}`);
  if (target.reason === 'device-read-only') throw new Error(`Kernel device is read-only: ${target.path}`);
  throw new Error(`Kernel device path not found: ${path}`);
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
  if (target.reason === 'proc-read-only') throw new Error(`Kernel proc path is read-only: ${path}`);
  if (target.reason === 'device-not-found') throw new Error(`Kernel device path not found: ${path}`);
  throw new Error(deviceMessage);
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

function kernelStatTarget(path: string, info: RuntimeKernelInfo): ReturnType<typeof runtimeKernelStatTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelStatTarget(path, info);
}

function throwKernelReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelReadTarget>, { kind: 'error' }>
): never {
  if (target.reason === 'permission-denied') throw new Error(`Kernel device is not readable: ${target.path}`);
  throw new Error(`Kernel virtual path not found: ${path}`);
}

function throwKernelFileReadTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>
): never {
  if (target.reason === 'is-directory') throw new Error(`Kernel virtual path is a directory: ${path}`);
  if (target.reason === 'permission-denied') throw new Error(`Kernel device is not readable: ${target.path}`);
  throw new Error(`Kernel virtual path not found: ${path}`);
}

function kernelCopyTarget(source: string, destination: string): ReturnType<typeof runtimeKernelCopyTarget> {
  assertNoNul(source, 'Kernel path');
  assertNoNul(destination, 'Kernel path');
  return runtimeKernelCopyTarget(source, destination);
}

function kernelDirectoryTarget(path: string): ReturnType<typeof runtimeKernelDirectoryTarget> {
  assertNoNul(path, 'Kernel path');
  return runtimeKernelDirectoryTarget(path);
}

function throwKernelMetadataTargetError(
  path: string,
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>
): never {
  if (target.reason === 'proc-read-only') throw new Error(`Kernel proc path is read-only: ${path}`);
  throw new Error(`Kernel device path not found: ${path}`);
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

async function collectSnapshotFiles(
  fs: CommandContext['fs'],
  cwd: string,
  absolutePath: string,
  files: RuntimeFile[],
  directories: string[]
): Promise<void> {
  if (!isWithinWorkspace(cwd, absolutePath)) {
    throw new Error(`Refusing to snapshot path outside workspace: ${absolutePath}`);
  }

  const stat = await fs.stat(absolutePath);
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
  const directoryPath = toProjectDirectoryPath(cwd, absolutePath);
  if (directoryPath !== null) directories.push(directoryPath);

  for (const entry of await fs.readdir(absolutePath)) {
    await collectSnapshotFiles(fs, cwd, `${absolutePath}/${entry}`, files, directories);
  }
}

async function snapshotCommandContext(
  ctx: CommandContext,
  workspaceRoot: string,
  entrypoint?: string,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo
): Promise<RuntimeProjectSnapshot> {
  const files: RuntimeFile[] = [];
  const directories: string[] = [];
  await collectSnapshotFiles(ctx.fs, workspaceRoot, workspaceRoot, files, directories);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.localeCompare(right));
  return {
    cwd: workspaceRoot,
    workspaceRoot,
    ...(workspaceAlias ? { workspaceAlias } : {}),
    ...(kernel ? { kernel } : {}),
    ...(kernel ? { kernelDevices: runtimeKernelVirtualDevices() } : {}),
    ...(kernel ? { kernelFiles: runtimeKernelVirtualFiles(kernel) } : {}),
    files,
    ...(directories.length > 0 ? { directories } : {}),
    ...(entrypoint ? { entrypoint } : {}),
  };
}

type RuntimeFileChangeObserver = (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => void;

async function applyCommandResultFiles(
  ctx: CommandContext,
  workspaceRoot: string,
  result: RuntimeCommandResult,
  onFileChange?: RuntimeFileChangeObserver
): Promise<RuntimeCommandResult> {
  return applyRuntimeCommandResultFiles(result, async (file, phase) => {
    await withSuspendedFsNotifications(ctx.fs, async () => {
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
  return applyRuntimeCommandResultFiles(result, async (file, phase) => {
    await workspace.applyKernelFileChange(file, phase);
  });
}

function assertSupportedEncoding(encoding: RuntimeFileEncoding | undefined): RuntimeFileEncoding {
  return encoding ?? 'utf8';
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

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left, 0);
  bytes.set(right, left.byteLength);
  return bytes;
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

type FsReadFileOptions = Parameters<IFileSystem['readFile']>[1];
type FsWriteFileOptions = Parameters<IFileSystem['writeFile']>[2];
type FsMkdirOptions = Parameters<IFileSystem['mkdir']>[1];
type FsRmOptions = Parameters<IFileSystem['rm']>[1];
type FsCpOptions = Parameters<IFileSystem['cp']>[2];

class KernelObservedFileSystem implements IFileSystem {
  private suspendDepth = 0;

  constructor(
    private readonly base: IFileSystem,
    private readonly workspaceRoot: () => string,
    private readonly workspaceAlias: () => string | undefined,
    private readonly kernelInfo: () => RuntimeKernelInfo,
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

  readFile(path: string, options?: FsReadFileOptions): Promise<string> {
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(this.readDeviceFile(readTarget.path, options));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(this.readProcFile(readTarget.path, options));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(throwKernelReadTargetError(path, readTarget));
    return this.base.readFile(this.mapPath(path), options);
  }

  readFileBytes?(path: string): Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never> {
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
    return this.base.readFileBytes(this.mapPath(path)) as Promise<ReturnType<NonNullable<IFileSystem['readFileBytes']>> extends Promise<infer T> ? T : never>;
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'device-file') return Promise.resolve(new TextEncoder().encode(this.readDeviceFile(readTarget.path)));
    if (readTarget.kind === 'device-directory') return Promise.reject(new Error(`Kernel device path is a directory: ${path}`));
    if (readTarget.kind === 'proc-file') return Promise.resolve(new TextEncoder().encode(this.readProcFile(readTarget.path)));
    if (readTarget.kind === 'proc-directory') return Promise.reject(new Error(`Kernel proc path is a directory: ${path}`));
    if (readTarget.kind === 'error') return Promise.reject(throwKernelReadTargetError(path, readTarget));
    return this.base.readFileBuffer(this.mapPath(path));
  }

  async writeFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    await this.base.writeFile(mappedPath, content, options);
    await this.emitFileWrite(mappedPath);
  }

  async appendFile(path: string, content: FileContent, options?: FsWriteFileOptions): Promise<void> {
    const writeTarget = kernelWriteTarget(path);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(path, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(content));
      return;
    }
    const mappedPath = this.mapPath(path);
    await this.base.appendFile(mappedPath, content, options);
    await this.emitFileWrite(mappedPath);
  }

  exists(path: string): Promise<boolean> {
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return Promise.resolve(true);
    if (accessTarget.kind === 'denied') return Promise.resolve(false);
    return this.base.exists(this.mapPath(path));
  }

  stat(path: string): Promise<Awaited<ReturnType<IFileSystem['stat']>>> {
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    return this.base.stat(this.mapPath(path));
  }

  async mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') return Promise.reject(new Error(
      mkdirTarget.reason === 'proc-read-only'
        ? `Kernel proc path is read-only: ${path}`
        : `Kernel device namespace is read-only: ${path}`
    ));
    const mappedPath = this.mapPath(path);
    const createdDirectories = await this.collectMissingDirectories(mappedPath);
    await this.base.mkdir(mappedPath, options);
    for (const directoryPath of createdDirectories) {
      this.emitDirectoryCreate(directoryPath);
    }
  }

  readdir(path: string): Promise<string[]> {
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return Promise.resolve(directoryTarget.entries.map((entry) => entry.name));
    if (directoryTarget.kind === 'error') {
      return Promise.reject(new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      ));
    }
    return this.base.readdir(this.mapPath(path));
  }

  readdirWithFileTypes?(path: string): Promise<Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>> {
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
    return this.base.readdirWithFileTypes(this.mapPath(path));
  }

  async rm(path: string, options?: FsRmOptions): Promise<void> {
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const mappedPath = this.mapPath(path);
    const deletedFiles = await this.collectExistingFiles(mappedPath);
    const deletedDirectories = await this.collectExistingDirectories(mappedPath);
    await this.base.rm(mappedPath, options);
    for (const deletedPath of deletedFiles) {
      this.emitFileDelete(deletedPath);
    }
    for (const deletedPath of deletedDirectories) {
      this.emitDirectoryDelete(deletedPath);
    }
  }

  async cp(src: string, dest: string, options?: FsCpOptions): Promise<void> {
    const copyTarget = kernelCopyTarget(src, dest);
    if (copyTarget.kind === 'file-copy') {
      await this.copyFileLike(src, dest);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'source-directory'
          ? `Kernel virtual path is a directory: ${src}`
          : `Kernel virtual path not found: ${src}`
      );
    }
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    await this.base.cp(mappedSource, mappedDestination, options);
    await this.emitExistingDirectories(mappedDestination);
    await this.emitExistingFiles(mappedDestination);
  }

  private async copyFileLike(src: string, dest: string): Promise<void> {
    const sourceBytes = await this.readKernelCopySource(src);
    const writeTarget = kernelWriteTarget(dest);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(dest, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(sourceBytes));
      return;
    }
    const mappedDestination = this.mapPath(dest);
    await this.base.writeFile(mappedDestination, sourceBytes);
    await this.emitFileWrite(mappedDestination);
  }

  private async readKernelCopySource(path: string): Promise<FileContent> {
    const sourceTarget = kernelFileReadTarget(path);
    if (sourceTarget.kind === 'device-file') return this.readDeviceFile(sourceTarget.path);
    if (sourceTarget.kind === 'proc-file') return readRuntimeProcFile(sourceTarget.path, this.kernelInfo());
    if (sourceTarget.kind === 'error') throwKernelFileReadTargetError(path, sourceTarget);
    return this.base.readFileBuffer(this.mapPath(path));
  }

  async mv(src: string, dest: string): Promise<void> {
    const sourceMutationTarget = kernelMutationTarget(src);
    if (sourceMutationTarget.kind === 'error') throwKernelMutationTargetError(src, sourceMutationTarget, 'Kernel device namespace is read-only.');
    const destinationMutationTarget = kernelMutationTarget(dest);
    if (destinationMutationTarget.kind === 'error') throwKernelMutationTargetError(dest, destinationMutationTarget, 'Kernel device namespace is read-only.');
    const mappedSource = this.mapPath(src);
    const mappedDestination = this.mapPath(dest);
    const deletedFiles = await this.collectExistingFiles(mappedSource);
    const deletedDirectories = await this.collectExistingDirectories(mappedSource);
    await this.base.mv(mappedSource, mappedDestination);
    await this.emitExistingDirectories(mappedDestination);
    await this.emitExistingFiles(mappedDestination);
    for (const deletedPath of deletedFiles) {
      this.emitFileDelete(deletedPath);
    }
    for (const deletedPath of deletedDirectories) {
      this.emitDirectoryDelete(deletedPath);
    }
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
    return Array.from(new Set([...aliasPaths, ...runtimeKernelVirtualPaths()])).sort((left, right) => left.localeCompare(right));
  }

  chmod(path: string, mode: number): Promise<void> {
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    return this.base.chmod(this.mapPath(path), mode);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    const symlinkTarget = kernelSymlinkTarget(linkPath);
    if (symlinkTarget.kind === 'error') throwKernelMutationTargetError(linkPath, symlinkTarget);
    return this.base.symlink(target, this.mapPath(linkPath));
  }

  link(existingPath: string, newPath: string): Promise<void> {
    const linkTarget = kernelLinkTarget(existingPath, newPath);
    if (linkTarget.kind === 'error') throwKernelMutationTargetError(linkTarget.side === 'source' ? existingPath : newPath, linkTarget);
    return this.base.link(this.mapPath(existingPath), this.mapPath(newPath));
  }

  readlink(path: string): Promise<string> {
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind !== 'workspace') return Promise.reject(new Error(`Kernel virtual path is not a symbolic link: ${path}`));
    return this.base.readlink(this.mapPath(path));
  }

  lstat(path: string): Promise<Awaited<ReturnType<IFileSystem['lstat']>>> {
    const statTarget = kernelStatTarget(path, this.kernelInfo());
    if (statTarget.kind === 'stat') return Promise.resolve(this.virtualStat(statTarget.stat));
    if (statTarget.kind === 'error') return Promise.reject(new Error(`Kernel virtual path not found: ${path}`));
    return this.base.lstat(this.mapPath(path));
  }

  realpath(path: string): Promise<string> {
    assertNoNul(path, 'Kernel path');
    if (isRuntimeKernelVirtualNamespacePath(path)) return Promise.resolve(path);
    return this.base.realpath(this.mapPath(path));
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const metadataTarget = kernelMetadataTarget(path);
    if (metadataTarget.kind === 'ignored-device') return Promise.resolve();
    if (metadataTarget.kind === 'error') throwKernelMetadataTargetError(path, metadataTarget);
    return this.base.utimes(this.mapPath(path), atime, mtime);
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
    const content = readRuntimeProcFile(path, this.kernelInfo());
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

export function createPythonProjectCommands(
  runner: PythonProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo
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

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin,
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel),
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
  kernel?: RuntimeKernelInfo
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

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin,
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel),
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

export function createJavaProjectCommands(
  runner: JavaProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo
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
      stdin: decodeCommandStdin(ctx.stdin),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel),
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

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath: jarPath ?? parsed.mainClass ?? '<main>',
      args: programArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin: decodeCommandStdin(ctx.stdin),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel),
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
      code: '',
      source: 'compile',
      scriptPath: parsed.args.find((arg) => /\.(?:c|cc|cpp|cxx)$/i.test(arg)) ?? '<compile>',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin: decodeCommandStdin(ctx.stdin),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel),
      options: { compilerCommand },
    });
    const commandResult = await applyCommandResultFiles(ctx, workspaceRoot, result, options.onFileChange);
    if (commandResult.exitCode === 0) {
      options.recordExecutablePath?.(toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, cppOutputPathFromArgs(parsed.args), options.workspaceAlias)));
    }
    return commandResult;
  };

  const runExecutable = (defaultPath: string | null) => async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, options.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    const scriptPath = defaultPath ?? expandedArgs[0];
    if (!scriptPath) {
      return { stdout: '', stderr: 'cpp-run: missing executable path\n', exitCode: 2 };
    }
    const programArgs = defaultPath === null ? expandedArgs.slice(1) : expandedArgs;
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath,
      args: programArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin: decodeCommandStdin(ctx.stdin),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel),
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
    defineCommand('cpp-run', runExecutable(null)),
  ];
}

export function createCSharpProjectCommands(
  runner: CSharpProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo
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

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: parsed.source,
      scriptPath: parsed.scriptPath,
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      stdin: decodeCommandStdin(ctx.stdin),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel),
      ...(parsed.buildArgs || parsed.noBuild
        ? {
            options: {
              ...(parsed.buildArgs ? { buildArgs: parsed.buildArgs } : {}),
              ...(parsed.noBuild ? { noBuild: true } : {}),
            },
          }
        : {}),
    }), onFileChange);
  };

  return [
    defineCommand('dotnet', runDotnet),
  ];
}

export class JustBashRuntimeWorkspace implements RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly cwd: string;
  readonly kernelInfo: RuntimeKernelInfo;
  private readonly bash: Bash;
  private readonly fs: KernelObservedFileSystem;
  private readonly entrypoint?: string;
  private readonly cppRunner?: CppProjectCommandRunner;
  private readonly cppExecutablePaths = new Set<string>();
  private readonly eventWatchers = new Set<RuntimeWorkspaceEventHandler>();
  private activeCommandEventHandler?: RuntimeCommandEventHandler;
  private activeCommandActor?: RuntimeWorkspaceActor;
  private activeCommandStdin = '';
  private activeDeviceStdout = '';
  private activeDeviceStderr = '';
  private activeRuntimeIo = this.createRuntimeLiveIoController();
  private nextCommandId = 1;

  constructor(options: CreateRuntimeWorkspaceOptions = {}) {
    this.kernelInfo = createTraceKernelInfo(options.kernel, options.cwd);
    this.cwd = this.kernelInfo.workspaceRoot;
    this.entrypoint = options.entrypoint ? this.toWorkspaceRelativePath(options.entrypoint) : undefined;
    this.cppRunner = options.cppRunner;
    this.kernel = this.createKernel();
    this.fs = new KernelObservedFileSystem(
      new InMemoryFs(),
      () => this.cwd,
      () => this.kernelInfo.workspaceAlias,
      () => this.kernelInfo,
      (change) => {
        if (!this.activeCommandActor) return;
        this.emitLocalRuntimeEvent({ type: 'file-change', change, phase: 'live' });
      },
      (device) => this.readDevice(device),
      (device, data) => this.writeDevice(device, data)
    );
    const withEvents = <Request extends RuntimeProjectCommandRequest<string>>(
      runner: RuntimeProjectCommandRunner<Request>
    ): RuntimeProjectCommandRunner<Request> => (
      async (request) => {
        const result = await runner({
          ...request,
          onEvent: (event) => {
            this.handleRuntimeCommandEvent(event);
          },
        } as Request);
        await this.flushRuntimeEventQueue();
        return this.activeRuntimeIo.filterAppliedResultFiles(result);
      }
    );
    const observeFileChange: RuntimeFileChangeObserver = (change, phase) => {
      this.emitLocalRuntimeEvent({ type: 'file-change', change, phase });
    };
    const customCommands = [
      ...(options.pythonRunner ? createPythonProjectCommands(withEvents(options.pythonRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo) : []),
      ...(options.nodeRunner ? createNodeProjectCommands(withEvents(options.nodeRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo) : []),
      ...(options.javaRunner ? createJavaProjectCommands(withEvents(options.javaRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo) : []),
      ...(options.cppRunner ? createCppProjectCommands(withEvents(options.cppRunner), this.cwd, {
        recordExecutablePath: (path) => this.cppExecutablePaths.add(path),
        entrypoint: this.entrypoint,
        onFileChange: observeFileChange,
        workspaceAlias: this.kernelInfo.workspaceAlias,
        kernel: this.kernelInfo,
      }) : []),
      ...(options.csharpRunner ? createCSharpProjectCommands(withEvents(options.csharpRunner), this.cwd, this.entrypoint, observeFileChange, this.kernelInfo.workspaceAlias, this.kernelInfo) : []),
      ...(options.customCommands ?? []),
    ];
    this.bash = new Bash({
      fs: this.fs,
      cwd: this.cwd,
      env: options.env,
      commands: options.commands as never,
      customCommands: customCommands.length > 0 ? customCommands as never : undefined,
      python: options.python,
      javascript: options.javascript as never,
      executionLimits: options.executionLimits as never,
    });
  }

  async ensureReady(): Promise<void> {
    await this.bash.fs.mkdir(this.cwd, { recursive: true });
  }

  async writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
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

  private readProcFile(path: string, encoding?: RuntimeFileEncoding): string | null {
    const procPath = normalizeProcPath(path);
    if (procPath === null) return null;
    if (encoding === 'base64') {
      throw new Error(`Kernel proc path does not support base64 reads: ${path}`);
    }
    try {
      return readRuntimeProcFile(procPath, this.kernelInfo);
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
    const inputDevice = runtimeDeviceInputSource(device);
    if (inputDevice && inputDevice !== '/dev/null') return this.activeCommandStdin;
    return '';
  }

  private writeDevice(device: RuntimeKernelDevicePath, data: string, actor?: RuntimeWorkspaceActor): void {
    const outputDevice = runtimeDeviceOutputTarget(device);
    if (!outputDevice) throw new Error(`Kernel device is read-only: ${device}`);
    if (outputDevice === '/dev/null') return;
    if (this.activeCommandActor) {
      if (outputDevice === '/dev/stdout') this.activeDeviceStdout += data;
      if (outputDevice === '/dev/stderr') this.activeDeviceStderr += data;
    }
    this.emitLocalRuntimeEvent({
      type: 'output',
      stream: outputDevice === '/dev/stderr' ? 'stderr' : 'stdout',
      device: outputDevice,
      ...(device !== outputDevice ? { sourceDevice: device } : {}),
      data,
      ...(actor ? { actor } : {}),
    });
  }

  private async writeFileAs(
    path: string,
    contents: string,
    actor: RuntimeWorkspaceActor,
    encoding?: RuntimeFileEncoding,
    phase: RuntimeFileMutationPhase = 'live'
  ): Promise<void> {
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
    await this.bash.fs.mkdir(dirname(absolutePath), { recursive: true });

    if (normalizedEncoding === 'base64') {
      await this.bash.fs.writeFile(absolutePath, bytesFromBase64(contents));
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change: { path: toProjectPath(this.cwd, absolutePath), contents, encoding: 'base64' },
        phase,
        actor,
      });
      return;
    }

    await this.bash.fs.writeFile(absolutePath, contents);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: toProjectPath(this.cwd, absolutePath), contents },
      phase,
      actor,
    });
  }

  async writeFiles(files: readonly RuntimeFile[]): Promise<void> {
    for (const file of files) {
      await this.writeFile(file.path, file.contents, file.encoding);
    }
  }

  async appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void> {
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
    await this.bash.fs.mkdir(dirname(absolutePath), { recursive: true });
    const nextBytes = normalizedEncoding === 'base64'
      ? bytesFromBase64(contents)
      : new TextEncoder().encode(contents);
    const previousBytes = await this.bash.fs.exists(absolutePath)
      ? await this.bash.fs.readFileBuffer(absolutePath)
      : new Uint8Array();
    const bytes = concatBytes(previousBytes, nextBytes);
    await this.bash.fs.writeFile(absolutePath, bytes);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: normalizedEncoding === 'base64'
        ? { path: toProjectPath(this.cwd, absolutePath), contents: base64FromBytes(bytes), encoding: 'base64' }
        : { path: toProjectPath(this.cwd, absolutePath), contents: new TextDecoder().decode(bytes) },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string> {
    const readTarget = kernelReadTarget(path);
    if (readTarget.kind === 'proc-file') {
      if (encoding === 'base64') throw new Error(`Kernel proc path does not support base64 reads: ${path}`);
      return readRuntimeProcFile(readTarget.path, this.kernelInfo);
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
    if (normalizedEncoding === 'base64') {
      const bytes = await this.bash.fs.readFileBuffer(absolutePath);
      return base64FromBytes(bytes);
    }
    return this.bash.fs.readFile(absolutePath);
  }

  async exists(path: string): Promise<boolean> {
    const accessTarget = kernelAccessTarget(path);
    if (accessTarget.kind === 'allowed') return true;
    if (accessTarget.kind === 'denied') return false;
    return this.bash.fs.exists(this.toWorkspaceEntryPath(path));
  }

  async stat(path: string): Promise<RuntimeWorkspaceStat> {
    const statTarget = kernelStatTarget(path, this.kernelInfo);
    if (statTarget.kind === 'stat') return { isFile: statTarget.stat.isFile, isDirectory: statTarget.stat.isDirectory };
    if (statTarget.kind === 'error') throw new Error(`Kernel virtual path not found: ${path}`);
    const stat = await this.bash.fs.stat(this.toWorkspaceEntryPath(path));
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
    };
  }

  async readDir(path = '.'): Promise<string[]> {
    const directoryTarget = kernelDirectoryTarget(path);
    if (directoryTarget.kind === 'directory') return directoryTarget.entries.map((entry) => entry.name);
    if (directoryTarget.kind === 'error') {
      throw new Error(
        directoryTarget.reason === 'not-directory'
          ? `Kernel virtual path is not a directory: ${path}`
          : `Kernel virtual path not found: ${path}`
      );
    }
    const entries = await this.bash.fs.readdir(this.toWorkspaceEntryPath(path));
    return [...entries].sort((left, right) => left.localeCompare(right));
  }

  async mkdir(path: string): Promise<void> {
    const mkdirTarget = kernelMkdirTarget(path);
    if (mkdirTarget.kind === 'error') throwKernelMutationTargetError(path, mkdirTarget);
    const absolutePath = this.toWorkspaceEntryPath(path);
    const createdDirectories = await this.collectMissingWorkspaceDirectories(absolutePath);
    await this.bash.fs.mkdir(absolutePath, { recursive: true });
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
    const copyTarget = kernelCopyTarget(sourcePath, destinationPath);
    if (copyTarget.kind === 'file-copy') {
      await this.copyFileLike(sourcePath, destinationPath);
      return;
    }
    if (copyTarget.kind === 'error') {
      throw new Error(
        copyTarget.reason === 'source-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    const absoluteDestinationPath = this.toWorkspacePath(destinationPath);
    const absoluteSourcePath = this.toWorkspacePath(sourcePath);
    const sourceBytes = await this.bash.fs.readFileBuffer(absoluteSourcePath);
    await this.bash.fs.mkdir(dirname(absoluteDestinationPath), { recursive: true });
    await this.bash.fs.writeFile(absoluteDestinationPath, sourceBytes);
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: toProjectPath(this.cwd, absoluteDestinationPath), contents: base64FromBytes(sourceBytes), encoding: 'base64' },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  private async copyFileLike(sourcePath: string, destinationPath: string): Promise<void> {
    const sourceBytes = await this.readKernelCopyBytes(sourcePath);
    const writeTarget = kernelWriteTarget(destinationPath);
    if (writeTarget.kind === 'error') throwKernelWriteTargetError(destinationPath, writeTarget);
    if (writeTarget.kind === 'device') {
      this.writeDevice(writeTarget.device, contentToText(sourceBytes), PRINCIPAL_ACTOR);
      return;
    }
    await this.writeFileAs(destinationPath, base64FromBytes(sourceBytes), PRINCIPAL_ACTOR, 'base64', 'live');
  }

  private async readKernelCopyBytes(sourcePath: string): Promise<Uint8Array> {
    const sourceTarget = kernelFileReadTarget(sourcePath);
    if (sourceTarget.kind === 'device-file') return new TextEncoder().encode(this.readDevice(sourceTarget.path));
    if (sourceTarget.kind === 'proc-file') return new TextEncoder().encode(readRuntimeProcFile(sourceTarget.path, this.kernelInfo));
    if (sourceTarget.kind === 'error') {
      throw new Error(
        sourceTarget.reason === 'is-directory'
          ? `Kernel virtual path is a directory: ${sourcePath}`
          : `Kernel virtual path not found: ${sourcePath}`
      );
    }
    return this.bash.fs.readFileBuffer(this.toWorkspacePath(sourcePath));
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const renameTarget = kernelRenameTarget(sourcePath, destinationPath);
    if (renameTarget.kind === 'error') throw new Error('Kernel virtual paths are read-only for move operations.');
    await this.copyFile(sourcePath, destinationPath);
    await this.bash.fs.rm(this.toWorkspacePath(sourcePath), { force: true });
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: this.toWorkspaceRelativePath(sourcePath), deleted: true },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async deleteFile(path: string): Promise<void> {
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    await this.bash.fs.rm(this.toWorkspacePath(path), { force: true });
    this.emitLocalRuntimeEvent({
      type: 'file-change',
      change: { path: this.toWorkspaceRelativePath(path), deleted: true },
      phase: 'live',
      actor: PRINCIPAL_ACTOR,
    });
  }

  async remove(path: string, options: RuntimeWorkspaceRemoveOptions = {}): Promise<void> {
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const deletedChanges = await this.collectDeletedChangesForRemove(path, options);
    await this.bash.fs.rm(this.toWorkspaceEntryPath(path), {
      force: options.force ?? true,
      recursive: options.recursive,
    });
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
    let result: { stdout: string; stderr: string; exitCode: number };
    let commandDeviceStdout = '';
    let commandDeviceStderr = '';
    const previousEventHandler = this.activeCommandEventHandler;
    const previousActor = this.activeCommandActor;
    const previousStdin = this.activeCommandStdin;
    const previousDeviceStdout = this.activeDeviceStdout;
    const previousDeviceStderr = this.activeDeviceStderr;
    const previousRuntimeIo = this.activeRuntimeIo;
    this.activeCommandEventHandler = options.onEvent;
    this.activeCommandActor = this.createRuntimeActor();
    this.activeCommandStdin = options.stdin ?? '';
    this.activeDeviceStdout = '';
    this.activeDeviceStderr = '';
    this.activeRuntimeIo = this.createRuntimeLiveIoController();
    try {
      const directCppResult = await this.tryRunCppExecutable(command, options);
      if (directCppResult) {
        await this.flushRuntimeEventQueue();
        this.emitReturnedOutputEvents(directCppResult);
        return directCppResult;
      }

      result = await this.bash.exec(command, {
        cwd: options.cwd ? this.toWorkspacePath(options.cwd) : this.cwd,
        env: options.env,
        stdin: options.stdin,
        signal: options.signal,
        args: options.args,
      });
      await this.flushRuntimeEventQueue();
      this.emitReturnedOutputEvents(result);
    } finally {
      commandDeviceStdout = this.activeDeviceStdout;
      commandDeviceStderr = this.activeDeviceStderr;
      this.activeCommandEventHandler = previousEventHandler;
      this.activeCommandActor = previousActor;
      this.activeCommandStdin = previousStdin;
      this.activeDeviceStdout = previousDeviceStdout;
      this.activeDeviceStderr = previousDeviceStderr;
      this.activeRuntimeIo = previousRuntimeIo;
    }
    return {
      stdout: `${result.stdout}${commandDeviceStdout}`,
      stderr: `${result.stderr}${commandDeviceStderr}`,
      exitCode: result.exitCode,
    };
  }

  private async tryRunCppExecutable(
    command: string,
    options: RuntimeCommandOptions
  ): Promise<RuntimeCommandResult | null> {
    if (!this.cppRunner || options.args !== undefined) return null;

    const words = parseSimpleCommandWords(command);
    if (!words || words.length === 0) return null;

    const cwd = options.cwd ? this.toWorkspacePath(options.cwd) : this.cwd;
    const env = {
      ...this.bash.getEnv(),
      ...(options.env ?? {}),
    };
    const ctx = {
      fs: this.bash.fs,
      cwd,
      env: new Map(Object.entries(env)),
      stdin: options.stdin ?? '',
    } as unknown as CommandContext;
    let expandedInvocation: { scriptFile: string | null; scriptArgs: string[] };
    try {
      expandedInvocation = await expandParsedScriptInvocation(ctx, this.cwd, words[0] ?? null, words.slice(1), this.kernelInfo.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }

    const executable = expandedInvocation.scriptFile;
    if (!executable || (!executable.includes('/') && !executable.startsWith('/'))) return null;

    const executablePath = toProjectPath(this.cwd, resolveWorkspaceCommandPath(this.cwd, cwd, executable, this.kernelInfo.workspaceAlias));
    if (!this.cppExecutablePaths.has(executablePath)) return null;

    const result = await this.cppRunner({
      code: '',
      source: 'run',
      scriptPath: executable.startsWith('./') ? executable.slice(2) : executable,
      args: expandedInvocation.scriptArgs,
      cwd,
      env,
      stdin: options.stdin ?? '',
      project: await this.snapshot(),
      onEvent: (event) => {
        this.handleRuntimeCommandEvent(event);
      },
    });
    await this.flushRuntimeEventQueue();
    return applyWorkspaceCommandResultFiles(
      this,
      this.activeRuntimeIo.filterAppliedResultFiles(result)
    );
  }

  async snapshot(options: { entrypoint?: string } = {}): Promise<RuntimeProjectSnapshot> {
    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    await this.collectFiles(this.cwd, files, directories);
    files.sort((left, right) => left.path.localeCompare(right.path));
    directories.sort((left, right) => left.localeCompare(right));
    return {
      cwd: this.cwd,
      workspaceRoot: this.cwd,
      ...(this.kernelInfo.workspaceAlias ? { workspaceAlias: this.kernelInfo.workspaceAlias } : {}),
      kernel: this.kernelInfo,
      kernelDevices: runtimeKernelVirtualDevices(),
      kernelFiles: runtimeKernelVirtualFiles(this.kernelInfo),
      files,
      ...(directories.length > 0 ? { directories } : {}),
      ...(options.entrypoint || this.entrypoint
        ? { entrypoint: options.entrypoint ? this.toWorkspaceRelativePath(options.entrypoint) : this.entrypoint }
        : {}),
    };
  }

  dispose(): void {
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
    actor: RuntimeWorkspaceActor = this.activeCommandActor ?? SYSTEM_ACTOR
  ): Promise<void> {
    await this.kernel.applyFileChange(change, actor, phase);
  }

  private createKernel(): RuntimeWorkspaceKernel {
    return {
      info: this.kernelInfo,
      readFile: (path, _actor, encoding) => this.readFile(path, encoding),
      writeFile: (path, contents, actor = PRINCIPAL_ACTOR, encoding) => this.writeFileAs(path, contents, actor, encoding, 'live'),
      deleteFile: (path, actor = PRINCIPAL_ACTOR) => this.deleteFileAs(path, actor, 'live'),
      applyFileChange: async (change, actor = this.activeCommandActor ?? SYSTEM_ACTOR, phase = 'final-diff') => {
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
    const mutationTarget = kernelMutationTarget(change.path);
    if (mutationTarget.kind === 'error') {
      throwKernelMutationTargetError(change.path, mutationTarget, `Kernel device namespace is not a file-change target: ${change.path}`);
    }
    if (isRuntimeDirectoryChange(change)) {
      const relativePath = this.toWorkspaceRelativePath(change.path);
      const absolutePath = this.toWorkspaceEntryPath(change.path);
      if (change.deleted === true) {
        await this.bash.fs.rm(absolutePath, { force: true, recursive: true });
      } else {
        await this.bash.fs.mkdir(absolutePath, { recursive: true });
      }
      this.emitLocalRuntimeEvent({
        type: 'file-change',
        change: { path: relativePath, directory: true, ...(change.deleted === true ? { deleted: true } : {}) },
        phase,
        actor,
      });
      return;
    }
    if ((change as RuntimeFileDeletion).deleted === true) {
      await this.deleteFileAs(change.path, actor, phase);
      return;
    }
    const changedFile = change as RuntimeFile;
    await this.writeFileAs(changedFile.path, changedFile.contents, actor, changedFile.encoding, phase);
  }

  private async deleteFileAs(
    path: string,
    actor: RuntimeWorkspaceActor,
    phase: RuntimeFileMutationPhase
  ): Promise<void> {
    const removeTarget = kernelRemoveTarget(path);
    if (removeTarget.kind === 'error') throwKernelMutationTargetError(path, removeTarget);
    const relativePath = this.toWorkspaceRelativePath(path);
    await this.bash.fs.rm(this.toWorkspacePath(path), { force: true });
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
      },
    };
  }

  private createRuntimeLiveIoController(): RuntimeProjectLiveIoController {
    return new RuntimeProjectLiveIoController({
      actor: this.activeCommandActor ?? SYSTEM_ACTOR,
      applyFileChange: (change) => this.applyRuntimeFileChangeSilently(change),
      onEvent: (event) => this.emitRuntimeEvent(event),
    });
  }

  private handleRuntimeCommandEvent(event: RuntimeCommandEvent): void {
    this.activeRuntimeIo.handleRuntimeEvent(event);
  }

  private async flushRuntimeEventQueue(): Promise<void> {
    await this.activeRuntimeIo.flush();
  }

  private async applyRuntimeFileChangeSilently(change: RuntimeFileChange): Promise<void> {
    await withSuspendedFsNotifications(this.bash.fs, async () => {
      const mutationTarget = kernelMutationTarget(change.path);
      if (mutationTarget.kind === 'error') {
        throwKernelMutationTargetError(change.path, mutationTarget, `Kernel device namespace is not a file-change target: ${change.path}`);
      }
      const absolutePath = this.toWorkspaceEntryPath(change.path);
      if (isRuntimeDirectoryChange(change)) {
        if (change.deleted === true) {
          await this.bash.fs.rm(absolutePath, { force: true, recursive: true });
          return;
        }
        await this.bash.fs.mkdir(absolutePath, { recursive: true });
        return;
      }
      if ((change as RuntimeFileDeletion).deleted === true) {
        await this.bash.fs.rm(absolutePath, { force: true });
        return;
      }

      const changedFile = change as RuntimeFile;
      await this.bash.fs.mkdir(dirname(absolutePath), { recursive: true });
      if ((changedFile.encoding ?? 'utf8') === 'base64') {
        await this.bash.fs.writeFile(absolutePath, bytesFromBase64(changedFile.contents));
        return;
      }
      await this.bash.fs.writeFile(absolutePath, changedFile.contents);
    });
  }

  private emitLocalRuntimeEvent(event: RuntimeCommandEvent): void {
    if (this.activeCommandActor) {
      this.activeRuntimeIo.emit(event);
      return;
    }
    this.emitRuntimeEvent(event);
  }

  private emitRuntimeEvent(event: RuntimeCommandEvent): void {
    const actor = 'actor' in event && event.actor ? event.actor : this.activeCommandActor;
    const enriched = this.enrichRuntimeEvent(event, actor);
    this.activeCommandEventHandler?.(enriched);
    for (const watcher of this.eventWatchers) {
      watcher(enriched);
    }
  }

  private emitReturnedOutputEvents(result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>): void {
    this.activeRuntimeIo.emitMissingFinalOutput(result, (stream, data) => {
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
    options: RuntimeWorkspaceRemoveOptions
  ): Promise<RuntimeFileChange[]> {
    const absolutePath = this.toWorkspaceEntryPath(path);
    if (!(await this.bash.fs.exists(absolutePath))) return [];
    const stat = await this.bash.fs.stat(absolutePath);
    if (stat.isFile) return [{ path: toProjectPath(this.cwd, absolutePath), deleted: true }];
    if (!stat.isDirectory || !options.recursive) return [];

    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    await collectSnapshotFiles(this.bash.fs, this.cwd, absolutePath, files, directories);
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
  const workspace = new JustBashRuntimeWorkspace(options);
  await workspace.ensureReady();
  if (options.directories) {
    for (const directory of options.directories) {
      await workspace.mkdir(directory);
    }
  }
  if (options.files) {
    await workspace.writeFiles(options.files);
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
  RuntimeKernelUserConfig,
  RuntimeKernelUserInfo,
  RuntimeKernelWorkspaceConfig,
  RuntimeKernelWorkspaceInfo,
  RuntimeKernelDevicePath,
  RuntimeFileMutationPhase,
  RuntimeTraceKernelConfig,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectIoBridge,
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
};

export { RuntimeProjectLiveIoController, createRuntimeProjectIoBridge, runRuntimeProjectWorkerBridge };
