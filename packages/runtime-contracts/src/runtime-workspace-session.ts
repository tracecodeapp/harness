import type {
  RuntimeDirectory,
  RuntimeFile,
  RuntimeSymlink,
} from './runtime-workspace-manifest';

export type RuntimeProjectSessionExpirationBehavior = 'none' | 'readonly' | 'destroy';

export interface RuntimeProjectSessionLifecycle {
  createdAt: string;
  lastOpenedAt: string;
  expiresAt?: string;
  expiredAt?: string;
  destroyedAt?: string;
  expirationBehavior: RuntimeProjectSessionExpirationBehavior;
}

export interface RuntimeProjectSessionFile extends RuntimeFile {
  readonly?: boolean;
  hidden?: boolean;
}

export interface RuntimeProjectSessionCommandMetadata {
  hidden?: boolean;
  label?: string;
  description?: string;
}

export interface RuntimeProjectSessionCommandStep extends RuntimeProjectSessionCommandMetadata {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RuntimeProjectSessionCommandGroup extends RuntimeProjectSessionCommandMetadata {
  steps: readonly RuntimeProjectSessionCommandStep[];
}

export type RuntimeProjectSessionCommand =
  | RuntimeProjectSessionCommandStep
  | RuntimeProjectSessionCommandGroup;

export type RuntimeProjectSessionCommandDefinition =
  | string
  | RuntimeProjectSessionCommandStep
  | (RuntimeProjectSessionCommandMetadata & { steps: readonly RuntimeProjectSessionCommandDefinition[] });

export interface RuntimeProjectSession {
  id: string;
  projectId?: string;
  projectSlug?: string;
  name?: string;
  language?: string;
  workspaceRoot?: string;
  cwd?: string;
  entrypoint?: string;
  env?: Record<string, string>;
  commands?: Record<string, RuntimeProjectSessionCommandDefinition>;
  files?: readonly RuntimeProjectSessionFile[];
  symlinks?: readonly RuntimeSymlink[];
  directories?: readonly string[];
  directoryMetadata?: readonly RuntimeDirectory[];
  skills?: readonly RuntimeFile[];
  createdAt?: string;
  lastOpenedAt?: string;
  expiresAt?: string;
  expirationBehavior?: RuntimeProjectSessionExpirationBehavior;
  metadata?: Record<string, unknown>;
}

export interface RuntimeProjectSessionInfo {
  id: string;
  projectId?: string;
  projectSlug?: string;
  name?: string;
  language?: string;
  workspaceRoot: string;
  cwd: string;
  entrypoint?: string;
  env?: Record<string, string>;
  commands: Record<string, RuntimeProjectSessionCommand>;
  readonlyFiles: readonly string[];
  hiddenFiles: readonly string[];
  lifecycle: RuntimeProjectSessionLifecycle;
  metadata?: Record<string, unknown>;
}
