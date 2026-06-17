import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeFileMutationPhase,
  RuntimeKernelDeviceInfo,
  RuntimeKernelDevicePath,
  RuntimeKernelHttpBridge,
  RuntimeKernelHttpListenerHandle,
  RuntimeKernelHttpListenOptions,
  RuntimeKernelHttpProtocolMessage,
  RuntimeKernelHttpRequest,
  RuntimeKernelHttpResponse,
  RuntimeKernelInfo,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';
import {
  RuntimeProjectLiveIoController,
  createRuntimeProjectIoBridge,
  readRuntimeCommandStdinPipeBytes,
  runtimeAbortSignalName,
  runRuntimeProjectWorkerBridge,
  runtimeCommandStdinPipeClosed,
  runtimeCommandStdinPipeRemainingBytes,
  runtimeSignalExitCode,
} from '../../harness-core/src/runtime-project';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import {
  createTypeScriptProjectRunner,
  type TypeScriptProjectCompiler,
} from './typescript-project';
export {
  createTypeScriptProjectRunner,
  type TypeScriptProjectCommandRequest,
  type TypeScriptProjectCommandResult,
  type TypeScriptProjectCommandRunner,
  type TypeScriptProjectFile,
  type TypeScriptProjectFileEncoding,
  type TypeScriptProjectRunnerOptions,
  type TypeScriptProjectSnapshot,
} from './typescript-project';
import {
  runtimeDeviceDirEntries,
  runtimeDeviceEntryKind,
  runtimeKernelAccessTarget,
  createRuntimeKernelReadonlyFileError,
  runtimeKernelCopyErrorCode,
  runtimeKernelCopyErrorMessage,
  runtimeKernelCopyTarget,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceInputSource,
  runtimeKernelDeviceOutputRoute,
  runtimeKernelDeviceOutputTarget,
  runtimeKernelDirectoryErrorCode,
  runtimeKernelDirectoryTarget,
  runtimeKernelFileCopyErrorMessage,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileCopyErrorCode,
  runtimeKernelFileReadFsErrorMessage,
  runtimeKernelFileReadTarget,
  runtimeKernelFileReadErrorCode,
  runtimeKernelLinkErrorCode,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirErrorCode,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataErrorCode,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationErrorCode,
  runtimeKernelMutationFsErrorMessage,
  runtimeKernelMutationTarget,
  runtimeKernelOpenErrorCode,
  runtimeKernelOpenErrorMessage,
  runtimeKernelOpenTarget,
  runtimeKernelReadTarget,
  runtimeKernelRenameErrorCode,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveErrorCode,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkErrorCode,
  runtimeKernelSymlinkTarget,
  runtimeKernelTruncateErrorCode,
  runtimeKernelTruncateTarget,
  runtimeKernelWriteErrorCode,
  runtimeKernelWriteFsErrorMessage,
  runtimeKernelWriteTarget,
  readPublicRuntimeProcFile as readPublicProcFile,
  runtimeProcDirEntries as procDirEntries,
  type RuntimeKernelDirectoryEntry,
  type RuntimeKernelVirtualStat,
} from '../../harness-core/src/runtime-kernel';
import * as fflateModule from 'fflate/browser';
import packageJson from '../package.json' with { type: 'json' };

export type JavaScriptProjectFileEncoding = RuntimeFileEncoding;
export type JavaScriptProjectFile = RuntimeFile;
export type JavaScriptProjectSnapshot = RuntimeProjectSnapshot;
export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;
export type JavaScriptProjectCommandResult = RuntimeCommandResult;
export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;
export type BrowserJavaScriptProjectCommandRunner = JavaScriptProjectCommandRunner;
export type BrowserJavaScriptProjectWorkerIsolation = 'shared' | 'per-command';

export interface BrowserJavaScriptProjectRunnerOptions {
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<boolean | void>;
  allowDynamicEval?: boolean;
  allowMainThreadExecution?: boolean;
  hardened?: boolean;
  trustedMainThreadExecution?: boolean;
  trustedReusableWorker?: boolean;
  timeoutMs?: number;
  workerIsolation?: BrowserJavaScriptProjectWorkerIsolation;
  workerUrl?: string;
}

export interface BrowserTypeScriptProjectRunnerOptions {
  allowDomCompilerScript?: boolean;
  allowExternalDomCompilerScript?: boolean;
  compiler?: TypeScriptProjectCompiler;
  compilerUrl?: string;
}

const browserTypeScriptCompilerPromises = new Map<string, Promise<TypeScriptProjectCompiler>>();
const DEFAULT_BROWSER_TYPESCRIPT_COMPILER_URL = 'workers/vendor/typescript.js';
const DOM_TYPESCRIPT_COMPILER_SCRIPT_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

function resolveBrowserTypeScriptCompilerScriptUrl(
  compilerUrl: string,
  options: Pick<BrowserTypeScriptProjectRunnerOptions, 'allowExternalDomCompilerScript'>
): string {
  const documentBase = document.baseURI || globalThis.location?.href;
  if (!documentBase) {
    throw new Error('TypeScript compiler DOM script loading requires a document base URL.');
  }

  let pageUrl: URL;
  let scriptUrl: URL;
  try {
    pageUrl = new URL(documentBase);
    scriptUrl = new URL(compilerUrl, pageUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TypeScript compiler script URL: ${message}`);
  }

  if (!DOM_TYPESCRIPT_COMPILER_SCRIPT_PROTOCOLS.has(scriptUrl.protocol)) {
    throw new Error(`TypeScript compiler DOM script URL must use http, https, or file: ${scriptUrl.protocol}`);
  }
  const sameDocumentScriptScope = pageUrl.protocol === 'file:' || scriptUrl.protocol === 'file:'
    ? pageUrl.protocol === scriptUrl.protocol && scriptUrl.href.startsWith(new URL('.', pageUrl).href)
    : scriptUrl.origin === pageUrl.origin;
  if (!sameDocumentScriptScope && options.allowExternalDomCompilerScript !== true) {
    throw new Error('External TypeScript compiler DOM script URLs require allowExternalDomCompilerScript.');
  }
  return scriptUrl.href;
}

async function loadBrowserTypeScriptCompiler(
  compilerUrl = DEFAULT_BROWSER_TYPESCRIPT_COMPILER_URL,
  options: Pick<BrowserTypeScriptProjectRunnerOptions, 'allowDomCompilerScript' | 'allowExternalDomCompilerScript'> = {}
): Promise<TypeScriptProjectCompiler> {
  const globalRecord = globalThis as typeof globalThis & { ts?: TypeScriptProjectCompiler };
  if (globalRecord.ts) return globalRecord.ts;
  if (typeof document === 'undefined') {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<TypeScriptProjectCompiler>;
    return dynamicImport('typescript');
  }
  if (options.allowDomCompilerScript !== true) {
    throw new Error('TypeScript project compile in the browser requires a trusted compiler object or a worker-backed compiler.');
  }
  const trustedCompilerUrl = resolveBrowserTypeScriptCompilerScriptUrl(compilerUrl, options);
  let compilerPromise = browserTypeScriptCompilerPromises.get(trustedCompilerUrl);
  if (!compilerPromise) {
    compilerPromise = new Promise<TypeScriptProjectCompiler>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = trustedCompilerUrl;
      script.async = true;
      script.onload = () => {
        if (globalRecord.ts) {
          resolve(globalRecord.ts);
        } else {
          reject(new Error(`TypeScript compiler did not initialize from ${trustedCompilerUrl}`));
        }
      };
      script.onerror = () => {
        reject(new Error(`Failed to load TypeScript compiler from ${trustedCompilerUrl}`));
      };
      document.head.appendChild(script);
    });
    browserTypeScriptCompilerPromises.set(trustedCompilerUrl, compilerPromise);
  }
  return compilerPromise;
}

export function createBrowserTypeScriptProjectRunner(
  options: BrowserTypeScriptProjectRunnerOptions = {}
) {
  return createTypeScriptProjectRunner({
    ...(options.compiler ? { compiler: options.compiler } : {}),
    loadCompiler: () => loadBrowserTypeScriptCompiler(options.compilerUrl, {
      allowDomCompilerScript: options.allowDomCompilerScript,
      allowExternalDomCompilerScript: options.allowExternalDomCompilerScript,
    }),
  });
}

interface BrowserJavaScriptProjectExecutionState {
  cancelled: boolean;
}

type ModuleRecord = {
  exports: unknown;
  id?: string;
  filename?: string;
  loaded?: boolean;
  parent?: ModuleRecord | null;
  children?: ModuleRecord[];
  path?: string;
  paths?: string[];
  require?: ((specifier: string) => unknown) & {
    cache: Record<string, ModuleRecord>;
    main?: ModuleRecord;
    resolve: (specifier: string) => string;
  };
};

interface BrowserProcSnapshot {
  readonly files: ReadonlyMap<string, string>;
  readonly directories: ReadonlyMap<string, readonly RuntimeKernelDirectoryEntry[]>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const AsyncFunction = Object.getPrototypeOf(async function noop() {
  // Intentionally empty.
}).constructor as typeof Function;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const streamInternalCloseListeners = Symbol('tracecode.streamInternalCloseListeners');

type InternalCloseAwareStream = {
  [streamInternalCloseListeners]?: Set<() => void>;
};

function moduleDefault(value: unknown): unknown {
  return (value as Record<string, unknown>).default;
}

const fflateRecord = fflateModule as unknown as Record<string, unknown>;
const fflate = (
  typeof fflateRecord.gzipSync === 'function'
    ? fflateModule
    : moduleDefault(fflateModule)
) as typeof fflateModule;

interface PackageMetadata {
  type?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

type PackageResolutionCondition = 'require' | 'import';

interface WorkspacePathContext {
  root: string;
  alias?: string;
}

function normalizeProjectPath(path: string): string {
  const cleaned = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/workspace\//, '');
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function workspacePathInputToString(path: unknown): string {
  if (path instanceof URL) {
    if (path.protocol !== 'file:') {
      throw new TypeError('The URL must be of scheme file');
    }
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}

function runtimeWriteTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelWriteTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelWriteTarget(raw, devices);
}

function runtimeMutationTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMutationTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMutationTarget(raw, devices);
}

function runtimeMetadataTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMetadataTarget> | null {
  if (typeof path === 'number') return null;
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'proc-read-only', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMetadataTarget(raw, devices);
}

function runtimeAccessTarget(
  path: unknown,
  mode: number,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelAccessTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return (mode & 2) !== 0
      ? { kind: 'denied', reason: 'permission-denied', path: procPath }
      : { kind: 'allowed', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return (mode & 2) !== 0
      ? { kind: 'denied', reason: 'permission-denied', path: readonlyPath }
      : { kind: 'denied', reason: 'not-found', path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelAccessTarget(raw, {
    read: (mode & 4) !== 0,
    write: (mode & 2) !== 0,
    execute: (mode & 1) !== 0,
  }, devices);
}

function runtimeOpenTarget(
  path: unknown,
  request: Parameters<typeof runtimeKernelOpenTarget>[1],
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelOpenTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    if (procKind === 'directory') return { kind: 'error', reason: 'is-directory', path: procPath };
    if (request?.writable || request?.create || request?.truncate || request?.exclusive) {
      return { kind: 'error', reason: 'read-only', path: procPath };
    }
    return { kind: 'proc-file', path: procPath, readable: true, writable: false };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) {
    return request?.writable || request?.create || request?.truncate || request?.exclusive
      ? { kind: 'error', reason: 'read-only', path: readonlyPath }
      : { kind: 'error', reason: 'not-found', path: readonlyPath };
  }
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelOpenTarget(raw, request, devices);
}

function runtimeReadTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelReadTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'file'
      ? { kind: 'proc-file', path: procPath }
      : { kind: 'proc-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelReadTarget(raw, devices);
}

function runtimeFileReadTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelFileReadTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'file'
      ? { kind: 'proc-file', path: procPath }
      : { kind: 'error', reason: 'is-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelFileReadTarget(raw, devices);
}

function runtimeCopyTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelCopyTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (sourceKind === 'file' || destinationReadonlyPath) return { kind: 'file-copy' };
  if (sourceKind === 'directory') return { kind: 'error', reason: 'source-directory', path: normalizeBrowserProcPath(source) ?? String(source) };
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelCopyTarget(sourceRaw, destinationRaw, devices);
}

function runtimeFileCopyTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelFileCopyTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const destinationReadonlyPath = browserReadonlyKernelNamespacePath(destination);
  if (destinationReadonlyPath) {
    return { kind: 'error', side: 'destination', reason: 'proc-read-only', path: destinationReadonlyPath };
  }
  const sourceKind = browserProcEntryKind(procSnapshot, source);
  if (sourceKind) {
    const sourcePath = normalizeBrowserProcPath(source) ?? String(source);
    if (sourceKind === 'directory') {
      return { kind: 'error', side: 'source', reason: 'is-directory', path: sourcePath };
    }
    const writeTarget = runtimeWriteTarget(destination, devices);
    if (writeTarget?.kind === 'error') {
      return { kind: 'error', side: 'destination', reason: writeTarget.reason, path: writeTarget.path };
    }
    if (writeTarget?.kind === 'device') {
      return {
        kind: 'device-destination',
        device: writeTarget.device,
        outputDevice: writeTarget.outputDevice,
        source: { kind: 'proc-file', path: sourcePath },
      };
    }
    return { kind: 'virtual-source', source: { kind: 'proc-file', path: sourcePath } };
  }
  const sourceReadonlyPath = browserReadonlyKernelNamespacePath(source);
  if (sourceReadonlyPath) {
    return { kind: 'error', side: 'source', reason: 'not-found', path: sourceReadonlyPath };
  }
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelFileCopyTarget(sourceRaw, destinationRaw, devices);
}

function runtimeLinkTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelLinkTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelLinkTarget(sourceRaw, destinationRaw, devices);
}

function runtimeRenameTarget(
  source: unknown,
  destination: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelRenameTarget> | null {
  if (typeof source === 'number' || typeof destination === 'number') return null;
  const sourceRaw = workspacePathInputToString(source).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const destinationRaw = workspacePathInputToString(destination).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelRenameTarget(sourceRaw, destinationRaw, devices);
}

function runtimeSymlinkTarget(
  linkPath: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelSymlinkTarget> | null {
  if (typeof linkPath === 'number') return null;
  const raw = workspacePathInputToString(linkPath).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelSymlinkTarget(raw, devices);
}

function runtimeRemoveTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelRemoveTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelRemoveTarget(raw, devices);
}

function runtimeMkdirTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelMkdirTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelMkdirTarget(raw, devices);
}

function runtimeTruncateTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[]
): ReturnType<typeof runtimeKernelTruncateTarget> | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelTruncateTarget(raw, devices);
}

function runtimeDirectoryTarget(
  path: unknown,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelDirectoryTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    return procKind === 'directory'
      ? { kind: 'directory', path: procPath, entries: [...(procSnapshot?.directories.get(procPath) ?? [])] }
      : { kind: 'error', reason: 'not-directory', path: procPath };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelDirectoryTarget(raw, devices);
}

function runtimeStatTarget(
  path: unknown,
  info: RuntimeKernelInfo,
  devices?: readonly RuntimeKernelDeviceInfo[],
  procSnapshot?: BrowserProcSnapshot
): ReturnType<typeof runtimeKernelStatTarget> | null {
  if (typeof path === 'number') return null;
  const procKind = browserProcEntryKind(procSnapshot, path);
  if (procKind) {
    const procPath = normalizeBrowserProcPath(path) ?? '/proc';
    const contents = procKind === 'file' ? browserProcFileContents(procSnapshot, procPath, info) : '';
    return {
      kind: 'stat',
      path: procPath,
      stat: {
        isFile: procKind === 'file',
        isDirectory: procKind === 'directory',
        isCharacterDevice: false,
        mode: procKind === 'directory' ? 0o555 : 0o444,
        size: textEncoder.encode(contents).byteLength,
      },
    };
  }
  const readonlyPath = browserReadonlyKernelNamespacePath(path);
  if (readonlyPath) return { kind: 'error', reason: 'not-found', path: readonlyPath };
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return runtimeKernelStatTarget(raw, info, devices);
}

function throwRuntimeWriteTargetError(
  target: Extract<ReturnType<typeof runtimeKernelWriteTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelWriteErrorCode(target.reason) });
}

function throwRuntimeMutationTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMutationTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMutationErrorCode(target.reason) });
}

function throwRuntimeMetadataTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMetadataTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMetadataErrorCode(target.reason) });
}

function throwRuntimeReadTargetError(
  target: Extract<ReturnType<typeof runtimeKernelFileReadTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelFileReadErrorCode(target.reason) });
}

function throwRuntimeLinkTargetError(
  target: Extract<ReturnType<typeof runtimeKernelLinkTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelLinkErrorCode(target.reason) });
}

function throwRuntimeRenameTargetError(
  target: Extract<ReturnType<typeof runtimeKernelRenameTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelRenameErrorCode(target.reason) });
}

function throwRuntimeSymlinkTargetError(
  target: Extract<ReturnType<typeof runtimeKernelSymlinkTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelSymlinkErrorCode(target.reason) });
}

function throwRuntimeRemoveTargetError(
  target: Extract<ReturnType<typeof runtimeKernelRemoveTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelRemoveErrorCode(target.reason) });
}

function throwRuntimeMkdirTargetError(
  target: Extract<ReturnType<typeof runtimeKernelMkdirTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelMkdirErrorCode(target.reason) });
}

function throwRuntimeTruncateTargetError(
  target: Extract<ReturnType<typeof runtimeKernelTruncateTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelTruncateErrorCode(target.reason) });
}

function throwRuntimeDirectoryTargetError(
  target: Extract<ReturnType<typeof runtimeKernelDirectoryTarget>, { kind: 'error' }>,
  message: string
): never {
  throw Object.assign(new Error(message), { code: runtimeKernelDirectoryErrorCode(target.reason) });
}

function normalizeAbsoluteWorkspaceRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`;
}

function createWorkspacePathContext(project: RuntimeProjectSnapshot): WorkspacePathContext {
  return {
    root: normalizeAbsoluteWorkspaceRoot(project.workspaceRoot ?? project.cwd ?? '/workspace'),
    ...(project.workspaceAlias ? { alias: normalizeAbsoluteWorkspaceRoot(project.workspaceAlias) } : {}),
  };
}

function fallbackKernelInfo(project: RuntimeProjectSnapshot, workspace: WorkspacePathContext): RuntimeKernelInfo {
  const root = workspace.root;
  const parts = root.split('/').filter(Boolean);
  const workspaceName = parts.at(-1) ?? 'workspace';
  const username = parts.length >= 2 && parts[0] === 'home' ? parts[1] ?? 'user' : 'user';
  const home = parts.length >= 2 && parts[0] === 'home' ? `/${parts.slice(0, 2).join('/')}` : dirname(root) || root;
  const startedAt = new Date(0).toISOString();
  return {
    name: 'tracekernel',
    version: packageJson.version,
    user: {
      id: username,
      username,
      home,
    },
    host: {
      hostname: 'tracevm',
      osName: 'tracecode',
    },
    workspace: {
      id: `${workspaceName}-${startedAt.replace(/[:.]/g, '-')}`,
      name: workspaceName,
      root,
      startedAt,
    },
    home,
    cwd: project.cwd ?? root,
    workspaceRoot: root,
    ...(workspace.alias ? { workspaceAlias: workspace.alias } : {}),
  };
}

function normalizeBrowserProcPath(path: unknown): string | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return raw === '/proc' || raw.startsWith('/proc/') || raw === '/skills' || raw.startsWith('/skills/')
    ? raw
    : null;
}

function browserReadonlyKernelNamespacePath(path: unknown): string | null {
  if (typeof path === 'number') return null;
  const raw = workspacePathInputToString(path).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return raw === '/skills' || raw.startsWith('/skills/') ? raw : null;
}

function createBrowserProcSnapshot(kernelFiles?: readonly RuntimeFile[]): BrowserProcSnapshot {
  const files = new Map<string, string>();
  const directoryEntries = new Map<string, Map<string, RuntimeKernelDirectoryEntry>>();
  const ensureDirectory = (path: string): void => {
    if (!directoryEntries.has(path)) directoryEntries.set(path, new Map());
    if (path === '/') return;
    const parent = dirname(path);
    if (parent && parent !== path) {
      ensureDirectory(parent);
      const name = path.slice(parent === '/' ? 1 : parent.length + 1);
      directoryEntries.get(parent)?.set(name, { name, kind: 'directory' });
    }
  };
  const addFile = (path: string, contents: string): void => {
    const normalized = normalizeBrowserProcPath(path);
    if (!normalized) return;
    files.set(normalized, contents);
    const parent = dirname(normalized);
    ensureDirectory(parent);
    const name = normalized.slice(parent === '/' ? 1 : parent.length + 1);
    directoryEntries.get(parent)?.set(name, { name, kind: 'file' });
  };
  ensureDirectory('/skills');
  for (const file of kernelFiles ?? []) addFile(file.path, file.contents);
  const directories = new Map<string, readonly RuntimeKernelDirectoryEntry[]>();
  for (const [path, entries] of directoryEntries) {
    if (path === '/' || !(
      path === '/proc' ||
      path.startsWith('/proc/') ||
      path === '/skills' ||
      path.startsWith('/skills/')
    )) continue;
    directories.set(path, [...entries.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }
  return { files, directories };
}

function browserProcEntryKind(snapshot: BrowserProcSnapshot | undefined, path: unknown): 'file' | 'directory' | null {
  const normalized = normalizeBrowserProcPath(path);
  if (!normalized || !snapshot) return null;
  if (snapshot.files.has(normalized)) return 'file';
  if (snapshot.directories.has(normalized)) return 'directory';
  return null;
}

function browserProcFileContents(snapshot: BrowserProcSnapshot | undefined, path: string, info: RuntimeKernelInfo): string {
  const contents = snapshot?.files.get(path);
  return contents !== undefined ? contents : readPublicProcFile(path, info);
}

function workspaceRelativeFromAbsolutePath(rawPath: string, workspace: WorkspacePathContext): string | null {
  const raw = normalizeAbsoluteWorkspaceRoot(rawPath);
  if (raw === workspace.root) return '';
  if (raw.startsWith(`${workspace.root}/`)) return raw.slice(workspace.root.length + 1);
  if (workspace.alias && raw === workspace.alias) return '';
  if (workspace.alias && raw.startsWith(`${workspace.alias}/`)) return raw.slice(workspace.alias.length + 1);
  return null;
}

function normalizeWorkspaceEntryPath(
  path: unknown,
  basePath = '',
  allowRoot = false,
  workspace: WorkspacePathContext = { root: '/workspace' }
): string {
  const rawInput = workspacePathInputToString(path);
  const raw = rawInput.replace(/\\/g, '/');
  const workspaceRelative = raw.startsWith('/') ? workspaceRelativeFromAbsolutePath(raw, workspace) : null;
  const withBase = workspaceRelative !== null
    ? workspaceRelative
    : raw.startsWith('/')
      ? raw
      : basePath
        ? `${basePath}/${raw}`
        : raw;
  const cleaned = withBase
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (cleaned.startsWith('/') || /^[A-Za-z]:\//.test(cleaned)) {
    throw new Error(`Path must be inside workspace: ${rawInput}`);
  }

  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Path must not escape workspace: ${rawInput}`);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) {
    if (allowRoot) return '';
    throw new Error(`Path must point to a file: ${rawInput}`);
  }
  return parts.join('/');
}

function assertSafeWorkspaceFilePath(
  path: unknown,
  basePath = '',
  workspace: WorkspacePathContext = { root: '/workspace' }
): string {
  return normalizeWorkspaceEntryPath(path, basePath, false, workspace);
}

function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64');
  }

  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function fileBytes(file: JavaScriptProjectFile): Uint8Array {
  return file.encoding === 'base64' ? base64ToBytes(file.contents) : utf8Bytes(file.contents);
}

function byteEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesToRuntimeFile(path: string, contents: Uint8Array): JavaScriptProjectFile {
  const text = textDecoder.decode(contents);
  if (byteEqual(utf8Bytes(text), contents)) {
    return { path, contents: text };
  }
  return { path, contents: bytesToBase64(contents), encoding: 'base64' };
}

function bytesFromNodeValue(value: unknown): Uint8Array {
  if (typeof value === 'string') return utf8Bytes(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((item) => Number(item) & 0xff));
  return utf8Bytes(String(value));
}

function requestedEncodingFromOptions(options?: string | { encoding?: string | null } | null): string | undefined {
  if (typeof options === 'string') return options;
  return typeof options?.encoding === 'string' ? options.encoding : undefined;
}

function bytesFromFsWriteValue(value: unknown, options?: string | { encoding?: string | null } | null): Uint8Array {
  const encoding = requestedEncodingFromOptions(options);
  if (typeof value === 'string' && typeof encoding === 'string') {
    return BrowserBuffer.from(value, encoding);
  }
  return bytesFromNodeValue(value);
}

function browserBufferFromBytes(value: Uint8Array): BrowserBuffer {
  return BrowserBuffer.from(value);
}

function textFromBytes(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function bytesToRuntimeHttpBody(bytes: Uint8Array): { body: string; bodyEncoding?: RuntimeFileEncoding } {
  const text = textDecoder.decode(bytes);
  return byteEqual(utf8Bytes(text), bytes)
    ? { body: text }
    : { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
}

function bytesFromRuntimeHttpBody(message: { body?: string; bodyEncoding?: RuntimeFileEncoding }): Uint8Array {
  if (message.body === undefined) return new Uint8Array();
  return message.bodyEncoding === 'base64' ? base64ToBytes(message.body) : utf8Bytes(message.body);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  const bytes = new Uint8Array(Math.ceil(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2).padEnd(2, '0'), 16) & 0xff;
  }
  return bytes;
}

class BrowserBuffer extends Uint8Array {
  static from(arrayLike: ArrayLike<number>): BrowserBuffer;
  static from<T>(arrayLike: ArrayLike<T>, mapfn: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(elements: Iterable<number>): BrowserBuffer;
  static from<T>(elements: Iterable<T>, mapfn?: (value: T, index: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(value: string, encoding?: string): BrowserBuffer;
  static from(value: unknown, encodingOrMapfn?: string | ((value: unknown, index: number) => number), thisArg?: unknown): BrowserBuffer {
    if (typeof value === 'string') {
      const encoding = typeof encodingOrMapfn === 'string' ? encodingOrMapfn : undefined;
      if (encoding === 'base64') return new BrowserBuffer(base64ToBytes(value));
      if (encoding === 'hex') return new BrowserBuffer(hexToBytes(value));
      if (encoding === 'latin1' || encoding === 'binary') {
        return new BrowserBuffer(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
      }
      return new BrowserBuffer(utf8Bytes(value));
    }
    if (typeof encodingOrMapfn === 'function' && value != null) {
      return new BrowserBuffer(Array.from(value as Iterable<unknown>, encodingOrMapfn, thisArg));
    }
    return new BrowserBuffer(bytesFromNodeValue(value));
  }

  static alloc(size: number, fill = 0): BrowserBuffer {
    const bytes = new BrowserBuffer(Math.max(0, Number(size) || 0));
    bytes.fill(Number(fill) & 0xff);
    return bytes;
  }

  static isBuffer(value: unknown): value is BrowserBuffer {
    return value instanceof BrowserBuffer;
  }

  static concat(values: readonly Uint8Array[]): BrowserBuffer {
    const totalLength = values.reduce((sum, value) => sum + value.byteLength, 0);
    const bytes = new BrowserBuffer(totalLength);
    let offset = 0;
    for (const value of values) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes;
  }

  static byteLength(value: unknown, encoding?: string): number {
    if (typeof value === 'string') return BrowserBuffer.from(value, encoding).byteLength;
    return bytesFromNodeValue(value).byteLength;
  }

  toString(encoding = 'utf8'): string {
    if (encoding === 'base64') return bytesToBase64(this);
    if (encoding === 'hex') return bytesToHex(this);
    if (encoding === 'latin1' || encoding === 'binary') {
      return Array.from(this, (byte) => String.fromCharCode(byte)).join('');
    }
    return textFromBytes(this);
  }
}

function createZlibApi() {
  return {
    gzipSync: (input: unknown) => browserBufferFromBytes(fflate.gzipSync(bytesFromNodeValue(input))),
    gunzipSync: (input: unknown) => browserBufferFromBytes(fflate.gunzipSync(bytesFromNodeValue(input))),
    deflateSync: (input: unknown) => browserBufferFromBytes(fflate.deflateSync(bytesFromNodeValue(input))),
    inflateSync: (input: unknown) => browserBufferFromBytes(fflate.inflateSync(bytesFromNodeValue(input))),
  };
}

function createReadableStdinDevice(
  readBytes: (size?: number) => Uint8Array,
  remainingBytes: () => number,
  isClosed: () => boolean = () => true,
  schedulePoll: (callback: () => void, delay: number) => unknown = (callback, delay) => setTimeout(callback, delay)
) {
  let encoding: string | undefined;
  let flowScheduled = false;
  let pollScheduled = false;
  let destroyed = false;
  let ended = false;
  let readableFlowing: boolean | null = null;
  const dataListeners: Array<(chunk?: BrowserBuffer | string) => void> = [];
  const endListeners: Array<(chunk?: BrowserBuffer | string) => void> = [];

  const formatChunk = (chunk: BrowserBuffer): BrowserBuffer | string => (
    encoding ? chunk.toString(encoding) : chunk
  );
  const read = (size?: number): BrowserBuffer | string | null => {
    if (remainingBytes() <= 0) {
      ended = isClosed();
      return null;
    }
    const requested = typeof size === 'number' && size >= 0 ? Math.floor(size) : undefined;
    const chunk = BrowserBuffer.from(readBytes(requested));
    if (remainingBytes() <= 0) ended = true;
    return formatChunk(chunk);
  };
  const scheduleFlow = (): void => {
    if (flowScheduled) return;
    if (readableFlowing === false) return;
    flowScheduled = true;
    queueMicrotask(() => {
      if (destroyed) return;
      const chunk = read();
      if (chunk !== null) {
        for (const listener of dataListeners) listener(chunk);
        if (ended) {
          for (const listener of endListeners) listener();
        } else {
          flowScheduled = false;
          scheduleFlow();
        }
        return;
      }
      if (!isClosed()) {
        flowScheduled = false;
        if (!pollScheduled) {
          pollScheduled = true;
          schedulePoll(() => {
            pollScheduled = false;
            scheduleFlow();
          }, 8);
        }
        return;
      }
      ended = true;
      for (const listener of endListeners) listener();
    });
  };
  const on = (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
    if (event === 'data') {
      dataListeners.push(listener);
      if (readableFlowing === null) readableFlowing = true;
      scheduleFlow();
    } else if (event === 'end') {
      endListeners.push(listener);
      scheduleFlow();
    }
    return stream;
  };
  const removeListener = (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
    const listeners = event === 'data' ? dataListeners : event === 'end' ? endListeners : null;
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    }
    return stream;
  };
  const stream = {
    fd: 0,
    readable: true,
    isTTY: false,
    get readableEnded() {
      return ended;
    },
    get readableEncoding() {
      return encoding ?? null;
    },
    get readableFlowing() {
      return readableFlowing;
    },
    get readableLength() {
      return Math.max(0, remainingBytes());
    },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return stream;
    },
    read,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event: string, listener: (chunk?: BrowserBuffer | string) => void) => {
      const wrapped = (chunk?: BrowserBuffer | string) => {
        removeListener(event, wrapped);
        listener(chunk);
      };
      return stream.on(event, wrapped);
    },
    destroy: () => {
      destroyed = true;
      return stream;
    },
    get destroyed() {
      return destroyed;
    },
    resume: () => {
      readableFlowing = true;
      scheduleFlow();
      return stream;
    },
    pause: () => {
      readableFlowing = false;
      return stream;
    },
    [Symbol.asyncIterator]: async function* () {
      const chunk = read();
      if (chunk !== null) yield chunk;
    },
  };
  return stream;
}

function createPathApi(getCwd: () => string, workspaceRoot: string) {
  const normalizePath = (value: string): string => {
    const raw = String(value).replace(/\\/g, '/');
    const isAbsolute = raw.startsWith('/');
    const parts: string[] = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        const previous = parts[parts.length - 1];
        if (previous && previous !== '..') {
          parts.pop();
        } else if (!isAbsolute) {
          parts.push('..');
        }
      } else {
        parts.push(part);
      }
    }
    const normalized = parts.join('/');
    if (isAbsolute) return normalized ? `/${normalized}` : '/';
    return normalized || '.';
  };
  const cwdAbsolutePath = (): string => {
    const cwd = getCwd();
    return cwd ? `${workspaceRoot}/${cwd}` : workspaceRoot;
  };
  const isAbsolute = (path: string): boolean => String(path).startsWith('/');
  const normalize = (path: string): string => normalizePath(path);
  const join = (...parts: string[]): string => normalizePath(parts.filter((part) => String(part).length > 0).join('/'));
  const resolve = (...parts: string[]): string => {
    const rawParts = parts.map((part) => String(part)).filter((part) => part.length > 0);
    let resolved = '';
    for (let index = rawParts.length - 1; index >= 0; index -= 1) {
      resolved = resolved ? `${rawParts[index]}/${resolved}` : rawParts[index] ?? '';
      if (resolved.startsWith('/')) return normalizePath(resolved);
    }
    return normalizePath(`${cwdAbsolutePath()}/${resolved}`);
  };
  const dirnameApi = (path: string): string => {
    const normalized = normalizePath(path);
    if (normalized === '/') return '/';
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');
    const index = withoutTrailingSlash.lastIndexOf('/');
    if (index === -1) return '.';
    if (index === 0) return '/';
    return withoutTrailingSlash.slice(0, index);
  };
  const basename = (path: string, suffix?: string): string => {
    const normalized = normalizePath(path).replace(/\/+$/, '');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  };
  const extname = (path: string): string => {
    const base = basename(path);
    const index = base.lastIndexOf('.');
    if (index <= 0) return '';
    return base.slice(index);
  };
  const relative = (from: string, to: string): string => {
    const fromParts = resolve(from).split('/').filter(Boolean);
    const toParts = resolve(to).split('/').filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common += 1;
    }
    return [
      ...fromParts.slice(common).map(() => '..'),
      ...toParts.slice(common),
    ].join('/') || '';
  };
  const parse = (path: string) => {
    const normalized = normalizePath(path);
    const root = normalized.startsWith('/') ? '/' : '';
    const dir = dirnameApi(normalized);
    const base = basename(normalized);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    return {
      root,
      dir: dir === '.' ? '' : dir,
      base,
      ext,
      name,
    };
  };
  const format = (pathObject: { root?: string; dir?: string; base?: string; name?: string; ext?: string }) => {
    const dir = pathObject.dir || pathObject.root || '';
    const base = pathObject.base ?? `${pathObject.name ?? ''}${pathObject.ext ?? ''}`;
    if (!dir) return base;
    if (dir === '/') return `/${base}`;
    return `${dir}/${base}`;
  };
  const api = {
    sep: '/',
    delimiter: ':',
    normalize,
    join,
    resolve,
    dirname: dirnameApi,
    basename,
    extname,
    isAbsolute,
    relative,
    parse,
    format,
  };
  return { ...api, posix: api };
}

function inferWorkspaceHome(workspaceRoot: string): string {
  const parts = workspaceRoot.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'home') {
    return `/${parts.slice(0, 2).join('/')}`;
  }
  const parent = dirname(workspaceRoot);
  return parent || workspaceRoot;
}

function workspaceUsername(workspaceHome: string): string {
  const parts = workspaceHome.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'browser';
}

function createOsApi(workspaceRoot: string) {
  const home = inferWorkspaceHome(workspaceRoot);
  return {
    EOL: '\n',
    arch: () => 'wasm32',
    cpus: () => [],
    endianness: () => 'LE',
    homedir: () => home,
    hostname: () => 'tracevm',
    platform: () => 'browser',
    release: () => '',
    tmpdir: () => '/tmp',
    type: () => 'tracekernel',
    userInfo: () => ({
      username: workspaceUsername(home),
      uid: -1,
      gid: -1,
      shell: null,
      homedir: home,
    }),
  };
}

function createBrowserEventLoopApi(executionState: BrowserJavaScriptProjectExecutionState) {
  type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
  type TimerCallback = (...args: unknown[]) => unknown;
  type TimerEntry = {
    handle: TimerHandle;
    interval: boolean;
  };

  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const hostQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  let nextTimerId = 1;
  let pendingTimerWork: Promise<void> = Promise.resolve();
  let timerError: unknown;
  const timers = new Map<number, TimerEntry>();

  const recordTimerWork = (work: Promise<void>): void => {
    pendingTimerWork = Promise.allSettled([pendingTimerWork, work]).then(() => undefined);
  };
  const runTimerCallback = (callback: TimerCallback, args: unknown[]): void => {
    const work = Promise.resolve()
      .then(() => callback(...args))
      .then(
        () => undefined,
        (error) => {
          timerError ??= error;
        }
      );
    recordTimerWork(work);
  };
  const setTrackedTimeout = (callback: TimerCallback, delay?: number, ...args: unknown[]): number => {
    const id = nextTimerId++;
    const handle = hostSetTimeout(() => {
      timers.delete(id);
      if (executionState.cancelled) return;
      runTimerCallback(callback, args);
    }, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: false });
    return id;
  };
  const clearTrackedTimeout = (id: unknown): void => {
    if (typeof id !== 'number') return;
    const timer = timers.get(id);
    if (!timer) return;
    hostClearTimeout(timer.handle);
    timers.delete(id);
  };
  const setTrackedInterval = (callback: TimerCallback, delay?: number, ...args: unknown[]): number => {
    const id = nextTimerId++;
    const run = (): void => {
      if (!timers.has(id) || executionState.cancelled) return;
      runTimerCallback(callback, args);
      const timer = timers.get(id);
      if (!timer) return;
      timer.handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    };
    const handle = hostSetTimeout(run, Math.max(0, Number(delay) || 0));
    timers.set(id, { handle, interval: true });
    return id;
  };
  const setTrackedImmediate = (callback: TimerCallback, ...args: unknown[]): number => setTrackedTimeout(callback, 0, ...args);
  const drain = async (): Promise<void> => {
    while (!executionState.cancelled && timers.size > 0) {
      await new Promise((resolve) => hostSetTimeout(resolve, 0));
      await pendingTimerWork;
      if (timerError !== undefined) throw timerError;
      if ([...timers.values()].some((timer) => timer.interval)) {
        await new Promise((resolve) => hostSetTimeout(resolve, 0));
      }
    }
    await pendingTimerWork;
    if (timerError !== undefined) throw timerError;
  };
  const clearAll = (): void => {
    for (const timer of timers.values()) {
      hostClearTimeout(timer.handle);
    }
    timers.clear();
  };

  return {
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: setTrackedInterval,
    clearInterval: clearTrackedTimeout,
    setImmediate: setTrackedImmediate,
    clearImmediate: clearTrackedTimeout,
    queueMicrotask: hostQueueMicrotask,
    drain,
    clearAll,
  };
}

class BrowserAssertionError extends Error {
  readonly code = 'ERR_ASSERTION';
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;

  constructor(options: { actual?: unknown; expected?: unknown; message?: string; operator?: string } = {}) {
    const operator = options.operator ?? 'fail';
    const generatedMessage = options.message === undefined;
    super(options.message ?? `Assertion failed: ${operator}`);
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = operator;
    this.generatedMessage = generatedMessage;
  }
}

function browserDeepStrictEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const seenRight = seen.get(left);
  if (seenRight) return seenRight === right;
  seen.set(left, right);

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return byteEqual(leftBytes, rightBytes);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => browserDeepStrictEqual(value, right[index], seen));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      if (!right.has(key) || !browserDeepStrictEqual(value, right.get(key), seen)) return false;
    }
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    return [...left].every((value) => right.has(value));
  }

  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.propertyIsEnumerable.call(right, key) &&
    browserDeepStrictEqual((left as Record<PropertyKey, unknown>)[key], (right as Record<PropertyKey, unknown>)[key], seen)
  ));
}

function createAssertApi() {
  const fail = (message?: string): never => {
    throw new BrowserAssertionError({ message, operator: 'fail' });
  };
  const assert = ((value: unknown, message?: string): asserts value => {
    if (!value) throw new BrowserAssertionError({ actual: value, expected: true, message, operator: '==' });
  }) as ((value: unknown, message?: string) => void) & Record<string, unknown>;
  const strictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (!Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'strictEqual' });
  };
  const notStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'notStrictEqual' });
  };
  const deepStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (!browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'deepStrictEqual' });
  };
  const notDeepStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'notDeepStrictEqual' });
  };
  const match = (actual: unknown, expected: RegExp, message?: string): void => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (!expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: 'match' });
  };
  const doesNotMatch = (actual: unknown, expected: RegExp, message?: string): void => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: 'doesNotMatch' });
  };
  const throws = (fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean), message?: string): unknown => {
    try {
      fn();
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'throws' });
      }
      if (typeof expected === 'function' && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'throws' });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: undefined, expected, message, operator: 'throws' });
  };
  const rejects = async (fn: (() => Promise<unknown>) | Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean), message?: string): Promise<unknown> => {
    try {
      await (typeof fn === 'function' ? fn() : fn);
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'rejects' });
      }
      if (typeof expected === 'function' && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'rejects' });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: undefined, expected, message, operator: 'rejects' });
  };

  Object.assign(assert, {
    AssertionError: BrowserAssertionError,
    fail,
    ok: assert,
    equal: strictEqual,
    notEqual: notStrictEqual,
    strictEqual,
    notStrictEqual,
    deepEqual: deepStrictEqual,
    notDeepEqual: notDeepStrictEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    match,
    doesNotMatch,
    throws,
    rejects,
  });
  return assert;
}

class BrowserEventEmitter {
  private readonly listeners = new Map<string | symbol, Array<(...args: unknown[]) => void>>();

  on(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const entries = this.listeners.get(eventName) ?? [];
    entries.push(listener);
    this.listeners.set(eventName, entries);
    return this;
  }

  addListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.on(eventName, listener);
  }

  once(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.off(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    const entries = this.listeners.get(eventName);
    if (!entries) return this;
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
    if (entries.length === 0) this.listeners.delete(eventName);
    return this;
  }

  removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.off(eventName, listener);
  }

  emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const entries = [...(this.listeners.get(eventName) ?? [])];
    if (entries.length === 0) {
      if (eventName === 'error') throw args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? 'Unhandled error'));
      return false;
    }
    for (const listener of entries) listener(...args);
    return true;
  }

  listenerCount(eventName: string | symbol): number {
    return this.listeners.get(eventName)?.length ?? 0;
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) this.listeners.clear();
    else this.listeners.delete(eventName);
    return this;
  }
}

function createEventsApi() {
  return {
    EventEmitter: BrowserEventEmitter,
    once: (emitter: BrowserEventEmitter, eventName: string | symbol) => new Promise<unknown[]>((resolve, reject) => {
      emitter.once(eventName, (...args) => resolve(args));
      if (eventName !== 'error') emitter.once('error', reject);
    }),
  };
}

function createUtilApi() {
  const inspect = (value: unknown): string => {
    if (typeof value === 'string') return `'${value}'`;
    if (value instanceof Error) return value.stack ?? value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const promisify = (fn: (...args: unknown[]) => void) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (error: unknown, value: unknown) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
  const callbackify = (fn: (...args: unknown[]) => Promise<unknown>) => (...args: unknown[]) => {
    const callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    fn(...args).then((value) => callback(null, value), (error) => callback(error));
  };
  return {
    inspect,
    format: (...args: unknown[]) => args.map((arg) => typeof arg === 'string' ? arg : inspect(arg)).join(' '),
    promisify,
    callbackify,
    TextEncoder,
    TextDecoder,
    types: {
      isDate: (value: unknown): value is Date => value instanceof Date,
      isMap: (value: unknown): value is Map<unknown, unknown> => value instanceof Map,
      isSet: (value: unknown): value is Set<unknown> => value instanceof Set,
      isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
      isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
    },
  };
}

function createTimersPromisesApi(eventLoopApi: ReturnType<typeof createBrowserEventLoopApi>) {
  return {
    setTimeout: (delay?: number, value?: unknown) => new Promise((resolve) => {
      eventLoopApi.setTimeout(() => resolve(value), delay);
    }),
    setImmediate: (value?: unknown) => new Promise((resolve) => {
      eventLoopApi.setImmediate(() => resolve(value));
    }),
  };
}

function createCryptoApi() {
  const randomFill = (target: Uint8Array): Uint8Array => {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.getRandomValues) {
      cryptoApi.getRandomValues(target);
      return target;
    }
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.floor(Math.random() * 256);
    }
    return target;
  };
  return {
    randomUUID: (): string => globalThis.crypto?.randomUUID?.() ?? `${bytesToHex(randomFill(new Uint8Array(4)))}-${bytesToHex(randomFill(new Uint8Array(2)))}-4${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-8${bytesToHex(randomFill(new Uint8Array(2))).slice(1)}-${bytesToHex(randomFill(new Uint8Array(6)))}`,
    randomBytes: (size: number): BrowserBuffer => browserBufferFromBytes(randomFill(new Uint8Array(Math.max(0, Math.floor(Number(size) || 0))))),
    getRandomValues: <T extends Uint8Array>(array: T): T => randomFill(array) as T,
  };
}

function createStreamApi() {
  class PassThrough extends BrowserEventEmitter {
    private ended = false;

    write(chunk: unknown): boolean {
      if (this.ended) throw new Error('write after end');
      this.emit('data', BrowserBuffer.isBuffer(chunk) ? chunk : BrowserBuffer.from(chunk as never));
      return true;
    }

    end(chunk?: unknown): this {
      if (chunk !== undefined) this.write(chunk);
      this.ended = true;
      this.emit('end');
      this.emit('finish');
      return this;
    }

    pipe(destination: { write(chunk: unknown): unknown; end?: () => unknown }): typeof destination {
      this.on('data', (chunk) => destination.write(chunk));
      this.on('end', () => destination.end?.());
      return destination;
    }
  }
  return {
    Stream: BrowserEventEmitter,
    Readable: PassThrough,
    Writable: PassThrough,
    Duplex: PassThrough,
    Transform: PassThrough,
    PassThrough,
  };
}

function createUrlApi() {
  return {
    URL,
    URLSearchParams,
    domainToASCII: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    domainToUnicode: (domain: string) => {
      try {
        return new URL(`http://${domain}`).hostname;
      } catch {
        return '';
      }
    },
    fileURLToPath: (value: string | URL) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.protocol !== 'file:') {
        throw new TypeError('The URL must be of scheme file');
      }
      return decodeURIComponent(url.pathname);
    },
    pathToFileURL: (path: string) => new URL(`file://${path.startsWith('/') ? path : `/${path}`}`),
  };
}

function createListenerMap() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = (event: string, listener: (...args: unknown[]) => void) => {
    const next = listeners.get(event) ?? [];
    next.push(listener);
    listeners.set(event, next);
    return api;
  };
  const removeListener = (event: string, listener: (...args: unknown[]) => void) => {
    const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
    if (next.length === 0) listeners.delete(event);
    else listeners.set(event, next);
    return api;
  };
  const emit = (event: string, ...args: unknown[]): boolean => {
    const current = listeners.get(event) ?? [];
    for (const listener of current) listener(...args);
    return current.length > 0;
  };
  const api = {
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    once: (event: string, listener: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        removeListener(event, wrapped);
        listener(...args);
      };
      return on(event, wrapped);
    },
    emit,
  };
  return api;
}

function createIncomingMessage(request: RuntimeKernelHttpRequest) {
  const events = createListenerMap();
  let encoding: string | undefined;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(request);
  const rawHeaders = request.rawHeaders
    ? request.rawHeaders.flatMap(([name, value]) => [name, value])
    : Object.entries(request.headers ?? {}).flatMap(([name, value]) => [name, value]);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding as BufferEncoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = (): void => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit('data', formatBody());
      }
      readableEnded = true;
      events.emit('end');
    });
  };
  const message = {
    method: request.method,
    url: request.path,
    headers: request.headers ?? {},
    rawHeaders,
    signal: request.signal,
    httpVersion: '1.1',
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    socket: { remoteAddress: '127.0.0.1' },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    addListener: (event: string, listener: (...args: unknown[]) => void) => message.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    },
  };
  return message;
}

function createServerResponse(resolve: (response: RuntimeKernelHttpResponse) => void) {
  const events = createListenerMap();
  const headers: Record<string, string> = {};
  const headerEntries = new Map<string, { name: string; values: string[] }>();
  const chunks: Uint8Array[] = [];
  let ended = false;
  const setHeaderValue = (name: string, value: unknown): void => {
    const key = String(name).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const text = values.join(', ');
    headers[key] = text;
    headerEntries.set(key, { name: String(name), values });
  };
  const responseRawHeaders = (): Array<[string, string]> => {
    const result: Array<[string, string]> = [];
    for (const entry of headerEntries.values()) {
      for (const value of entry.values) result.push([entry.name, value]);
    }
    return result;
  };
  const response = {
    statusCode: 200,
    statusMessage: 'OK',
    headersSent: false,
    writableEnded: false,
    setHeader: (name: string, value: unknown) => {
      setHeaderValue(name, value);
      return response;
    },
    getHeader: (name: string) => headers[String(name).toLowerCase()],
    getHeaders: () => ({ ...headers }),
    hasHeader: (name: string) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
    removeHeader: (name: string) => {
      const key = String(name).toLowerCase();
      delete headers[key];
      headerEntries.delete(key);
    },
    flushHeaders: () => {
      response.headersSent = true;
    },
    writeHead: (statusCode: number, reasonOrHeaders?: string | Record<string, unknown>, maybeHeaders?: Record<string, unknown>) => {
      response.statusCode = Number(statusCode) || 200;
      response.headersSent = true;
      const nextHeaders = typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) setHeaderValue(name, value);
      return response;
    },
    write: (chunk: unknown, encoding?: string | (() => void), callback?: () => void) => {
      chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === 'string' ? encoding : undefined));
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return true;
    },
    end: (chunk?: unknown, encoding?: string | (() => void), callback?: () => void) => {
      if (ended) return response;
      if (chunk !== undefined && chunk !== null) response.write(chunk, typeof encoding === 'string' ? encoding : undefined);
      ended = true;
      response.writableEnded = true;
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      events.emit('finish');
      events.emit('close');
      const bodyBytes = concatBytes(chunks);
      const rawHeaders = responseRawHeaders();
      resolve({
        status: response.statusCode,
        headers,
        ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
        ...bytesToRuntimeHttpBody(bodyBytes),
      });
      return response;
    },
    on: events.on,
    addListener: events.addListener,
    once: events.once,
    removeListener: events.removeListener,
    off: events.off,
    emit: events.emit,
  };
  return response;
}

const HTTP_STATUS_CODES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
};

function createClientIncomingMessage(response: RuntimeKernelHttpResponse) {
  const events = createListenerMap();
  let encoding: string | undefined;
  let bodyRead = false;
  let bodyScheduled = false;
  let readableEnded = false;
  const bodyBytes = bytesFromRuntimeHttpBody(response);
  const formatBody = () => encoding ? BrowserBuffer.from(bodyBytes).toString(encoding as BufferEncoding) : BrowserBuffer.from(bodyBytes);
  const scheduleBody = (): void => {
    if (bodyScheduled) return;
    bodyScheduled = true;
    queueMicrotask(() => {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        events.emit('data', formatBody());
      }
      readableEnded = true;
      events.emit('end');
    });
  };
  const message = {
    statusCode: response.status,
    statusMessage: HTTP_STATUS_CODES[response.status] ?? '',
    headers: response.headers ?? {},
    rawHeaders: response.rawHeaders
      ? response.rawHeaders.flatMap(([name, value]) => [name, value])
      : Object.entries(response.headers ?? {}).flatMap(([name, value]) => [name, value]),
    httpVersion: '1.1',
    complete: true,
    get readableEnded() {
      return readableEnded;
    },
    setEncoding: (nextEncoding: string) => {
      encoding = nextEncoding;
      return message;
    },
    read: () => {
      if (bodyRead) return null;
      bodyRead = true;
      readableEnded = true;
      return formatBody();
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    addListener: (event: string, listener: (...args: unknown[]) => void) => message.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      if (event === 'data' || event === 'end') scheduleBody();
      return message;
    },
    removeListener: events.removeListener,
    off: events.removeListener,
    [Symbol.asyncIterator]: async function* () {
      if (bodyBytes.byteLength > 0 && !bodyRead) {
        bodyRead = true;
        readableEnded = true;
        yield formatBody();
      }
    },
  };
  return message;
}

function headersFromHttpOptions(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return result;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      result[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return result;
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach: (callback: (value: unknown, name: unknown) => void) => void }).forEach((value, name) => {
      result[String(name).toLowerCase()] = String(value);
    });
    return result;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) result[name.toLowerCase()] = value.map(String).join(', ');
    else if (value !== undefined) result[name.toLowerCase()] = String(value);
  }
  return result;
}

function bodyToHttpBody(body: unknown): { body: string; bodyEncoding?: RuntimeFileEncoding } | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) return bytesToRuntimeHttpBody(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return bytesToRuntimeHttpBody(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return { body: String(body) };
}

function normalizeHttpClientRequest(args: unknown[]): {
  callback?: (response: unknown) => void;
  headers: Record<string, string>;
  method: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  url: URL;
} {
  const callback = args.find((arg): arg is (response: unknown) => void => typeof arg === 'function');
  const parts = args.filter((arg) => typeof arg !== 'function');
  const first = parts[0];
  const second = parts[1];
  const urlInput = typeof first === 'string' || first instanceof URL ? first : undefined;
  const options = (urlInput !== undefined ? second : first) as Record<string, unknown> | undefined;
  const baseUrl = urlInput !== undefined ? new URL(urlInput) : undefined;
  const optionHost = typeof options?.hostname === 'string'
    ? options.hostname
    : typeof options?.host === 'string'
      ? options.host
      : undefined;
  const protocol = String(options?.protocol ?? baseUrl?.protocol ?? 'http:');
  const hostname = optionHost ?? baseUrl?.hostname ?? 'localhost';
  const port = options?.port !== undefined ? String(options.port) : baseUrl?.port;
  const path = String(options?.path ?? `${baseUrl?.pathname ?? '/'}${baseUrl?.search ?? ''}`);
  const url = new URL(`${protocol}//${hostname}${port ? `:${port}` : ''}${path.startsWith('/') ? path : `/${path}`}`);
  return {
    ...(callback ? { callback } : {}),
    headers: headersFromHttpOptions(options?.headers),
    method: String(options?.method ?? 'GET').toUpperCase(),
    ...(typeof (options as { signal?: unknown } | undefined)?.signal === 'object' && (options as { signal?: unknown } | undefined)?.signal !== null
      ? { signal: (options as { signal: AbortSignal }).signal }
      : {}),
    ...(options?.timeout !== undefined && Number.isFinite(Number(options.timeout))
      ? { timeoutMs: Math.max(0, Number(options.timeout)) }
      : {}),
    url,
  };
}

function createHttpApi(kernelHttp: RuntimeKernelHttpBridge | undefined, signal: AbortSignal | undefined) {
  const activeHandles = new Set<RuntimeKernelHttpListenerHandle>();
  const activeClientAborters = new Set<() => void>();
  let activeClientRequests = 0;
  const closeWaiters: Array<() => void> = [];
  const notifyCloseWaiters = (): void => {
    if (activeHandles.size > 0 || activeClientRequests > 0) return;
    while (closeWaiters.length > 0) closeWaiters.shift()?.();
  };
  const closeHandle = (handle: RuntimeKernelHttpListenerHandle): void => {
    if (!activeHandles.delete(handle)) return;
    handle.close();
    notifyCloseWaiters();
  };
  const closeAll = (): void => {
    for (const handle of [...activeHandles]) closeHandle(handle);
    for (const abortClient of [...activeClientAborters]) abortClient();
  };
  signal?.addEventListener('abort', closeAll, { once: true });

  const createServer = (requestListener?: (request: unknown, response: unknown) => unknown) => {
    const events = createListenerMap();
    let handle: RuntimeKernelHttpListenerHandle | null = null;
    const server = {
      listening: false,
      listen: (...args: unknown[]) => {
        if (!kernelHttp) throw Object.assign(new Error('ENOSYS: tracekernel HTTP is not available'), { code: 'ENOSYS' });
        const port = typeof args[0] === 'number' || typeof args[0] === 'string' ? Number(args[0]) : 80;
        const host = typeof args[1] === 'string' ? args[1] : undefined;
        const callback = args.find((arg): arg is () => void => typeof arg === 'function');
        handle = kernelHttp.listen({ port, ...(host ? { host } : {}) }, async (request) => {
          const incoming = createIncomingMessage(request);
          const responsePromise = new Promise<RuntimeKernelHttpResponse>((resolve) => {
            const response = createServerResponse(resolve);
            let handled = false;
            try {
              handled = events.emit('request', incoming, response);
            } catch (error) {
              if (!response.writableEnded) {
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
              }
              return;
            }
            if (!handled && !response.writableEnded) {
              response.statusCode = 404;
              response.end('');
            }
          });
          return responsePromise;
        });
        activeHandles.add(handle);
        server.listening = true;
        events.emit('listening');
        callback?.();
        return server;
      },
      close: (callback?: (error?: Error) => void) => {
        if (handle) closeHandle(handle);
        handle = null;
        server.listening = false;
        events.emit('close');
        callback?.();
        return server;
      },
      address: () => handle ? { address: handle.info.host, port: handle.info.port, family: 'IPv4' } : null,
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
    };
    if (requestListener) server.on('request', requestListener as (...args: unknown[]) => void);
    return server;
  };

  const request = (...args: unknown[]) => {
    const events = createListenerMap();
    const chunks: Uint8Array[] = [];
    const headers: Record<string, string> = {};
    let ended = false;
    let destroyed = false;
    let timeoutMs: number | undefined;
    let timeoutCallback: (() => void) | undefined;
    let activeAbortClientRequest: ((error?: Error) => void) | undefined;
    let requestOptions: ReturnType<typeof normalizeHttpClientRequest>;
    try {
      requestOptions = normalizeHttpClientRequest(args);
      Object.assign(headers, requestOptions.headers);
      timeoutMs = requestOptions.timeoutMs;
    } catch (error) {
      requestOptions = {
        headers,
        method: 'GET',
        url: new URL('http://localhost/'),
      };
      queueMicrotask(() => events.emit('error', error));
    }
    const clientRequest = {
      destroyed: false,
      writableEnded: false,
      setTimeout: (milliseconds: number, callback?: () => void) => {
        timeoutMs = Math.max(0, Number(milliseconds) || 0);
        timeoutCallback = callback;
        if (callback) events.once('timeout', callback);
        return clientRequest;
      },
      setHeader: (name: string, value: unknown) => {
        headers[String(name).toLowerCase()] = String(value);
        return clientRequest;
      },
      getHeader: (name: string) => headers[String(name).toLowerCase()],
      getHeaders: () => ({ ...headers }),
      hasHeader: (name: string) => Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
      removeHeader: (name: string) => {
        delete headers[String(name).toLowerCase()];
      },
      write: (chunk: unknown, encoding?: string | (() => void), callback?: () => void) => {
        if (destroyed) return false;
        chunks.push(bytesFromFsWriteValue(chunk, typeof encoding === 'string' ? encoding : undefined));
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.();
        return true;
      },
      end: (chunk?: unknown, encoding?: string | (() => void), callback?: () => void) => {
        if (ended || destroyed) return clientRequest;
        if (chunk !== undefined && chunk !== null) clientRequest.write(chunk, typeof encoding === 'string' ? encoding : undefined);
        ended = true;
        clientRequest.writableEnded = true;
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.();
        if (!kernelHttp) {
          activeClientRequests += 1;
          queueMicrotask(() => {
            events.emit('error', Object.assign(new Error('ENOSYS: tracekernel HTTP is not available'), { code: 'ENOSYS' }));
            activeClientRequests -= 1;
            notifyCloseWaiters();
          });
          return clientRequest;
        }
        const body = bytesToRuntimeHttpBody(concatBytes(chunks));
        const rawHeaders = Object.entries(headers);
        activeClientRequests += 1;
        let active = true;
        let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
        let requestAbortListener: (() => void) | undefined;
        const dispatchAbortController = new AbortController();
        const finishClientRequest = (): void => {
          if (!active) return;
          active = false;
          activeAbortClientRequest = undefined;
          if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
          if (requestAbortListener) requestOptions.signal?.removeEventListener?.('abort', requestAbortListener);
          activeClientAborters.delete(abortClientRequest);
          queueMicrotask(() => {
            queueMicrotask(() => {
              activeClientRequests -= 1;
              notifyCloseWaiters();
            });
          });
        };
        const abortClientRequest = (error?: Error): void => {
          if (destroyed) return;
          destroyed = true;
          clientRequest.destroyed = true;
          if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
          if (error) events.emit('error', error);
          events.emit('close');
          finishClientRequest();
        };
        activeAbortClientRequest = abortClientRequest;
        activeClientAborters.add(abortClientRequest);
        if (requestOptions.signal) {
          requestAbortListener = () => abortClientRequest(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          requestOptions.signal.addEventListener?.('abort', requestAbortListener, { once: true });
          if (requestOptions.signal.aborted) requestAbortListener();
        }
        if (!destroyed && timeoutMs !== undefined) {
          timeoutHandle = globalThis.setTimeout(() => {
            events.emit('timeout');
            abortClientRequest(Object.assign(new Error(`ETIMEDOUT: request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
          }, timeoutMs);
        }
        void kernelHttp.dispatch({
          method: requestOptions.method,
          url: requestOptions.url.toString(),
          path: `${requestOptions.url.pathname}${requestOptions.url.search}`,
          headers,
          ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
          ...(chunks.length > 0 ? body : {}),
        }, {
          signal: dispatchAbortController.signal,
        }).then((response) => {
          if (destroyed) return;
          if (response.status === 0) {
            events.emit('error', Object.assign(new Error(response.body ?? 'connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
            finishClientRequest();
            return;
          }
          const incoming = createClientIncomingMessage(response);
          requestOptions.callback?.(incoming);
          events.emit('response', incoming);
          finishClientRequest();
        }, (error) => {
          if (!destroyed) events.emit('error', error);
          finishClientRequest();
        });
        return clientRequest;
      },
      abort: () => {
        clientRequest.destroy();
        events.emit('abort');
      },
      destroy: (error?: Error) => {
        if (activeAbortClientRequest) {
          activeAbortClientRequest(error);
          return clientRequest;
        }
        if (destroyed) return clientRequest;
        destroyed = true;
        clientRequest.destroyed = true;
        if (error) events.emit('error', error);
        events.emit('close');
        return clientRequest;
      },
      on: events.on,
      addListener: events.addListener,
      once: events.once,
      removeListener: events.removeListener,
      off: events.off,
      emit: events.emit,
    };
    return clientRequest;
  };

  const get = (...args: unknown[]) => {
    const clientRequest = request(...args);
    clientRequest.end();
    return clientRequest;
  };

  class TraceKernelHeaders {
    private readonly headerValues = new Map<string, string>();

    constructor(init?: unknown) {
      const record = headersFromHttpOptions(init);
      for (const [name, value] of Object.entries(record)) this.set(name, value);
    }

    append(name: string, value: unknown): void {
      const key = String(name).toLowerCase();
      const current = this.headerValues.get(key);
      this.headerValues.set(key, current === undefined ? String(value) : `${current}, ${String(value)}`);
    }

    delete(name: string): void {
      this.headerValues.delete(String(name).toLowerCase());
    }

    entries(): IterableIterator<[string, string]> {
      return this.headerValues.entries();
    }

    forEach(callback: (value: string, name: string, parent: TraceKernelHeaders) => void): void {
      for (const [name, value] of this.headerValues) callback(value, name, this);
    }

    get(name: string): string | null {
      return this.headerValues.get(String(name).toLowerCase()) ?? null;
    }

    has(name: string): boolean {
      return this.headerValues.has(String(name).toLowerCase());
    }

    keys(): IterableIterator<string> {
      return this.headerValues.keys();
    }

    set(name: string, value: unknown): void {
      this.headerValues.set(String(name).toLowerCase(), String(value));
    }

    values(): IterableIterator<string> {
      return this.headerValues.values();
    }

    toRecord(): Record<string, string> {
      return Object.fromEntries(this.headerValues);
    }

    [Symbol.iterator](): IterableIterator<[string, string]> {
      return this.entries();
    }
  }

  class TraceKernelRequest {
    readonly headers: TraceKernelHeaders;
    readonly method: string;
    readonly signal?: AbortSignal;
    readonly url: string;
    private readonly bodyPayload?: { body: string; bodyEncoding?: RuntimeFileEncoding };

    constructor(input: unknown, init?: Record<string, unknown>) {
      const sourceRequest = input instanceof TraceKernelRequest ? input : null;
      const source = input as {
        url?: unknown;
        method?: unknown;
        headers?: unknown;
        body?: unknown;
        bodyEncoding?: RuntimeFileEncoding;
        signal?: AbortSignal;
      };
      const inputUrl = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(sourceRequest?.url ?? source.url ?? '');
      this.url = inputUrl;
      this.method = String(init?.method ?? sourceRequest?.method ?? source.method ?? 'GET').toUpperCase();
      this.headers = new TraceKernelHeaders(sourceRequest?.headers ?? source.headers);
      const initHeaders = new TraceKernelHeaders(init?.headers);
      initHeaders.forEach((value, name) => this.headers.set(name, value));
      this.bodyPayload = init && Object.prototype.hasOwnProperty.call(init, 'body')
        ? bodyToHttpBody(init.body)
        : sourceRequest?.bodyForDispatch() ?? (
            source.bodyEncoding === 'base64'
              ? { body: String(source.body ?? ''), bodyEncoding: 'base64' }
              : bodyToHttpBody(source.body)
          );
      const initSignal = init?.signal;
      this.signal = initSignal && typeof initSignal === 'object' ? initSignal as AbortSignal : sourceRequest?.signal ?? source.signal;
    }

    async text(): Promise<string> {
      return textFromBytes(bytesFromRuntimeHttpBody(this.bodyPayload ?? {}));
    }

    bodyForDispatch(): { body: string; bodyEncoding?: RuntimeFileEncoding } | undefined {
      return this.bodyPayload;
    }
  }

  class TraceKernelResponse {
    readonly headers: TraceKernelHeaders;
    readonly ok: boolean;
    readonly redirected = false;
    readonly status: number;
    readonly statusText: string;
    readonly type = 'basic';
    readonly url: string;
    private readonly bodyBytes: Uint8Array;
    private used = false;

    constructor(bodyOrResponse: unknown = '', initOrUrl?: Record<string, unknown> | string) {
      const kernelResponse = typeof initOrUrl === 'string' &&
        bodyOrResponse !== null &&
        typeof bodyOrResponse === 'object' &&
        'status' in bodyOrResponse
        ? bodyOrResponse as RuntimeKernelHttpResponse
        : null;
      const init = !kernelResponse && initOrUrl && typeof initOrUrl === 'object' ? initOrUrl : {};
      const status = kernelResponse ? kernelResponse.status : Math.trunc(Number(init.status ?? 200)) || 200;
      this.status = status;
      this.statusText = HTTP_STATUS_CODES[status] ?? '';
      this.ok = status >= 200 && status < 300;
      this.headers = new TraceKernelHeaders(kernelResponse ? kernelResponse.headers : init.headers);
      this.bodyBytes = kernelResponse
        ? bytesFromRuntimeHttpBody(kernelResponse)
        : bytesFromRuntimeHttpBody(bodyToHttpBody(bodyOrResponse) ?? {});
      this.url = typeof initOrUrl === 'string' ? initOrUrl : '';
    }

    get bodyUsed(): boolean {
      return this.used;
    }

    private consume(): Uint8Array {
      if (this.used) throw new TypeError('Body has already been consumed.');
      this.used = true;
      return new Uint8Array(this.bodyBytes);
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = this.consume();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }

    clone(): TraceKernelResponse {
      if (this.used) throw new TypeError('Body has already been consumed.');
      return new TraceKernelResponse({
        status: this.status,
        headers: this.headers.toRecord(),
        ...bytesToRuntimeHttpBody(this.bodyBytes),
      }, this.url);
    }

    async json(): Promise<unknown> {
      return JSON.parse(textFromBytes(this.consume()));
    }

    async text(): Promise<string> {
      return textFromBytes(this.consume());
    }
  }

  const fetch = async (input: unknown, init?: Record<string, unknown>): Promise<TraceKernelResponse> => {
    if (!kernelHttp) throw Object.assign(new Error('ENOSYS: tracekernel HTTP is not available'), { code: 'ENOSYS' });
    const request = new TraceKernelRequest(input, init);
    const url = new URL(request.url);
    const body = request.bodyForDispatch();
    const headers = request.headers.toRecord();
    const rawHeaders = Object.entries(headers);
    activeClientRequests += 1;
    let active = true;
    let abortListener: (() => void) | undefined;
    let rejectFetch: ((error: unknown) => void) | undefined;
    const dispatchAbortController = new AbortController();
    const finishFetch = (): void => {
      if (!active) return;
      active = false;
      if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
      activeClientAborters.delete(abortFetch);
      globalThis.setTimeout(() => {
        activeClientRequests -= 1;
        notifyCloseWaiters();
      }, 0);
    };
    const abortFetch = (): void => {
      if (!dispatchAbortController.signal.aborted) dispatchAbortController.abort();
      rejectFetch?.(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      finishFetch();
    };
    activeClientAborters.add(abortFetch);
    return new Promise<TraceKernelResponse>((resolve, reject) => {
      rejectFetch = reject;
      if (request.signal) {
        abortListener = abortFetch;
        request.signal.addEventListener?.('abort', abortListener, { once: true });
        if (request.signal.aborted) {
          abortFetch();
          return;
        }
      }
      if (!active) return;
      void kernelHttp.dispatch({
        method: request.method,
        url: url.toString(),
        path: `${url.pathname}${url.search}`,
        headers,
        ...(rawHeaders.length > 0 ? { rawHeaders } : {}),
        ...(body !== undefined ? body : {}),
      }, {
        signal: dispatchAbortController.signal,
      }).then((response) => {
        if (!active) return;
        if (response.status === 0) {
          reject(Object.assign(new TypeError(response.body ?? 'fetch failed'), { code: 'ECONNREFUSED' }));
          finishFetch();
          return;
        }
        resolve(new TraceKernelResponse(response, url.toString()));
        finishFetch();
      }, (error) => {
        if (!active) return;
        reject(error);
        finishFetch();
      });
    });
  };

  return {
    module: {
      createServer,
      request,
      get,
      Server: function Server(this: unknown, requestListener?: (request: unknown, response: unknown) => unknown) {
        return createServer(requestListener);
      },
      STATUS_CODES: HTTP_STATUS_CODES,
    },
    fetch,
    Headers: TraceKernelHeaders,
    Request: TraceKernelRequest,
    Response: TraceKernelResponse,
    hasActiveWork: () => activeHandles.size > 0 || activeClientRequests > 0,
    waitForClose: () => activeHandles.size === 0 && activeClientRequests === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => closeWaiters.push(resolve)),
    closeAll,
  };
}

function installBrowserHttpGlobalLockdown(httpApi: ReturnType<typeof createHttpApi>): () => void {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const blockedNetworkApi = (name: string) => function blockedTraceKernelNetworkApi(): never {
    throw Object.assign(new Error(`EACCES: ${name} is not available inside TraceKernel browser execution`), { code: 'EACCES' });
  };
  const replacements: Record<string, unknown> = {
    fetch: httpApi.fetch,
    Headers: httpApi.Headers,
    Request: httpApi.Request,
    Response: httpApi.Response,
    XMLHttpRequest: blockedNetworkApi('XMLHttpRequest'),
    WebSocket: blockedNetworkApi('WebSocket'),
    EventSource: blockedNetworkApi('EventSource'),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: false,
        value,
      });
    } catch {
      // Same-realm execution is best-effort; worker-backed execution remains the stronger boundary.
    }
  }
  const navigatorValue = global.navigator;
  const sendBeaconDescriptor = navigatorValue && typeof navigatorValue === 'object'
    ? Object.getOwnPropertyDescriptor(navigatorValue, 'sendBeacon')
    : undefined;
  if (navigatorValue && typeof navigatorValue === 'object') {
    try {
      Object.defineProperty(navigatorValue, 'sendBeacon', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: blockedNetworkApi('navigator.sendBeacon'),
      });
    } catch {
      // Ignore read-only host navigator implementations.
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
        // User code can still poison same-realm globals; later executions should prefer worker-backed mode.
      }
    }
    if (navigatorValue && typeof navigatorValue === 'object') {
      try {
        if (sendBeaconDescriptor) {
          Object.defineProperty(navigatorValue, 'sendBeacon', sendBeaconDescriptor);
        } else {
          delete (navigatorValue as unknown as Record<string, unknown>).sendBeacon;
        }
      } catch {
        // Ignore read-only host navigator implementations.
      }
    }
  };
}

function installBrowserTimerGlobals(eventLoopApi: ReturnType<typeof createBrowserEventLoopApi>): () => void {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    setTimeout: eventLoopApi.setTimeout,
    clearTimeout: eventLoopApi.clearTimeout,
    setInterval: eventLoopApi.setInterval,
    clearInterval: eventLoopApi.clearInterval,
    setImmediate: eventLoopApi.setImmediate,
    clearImmediate: eventLoopApi.clearImmediate,
    queueMicrotask: eventLoopApi.queueMicrotask,
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) {
    previousDescriptors.set(name, Object.getOwnPropertyDescriptor(global, name));
    try {
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    } catch {
      // Same-realm execution is best-effort; worker-backed execution remains the stronger boundary.
    }
  }
  return () => {
    for (const [name, descriptor] of previousDescriptors) {
      try {
        if (descriptor) {
          Object.defineProperty(global, name, descriptor);
        } else {
          delete global[name];
        }
      } catch {
        // User code can still poison same-realm globals; later executions should prefer worker-backed mode.
      }
    }
  };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function workspaceFilename(path: string, workspaceRoot = '/workspace'): string {
  const normalized = normalizeProjectPath(path);
  return normalized ? `${workspaceRoot}/${normalized}` : workspaceRoot;
}

function workspaceFileUrl(path: string, workspaceRoot = '/workspace'): string {
  return `file://${workspaceFilename(path, workspaceRoot).split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function relativeWorkspacePath(from: string, to: string): string {
  const fromParts = normalizeProjectPath(from).split('/').filter(Boolean);
  const toParts = normalizeProjectPath(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  return [
    ...fromParts.slice(common).map(() => '..'),
    ...toParts.slice(common),
  ].join('/') || '.';
}

function workspaceDirname(path: string, workspaceRoot = '/workspace'): string {
  const normalizedDir = dirname(normalizeProjectPath(path));
  return normalizedDir ? `${workspaceRoot}/${normalizedDir}` : workspaceRoot;
}

function joinModulePath(parentPath: string, specifier: string): string {
  const parentDir = dirname(parentPath);
  const joined = `${parentDir}/${specifier}`.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function workspaceCwdPath(request: JavaScriptProjectCommandRequest): string {
  const projectCwd = request.project.cwd ?? '/workspace';
  if (request.cwd === projectCwd) return '';
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return normalizeProjectPath(request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function moduleFileCandidates(path: string): string[] {
  const normalized = normalizeProjectPath(path);
  const candidates = [normalized];
  if (!/\.(?:cjs|js|json|mjs)$/.test(normalized)) {
    candidates.push(`${normalized}.js`, `${normalized}.json`, `${normalized}.mjs`, `${normalized}.cjs`);
  }
  return candidates;
}

function parsePackageJson(modules: Map<string, string>, path: string): PackageMetadata | null {
  const normalized = normalizeProjectPath(path);
  const packageJson = modules.get(normalized ? `${normalized}/package.json` : 'package.json');
  if (!packageJson) return null;

  try {
    return JSON.parse(packageJson) as PackageMetadata;
  } catch {
    return null;
  }
}

function manifestDeclaresDependency(manifest: PackageMetadata, dependency: string): boolean {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) && dependency in dependencies) {
      return true;
    }
  }
  return false;
}

function projectDeclaresDependency(modules: Map<string, string>, dependency: string): boolean {
  for (const path of modules.keys()) {
    if (!path.endsWith('package.json')) continue;
    const directory = dirname(path);
    const manifest = parsePackageJson(modules, directory);
    if (manifest && manifestDeclaresDependency(manifest, dependency)) return true;
  }
  return false;
}

function packageExportTarget(value: unknown, condition: PackageResolutionCondition): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  return packageExportTarget(record[condition], condition)
    ?? packageExportTarget(record.node, condition)
    ?? packageExportTarget(record.default, condition)
    ?? packageExportTarget(condition === 'require' ? record.import : record.require, condition);
}

function packageMainCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  const parsed = parsePackageJson(modules, normalized);
  if (!parsed) return [];

  const candidates: string[] = [];
  const exportsTarget = packageExportTarget(parsed.exports, condition);
  if (exportsTarget) {
    candidates.push(...moduleFileCandidates(`${normalized}/${exportsTarget}`));
  }
  if (parsed.exports && typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)) {
    const dotTarget = packageExportTarget((parsed.exports as Record<string, unknown>)['.'], condition);
    if (dotTarget) {
      candidates.push(...moduleFileCandidates(`${normalized}/${dotTarget}`));
    }
  }
  if (typeof parsed.module === 'string' && parsed.module.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.module}`));
  }
  if (typeof parsed.main === 'string' && parsed.main.trim().length > 0) {
    candidates.push(...moduleFileCandidates(`${normalized}/${parsed.main}`));
  }

  return candidates;
}

function packageSpecifierParts(specifier: string): { packageName: string; subpath: string } | null {
  const parts = normalizeProjectPath(specifier).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith('@')) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.',
    };
  }
  return {
    packageName: parts[0] ?? '',
    subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : '.',
  };
}

function packageExportCandidates(
  modules: Map<string, string>,
  specifier: string,
  condition: PackageResolutionCondition
): string[] {
  const parsedSpecifier = packageLocationForSpecifier(specifier);
  if (!parsedSpecifier) return [];

  const packageRoot = parsedSpecifier.packageRoot;
  const parsed = parsePackageJson(modules, packageRoot);
  if (!parsed?.exports) return [];

  const exportTarget = parsedSpecifier.subpath === '.'
    ? packageExportTarget(parsed.exports, condition)
    : typeof parsed.exports === 'object' && !Array.isArray(parsed.exports)
      ? packageExportTarget((parsed.exports as Record<string, unknown>)[parsedSpecifier.subpath], condition)
      : null;

  if (!exportTarget) {
    return [];
  }

  return moduleFileCandidates(`${packageRoot}/${exportTarget}`);
}

function packageLocationForSpecifier(specifier: string): { packageRoot: string; subpath: string } | null {
  const normalized = normalizeProjectPath(specifier);
  const parts = normalized.split('/').filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex !== -1) {
    const packageStart = nodeModulesIndex + 1;
    const first = parts[packageStart];
    if (!first) return null;
    const packageLength = first.startsWith('@') ? 2 : 1;
    const packageParts = parts.slice(packageStart, packageStart + packageLength);
    if (packageParts.length !== packageLength || packageParts.some((part) => !part)) return null;
    const packageRoot = parts.slice(0, packageStart + packageLength).join('/');
    const subpathParts = parts.slice(packageStart + packageLength);
    return {
      packageRoot,
      subpath: subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.',
    };
  }

  const parsedSpecifier = packageSpecifierParts(normalized);
  if (!parsedSpecifier) return null;
  return {
    packageRoot: `node_modules/${parsedSpecifier.packageName}`,
    subpath: parsedSpecifier.subpath,
  };
}

function moduleCandidates(
  modules: Map<string, string>,
  path: string,
  condition: PackageResolutionCondition
): string[] {
  const normalized = normalizeProjectPath(path);
  return [
    ...packageExportCandidates(modules, normalized, condition),
    ...moduleFileCandidates(normalized),
    ...packageMainCandidates(modules, normalized, condition),
    `${normalized}/index.js`,
    `${normalized}/index.json`,
  ];
}

function nodePathEntries(
  request: JavaScriptProjectCommandRequest,
  cwdPath: string,
  workspace: WorkspacePathContext
): string[] {
  const rawNodePath = request.env.NODE_PATH;
  if (typeof rawNodePath !== 'string' || rawNodePath.trim().length === 0) {
    return [];
  }

  return rawNodePath
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeWorkspaceEntryPath(entry, cwdPath, true, workspace))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function packageTypeForPath(modules: Map<string, string>, path: string): string | null {
  const normalized = normalizeProjectPath(path);
  const parts = normalized.split('/');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    const parsed = parsePackageJson(modules, directory);
    if (typeof parsed?.type === 'string') return parsed.type;
  }
  return null;
}

function isEsmModule(modules: Map<string, string>, path: string): boolean {
  const normalized = normalizeProjectPath(path);
  if (normalized.endsWith('.mjs')) return true;
  if (normalized.endsWith('.cjs') || normalized.endsWith('.json')) return false;
  return normalized.endsWith('.js') && packageTypeForPath(modules, normalized) === 'module';
}

function toRequireBinding(specifier: string): string {
  return `require(${JSON.stringify(specifier)})`;
}

function toDynamicImportBinding(specifier: string): string {
  return `__import(${JSON.stringify(specifier)})`;
}

function transformDynamicImports(code: string): string {
  return code.replace(
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    (_match, _quote: string, specifier: string) => toDynamicImportBinding(specifier)
  );
}

function serializableKernelHttpRequest(request: RuntimeKernelHttpRequest): RuntimeKernelHttpRequest {
  const { signal: _signal, ...serializable } = request;
  return serializable;
}

function defaultImportBinding(name: string, specifier: string, index: number): string {
  const moduleName = `__tracecode_esm_default_${index}`;
  return [
    `const ${moduleName} = ${toRequireBinding(specifier)};`,
    `const ${name} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`,
  ].join(' ');
}

function transformNamedBindings(bindings: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [importedName, localName] = part.split(/\s+as\s+/).map((value) => value.trim());
      return localName ? `${importedName}: ${localName}` : importedName;
    })
    .join(', ');
}

function namedExportAssignments(bindings: string, moduleName?: string): string {
  return bindings
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [localName, exportedName] = part.split(/\s+as\s+/).map((value) => value.trim());
      const targetName = exportedName ?? localName;
      const source = moduleName ? `${moduleName}.${localName}` : localName;
      return `exports.${targetName} = ${source};`;
    })
    .join(' ');
}

function transformStaticEsmToCommonJs(code: string, importMetaUrl?: string): string {
  let defaultImportIndex = 0;
  let reExportIndex = 0;
  return transformDynamicImports(code)
    .replace(
      /\bimport\.meta\.url\b/g,
      JSON.stringify(importMetaUrl ?? 'file:///workspace/[eval]')
    )
    .replace(
      /^\s*export\s+\*\s+from\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
      (_match, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; for (const __tracecode_key of Object.keys(${moduleName})) { if (__tracecode_key !== "default") exports[__tracecode_key] = ${moduleName}[__tracecode_key]; }`;
      }
    )
    .replace(
      /^\s*export\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, namedExports: string, _quote: string, specifier: string) => {
        const moduleName = `__tracecode_esm_reexport_${reExportIndex++}`;
        return `const ${moduleName} = ${toRequireBinding(specifier)}; ${namedExportAssignments(namedExports, moduleName)}`;
      }
    )
    .replace(
      /^\s*import\s+([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
      (_match, defaultName: string, namespaceName: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${namespaceName} = ${required}; const ${moduleName} = ${namespaceName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      }
    )
    .replace(
      /^\s*import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?\s*$/gm,
      (_match, defaultName: string, namedImports: string, _quote: string, specifier: string) => {
        const required = toRequireBinding(specifier);
        const moduleName = `__tracecode_esm_default_${defaultImportIndex++}`;
        return `const ${moduleName} = ${required}; const { ${transformNamedBindings(namedImports)} } = ${moduleName}; const ${defaultName} = ${moduleName} && typeof ${moduleName} === "object" && "default" in ${moduleName} ? ${moduleName}.default : ${moduleName};`;
      }
    )
    .replace(
      /^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, namespaceName: string, _quote: string, specifier: string) =>
        `const ${namespaceName} = ${toRequireBinding(specifier)};`
    )
    .replace(
      /\bimport\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
      (_match, namedImports: string, _quote: string, specifier: string) =>
        `const { ${transformNamedBindings(namedImports)} } = ${toRequireBinding(specifier)};`
    )
    .replace(
      /^\s*import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/gm,
      (_match, defaultName: string, _quote: string, specifier: string) =>
        defaultImportBinding(defaultName, specifier, defaultImportIndex++)
    )
    .replace(
      /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm,
      (_match, _quote: string, specifier: string) => `${toRequireBinding(specifier)};`
    )
    .replace(
      /^\s*export\s+function\s+([\w$]+)\s*\(/gm,
      (_match, name: string) => `exports.${name} = function ${name}(`
    )
    .replace(
      /^\s*export\s+class\s+([\w$]+)\s*/gm,
      (_match, name: string) => `exports.${name} = class ${name} `
    )
    .replace(
      /^\s*export\s+(const|let|var)\s+([\w$]+)\s*=/gm,
      (_match, declaration: string, name: string) => `${declaration} ${name} = exports.${name} =`
    )
    .replace(
      /^\s*export\s+default\s+/gm,
      'exports.default = '
    )
    .replace(
      /^\s*export\s+\{([^}]+)\}\s*;?\s*$/gm,
      (_match, namedExports: string) => namedExportAssignments(namedExports)
    );
}

function resolveModulePath(
  modules: Map<string, string>,
  specifier: string,
  parentPath: string,
  nodePathSearchEntries: readonly string[] = [],
  condition: PackageResolutionCondition = 'require'
): string {
  const basePaths = specifier.startsWith('.')
    ? [joinModulePath(parentPath, specifier)]
    : [
        ...nodeModulesSearchPaths(parentPath, specifier),
        specifier,
        ...nodePathSearchEntries.map((entry) => entry ? `${entry}/${specifier}` : specifier),
      ];

  for (const basePath of basePaths) {
    for (const candidate of moduleCandidates(modules, basePath, condition)) {
      if (modules.has(candidate)) return candidate;
    }
  }

  throw new Error(`Cannot find module '${specifier}'`);
}

function nodeModulesSearchPaths(parentPath: string, specifier: string): string[] {
  const parentDirectory = dirname(normalizeProjectPath(parentPath));
  const parts = parentDirectory ? parentDirectory.split('/').filter(Boolean) : [];
  const paths: string[] = [];

  for (let index = parts.length; index >= 0; index -= 1) {
    const directory = parts.slice(0, index).join('/');
    paths.push(directory ? `${directory}/node_modules/${specifier}` : `node_modules/${specifier}`);
  }

  return paths;
}

function moduleSearchPaths(parentPath: string, workspaceRoot = '/workspace'): string[] {
  return nodeModulesSearchPaths(parentPath, '').map((path) => workspaceFilename(path.replace(/\/$/, ''), workspaceRoot));
}

function formatConsoleValues(values: unknown[]): string {
  return values
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack ?? value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

function formatBrowserJavaScriptErrorForStderr(error: unknown): string {
  if (error instanceof Error) {
    const text = typeof error.stack === 'string' && error.stack.trim()
      ? error.stack
      : error.message;
    return `${text.trimEnd()}\n`;
  }
  return `${String(error)}\n`;
}

function sanitizeBrowserJavaScriptStack(error: unknown, sourcePath: string): unknown {
  if (!(error instanceof Error) || typeof error.stack !== 'string' || !error.stack.trim()) {
    return error;
  }

  const mappedStack = error.stack.replace(
    /\(eval at [^,]+ \([^)]*\), <anonymous>:(\d+):(\d+)\)/g,
    (_match, line, column) => `(${sourcePath}:${Math.max(1, Number(line) - 2)}:${column})`
  );
  const lines: string[] = [];
  for (const line of mappedStack.split('\n')) {
    if (
      line.includes('/@fs/') ||
      line.includes('/dist/browser/project.js') ||
      line.includes('runBrowserJavaScriptProjectRequest') ||
      line.includes('executeEntrypoint') ||
      line.includes('executeModule')
    ) {
      break;
    }
    lines.push(line);
  }
  Object.defineProperty(error, 'stack', {
    configurable: true,
    value: (lines.length > 0 ? lines : [mappedStack.split('\n')[0] ?? error.message]).join('\n'),
  });
  return error;
}

function processArgvForRequest(request: JavaScriptProjectCommandRequest): string[] {
  if (request.source === 'argument') {
    return ['node', ...request.args];
  }

  if (request.source === 'stdin') {
    return ['node', '-', ...request.args];
  }

  return ['node', request.scriptPath, ...request.args];
}

function requireModulesForRequest(request: JavaScriptProjectCommandRequest): string[] {
  return Array.isArray(request.options?.require)
    ? request.options.require.filter((item): item is string => typeof item === 'string')
    : [];
}

interface BrowserJavaScriptProjectWorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
  runnerOptions?: Pick<BrowserJavaScriptProjectRunnerOptions, 'allowDynamicEval'>;
  port?: MessagePort;
}

interface BrowserJavaScriptProjectPendingMessage {
  protocolToken: string;
  resolve: (value: RuntimeCommandResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: RuntimeCommandEvent) => void;
  kernelHttp?: RuntimeKernelHttpBridge;
  port?: MessagePort;
  httpListeners: Map<string, RuntimeKernelHttpListenerHandle>;
  httpRequests: Map<string, { resolve: (response: RuntimeKernelHttpResponse) => void; reject: (error: Error) => void }>;
  httpDispatchAbortControllers: Map<string, AbortController>;
}

function createBrowserJavaScriptProjectAbortError(): Error {
  return Object.assign(new Error('Execution aborted'), { name: 'AbortError' });
}

function createBrowserJavaScriptProjectProtocolToken(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function createBrowserJavaScriptProjectPolicyFailureRunner(stderr: string): JavaScriptProjectCommandRunner {
  return (request) => {
    const io = createRuntimeProjectIoBridge(request.onEvent);
    io.output('stderr', stderr);
    io.status('process-exit', 'Browser Node exited', { command: 'node', exitCode: 1 });
    return Promise.resolve({
      stdout: '',
      stderr,
      exitCode: 1,
    });
  };
}

class BrowserJavaScriptProjectWorkerClient {
  private worker: Worker | null = null;
  private messageId = 0;
  private httpRequestId = 0;
  private readonly pendingMessages = new Map<string, BrowserJavaScriptProjectPendingMessage>();

  constructor(
    private readonly workerUrl: string,
    private readonly runnerOptions: Pick<BrowserJavaScriptProjectRunnerOptions, 'allowDynamicEval'> = {}
  ) {}

  executeProject(
    request: JavaScriptProjectCommandRequest,
    timeoutMs: number,
    onEvent?: (event: RuntimeCommandEvent) => void
  ): Promise<RuntimeCommandResult> {
    const signal = request.signal;
    if (signal?.aborted) {
      const abortError = createBrowserJavaScriptProjectAbortError();
      this.terminateAndReset(abortError);
      return Promise.reject(abortError);
    }
    const { signal: _signal, onEvent: _requestOnEvent, kernelHttp, ...workerRequest } = request;
    return this.executeWithTimeout(
      () => this.sendMessage('execute-project-javascript', workerRequest, onEvent, kernelHttp),
      timeoutMs,
      signal
    );
  }

  terminate(): void {
    this.terminateAndReset();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<BrowserJavaScriptProjectWorkerMessage>) => {
      this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.terminateAndReset(new Error(event.message || 'JavaScript project worker error'));
    };
    return this.worker;
  }

  private handleWorkerMessage(message: BrowserJavaScriptProjectWorkerMessage): void {
    const { id, type, payload, protocolToken } = message;
    if (!id) return;
    const pending = this.pendingMessages.get(id);
    if (!pending || protocolToken !== pending.protocolToken) return;
    if (type === 'project-event') {
      pending.onEvent?.(payload as RuntimeCommandEvent);
      return;
    }
    if (
      type === 'kernel-http-listen' ||
      type === 'kernel-http-close' ||
      type === 'kernel-http-response' ||
      type === 'kernel-http-dispatch' ||
      type === 'kernel-http-abort-dispatch' ||
      type === 'kernel-http-error'
    ) {
      this.handleKernelHttpProtocolMessage(id, type, payload);
      return;
    }
    this.pendingMessages.delete(id);
    this.cleanupPendingKernelHttp(pending);
    if (type === 'error') {
      const errorMessage = payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error ?? 'JavaScript project worker failed')
        : 'JavaScript project worker failed';
      pending.reject(new Error(errorMessage));
      return;
    }
    pending.resolve(payload as RuntimeCommandResult);
  }

  private sendMessage(
    type: string,
    payload: unknown,
    onEvent?: (event: RuntimeCommandEvent) => void,
    kernelHttp?: RuntimeKernelHttpBridge
  ): Promise<RuntimeCommandResult> {
    const worker = this.getWorker();
    const id = String(++this.messageId);
    const protocolToken = createBrowserJavaScriptProjectProtocolToken();
    const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    return new Promise<RuntimeCommandResult>((resolve, reject) => {
      if (channel) {
        channel.port1.onmessage = (event: MessageEvent<BrowserJavaScriptProjectWorkerMessage>) => {
          this.handleWorkerMessage(event.data);
        };
        channel.port1.start?.();
      }
      this.pendingMessages.set(id, {
        protocolToken,
        resolve,
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(kernelHttp ? { kernelHttp } : {}),
        ...(channel ? { port: channel.port1 } : {}),
        httpListeners: new Map(),
        httpRequests: new Map(),
        httpDispatchAbortControllers: new Map(),
      });
      const message: BrowserJavaScriptProjectWorkerMessage = {
        id,
        type,
        payload,
        protocolToken,
        runnerOptions: this.runnerOptions,
        ...(channel ? { port: channel.port2 } : {}),
      };
      if (channel) {
        worker.postMessage(message, [channel.port2]);
      } else {
        worker.postMessage(message);
      }
    });
  }

  private handleKernelHttpProtocolMessage(commandId: string, type: string, payload: unknown): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const message = payload as RuntimeKernelHttpProtocolMessage;
    if (type === 'kernel-http-listen' && message.type === 'kernel-http-listen') {
      if (!pending.kernelHttp) {
        this.postKernelHttpError(commandId, { listenerId: message.listenerId, error: 'TraceKernel HTTP is not available.' });
        return;
      }
      try {
        const handle = pending.kernelHttp.listen(message.options, (request) => this.dispatchWorkerKernelHttpRequest(commandId, message.listenerId, request));
        pending.httpListeners.set(message.listenerId, handle);
        this.postWorkerMessage(commandId, 'kernel-http-listen-result', {
          type: 'kernel-http-listen-result',
          listenerId: message.listenerId,
          info: handle.info,
        } satisfies RuntimeKernelHttpProtocolMessage);
      } catch (error) {
        this.postKernelHttpError(commandId, {
          listenerId: message.listenerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (type === 'kernel-http-close' && message.type === 'kernel-http-close') {
      pending.httpListeners.get(message.listenerId)?.close();
      pending.httpListeners.delete(message.listenerId);
      return;
    }
    if (type === 'kernel-http-response' && message.type === 'kernel-http-response') {
      const request = pending.httpRequests.get(message.requestId);
      pending.httpRequests.delete(message.requestId);
      request?.resolve(message.response);
      return;
    }
    if (type === 'kernel-http-dispatch' && message.type === 'kernel-http-dispatch') {
      if (!pending.kernelHttp) {
        this.postKernelHttpError(commandId, { requestId: message.requestId, error: 'TraceKernel HTTP is not available.' });
        return;
      }
      const abortController = new AbortController();
      pending.httpDispatchAbortControllers.set(message.requestId, abortController);
      pending.kernelHttp.dispatch(message.request, {
        signal: abortController.signal,
        ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
      }).then((response) => {
        pending.httpDispatchAbortControllers.delete(message.requestId);
        this.postWorkerMessage(commandId, 'kernel-http-dispatch-result', {
          type: 'kernel-http-dispatch-result',
          requestId: message.requestId,
          response,
        } satisfies RuntimeKernelHttpProtocolMessage);
      }, (error) => {
        pending.httpDispatchAbortControllers.delete(message.requestId);
        this.postKernelHttpError(commandId, {
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (type === 'kernel-http-abort-dispatch' && message.type === 'kernel-http-abort-dispatch') {
      pending.httpDispatchAbortControllers.get(message.requestId)?.abort();
      pending.httpDispatchAbortControllers.delete(message.requestId);
      return;
    }
    if (type === 'kernel-http-error' && message.type === 'kernel-http-error') {
      if (message.requestId) {
        const request = pending.httpRequests.get(message.requestId);
        pending.httpRequests.delete(message.requestId);
        request?.reject(new Error(message.error));
      }
    }
  }

  private dispatchWorkerKernelHttpRequest(
    commandId: string,
    listenerId: string,
    request: RuntimeKernelHttpRequest
  ): Promise<RuntimeKernelHttpResponse> {
    const pending = this.pendingMessages.get(commandId);
    if (!pending || !this.worker) return Promise.reject(new Error('JavaScript project worker is not running.'));
    const requestId = `${commandId}:http:${++this.httpRequestId}`;
    let abortListener: (() => void) | undefined;
    return new Promise<RuntimeKernelHttpResponse>((resolve, reject) => {
      const cleanup = (): void => {
        if (abortListener) request.signal?.removeEventListener?.('abort', abortListener);
      };
      pending.httpRequests.set(requestId, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (request.signal) {
        abortListener = () => {
          this.postWorkerMessage(commandId, 'kernel-http-abort-request', {
            type: 'kernel-http-abort-request',
            requestId,
          } satisfies RuntimeKernelHttpProtocolMessage);
        };
        request.signal.addEventListener?.('abort', abortListener, { once: true });
        if (request.signal.aborted) abortListener();
      }
      this.postWorkerMessage(commandId, 'kernel-http-request', {
        type: 'kernel-http-request',
        listenerId,
        requestId,
        request: serializableKernelHttpRequest(request),
      } satisfies RuntimeKernelHttpProtocolMessage);
    });
  }

  private postWorkerMessage(commandId: string, type: string, payload: RuntimeKernelHttpProtocolMessage): void {
    const pending = this.pendingMessages.get(commandId);
    if (!pending) return;
    const message: BrowserJavaScriptProjectWorkerMessage = {
      id: commandId,
      type,
      payload,
      protocolToken: pending.protocolToken,
    };
    if (pending.port) {
      pending.port.postMessage(message);
      return;
    }
    this.worker?.postMessage(message);
  }

  private postKernelHttpError(
    commandId: string,
    error: Omit<Extract<RuntimeKernelHttpProtocolMessage, { type: 'kernel-http-error' }>, 'type'>
  ): void {
    this.postWorkerMessage(commandId, 'kernel-http-error', {
      type: 'kernel-http-error',
      ...error,
    } satisfies RuntimeKernelHttpProtocolMessage);
  }

  private cleanupPendingKernelHttp(pending: BrowserJavaScriptProjectPendingMessage): void {
    for (const listener of pending.httpListeners.values()) listener.close();
    pending.httpListeners.clear();
    for (const request of pending.httpRequests.values()) request.reject(new Error('JavaScript project worker finished before HTTP response.'));
    pending.httpRequests.clear();
    for (const abortController of pending.httpDispatchAbortControllers.values()) abortController.abort();
    pending.httpDispatchAbortControllers.clear();
    pending.port?.close();
  }

  private executeWithTimeout(
    executor: () => Promise<RuntimeCommandResult>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeCommandResult> {
    return new Promise<RuntimeCommandResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const abortError = createBrowserJavaScriptProjectAbortError();
        this.terminateAndReset(abortError);
        rejectOnce(abortError);
      };
      const timeoutId = setTimeout(() => {
        const timeoutError = new Error(`node: execution timed out after ${timeoutMs}ms`);
        this.terminateAndReset(timeoutError);
        rejectOnce(timeoutError);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      executor().then((result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }, (error) => {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private terminateAndReset(reason: Error = new Error('JavaScript project worker was terminated')): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, pending] of this.pendingMessages) {
      this.cleanupPendingKernelHttp(pending);
      pending.reject(reason);
    }
    this.pendingMessages.clear();
  }
}

function createWorkerBackedBrowserJavaScriptProjectRunner(
  options: BrowserJavaScriptProjectRunnerOptions & { workerUrl: string }
): JavaScriptProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerIsolation = options.workerIsolation ?? 'per-command';
  if (workerIsolation !== 'per-command' && workerIsolation !== 'shared') {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      `node: invalid browser JavaScript worker isolation "${String(workerIsolation)}"; expected "per-command" or "shared"\n`
    );
  }
  if (workerIsolation === 'shared' && options.trustedReusableWorker !== true) {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      'node: browser JavaScript shared worker isolation is trusted-only and requires trustedReusableWorker: true\n'
    );
  }
  if (workerIsolation === 'per-command') {
    return (request) =>
      runRuntimeProjectWorkerBridge({
        request,
        startPhase: 'process-start',
        startMessage: 'Starting browser Node',
        startDetail: {
          command: 'node',
          args: processArgvForRequest(request).slice(2),
          cwd: request.cwd,
        },
        finishPhase: 'process-exit',
        finishMessage: 'Browser Node exited',
        applyFileChange: options.applyFileChange,
        run: async (workerRequest, onEvent) => {
          const client = new BrowserJavaScriptProjectWorkerClient(options.workerUrl, {
            allowDynamicEval: options.allowDynamicEval,
          });
          try {
            return await client.executeProject(workerRequest, timeoutMs, onEvent);
          } finally {
            client.terminate();
          }
        },
      });
  }
  const client = new BrowserJavaScriptProjectWorkerClient(options.workerUrl, {
    allowDynamicEval: options.allowDynamicEval,
  });
  return (request) =>
    runRuntimeProjectWorkerBridge({
      request,
      startPhase: 'process-start',
      startMessage: 'Starting browser Node',
      startDetail: {
        command: 'node',
        args: processArgvForRequest(request).slice(2),
        cwd: request.cwd,
      },
      finishPhase: 'process-exit',
      finishMessage: 'Browser Node exited',
      applyFileChange: options.applyFileChange,
      run: (workerRequest, onEvent) => client.executeProject(workerRequest, timeoutMs, onEvent),
    });
}

export function createBrowserJavaScriptProjectRunner(
  options: BrowserJavaScriptProjectRunnerOptions = {}
): JavaScriptProjectCommandRunner {
  if (options.workerUrl && typeof Worker !== 'undefined') {
    return createWorkerBackedBrowserJavaScriptProjectRunner({
      ...options,
      workerUrl: options.workerUrl,
    });
  }
  if (
    options.hardened === true ||
    options.allowMainThreadExecution !== true ||
    options.trustedMainThreadExecution !== true
  ) {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      'node: browser JavaScript project runner requires a Worker-backed runner unless allowMainThreadExecution and trustedMainThreadExecution are explicitly enabled\n'
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (request) => {
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let forcedResult: RuntimeCommandResult | undefined;
    const executionState: BrowserJavaScriptProjectExecutionState = { cancelled: false };
    const execution = runBrowserJavaScriptProjectRequest(request, options, executionState).finally(() => {
      if (timeoutId !== undefined) hostClearTimeout(timeoutId);
      if (abortListener) request.signal?.removeEventListener('abort', abortListener);
    });
    timeoutId = hostSetTimeout(() => {
      if (forcedResult) return;
      executionState.cancelled = true;
      const io = createRuntimeProjectIoBridge(request.onEvent);
      const timeoutStderr = `node: execution timed out after ${timeoutMs}ms\n`;
      io.output('stderr', timeoutStderr);
      io.status('process-exit', 'Browser Node timed out', { command: 'node', exitCode: 124, timeoutMs });
      forcedResult = {
        stdout: '',
        stderr: timeoutStderr,
        exitCode: 124,
      };
    }, timeoutMs);
    if (request.signal) {
      abortListener = () => {
        if (forcedResult) return;
        executionState.cancelled = true;
        const signal = runtimeAbortSignalName(request.signal);
        const exitCode = runtimeSignalExitCode(signal);
        const io = createRuntimeProjectIoBridge(request.onEvent);
        io.status('process-exit', 'Browser Node interrupted', { command: 'node', exitCode, signal });
        forcedResult = {
          stdout: '',
          stderr: 'Execution aborted\n',
          exitCode,
        };
      };
      request.signal.addEventListener('abort', abortListener, { once: true });
      if (request.signal.aborted) abortListener();
    }
    try {
      const result = await execution;
      return forcedResult ?? result;
    } catch (error) {
      if (forcedResult) return forcedResult;
      throw error;
    }
  };
}

export async function runBrowserJavaScriptProjectRequest(
  request: JavaScriptProjectCommandRequest,
  options: BrowserJavaScriptProjectRunnerOptions,
  executionState: BrowserJavaScriptProjectExecutionState
): Promise<RuntimeCommandResult> {
    if (options.allowDynamicEval === false) {
      const stderr = 'node: browser JavaScript project runner requires dynamic evaluation\n';
      const io = createRuntimeProjectIoBridge(request.onEvent);
      io.output('stderr', stderr);
      io.status('process-exit', 'Browser Node exited', { command: 'node', exitCode: 1 });
      return {
        stdout: '',
        stderr,
        exitCode: 1,
      };
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const liveIo = new RuntimeProjectLiveIoController({
      applyFileChange: options.applyFileChange ? async (change, phase) => {
        if (executionState.cancelled) return false;
        return options.applyFileChange?.(change, phase);
      } : undefined,
      onEvent: (event) => {
        if (!executionState.cancelled) request.onEvent?.(event);
      },
      signal: request.signal,
    });
    const emitRuntimeEvent = (event: RuntimeCommandEvent): void => {
      liveIo.handleRuntimeEvent(event);
    };
    const io = createRuntimeProjectIoBridge(emitRuntimeEvent);
    const workspacePathContext = createWorkspacePathContext(request.project);
    const workspaceRoot = workspacePathContext.root;
    const kernelInfo = request.project.kernel ?? fallbackKernelInfo(request.project, workspacePathContext);
    const kernelDevices = request.project.kernelDevices;
    const procSnapshot = createBrowserProcSnapshot(request.project.kernelFiles);
    const cwdPath = workspaceCwdPath(request);
    const hiddenFiles = Array.from(new Set(
      (request.project.hiddenFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, '', false, workspacePathContext))
    ));
    const hiddenNamespaces = new Set<string>();
    for (const hiddenPath of hiddenFiles) {
      if (!hiddenPath) continue;
      hiddenNamespaces.add(hiddenPath);
      const parts = hiddenPath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        hiddenNamespaces.add(parts.slice(0, index).join('/'));
      }
    }
    const isHiddenNamespacePath = (path: string): boolean =>
      Boolean(path) && Array.from(hiddenNamespaces).some((hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}/`));
    const isHiddenProjectPath = (path: string): boolean =>
      isHiddenNamespacePath(path) || hiddenFiles.some((hiddenPath) => hiddenPath.startsWith(`${path}/`));
    const readonlyFiles = new Set(
      (request.project.readonlyFiles ?? []).map((path) => normalizeWorkspaceEntryPath(path, '', false, workspacePathContext))
    );
    io.status('process-start', 'Starting browser Node', {
      command: 'node',
      args: processArgvForRequest(request).slice(2),
      cwd: request.cwd,
    });
    const visibleProjectFiles = request.project.files.filter((file) =>
      !isHiddenProjectPath(assertSafeWorkspaceFilePath(file.path, '', workspacePathContext))
    );
    const modules = new Map(
      visibleProjectFiles
        .filter((file) => file.encoding !== 'base64')
        .map((file) => [assertSafeWorkspaceFilePath(file.path, '', workspacePathContext), file.contents])
    );
    const virtualTextFiles = new Map<string, string>();
    const virtualTypeScriptPackagePaths = [
      'node_modules/typescript/package.json',
      'node_modules/typescript/index.js',
    ];
    const hasTypeScriptPackage = Array.from(modules.keys()).some((path) => path.startsWith('node_modules/typescript/'));
    const canExposeVirtualTypeScriptPackage = virtualTypeScriptPackagePaths.every((path) => !isHiddenProjectPath(path));
    if (!hasTypeScriptPackage && canExposeVirtualTypeScriptPackage && projectDeclaresDependency(modules, 'typescript')) {
      const version = getLanguageRuntimeInfo('typescript').compiler?.version ?? '5.9.3';
      virtualTextFiles.set('node_modules/typescript/package.json', JSON.stringify({
        name: 'typescript',
        version,
        main: 'index.js',
      }, null, 2) + '\n');
      virtualTextFiles.set('node_modules/typescript/index.js', [
        `const version = ${JSON.stringify(version)};`,
        'module.exports = {',
        '  version,',
        '  versionMajorMinor: version.split(".").slice(0, 2).join("."),',
        '};',
        '',
      ].join('\n'));
    }
    for (const [path, contents] of virtualTextFiles) {
      modules.set(path, contents);
    }
    const fileStore = new Map(
      visibleProjectFiles.map((file) => [assertSafeWorkspaceFilePath(file.path, '', workspacePathContext), fileBytes(file)] as const)
    );
    for (const [path, contents] of virtualTextFiles) {
      fileStore.set(path, textEncoder.encode(contents));
    }
    const directoryStore = new Set<string>(['']);
    for (const filePath of fileStore.keys()) {
      const parts = filePath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        directoryStore.add(parts.slice(0, index).join('/'));
      }
    }
    for (const directory of request.project.directories ?? []) {
      const directoryPath = normalizeWorkspaceEntryPath(directory, '', true, workspacePathContext);
      if (!directoryPath) continue;
      if (isHiddenProjectPath(directoryPath)) continue;
      const parts = directoryPath.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        directoryStore.add(parts.slice(0, index).join('/'));
      }
    }
    type BrowserEntryMetadata = {
      atimeMs: number;
      birthtimeMs: number;
      ctimeMs: number;
      gid: number;
      mode?: number;
      mtimeMs: number;
      uid: number;
    };
    let fsTimestampMs = 1;
    const createEntryMetadata = (mode?: number): BrowserEntryMetadata => ({
      atimeMs: fsTimestampMs,
      birthtimeMs: fsTimestampMs,
      ctimeMs: fsTimestampMs,
      gid: 0,
      mode,
      mtimeMs: fsTimestampMs,
      uid: 0,
    });
    const entryMetadata = new Map<string, BrowserEntryMetadata>(
      Array.from(fileStore.keys()).map((filePath) => [filePath, createEntryMetadata(0o100644)])
    );
    for (const directoryPath of directoryStore) {
      if (!entryMetadata.has(directoryPath)) {
        entryMetadata.set(directoryPath, createEntryMetadata(0o40755));
      }
    }
    const touchEntryMetadata = (path: string): void => {
      fsTimestampMs += 1;
      const previous = entryMetadata.get(path);
      entryMetadata.set(path, {
        atimeMs: previous?.atimeMs ?? fsTimestampMs,
        birthtimeMs: previous?.birthtimeMs ?? fsTimestampMs,
        ctimeMs: fsTimestampMs,
        gid: previous?.gid ?? 0,
        mode: previous?.mode,
        mtimeMs: fsTimestampMs,
        uid: previous?.uid ?? 0,
      });
    };
    const updateEntryMetadata = (path: string, update: Partial<BrowserEntryMetadata>): void => {
      fsTimestampMs += 1;
      const previous = entryMetadata.get(path) ?? createEntryMetadata();
      entryMetadata.set(path, {
        ...previous,
        ...update,
        ctimeMs: fsTimestampMs,
      });
    };
    const deleteEntryMetadata = (path: string): void => {
      fsTimestampMs += 1;
      entryMetadata.delete(path);
    };
    const hardLinkGroups = new Map<string, Set<string>>();
    const hardLinkGroupForPath = (path: string): Set<string> => hardLinkGroups.get(path) ?? new Set([path]);
    const setHardLinkGroup = (paths: Iterable<string>): Set<string> => {
      const group = new Set(paths);
      for (const path of group) hardLinkGroups.set(path, group);
      return group;
    };
    const linkPaths = (source: string, destination: string): void => {
      setHardLinkGroup([...hardLinkGroupForPath(source), destination]);
    };
    const unlinkPathFromHardLinks = (path: string): void => {
      const group = hardLinkGroups.get(path);
      if (!group) return;
      group.delete(path);
      hardLinkGroups.delete(path);
      if (group.size <= 1) {
        for (const remaining of group) hardLinkGroups.delete(remaining);
        return;
      }
      for (const remaining of group) hardLinkGroups.set(remaining, group);
    };
    const moveHardLinkPath = (oldPath: string, newPath: string): void => {
      const group = hardLinkGroups.get(oldPath);
      if (!group) return;
      group.delete(oldPath);
      group.add(newPath);
      hardLinkGroups.delete(oldPath);
      for (const path of group) hardLinkGroups.set(path, group);
    };
    const linkedInodeForPath = (path: string): number => {
      const group = hardLinkGroups.get(path);
      return inodeForPath(group ? [...group].sort((left, right) => left.localeCompare(right))[0] ?? path : path);
    };
    const originalFiles = new Map(fileStore);
    const cache = new Map<string, ModuleRecord>();
    const requireCache: Record<string, ModuleRecord> = {};
    let mainModule: ModuleRecord | undefined;

    const emitOutput = (
      stream: 'stdout' | 'stderr',
      data: string,
      device?: RuntimeKernelDevicePath,
      sourceDevice?: RuntimeKernelDevicePath
    ): void => {
      if (stream === 'stdout') {
        stdout.push(data);
      } else {
        stderr.push(data);
      }
      io.output(stream, data, device, sourceDevice);
    };

    const writeDevice = (device: RuntimeKernelDevicePath, data: string): void => {
      const route = runtimeKernelDeviceOutputRoute(kernelDevices, device);
      if (!route) {
        if (runtimeKernelDeviceOutputTarget(kernelDevices, device) === '/dev/null') return;
        throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
      }
      emitOutput(route.stream, data, route.outputDevice, route.sourceDevice);
    };

    const readDeviceBytes = (device: RuntimeKernelDevicePath, size?: number): Uint8Array => {
      const inputRoute = runtimeKernelDeviceInputRoute(kernelDevices, device);
      if (!inputRoute) return new Uint8Array();
      if (request.stdinPipe) {
        return readRuntimeCommandStdinPipeBytes(request.stdinPipe, size);
      }
      return new Uint8Array();
    };
    const remainingDeviceBytes = (device: RuntimeKernelDevicePath): number => (
      runtimeKernelDeviceInputRoute(kernelDevices, device)
        ? request.stdinPipe
          ? runtimeCommandStdinPipeRemainingBytes(request.stdinPipe)
          : 0
        : 0
    );
    const deviceInputClosed = (device: RuntimeKernelDevicePath): boolean => (
      runtimeKernelDeviceInputRoute(kernelDevices, device)
        ? request.stdinPipe ? runtimeCommandStdinPipeClosed(request.stdinPipe) : true
        : true
    );
    const readDevice = (device: RuntimeKernelDevicePath): string => textFromBytes(readDeviceBytes(device));

    const consoleApi = {
      log: (...values: unknown[]) => {
        emitOutput('stdout', `${formatConsoleValues(values)}\n`);
      },
      error: (...values: unknown[]) => {
        emitOutput('stderr', `${formatConsoleValues(values)}\n`);
      },
    };

    const createWritableDevice = (device: RuntimeKernelDevicePath, fd: number) => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      let destroyed = false;
      let closed = false;
      let bytesWritten = 0;
      let writableEnded = false;
      let writableFinished = false;
      const on = (event: string, listener: (...args: unknown[]) => void): void => {
        const next = listeners.get(event) ?? [];
        next.push(listener);
        listeners.set(event, next);
      };
      const removeListener = (event: string, listener: (...args: unknown[]) => void): void => {
        const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
        if (next.length === 0) listeners.delete(event);
        else listeners.set(event, next);
      };
      const emit = (event: string, ...args: unknown[]): boolean => {
        const current = listeners.get(event) ?? [];
        for (const listener of current) listener(...args);
        return current.length > 0;
      };
      const stream = {
        fd,
        writable: true,
        isTTY: false,
        get closed() {
          return closed;
        },
        get bytesWritten() {
          return bytesWritten;
        },
        get writableEnded() {
          return writableEnded;
        },
        get writableFinished() {
          return writableFinished;
        },
        write: (value: unknown, encoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
          const bytes = bytesFromFsWriteValue(value, typeof encoding === 'string' ? encoding : undefined);
          const data = textFromBytes(bytes);
          writeDevice(device, data);
          bytesWritten += bytes.byteLength;
          const done = typeof encoding === 'function' ? encoding : callback;
          done?.(null);
          return true;
        },
        end: (value?: unknown, encoding?: string | (() => void), callback?: () => void) => {
          if (value !== undefined && value !== null) {
            stream.write(value, typeof encoding === 'string' ? encoding : undefined);
          }
          writableEnded = true;
          const done = typeof encoding === 'function' ? encoding : callback;
          queueMicrotask(() => {
            done?.();
            writableFinished = true;
            emit('finish');
            closed = true;
            emit('close');
          });
          return stream;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          on(event, listener);
          return stream;
        },
        addListener: (event: string, listener: (...args: unknown[]) => void) => {
          on(event, listener);
          return stream;
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          removeListener(event, listener);
          return stream;
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          removeListener(event, listener);
          return stream;
        },
        emit,
        destroy: (error?: Error) => {
          if (destroyed) return stream;
          destroyed = true;
          queueMicrotask(() => {
            if (error) emit('error', error);
            closed = true;
            emit('close');
          });
          return stream;
        },
        close: (callback?: () => void) => {
          if (callback) stream.once('close', callback);
          return stream.destroy();
        },
        get destroyed() {
          return destroyed;
        },
        once: (event: string, listener: (...args: unknown[]) => void) => {
          const wrapped = (...args: unknown[]) => {
            removeListener(event, wrapped);
            listener(...args);
          };
          on(event, wrapped);
          return stream;
        },
      };
      return stream;
    };

    const eventLoopApi = createBrowserEventLoopApi(executionState);
    const stdinDevice = createReadableStdinDevice(
      (size) => readDeviceBytes('/dev/stdin', size),
      () => remainingDeviceBytes('/dev/stdin'),
      () => deviceInputClosed('/dev/stdin'),
      eventLoopApi.setTimeout
    );
    const processApi = {
      argv: processArgvForRequest(request),
      env: request.env,
      exitCode: undefined as number | undefined,
      cwd: () => request.cwd,
      stdin: stdinDevice,
      stdout: createWritableDevice('/dev/stdout', 1),
      stderr: createWritableDevice('/dev/stderr', 2),
      exit: (code = 0) => {
        throw Object.assign(new Error(`process.exit(${code})`), {
          exitCode: Number(code) || 0,
          suppressStderr: true,
        });
      },
    };
    const nodePathSearchEntries = nodePathEntries(request, cwdPath, workspacePathContext);
    const pathApi = createPathApi(() => cwdPath, workspaceRoot);
    const osApi = createOsApi(workspaceRoot);
    const urlApi = createUrlApi();
    const assertApi = createAssertApi();
    const eventsApi = createEventsApi();
    const utilApi = createUtilApi();
    const streamApi = createStreamApi();
    const cryptoApi = createCryptoApi();
    const timersPromisesApi = createTimersPromisesApi(eventLoopApi);
    const syncTextModule = (path: string, bytes: Uint8Array): void => {
      const text = textFromBytes(bytes);
      if (byteEqual(utf8Bytes(text), bytes)) {
        modules.set(path, text);
      } else {
        modules.delete(path);
      }
    };
    type BrowserFsWatcher = {
      path: string;
      recursive: boolean;
      closed: boolean;
      listeners: Map<string, Array<(...args: unknown[]) => void>>;
    };
    type BrowserFileStat = {
      atime: Date;
      atimeMs: number;
      birthtime: Date;
      birthtimeMs: number;
      blksize: number;
      blocks: number;
      ctime: Date;
      ctimeMs: number;
      dev: number;
      gid: number;
      ino: number;
      mode: number;
      mtime: Date;
      mtimeMs: number;
      nlink: number;
      rdev: number;
      size: number;
      uid: number;
      isBlockDevice: () => boolean;
      isCharacterDevice: () => boolean;
      isFIFO: () => boolean;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSocket: () => boolean;
      isSymbolicLink: () => boolean;
    };
    type BrowserFileStatResult = Omit<
      BrowserFileStat,
      'atimeMs' | 'birthtimeMs' | 'blksize' | 'blocks' | 'ctimeMs' | 'dev' | 'gid' | 'ino' | 'mode' | 'mtimeMs' | 'nlink' | 'rdev' | 'size' | 'uid'
    > & {
      atimeMs: number | bigint;
      birthtimeMs: number | bigint;
      blksize: number | bigint;
      blocks: number | bigint;
      ctimeMs: number | bigint;
      dev: number | bigint;
      gid: number | bigint;
      ino: number | bigint;
      mode: number | bigint;
      mtimeMs: number | bigint;
      nlink: number | bigint;
      rdev: number | bigint;
      size: number | bigint;
      uid: number | bigint;
    };
    type BrowserFileSystemStat = {
      type: number | bigint;
      bsize: number | bigint;
      blocks: number | bigint;
      bfree: number | bigint;
      bavail: number | bigint;
      files: number | bigint;
      ffree: number | bigint;
    };
    type BrowserStatOptions = {
      bigint?: boolean;
      throwIfNoEntry?: boolean;
    };
    type BrowserFileWatcher = {
      path: string;
      listener: (curr: BrowserFileStat, prev: BrowserFileStat) => void;
      previous: BrowserFileStat;
    };
    const fsWatchers = new Set<BrowserFsWatcher>();
    const fsFileWatchers = new Set<BrowserFileWatcher>();
    const inodeForPath = (path: string): number => {
      let hash = 2166136261;
      for (let index = 0; index < path.length; index += 1) {
        hash ^= path.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0) || 1;
    };
    const statForNormalizedPath = (normalized: string): BrowserFileStat | null => {
      const isFile = fileStore.has(normalized);
      const prefix = normalized ? `${normalized}/` : '';
      const isDirectory = !isFile && (
        directoryStore.has(normalized) ||
        Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
      );
      if (!isFile && !isDirectory) return null;
      const metadata = entryMetadata.get(normalized) ?? createEntryMetadata(isDirectory ? 0o40755 : 0o100644);
      const size = isFile ? fileStore.get(normalized)?.byteLength ?? 0 : 0;
      const mode = metadata.mode ?? (isDirectory ? 0o40755 : 0o100644);
      return {
        atimeMs: metadata.atimeMs,
        birthtimeMs: metadata.birthtimeMs,
        blksize: 4096,
        blocks: Math.ceil(size / 512),
        ctimeMs: metadata.ctimeMs,
        dev: 1,
        gid: metadata.gid,
        ino: isFile ? linkedInodeForPath(normalized) : inodeForPath(normalized),
        mode,
        mtimeMs: metadata.mtimeMs,
        nlink: isDirectory ? 2 : hardLinkGroupForPath(normalized).size,
        rdev: 0,
        size,
        uid: metadata.uid,
        atime: new Date(metadata.atimeMs),
        birthtime: new Date(metadata.birthtimeMs),
        ctime: new Date(metadata.ctimeMs),
        mtime: new Date(metadata.mtimeMs),
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isFile: () => isFile,
        isDirectory: () => isDirectory,
        isSocket: () => false,
        isSymbolicLink: () => false,
      };
    };
    const statForKernelPath = (path: string, kernelStat: RuntimeKernelVirtualStat): BrowserFileStat => {
      const modeType = kernelStat.isDirectory ? 0o40000 : kernelStat.isCharacterDevice ? 0o20000 : 0o100000;
      const mode = modeType | kernelStat.mode;
      return {
        atimeMs: fsTimestampMs,
        birthtimeMs: fsTimestampMs,
        blksize: 4096,
        blocks: Math.ceil(kernelStat.size / 512),
        ctimeMs: fsTimestampMs,
        dev: 1,
        gid: 0,
        ino: inodeForPath(path),
        mode,
        mtimeMs: fsTimestampMs,
        nlink: kernelStat.isDirectory ? 2 : 1,
        rdev: 0,
        size: kernelStat.size,
        uid: 0,
        atime: new Date(fsTimestampMs),
        birthtime: new Date(fsTimestampMs),
        ctime: new Date(fsTimestampMs),
        mtime: new Date(fsTimestampMs),
        isBlockDevice: () => false,
        isCharacterDevice: () => kernelStat.isCharacterDevice,
        isFIFO: () => false,
        isFile: () => kernelStat.isFile,
        isDirectory: () => kernelStat.isDirectory,
        isSocket: () => false,
        isSymbolicLink: () => false,
      };
    };
    const statForKernelTarget = (path: unknown, options?: BrowserStatOptions): BrowserFileStat | null | undefined => {
      const statTarget = runtimeStatTarget(path, kernelInfo, kernelDevices, procSnapshot);
      if (!statTarget || statTarget.kind === 'workspace') return null;
      if (statTarget.kind === 'error') {
        if (options?.throwIfNoEntry === false) return undefined;
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
      }
      return statForKernelPath(statTarget.path, statTarget.stat);
    };
    const browserFileSystemStat = (bigint = false): BrowserFileSystemStat => {
      const stats = {
        type: 0x74726365,
        bsize: 4096,
        blocks: 1_048_576,
        bfree: 1_048_000,
        bavail: 1_048_000,
        files: 1_000_000,
        ffree: 999_000,
      };
      if (!bigint) return stats;
      return Object.fromEntries(
        Object.entries(stats).map(([key, value]) => [key, BigInt(value)])
      ) as BrowserFileSystemStat;
    };
    const browserStatsResult = (stats: BrowserFileStat, options?: BrowserStatOptions): BrowserFileStatResult => {
      if (!options?.bigint) return stats;
      return {
        ...stats,
        atimeMs: BigInt(Math.trunc(stats.atimeMs)),
        birthtimeMs: BigInt(Math.trunc(stats.birthtimeMs)),
        blksize: BigInt(stats.blksize),
        blocks: BigInt(stats.blocks),
        ctimeMs: BigInt(Math.trunc(stats.ctimeMs)),
        dev: BigInt(stats.dev),
        gid: BigInt(stats.gid),
        ino: BigInt(stats.ino),
        mode: BigInt(stats.mode),
        mtimeMs: BigInt(Math.trunc(stats.mtimeMs)),
        nlink: BigInt(stats.nlink),
        rdev: BigInt(stats.rdev),
        size: BigInt(stats.size),
        uid: BigInt(stats.uid),
      };
    };
    const missingFileStat = (): BrowserFileStat => ({
      atime: new Date(0),
      atimeMs: 0,
      birthtime: new Date(0),
      birthtimeMs: 0,
      blksize: 4096,
      blocks: 0,
      ctime: new Date(0),
      ctimeMs: 0,
      dev: 1,
      gid: 0,
      ino: 0,
      mode: 0,
      mtime: new Date(0),
      mtimeMs: 0,
      nlink: 0,
      rdev: 0,
      size: 0,
      uid: 0,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => false,
      isDirectory: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    });
    const watchedFilename = (watcher: BrowserFsWatcher, changedPath: string): string | null => {
      if (changedPath === watcher.path) return changedPath.split('/').pop() ?? changedPath;
      const prefix = watcher.path ? `${watcher.path}/` : '';
      if (!changedPath.startsWith(prefix)) return null;
      const relative = changedPath.slice(prefix.length);
      if (!watcher.recursive && relative.includes('/')) return null;
      return relative;
    };
    const emitFsWatch = (watcher: BrowserFsWatcher, eventType: 'change' | 'rename', filename: string): void => {
      if (watcher.closed) return;
      for (const listener of watcher.listeners.get('change') ?? []) listener(eventType, filename);
    };
    const notifyFsWatchers = (eventType: 'change' | 'rename', path: string): void => {
      for (const watcher of fsWatchers) {
        const filename = watchedFilename(watcher, path);
        if (filename !== null) queueMicrotask(() => emitFsWatch(watcher, eventType, filename));
      }
    };
    const notifyWatchFileWatchers = (path: string): void => {
      for (const watcher of fsFileWatchers) {
        if (watcher.path !== path) continue;
        const previous = watcher.previous;
        const current = statForNormalizedPath(path) ?? missingFileStat();
        watcher.previous = current;
        queueMicrotask(() => watcher.listener(current, previous));
      }
    };
    const notifyDirectoryMutation = (path: string): void => {
      notifyFsWatchers('rename', path);
      notifyWatchFileWatchers(path);
    };
    const emitDirectoryCreate = (path: string): void => {
      if (!path) return;
      io.fileChange({ path, directory: true }, 'live');
    };
    const emitDirectoryDelete = (path: string): void => {
      if (!path) return;
      io.fileChange({ path, directory: true, deleted: true }, 'live');
    };
    const assertReadonlyFilePath = (normalized: string, operation: string): void => {
      if (readonlyFiles.has(normalized) || isHiddenNamespacePath(normalized)) {
        throw createRuntimeKernelReadonlyFileError(normalized, operation);
      }
    };
    const setFileBytes = (path: string, bytes: Uint8Array): void => {
      const linkedPaths = Array.from(hardLinkGroupForPath(path))
        .filter((linkedPath) => fileStore.has(linkedPath) || linkedPath === path);
      for (const linkedPath of linkedPaths) {
        assertReadonlyFilePath(linkedPath, 'write');
      }
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join('/');
        const existed = directoryStore.has(directoryPath);
        directoryStore.add(directoryPath);
        if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
        if (!existed) emitDirectoryCreate(directoryPath);
      }
      for (const linkedPath of linkedPaths) {
        fileStore.set(linkedPath, bytes);
        touchEntryMetadata(linkedPath);
        syncTextModule(linkedPath, bytes);
        cache.delete(linkedPath);
        io.fileChange(bytesToRuntimeFile(linkedPath, bytes), 'live');
        notifyFsWatchers('change', linkedPath);
        notifyWatchFileWatchers(linkedPath);
      }
    };
    const createEventTarget = () => {
      type EventListener = (...args: unknown[]) => void;
      type EventListenerWithOriginal = EventListener & { listener?: EventListener };
      const listeners = new Map<string, EventListener[]>();
      const listenerTarget = (listener: EventListener): EventListener => (
        (listener as EventListenerWithOriginal).listener ?? listener
      );
      const on = (event: string, listener: EventListener): void => {
        const next = listeners.get(event) ?? [];
        next.push(listener);
        listeners.set(event, next);
      };
      const prependListener = (event: string, listener: EventListener): void => {
        const next = listeners.get(event) ?? [];
        next.unshift(listener);
        listeners.set(event, next);
      };
      const removeListener = (event: string, listener: EventListener): void => {
        const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener && listenerTarget(candidate) !== listener);
        if (next.length === 0) listeners.delete(event);
        else listeners.set(event, next);
      };
      const once = (event: string, listener: EventListener, prepend = false): void => {
        const wrapped = (...args: unknown[]) => {
          removeListener(event, wrapped);
          listener(...args);
        };
        Object.defineProperty(wrapped, 'listener', { value: listener });
        if (prepend) prependListener(event, wrapped);
        else on(event, wrapped);
      };
      return {
        emit: (event: string, ...args: unknown[]) => {
          const current = listeners.get(event) ?? [];
          for (const listener of current) listener(...args);
          return current.length > 0;
        },
        on,
        addListener: on,
        prependListener,
        removeListener,
        off: removeListener,
        once: (event: string, listener: (...args: unknown[]) => void) => once(event, listener),
        prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => once(event, listener, true),
        removeAllListeners: (event?: string) => {
          if (typeof event === 'string') listeners.delete(event);
          else listeners.clear();
        },
        listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
        listeners: (event: string) => (listeners.get(event) ?? []).map(listenerTarget),
        rawListeners: (event: string) => [...(listeners.get(event) ?? [])],
        eventNames: () => [...listeners.keys()],
      };
    };
    const createReadableStream = (bytes: Uint8Array, encoding?: string, onClose?: () => void) => {
      const events = createEventTarget();
      type PipeDestination = {
        write?: (chunk: BrowserBuffer | string) => unknown;
        end?: () => unknown;
        emit?: (event: string, ...args: unknown[]) => unknown;
      };
      type PipeBinding = {
        destination: PipeDestination;
        onData: (chunk: unknown) => void;
        onEnd: () => void;
      };
      let started = false;
      let closed = false;
      let destroyed = false;
      let ended = false;
      let offset = 0;
      let streamEncoding = encoding;
      let readableFlowing: boolean | null = null;
      const pipeBindings: PipeBinding[] = [];
      const internalCloseListeners = new Set<() => void>();
      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        onClose?.();
        for (const listener of internalCloseListeners) listener();
        internalCloseListeners.clear();
        events.emit('close');
      };
      const formatChunk = (chunk: Uint8Array): BrowserBuffer | string => {
        const buffer = BrowserBuffer.from(chunk);
        return streamEncoding ? buffer.toString(streamEncoding) : buffer;
      };
      const readChunk = (size?: number): BrowserBuffer | string | null => {
        if (destroyed || offset >= bytes.byteLength) {
          ended = offset >= bytes.byteLength;
          return null;
        }
        const requested = typeof size === 'number' && size >= 0 ? Math.floor(size) : bytes.byteLength - offset;
        const end = Math.min(bytes.byteLength, offset + requested);
        const chunk = bytes.slice(offset, end);
        offset = end;
        if (offset >= bytes.byteLength) ended = true;
        return formatChunk(chunk);
      };
      const scheduleRead = (): void => {
        if (started) return;
        if (readableFlowing === false) return;
        started = true;
        queueMicrotask(() => {
          if (closed || destroyed) return;
          const chunk = readChunk();
          if (chunk !== null && (typeof chunk !== 'string' || chunk.length > 0) && (!(chunk instanceof Uint8Array) || chunk.byteLength > 0)) {
            events.emit('data', chunk);
          }
          events.emit('end');
          closeStream();
        });
      };
      const stream = {
        readable: true,
        get closed() {
          return closed;
        },
        get destroyed() {
          return destroyed;
        },
        get readableEnded() {
          return ended;
        },
        get readableEncoding() {
          return streamEncoding ?? null;
        },
        get readableLength() {
          return Math.max(0, bytes.byteLength - offset);
        },
        get readableFlowing() {
          return readableFlowing;
        },
        [streamInternalCloseListeners]: internalCloseListeners,
        setEncoding: (nextEncoding: string) => {
          streamEncoding = nextEncoding;
          return stream;
        },
        read: (size?: number) => readChunk(size),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          events.on(event, listener);
          if (event === 'data') {
            if (readableFlowing === null) readableFlowing = true;
            scheduleRead();
          } else if (event === 'end') {
            scheduleRead();
          }
          return stream;
        },
        addListener: (event: string, listener: (...args: unknown[]) => void) => {
          stream.on(event, listener);
          return stream;
        },
        prependListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.prependListener(event, listener);
          if (event === 'data') {
            if (readableFlowing === null) readableFlowing = true;
            scheduleRead();
          } else if (event === 'end') {
            scheduleRead();
          }
          return stream;
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.removeListener(event, listener);
          return stream;
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          events.off(event, listener);
          return stream;
        },
        emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
        once: (event: string, listener: (...args: unknown[]) => void) => {
          events.once(event, listener);
          if (event === 'data') {
            if (readableFlowing === null) readableFlowing = true;
            scheduleRead();
          } else if (event === 'end') {
            scheduleRead();
          }
          return stream;
        },
        prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.prependOnceListener(event, listener);
          if (event === 'data') {
            if (readableFlowing === null) readableFlowing = true;
            scheduleRead();
          } else if (event === 'end') {
            scheduleRead();
          }
          return stream;
        },
        removeAllListeners: (event?: string) => {
          events.removeAllListeners(event);
          return stream;
        },
        listenerCount: (event: string) => events.listenerCount(event),
        listeners: (event: string) => events.listeners(event),
        rawListeners: (event: string) => events.rawListeners(event),
        eventNames: () => events.eventNames(),
        pause: () => {
          readableFlowing = false;
          return stream;
        },
        resume: () => {
          readableFlowing = true;
          scheduleRead();
          return stream;
        },
        destroy: (error?: Error) => {
          if (destroyed) return stream;
          destroyed = true;
          if (error) events.emit('error', error);
          closeStream();
          return stream;
        },
        close: (callback?: () => void) => {
          if (callback) stream.once('close', callback);
          closeStream();
          return stream;
        },
        pipe: (destination: PipeDestination, options?: { end?: boolean }) => {
          const onData = (chunk: unknown) => destination.write?.(chunk as BrowserBuffer | string);
          const onEnd = () => {
            if (options?.end !== false) destination.end?.();
          };
          pipeBindings.push({ destination, onData, onEnd });
          events.on('data', onData);
          events.on('end', onEnd);
          destination.emit?.('pipe', stream);
          readableFlowing = true;
          scheduleRead();
          return destination;
        },
        unpipe: (destination?: PipeDestination) => {
          for (let index = pipeBindings.length - 1; index >= 0; index -= 1) {
            const binding = pipeBindings[index];
            if (!destination || binding.destination === destination) {
              events.removeListener('data', binding.onData);
              events.removeListener('end', binding.onEnd);
              binding.destination.emit?.('unpipe', stream);
              pipeBindings.splice(index, 1);
            }
          }
          return stream;
        },
      };
      return stream;
    };
    const createWritableStream = (
      path: unknown,
      options?: string | { autoClose?: boolean; encoding?: string | null; fd?: number; flags?: string; start?: number } | null
    ) => {
      const events = createEventTarget();
      const optionFd = typeof options === 'object' && typeof options?.fd === 'number' ? options.fd : null;
      const encoding = requestedEncodingFromOptions(options);
      const flags = typeof options === 'object' && typeof options?.flags === 'string' ? options.flags : 'w';
      const parsed = parseOpenFlags(flags);
      const openTarget = optionFd === null
          ? runtimeOpenTarget(path, {
              ...parsed,
              writable: parsed.writable,
              create: parsed.create,
              truncate: parsed.truncate,
          }, kernelDevices, procSnapshot)
        : null;
      if (openTarget?.kind === 'error') {
        throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
          code: runtimeKernelOpenErrorCode(openTarget.reason),
        });
      }
      const device = openTarget?.kind === 'device' ? openTarget.device : null;
      const autoClose = typeof options === 'object' && options?.autoClose === false ? false : true;
      const normalized = device || optionFd !== null ? null : assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      if (normalized !== null) {
        assertWorkspaceFileWritePath(normalized, path, 'write');
        if (!parsed.create && !fileStore.has(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        if (parsed.exclusive && fileStore.has(normalized)) {
          throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
        }
      }
      if (normalized !== null && parsed.truncate) {
        setFileBytes(normalized, new Uint8Array());
      }
      let closed = false;
      let destroyed = false;
      let bytesWritten = 0;
      let writableEnded = false;
      let writableFinished = false;
      let writableCorked = 0;
      let writeOffset = typeof options === 'object' && typeof options?.start === 'number'
        ? Math.max(0, options.start)
        : 0;
      const hasExplicitWriteStart = typeof options === 'object' && typeof options?.start === 'number';
      const internalCloseListeners = new Set<() => void>();
      const writeBytes = (value: unknown, writeEncoding?: string): number => {
        if (writableEnded) {
          throw Object.assign(new Error('ERR_STREAM_WRITE_AFTER_END: write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
        }
        if (closed || destroyed) {
          throw Object.assign(new Error('ERR_STREAM_DESTROYED: Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
        }
        const bytes = bytesFromFsWriteValue(value, writeEncoding ?? encoding);
        if (optionFd !== null) {
          if (hasExplicitWriteStart) {
            writeDescriptorBytes(fileDescriptor(optionFd), bytes, writeOffset);
            writeOffset += bytes.byteLength;
          } else {
            writeDescriptorFileBytes(optionFd, bytes, flags.includes('a'));
          }
          bytesWritten += bytes.byteLength;
          return bytes.byteLength;
        }
        if (device) {
          writeDevice(device, textFromBytes(bytes));
          bytesWritten += bytes.byteLength;
          return bytes.byteLength;
        }
        if (!parsed.writable) {
          throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
        }
        const previous = fileStore.get(normalized ?? '') ?? new Uint8Array();
        const start = parsed.append ? previous.byteLength : writeOffset;
        const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
        next.set(previous, 0);
        next.set(bytes, start);
        setFileBytes(normalized ?? '', next);
        writeOffset = start + bytes.byteLength;
        bytesWritten += bytes.byteLength;
        return bytes.byteLength;
      };
      const closeStream = (emitFinish: boolean, done?: () => void, error?: Error): void => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => {
          if (error) events.emit('error', error);
          done?.();
          if (autoClose && optionFd !== null) fsApi.closeSync(optionFd);
          for (const listener of internalCloseListeners) listener();
          internalCloseListeners.clear();
          if (emitFinish) {
            writableFinished = true;
            events.emit('finish');
          }
          events.emit('close');
        });
      };
      const stream = {
        writable: true,
        get closed() {
          return closed;
        },
        get destroyed() {
          return destroyed;
        },
        get bytesWritten() {
          return bytesWritten;
        },
        get writableEnded() {
          return writableEnded;
        },
        get writableFinished() {
          return writableFinished;
        },
        get writableLength() {
          return 0;
        },
        get writableNeedDrain() {
          return false;
        },
        get writableCorked() {
          return writableCorked;
        },
        [streamInternalCloseListeners]: internalCloseListeners,
        on: (event: string, listener: (...args: unknown[]) => void) => {
          events.on(event, listener);
          return stream;
        },
        addListener: (event: string, listener: (...args: unknown[]) => void) => {
          stream.on(event, listener);
          return stream;
        },
        prependListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.prependListener(event, listener);
          return stream;
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.removeListener(event, listener);
          return stream;
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          events.off(event, listener);
          return stream;
        },
        emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
        once: (event: string, listener: (...args: unknown[]) => void) => {
          events.once(event, listener);
          return stream;
        },
        prependOnceListener: (event: string, listener: (...args: unknown[]) => void) => {
          events.prependOnceListener(event, listener);
          return stream;
        },
        removeAllListeners: (event?: string) => {
          events.removeAllListeners(event);
          return stream;
        },
        listenerCount: (event: string) => events.listenerCount(event),
        listeners: (event: string) => events.listeners(event),
        rawListeners: (event: string) => events.rawListeners(event),
        eventNames: () => events.eventNames(),
        cork: () => {
          writableCorked += 1;
        },
        uncork: () => {
          writableCorked = Math.max(0, writableCorked - 1);
        },
        write: (value: unknown, writeEncoding?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
          const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
          try {
            writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
            done?.(null);
            return true;
          } catch (error) {
            const streamError = error as Error;
            done?.(streamError);
            events.emit('error', streamError);
            return false;
          }
        },
        end: (value?: unknown, writeEncoding?: string | (() => void), callback?: () => void) => {
          const done = typeof writeEncoding === 'function' ? writeEncoding : callback;
          if (value !== undefined && value !== null) {
            try {
              writeBytes(value, typeof writeEncoding === 'string' ? writeEncoding : undefined);
            } catch (error) {
              writableEnded = true;
              closeStream(false, undefined, error as Error);
              return stream;
            }
          }
          writableEnded = true;
          closeStream(true, done);
          return stream;
        },
        destroy: (error?: Error) => {
          if (destroyed) return stream;
          destroyed = true;
          closeStream(false, undefined, error);
          return stream;
        },
        close: (callback?: () => void) => {
          if (callback) stream.once('close', callback);
          closeStream(false);
          return stream;
        },
      };
      return stream;
    };
    const assertStreamRangeInteger = (name: 'start' | 'end', value: unknown): number | undefined => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || Number(value) < 0) {
        throw Object.assign(new RangeError(`The value of "${name}" is out of range.`), { code: 'ERR_OUT_OF_RANGE' });
      }
      return Number(value);
    };
    const deleteFile = (path: unknown): void => {
      const removeTarget = runtimeRemoveTarget(path, kernelDevices);
      if (removeTarget?.kind === 'error') {
        const message = removeTarget.reason === 'device-not-found'
          ? `ENOENT: no such file or directory, unlink '${path}'`
          : `EROFS: read-only file system, unlink '${path}'`;
        throwRuntimeRemoveTargetError(removeTarget, message);
      }
      const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
      assertReadonlyFilePath(normalized, 'delete');
      if (!fileStore.delete(normalized)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: 'ENOENT' });
      }
      detachOpenFileDescriptorsForPath(normalized);
      unlinkPathFromHardLinks(normalized);
      modules.delete(normalized);
      cache.delete(normalized);
      deleteEntryMetadata(normalized);
      io.fileChange({ path: normalized, deleted: true }, 'live');
      notifyFsWatchers('rename', normalized);
      notifyWatchFileWatchers(normalized);
    };
    const fsConstants = {
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      O_RDONLY: 0,
      O_WRONLY: 1,
      O_RDWR: 2,
      O_CREAT: 0o100,
      O_EXCL: 0o200,
      O_TRUNC: 0o1000,
      O_APPEND: 0o2000,
      S_IFMT: 0o170000,
      S_IFREG: 0o100000,
      S_IFDIR: 0o040000,
      S_IFLNK: 0o120000,
      COPYFILE_EXCL: 1,
      COPYFILE_FICLONE: 2,
      COPYFILE_FICLONE_FORCE: 4,
    } as const;
    let mkdtempCounter = 0;
    const fileSystemEntryExists = (path: unknown): boolean => {
      const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
      if (accessTarget?.kind === 'allowed') return true;
      if (accessTarget?.kind === 'denied') return false;
      const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
      if (
        readTarget?.kind === 'device-file' ||
        readTarget?.kind === 'device-directory' ||
        readTarget?.kind === 'proc-file' ||
        readTarget?.kind === 'proc-directory'
      ) {
        return true;
      }
      if (readTarget?.kind === 'error') return false;
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      const prefix = normalized ? `${normalized}/` : '';
      return fileStore.has(normalized)
        || directoryStore.has(normalized)
        || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
    };
    const isWorkspaceDirectoryPath = (normalized: string): boolean => {
      const prefix = normalized ? `${normalized}/` : '';
      return directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
    };
    const workspaceFileAncestor = (normalized: string): string | null => {
      const parts = normalized.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directoryPath = parts.slice(0, index).join('/');
        if (fileStore.has(directoryPath)) return directoryPath;
      }
      return null;
    };
    const assertWorkspaceParentDirectoryPath = (normalized: string, path: unknown, syscall: string): void => {
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, ${syscall} '${path}'`), { code: 'ENOTDIR' });
      }
      const parent = dirname(normalized);
      const parentPath = parent === '' ? '' : parent;
      if (parentPath && !directoryStore.has(parentPath)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT' });
      }
    };
    const assertWorkspaceFileWritePath = (normalized: string, path: unknown, operation: string, syscall = operation): void => {
      if (!normalized) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: 'EISDIR' });
      }
      assertReadonlyFilePath(normalized, operation);
      assertWorkspaceParentDirectoryPath(normalized, path, syscall);
      if (isWorkspaceDirectoryPath(normalized)) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, ${syscall} '${path}'`), { code: 'EISDIR' });
      }
    };
    const assertFileSystemAccess = (path: unknown, mode: number = fsConstants.F_OK): void => {
      const requested = Number(mode) || fsConstants.F_OK;
      const accessTarget = runtimeAccessTarget(path, requested, kernelDevices, procSnapshot);
      if (accessTarget?.kind === 'allowed') return;
      if (accessTarget?.kind === 'denied') {
        const code = accessTarget.reason === 'not-found' ? 'ENOENT' : 'EACCES';
        const reason = accessTarget.reason === 'not-found' ? 'no such file or directory' : 'permission denied';
        throw Object.assign(new Error(`${code}: ${reason}, access '${path}'`), { code });
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, access '${path}'`), { code: 'ENOTDIR' });
      }
      const stats = statForNormalizedPath(normalized);
      if (!stats) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: 'ENOENT' });
      }
      const permissionMode = stats.mode & 0o777;
      const readable = (permissionMode & 0o444) !== 0;
      const writable = (permissionMode & 0o222) !== 0;
      const executable = (permissionMode & 0o111) !== 0;
      if (
        ((requested & fsConstants.R_OK) !== 0 && !readable) ||
        ((requested & fsConstants.W_OK) !== 0 && !writable) ||
        ((requested & fsConstants.X_OK) !== 0 && !executable)
      ) {
        throw Object.assign(new Error(`EACCES: permission denied, access '${path}'`), { code: 'EACCES' });
      }
    };
    const notifyMetadataMutation = (path: string): void => {
      notifyFsWatchers('change', path);
      notifyWatchFileWatchers(path);
    };
    const metadataPathForEntry = (path: unknown): string | null => {
      const metadataTarget = runtimeMetadataTarget(path, kernelDevices);
      if (metadataTarget?.kind === 'ignored-device') return null;
      if (metadataTarget?.kind === 'error') {
        const message = metadataTarget.reason === 'proc-read-only'
          ? `EROFS: read-only file system, metadata '${path}'`
          : `ENOENT: no such file or directory, metadata '${path}'`;
        throwRuntimeMetadataTargetError(metadataTarget, message);
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, metadata '${path}'`), { code: 'ENOTDIR' });
      }
      if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
      }
      return normalized;
    };
    const timeToMs = (value: unknown): number => {
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'number') return Math.max(0, value * 1000);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, parsed * 1000) : fsTimestampMs;
    };
    type BrowserFileDescriptor = {
      kind: 'file' | 'directory' | 'device' | 'proc';
      path?: string;
      bytes?: Uint8Array;
      device?: RuntimeKernelDevicePath;
      offset: number;
      readable: boolean;
      writable: boolean;
      append: boolean;
    };
    const stdioDescriptor = (device: RuntimeKernelDevicePath, append = false): BrowserFileDescriptor => ({
      kind: 'device',
      device,
      offset: 0,
      readable: runtimeKernelDeviceInputSource(kernelDevices, device) !== null,
      writable: runtimeKernelDeviceOutputTarget(kernelDevices, device) !== null,
      append,
    });
    const fileDescriptors = new Map<number, BrowserFileDescriptor>([
      [0, stdioDescriptor('/dev/stdin')],
      [1, stdioDescriptor('/dev/stdout', true)],
      [2, stdioDescriptor('/dev/stderr', true)],
    ]);
    let nextFd = 3;
    const workspaceFileDescriptorRecords = (): BrowserFileDescriptor[] =>
      [...fileDescriptors.values()].filter((entry) => entry.kind === 'file');
    const detachOpenFileDescriptorsForPath = (path: string): void => {
      const bytes = fileStore.get(path);
      for (const entry of workspaceFileDescriptorRecords()) {
        if (entry.path !== path) continue;
        entry.bytes = new Uint8Array(bytes ?? entry.bytes ?? new Uint8Array());
        entry.path = undefined;
      }
    };
    const moveOpenFileDescriptorPath = (oldPath: string, newPath: string): void => {
      for (const entry of workspaceFileDescriptorRecords()) {
        if (entry.path === oldPath) entry.path = newPath;
      }
    };
    const parseOpenFlags = (flags: unknown = 'r') => {
      if (typeof flags === 'number') {
        const access = flags & 3;
        return {
          readable: access === 0 || access === 2,
          writable: access === 1 || access === 2,
          append: (flags & 0o2000) !== 0,
          truncate: (flags & 0o1000) !== 0,
          create: (flags & 0o100) !== 0,
          exclusive: (flags & 0o200) !== 0,
        };
      }
      const text = String(flags);
      return {
        readable: text.includes('+') || text.startsWith('r'),
        writable: text.includes('+') || text.startsWith('w') || text.startsWith('a'),
        append: text.startsWith('a'),
        truncate: text.startsWith('w'),
        create: text.startsWith('w') || text.startsWith('a'),
        exclusive: text.includes('x'),
      };
    };
    const fileDescriptor = (fd: number): BrowserFileDescriptor => {
      const entry = fileDescriptors.get(Number(fd));
      if (!entry) throw Object.assign(new Error(`EBADF: bad file descriptor, fd ${fd}`), { code: 'EBADF' });
      return entry;
    };
    const descriptorMetadataPath = (fd: number, operation: string): string | null => {
      const entry = fileDescriptor(fd);
      if (entry.kind === 'file' && !entry.path) return null;
      const path = entry.kind === 'device' ? entry.device ?? '/dev/stdin' : entry.path ?? '';
      const metadataTarget = runtimeKernelMetadataTarget(path, kernelDevices);
      if (metadataTarget.kind === 'ignored-device') return null;
      if (metadataTarget.kind === 'error') {
        const message = metadataTarget.reason === 'proc-read-only'
          ? `EROFS: read-only file system, ${operation}`
          : `ENOENT: no such file or directory, ${operation}`;
        throwRuntimeMetadataTargetError(metadataTarget, message);
      }
      return path;
    };
    const descriptorBytes = (entry: BrowserFileDescriptor): Uint8Array => {
      if (entry.kind === 'device') return utf8Bytes(readDevice(entry.device ?? '/dev/stdin'));
      if (entry.kind === 'proc') return utf8Bytes(browserProcFileContents(procSnapshot, entry.path ?? '', kernelInfo));
      if (entry.kind === 'directory') {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${entry.path ?? ''}'`), { code: 'EISDIR' });
      }
      if (entry.path && fileStore.has(entry.path)) return fileStore.get(entry.path) ?? new Uint8Array();
      return entry.bytes ?? new Uint8Array();
    };
    const readDescriptorFileBytes = (fd: number): Uint8Array => {
      const entry = fileDescriptor(fd);
      if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
      if (entry.kind === 'device') return readDeviceBytes(entry.device ?? '/dev/stdin');
      const source = descriptorBytes(entry);
      const start = entry.offset;
      const bytes = source.slice(start);
      entry.offset = source.byteLength;
      return bytes;
    };
    const writeDescriptorBytes = (entry: BrowserFileDescriptor, bytes: Uint8Array, position?: number | null): void => {
      if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
      if (entry.kind === 'device') {
        writeDevice(entry.device ?? '/dev/stdout', textFromBytes(bytes));
        return;
      }
      if (entry.kind === 'proc') {
        throw Object.assign(new Error(`EROFS: read-only file system, write '${entry.path ?? '/proc'}'`), { code: 'EROFS' });
      }
      const previous = descriptorBytes(entry);
      const start = entry.append ? previous.byteLength : typeof position === 'number' ? Math.max(0, position) : entry.offset;
      const next = new Uint8Array(Math.max(previous.byteLength, start + bytes.byteLength));
      next.set(previous, 0);
      next.set(bytes, start);
      entry.bytes = next;
      if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
      if (entry.append || position === undefined || position === null) entry.offset = start + bytes.byteLength;
    };
    const writeDescriptorFileBytes = (fd: number, bytes: Uint8Array, append = false): void => {
      const entry = fileDescriptor(fd);
      const position = append && entry.kind !== 'device' ? descriptorBytes(entry).byteLength : null;
      writeDescriptorBytes(entry, bytes, position);
      if (append && entry.kind !== 'device' && typeof position === 'number') entry.offset = position + bytes.byteLength;
    };
    const truncateFileBytes = (path: string, length = 0): void => {
      const previous = fileStore.get(path);
      if (!previous) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, truncate '${path}'`), { code: 'ENOENT' });
      }
      const size = Math.max(0, Number(length) || 0);
      const next = new Uint8Array(size);
      next.set(previous.slice(0, Math.min(previous.byteLength, size)));
      setFileBytes(path, next);
    };
    const truncateDescriptorBytes = (entry: BrowserFileDescriptor, length = 0): void => {
      if (entry.kind !== 'file') {
        if (entry.kind === 'device') throw Object.assign(new Error('EINVAL: invalid argument, ftruncate'), { code: 'EINVAL' });
        throw Object.assign(new Error(`EROFS: read-only file system, ftruncate '${entry.path ?? ''}'`), { code: 'EROFS' });
      }
      const previous = descriptorBytes(entry);
      const size = Math.max(0, Number(length) || 0);
      const next = new Uint8Array(size);
      next.set(previous.slice(0, Math.min(previous.byteLength, size)));
      entry.bytes = next;
      if (entry.path && fileStore.has(entry.path)) setFileBytes(entry.path, next);
      if (entry.offset > size) entry.offset = size;
    };
    const realpathForEntry = (path: unknown): string => {
      const accessTarget = runtimeAccessTarget(path, 0, kernelDevices, procSnapshot);
      if (accessTarget?.kind === 'allowed') return accessTarget.path;
      if (accessTarget?.kind === 'denied') {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
      }
      const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
      if (readTarget?.kind === 'device-file' || readTarget?.kind === 'proc-file' || readTarget?.kind === 'proc-directory') {
        return readTarget.path;
      }
      if (readTarget?.kind === 'device-directory') return readTarget.path;
      if (readTarget?.kind === 'error') {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
      }
      const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
      if (workspaceFileAncestor(normalized) !== null) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${path}'`), { code: 'ENOTDIR' });
      }
      if (!fileSystemEntryExists(workspaceFilename(normalized, workspaceRoot))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
      }
      return workspaceFilename(normalized, workspaceRoot);
    };
    const copyEntrySync = (
      source: unknown,
      destination: unknown,
      options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } = {}
    ): void => {
      const copyTarget = runtimeCopyTarget(source, destination, kernelDevices, procSnapshot);
      if (copyTarget?.kind === 'file-copy') {
        fsApi.copyFileSync(source, destination);
        return;
      }
      if (copyTarget?.kind === 'error') {
        throw Object.assign(new Error(runtimeKernelCopyErrorMessage(String(source), String(destination), copyTarget)), {
          code: runtimeKernelCopyErrorCode(copyTarget.reason),
        });
      }

      const normalizedSource = normalizeWorkspaceEntryPath(source, cwdPath, true, workspacePathContext);
      const normalizedDestination = normalizeWorkspaceEntryPath(destination, cwdPath, true, workspacePathContext);
      const sourcePath = workspaceFilename(normalizedSource, workspaceRoot);
      const destinationPath = workspaceFilename(normalizedDestination, workspaceRoot);
      if (options.filter && !options.filter(sourcePath, destinationPath)) return;
      if (normalizedSource === normalizedDestination) {
        throw Object.assign(new Error(`${source} and dest cannot be the same ${destination}`), {
          code: 'ERR_FS_CP_EINVAL',
        });
      }

      const sourceBytes = fileStore.get(normalizedSource);
      if (sourceBytes) {
        if (directoryStore.has(normalizedDestination)) {
          throw Object.assign(new Error(`Cannot overwrite directory ${destination} with non-directory ${source}`), {
            code: 'ERR_FS_CP_NON_DIR_TO_DIR',
          });
        }
        if (fileStore.has(normalizedDestination) && options.force === false) {
          if (options.errorOnExist) {
            throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
          }
          return;
        }
        setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
        return;
      }

      const destinationExists = fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination);
      if (destinationExists && options.force === false) {
        if (options.errorOnExist) {
          throw Object.assign(new Error(`EEXIST: file already exists, cp '${destination}'`), { code: 'EEXIST' });
        }
        return;
      }

      const sourcePrefix = normalizedSource ? `${normalizedSource}/` : '';
      const descendantFiles = Array.from(fileStore.entries()).filter(([filePath]) => filePath.startsWith(sourcePrefix));
      const descendantDirectories = Array.from(directoryStore).filter((directoryPath) =>
        directoryPath === normalizedSource || directoryPath.startsWith(sourcePrefix)
      );
      if (!directoryStore.has(normalizedSource) && descendantFiles.length === 0 && descendantDirectories.length === 0) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${source}' -> '${destination}'`), { code: 'ENOENT' });
      }
      if (!options.recursive) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, cp '${source}'`), { code: 'EISDIR' });
      }
      if (normalizedDestination.startsWith(`${normalizedSource}/`)) {
        throw Object.assign(new Error(`Cannot copy ${source}/ to a subdirectory of self ${destination}`), {
          code: 'ERR_FS_CP_EINVAL',
        });
      }
      if (fileStore.has(normalizedDestination)) {
        throw Object.assign(new Error(`Cannot overwrite non-directory ${destination} with directory ${source}`), {
          code: 'ERR_FS_CP_DIR_TO_NON_DIR',
        });
      }

      const destinationDirectoryExisted = directoryStore.has(normalizedDestination);
      directoryStore.add(normalizedDestination);
      if (!destinationDirectoryExisted) emitDirectoryCreate(normalizedDestination);
      for (const directoryPath of descendantDirectories) {
        const relative = directoryPath === normalizedSource ? '' : directoryPath.slice(sourcePrefix.length);
        const nextDirectory = relative ? `${normalizedDestination}/${relative}` : normalizedDestination;
        if (options.filter && !options.filter(workspaceFilename(directoryPath, workspaceRoot), workspaceFilename(nextDirectory, workspaceRoot))) {
          continue;
        }
        const existed = directoryStore.has(nextDirectory);
        directoryStore.add(nextDirectory);
        if (!existed) emitDirectoryCreate(nextDirectory);
      }
      for (const [filePath, bytes] of descendantFiles) {
        const relative = filePath.slice(sourcePrefix.length);
        const nextPath = normalizedDestination ? `${normalizedDestination}/${relative}` : relative;
        if (options.filter && !options.filter(workspaceFilename(filePath, workspaceRoot), workspaceFilename(nextPath, workspaceRoot))) {
          continue;
        }
        setFileBytes(nextPath, new Uint8Array(bytes));
      }
    };
    const fsApi = {
      constants: fsConstants,
      F_OK: fsConstants.F_OK,
      R_OK: fsConstants.R_OK,
      W_OK: fsConstants.W_OK,
      X_OK: fsConstants.X_OK,
      O_RDONLY: fsConstants.O_RDONLY,
      O_WRONLY: fsConstants.O_WRONLY,
      O_RDWR: fsConstants.O_RDWR,
      O_CREAT: fsConstants.O_CREAT,
      O_EXCL: fsConstants.O_EXCL,
      O_TRUNC: fsConstants.O_TRUNC,
      O_APPEND: fsConstants.O_APPEND,
      S_IFMT: fsConstants.S_IFMT,
      S_IFREG: fsConstants.S_IFREG,
      S_IFDIR: fsConstants.S_IFDIR,
      S_IFLNK: fsConstants.S_IFLNK,
      COPYFILE_EXCL: fsConstants.COPYFILE_EXCL,
      COPYFILE_FICLONE: fsConstants.COPYFILE_FICLONE,
      COPYFILE_FICLONE_FORCE: fsConstants.COPYFILE_FICLONE_FORCE,
      accessSync: (path: unknown, mode = fsConstants.F_OK) => {
        assertFileSystemAccess(path, mode);
      },
      access: (path: unknown, mode?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof mode === 'function' ? mode : callback;
        try {
          assertFileSystemAccess(path, typeof mode === 'number' ? mode : fsConstants.F_OK);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      chmodSync: (path: unknown, mode: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          const stats = statForNormalizedPath(normalized);
          const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
          updateEntryMetadata(normalized, { mode: typeMode | (Number(mode) & 0o7777) });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      chmod: (path: unknown, mode: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.chmodSync(path, mode);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      chownSync: (path: unknown, uid: unknown, gid: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          updateEntryMetadata(normalized, { uid: Number(uid) || 0, gid: Number(gid) || 0 });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      chown: (path: unknown, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.chownSync(path, uid, gid);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      utimesSync: (path: unknown, atime: unknown, mtime: unknown) => {
        const normalized = metadataPathForEntry(path);
        if (normalized !== null) {
          updateEntryMetadata(normalized, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
          notifyMetadataMutation(normalized);
        }
        return undefined;
      },
      utimes: (path: unknown, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.utimesSync(path, atime, mtime);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      watch: (
        path: unknown,
        optionsOrListener?: { recursive?: boolean } | string | ((eventType: string, filename: string) => void),
        listener?: (eventType: string, filename: string) => void
      ) => {
        assertFileSystemAccess(path);
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const on = (event: string, callback: (...args: unknown[]) => void): void => {
          const next = listeners.get(event) ?? [];
          next.push(callback);
          listeners.set(event, next);
        };
        const watcher: BrowserFsWatcher = {
          path: normalized,
          recursive: typeof optionsOrListener === 'object' && optionsOrListener?.recursive === true,
          closed: false,
          listeners,
        };
        const initialListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        if (initialListener) on('change', initialListener as (...args: unknown[]) => void);
        fsWatchers.add(watcher);
        const api = {
          on: (event: string, callback: (...args: unknown[]) => void) => {
            on(event, callback);
            return api;
          },
          once: (event: string, callback: (...args: unknown[]) => void) => {
            const wrapped = (...args: unknown[]) => {
              const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped);
              listeners.set(event, next);
              callback(...args);
            };
            on(event, wrapped);
            return api;
          },
          close: () => {
            watcher.closed = true;
            fsWatchers.delete(watcher);
            for (const closeListener of listeners.get('close') ?? []) closeListener();
          },
        };
        return api;
      },
      watchFile: (
        path: unknown,
        optionsOrListener?: { interval?: number; persistent?: boolean } | ((curr: BrowserFileStat, prev: BrowserFileStat) => void),
        listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
      ) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        const changeListener = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
        if (!changeListener) {
          throw new TypeError('The "listener" argument must be of type function');
        }
        const watcher: BrowserFileWatcher = {
          path: normalized,
          listener: changeListener,
          previous: statForNormalizedPath(normalized) ?? missingFileStat(),
        };
        fsFileWatchers.add(watcher);
        const api = {
          ref: () => api,
          unref: () => api,
          close: () => {
            fsFileWatchers.delete(watcher);
          },
          on: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
            if (typeof nextListener === 'function') watcher.listener = nextListener;
            return api;
          },
          addListener: (_event: string, nextListener: (curr: BrowserFileStat, prev: BrowserFileStat) => void) => {
            if (typeof nextListener === 'function') watcher.listener = nextListener;
            return api;
          },
          removeListener: () => api,
        };
        return api;
      },
      unwatchFile: (
        path: unknown,
        listener?: (curr: BrowserFileStat, prev: BrowserFileStat) => void
      ) => {
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        for (const watcher of Array.from(fsFileWatchers)) {
          if (watcher.path === normalized && (!listener || watcher.listener === listener)) {
            fsFileWatchers.delete(watcher);
          }
        }
      },
      openSync: (path: unknown, flags: unknown = 'r') => {
        const parsed = parseOpenFlags(flags);
        const openTarget = runtimeOpenTarget(path, parsed, kernelDevices, procSnapshot);
        const fd = nextFd++;
        if (openTarget?.kind === 'error') {
          throw Object.assign(new Error(runtimeKernelOpenErrorMessage(String(path), openTarget)), {
            code: runtimeKernelOpenErrorCode(openTarget.reason),
          });
        }
        if (openTarget?.kind === 'device') {
          fileDescriptors.set(fd, {
            kind: 'device',
            device: openTarget.device,
            offset: 0,
            readable: openTarget.readable,
            writable: openTarget.writable,
            append: true,
          });
          return fd;
        }
        if (openTarget?.kind === 'proc-file') {
          fileDescriptors.set(fd, {
            kind: 'proc',
            path: openTarget.path,
            offset: 0,
            readable: openTarget.readable,
            writable: openTarget.writable,
            append: false,
          });
          return fd;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        const directoryPrefix = normalized ? `${normalized}/` : '';
        const isDirectory = directoryStore.has(normalized) || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(directoryPrefix));
        if (isDirectory) {
          if (parsed.writable || parsed.create || parsed.truncate) {
            throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
          }
          fileDescriptors.set(fd, {
            kind: 'directory',
            path: normalized,
            offset: 0,
            readable: true,
            writable: false,
            append: false,
          });
          return fd;
        }
        if (!fileStore.has(normalized)) {
          if (!parsed.create) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
          }
          assertWorkspaceFileWritePath(normalized, path, 'write', 'open');
          setFileBytes(normalized, new Uint8Array());
        } else if (parsed.exclusive) {
          throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
        } else if (parsed.truncate) {
          assertWorkspaceFileWritePath(normalized, path, 'truncate', 'open');
          setFileBytes(normalized, new Uint8Array());
        }
        fileDescriptors.set(fd, {
          kind: 'file',
          path: normalized,
          bytes: new Uint8Array(fileStore.get(normalized) ?? new Uint8Array()),
          offset: parsed.append ? fileStore.get(normalized)?.byteLength ?? 0 : 0,
          readable: parsed.readable,
          writable: parsed.writable,
          append: parsed.append,
        });
        return fd;
      },
      open: (path: unknown, flags?: unknown, modeOrCallback?: unknown, callback?: (error: Error | null, fd?: number) => void) => {
        const done = typeof flags === 'function'
          ? flags as (error: Error | null, fd?: number) => void
          : typeof modeOrCallback === 'function'
            ? modeOrCallback as (error: Error | null, fd?: number) => void
            : callback;
        const openFlags = typeof flags === 'function' || flags === undefined ? 'r' : flags;
        try {
          const fd = fsApi.openSync(path, openFlags);
          queueMicrotask(() => done?.(null, fd));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      closeSync: (fd: number) => {
        if (Number(fd) < 3) return undefined;
        if (!fileDescriptors.delete(Number(fd))) {
          throw Object.assign(new Error(`EBADF: bad file descriptor, close`), { code: 'EBADF' });
        }
        return undefined;
      },
      close: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.closeSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      readSync: (fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) => {
        const entry = fileDescriptor(fd);
        if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
        if (entry.kind === 'device') {
          const bytes = readDeviceBytes(entry.device ?? '/dev/stdin', Math.max(0, Math.min(length, buffer.byteLength - offset)));
          buffer.set(bytes, offset);
          return bytes.byteLength;
        }
        const source = descriptorBytes(entry);
        const start = typeof position === 'number' ? Math.max(0, position) : entry.offset;
        const count = Math.max(0, Math.min(length, source.byteLength - start, buffer.byteLength - offset));
        buffer.set(source.slice(start, start + count), offset);
        if (position === undefined || position === null) entry.offset = start + count;
        return count;
      },
      read: (
        fd: number,
        buffer: Uint8Array,
        offsetOrOptions?: number | { offset?: number; length?: number; position?: number | null } | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
        lengthOrCallback?: number | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
        positionOrCallback?: number | null | ((error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void),
        callback?: (error: Error | null, bytesRead?: number, buffer?: Uint8Array) => void
      ) => {
        const options = typeof offsetOrOptions === 'object' && offsetOrOptions !== null ? offsetOrOptions : undefined;
        const done = typeof offsetOrOptions === 'function'
          ? offsetOrOptions
          : typeof lengthOrCallback === 'function'
            ? lengthOrCallback
            : typeof positionOrCallback === 'function'
              ? positionOrCallback
              : callback;
        const offset: number = options?.offset ?? (typeof offsetOrOptions === 'number' ? offsetOrOptions : 0);
        const length: number = options?.length ?? (typeof lengthOrCallback === 'number' ? lengthOrCallback : buffer.byteLength - offset);
        let position: number | null | undefined;
        if (options !== undefined) {
          position = options.position;
        } else if (typeof positionOrCallback === 'number') {
          position = positionOrCallback;
        } else {
          position = null;
        }
        try {
          const bytesRead = fsApi.readSync(fd, buffer, offset, length, position);
          queueMicrotask(() => done?.(null, bytesRead, buffer));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, buffer));
        }
      },
      readvSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
        let bytesRead = 0;
        let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
        for (const buffer of buffers) {
          const count = fsApi.readSync(fd, buffer, 0, buffer.byteLength, nextPosition);
          bytesRead += count;
          if (typeof nextPosition === 'number') nextPosition += count;
          if (count === 0) break;
        }
        return bytesRead;
      },
      readv: (
        fd: number,
        buffers: Uint8Array[],
        positionOrCallback?: number | null | ((error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void),
        callback?: (error: Error | null, bytesRead?: number, buffers?: Uint8Array[]) => void
      ) => {
        const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
        const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
        try {
          const bytesRead = fsApi.readvSync(fd, buffers, position);
          queueMicrotask(() => done?.(null, bytesRead, buffers));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, buffers));
        }
      },
      writeSync: (fd: number, value: unknown, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null) => {
        let bytes: Uint8Array;
        let writePosition: number | null | undefined = position;
        if (typeof value === 'string') {
          bytes = BrowserBuffer.from(value, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined);
          writePosition = typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined;
        } else {
          const source = bytesFromNodeValue(value);
          const offset = typeof offsetOrPosition === 'number' ? offsetOrPosition : 0;
          const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : source.byteLength - offset;
          bytes = source.slice(offset, offset + length);
        }
        writeDescriptorBytes(fileDescriptor(fd), bytes, writePosition);
        return bytes.byteLength;
      },
      write: (
        fd: number,
        value: unknown,
        offsetOrPosition?: number | { offset?: number; length?: number; position?: number | null; encoding?: string } | ((error: Error | null, written?: number, value?: unknown) => void),
        lengthOrEncoding?: number | string | ((error: Error | null, written?: number, value?: unknown) => void),
        positionOrCallback?: number | null | ((error: Error | null, written?: number, value?: unknown) => void),
        callback?: (error: Error | null, written?: number, value?: unknown) => void
      ) => {
        const options = typeof offsetOrPosition === 'object' && offsetOrPosition !== null ? offsetOrPosition : undefined;
        const done = typeof offsetOrPosition === 'function'
          ? offsetOrPosition
          : typeof lengthOrEncoding === 'function'
            ? lengthOrEncoding
            : typeof positionOrCallback === 'function'
              ? positionOrCallback
              : callback;
        let writePosition: number | null | undefined;
        if (options !== undefined) {
          writePosition = options.position;
        } else if (typeof positionOrCallback === 'number') {
          writePosition = positionOrCallback;
        } else if (positionOrCallback === null) {
          writePosition = null;
        }
        try {
          const written = fsApi.writeSync(
            fd,
            value,
            options?.offset ?? (typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined),
            options?.length ?? options?.encoding ?? (typeof lengthOrEncoding === 'number' || typeof lengthOrEncoding === 'string' ? lengthOrEncoding : undefined),
            writePosition
          );
          queueMicrotask(() => done?.(null, written, value));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, value));
        }
      },
      writevSync: (fd: number, buffers: Uint8Array[], position?: number | null) => {
        let bytesWritten = 0;
        let nextPosition = typeof position === 'number' ? Math.max(0, position) : position;
        for (const buffer of buffers) {
          const written = fsApi.writeSync(fd, buffer, 0, buffer.byteLength, nextPosition);
          bytesWritten += written;
          if (typeof nextPosition === 'number') nextPosition += written;
        }
        return bytesWritten;
      },
      writev: (
        fd: number,
        buffers: Uint8Array[],
        positionOrCallback?: number | null | ((error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void),
        callback?: (error: Error | null, bytesWritten?: number, buffers?: Uint8Array[]) => void
      ) => {
        const done = typeof positionOrCallback === 'function' ? positionOrCallback : callback;
        const position = typeof positionOrCallback === 'function' ? undefined : positionOrCallback;
        try {
          const bytesWritten = fsApi.writevSync(fd, buffers, position);
          queueMicrotask(() => done?.(null, bytesWritten, buffers));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error, undefined, buffers));
        }
      },
      fstatSync: (fd: number, options?: BrowserStatOptions) => {
        const entry = fileDescriptor(fd);
        let stats: BrowserFileStat;
        if (entry.kind === 'device') {
          const statTarget = runtimeKernelStatTarget(entry.device ?? '/dev/stdin', kernelInfo, kernelDevices);
          stats = statTarget.kind === 'stat' ? statForKernelPath(statTarget.path, statTarget.stat) : missingFileStat();
        } else if (entry.kind === 'proc') {
          stats = statForKernelTarget(entry.path ?? '') ?? missingFileStat();
        } else if (entry.kind === 'directory') {
          stats = statForNormalizedPath(entry.path ?? '') ?? missingFileStat();
        } else {
          stats = entry.path && fileStore.has(entry.path)
            ? statForNormalizedPath(entry.path) ?? missingFileStat()
            : {
                ...missingFileStat(),
                size: descriptorBytes(entry).byteLength,
                isFile: () => true,
                isDirectory: () => false,
              };
        }
        return browserStatsResult(stats, options);
      },
      fstat: (
        fd: number,
        optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
        callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
      ) => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const stats = fsApi.fstatSync(fd, options);
          queueMicrotask(() => done?.(null, stats));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      fchmodSync: (fd: number, mode: unknown) => {
        const path = descriptorMetadataPath(fd, 'fchmod');
        if (path !== null) {
          const stats = statForNormalizedPath(path);
          const typeMode = stats?.isDirectory() ? 0o40000 : 0o100000;
          updateEntryMetadata(path, { mode: typeMode | (Number(mode) & 0o7777) });
          notifyMetadataMutation(path);
        }
        return undefined;
      },
      fchmod: (fd: number, mode: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fchmodSync(fd, mode);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      fchownSync: (fd: number, uid: unknown, gid: unknown) => {
        const path = descriptorMetadataPath(fd, 'fchown');
        if (path !== null) {
          updateEntryMetadata(path, { uid: Number(uid) || 0, gid: Number(gid) || 0 });
          notifyMetadataMutation(path);
        }
        return undefined;
      },
      fchown: (fd: number, uid: unknown, gid: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fchownSync(fd, uid, gid);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      futimesSync: (fd: number, atime: unknown, mtime: unknown) => {
        const path = descriptorMetadataPath(fd, 'futimes');
        if (path !== null) {
          updateEntryMetadata(path, { atimeMs: timeToMs(atime), mtimeMs: timeToMs(mtime) });
          notifyMetadataMutation(path);
        }
        return undefined;
      },
      futimes: (fd: number, atime: unknown, mtime: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.futimesSync(fd, atime, mtime);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      ftruncateSync: (fd: number, length = 0) => {
        const entry = fileDescriptor(fd);
        if (!entry.writable) throw Object.assign(new Error('EBADF: bad file descriptor, ftruncate'), { code: 'EBADF' });
        truncateDescriptorBytes(entry, length);
        return undefined;
      },
      ftruncate: (fd: number, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
        try {
          fsApi.ftruncateSync(fd, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      fsyncSync: (fd: number) => {
        fileDescriptor(fd);
        return undefined;
      },
      fsync: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fsyncSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      fdatasyncSync: (fd: number) => {
        fileDescriptor(fd);
        return undefined;
      },
      fdatasync: (fd: number, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.fdatasyncSync(fd);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      createReadStream: (path: unknown, options?: string | { autoClose?: boolean; encoding?: string; end?: number; fd?: number; start?: number } | null) => {
        const optionFd = typeof options === 'object' && typeof options?.fd === 'number' ? options.fd : null;
        const readTarget = optionFd === null ? runtimeFileReadTarget(path, kernelDevices, procSnapshot) : null;
        const requestedEncoding = typeof options === 'string' ? options : options?.encoding;
        let sourceBytes: Uint8Array | undefined;
        if (readTarget?.kind === 'device-file') sourceBytes = utf8Bytes(readDevice(readTarget.path));
        else if (readTarget?.kind === 'proc-file') sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, readTarget.path, kernelInfo));
        else if (readTarget?.kind === 'error') {
          throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
        } else if (optionFd !== null) {
          const entry = fileDescriptor(optionFd);
          if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' });
          if (typeof options === 'object' && typeof options?.start === 'number') {
            sourceBytes = descriptorBytes(entry);
          } else {
            sourceBytes = readDescriptorFileBytes(optionFd);
          }
        } else {
          const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
          if (workspaceFileAncestor(normalized) !== null) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: 'ENOTDIR' });
          }
          if (isWorkspaceDirectoryPath(normalized)) {
            throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
          }
          sourceBytes = fileStore.get(normalized);
        }
        if (!sourceBytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        const requestedStart = typeof options === 'object' ? assertStreamRangeInteger('start', options?.start) : undefined;
        const requestedEnd = typeof options === 'object' ? assertStreamRangeInteger('end', options?.end) : undefined;
        if (requestedStart !== undefined && requestedEnd !== undefined && requestedEnd < requestedStart) {
          throw Object.assign(new RangeError('The value of "start" is out of range.'), { code: 'ERR_OUT_OF_RANGE' });
        }
        const start = requestedStart ?? 0;
        const endInclusive = requestedEnd ?? sourceBytes.byteLength - 1;
        const autoClose = typeof options === 'object' && options?.autoClose === false ? false : true;
        return createReadableStream(
          sourceBytes.slice(start, Math.max(start, endInclusive + 1)),
          requestedEncoding,
          autoClose && optionFd !== null ? () => fsApi.closeSync(optionFd) : undefined
        );
      },
      createWriteStream: createWritableStream,
      readFileSync: (path: unknown, encoding?: string | { encoding?: string }) => {
        const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
        if (typeof path === 'number') {
          const bytes = BrowserBuffer.from(readDescriptorFileBytes(path));
          return typeof requestedEncoding === 'string' ? bytes.toString(requestedEncoding) : bytes;
        }
        const readTarget = runtimeFileReadTarget(path, kernelDevices, procSnapshot);
        if (readTarget?.kind === 'device-file') {
          const contents = readDevice(readTarget.path);
          if (typeof requestedEncoding === 'string') return BrowserBuffer.from(contents).toString(requestedEncoding);
          return BrowserBuffer.from(contents);
        }
        if (readTarget?.kind === 'proc-file') {
          const contents = browserProcFileContents(procSnapshot, readTarget.path, kernelInfo);
          if (typeof requestedEncoding === 'string') return BrowserBuffer.from(contents).toString(requestedEncoding);
          return BrowserBuffer.from(contents);
        }
        if (readTarget?.kind === 'error') {
          throwRuntimeReadTargetError(readTarget, runtimeKernelFileReadFsErrorMessage(String(path), readTarget));
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        if (workspaceFileAncestor(normalized) !== null) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), { code: 'ENOTDIR' });
        }
        if (isWorkspaceDirectoryPath(normalized)) {
          throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${path}'`), { code: 'EISDIR' });
        }
        const bytes = fileStore.get(normalized);
        if (!bytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        if (typeof requestedEncoding === 'string') {
          return BrowserBuffer.from(bytes).toString(requestedEncoding);
        }
        return BrowserBuffer.from(bytes);
      },
      readFile: (path: unknown, encodingOrCallback?: string | { encoding?: string } | ((error: Error | null, data?: unknown) => void), callback?: (error: Error | null, data?: unknown) => void) => {
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        try {
          const data = fsApi.readFileSync(path, typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback);
          queueMicrotask(() => done?.(null, data));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      writeFileSync: (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        if (typeof path === 'number') {
          writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options));
          return;
        }
        const writeTarget = runtimeWriteTarget(path, kernelDevices);
        if (writeTarget?.kind === 'error') {
          throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
        }
        if (writeTarget?.kind === 'device') {
          writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
          return;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        assertWorkspaceFileWritePath(normalized, path, 'write', 'open');
        setFileBytes(normalized, bytesFromFsWriteValue(value, options));
      },
      writeFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.writeFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      appendFileSync: (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        if (typeof path === 'number') {
          writeDescriptorFileBytes(path, bytesFromFsWriteValue(value, options), true);
          return;
        }
        const writeTarget = runtimeWriteTarget(path, kernelDevices);
        if (writeTarget?.kind === 'error') {
          throwRuntimeWriteTargetError(writeTarget, runtimeKernelWriteFsErrorMessage(String(path), writeTarget));
        }
        if (writeTarget?.kind === 'device') {
          writeDevice(writeTarget.device, textFromBytes(bytesFromFsWriteValue(value, options)));
          return;
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        assertWorkspaceFileWritePath(normalized, path, 'append', 'open');
        const previous = fileStore.get(normalized) ?? new Uint8Array();
        const next = bytesFromFsWriteValue(value, options);
        const combined = new Uint8Array(previous.byteLength + next.byteLength);
        combined.set(previous, 0);
        combined.set(next, previous.byteLength);
        setFileBytes(normalized, combined);
      },
      appendFile: (path: unknown, value: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.appendFileSync(path, value, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      copyFileSync: (source: unknown, destination: unknown, mode = 0) => {
        const copyTarget = runtimeFileCopyTarget(source, destination, kernelDevices, procSnapshot);
        if (copyTarget?.kind === 'error' && copyTarget.side === 'destination') {
          throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
            code: runtimeKernelFileCopyErrorCode(copyTarget),
          });
        }
        let sourceBytes: Uint8Array | undefined;
        const sourceTarget = copyTarget?.kind === 'virtual-source' || copyTarget?.kind === 'device-destination'
          ? copyTarget.source
          : runtimeFileReadTarget(source, kernelDevices, procSnapshot);
        if (sourceTarget?.kind === 'device-file') sourceBytes = utf8Bytes(readDevice(sourceTarget.path));
        else if (sourceTarget?.kind === 'proc-file') sourceBytes = utf8Bytes(browserProcFileContents(procSnapshot, sourceTarget.path, kernelInfo));
        else if (copyTarget?.kind === 'error' && copyTarget.side === 'source') {
          throw Object.assign(new Error(runtimeKernelFileCopyErrorMessage(String(source), String(destination), copyTarget)), {
            code: runtimeKernelFileCopyErrorCode(copyTarget),
          });
        } else if (sourceTarget?.kind === 'error') {
          throwRuntimeReadTargetError(sourceTarget, sourceTarget.reason === 'is-directory'
            ? `EISDIR: illegal operation on a directory, copyfile '${source}' -> '${destination}'`
            : sourceTarget.reason === 'permission-denied'
              ? `EBADF: bad file descriptor, copyfile '${source}' -> '${destination}'`
              : `ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`);
        } else sourceBytes = fileStore.get(assertSafeWorkspaceFilePath(source, cwdPath, workspacePathContext));
        if (!sourceBytes) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${source}' -> '${destination}'`), { code: 'ENOENT' });
        }
        if (copyTarget?.kind === 'device-destination') {
          writeDevice(copyTarget.device, textFromBytes(sourceBytes));
          return;
        }
        const normalizedDestination = assertSafeWorkspaceFilePath(destination, cwdPath, workspacePathContext);
        assertWorkspaceFileWritePath(normalizedDestination, destination, 'copy', 'copyfile');
        if ((Number(mode) & fsConstants.COPYFILE_EXCL) !== 0 && fileSystemEntryExists(workspaceFilename(normalizedDestination, workspaceRoot))) {
          throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`), { code: 'EEXIST' });
        }
        setFileBytes(normalizedDestination, new Uint8Array(sourceBytes));
      },
      copyFile: (source: unknown, destination: unknown, modeOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof modeOrCallback === 'function' ? modeOrCallback : callback;
        try {
          fsApi.copyFileSync(source, destination, typeof modeOrCallback === 'number' ? modeOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      linkSync: (existingPath: unknown, newPath: unknown) => {
        const linkTarget = runtimeLinkTarget(existingPath, newPath, kernelDevices);
        if (linkTarget?.kind === 'error') {
          throwRuntimeLinkTargetError(
            linkTarget,
            runtimeKernelMutationFsErrorMessage(String(existingPath), linkTarget, 'link', String(newPath))
          );
        }
        const normalizedSource = assertSafeWorkspaceFilePath(existingPath, cwdPath, workspacePathContext);
        const normalizedDestination = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
        const bytes = fileStore.get(normalizedSource);
        if (!bytes) {
          const sourceIsDirectory = directoryStore.has(normalizedSource)
            || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedSource}/`));
          if (sourceIsDirectory) {
            throw Object.assign(new Error(`EPERM: operation not permitted, link '${existingPath}' -> '${newPath}'`), { code: 'EPERM' });
          }
          throw Object.assign(new Error(`ENOENT: no such file or directory, link '${existingPath}' -> '${newPath}'`), { code: 'ENOENT' });
        }
        assertReadonlyFilePath(normalizedSource, 'link');
        if (fileStore.has(normalizedDestination) || directoryStore.has(normalizedDestination)) {
          throw Object.assign(new Error(`EEXIST: file already exists, link '${existingPath}' -> '${newPath}'`), { code: 'EEXIST' });
        }
        assertWorkspaceFileWritePath(normalizedDestination, newPath, 'link');
        fileStore.set(normalizedDestination, bytes);
        touchEntryMetadata(normalizedDestination);
        linkPaths(normalizedSource, normalizedDestination);
        syncTextModule(normalizedDestination, bytes);
        cache.delete(normalizedDestination);
        io.fileChange(bytesToRuntimeFile(normalizedDestination, bytes), 'live');
        notifyFsWatchers('change', normalizedDestination);
        notifyWatchFileWatchers(normalizedDestination);
      },
      link: (existingPath: unknown, newPath: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.linkSync(existingPath, newPath);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      symlinkSync: (_target: unknown, linkPath: unknown) => {
        const symlinkTarget = runtimeSymlinkTarget(linkPath, kernelDevices);
        if (symlinkTarget?.kind === 'error') {
          throwRuntimeSymlinkTargetError(symlinkTarget, runtimeKernelMutationFsErrorMessage(String(linkPath), symlinkTarget, 'symlink'));
        }
        throw Object.assign(new Error(`ENOSYS: function not implemented, symlink '${linkPath}'`), { code: 'ENOSYS' });
      },
      symlink: (target: unknown, linkPath: unknown, typeOrCallback?: string | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof typeOrCallback === 'function' ? typeOrCallback : callback;
        try {
          fsApi.symlinkSync(target, linkPath);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      readlinkSync: (path: unknown, _options?: string | { encoding?: string | null } | null) => {
        const readTarget = runtimeReadTarget(path, kernelDevices, procSnapshot);
        if (readTarget?.kind && readTarget.kind !== 'workspace') {
          throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL' });
        }
        assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL' });
      },
      readlink: (path: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, linkString?: unknown) => void), callback?: (error: Error | null, linkString?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const linkString = fsApi.readlinkSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, linkString));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      cpSync: (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
        copyEntrySync(source, destination, options);
        return undefined;
      },
      cp: (source: unknown, destination: unknown, optionsOrCallback?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.cpSync(source, destination, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      renameSync: (oldPath: unknown, newPath: unknown) => {
        const renameTarget = runtimeRenameTarget(oldPath, newPath, kernelDevices);
        if (renameTarget?.kind === 'error') {
          throwRuntimeRenameTargetError(
            renameTarget,
            runtimeKernelMutationFsErrorMessage(String(oldPath), renameTarget, 'rename', String(newPath))
          );
        }
        const normalizedOldPath = assertSafeWorkspaceFilePath(oldPath, cwdPath, workspacePathContext);
        const normalizedNewPath = assertSafeWorkspaceFilePath(newPath, cwdPath, workspacePathContext);
        if (normalizedOldPath === normalizedNewPath) {
          const prefix = normalizedOldPath ? `${normalizedOldPath}/` : '';
          if (
            fileStore.has(normalizedOldPath) ||
            directoryStore.has(normalizedOldPath) ||
            Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix)) ||
            Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(prefix))
          ) {
            return;
          }
          throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOENT' });
        }
        const bytes = fileStore.get(normalizedOldPath);
        if (bytes) {
          assertReadonlyFilePath(normalizedOldPath, 'move');
          assertWorkspaceFileWritePath(normalizedNewPath, newPath, 'move', 'rename');
          fileStore.delete(normalizedOldPath);
          moveOpenFileDescriptorPath(normalizedOldPath, normalizedNewPath);
          moveHardLinkPath(normalizedOldPath, normalizedNewPath);
          modules.delete(normalizedOldPath);
          cache.delete(normalizedOldPath);
          deleteEntryMetadata(normalizedOldPath);
          io.fileChange({ path: normalizedOldPath, deleted: true }, 'live');
          notifyFsWatchers('rename', normalizedOldPath);
          notifyWatchFileWatchers(normalizedOldPath);
          setFileBytes(normalizedNewPath, bytes);
          notifyFsWatchers('rename', normalizedNewPath);
          return;
        }

        const oldPrefix = normalizedOldPath ? `${normalizedOldPath}/` : '';
        const sourceDirectories = Array.from(directoryStore)
          .filter((directoryPath) => directoryPath === normalizedOldPath || directoryPath.startsWith(oldPrefix))
          .sort((left, right) => left.localeCompare(right));
        const sourceFiles = Array.from(fileStore.entries())
          .filter(([filePath]) => filePath.startsWith(oldPrefix))
          .sort(([left], [right]) => left.localeCompare(right));
        if (sourceDirectories.length === 0 && sourceFiles.length === 0) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOENT' });
        }
        for (const [filePath] of sourceFiles) {
          assertReadonlyFilePath(filePath, 'move');
        }
        assertReadonlyFilePath(normalizedNewPath, 'move');
        assertWorkspaceParentDirectoryPath(normalizedNewPath, newPath, 'rename');
        if (fileStore.has(normalizedNewPath)) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, rename '${oldPath}' -> '${newPath}'`), { code: 'ENOTDIR' });
        }

        const existingDestinationFiles = fileStore.has(normalizedNewPath)
          || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(`${normalizedNewPath}/`));
        const existingDestinationDirectories = directoryStore.has(normalizedNewPath)
          || Array.from(directoryStore).some((directoryPath) => directoryPath.startsWith(`${normalizedNewPath}/`));
        if (existingDestinationFiles || existingDestinationDirectories) {
          throw Object.assign(new Error(`EEXIST: file already exists, rename '${oldPath}' -> '${newPath}'`), { code: 'EEXIST' });
        }

        for (const [filePath] of sourceFiles) {
          fileStore.delete(filePath);
          const relative = filePath.slice(oldPrefix.length);
          const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
          moveOpenFileDescriptorPath(filePath, nextPath);
          moveHardLinkPath(filePath, nextPath);
          modules.delete(filePath);
          cache.delete(filePath);
          deleteEntryMetadata(filePath);
          io.fileChange({ path: filePath, deleted: true }, 'live');
          notifyFsWatchers('rename', filePath);
          notifyWatchFileWatchers(filePath);
        }
        for (const directoryPath of [...sourceDirectories].sort((left, right) => right.length - left.length || right.localeCompare(left))) {
          directoryStore.delete(directoryPath);
          deleteEntryMetadata(directoryPath);
          emitDirectoryDelete(directoryPath);
          notifyDirectoryMutation(directoryPath);
        }
        for (const directoryPath of sourceDirectories) {
          const relative = directoryPath === normalizedOldPath ? '' : directoryPath.slice(oldPrefix.length);
          const nextDirectory = relative ? `${normalizedNewPath}/${relative}` : normalizedNewPath;
          const existed = directoryStore.has(nextDirectory);
          directoryStore.add(nextDirectory);
          if (!entryMetadata.has(nextDirectory)) touchEntryMetadata(nextDirectory);
          if (!existed) {
            emitDirectoryCreate(nextDirectory);
            notifyDirectoryMutation(nextDirectory);
          }
        }
        for (const [filePath, fileBytes] of sourceFiles) {
          const relative = filePath.slice(oldPrefix.length);
          const nextPath = normalizedNewPath ? `${normalizedNewPath}/${relative}` : relative;
          setFileBytes(nextPath, fileBytes);
          notifyFsWatchers('rename', nextPath);
        }
      },
      rename: (oldPath: unknown, newPath: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.renameSync(oldPath, newPath);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      unlinkSync: deleteFile,
      unlink: (path: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.unlinkSync(path);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
      rmSync: (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
        try {
          const removeTarget = runtimeRemoveTarget(path, kernelDevices);
          if (removeTarget?.kind === 'error') {
            throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, 'rm'));
          }
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          if (fileStore.has(normalized)) {
            deleteFile(path);
            return;
          }
          const prefix = normalized ? `${normalized}/` : '';
          assertWorkspaceParentDirectoryPath(normalized, path, 'rm');
          const descendantFiles = Array.from(fileStore.keys()).filter((filePath) => filePath.startsWith(prefix));
          const descendantDirectories = Array.from(directoryStore).filter((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
          if (directoryStore.has(normalized) || descendantFiles.length > 0 || descendantDirectories.length > 0) {
            if (!options?.recursive) {
              throw Object.assign(new Error(`ERR_FS_EISDIR: path is a directory, rm '${path}'`), { code: 'ERR_FS_EISDIR' });
            }
            for (const filePath of descendantFiles) {
              assertReadonlyFilePath(filePath, 'delete');
            }
            for (const filePath of descendantFiles) {
              fileStore.delete(filePath);
              modules.delete(filePath);
              cache.delete(filePath);
              deleteEntryMetadata(filePath);
              io.fileChange({ path: filePath, deleted: true }, 'live');
              notifyFsWatchers('rename', filePath);
              notifyWatchFileWatchers(filePath);
            }
            for (const directoryPath of Array.from(directoryStore)) {
              if (directoryPath === normalized || directoryPath.startsWith(prefix)) {
                directoryStore.delete(directoryPath);
                deleteEntryMetadata(directoryPath);
                emitDirectoryDelete(directoryPath);
                notifyDirectoryMutation(directoryPath);
              }
            }
            return;
          }
          if (!options?.force) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), { code: 'ENOENT' });
          }
        } catch (error) {
          if (options?.force && (error as { code?: unknown }).code === 'ENOENT') return;
          throw error;
        }
      },
      rm: (path: unknown, optionsOrCallback?: { force?: boolean; recursive?: boolean } | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          fsApi.rmSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      existsSync: (path: unknown) => {
        try {
          const accessTarget = runtimeAccessTarget(path, fsConstants.F_OK, kernelDevices, procSnapshot);
          if (accessTarget?.kind === 'allowed') return true;
          if (accessTarget?.kind === 'denied') return false;
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          const prefix = normalized ? `${normalized}/` : '';
          return fileStore.has(normalized)
            || directoryStore.has(normalized)
            || Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix));
        } catch {
          return false;
        }
      },
      exists: (path: unknown, callback?: (exists: boolean) => void) => {
        queueMicrotask(() => callback?.(fsApi.existsSync(path)));
      },
      readdirSync: (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => {
        const directoryTarget = runtimeDirectoryTarget(path, kernelDevices, procSnapshot);
        const withFileTypes = typeof options === 'object' && options?.withFileTypes === true;
        const makeDirent = (
          name: string,
          type: 'file' | 'directory',
          parentPath: string,
          characterDevice = false
        ) => ({
          name,
          path: parentPath,
          parentPath,
          isBlockDevice: () => false,
          isCharacterDevice: () => characterDevice,
          isDirectory: () => type === 'directory',
          isFIFO: () => false,
          isFile: () => type === 'file',
          isSocket: () => false,
          isSymbolicLink: () => false,
        });
        if (directoryTarget?.kind === 'directory') {
          const names = directoryTarget.entries.map((entry) => entry.name);
          if (!withFileTypes) return names;
          return directoryTarget.entries.map((entry) => makeDirent(
            entry.name,
            entry.kind === 'directory' ? 'directory' : 'file',
            directoryTarget.path,
            directoryTarget.path === '/dev' && entry.kind === 'file'
          ));
        }
        if (directoryTarget?.kind === 'error') {
          throwRuntimeDirectoryTargetError(directoryTarget, directoryTarget.reason === 'not-directory'
            ? `ENOTDIR: not a directory, scandir '${path}'`
            : `ENOENT: no such file or directory, scandir '${path}'`);
        }
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (workspaceFileAncestor(normalized) !== null || fileStore.has(normalized)) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, scandir '${path}'`), { code: 'ENOTDIR' });
        }
        const prefix = normalized ? `${normalized}/` : '';
        const recursive = typeof options === 'object' && options?.recursive === true;
        const makeWorkspaceDirent = (name: string, type: 'file' | 'directory', parentPath = normalized) =>
          makeDirent(name, type, workspaceFilename(parentPath, workspaceRoot));
        if (recursive) {
          const entries = new Map<string, 'file' | 'directory'>();
          for (const directoryPath of directoryStore) {
            if (directoryPath === normalized || !directoryPath.startsWith(prefix)) continue;
            const rest = directoryPath.slice(prefix.length);
            if (rest) entries.set(rest, 'directory');
          }
          for (const filePath of fileStore.keys()) {
            if (!filePath.startsWith(prefix)) continue;
            const rest = filePath.slice(prefix.length);
            if (rest) entries.set(rest, 'file');
          }
          if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
          }
          const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
          if (!withFileTypes) return sortedEntries.map(([name]) => name);
          return sortedEntries.map(([relativePath, type]) => {
            const parts = relativePath.split('/');
            const name = parts.pop() ?? relativePath;
            const parentPath = parts.length === 0
              ? normalized
              : normalized
                ? `${normalized}/${parts.join('/')}`
                : parts.join('/');
            return makeWorkspaceDirent(name, type, parentPath);
          });
        }
        const entries = new Map<string, 'file' | 'directory'>();
        for (const filePath of fileStore.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (!rest) continue;
          const [name, ...remaining] = rest.split('/');
          if (!name) continue;
          entries.set(name, remaining.length > 0 ? 'directory' : 'file');
        }
        for (const directoryPath of directoryStore) {
          if (!directoryPath.startsWith(prefix)) continue;
          const rest = directoryPath.slice(prefix.length);
          if (!rest) continue;
          const name = rest.split('/')[0] ?? rest;
          if (!entries.has(name)) entries.set(name, 'directory');
        }
        if (entries.size === 0 && !fileStore.has(normalized) && !directoryStore.has(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
        }
        const sortedEntries = Array.from(entries.entries()).sort(([left], [right]) => left.localeCompare(right));
        if (!withFileTypes) return sortedEntries.map(([name]) => name);
        return sortedEntries.map(([name, type]) => makeWorkspaceDirent(name, type));
      },
      readdir: (path: unknown, optionsOrCallback?: { withFileTypes?: boolean; recursive?: boolean } | string | null | ((error: Error | null, files?: unknown) => void), callback?: (error: Error | null, files?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const entries = fsApi.readdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, entries));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      opendirSync: (path: unknown) => {
        const entries = fsApi.readdirSync(path, { withFileTypes: true }) as Array<{
          name: string;
          isFile: () => boolean;
          isDirectory: () => boolean;
          isSymbolicLink: () => boolean;
        }>;
        let index = 0;
        let closed = false;
        const assertOpen = (): void => {
          if (closed) throw Object.assign(new Error('ERR_DIR_CLOSED: Directory handle was closed'), { code: 'ERR_DIR_CLOSED' });
        };
        const dir = {
          path: fsApi.realpathSync(path),
          readSync: () => {
            assertOpen();
            return entries[index++] ?? null;
          },
          read: (callback?: (error: Error | null, dirent?: unknown) => void) => {
            try {
              const entry = dir.readSync();
              queueMicrotask(() => callback?.(null, entry));
            } catch (error) {
              queueMicrotask(() => callback?.(error as Error));
            }
          },
          closeSync: () => {
            closed = true;
          },
          close: (callback?: (error?: Error | null) => void) => {
            closed = true;
            queueMicrotask(() => callback?.(null));
          },
          async *[Symbol.asyncIterator]() {
            while (true) {
              const entry = dir.readSync();
              if (entry === null) break;
              yield entry;
            }
          },
        };
        return dir;
      },
      opendir: (path: unknown, optionsOrCallback?: unknown, callback?: (error: Error | null, dir?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback as (error: Error | null, dir?: unknown) => void : callback;
        try {
          const dir = fsApi.opendirSync(path);
          queueMicrotask(() => done?.(null, dir));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      statSync: (path: unknown, options?: BrowserStatOptions) => {
        const kernelStats = statForKernelTarget(path, options);
        if (kernelStats === undefined) return undefined;
        let stats = kernelStats;
        if (stats === null) {
          const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
          if (workspaceFileAncestor(normalized) !== null) {
            if (options?.throwIfNoEntry === false) return undefined;
            throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${path}'`), { code: 'ENOTDIR' });
          }
          stats = statForNormalizedPath(normalized);
        }
        if (!stats) {
          if (options?.throwIfNoEntry === false) return undefined;
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
        }
        return browserStatsResult(stats, options);
      },
      lstatSync: (path: unknown, options?: BrowserStatOptions) => fsApi.statSync(path, options),
      statfsSync: (path: unknown, options?: { bigint?: boolean }) => {
        fsApi.statSync(path);
        return browserFileSystemStat(Boolean(options?.bigint));
      },
      stat: (
        path: unknown,
        optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
        callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
      ) => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const stats = fsApi.statSync(path, options);
          queueMicrotask(() => done?.(null, stats));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      lstat: (
        path: unknown,
        optionsOrCallback?: BrowserStatOptions | ((error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void),
        callback?: (error: Error | null, stats?: { size: number | bigint; isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean }) => void
      ) => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const stats = fsApi.lstatSync(path, options);
          if (stats === undefined && options?.throwIfNoEntry === false) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
          }
          queueMicrotask(() => done?.(null, stats));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      statfs: (
        path: unknown,
        optionsOrCallback?: { bigint?: boolean } | ((error: Error | null, stats?: BrowserFileSystemStat) => void),
        callback?: (error: Error | null, stats?: BrowserFileSystemStat) => void
      ) => {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const stats = fsApi.statfsSync(path, options);
          queueMicrotask(() => done?.(null, stats));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      realpathSync: (path: unknown, options?: string | { encoding?: string | null } | null) => {
        const resolved = realpathForEntry(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding === 'buffer' ? BrowserBuffer.from(resolved) : resolved;
      },
      realpath: (path: unknown, optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, resolvedPath?: unknown) => void), callback?: (error: Error | null, resolvedPath?: unknown) => void) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const resolved = fsApi.realpathSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, resolved));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      truncateSync: (path: unknown, length = 0) => {
        const truncateTarget = runtimeTruncateTarget(path, kernelDevices);
        if (truncateTarget?.kind === 'error') {
          throwRuntimeTruncateTargetError(truncateTarget, runtimeKernelMutationFsErrorMessage(String(path), truncateTarget, 'truncate'));
        }
        const normalized = assertSafeWorkspaceFilePath(path, cwdPath, workspacePathContext);
        assertWorkspaceFileWritePath(normalized, path, 'truncate');
        truncateFileBytes(normalized, length);
        return undefined;
      },
      truncate: (path: unknown, lengthOrCallback?: number | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const done = typeof lengthOrCallback === 'function' ? lengthOrCallback : callback;
        try {
          fsApi.truncateSync(path, typeof lengthOrCallback === 'number' ? lengthOrCallback : 0);
          queueMicrotask(() => done?.(null));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      mkdirSync: (path: unknown, options?: { recursive?: boolean }) => {
        const mkdirTarget = runtimeMkdirTarget(path, kernelDevices);
        if (mkdirTarget?.kind === 'error') {
          throwRuntimeMkdirTargetError(mkdirTarget, runtimeKernelMutationFsErrorMessage(String(path), mkdirTarget, 'mkdir'));
        }
        const rawPath = workspacePathInputToString(path).replace(/\\/g, '/');
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        if (!normalized) return undefined;
        assertReadonlyFilePath(normalized, 'mkdir');
        const parent = dirname(normalized);
        const parentPath = parent === '' ? '' : parent;
        const parts = normalized.split('/');
        for (let index = 1; index < parts.length; index += 1) {
          const directoryPath = parts.slice(0, index).join('/');
          if (fileStore.has(directoryPath)) {
            throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${path}'`), { code: 'ENOTDIR' });
          }
        }
        if (fileStore.has(normalized)) {
          throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
        }
        if (directoryStore.has(normalized)) {
          if (!options?.recursive) {
            throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
          }
          return undefined;
        }
        if (!options?.recursive && parentPath && !directoryStore.has(parentPath)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${path}'`), { code: 'ENOENT' });
        }
        const start = options?.recursive ? 1 : parts.length;
        let firstCreated: string | undefined;
        for (let index = start; index <= parts.length; index += 1) {
          const directoryPath = parts.slice(0, index).join('/');
          const existed = directoryStore.has(directoryPath);
          directoryStore.add(directoryPath);
          if (!entryMetadata.has(directoryPath)) touchEntryMetadata(directoryPath);
          if (!existed) {
            firstCreated ??= directoryPath;
            emitDirectoryCreate(directoryPath);
            notifyDirectoryMutation(directoryPath);
          }
        }
        if (!options?.recursive || firstCreated === undefined) return undefined;
        if (rawPath.startsWith('/')) return workspaceFilename(firstCreated, workspaceRoot);
        const relativeFirstCreated = relativeWorkspacePath(cwdPath, firstCreated);
        return rawPath.startsWith('./') && !relativeFirstCreated.startsWith('.')
          ? `./${relativeFirstCreated}`
          : relativeFirstCreated;
      },
      mkdir: (
        path: unknown,
        optionsOrCallback?: { recursive?: boolean } | ((error?: Error | null, path?: string) => void),
        callback?: (error?: Error | null, path?: string) => void
      ) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const created = fsApi.mkdirSync(path, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, created));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      mkdtempSync: (prefix: unknown, options?: string | { encoding?: string | null } | null) => {
        const rawPrefix = workspacePathInputToString(prefix);
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          mkdtempCounter += 1;
          const suffix = mkdtempCounter.toString(36).padStart(6, '0').slice(-6);
          const candidate = `${rawPrefix}${suffix}`;
          const normalized = normalizeWorkspaceEntryPath(candidate, cwdPath, false, workspacePathContext);
          if (fileStore.has(normalized) || directoryStore.has(normalized)) continue;
          fsApi.mkdirSync(candidate);
          const encoding = typeof options === 'string' ? options : options?.encoding;
          const result = rawPrefix.startsWith('/') ? workspaceFilename(normalized, workspaceRoot) : candidate;
          return encoding === 'buffer' ? BrowserBuffer.from(result) : result;
        }
        throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), { code: 'EEXIST' });
      },
      mkdtemp: (
        prefix: unknown,
        optionsOrCallback?: string | { encoding?: string | null } | null | ((error: Error | null, directory?: unknown) => void),
        callback?: (error: Error | null, directory?: unknown) => void
      ) => {
        const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        try {
          const directory = fsApi.mkdtempSync(prefix, typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback);
          queueMicrotask(() => done?.(null, directory));
        } catch (error) {
          queueMicrotask(() => done?.(error as Error));
        }
      },
      rmdirSync: (path: unknown) => {
        const removeTarget = runtimeRemoveTarget(path, kernelDevices);
        if (removeTarget?.kind === 'error') {
          throwRuntimeRemoveTargetError(removeTarget, runtimeKernelMutationFsErrorMessage(String(path), removeTarget, 'rmdir'));
        }
        const normalized = normalizeWorkspaceEntryPath(path, cwdPath, true, workspacePathContext);
        assertWorkspaceParentDirectoryPath(normalized, path, 'rmdir');
        if (fileStore.has(normalized)) {
          throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${path}'`), { code: 'ENOTDIR' });
        }
        const prefix = normalized ? `${normalized}/` : '';
        const hasChildren = Array.from(fileStore.keys()).some((filePath) => filePath.startsWith(prefix))
          || Array.from(directoryStore).some((directoryPath) => directoryPath !== normalized && directoryPath.startsWith(prefix));
        if (hasChildren) {
          throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: 'ENOTEMPTY' });
        }
        if (!directoryStore.delete(normalized)) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, rmdir '${path}'`), { code: 'ENOENT' });
        }
        deleteEntryMetadata(normalized);
        emitDirectoryDelete(normalized);
        notifyDirectoryMutation(normalized);
      },
      rmdir: (path: unknown, callback?: (error?: Error | null) => void) => {
        try {
          fsApi.rmdirSync(path);
          queueMicrotask(() => callback?.(null));
        } catch (error) {
          queueMicrotask(() => callback?.(error as Error));
        }
      },
    };
    const fileHandleTarget = (path: unknown): unknown => (
      typeof path === 'object' &&
        path !== null &&
        !(path instanceof URL) &&
        typeof (path as { fd?: unknown }).fd === 'number'
        ? (path as { fd: number }).fd
        : path
    );
    const fsPromisesApi = {
      constants: fsConstants,
      access: async (path: unknown, mode = fsConstants.F_OK) => {
        fsApi.accessSync(path, mode);
      },
      open: async (path: unknown, flags: unknown = 'r') => {
        const fd = fsApi.openSync(path, flags);
        let closed = false;
        const assertFileHandleOpen = (): void => {
          if (closed) throw Object.assign(new Error('file closed'), { code: 'EBADF' });
        };
        const trackAutoCloseStream = (stream: unknown, autoClose: boolean): void => {
          if (!autoClose) return;
          (stream as InternalCloseAwareStream)[streamInternalCloseListeners]?.add(() => {
            closed = true;
          });
        };
        const readFileFromHandle = (encoding?: string | { encoding?: string | null } | null): BrowserBuffer | string => {
          assertFileHandleOpen();
          const entry = fileDescriptor(fd);
          if (!entry.readable) throw Object.assign(new Error('EBADF: bad file descriptor, readFile'), { code: 'EBADF' });
          const source = descriptorBytes(entry);
          const start = entry.offset;
          const bytes = BrowserBuffer.from(source.slice(start));
          entry.offset = source.byteLength;
          const requestedEncoding = typeof encoding === 'string' ? encoding : encoding?.encoding;
          return typeof requestedEncoding === 'string' ? bytes.toString(requestedEncoding) : bytes;
        };
        const writeFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
          assertFileHandleOpen();
          const bytes = bytesFromFsWriteValue(value, options);
          return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, null);
        };
        const appendFileToHandle = (value: unknown, options?: string | { encoding?: string | null } | null): number => {
          assertFileHandleOpen();
          const entry = fileDescriptor(fd);
          const bytes = bytesFromFsWriteValue(value, options);
          const position = entry.kind === 'device' ? null : descriptorBytes(entry).byteLength;
          return fsApi.writeSync(fd, bytes, 0, bytes.byteLength, position);
        };
        return {
          fd,
          read: async (
            bufferOrOptions?: Uint8Array | { buffer?: Uint8Array; offset?: number; length?: number; position?: number | null },
            offset = 0,
            length?: number,
            position?: number | null
          ) => {
            assertFileHandleOpen();
            const options = typeof bufferOrOptions === 'object' && bufferOrOptions !== null && !ArrayBuffer.isView(bufferOrOptions)
              ? bufferOrOptions
              : undefined;
            const buffer = options?.buffer ?? (ArrayBuffer.isView(bufferOrOptions) ? bufferOrOptions : BrowserBuffer.alloc(16 * 1024));
            const readOffset = options?.offset ?? offset;
            const readLength = options?.length ?? length ?? buffer.byteLength - readOffset;
            const readPosition = options !== undefined ? options.position : position;
            const bytesRead = fsApi.readSync(fd, buffer, readOffset, readLength, readPosition);
            return { bytesRead, buffer };
          },
          readFile: async (encoding?: string | { encoding?: string | null } | null) => readFileFromHandle(encoding),
          readv: async (buffers: Uint8Array[], position?: number | null) => {
            assertFileHandleOpen();
            const bytesRead = fsApi.readvSync(fd, buffers, position);
            return { bytesRead, buffers };
          },
          write: async (
            value: unknown,
            offsetOrPosition?: number | { offset?: number; length?: number; position?: number | null },
            lengthOrEncoding?: number | string,
            position?: number | null
          ) => {
            assertFileHandleOpen();
            const options = typeof offsetOrPosition === 'object' && offsetOrPosition !== null ? offsetOrPosition : undefined;
            const bytesWritten = fsApi.writeSync(
              fd,
              value,
              options?.offset ?? (typeof offsetOrPosition === 'number' ? offsetOrPosition : undefined),
              options?.length ?? lengthOrEncoding,
              options !== undefined ? options.position : position
            );
            return {
              bytesWritten,
              buffer: value,
            };
          },
          writeFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
            writeFileToHandle(value, options);
          },
          createReadStream: (options?: string | { autoClose?: boolean; encoding?: string; end?: number; start?: number } | null) => {
            assertFileHandleOpen();
            const streamOptions = typeof options === 'string' ? { encoding: options, fd } : { ...(options ?? {}), fd };
            const stream = fsApi.createReadStream(null, streamOptions);
            trackAutoCloseStream(stream, typeof options !== 'object' || options?.autoClose !== false);
            return stream;
          },
          createWriteStream: (options?: string | { autoClose?: boolean; encoding?: string | null; flags?: string } | null) => {
            assertFileHandleOpen();
            const streamOptions = typeof options === 'string' ? { encoding: options, fd } : { ...(options ?? {}), fd };
            const stream = fsApi.createWriteStream(null, streamOptions);
            trackAutoCloseStream(stream, typeof options !== 'object' || options?.autoClose !== false);
            return stream;
          },
          appendFile: async (value: unknown, options?: string | { encoding?: string | null } | null) => {
            appendFileToHandle(value, options);
          },
          writev: async (buffers: Uint8Array[], position?: number | null) => {
            assertFileHandleOpen();
            const bytesWritten = fsApi.writevSync(fd, buffers, position);
            return { bytesWritten, buffers };
          },
          stat: async (options?: BrowserStatOptions) => {
            assertFileHandleOpen();
            return fsApi.fstatSync(fd, options);
          },
          chmod: async (mode: unknown) => {
            assertFileHandleOpen();
            fsApi.fchmodSync(fd, mode);
          },
          chown: async (uid: unknown, gid: unknown) => {
            assertFileHandleOpen();
            fsApi.fchownSync(fd, uid, gid);
          },
          utimes: async (atime: unknown, mtime: unknown) => {
            assertFileHandleOpen();
            fsApi.futimesSync(fd, atime, mtime);
          },
          truncate: async (length = 0) => {
            assertFileHandleOpen();
            fsApi.ftruncateSync(fd, length);
          },
          sync: async () => {
            assertFileHandleOpen();
            fsApi.fsyncSync(fd);
          },
          datasync: async () => {
            assertFileHandleOpen();
            fsApi.fdatasyncSync(fd);
          },
          close: async () => {
            if (closed) return;
            closed = true;
            fsApi.closeSync(fd);
          },
        };
      },
      readFile: async (path: unknown, encoding?: string | { encoding?: string }) => fsApi.readFileSync(fileHandleTarget(path), encoding),
      writeFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        fsApi.writeFileSync(fileHandleTarget(path), value, options);
      },
      appendFile: async (path: unknown, value: unknown, options?: string | { encoding?: string | null } | null) => {
        fsApi.appendFileSync(fileHandleTarget(path), value, options);
      },
      copyFile: async (source: unknown, destination: unknown, mode = 0) => {
        fsApi.copyFileSync(source, destination, mode);
      },
      link: async (existingPath: unknown, newPath: unknown) => {
        fsApi.linkSync(existingPath, newPath);
      },
      symlink: async (target: unknown, linkPath: unknown) => {
        fsApi.symlinkSync(target, linkPath);
      },
      readlink: async (path: unknown, options?: string | { encoding?: string | null } | null) => fsApi.readlinkSync(path, options),
      cp: async (source: unknown, destination: unknown, options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean; filter?: (source: string, destination: string) => boolean }) => {
        fsApi.cpSync(source, destination, options);
      },
      chmod: async (path: unknown, mode: unknown) => {
        fsApi.chmodSync(path, mode);
      },
      chown: async (path: unknown, uid: unknown, gid: unknown) => {
        fsApi.chownSync(path, uid, gid);
      },
      utimes: async (path: unknown, atime: unknown, mtime: unknown) => {
        fsApi.utimesSync(path, atime, mtime);
      },
      rename: async (oldPath: unknown, newPath: unknown) => {
        fsApi.renameSync(oldPath, newPath);
      },
      unlink: async (path: unknown) => {
        fsApi.unlinkSync(path);
      },
      truncate: async (path: unknown, length = 0) => {
        fsApi.truncateSync(path, length);
      },
      rm: async (path: unknown, options?: { force?: boolean; recursive?: boolean }) => {
        fsApi.rmSync(path, options);
      },
      readdir: async (path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean } | string | null) => fsApi.readdirSync(path, options),
      opendir: async (path: unknown) => fsApi.opendirSync(path),
      watch: (path: unknown, options?: { recursive?: boolean; signal?: AbortSignal } | string | null) => {
        type WatchEntry = { eventType: string; filename: string };
        const entries: WatchEntry[] = [];
        const waiters: Array<(result: IteratorResult<WatchEntry>) => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          watcher.close();
          entries.length = 0;
          while (waiters.length > 0) {
            waiters.shift()?.({ done: true, value: undefined });
          }
        };
        const watcher = fsApi.watch(path, typeof options === 'string' ? undefined : options ?? undefined, (eventType, filename) => {
          const entry = { eventType, filename };
          const waiter = waiters.shift();
          if (waiter) {
            waiter({ done: false, value: entry });
            return;
          }
          entries.push(entry);
        });
        if (typeof options === 'object' && options?.signal) {
          if (options.signal.aborted) {
            close();
          } else {
            options.signal.addEventListener('abort', close, { once: true });
          }
        }
        const iterator = {
          [Symbol.asyncIterator]() {
            return iterator;
          },
          next: (): Promise<IteratorResult<WatchEntry>> => {
            if (entries.length > 0) return Promise.resolve({ done: false, value: entries.shift() as WatchEntry });
            if (closed) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              waiters.push(resolve);
            });
          },
          return: (): Promise<IteratorResult<WatchEntry>> => {
            close();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        return iterator;
      },
      stat: async (path: unknown, options?: BrowserStatOptions) => fsApi.statSync(path, options),
      lstat: async (path: unknown, options?: BrowserStatOptions) => {
        const stats = fsApi.lstatSync(path, options);
        if (stats === undefined && options?.throwIfNoEntry === false) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' });
        }
        return stats;
      },
      statfs: async (path: unknown, options?: { bigint?: boolean }) => fsApi.statfsSync(path, options),
      realpath: async (path: unknown, options?: string | { encoding?: string | null } | null) => fsApi.realpathSync(path, options),
      mkdir: async (path: unknown, options?: { recursive?: boolean }) => fsApi.mkdirSync(path, options),
      mkdtemp: async (prefix: unknown, options?: string | { encoding?: string | null } | null) => fsApi.mkdtempSync(prefix, options),
      rmdir: async (path: unknown) => {
        fsApi.rmdirSync(path);
      },
    };
    (fsApi.realpath as unknown as { native: typeof fsApi.realpath }).native = fsApi.realpath;
    (fsApi.realpathSync as unknown as { native: typeof fsApi.realpathSync }).native = fsApi.realpathSync;
    Object.assign(fsApi, { promises: fsPromisesApi });
    const zlibApi = createZlibApi();
    const httpApi = createHttpApi(request.kernelHttp, request.signal);
    const restoreHttpGlobals = installBrowserHttpGlobalLockdown(httpApi);
    const restoreTimerGlobals = installBrowserTimerGlobals(eventLoopApi);
    const builtins = new Map<string, unknown>([
      ['fs', fsApi],
      ['node:fs', fsApi],
      ['fs/promises', fsPromisesApi],
      ['node:fs/promises', fsPromisesApi],
      ['path', pathApi],
      ['node:path', pathApi],
      ['os', osApi],
      ['node:os', osApi],
      ['url', urlApi],
      ['node:url', urlApi],
      ['buffer', { Buffer: BrowserBuffer }],
      ['node:buffer', { Buffer: BrowserBuffer }],
      ['http', httpApi.module],
      ['node:http', httpApi.module],
      ['zlib', zlibApi],
      ['node:zlib', zlibApi],
      ['assert', assertApi],
      ['node:assert', assertApi],
      ['assert/strict', assertApi],
      ['node:assert/strict', assertApi],
      ['events', eventsApi],
      ['node:events', eventsApi],
      ['util', utilApi],
      ['node:util', utilApi],
      ['stream', streamApi],
      ['node:stream', streamApi],
      ['timers/promises', timersPromisesApi],
      ['node:timers/promises', timersPromisesApi],
      ['crypto', cryptoApi],
      ['node:crypto', cryptoApi],
      ['process', processApi],
      ['node:process', processApi],
    ]);
    const normalizeModuleSpecifier = (specifier: string): string => (
      specifier.startsWith('/')
        ? normalizeWorkspaceEntryPath(specifier, '', false, workspacePathContext)
        : specifier
    );
    const requireModule = (specifier: string, parentPath: string, parentModule: ModuleRecord | null = null) => {
      if (builtins.has(specifier)) return builtins.get(specifier);
      const normalizedSpecifier = normalizeModuleSpecifier(specifier);
      return executeModule(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), parentModule);
    };
    const resolveRequireModule = (specifier: string, parentPath: string): string => {
      if (builtins.has(specifier)) return specifier;
      const normalizedSpecifier = normalizeModuleSpecifier(specifier);
      return workspaceFilename(resolveModulePath(modules, normalizedSpecifier, parentPath, nodePathSearchEntries, 'require'), workspaceRoot);
    };
    const createWorkspaceRequire = (
      parentPath: string,
      parentModule: ModuleRecord | null = null
    ): ((specifier: string) => unknown) & {
      cache: Record<string, ModuleRecord>;
      main?: ModuleRecord;
      resolve: (specifier: string) => string;
    } => {
      const localRequire = ((specifier: string) => requireModule(specifier, parentPath, parentModule)) as ((specifier: string) => unknown) & {
        cache: Record<string, ModuleRecord>;
        resolve: (specifier: string) => string;
        main?: ModuleRecord;
      };
      localRequire.cache = requireCache;
      localRequire.resolve = (specifier: string) => resolveRequireModule(specifier, parentPath);
      Object.defineProperty(localRequire, 'main', {
        configurable: true,
        enumerable: true,
        get: () => mainModule,
      });
      return localRequire;
    };
    const importModule = (specifier: string, parentPath: string) => (
      builtins.has(specifier)
        ? Promise.resolve(builtins.get(specifier))
        : Promise.resolve(executeModule(resolveModulePath(modules, normalizeModuleSpecifier(specifier), parentPath, nodePathSearchEntries, 'import')))
    );
    const preloadParentPath = cwdPath ? `${cwdPath}/repl.js` : 'repl.js';

    const createModuleRecord = (normalizedPath: string, parent: ModuleRecord | null): ModuleRecord => ({
      exports: {},
      id: workspaceFilename(normalizedPath, workspaceRoot),
      filename: workspaceFilename(normalizedPath, workspaceRoot),
      loaded: false,
      parent,
      children: [],
      path: workspaceDirname(normalizedPath, workspaceRoot),
      paths: moduleSearchPaths(normalizedPath, workspaceRoot),
    });

    const executeModule = (modulePath: string, parent: ModuleRecord | null = null, isMain = false): unknown => {
      const normalizedPath = moduleCandidates(modules, modulePath, 'require').find((candidate) => modules.has(candidate));
      if (!normalizedPath) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }
      const cacheKey = workspaceFilename(normalizedPath, workspaceRoot);

      const cached = cache.get(normalizedPath);
      if (cached && requireCache[cacheKey]) {
        if (parent?.children && !parent.children.includes(cached)) parent.children.push(cached);
        return cached.exports;
      } else if (cached) {
        cache.delete(normalizedPath);
      }

      const code = modules.get(normalizedPath);
      if (code === undefined) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      if (normalizedPath.endsWith('.json')) {
        const parsed = JSON.parse(code) as unknown;
        const jsonModule = createModuleRecord(normalizedPath, parent);
        jsonModule.exports = parsed;
        jsonModule.loaded = true;
        cache.set(normalizedPath, jsonModule);
        requireCache[cacheKey] = jsonModule;
        if (parent?.children) parent.children.push(jsonModule);
        return parsed;
      }

      const module = createModuleRecord(normalizedPath, parent);
      if (isMain) {
        module.id = '.';
        mainModule = module;
      }
      cache.set(normalizedPath, module);
      requireCache[cacheKey] = module;
      if (parent?.children) parent.children.push(module);
      const localRequire = createWorkspaceRequire(normalizedPath, module);
      module.require = localRequire;
      const localImport = (specifier: string) => importModule(specifier, normalizedPath);
      const executableCode = isEsmModule(modules, normalizedPath)
        ? transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot))
        : code;
      try {
        const fn = new Function(
          'require',
          '__import',
          'module',
          'exports',
          'console',
          'process',
          'Buffer',
          '__filename',
          '__dirname',
          executableCode
        );
        fn.call(
          isEsmModule(modules, normalizedPath) ? undefined : module.exports,
          localRequire,
          localImport,
          module,
          module.exports,
          consoleApi,
          processApi,
          BrowserBuffer,
          workspaceFilename(normalizedPath, workspaceRoot),
          workspaceDirname(normalizedPath, workspaceRoot)
        );
      } catch (error) {
        throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
      }
      module.loaded = true;
      return module.exports;
    };

    const executeEntrypoint = async (modulePath: string): Promise<void> => {
      const normalizedPath = moduleCandidates(modules, modulePath, 'import').find((candidate) => modules.has(candidate));
      if (!normalizedPath) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      if (!isEsmModule(modules, normalizedPath)) {
        executeModule(normalizedPath, null, true);
        await Promise.resolve();
        return;
      }

      const cached = cache.get(normalizedPath);
      if (cached) return;

      const code = modules.get(normalizedPath);
      if (code === undefined) {
        throw new Error(`Cannot find module '${modulePath}'`);
      }

      const module = createModuleRecord(normalizedPath, null);
      module.id = '.';
      mainModule = module;
      cache.set(normalizedPath, module);
      requireCache[workspaceFilename(normalizedPath, workspaceRoot)] = module;
      const localRequire = createWorkspaceRequire(normalizedPath, module);
      module.require = localRequire;
      const localImport = (specifier: string) => importModule(specifier, normalizedPath);
      const executableCode = transformStaticEsmToCommonJs(code, workspaceFileUrl(normalizedPath, workspaceRoot));
      try {
        const fn = new AsyncFunction(
          'require',
          '__import',
          'module',
          'exports',
          'console',
          'process',
          'Buffer',
          '__filename',
          '__dirname',
          executableCode
        );
        await fn.call(
          undefined,
          localRequire,
          localImport,
          module,
          module.exports,
          consoleApi,
          processApi,
          BrowserBuffer,
          workspaceFilename(normalizedPath, workspaceRoot),
          workspaceDirname(normalizedPath, workspaceRoot)
        );
      } catch (error) {
        throw sanitizeBrowserJavaScriptStack(error, workspaceFilename(normalizedPath, workspaceRoot));
      }
      module.loaded = true;
      await Promise.resolve();
    };

    try {
      for (const moduleName of requireModulesForRequest(request)) {
        requireModule(moduleName, preloadParentPath);
      }

      if (request.source === 'file') {
        let entryPath: string | null = null;
        try {
          const workspaceRelativePath = assertSafeWorkspaceFilePath(request.scriptPath, '', workspacePathContext);
          if (modules.has(workspaceRelativePath)) {
            entryPath = workspaceRelativePath;
          }
        } catch {
          // Fall back to cwd-relative resolution below.
        }
        await executeEntrypoint(entryPath ?? normalizeWorkspaceEntryPath(request.scriptPath, cwdPath, false, workspacePathContext));
      } else {
        const module: ModuleRecord = { exports: {} };
        const replPath = preloadParentPath;
        const requireFromRoot = createWorkspaceRequire(replPath);
        const importFromRoot = (specifier: string) => importModule(specifier, replPath);
        const evalCode = request.options?.inputType === 'module'
          ? transformStaticEsmToCommonJs(request.code, workspaceFileUrl('[eval]', workspaceRoot))
          : request.code;
        try {
          const fn = new AsyncFunction(
            'require',
            '__import',
            'module',
            'exports',
            'console',
            'process',
            'Buffer',
            '__filename',
            '__dirname',
            transformDynamicImports(evalCode)
          );
          await fn.call(
            module.exports,
            requireFromRoot,
            importFromRoot,
            module,
            module.exports,
            consoleApi,
            processApi,
            BrowserBuffer,
            `${workspaceRoot}/[eval]`,
            cwdPath ? `${workspaceRoot}/${cwdPath}` : workspaceRoot
          );
        } catch (error) {
          throw sanitizeBrowserJavaScriptStack(error, `${workspaceRoot}/[eval]`);
        }
        await Promise.resolve();
      }

      if (httpApi.hasActiveWork()) {
        await httpApi.waitForClose();
      }
      await eventLoopApi.drain();
      liveIo.close();
      await liveIo.flush();
      const resultFiles = [
        ...Array.from(fileStore.entries())
        .filter(([path, contents]) => !byteEqual(originalFiles.get(path), contents))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, contents]) => bytesToRuntimeFile(path, contents)),
        ...Array.from(originalFiles.keys())
          .filter((path) => !fileStore.has(path))
          .sort((left, right) => left.localeCompare(right))
          .map((path): RuntimeFileChange => ({ path, deleted: true })),
      ]
        .sort((left, right) => left.path.localeCompare(right.path));
      const files = liveIo.filterAppliedResultFiles({
        stdout: '',
        stderr: '',
        exitCode: 0,
        files: resultFiles,
      }).files ?? [];
      httpApi.closeAll();
      eventLoopApi.clearAll();
      const exitCode = typeof processApi.exitCode === 'number' ? processApi.exitCode : 0;
      createRuntimeProjectIoBridge(request.onEvent).status('process-exit', 'Browser Node exited', { command: 'node', exitCode });
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode,
        ...(files.length > 0 ? { files } : {}),
      };
    } catch (error) {
      httpApi.closeAll();
      eventLoopApi.clearAll();
      const exitCode = typeof (error as { exitCode?: unknown }).exitCode === 'number'
        ? (error as { exitCode: number }).exitCode
        : 1;
      const stderrSuffix = (error as { suppressStderr?: unknown }).suppressStderr
        ? ''
        : formatBrowserJavaScriptErrorForStderr(error);
      const hostIo = createRuntimeProjectIoBridge(request.onEvent);
      if (stderrSuffix) {
        stderr.push(stderrSuffix);
        hostIo.output('stderr', stderrSuffix);
      }
      liveIo.close();
      try {
        await liveIo.flush();
      } catch (flushError) {
        const flushStderr = flushError instanceof Error ? `${flushError.message}\n` : `${String(flushError)}\n`;
        hostIo.output('stderr', flushStderr);
        hostIo.status('process-exit', 'Browser Node exited', { command: 'node', exitCode: 1 });
        return {
          stdout: stdout.join(''),
          stderr: stderr.join('') + flushStderr,
          exitCode: 1,
        };
      }
      hostIo.status('process-exit', 'Browser Node exited', { command: 'node', exitCode });
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode,
      };
    } finally {
      restoreTimerGlobals();
      restoreHttpGlobals();
    }
}
