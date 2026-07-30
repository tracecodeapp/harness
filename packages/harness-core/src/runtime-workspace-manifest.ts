import type {
  RuntimeKernelDeviceInfo,
  RuntimeKernelInfo,
} from './runtime-kernel-contracts';

export type RuntimeFileEncoding = 'utf8' | 'base64';

/** Canonical, traversal-safe project path normalization shared by every surface. */
export function normalizeRuntimeProjectPath(path: string): string {
  if (path.includes('\0')) throw new Error('Project path must not contain NUL bytes.');
  const normalized = path.replace(/\\/g, '/');
  if (normalized.trim().length === 0) throw new Error('Project path must not be empty.');
  if (normalized.startsWith('/')) throw new Error(`Project path must be relative: ${path}`);
  if (/^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${path}`);
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Project path must not escape the workspace: ${path}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Project path must point to a file: ${path}`);
  return parts.join('/');
}

export interface RuntimeFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  /** Permission bits, without the file-type bits. */
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export interface RuntimeSymlink {
  path: string;
  symlink: true;
  target: string;
}

export interface RuntimeFileDeletion {
  path: string;
  deleted: true;
}

export interface RuntimeDirectoryChange {
  path: string;
  directory: true;
  deleted?: true;
  /** Permission bits, without the file-type bits. */
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export type RuntimeDirectory = Omit<RuntimeDirectoryChange, 'directory' | 'deleted'>;

export type RuntimeFileChange = RuntimeFile | RuntimeSymlink | RuntimeFileDeletion | RuntimeDirectoryChange;

export type RuntimeFileMutationPhase = 'live' | 'flush' | 'final-diff';

export type RuntimeWorkspaceActorKind = 'principal' | 'test' | 'hidden-test' | 'runtime' | 'system';

export interface RuntimeWorkspaceHttpCapabilities {
  listen?: boolean;
  dispatch?: boolean;
  externalFetch?: boolean;
  readDiagnostics?: boolean;
}

export interface RuntimeWorkspaceCapabilities {
  read?: readonly string[];
  write?: readonly string[];
  delete?: readonly string[];
  execute?: boolean;
  http?: RuntimeWorkspaceHttpCapabilities;
}

export interface RuntimeWorkspaceActor {
  id: string;
  kind: RuntimeWorkspaceActorKind;
  capabilities?: RuntimeWorkspaceCapabilities;
}

export type RuntimeWorkspaceHttpCapabilityPresetName = 'workspace' | 'system' | 'none';

export const RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS = {
  workspace: {
    listen: true,
    dispatch: true,
    readDiagnostics: true,
  },
  system: {
    listen: true,
    dispatch: true,
    externalFetch: true,
    readDiagnostics: true,
  },
  none: {},
} as const satisfies Record<RuntimeWorkspaceHttpCapabilityPresetName, RuntimeWorkspaceHttpCapabilities>;

export type RuntimeWorkspaceActorPresetName = RuntimeWorkspaceActorKind;

export const RUNTIME_WORKSPACE_ACTOR_PRESETS = {
  principal: {
    id: 'principal',
    kind: 'principal',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  test: {
    id: 'test',
    kind: 'test',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  'hidden-test': {
    id: 'hidden-test',
    kind: 'hidden-test',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  runtime: {
    id: 'runtime',
    kind: 'runtime',
    capabilities: {
      execute: true,
      http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace,
    },
  },
  system: {
    id: 'system',
    kind: 'system',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.system },
  },
} as const satisfies Record<RuntimeWorkspaceActorPresetName, RuntimeWorkspaceActor>;

export function runtimeWorkspaceHttpCapabilitiesPreset(
  name: RuntimeWorkspaceHttpCapabilityPresetName
): RuntimeWorkspaceHttpCapabilities {
  return { ...RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS[name] };
}

export function runtimeWorkspaceActorPreset(
  name: RuntimeWorkspaceActorPresetName,
  options: {
    id?: string;
    capabilities?: RuntimeWorkspaceCapabilities;
  } = {}
): RuntimeWorkspaceActor {
  const preset = RUNTIME_WORKSPACE_ACTOR_PRESETS[name];
  const capabilities = options.capabilities ?? preset.capabilities;
  return {
    id: options.id ?? preset.id,
    kind: preset.kind,
    ...(capabilities ? { capabilities: cloneRuntimeWorkspaceCapabilities(capabilities) } : {}),
  };
}

function cloneRuntimeWorkspaceCapabilities(capabilities: RuntimeWorkspaceCapabilities): RuntimeWorkspaceCapabilities {
  return {
    ...(capabilities.read ? { read: [...capabilities.read] } : {}),
    ...(capabilities.write ? { write: [...capabilities.write] } : {}),
    ...(capabilities.delete ? { delete: [...capabilities.delete] } : {}),
    ...(capabilities.execute !== undefined ? { execute: capabilities.execute } : {}),
    ...(capabilities.http ? { http: { ...capabilities.http } } : {}),
  };
}

export interface RuntimeProjectStorageSnapshot {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number;
  usedEntries: number;
  capacityEntries: number;
  availableEntries: number;
}

export interface RuntimeProjectSnapshot {
  files: RuntimeFile[];
  symlinks?: RuntimeSymlink[];
  kernelFiles?: RuntimeFile[];
  kernelDevices?: RuntimeKernelDeviceInfo[];
  directories?: string[];
  directoryMetadata?: RuntimeDirectory[];
  readonlyFiles?: readonly string[];
  hiddenFiles?: readonly string[];
  entrypoint?: string;
  cwd?: string;
  workspaceRoot?: string;
  workspaceAlias?: string;
  kernel?: RuntimeKernelInfo;
  storage?: RuntimeProjectStorageSnapshot;
}

export interface RuntimeProjectPatchBase {
  id?: string;
  version?: string;
  manifestHash: string;
}

export interface RuntimeProjectPatchOptions {
  base?: {
    id?: string;
    version?: string;
  };
}

export interface RuntimeProjectPatchFileWrite {
  kind: 'write';
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  baseHash: string | null;
}

export interface RuntimeProjectPatchFileDelete {
  kind: 'delete';
  path: string;
  baseHash: string;
}

export interface RuntimeProjectPatchSymlinkWrite {
  kind: 'symlink';
  path: string;
  target: string;
  baseHash: string | null;
}

export interface RuntimeProjectPatchDirectoryCreate {
  kind: 'mkdir';
  path: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export interface RuntimeProjectPatchDirectoryWrite {
  kind: 'directory';
  path: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  baseHash: string;
}

export interface RuntimeProjectPatchDirectoryDelete {
  kind: 'rmdir';
  path: string;
}

export type RuntimeProjectPatchChange =
  | RuntimeProjectPatchFileWrite
  | RuntimeProjectPatchSymlinkWrite
  | RuntimeProjectPatchFileDelete
  | RuntimeProjectPatchDirectoryCreate
  | RuntimeProjectPatchDirectoryWrite
  | RuntimeProjectPatchDirectoryDelete;

export interface RuntimeProjectPatch {
  version: 1;
  base: RuntimeProjectPatchBase;
  changes: RuntimeProjectPatchChange[];
}
