import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  emitRuntimeCommandFileChanges,
  emitRuntimeCommandOutput,
  readRuntimeCommandStdinPipeBytes,
  runtimeAbortSignalName,
  runtimeCommandStdinPipeClosed,
  runtimeSignalExitCode,
} from '@tracecode/runtime-contracts';
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
} from '@tracecode/runtime-contracts';

export type CppProjectFileEncoding = RuntimeFileEncoding;
export type CppProjectFile = RuntimeFile;
export type CppProjectSnapshot = RuntimeProjectSnapshot;
export type CppProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CppProjectCommandResult = RuntimeCommandResult;
export type CppProjectCommandRunner = RuntimeProjectCommandRunner<CppProjectCommandRequest>;

export interface NativeCppProjectRunnerOptions {
  compilerCommand?: string;
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

async function writeProjectFile(root: string, file: CppProjectFile): Promise<void> {
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

function fileBytes(file: CppProjectFile): Buffer {
  if (file.encoding === 'base64') return Buffer.from(file.contents, 'base64');
  return Buffer.from(file.contents, 'utf8');
}

function originalProjectFiles(project: CppProjectSnapshot): Map<string, Buffer> {
  return new Map(project.files.map((file) => [assertSafeProjectPath(file.path), fileBytes(file)]));
}

function addDirectoryAncestors(directories: Set<string>, path: string): void {
  let current = dirname(path);
  while (current && current !== '.') {
    directories.add(current.replace(/\\/g, '/'));
    current = dirname(current);
  }
}

function originalProjectDirectories(project: CppProjectSnapshot): Set<string> {
  const directories = new Set<string>();
  for (const file of project.files) {
    addDirectoryAncestors(directories, assertSafeProjectPath(file.path));
  }
  for (const directory of project.directories ?? []) {
    const safeDirectory = assertSafeProjectPath(directory);
    directories.add(safeDirectory);
    addDirectoryAncestors(directories, safeDirectory);
  }
  return directories;
}

function explicitlySnapshottedProjectDirectories(project: CppProjectSnapshot): Set<string> {
  return new Set((project.directories ?? []).map((directory) => assertSafeProjectPath(directory)));
}

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  originalFiles: Map<string, Buffer>,
  originalDirectories: Set<string>,
  deletableDirectories: Set<string>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) return;
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isDirectory()) {
    if (relativePath && !relativePath.startsWith('..')) {
      if (originalDirectories.has(relativePath)) {
        originalDirectories.delete(relativePath);
        deletableDirectories.delete(relativePath);
      } else {
        files.push({ path: relativePath, directory: true });
      }
    }
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(root, join(absolutePath, entry), originalFiles, originalDirectories, deletableDirectories, files);
    }
    return;
  }

  if (!info.isFile()) return;

  if (!relativePath || relativePath.startsWith('..')) return;

  const contents = await readFile(absolutePath);
  const original = originalFiles.get(relativePath);
  originalFiles.delete(relativePath);
  if (original && Buffer.compare(original, contents) === 0) return;

  const utf8 = contents.toString('utf8');
  files.push(
    Buffer.compare(Buffer.from(utf8, 'utf8'), contents) === 0
      ? { path: relativePath, contents: utf8 }
      : { path: relativePath, contents: contents.toString('base64'), encoding: 'base64' }
  );
}

async function changedProjectFiles(root: string, project: CppProjectSnapshot): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  const originalFiles = originalProjectFiles(project);
  const originalDirectories = originalProjectDirectories(project);
  const deletableDirectories = explicitlySnapshottedProjectDirectories(project);
  await collectChangedFiles(root, root, originalFiles, originalDirectories, deletableDirectories, files);
  for (const path of originalFiles.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of deletableDirectories) {
    files.push({ path, directory: true, deleted: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function projectVirtualRoot(project: CppProjectSnapshot): string {
  return project.workspaceRoot ?? project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
}

function projectVirtualAliases(project: CppProjectSnapshot): string[] {
  return Array.from(new Set([project.workspaceAlias, VIRTUAL_WORKSPACE_ROOT].filter((alias): alias is string => Boolean(alias && alias !== projectVirtualRoot(project)))));
}

function stripProjectVirtualPrefix(value: string, project: CppProjectSnapshot): string | null {
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

function cwdForRequest(request: CppProjectCommandRequest, root: string): string {
  const relativeCwd = stripProjectVirtualPrefix(request.cwd, request.project);
  if (relativeCwd !== null) {
    return relativeCwd ? join(root, relativeCwd) : root;
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function mapWorkspaceAbsolutePath(root: string, value: string, project?: CppProjectSnapshot): string {
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

function mapWorkspaceProjectPath(root: string, value: string, project?: CppProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceAbsolutePath(root, normalized, project);
  }
  if (normalized.startsWith('/') && normalized !== VIRTUAL_WORKSPACE_ROOT && !normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return mapWorkspaceAbsolutePath(root, value);
}

function assertCompilePathStaysInWorkspace(root: string, cwd: string, value: string, project?: CppProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceAbsolutePath(root, normalized, project);
  }
  if (normalized === VIRTUAL_WORKSPACE_ROOT || normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, normalized);
  }
  if (normalized.startsWith('/')) {
    if (normalized === root || normalized.startsWith(`${root}/`)) return normalized;
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  const absolute = resolve(cwd, normalized);
  const relativePath = relative(root, absolute).replace(/\\/g, '/');
  if (relativePath.startsWith('..') || relativePath === '..') {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return value;
}

function mapCompilePathOption(root: string, cwd: string, value: string, project?: CppProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  if (project && stripProjectVirtualPrefix(normalized, project) !== null) {
    return mapWorkspaceProjectPath(root, value, project);
  }
  if (normalized.startsWith('/') || normalized === VIRTUAL_WORKSPACE_ROOT) {
    return mapWorkspaceProjectPath(root, value);
  }
  return assertCompilePathStaysInWorkspace(root, cwd, value, project);
}

function mapCompileArg(root: string, cwd: string, arg: string, project: CppProjectSnapshot): string {
  if (arg.startsWith('-I/')) return `-I${mapWorkspaceProjectPath(root, arg.slice(2), project)}`;
  if (arg.startsWith('-L/')) return `-L${mapWorkspaceProjectPath(root, arg.slice(2), project)}`;
  if (arg.startsWith('-isystem/')) return `-isystem${mapWorkspaceProjectPath(root, arg.slice('-isystem'.length), project)}`;
  if (arg.startsWith('-I') && arg.length > 2) return `-I${mapCompilePathOption(root, cwd, arg.slice(2), project)}`;
  if (arg.startsWith('-L') && arg.length > 2) return `-L${mapCompilePathOption(root, cwd, arg.slice(2), project)}`;
  if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
    return `-isystem${mapCompilePathOption(root, cwd, arg.slice('-isystem'.length), project)}`;
  }
  if (arg.startsWith('-o') && arg.length > 2) return `-o${mapCompilePathOption(root, cwd, arg.slice(2), project)}`;
  if (stripProjectVirtualPrefix(arg, project) !== null || arg === VIRTUAL_WORKSPACE_ROOT || arg.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, arg, project);
  }
  if (/\.(?:cpp|cc|cxx|c|hpp|hh|h|o|obj|a|lib)$/i.test(arg)) {
    return assertCompilePathStaysInWorkspace(root, cwd, arg, project);
  }
  return arg;
}

function defaultCompileScriptPath(request: CppProjectCommandRequest): string {
  const scriptPath = request.scriptPath || 'main.cpp';
  if (stripProjectVirtualPrefix(scriptPath, request.project) !== null) {
    return scriptPath;
  }
  if (scriptPath === VIRTUAL_WORKSPACE_ROOT || scriptPath.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return scriptPath;
  }
  return assertSafeProjectPath(scriptPath);
}

function isPathLikeCompileArg(arg: string): boolean {
  return (
    arg === VIRTUAL_WORKSPACE_ROOT ||
    arg.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`) ||
    arg.startsWith('/') ||
    arg.includes('/')
  );
}

function pathForOutputDirectory(root: string, cwd: string, value: string, project?: CppProjectSnapshot): string {
  if (value === root || value.startsWith(`${root}/`)) {
    return value;
  }
  if ((project && stripProjectVirtualPrefix(value, project) !== null) || value === VIRTUAL_WORKSPACE_ROOT || value.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, value, project);
  }
  if (value.startsWith('/')) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  if (isPathLikeCompileArg(value)) {
    const outputPath = resolve(cwd, value);
    const relativePath = relative(root, outputPath).replace(/\\/g, '/');
    if (relativePath.startsWith('..') || relativePath === '..') {
      throw new Error(`Project path must stay inside the workspace: ${value}`);
    }
    return outputPath;
  }
  return value;
}

function compileArgsForRequest(request: CppProjectCommandRequest, root: string, cwd: string): string[] {
  const args = request.args.length > 0
    ? [...request.args]
    : ['-std=c++17', defaultCompileScriptPath(request)];
  const mapped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o' || arg === '-I' || arg === '-L' || arg === '-isystem') {
      mapped.push(arg);
      const value = args[index + 1];
      if (typeof value === 'string') {
        mapped.push(mapCompilePathOption(root, cwd, value, request.project));
        index += 1;
      }
      continue;
    }
    mapped.push(mapCompileArg(root, cwd, arg, request.project));
  }
  return mapped;
}

async function ensureCompileOutputDirectories(args: string[], root: string, cwd: string, project?: CppProjectSnapshot): Promise<void> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o') {
      const outputPath = args[index + 1];
      if (typeof outputPath === 'string') {
        await mkdir(dirname(pathForOutputDirectory(root, cwd, outputPath, project)), { recursive: true });
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      await mkdir(dirname(pathForOutputDirectory(root, cwd, arg.slice(2), project)), { recursive: true });
    }
  }
}

function executablePathForRequest(request: CppProjectCommandRequest, root: string, cwd: string): string {
  const raw = request.scriptPath || './a.out';
  if (stripProjectVirtualPrefix(raw, request.project) !== null || raw === VIRTUAL_WORKSPACE_ROOT || raw.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, raw, request.project);
  }
  if (raw.startsWith('/')) {
    throw new Error(`C++ executable path must stay inside the workspace: ${raw}`);
  }
  return resolve(cwd, raw);
}

function mapWorkspaceEnvPathList(root: string, cwd: string, value: string, project: CppProjectSnapshot): string {
  return value
    .split(/[:;]/)
    .map((entry) => entry ? assertCompilePathStaysInWorkspace(root, cwd, entry, project) : entry)
    .join(':');
}

function mapCompileEnv(root: string, cwd: string, env: Record<string, string>, project: CppProjectSnapshot): Record<string, string> {
  const mapped = { ...env };
  for (const key of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH']) {
    if (typeof mapped[key] === 'string') {
      mapped[key] = mapWorkspaceEnvPathList(root, cwd, mapped[key], project);
    }
  }
  return mapped;
}

function compilerCommandForRequest(request: CppProjectCommandRequest, fallback: string): string {
  const command = request.options?.compilerCommand;
  return typeof command === 'string' && command.trim() ? command.trim() : fallback;
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    inputText?: string;
    stdinPipe?: RuntimeCommandStdinSharedBuffer;
    signal?: AbortSignal;
    timeoutMs: number;
    timeoutLabel: string;
    onEvent?: RuntimeCommandEventHandler;
  }
): Promise<CppProjectCommandResult> {
  return new Promise<CppProjectCommandResult>((resolveResult) => {
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

    const isClosedStdinError = (error: unknown): boolean => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
    };

    const settle = (result: CppProjectCommandResult, phase: string, message: string, detail: Record<string, unknown>): void => {
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
    child.stdin.on('error', (error) => {
      if (isClosedStdinError(error)) return;
      if (settled) return;
      const message = error instanceof Error ? error.message : String(error);
      emitRuntimeCommandOutput(options.onEvent, 'stderr', `${message}\n`);
      settle(
        { stdout, stderr: `${stderr}${message}\n`, exitCode: 1 },
        'process-error',
        `${command} stdin failed`,
        { command, error: message }
      );
    });

    if (options.stdinPipe) {
      void pumpStdinPipeToChild(options.stdinPipe, child.stdin).catch(() => undefined);
    } else {
      try {
        child.stdin.end(options.inputText ?? '');
      } catch (error) {
        if (!isClosedStdinError(error) && !settled) {
          const message = error instanceof Error ? error.message : String(error);
          emitRuntimeCommandOutput(options.onEvent, 'stderr', `${message}\n`);
          settle(
            { stdout, stderr: `${stderr}${message}\n`, exitCode: 1 },
            'process-error',
            `${command} stdin failed`,
            { command, error: message }
          );
        }
      }
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

export function createNativeCppProjectRunner(
  options: NativeCppProjectRunnerOptions = {}
): CppProjectCommandRunner {
  const fallbackCompilerCommand = options.compilerCommand ?? 'clang++';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-cpp-project-')));
    try {
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });

      if (request.source === 'compile') {
        const compilerCommand = compilerCommandForRequest(request, fallbackCompilerCommand);
        const compileArgs = compileArgsForRequest(request, root, cwd);
        await ensureCompileOutputDirectories(compileArgs, root, cwd, request.project);
        const result = await runProcess(compilerCommand, compileArgs, {
          cwd,
          env: mapCompileEnv(root, cwd, request.env, request.project),
          inputText: request.code,
          signal: request.signal,
          timeoutMs,
          timeoutLabel: compilerCommand,
          onEvent: request.onEvent,
        });
        if (result.exitCode !== 0) return result;
        const files = await changedProjectFiles(root, request.project);
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...result, files };
      }

      const executablePath = executablePathForRequest(request, root, cwd);
      await chmod(executablePath, 0o755).catch(() => undefined);
      const result = await runProcess(executablePath, request.args, {
        cwd,
        env: request.env,
        stdinPipe: request.stdinPipe,
        signal: request.signal,
        timeoutMs,
        timeoutLabel: request.scriptPath || './a.out',
        onEvent: request.onEvent,
      });
      const files = await changedProjectFiles(root, request.project);
      emitRuntimeCommandFileChanges(request.onEvent, files);
      return { ...result, files };
    } finally {
      if (!options.keepTempDir) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
