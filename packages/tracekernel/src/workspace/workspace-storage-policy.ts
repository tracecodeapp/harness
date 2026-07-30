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

function normalizeRuntimeWorkspaceStorageLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
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
