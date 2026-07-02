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
import { bytesEqual, contentToBytes, contentToBytesForRuntimeFile, normalizeRuntimeFileEncoding } from './fs-observed';
import { normalizeRuntimeProjectPath } from './paths';
import type { RuntimeProjectPatchFileDelete } from '../../harness-core/src/runtime-project';



export interface RuntimeProjectPatchSnapshotFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  hash: string;
}


export interface RuntimeProjectPatchSnapshotView {
  manifestHash: string;
  files: Map<string, RuntimeProjectPatchSnapshotFile>;
  directories: Set<string>;
  entrypoint?: string;
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


export async function runtimeProjectPatchFileHash(file: RuntimeFile): Promise<string> {
  return runtimeProjectPatchHashBytes(contentToBytesForRuntimeFile(file));
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

    if (kind === 'mkdir' || kind === 'rmdir') return { kind, path };
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


export function runtimeProjectPatchChangesToFileChanges(changes: readonly RuntimeProjectPatchChange[]): RuntimeFileChange[] {
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
