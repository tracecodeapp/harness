import type {
  RuntimeFileChange,
  RuntimeProjectPatch,
  RuntimeProjectPatchChange,
  RuntimeProjectPatchOptions,
  RuntimeProjectSnapshot,
} from '@tracecode/harness-core';
import {
  RUNTIME_PROJECT_PATCH_VERSION,
  createRuntimeProjectPatchSnapshotView,
  normalizeRuntimeProjectPatch,
  runtimeProjectPatchChangesToFileChanges,
  sortRuntimeProjectPatchChanges,
  staleRuntimeProjectPatchError,
  validateRuntimeProjectPatchAgainstBase,
} from './patches';

export interface WorkspacePatchIdentity {
  readonly projectId?: string;
  readonly projectVersion?: string;
}

/**
 * Computes a deterministic patch between two public workspace snapshots.
 *
 * Snapshot collection and mutation remain workspace-owned. This module owns
 * only the persistence format and its comparison rules.
 */
export async function createWorkspacePatch(
  baseSnapshot: RuntimeProjectSnapshot,
  currentSnapshot: RuntimeProjectSnapshot,
  options: RuntimeProjectPatchOptions = {}
): Promise<RuntimeProjectPatch> {
  const base = await createRuntimeProjectPatchSnapshotView(
    baseSnapshot,
    'Runtime project patch base snapshot'
  );
  const current = await createRuntimeProjectPatchSnapshotView(
    currentSnapshot,
    'Runtime project patch current snapshot'
  );
  const changes: RuntimeProjectPatchChange[] = [];

  for (
    const baseFile of [...base.files.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    const currentFile = current.files.get(baseFile.path);
    const currentSymlink = current.symlinks.get(baseFile.path);
    if (currentSymlink) {
      changes.push({
        kind: 'symlink',
        path: currentSymlink.path,
        target: currentSymlink.target,
        baseHash: baseFile.hash,
      });
    } else if (!currentFile) {
      changes.push({
        kind: 'delete',
        path: baseFile.path,
        baseHash: baseFile.hash,
      });
    } else if (currentFile.hash !== baseFile.hash) {
      changes.push({
        kind: 'write',
        path: currentFile.path,
        contents: currentFile.contents,
        ...(currentFile.encoding === 'base64'
          ? { encoding: currentFile.encoding }
          : {}),
        baseHash: baseFile.hash,
      });
    }
  }

  for (
    const currentFile of [...current.files.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    if (
      !base.files.has(currentFile.path) &&
      !base.symlinks.has(currentFile.path)
    ) {
      changes.push({
        kind: 'write',
        path: currentFile.path,
        contents: currentFile.contents,
        ...(currentFile.encoding === 'base64'
          ? { encoding: currentFile.encoding }
          : {}),
        baseHash: null,
      });
    }
  }

  for (
    const baseSymlink of [...base.symlinks.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    const currentSymlink = current.symlinks.get(baseSymlink.path);
    const currentFile = current.files.get(baseSymlink.path);
    if (currentFile) {
      changes.push({
        kind: 'write',
        path: currentFile.path,
        contents: currentFile.contents,
        ...(currentFile.encoding === 'base64'
          ? { encoding: currentFile.encoding }
          : {}),
        baseHash: baseSymlink.hash,
      });
    } else if (!currentSymlink) {
      changes.push({
        kind: 'delete',
        path: baseSymlink.path,
        baseHash: baseSymlink.hash,
      });
    } else if (currentSymlink.hash !== baseSymlink.hash) {
      changes.push({
        kind: 'symlink',
        path: currentSymlink.path,
        target: currentSymlink.target,
        baseHash: baseSymlink.hash,
      });
    }
  }

  for (
    const currentSymlink of [...current.symlinks.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    if (
      !base.files.has(currentSymlink.path) &&
      !base.symlinks.has(currentSymlink.path)
    ) {
      changes.push({
        kind: 'symlink',
        path: currentSymlink.path,
        target: currentSymlink.target,
        baseHash: null,
      });
    }
  }

  for (
    const directory of [...base.directories.keys()].sort((left, right) =>
      right.localeCompare(left)
    )
  ) {
    if (!current.directories.has(directory)) {
      changes.push({ kind: 'rmdir', path: directory });
    }
  }
  for (
    const directory of [...current.directories.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
  ) {
    const baseDirectory = base.directories.get(directory.path);
    if (!baseDirectory) {
      changes.push({
        kind: 'mkdir',
        path: directory.path,
        ...(directory.mode !== undefined
          ? { mode: directory.mode }
          : {}),
        ...(directory.atimeMs !== undefined
          ? { atimeMs: directory.atimeMs }
          : {}),
        ...(directory.mtimeMs !== undefined
          ? { mtimeMs: directory.mtimeMs }
          : {}),
      });
    } else if (baseDirectory.hash !== directory.hash) {
      changes.push({
        kind: 'directory',
        path: directory.path,
        ...(directory.mode !== undefined
          ? { mode: directory.mode }
          : {}),
        ...(directory.atimeMs !== undefined
          ? { atimeMs: directory.atimeMs }
          : {}),
        ...(directory.mtimeMs !== undefined
          ? { mtimeMs: directory.mtimeMs }
          : {}),
        baseHash: baseDirectory.hash,
      });
    }
  }

  return {
    version: RUNTIME_PROJECT_PATCH_VERSION,
    base: {
      ...(options.base?.id ? { id: options.base.id } : {}),
      ...(options.base?.version
        ? { version: options.base.version }
        : {}),
      manifestHash: base.manifestHash,
    },
    changes: sortRuntimeProjectPatchChanges(changes),
  };
}

/**
 * Validates a patch against both its declared base and the current workspace,
 * then returns the normalized filesystem transaction.
 */
export async function prepareWorkspacePatchImport(
  baseSnapshot: RuntimeProjectSnapshot,
  currentSnapshot: RuntimeProjectSnapshot,
  patch: RuntimeProjectPatch,
  options: RuntimeProjectPatchOptions,
  identity: WorkspacePatchIdentity
): Promise<readonly RuntimeFileChange[]> {
  const normalizedPatch = normalizeRuntimeProjectPatch(patch);
  const expectedIdentity = {
    id: options.base?.id ?? identity.projectId,
    version: options.base?.version ?? identity.projectVersion,
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

  const base = await createRuntimeProjectPatchSnapshotView(
    baseSnapshot,
    'Runtime project patch base snapshot'
  );
  validateRuntimeProjectPatchAgainstBase(base, normalizedPatch);

  const current = await createRuntimeProjectPatchSnapshotView(
    currentSnapshot,
    'Runtime project patch current snapshot'
  );
  if (current.manifestHash !== base.manifestHash) {
    throw staleRuntimeProjectPatchError(
      `current workspace manifest ${current.manifestHash} does not match patch base ${base.manifestHash}`
    );
  }

  return runtimeProjectPatchChangesToFileChanges(
    normalizedPatch.changes
  );
}
