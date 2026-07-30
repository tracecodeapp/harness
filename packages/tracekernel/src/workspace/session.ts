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
import { DEFAULT_CWD, TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS, TRACEKERNEL_MAX_PROJECT_COMMAND_STEP_NESTING_DEPTH } from './constants';
import { isWithinWorkspace, normalizeRuntimeProjectPath, normalizeWorkspaceCwd } from './paths';



export function normalizeKernelNamePart(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}


export function normalizeIsoTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return new Date(value).toISOString();
  return new Date().toISOString();
}


export function normalizeOptionalIsoTimestamp(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeIsoTimestamp(value);
}


export function createWorkspaceId(workspaceName: string, startedAt: string): string {
  return `${normalizeKernelNamePart(workspaceName, 'workspace')}-${startedAt.replace(/[:.]/g, '-')}`;
}


export function normalizeProjectSessionCommand(
  command: RuntimeProjectSessionCommandDefinition,
  name = 'project command',
  depth = 0,
  state: { steps: number } = { steps: 0 }
): RuntimeProjectSessionCommand {
  if (typeof command === 'string') {
    state.steps += 1;
    if (state.steps > TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS) {
      throw new Error(
        `Project session command "${name}" must include at most ${TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS} steps.`
      );
    }
    return { command };
  }
  if ('steps' in command) {
    if (depth >= TRACEKERNEL_MAX_PROJECT_COMMAND_STEP_NESTING_DEPTH) {
      throw new Error(
        `Project session command "${name}" must not nest steps deeper than ${TRACEKERNEL_MAX_PROJECT_COMMAND_STEP_NESTING_DEPTH} levels.`
      );
    }
    const steps: RuntimeProjectSessionCommandStep[] = [];
    for (const step of command.steps) {
      const normalized = normalizeProjectSessionCommand(step, name, depth + 1, state);
      if ('steps' in normalized) {
        steps.push(...normalized.steps);
      } else {
        steps.push(normalized);
      }
    }
    return {
      steps,
      ...(command.hidden === true ? { hidden: true } : {}),
      ...(command.label ? { label: command.label } : {}),
      ...(command.description ? { description: command.description } : {}),
    };
  }
  state.steps += 1;
  if (state.steps > TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS) {
    throw new Error(
      `Project session command "${name}" must include at most ${TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS} steps.`
    );
  }
  return { ...command, ...(command.env ? { env: { ...command.env } } : {}) };
}


export function normalizeProjectSessionCommands(
  commands: Record<string, RuntimeProjectSessionCommandDefinition> | undefined
): Record<string, RuntimeProjectSessionCommand> {
  const normalized: Record<string, RuntimeProjectSessionCommand> = {};
  for (const [name, command] of Object.entries(commands ?? {})) {
    if (!name.trim()) throw new Error('Project session command names must not be empty.');
    const normalizedCommand = normalizeProjectSessionCommand(command, name);
    if ('steps' in normalizedCommand) {
      if (normalizedCommand.steps.length === 0) {
        throw new Error(`Project session command "${name}" must include at least one step.`);
      }
      if (normalizedCommand.steps.length > TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS) {
        throw new Error(
          `Project session command "${name}" must include at most ${TRACEKERNEL_MAX_PROJECT_COMMAND_STEPS} steps.`
        );
      }
      for (const step of normalizedCommand.steps) {
        if (!step.command.trim()) {
          throw new Error(`Project session command "${name}" must not include an empty step.`);
        }
      }
    } else if (!normalizedCommand.command.trim()) {
      throw new Error(`Project session command "${name}" must not be empty.`);
    }
    normalized[name] = normalizedCommand;
  }
  return normalized;
}


export function normalizeProjectSessionHiddenFiles(session: RuntimeProjectSession): string[] {
  return [...new Set((session.files ?? [])
    .filter((file) => file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))].sort((left, right) => left.localeCompare(right));
}


export function normalizeProjectSessionReadonlyFiles(session: RuntimeProjectSession): string[] {
  return [...new Set((session.files ?? [])
    .filter((file) => file.readonly === true || file.hidden === true)
    .map((file) => normalizeRuntimeProjectPath(file.path)))].sort((left, right) => left.localeCompare(right));
}


export function mergeProjectSessionKernelConfig(
  options: CreateRuntimeWorkspaceOptions
): RuntimeTraceKernelConfig | undefined {
  const session = options.projectSession;
  if (!session) return options.kernel;
  const workspaceName = session.projectSlug ?? session.name;
  const workspaceId = session.id;
  return {
    ...(options.kernel ?? {}),
    workspace: {
      ...(workspaceName ? { name: workspaceName } : {}),
      ...(workspaceId ? { id: workspaceId } : {}),
      ...(session.workspaceRoot ? { root: session.workspaceRoot } : {}),
      ...(options.kernel?.workspace ?? {}),
    },
  };
}


export function normalizeRuntimeWorkspaceOptions(
  options: CreateRuntimeWorkspaceOptions
): CreateRuntimeWorkspaceOptions {
  const session = options.projectSession;
  if (!session) {
    return options;
  }
  return {
    ...options,
    kernel: mergeProjectSessionKernelConfig(options),
    cwd: options.cwd ?? session.workspaceRoot,
    entrypoint: options.entrypoint ?? session.entrypoint,
    env: {
      ...(session.env ?? {}),
      ...(options.env ?? {}),
    },
    directories: [
      ...(session.directories ?? []),
      ...(options.directories ?? []),
    ],
    directoryMetadata: [
      ...(session.directoryMetadata ?? []),
      ...(options.directoryMetadata ?? []),
    ],
    files: [
      ...(session.files ?? []),
      ...(options.files ?? []),
    ],
    symlinks: [
      ...(session.symlinks ?? []),
      ...(options.symlinks ?? []),
    ],
    skills: [
      ...(session.skills ?? []),
      ...(options.skills ?? []),
    ],
  };
}


export function createProjectSessionInfo(session: RuntimeProjectSession, kernelInfo: RuntimeKernelInfo): RuntimeProjectSessionInfo {
  const cwd = session.cwd
    ? (session.cwd.startsWith('/') ? normalizeWorkspaceCwd(session.cwd) : normalizeWorkspaceCwd(`${kernelInfo.workspaceRoot}/${session.cwd}`))
    : kernelInfo.workspaceRoot;
  if (!isWithinWorkspace(kernelInfo.workspaceRoot, cwd)) {
    throw new Error(`Project session cwd must stay inside the workspace: ${session.cwd}`);
  }
  const createdAt = normalizeIsoTimestamp(session.createdAt);
  const lastOpenedAt = normalizeIsoTimestamp(session.lastOpenedAt);
  const expiresAt = normalizeOptionalIsoTimestamp(session.expiresAt);
  return {
    id: session.id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
    ...(session.name ? { name: session.name } : {}),
    ...(session.language ? { language: session.language } : {}),
    workspaceRoot: kernelInfo.workspaceRoot,
    cwd,
    ...(session.entrypoint ? { entrypoint: normalizeRuntimeProjectPath(session.entrypoint) } : {}),
    ...(session.env ? { env: { ...session.env } } : {}),
    commands: normalizeProjectSessionCommands(session.commands),
    readonlyFiles: normalizeProjectSessionReadonlyFiles(session),
    hiddenFiles: normalizeProjectSessionHiddenFiles(session),
    lifecycle: {
      createdAt,
      lastOpenedAt,
      ...(expiresAt ? { expiresAt } : {}),
      expirationBehavior: session.expirationBehavior ?? 'none',
    },
    ...(session.metadata ? { metadata: { ...session.metadata } } : {}),
  };
}


export function visibleProjectSessionCommands(
  commands: Record<string, RuntimeProjectSessionCommand>
): Record<string, RuntimeProjectSessionCommand> {
  const visible: Record<string, RuntimeProjectSessionCommand> = {};
  for (const [name, command] of Object.entries(commands)) {
    if (command.hidden === true) continue;
    visible[name] = command;
  }
  return visible;
}


export function publicProjectSessionInfo(session: RuntimeProjectSessionInfo): RuntimeProjectSessionInfo {
  return {
    ...session,
    commands: visibleProjectSessionCommands(session.commands),
  };
}
