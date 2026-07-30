import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import {
  emitRuntimeCommandFileChanges,
  emitRuntimeCommandOutput,
  readRuntimeCommandStdinPipeBytes,
  runtimeAbortSignalName,
  runtimeCommandStdinPipeClosed,
  runtimeSignalExitCode,
} from '@tracecode/runtime-core';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventHandler,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
  RuntimeCommandStdinSharedBuffer,
} from '@tracecode/runtime-core';

export type JavaProjectFileEncoding = RuntimeFileEncoding;
export type JavaProjectFile = RuntimeFile;
export type JavaProjectSnapshot = RuntimeProjectSnapshot;
export type JavaProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type JavaProjectCommandResult = RuntimeCommandResult;
export type JavaProjectCommandRunner = RuntimeProjectCommandRunner<JavaProjectCommandRequest>;

export interface NativeJavaProjectRunnerOptions {
  javacCommand?: string;
  javaCommand?: string;
  timeoutMs?: number;
  keepTempDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const VIRTUAL_WORKSPACE_ROOT = '/workspace';
const ABORT_FORCE_KILL_MS = 500;

function emitCommandStatus(onEvent: RuntimeCommandEventHandler | undefined, phase: string, message: string, detail?: Record<string, unknown>): void {
  onEvent?.({ type: 'status', phase, message, ...(detail ? { detail } : {}) });
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

function assertSafeMainClass(value: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(value)) {
    throw new Error(`Java main class must be a class name: ${value}`);
  }
  return value;
}

async function writeProjectFile(root: string, file: JavaProjectFile): Promise<void> {
  const relativePath = assertSafeProjectPath(file.path);
  const targetPath = join(root, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });

  if (file.encoding === 'base64') {
    await writeFile(targetPath, Buffer.from(file.contents, 'base64'));
    return;
  }

  await writeFile(targetPath, file.contents, 'utf8');
}

async function writeProjectDirectory(root: string, path: string): Promise<void> {
  await mkdir(join(root, assertSafeProjectPath(path)), { recursive: true });
}

function workspaceRelativeSymlinkTarget(root: string, linkPath: string, target: string): string {
  if (target.includes('\0')) throw new Error('Project symlink target must not contain NUL bytes.');
  const normalized = target.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Native Java project provider cannot preserve absolute symlink target: ${target}`);
  }
  const materializedTarget = resolve(dirname(linkPath), normalized);
  const relativeTarget = relative(root, materializedTarget).replace(/\\/g, '/');
  if (relativeTarget.startsWith('..')) {
    throw new Error(`Project symlink target must stay inside the workspace: ${target}`);
  }
  return normalized;
}

async function writeProjectSymlink(
  root: string,
  entry: NonNullable<JavaProjectSnapshot['symlinks']>[number]
): Promise<void> {
  const relativePath = assertSafeProjectPath(entry.path);
  const linkPath = join(root, relativePath);
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(workspaceRelativeSymlinkTarget(root, linkPath, entry.target), linkPath);
}

async function applyProjectDirectoryMetadata(
  root: string,
  entry: NonNullable<JavaProjectSnapshot['directoryMetadata']>[number]
): Promise<void> {
  const targetPath = join(root, assertSafeProjectPath(entry.path));
  await mkdir(targetPath, { recursive: true });
  if (entry.mode !== undefined) {
    await chmod(targetPath, entry.mode & 0o7777);
  }
  if (entry.atimeMs !== undefined || entry.mtimeMs !== undefined) {
    const current = await stat(targetPath);
    await utimes(
      targetPath,
      entry.atimeMs === undefined ? current.atime : new Date(entry.atimeMs),
      entry.mtimeMs === undefined ? current.mtime : new Date(entry.mtimeMs)
    );
  }
}

async function applyProjectFileMetadata(root: string, file: JavaProjectFile): Promise<void> {
  if (file.mode === undefined && file.atimeMs === undefined && file.mtimeMs === undefined) return;
  const targetPath = join(root, assertSafeProjectPath(file.path));
  if (file.mode !== undefined) {
    await chmod(targetPath, file.mode & 0o7777);
  }
  if (file.atimeMs !== undefined || file.mtimeMs !== undefined) {
    const current = await stat(targetPath);
    await utimes(
      targetPath,
      file.atimeMs === undefined ? current.atime : new Date(file.atimeMs),
      file.mtimeMs === undefined ? current.mtime : new Date(file.mtimeMs)
    );
  }
}

function fileBytes(file: JavaProjectFile): Buffer {
  if (file.encoding === 'base64') {
    return Buffer.from(file.contents, 'base64');
  }
  return Buffer.from(file.contents, 'utf8');
}

function javaSourceFiles(project: JavaProjectSnapshot): string[] {
  return project.files
    .map((file) => file.path)
    .filter((path) => path.endsWith('.java'))
    .map(assertSafeProjectPath)
    .sort();
}

function projectVirtualRoot(project: JavaProjectSnapshot): string {
  return project.workspaceRoot ?? project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
}

function projectVirtualAliases(project: JavaProjectSnapshot): string[] {
  return Array.from(new Set([project.workspaceAlias, VIRTUAL_WORKSPACE_ROOT].filter((alias): alias is string => Boolean(alias && alias !== projectVirtualRoot(project)))));
}

function stripProjectVirtualPrefix(value: string, project: JavaProjectSnapshot): string | null {
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

function cwdForRequest(request: JavaProjectCommandRequest, root: string): string {
  const relativeCwd = stripProjectVirtualPrefix(request.cwd, request.project);
  if (relativeCwd !== null) {
    return relativeCwd ? join(root, relativeCwd) : root;
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function mapWorkspaceAbsolutePath(root: string, value: string, project?: JavaProjectSnapshot): string {
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

function mapWorkspaceProjectPath(root: string, value: string, project?: JavaProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceAbsolutePath(root, normalized, project);
  }
  if (normalized.startsWith('/') && normalized !== VIRTUAL_WORKSPACE_ROOT && !normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return mapWorkspaceAbsolutePath(root, value);
}

function assertWorkspaceRelativeOperand(root: string, cwd: string, value: string, label: string, project?: JavaProjectSnapshot): string {
  if (value.length === 0) return value;
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceAbsolutePath(root, normalized, project);
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT || normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, normalized);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`${label} must stay inside the workspace: ${value}`);
  }
  const absolute = resolve(cwd, normalized);
  const relativePath = relative(root, absolute).replace(/\\/g, '/');
  if (relativePath === '') return value;
  if (relativePath.startsWith('..')) {
    throw new Error(`${label} must stay inside the workspace: ${value}`);
  }
  return value;
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
  if (!relativePath || relativePath.startsWith('..')) return;
  files.set(relativePath, await readFile(absolutePath));
}

async function collectDirectories(root: string, absolutePath: string, directories: Set<string>): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) return;

  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..')) directories.add(relativePath);
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

interface NativeDirectoryMetadata {
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

type NativeFileMetadata = NativeDirectoryMetadata;

function nativeDirectoryMetadata(info: { mode: number; atimeMs: number; mtimeMs: number }): NativeDirectoryMetadata {
  return {
    mode: info.mode & 0o7777,
    atimeMs: info.atimeMs,
    mtimeMs: info.mtimeMs,
  };
}

async function collectDirectoryMetadata(
  root: string,
  absolutePath: string,
  metadata: Map<string, NativeDirectoryMetadata>
): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  for (const entry of await readdir(absolutePath)) {
    await collectDirectoryMetadata(root, join(absolutePath, entry), metadata);
  }
  if (relativePath && !relativePath.startsWith('..')) {
    // Capture after readdir so the baseline includes any atime transition caused
    // by the snapshot traversal itself (notably on relatime-style mounts).
    metadata.set(relativePath, nativeDirectoryMetadata(await lstat(absolutePath)));
  }
}

async function snapshotDirectoryMetadata(root: string): Promise<Map<string, NativeDirectoryMetadata>> {
  const metadata = new Map<string, NativeDirectoryMetadata>();
  await collectDirectoryMetadata(root, root, metadata);
  return metadata;
}

async function collectFileMetadata(
  root: string,
  absolutePath: string,
  metadata: Map<string, NativeFileMetadata>
): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await collectFileMetadata(root, join(absolutePath, entry), metadata);
    }
    return;
  }
  if (!info.isFile()) return;
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..')) {
    metadata.set(relativePath, nativeDirectoryMetadata(info));
  }
}

async function snapshotFileMetadata(root: string): Promise<Map<string, NativeFileMetadata>> {
  const metadata = new Map<string, NativeFileMetadata>();
  await collectFileMetadata(root, root, metadata);
  return metadata;
}

function directoryMetadataChanged(left: NativeDirectoryMetadata, right: NativeDirectoryMetadata): boolean {
  return left.mode !== right.mode || left.atimeMs !== right.atimeMs || left.mtimeMs !== right.mtimeMs;
}

async function collectSymlinkTargets(root: string, absolutePath: string, symlinks: Map<string, string>): Promise<void> {
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isSymbolicLink()) {
    if (relativePath && !relativePath.startsWith('..')) {
      symlinks.set(relativePath, await readlink(absolutePath));
    }
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(absolutePath)) {
    await collectSymlinkTargets(root, join(absolutePath, entry), symlinks);
  }
}

async function snapshotSymlinkTargets(root: string): Promise<Map<string, string>> {
  const symlinks = new Map<string, string>();
  await collectSymlinkTargets(root, root, symlinks);
  return symlinks;
}

function explicitlySnapshottedProjectDirectories(project: JavaProjectSnapshot): Set<string> {
  return new Set((project.directories ?? []).map((directory) => assertSafeProjectPath(directory)));
}

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  baselineFiles: Map<string, Buffer>,
  baselineFileMetadata: Map<string, NativeFileMetadata>,
  baselineSymlinks: Map<string, string>,
  baselineDirectories: Set<string>,
  baselineDirectoryMetadata: Map<string, NativeDirectoryMetadata>,
  deletableDirectories: Set<string>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await lstat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isSymbolicLink()) {
    if (!relativePath || relativePath.startsWith('..')) return;
    const target = await readlink(absolutePath);
    const baseline = baselineSymlinks.get(relativePath);
    baselineSymlinks.delete(relativePath);
    baselineFiles.delete(relativePath);
    baselineFileMetadata.delete(relativePath);
    baselineDirectories.delete(relativePath);
    baselineDirectoryMetadata.delete(relativePath);
    deletableDirectories.delete(relativePath);
    if (baseline !== target) files.push({ path: relativePath, symlink: true, target });
    return;
  }
  if (info.isDirectory()) {
    let previousMetadata: NativeDirectoryMetadata | undefined;
    let existedAtBaseline = false;
    if (relativePath && !relativePath.startsWith('..')) {
      baselineFiles.delete(relativePath);
      baselineFileMetadata.delete(relativePath);
      baselineSymlinks.delete(relativePath);
      previousMetadata = baselineDirectoryMetadata.get(relativePath);
      baselineDirectoryMetadata.delete(relativePath);
      if (baselineDirectories.has(relativePath)) {
        existedAtBaseline = true;
        baselineDirectories.delete(relativePath);
        deletableDirectories.delete(relativePath);
      }
    }
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(
        root,
        join(absolutePath, entry),
        baselineFiles,
        baselineFileMetadata,
        baselineSymlinks,
        baselineDirectories,
        baselineDirectoryMetadata,
        deletableDirectories,
        files
      );
    }
    if (relativePath && !relativePath.startsWith('..')) {
      // Compare after walking children, matching snapshotDirectoryMetadata's
      // ordering so this scanner cannot manufacture an atime-only final diff.
      const currentMetadata = nativeDirectoryMetadata(await lstat(absolutePath));
      if (!existedAtBaseline || (previousMetadata && directoryMetadataChanged(previousMetadata, currentMetadata))) {
        files.push({ path: relativePath, directory: true, ...currentMetadata });
      }
    }
    return;
  }

  if (!info.isFile()) return;

  if (!relativePath || relativePath.startsWith('..')) return;

  const contents = await readFile(absolutePath);
  const baseline = baselineFiles.get(relativePath);
  const currentMetadata = nativeDirectoryMetadata(info);
  const baselineMetadata = baselineFileMetadata.get(relativePath);
  baselineFiles.delete(relativePath);
  baselineFileMetadata.delete(relativePath);
  baselineSymlinks.delete(relativePath);
  baselineDirectories.delete(relativePath);
  baselineDirectoryMetadata.delete(relativePath);
  deletableDirectories.delete(relativePath);
  if (
    baseline &&
    Buffer.compare(baseline, contents) === 0 &&
    baselineMetadata &&
    !directoryMetadataChanged(baselineMetadata, currentMetadata)
  ) return;

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
  baselineFileMetadata: Map<string, NativeFileMetadata>,
  baselineSymlinks: Map<string, string>,
  baselineDirectories: Set<string>,
  baselineDirectoryMetadata: Map<string, NativeDirectoryMetadata>,
  deletableDirectories: Set<string>
): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  await collectChangedFiles(
    root,
    root,
    baselineFiles,
    baselineFileMetadata,
    baselineSymlinks,
    baselineDirectories,
    baselineDirectoryMetadata,
    deletableDirectories,
    files
  );
  for (const path of baselineFiles.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of baselineSymlinks.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of deletableDirectories) {
    files.push({ path, directory: true, deleted: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function mapJavaClasspath(root: string, cwd: string, classpath: string, project?: JavaProjectSnapshot): string {
  return classpath
    .split(delimiter)
    .map((entry) => assertWorkspaceRelativeOperand(root, cwd, entry, 'Java classpath entry', project))
    .join(delimiter);
}

function parseJavaArgFile(contents: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaping = false;
  for (const ch of contents) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current.length > 0) args.push(current);
  return args;
}

function projectRelativeCwd(request: JavaProjectCommandRequest): string {
  const relativeCwd = stripProjectVirtualPrefix(request.cwd, request.project);
  if (relativeCwd !== null) {
    return relativeCwd;
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function resolveProjectCommandPath(request: JavaProjectCommandRequest, path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const relativePath = stripProjectVirtualPrefix(normalized, request.project);
  if (relativePath !== null) {
    return relativePath ? assertSafeProjectPath(relativePath) : '';
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return '';
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return assertSafeProjectPath(normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
  }
  if (normalized.startsWith('/')) {
    throw new Error(`Java argfile path must stay inside the workspace: ${path}`);
  }
  const relativeCwd = projectRelativeCwd(request);
  return assertSafeProjectPath(relativeCwd ? `${relativeCwd}/${normalized}` : normalized);
}

function expandedJavacArgsForRequest(request: JavaProjectCommandRequest): string[] {
  if (request.source !== 'compile') return request.args;
  const files = new Map(request.project.files.map((file) => [assertSafeProjectPath(file.path), file]));
  const expand = (args: string[], seen: Set<string>): string[] => {
    const expanded: string[] = [];
    for (const arg of args) {
      if (!arg.startsWith('@') || arg === '@') {
        expanded.push(arg);
        continue;
      }
      const argfilePath = resolveProjectCommandPath(request, arg.slice(1));
      if (seen.has(argfilePath)) {
        throw new Error(`Recursive Java argfile reference: ${argfilePath}`);
      }
      const file = files.get(argfilePath);
      if (!file) {
        throw new Error(`Java argfile not found: ${argfilePath}`);
      }
      if (file.encoding === 'base64') {
        throw new Error(`Java argfile must be utf8: ${argfilePath}`);
      }
      seen.add(argfilePath);
      expanded.push(...expand(parseJavaArgFile(file.contents), seen));
      seen.delete(argfilePath);
    }
    return expanded;
  };
  return expand(request.args, new Set());
}

function mapJavaPathList(root: string, cwd: string, value: string, project?: JavaProjectSnapshot): string {
  return value
    .split(delimiter)
    .map((entry) => assertWorkspaceRelativeOperand(root, cwd, entry, 'Java path entry', project))
    .join(delimiter);
}

function javacArgsForRequest(request: JavaProjectCommandRequest, root: string, cwd: string): string[] {
  if (request.source === 'compile') {
    const mapped: string[] = [];
    const args = expandedJavacArgsForRequest(request);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-d') {
        mapped.push(arg);
        const outputDir = args[index + 1];
        if (typeof outputDir === 'string') {
          mapped.push(assertWorkspaceRelativeOperand(root, cwd, outputDir, 'Java output directory', request.project));
          index += 1;
        }
        continue;
      }
      if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
        mapped.push(arg);
        const classpath = args[index + 1];
        if (typeof classpath === 'string') {
          mapped.push(mapJavaClasspath(root, cwd, classpath, request.project));
          index += 1;
        }
        continue;
      }
      if (arg === '-sourcepath' || arg === '--source-path') {
        mapped.push(arg);
        const sourcepath = args[index + 1];
        if (typeof sourcepath === 'string') {
          mapped.push(mapJavaPathList(root, cwd, sourcepath, request.project));
          index += 1;
        }
        continue;
      }
      if (arg.startsWith('--class-path=')) {
        mapped.push(`--class-path=${mapJavaClasspath(root, cwd, arg.slice('--class-path='.length), request.project)}`);
        continue;
      }
      if (arg.startsWith('--source-path=')) {
        mapped.push(`--source-path=${mapJavaPathList(root, cwd, arg.slice('--source-path='.length), request.project)}`);
        continue;
      }
      if (arg.startsWith('@') && arg.length > 1) {
        mapped.push(`@${assertWorkspaceRelativeOperand(root, cwd, arg.slice(1), 'Java argfile path', request.project)}`);
        continue;
      }
      if (arg.endsWith('.java')) {
        mapped.push(assertWorkspaceRelativeOperand(root, cwd, arg, 'Java source path', request.project));
        continue;
      }
      mapped.push(arg);
    }
    return mapped;
  }
  return ['-d', '.', ...javaSourceFiles(request.project).map((path) => join(root, path))];
}

function workspacePathForClasspathEntry(root: string, cwd: string, entry: string, project?: JavaProjectSnapshot): string {
  if (project && stripProjectVirtualPrefix(entry, project) !== null) {
    return mapWorkspaceAbsolutePath(root, entry, project);
  }
  if (entry === VIRTUAL_WORKSPACE_ROOT || entry.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, entry);
  }
  if (entry === '.') return cwd;
  const absolute = resolve(cwd, entry);
  const relativePath = relative(root, absolute).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) {
    throw new Error(`Java classpath entry must stay inside the workspace: ${entry}`);
  }
  return absolute;
}

function classpathEntriesForRequest(request: JavaProjectCommandRequest, root: string, cwd: string): string[] {
  const rawClasspath = effectiveJavaClasspath(request);
  if (typeof rawClasspath !== 'string' || rawClasspath.trim().length === 0) {
    return [cwd];
  }

  return rawClasspath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => workspacePathForClasspathEntry(root, cwd, entry, request.project));
}

function effectiveJavaClasspath(request: JavaProjectCommandRequest): unknown {
  return typeof request.options?.classpath === 'string'
    ? request.options.classpath
    : request.env.CLASSPATH;
}

function mapJavaEnv(root: string, cwd: string, env: Record<string, string>, project?: JavaProjectSnapshot): Record<string, string> {
  return typeof env.CLASSPATH === 'string'
    ? { ...env, CLASSPATH: mapJavaClasspath(root, cwd, env.CLASSPATH, project) }
    : env;
}

function javaSystemPropertyArgs(request: JavaProjectCommandRequest): string[] {
  const properties = request.options?.systemProperties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }

  return Object.entries(properties as Record<string, unknown>)
    .filter(([key]) => /^[^=\0]+$/.test(key))
    .map(([key, value]) => `-D${key}=${String(value ?? '')}`);
}

function javaRuntimeOptionArgs(request: JavaProjectCommandRequest): string[] {
  return [
    ...(request.options?.enablePreview === true ? ['--enable-preview'] : []),
    ...(request.options?.enableAssertions === true ? ['-ea'] : []),
  ];
}

function jarPathForRequest(request: JavaProjectCommandRequest, root: string, cwd: string): string | null {
  const jarPath = request.options?.jarPath;
  if (typeof jarPath !== 'string' || jarPath.trim().length === 0) {
    return null;
  }
  return workspacePathForClasspathEntry(root, cwd, jarPath, request.project);
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
): Promise<JavaProjectCommandResult> {
  return new Promise<JavaProjectCommandResult>((resolve) => {
    emitCommandStatus(options.onEvent, 'process-start', `Starting ${command}`, { command, args, cwd: options.cwd });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let abortedSignal: string | null = null;
    let abortForceKill: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: JavaProjectCommandResult, phase: string, message: string, detail: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortForceKill) clearTimeout(abortForceKill);
      options.signal?.removeEventListener('abort', abort);
      emitCommandStatus(options.onEvent, phase, message, detail);
      resolve(result);
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
      resolve({
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

export function createNativeJavaProjectRunner(
  options: NativeJavaProjectRunnerOptions = {}
): JavaProjectCommandRunner {
  const javacCommand = options.javacCommand ?? 'javac';
  const javaCommand = options.javaCommand ?? 'java';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-java-project-')));
    try {
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }
      for (const entry of request.project.symlinks ?? []) {
        await writeProjectSymlink(root, entry);
      }
      for (const file of request.project.files) {
        await applyProjectFileMetadata(root, file);
      }
      // Apply directory metadata last because materializing descendants updates parent mtimes.
      for (const entry of request.project.directoryMetadata ?? []) {
        await applyProjectDirectoryMetadata(root, entry);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });
      const jarPath = request.source === 'run' ? jarPathForRequest(request, root, cwd) : null;
      if (request.source === 'run' && jarPath) {
        const baseline = await snapshotFileBytes(root);
        const baselineFileMetadata = await snapshotFileMetadata(root);
        const baselineSymlinks = await snapshotSymlinkTargets(root);
        const baselineDirectories = await snapshotDirectories(root);
        const baselineDirectoryMetadata = await snapshotDirectoryMetadata(root);
        const deletableDirectories = explicitlySnapshottedProjectDirectories(request.project);
        const run = await runProcess(javaCommand, [...javaRuntimeOptionArgs(request), ...javaSystemPropertyArgs(request), '-jar', jarPath, ...request.args], {
          cwd,
          env: mapJavaEnv(root, cwd, request.env, request.project),
          stdinPipe: request.stdinPipe,
          signal: request.signal,
          timeoutMs,
          timeoutLabel: 'java',
          onEvent: request.onEvent,
        });
        const files = await changedProjectFiles(
          root,
          baseline,
          baselineFileMetadata,
          baselineSymlinks,
          baselineDirectories,
          baselineDirectoryMetadata,
          deletableDirectories
        );
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...run, files };
      }
      const mainClass = request.source === 'run' ? assertSafeMainClass(request.scriptPath) : null;
      const runClasspath = request.source === 'run' ? classpathEntriesForRequest(request, root, cwd).join(delimiter) : '';
      if (request.source === 'run' && effectiveJavaClasspath(request)) {
        const baseline = await snapshotFileBytes(root);
        const baselineFileMetadata = await snapshotFileMetadata(root);
        const baselineSymlinks = await snapshotSymlinkTargets(root);
        const baselineDirectories = await snapshotDirectories(root);
        const baselineDirectoryMetadata = await snapshotDirectoryMetadata(root);
        const deletableDirectories = explicitlySnapshottedProjectDirectories(request.project);
        const run = await runProcess(javaCommand, [...javaRuntimeOptionArgs(request), ...javaSystemPropertyArgs(request), '-cp', runClasspath, mainClass ?? '<main>', ...request.args], {
          cwd,
          env: mapJavaEnv(root, cwd, request.env, request.project),
          stdinPipe: request.stdinPipe,
          signal: request.signal,
          timeoutMs,
          timeoutLabel: 'java',
          onEvent: request.onEvent,
        });
        const files = await changedProjectFiles(
          root,
          baseline,
          baselineFileMetadata,
          baselineSymlinks,
          baselineDirectories,
          baselineDirectoryMetadata,
          deletableDirectories
        );
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...run, files };
      }

      const compileBaseline = request.source === 'compile' ? await snapshotFileBytes(root) : null;
      const compileBaselineFileMetadata = request.source === 'compile' ? await snapshotFileMetadata(root) : null;
      const compileBaselineSymlinks = request.source === 'compile' ? await snapshotSymlinkTargets(root) : null;
      const compileBaselineDirectories = request.source === 'compile' ? await snapshotDirectories(root) : null;
      const compileBaselineDirectoryMetadata = request.source === 'compile' ? await snapshotDirectoryMetadata(root) : null;
      const compileDeletableDirectories = request.source === 'compile'
        ? explicitlySnapshottedProjectDirectories(request.project)
        : null;
      const compile = await runProcess(javacCommand, javacArgsForRequest(request, root, cwd), {
        cwd,
          env: mapJavaEnv(root, cwd, request.env, request.project),
          signal: request.signal,
          timeoutMs,
          timeoutLabel: 'javac',
          onEvent: request.onEvent,
        });
      if (request.source === 'compile') {
        if (compile.exitCode !== 0) return compile;
        const files = await changedProjectFiles(
          root,
          compileBaseline ?? new Map(),
          compileBaselineFileMetadata ?? new Map(),
          compileBaselineSymlinks ?? new Map(),
          compileBaselineDirectories ?? new Set(),
          compileBaselineDirectoryMetadata ?? new Map(),
          compileDeletableDirectories ?? new Set()
        );
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...compile, files };
      }
      if (compile.exitCode !== 0) {
        return compile;
      }

      const baseline = await snapshotFileBytes(root);
      const baselineFileMetadata = await snapshotFileMetadata(root);
      const baselineSymlinks = await snapshotSymlinkTargets(root);
      const baselineDirectories = await snapshotDirectories(root);
      const baselineDirectoryMetadata = await snapshotDirectoryMetadata(root);
      const deletableDirectories = explicitlySnapshottedProjectDirectories(request.project);
      const run = await runProcess(javaCommand, [...javaRuntimeOptionArgs(request), ...javaSystemPropertyArgs(request), '-cp', runClasspath, mainClass ?? '<main>', ...request.args], {
        cwd,
        env: mapJavaEnv(root, cwd, request.env, request.project),
        stdinPipe: request.stdinPipe,
        signal: request.signal,
        timeoutMs,
        timeoutLabel: 'java',
        onEvent: request.onEvent,
      });
      const files = await changedProjectFiles(
        root,
        baseline,
        baselineFileMetadata,
        baselineSymlinks,
        baselineDirectories,
        baselineDirectoryMetadata,
        deletableDirectories
      );
      emitRuntimeCommandFileChanges(request.onEvent, files);
      return {
        stdout: `${compile.stdout}${run.stdout}`,
        stderr: `${compile.stderr}${run.stderr}`,
        exitCode: run.exitCode,
        files,
      };
    } finally {
      if (!options.keepTempDir) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
