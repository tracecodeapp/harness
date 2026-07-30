import {
  defineCommand,
} from 'just-bash/browser';
import {
  applyRuntimeCommandResultFiles,
  canCreateRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipe,
  createRuntimeCommandStdinPipeFromText,
  normalizeRuntimeProjectPath,
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
import { DEFAULT_CWD, TRACEKERNEL_BIN_PATH, TRACEKERNEL_SKILLS_ROOT } from './constants';

export { normalizeRuntimeProjectPath };


export function normalizeTraceKernelVirtualPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  return normalizeTerminalAbsolutePath(path);
}


export function isTraceKernelVirtualNamespacePath(path: string): boolean {
  const normalized = normalizeTraceKernelVirtualPath(path);
  return normalized === '/tracekernel' || normalized?.startsWith('/tracekernel/') === true;
}


export function traceKernelBinCommandName(path: string): string | null {
  const normalized = normalizeTraceKernelVirtualPath(path);
  if (!normalized?.startsWith(`${TRACEKERNEL_BIN_PATH}/`)) return null;
  const name = normalized.slice(TRACEKERNEL_BIN_PATH.length + 1);
  return name && !name.includes('/') ? name : null;
}


export function normalizeRuntimeSkillPath(path: string): string {
  assertNoNul(path, 'Skill path');
  const raw = path.replace(/\\/g, '/');
  if (raw === TRACEKERNEL_SKILLS_ROOT || raw === `${TRACEKERNEL_SKILLS_ROOT}/`) {
    throw new Error('Skill path must point to a file.');
  }
  if (raw.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)) {
    return normalizeRuntimeProjectPath(raw.slice(TRACEKERNEL_SKILLS_ROOT.length + 1));
  }
  if (raw.startsWith('/')) {
    throw new Error(`Skill path must stay inside ${TRACEKERNEL_SKILLS_ROOT}: ${path}`);
  }
  return normalizeRuntimeProjectPath(raw);
}


export function runtimeSkillAbsolutePath(path: string): string {
  return `${TRACEKERNEL_SKILLS_ROOT}/${normalizeRuntimeSkillPath(path)}`;
}


export function normalizeRuntimeSkillsVirtualPath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const normalized = normalizeTerminalAbsolutePath(path);
  return normalized === TRACEKERNEL_SKILLS_ROOT || normalized.startsWith(`${TRACEKERNEL_SKILLS_ROOT}/`)
    ? normalized
    : null;
}


export function isRuntimeSkillsNamespacePath(path: string): boolean {
  return normalizeRuntimeSkillsVirtualPath(path) !== null;
}


export function assertNoNul(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`${label} must not contain NUL bytes.`);
  }
}


export function normalizeWorkspaceCwd(cwd: string | undefined): string {
  const raw = cwd ?? DEFAULT_CWD;
  assertNoNul(raw, 'Workspace cwd');
  if (!raw.startsWith('/')) {
    throw new Error(`Workspace cwd must be absolute: ${raw}`);
  }

  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}


export function mapWorkspaceAlias(workspaceRoot: string, workspaceAlias: string | undefined, absolutePath: string): string {
  if (!workspaceAlias || workspaceAlias === workspaceRoot) return absolutePath;
  if (absolutePath === workspaceAlias) return workspaceRoot;
  if (absolutePath.startsWith(`${workspaceAlias}/`)) {
    return `${workspaceRoot}${absolutePath.slice(workspaceAlias.length)}`;
  }
  return absolutePath;
}


export function toWorkspacePath(cwd: string, path: string, workspaceAlias?: string): string {
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


export function toWorkspaceEntryPath(cwd: string, path: string, workspaceAlias?: string): string {
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


export function resolveWorkspaceCommandPath(workspaceRoot: string, cwd: string, path: string, workspaceAlias?: string): string {
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


export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}


export function isWithinWorkspace(cwd: string, absolutePath: string): boolean {
  return absolutePath === cwd || absolutePath.startsWith(`${cwd}/`);
}


export function toProjectPath(cwd: string, absolutePath: string): string {
  if (absolutePath === cwd) return '';
  return absolutePath.slice(cwd.length + 1);
}


export function toProjectDirectoryPath(cwd: string, absolutePath: string): string | null {
  const relativePath = toProjectPath(cwd, absolutePath);
  return relativePath || null;
}


export function toWorkspaceRelativePath(cwd: string, path: string, workspaceAlias?: string): string {
  const relativePath = toProjectPath(cwd, toWorkspacePath(cwd, path, workspaceAlias));
  if (!relativePath) {
    throw new Error(`Project path must point to a file: ${path}`);
  }
  return relativePath;
}


export function resolveWorkspaceContextPath(
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


export function normalizeTerminalAbsolutePath(path: string): string {
  assertNoNul(path, 'Terminal path');
  if (!path.startsWith('/')) throw new Error(`Terminal path must be absolute: ${path}`);
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}


export function terminalCwdLabel(workspaceRoot: string, cwd: string, home: string): string {
  if (cwd === workspaceRoot) {
    const workspaceName = workspaceRoot.split('/').filter(Boolean).at(-1);
    return workspaceName || '/';
  }
  if (cwd === home) return '~';
  const cwdName = cwd.split('/').filter(Boolean).at(-1);
  return cwdName || '/';
}


export function hasWorkspaceGlob(value: string): boolean {
  return /[*?[]/.test(value);
}


export function globSegmentToRegExp(segment: string): RegExp {
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


export function formatExpandedGlobPath(original: string, workspaceRoot: string, absolutePath: string): string {
  if (original.startsWith('/')) return absolutePath;
  return toProjectPath(workspaceRoot, absolutePath);
}


export async function expandWorkspaceGlobArg(
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


export async function expandWorkspaceGlobArgs(
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


export async function expandParsedScriptInvocation(
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


export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
