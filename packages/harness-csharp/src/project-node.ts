import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, lstat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  emitRuntimeCommandFileChanges,
  emitRuntimeCommandOutput,
  readRuntimeCommandStdinPipeBytes,
  runtimeAbortSignalName,
  runtimeCommandStdinPipeClosed,
  runtimeSignalExitCode,
} from '@tracecode/harness-core';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventHandler,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeDirectory,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
  RuntimeCommandStdinSharedBuffer,
} from '@tracecode/harness-core';

export type CSharpProjectFileEncoding = RuntimeFileEncoding;
export type CSharpProjectFile = RuntimeFile;
export type CSharpProjectSnapshot = RuntimeProjectSnapshot;
export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;
export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;

export interface NativeCSharpProjectRunnerOptions {
  runtimeCommand?: string;
  timeoutMs?: number;
  keepTempDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const VIRTUAL_WORKSPACE_ROOT = '/workspace';
const ABORT_FORCE_KILL_MS = 500;
const GENERATED_PROJECT_PATH = '.tracecode-build/TraceCodeProject.csproj';

function emitCommandStatus(onEvent: RuntimeCommandEventHandler | undefined, phase: string, message: string, detail?: Record<string, unknown>): void {
  onEvent?.({ type: 'status', phase, message, ...(detail ? { detail } : {}) });
}

function shouldRestoreExecutableMode(path: string): boolean {
  const fileName = path.split('/').pop() ?? '';
  return path.startsWith('bin/') && fileName.length > 0 && !fileName.includes('.');
}

function assertSafeProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project file path must be relative: ${path}`);
  }

  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Project file path must not escape the workspace: ${path}`);
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new Error(`Project file path must point to a file: ${path}`);
  }
  return parts.join('/');
}

async function writeProjectFile(root: string, file: CSharpProjectFile): Promise<void> {
  const relativePath = assertSafeProjectPath(file.path);
  const targetPath = join(root, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });

  if (file.encoding === 'base64') {
    await writeFile(targetPath, Buffer.from(file.contents, 'base64'));
  } else {
    await writeFile(targetPath, file.contents, 'utf8');
  }
  if (file.mode !== undefined) {
    await chmod(targetPath, file.mode & 0o7777);
  } else if (file.encoding === 'base64' && shouldRestoreExecutableMode(relativePath)) {
    await chmod(targetPath, 0o755);
  }
  if (file.atimeMs !== undefined || file.mtimeMs !== undefined) {
    const info = await lstat(targetPath);
    await utimes(targetPath, new Date(file.atimeMs ?? info.atimeMs), new Date(file.mtimeMs ?? info.mtimeMs));
  }
}

async function writeProjectDirectory(root: string, path: string): Promise<void> {
  await mkdir(join(root, assertSafeProjectPath(path)), { recursive: true });
}

async function writeProjectDirectoryMetadata(root: string, metadata: RuntimeDirectory): Promise<void> {
  const absolutePath = join(root, assertSafeProjectPath(metadata.path));
  if (metadata.mode !== undefined) await chmod(absolutePath, metadata.mode & 0o7777);
  if (metadata.atimeMs !== undefined || metadata.mtimeMs !== undefined) {
    const info = await lstat(absolutePath);
    await utimes(
      absolutePath,
      new Date(metadata.atimeMs ?? info.atimeMs),
      new Date(metadata.mtimeMs ?? info.mtimeMs)
    );
  }
}

async function reapplyProjectMetadata(root: string, project: CSharpProjectSnapshot): Promise<void> {
  for (const file of project.files) {
    if (file.mode === undefined && file.atimeMs === undefined && file.mtimeMs === undefined) continue;
    const absolutePath = join(root, assertSafeProjectPath(file.path));
    if (file.mode !== undefined) await chmod(absolutePath, file.mode & 0o7777);
    if (file.atimeMs !== undefined || file.mtimeMs !== undefined) {
      const info = await lstat(absolutePath);
      await utimes(absolutePath, new Date(file.atimeMs ?? info.atimeMs), new Date(file.mtimeMs ?? info.mtimeMs));
    }
  }
  for (const metadata of project.directoryMetadata ?? []) {
    await writeProjectDirectoryMetadata(root, metadata);
  }
}

async function writeProjectSymlink(root: string, path: string, target: string): Promise<void> {
  const relativePath = assertSafeProjectPath(path);
  if (!target || target.includes('\0')) throw new Error(`Invalid symbolic link target for ${path}.`);
  const normalizedTarget = target.replace(/\\/g, '/');
  if (/^[A-Za-z]:/u.test(normalizedTarget) || isAbsolute(normalizedTarget)) {
    throw Object.assign(new Error(`ENOTSUP: absolute symbolic link targets are not supported by this runtime`), { code: 'ENOTSUP' });
  }
  const absolutePath = join(root, relativePath);
  const resolvedTarget = resolve(dirname(absolutePath), normalizedTarget);
  const targetFromRoot = relative(root, resolvedTarget);
  if (targetFromRoot === '..' || targetFromRoot.startsWith(`..${sep}`) || isAbsolute(targetFromRoot)) {
    throw Object.assign(new Error(`EACCES: symbolic link target escapes the workspace`), { code: 'EACCES' });
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  await symlink(normalizedTarget, absolutePath);
}

async function collectSymlinks(root: string, absolutePath: string, symlinks: Map<string, string>): Promise<void> {
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isSymbolicLink()) {
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('.tracecode-build/')) {
      symlinks.set(relativePath, await readlink(absolutePath));
    }
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(absolutePath)) {
    await collectSymlinks(root, join(absolutePath, entry), symlinks);
  }
}

async function snapshotSymlinks(root: string): Promise<Map<string, string>> {
  const symlinks = new Map<string, string>();
  await collectSymlinks(root, root, symlinks);
  return symlinks;
}

interface NativeDirectoryMetadata {
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

type NativeFileMetadata = NativeDirectoryMetadata;

async function collectFileMetadata(root: string, absolutePath: string, metadata: Map<string, NativeFileMetadata>): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await collectFileMetadata(root, join(absolutePath, entry), metadata);
    }
    return;
  }
  if (!info.isFile() || !relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;
  metadata.set(relativePath, { mode: info.mode & 0o7777, atimeMs: info.atimeMs, mtimeMs: info.mtimeMs });
}

async function snapshotFileMetadata(root: string): Promise<Map<string, NativeFileMetadata>> {
  const metadata = new Map<string, NativeFileMetadata>();
  await collectFileMetadata(root, root, metadata);
  return metadata;
}

async function collectDirectoryMetadata(root: string, absolutePath: string, metadata: Map<string, NativeDirectoryMetadata>): Promise<void> {
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isDirectory()) return;
  const entries = await readdir(absolutePath);
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('.tracecode-build/')) {
    metadata.set(relativePath, { mode: info.mode & 0o7777, atimeMs: info.atimeMs, mtimeMs: info.mtimeMs });
  }
  for (const entry of entries) {
    await collectDirectoryMetadata(root, join(absolutePath, entry), metadata);
  }
}

async function snapshotDirectoryMetadata(root: string): Promise<Map<string, NativeDirectoryMetadata>> {
  const metadata = new Map<string, NativeDirectoryMetadata>();
  await collectDirectoryMetadata(root, root, metadata);
  return metadata;
}

function fileBytes(file: CSharpProjectFile): Buffer {
  if (file.encoding === 'base64') return Buffer.from(file.contents, 'base64');
  return Buffer.from(file.contents, 'utf8');
}

async function collectFileBytes(root: string, absolutePath: string, files: Map<string, Buffer>): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await collectFileBytes(root, join(absolutePath, entry), files);
    }
    return;
  }

  if (!info.isFile()) return;

  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;
  const beforeRead = await lstat(absolutePath);
  const contents = await readFile(absolutePath);
  await utimes(absolutePath, beforeRead.atimeMs / 1000, beforeRead.mtimeMs / 1000);
  files.set(relativePath, contents);
}

async function collectDirectories(root: string, absolutePath: string, directories: Set<string>): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) return;

  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('.tracecode-build/')) {
    directories.add(relativePath);
  }
  for (const entry of await readdir(absolutePath)) {
    await collectDirectories(root, join(absolutePath, entry), directories);
  }
}

async function snapshotFileBytes(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await collectFileBytes(root, root, files);
  return files;
}

async function snapshotDirectories(root: string): Promise<Set<string>> {
  const directories = new Set<string>();
  await collectDirectories(root, root, directories);
  return directories;
}

function explicitlySnapshottedProjectDirectories(project: CSharpProjectSnapshot): Set<string> {
  return new Set((project.directories ?? []).map((directory) => assertSafeProjectPath(directory)));
}

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  baselineFiles: Map<string, Buffer>,
  baselineDirectories: Set<string>,
  deletableDirectories: Set<string>,
  baselineSymlinks: Map<string, string>,
  baselineFileMetadata: Map<string, NativeFileMetadata>,
  baselineDirectoryMetadata: Map<string, NativeDirectoryMetadata>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isSymbolicLink()) {
    if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;
    const target = await readlink(absolutePath);
    const baseline = baselineSymlinks.get(relativePath);
    baselineFiles.delete(relativePath);
    baselineFileMetadata.delete(relativePath);
    baselineDirectories.delete(relativePath);
    deletableDirectories.delete(relativePath);
    baselineDirectoryMetadata.delete(relativePath);
    baselineSymlinks.delete(relativePath);
    if (baseline !== target) files.push({ path: relativePath, symlink: true, target });
    return;
  }
  if (info.isDirectory()) {
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('.tracecode-build/')) {
      baselineFiles.delete(relativePath);
      baselineFileMetadata.delete(relativePath);
      baselineSymlinks.delete(relativePath);
      if (baselineDirectories.has(relativePath)) {
        baselineDirectories.delete(relativePath);
        deletableDirectories.delete(relativePath);
      } else {
        baselineDirectoryMetadata.delete(relativePath);
        files.push({ path: relativePath, directory: true });
      }
    }
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(
        root,
        join(absolutePath, entry),
        baselineFiles,
        baselineDirectories,
        deletableDirectories,
        baselineSymlinks,
        baselineFileMetadata,
        baselineDirectoryMetadata,
        files
      );
    }
    return;
  }

  if (!info.isFile()) return;

  if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;

  const currentInfo = await lstat(absolutePath);
  const currentMetadata: NativeFileMetadata = {
    mode: currentInfo.mode & 0o7777,
    atimeMs: currentInfo.atimeMs,
    mtimeMs: currentInfo.mtimeMs,
  };
  const contents = await readFile(absolutePath);
  await utimes(absolutePath, currentInfo.atimeMs / 1000, currentInfo.mtimeMs / 1000);
  baselineSymlinks.delete(relativePath);
  baselineDirectories.delete(relativePath);
  deletableDirectories.delete(relativePath);
  baselineDirectoryMetadata.delete(relativePath);
  const baseline = baselineFiles.get(relativePath);
  const baselineMetadata = baselineFileMetadata.get(relativePath);
  baselineFiles.delete(relativePath);
  baselineFileMetadata.delete(relativePath);
  const contentsUnchanged = baseline !== undefined && Buffer.compare(baseline, contents) === 0;
  const metadataUnchanged = baselineMetadata !== undefined
    && baselineMetadata.mode === currentMetadata.mode
    && baselineMetadata.atimeMs === currentMetadata.atimeMs
    && baselineMetadata.mtimeMs === currentMetadata.mtimeMs;
  if (contentsUnchanged && metadataUnchanged) return;

  const utf8 = contents.toString('utf8');
  files.push(
    Buffer.compare(Buffer.from(utf8, 'utf8'), contents) === 0
      ? { path: relativePath, contents: utf8, ...currentMetadata }
      : { path: relativePath, contents: contents.toString('base64'), encoding: 'base64', ...currentMetadata }
  );
}

async function changedProjectFiles(
  root: string,
  baselineFiles: Map<string, Buffer>,
  baselineDirectories: Set<string>,
  deletableDirectories: Set<string>,
  baselineSymlinks: Map<string, string>,
  baselineFileMetadata: Map<string, NativeFileMetadata>,
  baselineDirectoryMetadata: Map<string, NativeDirectoryMetadata>
): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  await collectChangedFiles(
    root,
    root,
    baselineFiles,
    baselineDirectories,
    deletableDirectories,
    baselineSymlinks,
    baselineFileMetadata,
    baselineDirectoryMetadata,
    files
  );
  for (const path of baselineFiles.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of deletableDirectories) {
    files.push({ path, directory: true, deleted: true });
  }
  for (const path of baselineSymlinks.keys()) {
    files.push({ path, deleted: true });
  }
  const currentDirectoryMetadata = await snapshotDirectoryMetadata(root);
  for (const [path, current] of currentDirectoryMetadata) {
    const baseline = baselineDirectoryMetadata.get(path);
    if (baseline && baseline.mode === current.mode && baseline.atimeMs === current.atimeMs && baseline.mtimeMs === current.mtimeMs) continue;
    const existing = files.find((change) => change.path === path && 'directory' in change && change.directory && !('deleted' in change && change.deleted));
    if (existing && 'directory' in existing) {
      Object.assign(existing, current);
    } else {
      files.push({ path, directory: true, ...current });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function projectVirtualRoot(project: CSharpProjectSnapshot): string {
  return project.workspaceRoot ?? project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
}

function projectVirtualAliases(project: CSharpProjectSnapshot): string[] {
  return Array.from(new Set([project.workspaceAlias, VIRTUAL_WORKSPACE_ROOT].filter((alias): alias is string => Boolean(alias && alias !== projectVirtualRoot(project)))));
}

function stripProjectVirtualPrefix(value: string, project: CSharpProjectSnapshot): string | null {
  const stripSafe = (relativePath: string): string => relativePath ? assertSafeProjectPath(relativePath) : '';
  const normalized = value.replace(/\\/g, '/');
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return '';
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) return stripSafe(normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
  const roots = [projectVirtualRoot(project), ...projectVirtualAliases(project)];
  for (const root of roots) {
    if (normalized === root) return '';
    if (normalized.startsWith(`${root}/`)) return stripSafe(normalized.slice(root.length + 1));
  }
  return null;
}

function cwdForRequest(request: CSharpProjectCommandRequest, root: string): string {
  const relativeCwd = stripProjectVirtualPrefix(request.cwd, request.project);
  if (relativeCwd !== null) {
    return relativeCwd ? join(root, relativeCwd) : root;
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function mapWorkspaceAbsolutePath(root: string, value: string, project?: CSharpProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  const relativePath = project ? stripProjectVirtualPrefix(normalized, project) : null;
  if (relativePath !== null) {
    return relativePath ? join(root, relativePath) : root;
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return root;
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    const relativePath = normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1);
    return relativePath ? join(root, assertSafeProjectPath(relativePath)) : root;
  }
  return value;
}

function isDotnetSlashPropertySwitch(value: string): boolean {
  return /^\/(?:p|property)(?:[:=]|$)/i.test(value);
}

function mapWorkspaceBuildArg(root: string, value: string, project?: CSharpProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceAbsolutePath(root, normalized, project);
  }
  if (
    (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) &&
    normalized !== VIRTUAL_WORKSPACE_ROOT &&
    !normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`) &&
    !isDotnetSlashPropertySwitch(normalized)
  ) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return mapWorkspaceAbsolutePath(root, value, project);
}

function projectDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function relativeVirtualWorkspacePath(path: string, project?: CSharpProjectSnapshot): string {
  const normalized = path.replace(/\\/g, '/');
  const relativePath = project ? stripProjectVirtualPrefix(normalized, project) : null;
  if (relativePath !== null) {
    return relativePath ? assertSafeProjectPath(relativePath) : '';
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return '';
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return assertSafeProjectPath(normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
  }
  return assertSafeProjectPath(normalized);
}

function resolveProjectOperandPath(request: CSharpProjectCommandRequest, value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const relativePath = stripProjectVirtualPrefix(normalized, request.project);
  if (relativePath !== null) {
    return relativePath ? assertSafeProjectPath(relativePath) : '';
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT || normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return relativeVirtualWorkspacePath(normalized);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return normalizeProjectItemPath(relativeVirtualWorkspacePath(request.cwd, request.project), normalized, request.project);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeProjectItemPath(projectDirectoryPath: string, value: string, project?: CSharpProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('$(') || normalized.includes('%(')) return '';
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }

  const strippedPath = project ? stripProjectVirtualPrefix(normalized, project) : null;
  const relativePath = strippedPath !== null
    ? strippedPath
    : normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)
    ? normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1)
    : normalized;
  if (relativePath.startsWith('/')) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }

  const parts: string[] = [];
  const combinedPath = projectDirectoryPath && strippedPath === null && !normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)
    ? `${projectDirectoryPath}/${relativePath}`
    : relativePath;
  for (const part of combinedPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Project path must stay inside the workspace: ${value}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return parts.join('/');
}

function validateProjectItemValue(projectDirectoryPath: string, value: string, project: CSharpProjectSnapshot): void {
  for (const item of value.split(';').map((part) => part.trim()).filter(Boolean)) {
    normalizeProjectItemPath(projectDirectoryPath, item, project);
  }
}

function validateNativeProjectFileItems(project: CSharpProjectSnapshot): void {
  const projectFiles = project.files.filter((file) => file.path.endsWith('.csproj') && file.encoding !== 'base64');
  for (const file of projectFiles) {
    const projectPath = assertSafeProjectPath(file.path);
    const directoryPath = projectDirectory(projectPath);
    const contents = file.contents;

    for (const tagMatch of contents.matchAll(/<(?:Compile|EmbeddedResource|ProjectReference)\b[^>]*>/gi)) {
      const tag = tagMatch[0] ?? '';
      for (const attributeMatch of tag.matchAll(/\s(?:Include|Remove|Exclude)\s*=\s*["']([^"']+)["']/gi)) {
        validateProjectItemValue(directoryPath, decodeXmlText(attributeMatch[1] ?? ''), project);
      }
    }
    for (const match of contents.matchAll(/<HintPath\b[^>]*>([\s\S]*?)<\/HintPath>/gi)) {
      validateProjectItemValue(directoryPath, decodeXmlText(match[1] ?? ''), project);
    }
  }
}

function pathContainsCwd(projectPath: string, cwd: string): boolean {
  const directory = projectDirectory(projectPath);
  return directory.length === 0 || cwd === directory || cwd.startsWith(`${directory}/`);
}

function existingProjectPath(project: CSharpProjectSnapshot, requestCwd: string): string | null {
  const cwd = relativeVirtualWorkspacePath(requestCwd, project);
  const candidates = project.files
    .map((file) => file.path)
    .filter((path) => path.endsWith('.csproj'))
    .map(assertSafeProjectPath)
    .sort((left, right) => {
      const leftContainsCwd = pathContainsCwd(left, cwd);
      const rightContainsCwd = pathContainsCwd(right, cwd);
      if (leftContainsCwd !== rightContainsCwd) return leftContainsCwd ? -1 : 1;
      return left.localeCompare(right);
    });
  return candidates[0] ?? null;
}

async function ensureProjectFile(root: string, request: CSharpProjectCommandRequest): Promise<string> {
  if (request.scriptPath.endsWith('.csproj')) {
    return resolveProjectOperandPath(request, request.scriptPath);
  }

  const existing = existingProjectPath(request.project, request.cwd);
  if (existing) return existing;

  const cwd = relativeVirtualWorkspacePath(request.cwd, request.project);
  const compileInclude = cwd ? `../${cwd}/**/*.cs` : '../**/*.cs';
  const excludePaths = cwd
    ? `../${cwd}/bin/**;../${cwd}/obj/**`
    : '../bin/**;../obj/**';
  const targetPath = join(root, GENERATED_PROJECT_PATH);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <OutputType>Exe</OutputType>',
      '    <TargetFramework>net10.0</TargetFramework>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '    <Nullable>disable</Nullable>',
      '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
      '    <BaseOutputPath>../bin/</BaseOutputPath>',
      '    <BaseIntermediateOutputPath>../obj/</BaseIntermediateOutputPath>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      `    <Compile Include="${compileInclude}" Exclude="../.tracecode-build/**;${excludePaths}" />`,
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n'),
    'utf8'
  );
  return GENERATED_PROJECT_PATH;
}

function mappedDotnetArgs(root: string, args: string[], project: CSharpProjectSnapshot): string[] {
  return args.map((arg) => mapWorkspaceBuildArg(root, arg, project));
}

function buildArgsForRequest(request: CSharpProjectCommandRequest): string[] {
  const buildArgs = request.options?.buildArgs;
  return Array.isArray(buildArgs) ? buildArgs.filter((arg): arg is string => typeof arg === 'string') : [];
}

function shouldSkipBuildForRequest(request: CSharpProjectCommandRequest): boolean {
  return request.options?.noBuild === true || buildArgsForRequest(request).includes('--no-build');
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdinPipe?: RuntimeCommandStdinSharedBuffer;
    signal?: AbortSignal;
    timeoutMs: number;
    timeoutLabel: string;
    onEvent?: RuntimeCommandEventHandler;
  }
): Promise<CSharpProjectCommandResult> {
  return new Promise<CSharpProjectCommandResult>((resolveResult) => {
    emitCommandStatus(options.onEvent, 'process-start', `Starting ${command}`, { command, args, cwd: options.cwd });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        HOME: options.env.HOME ?? options.cwd,
        DOTNET_CLI_HOME: options.env.DOTNET_CLI_HOME ?? options.cwd,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let abortedSignal: string | null = null;
    let abortForceKill: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CSharpProjectCommandResult, phase: string, message: string, detail: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortForceKill) clearTimeout(abortForceKill);
      options.signal?.removeEventListener('abort', abort);
      emitCommandStatus(options.onEvent, phase, message, detail);
      resolveResult(result);
    };

    const abort = (): void => {
      if (settled) return;
      abortedSignal = runtimeAbortSignalName(options.signal);
      child.kill(abortedSignal as NodeJS.Signals);
      abortForceKill = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, ABORT_FORCE_KILL_MS);
      abortForceKill.unref?.();
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const timeoutStderr = `${options.timeoutLabel}: execution timed out after ${options.timeoutMs}ms\n`;
      emitRuntimeCommandOutput(options.onEvent, 'stderr', timeoutStderr);
      emitCommandStatus(options.onEvent, 'process-exit', `${command} timed out`, { command, exitCode: 124, timeoutMs: options.timeoutMs });
      resolveResult({
        stdout,
        stderr: `${stderr}${timeoutStderr}`,
        exitCode: 124,
      });
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    child.stdout.on('data', (chunk) => {
      const data = String(chunk);
      stdout += data;
      emitRuntimeCommandOutput(options.onEvent, 'stdout', data);
    });
    child.stderr.on('data', (chunk) => {
      const data = String(chunk);
      stderr += data;
      emitRuntimeCommandOutput(options.onEvent, 'stderr', data);
    });
    child.on('error', (error) => {
      if (settled) return;
      emitRuntimeCommandOutput(options.onEvent, 'stderr', `${error.message}\n`);
      settle(
        { stdout, stderr: `${stderr}${error.message}\n`, exitCode: 1 },
        'process-error',
        `${command} failed to start`,
        { command, error: error.message }
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      const exitCode = abortedSignal ? runtimeSignalExitCode(abortedSignal) : code ?? 1;
      settle(
        { stdout, stderr, exitCode },
        'process-exit',
        abortedSignal ? `${command} interrupted` : `${command} exited`,
        { command, exitCode, ...(abortedSignal ? { signal: abortedSignal } : {}) }
      );
    });

    if (options.stdinPipe) {
      void pumpStdinPipeToChild(options.stdinPipe, child.stdin).catch(() => undefined);
    } else {
      child.stdin.end();
    }
  });
}

async function pumpStdinPipeToChild(pipe: RuntimeCommandStdinSharedBuffer, stdin: NonNullable<ReturnType<typeof spawn>['stdin']>): Promise<void> {
  while (true) {
    const bytes = readRuntimeCommandStdinPipeBytes(pipe);
    if (bytes.byteLength > 0) {
      if (!stdin.write(Buffer.from(bytes))) {
        await once(stdin, 'drain').catch(() => undefined);
      }
      continue;
    }
    if (runtimeCommandStdinPipeClosed(pipe)) break;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  stdin.end();
}

async function resolveDotnetCommand(command: string): Promise<string> {
  if (command !== 'dotnet') return command;
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'dotnet'));
  for (const candidate of [
    ...pathCandidates,
    '/opt/homebrew/bin/dotnet',
    '/usr/local/bin/dotnet',
    '/usr/local/share/dotnet/dotnet',
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common install location.
    }
  }
  return command;
}

export function createNativeCSharpProjectRunner(
  options: NativeCSharpProjectRunnerOptions = {}
): CSharpProjectCommandRunner {
  const runtimeCommand = options.runtimeCommand ?? 'dotnet';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const resolvedDotnetCommand = await resolveDotnetCommand(runtimeCommand);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-csharp-project-')));
    try {
      validateNativeProjectFileItems(request.project);
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }
      for (const symlinkEntry of request.project.symlinks ?? []) {
        await writeProjectSymlink(root, symlinkEntry.path, symlinkEntry.target);
      }
      for (const metadata of request.project.directoryMetadata ?? []) {
        await writeProjectDirectoryMetadata(root, metadata);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });
      const projectPath = await ensureProjectFile(root, request);
      const projectArg = join(root, projectPath);

      if (request.source === 'compile') {
        const baselineFileMetadata = await snapshotFileMetadata(root);
        const baseline = await snapshotFileBytes(root);
        const baselineDirectories = await snapshotDirectories(root);
        const deletableDirectories = explicitlySnapshottedProjectDirectories(request.project);
        const baselineSymlinks = await snapshotSymlinks(root);
        const baselineDirectoryMetadata = await snapshotDirectoryMetadata(root);
        const result = await runProcess(resolvedDotnetCommand, ['build', projectArg, '--nologo', ...mappedDotnetArgs(root, request.args, request.project)], {
          cwd,
          env: request.env,
          stdinPipe: request.stdinPipe,
          signal: request.signal,
          timeoutMs,
          timeoutLabel: 'dotnet build',
          onEvent: request.onEvent,
        });
        if (result.exitCode !== 0) return result;
        await reapplyProjectMetadata(root, request.project);
        const files = await changedProjectFiles(
          root,
          baseline,
          baselineDirectories,
          deletableDirectories,
          baselineSymlinks,
          baselineFileMetadata,
          baselineDirectoryMetadata
        );
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...result, files };
      }

      if (!shouldSkipBuildForRequest(request)) {
        const build = await runProcess(resolvedDotnetCommand, ['build', projectArg, '--nologo', ...mappedDotnetArgs(root, buildArgsForRequest(request), request.project)], {
          cwd,
          env: request.env,
          signal: request.signal,
          timeoutMs,
          timeoutLabel: 'dotnet build',
          onEvent: request.onEvent,
        });
        if (build.exitCode !== 0) return build;
      }

      await reapplyProjectMetadata(root, request.project);
      const baselineFileMetadata = await snapshotFileMetadata(root);
      const baseline = await snapshotFileBytes(root);
      const baselineDirectories = await snapshotDirectories(root);
      const deletableDirectories = explicitlySnapshottedProjectDirectories(request.project);
      const baselineSymlinks = await snapshotSymlinks(root);
      const baselineDirectoryMetadata = await snapshotDirectoryMetadata(root);
      const run = await runProcess(resolvedDotnetCommand, ['run', '--project', projectArg, '--no-build', '--no-launch-profile', '--', ...request.args], {
        cwd,
        env: request.env,
        stdinPipe: request.stdinPipe,
        signal: request.signal,
        timeoutMs,
        timeoutLabel: 'dotnet run',
        onEvent: request.onEvent,
      });
      const files = await changedProjectFiles(
        root,
        baseline,
        baselineDirectories,
        deletableDirectories,
        baselineSymlinks,
        baselineFileMetadata,
        baselineDirectoryMetadata
      );
      emitRuntimeCommandFileChanges(request.onEvent, files);
      return { ...run, files };
    } finally {
      if (!options.keepTempDir) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
