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
} from '@tracecode/runtime-contracts';
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
} from '@tracecode/runtime-contracts';
import { getLanguageRuntimeInfo } from '@tracecode/runtime-contracts';
import type { Language } from '@tracecode/runtime-contracts';
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
  RuntimeSymlink,
  RuntimeDirectory,
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
  RuntimeProjectPatchSymlinkWrite,
  RuntimeProjectPatchDirectoryWrite,
  RuntimeProjectSnapshot,
  RuntimeWorkspaceActor,
} from '@tracecode/runtime-contracts';
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
import { bytesEqual, contentToBytes, contentToBytesForRuntimeFile, normalizeRuntimeFileEncoding } from './fs-observed';
import { normalizeRuntimeProjectPath } from './paths';
import type { RuntimeProjectPatchFileDelete } from '@tracecode/runtime-contracts';



export interface RuntimeProjectPatchSnapshotFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  hash: string;
}


export interface RuntimeProjectPatchSnapshotView {
  manifestHash: string;
  files: Map<string, RuntimeProjectPatchSnapshotFile>;
  symlinks: Map<string, RuntimeProjectPatchSnapshotSymlink>;
  directories: Map<string, RuntimeProjectPatchSnapshotDirectory>;
  entrypoint?: string;
}

export interface RuntimeProjectPatchSnapshotDirectory extends RuntimeDirectory {
  hash: string;
}

export interface RuntimeProjectPatchSnapshotSymlink extends RuntimeSymlink {
  hash: string;
}


export const RUNTIME_PROJECT_PATCH_VERSION = 1;

export const RUNTIME_PROJECT_PATCH_HASH_PATTERN = /^[0-9a-f]{64}$/;


export async function createRuntimeProjectPatchSnapshotView(
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
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
      ...(file.atimeMs !== undefined ? { atimeMs: file.atimeMs } : {}),
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    };
    files.set(path, {
      ...normalizedFile,
      hash: await runtimeProjectPatchFileHash(normalizedFile),
    });
  }

  const symlinks = new Map<string, RuntimeProjectPatchSnapshotSymlink>();
  for (const [index, symlink] of (snapshot.symlinks ?? []).entries()) {
    const path = normalizeRuntimeProjectPath(symlink.path);
    if (files.has(path) || symlinks.has(path)) throw new Error(`${label}.symlinks[${index}] duplicates project path: ${path}`);
    if (symlink.symlink !== true || typeof symlink.target !== 'string' || symlink.target.length === 0 || symlink.target.includes('\0')) {
      throw new Error(`${label}.symlinks[${index}] must declare a valid symbolic-link target.`);
    }
    const normalizedSymlink: RuntimeSymlink = { path, symlink: true, target: symlink.target };
    symlinks.set(path, {
      ...normalizedSymlink,
      hash: await runtimeProjectPatchSymlinkHash(normalizedSymlink),
    });
  }

  const directoryMetadata = new Map(
    (snapshot.directoryMetadata ?? []).map((directory, index) => {
      const path = normalizeRuntimeProjectPath(directory.path);
      return [path, {
        path,
        ...normalizeRuntimeProjectPatchDirectoryMetadata(directory, `${label}.directoryMetadata[${index}]`),
      }] as const;
    })
  );
  const directories = new Map<string, RuntimeProjectPatchSnapshotDirectory>();
  for (const [index, directory] of (snapshot.directories ?? []).entries()) {
    if (typeof directory !== 'string') throw new Error(`${label}.directories[${index}] must be a string.`);
    const path = normalizeRuntimeProjectPath(directory);
    if (files.has(path) || symlinks.has(path)) throw new Error(`${label}.directories[${index}] conflicts with non-directory path: ${path}`);
    const metadata = directoryMetadata.get(path);
    const normalizedDirectory: RuntimeDirectory = {
      path,
      ...(metadata?.mode !== undefined ? { mode: metadata.mode } : {}),
      ...(metadata?.atimeMs !== undefined ? { atimeMs: metadata.atimeMs } : {}),
      ...(metadata?.mtimeMs !== undefined ? { mtimeMs: metadata.mtimeMs } : {}),
    };
    directories.set(path, {
      ...normalizedDirectory,
      hash: await runtimeProjectPatchDirectoryHash(normalizedDirectory),
    });
  }
  for (const path of directoryMetadata.keys()) {
    if (!directories.has(path)) throw new Error(`${label}.directoryMetadata references missing directory path: ${path}`);
  }

  const entrypoint = snapshot.entrypoint === undefined ? undefined : normalizeRuntimeProjectPath(snapshot.entrypoint);
  const manifestHash = await runtimeProjectPatchHashJson({
    version: RUNTIME_PROJECT_PATCH_VERSION,
    entrypoint: entrypoint ?? null,
    files: [...files.values()]
      .map((file) => ({ path: file.path, hash: file.hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    symlinks: [...symlinks.values()]
      .map((symlink) => ({ path: symlink.path, hash: symlink.hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    directories: [...directories.values()]
      .map((directory) => ({ path: directory.path, hash: directory.hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });

  return {
    manifestHash,
    files,
    symlinks,
    directories,
    ...(entrypoint ? { entrypoint } : {}),
  };
}

export function runtimeProjectPatchSymlinkHash(symlink: RuntimeSymlink): Promise<string> {
  return runtimeProjectPatchHashJson({ target: symlink.target });
}

export function runtimeProjectPatchDirectoryHash(directory: RuntimeDirectory): Promise<string> {
  return runtimeProjectPatchHashJson({
    mode: directory.mode ?? null,
    atimeMs: directory.atimeMs ?? null,
    mtimeMs: directory.mtimeMs ?? null,
  });
}


export async function runtimeProjectPatchFileHash(file: RuntimeFile): Promise<string> {
  const contents = contentToBytesForRuntimeFile(file);
  const metadata = new TextEncoder().encode(JSON.stringify({
    mode: file.mode ?? null,
  }) + '\0');
  const payload = new Uint8Array(metadata.byteLength + contents.byteLength);
  payload.set(metadata);
  payload.set(contents, metadata.byteLength);
  return runtimeProjectPatchHashBytes(payload);
}


export async function runtimeProjectPatchHashJson(value: unknown): Promise<string> {
  return runtimeProjectPatchHashBytes(new TextEncoder().encode(JSON.stringify(value)));
}


export async function runtimeProjectPatchHashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Runtime project patch hashing requires Web Crypto SHA-256 support.');
  }
  const digestSource = new Uint8Array(bytes.byteLength);
  digestSource.set(bytes);
  return runtimeProjectPatchBytesToHex(new Uint8Array(await subtle.digest('SHA-256', digestSource.buffer as ArrayBuffer)));
}


export function runtimeProjectPatchBytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}


export function assertRuntimeProjectPatchHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUNTIME_PROJECT_PATCH_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}


export function staleRuntimeProjectPatchError(message: string, path?: string): Error {
  return Object.assign(new Error(`ESTALE: ${message}`), {
    code: 'ESTALE',
    errno: 116,
    syscall: 'patch',
    ...(path ? { path } : {}),
  });
}

function normalizeRuntimeProjectPatchDirectoryMetadata(
  change: { mode?: unknown; atimeMs?: unknown; mtimeMs?: unknown },
  label: string
): Omit<RuntimeDirectory, 'path'> {
  if (change.mode !== undefined && (!Number.isInteger(change.mode) || Number(change.mode) < 0 || Number(change.mode) > 0o7777)) {
    throw new Error(`${label}.mode must be permission bits.`);
  }
  for (const field of ['atimeMs', 'mtimeMs'] as const) {
    const value = change[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${label}.${field} must be a non-negative finite timestamp.`);
    }
  }
  return {
    ...(change.mode !== undefined ? { mode: Number(change.mode) } : {}),
    ...(change.atimeMs !== undefined ? { atimeMs: Number(change.atimeMs) } : {}),
    ...(change.mtimeMs !== undefined ? { mtimeMs: Number(change.mtimeMs) } : {}),
  };
}


export function normalizeRuntimeProjectPatch(patch: RuntimeProjectPatch): RuntimeProjectPatch {
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

    if (kind === 'symlink') {
      const symlink = change as RuntimeProjectPatchSymlinkWrite;
      if (typeof symlink.target !== 'string' || symlink.target.length === 0 || symlink.target.includes('\0')) {
        throw new Error(`Runtime project patch changes[${index}].target must be a non-empty string without NUL bytes.`);
      }
      return {
        kind,
        path,
        target: symlink.target,
        baseHash: symlink.baseHash === null
          ? null
          : assertRuntimeProjectPatchHash(symlink.baseHash, `Runtime project patch changes[${index}].baseHash`),
      };
    }

    if (kind === 'mkdir') {
      return { kind, path, ...normalizeRuntimeProjectPatchDirectoryMetadata(change as RuntimeProjectPatchDirectoryWrite, `Runtime project patch changes[${index}]`) };
    }
    if (kind === 'directory') {
      const directory = change as RuntimeProjectPatchDirectoryWrite;
      return {
        kind,
        path,
        ...normalizeRuntimeProjectPatchDirectoryMetadata(directory, `Runtime project patch changes[${index}]`),
        baseHash: assertRuntimeProjectPatchHash(directory.baseHash, `Runtime project patch changes[${index}].baseHash`),
      };
    }
    if (kind === 'rmdir') return { kind, path };
    throw new Error(`Runtime project patch changes[${index}].kind is unsupported: ${String(kind)}`);
  });

  return {
    version: RUNTIME_PROJECT_PATCH_VERSION,
    base,
    changes: sortRuntimeProjectPatchChanges(changes),
  };
}


export function sortRuntimeProjectPatchChanges(changes: readonly RuntimeProjectPatchChange[]): RuntimeProjectPatchChange[] {
  const rank = (change: RuntimeProjectPatchChange): number => {
    if (change.kind === 'delete') return 0;
    if (change.kind === 'rmdir') return 1;
    if (change.kind === 'write' || change.kind === 'symlink') return 2;
    if (change.kind === 'mkdir') return 3;
    return change.kind === 'directory' ? 4 : 5;
  };
  return [...changes].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    if (left.kind === 'rmdir' && right.kind === 'rmdir') return right.path.localeCompare(left.path);
    // Content writes create missing ancestors. Apply new-directory metadata
    // afterward, deepest first, so a recursive child mkdir cannot subsequently
    // overwrite its parent's persisted mtime.
    if (left.kind === 'mkdir' && right.kind === 'mkdir') {
      const depthDelta =
        right.path.split('/').length - left.path.split('/').length;
      if (depthDelta !== 0) return depthDelta;
    }
    return left.path.localeCompare(right.path);
  });
}


export function validateRuntimeProjectPatchAgainstBase(
  base: RuntimeProjectPatchSnapshotView,
  patch: RuntimeProjectPatch
): void {
  if (patch.base.manifestHash !== base.manifestHash) {
    throw staleRuntimeProjectPatchError(
      `patch base manifest ${patch.base.manifestHash} does not match provided base ${base.manifestHash}`
    );
  }

  for (const change of patch.changes) {
    if (change.kind === 'write' || change.kind === 'symlink') {
      const baseEntry = base.files.get(change.path) ?? base.symlinks.get(change.path);
      if (change.baseHash === null) {
        if (baseEntry || base.directories.has(change.path)) {
          throw staleRuntimeProjectPatchError(`patch expected '${change.path}' to be absent in the base`, change.path);
        }
      } else if (!baseEntry || baseEntry.hash !== change.baseHash) {
        throw staleRuntimeProjectPatchError(`patch ${change.kind} precondition failed for '${change.path}'`, change.path);
      }
      continue;
    }

    if (change.kind === 'delete') {
      const baseEntry = base.files.get(change.path) ?? base.symlinks.get(change.path);
      if (!baseEntry || baseEntry.hash !== change.baseHash) {
        throw staleRuntimeProjectPatchError(`patch delete precondition failed for '${change.path}'`, change.path);
      }
      continue;
    }

    if (change.kind === 'mkdir') {
      if (base.files.has(change.path) || base.symlinks.has(change.path) || base.directories.has(change.path)) {
        throw staleRuntimeProjectPatchError(`patch expected directory '${change.path}' to be absent in the base`, change.path);
      }
      continue;
    }

    if (change.kind === 'directory') {
      const baseDirectory = base.directories.get(change.path);
      if (!baseDirectory || baseDirectory.hash !== change.baseHash) {
        throw staleRuntimeProjectPatchError(`patch directory precondition failed for '${change.path}'`, change.path);
      }
      continue;
    }

    if (!base.directories.has(change.path)) {
      throw staleRuntimeProjectPatchError(`patch expected directory '${change.path}' to exist in the base`, change.path);
    }
  }
}


export function runtimeProjectPatchChangesToFileChanges(changes: readonly RuntimeProjectPatchChange[]): RuntimeFileChange[] {
  return changes.map((change): RuntimeFileChange => {
    if (change.kind === 'write') {
      return {
        path: change.path,
        contents: change.contents,
        ...(change.encoding === 'base64' ? { encoding: change.encoding } : {}),
      };
    }
    if (change.kind === 'symlink') return { path: change.path, symlink: true, target: change.target };
    if (change.kind === 'delete') return { path: change.path, deleted: true };
    if (change.kind === 'mkdir' || change.kind === 'directory') {
      return {
        path: change.path,
        directory: true,
        ...(change.mode !== undefined ? { mode: change.mode } : {}),
        ...(change.atimeMs !== undefined ? { atimeMs: change.atimeMs } : {}),
        ...(change.mtimeMs !== undefined ? { mtimeMs: change.mtimeMs } : {}),
      };
    }
    return { path: change.path, directory: true, deleted: true };
  });
}
