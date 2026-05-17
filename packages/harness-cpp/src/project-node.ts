import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';

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

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  originalFiles: Map<string, Buffer>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await stat(absolutePath);
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(root, join(absolutePath, entry), originalFiles, files);
    }
    return;
  }

  if (!info.isFile()) return;

  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
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
  await collectChangedFiles(root, root, originalFiles, files);
  for (const path of originalFiles.keys()) {
    files.push({ path, deleted: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function cwdForRequest(request: CppProjectCommandRequest, root: string): string {
  const projectCwd = request.project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
  if (request.cwd === projectCwd) return root;
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return join(root, request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function mapWorkspaceAbsolutePath(root: string, value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return root;
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return join(root, normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
  }
  return value;
}

function mapWorkspaceProjectPath(root: string, value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') && normalized !== VIRTUAL_WORKSPACE_ROOT && !normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    throw new Error(`Project path must stay inside the workspace: ${value}`);
  }
  return mapWorkspaceAbsolutePath(root, value);
}

function assertCompilePathStaysInWorkspace(root: string, cwd: string, value: string): string {
  const normalized = value.replace(/\\/g, '/');
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

function mapCompilePathOption(root: string, cwd: string, value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized === VIRTUAL_WORKSPACE_ROOT) {
    return mapWorkspaceProjectPath(root, value);
  }
  return assertCompilePathStaysInWorkspace(root, cwd, value);
}

function mapCompileArg(root: string, cwd: string, arg: string): string {
  if (arg.startsWith('-I/')) return `-I${mapWorkspaceProjectPath(root, arg.slice(2))}`;
  if (arg.startsWith('-L/')) return `-L${mapWorkspaceProjectPath(root, arg.slice(2))}`;
  if (arg.startsWith('-isystem/')) return `-isystem${mapWorkspaceProjectPath(root, arg.slice('-isystem'.length))}`;
  if (arg.startsWith('-I') && arg.length > 2) return `-I${mapCompilePathOption(root, cwd, arg.slice(2))}`;
  if (arg.startsWith('-L') && arg.length > 2) return `-L${mapCompilePathOption(root, cwd, arg.slice(2))}`;
  if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
    return `-isystem${mapCompilePathOption(root, cwd, arg.slice('-isystem'.length))}`;
  }
  if (arg.startsWith('-o') && arg.length > 2) return `-o${mapCompilePathOption(root, cwd, arg.slice(2))}`;
  if (arg === VIRTUAL_WORKSPACE_ROOT || arg.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, arg);
  }
  if (/\.(?:cpp|cc|cxx|c|hpp|hh|h|o|obj|a|lib)$/i.test(arg)) {
    return assertCompilePathStaysInWorkspace(root, cwd, arg);
  }
  return arg;
}

function defaultCompileScriptPath(request: CppProjectCommandRequest): string {
  const scriptPath = request.scriptPath || 'main.cpp';
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

function pathForOutputDirectory(root: string, cwd: string, value: string): string {
  if (value === root || value.startsWith(`${root}/`)) {
    return value;
  }
  if (value === VIRTUAL_WORKSPACE_ROOT || value.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, value);
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
        mapped.push(mapCompilePathOption(root, cwd, value));
        index += 1;
      }
      continue;
    }
    mapped.push(mapCompileArg(root, cwd, arg));
  }
  return mapped;
}

async function ensureCompileOutputDirectories(args: string[], root: string, cwd: string): Promise<void> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-o') {
      const outputPath = args[index + 1];
      if (typeof outputPath === 'string') {
        await mkdir(dirname(pathForOutputDirectory(root, cwd, outputPath)), { recursive: true });
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      await mkdir(dirname(pathForOutputDirectory(root, cwd, arg.slice(2))), { recursive: true });
    }
  }
}

function executablePathForRequest(request: CppProjectCommandRequest, root: string, cwd: string): string {
  const raw = request.scriptPath || './a.out';
  if (raw === VIRTUAL_WORKSPACE_ROOT || raw.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return mapWorkspaceAbsolutePath(root, raw);
  }
  if (raw.startsWith('/')) {
    throw new Error(`C++ executable path must stay inside the workspace: ${raw}`);
  }
  return resolve(cwd, raw);
}

function mapWorkspaceEnvPathList(root: string, cwd: string, value: string): string {
  return value
    .split(/[:;]/)
    .map((entry) => entry ? assertCompilePathStaysInWorkspace(root, cwd, entry) : entry)
    .join(':');
}

function mapCompileEnv(root: string, cwd: string, env: Record<string, string>): Record<string, string> {
  const mapped = { ...env };
  for (const key of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH']) {
    if (typeof mapped[key] === 'string') {
      mapped[key] = mapWorkspaceEnvPathList(root, cwd, mapped[key]);
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
    stdin: string;
    timeoutMs: number;
    timeoutLabel: string;
  }
): Promise<CppProjectCommandResult> {
  return new Promise<CppProjectCommandResult>((resolveResult) => {
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

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolveResult({
        stdout,
        stderr: `${stderr}${options.timeoutLabel}: execution timed out after ${options.timeoutMs}ms\n`,
        exitCode: 124,
      });
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout,
        stderr: `${stderr}${error.message}\n`,
        exitCode: 1,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.stdin.end(options.stdin);
  });
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
        await ensureCompileOutputDirectories(compileArgs, root, cwd);
        const result = await runProcess(compilerCommand, compileArgs, {
          cwd,
          env: mapCompileEnv(root, cwd, request.env),
          stdin: request.stdin,
          timeoutMs,
          timeoutLabel: compilerCommand,
        });
        return result.exitCode === 0
          ? { ...result, files: await changedProjectFiles(root, request.project) }
          : result;
      }

      const executablePath = executablePathForRequest(request, root, cwd);
      await chmod(executablePath, 0o755).catch(() => undefined);
      const result = await runProcess(executablePath, request.args, {
        cwd,
        env: request.env,
        stdin: request.stdin,
        timeoutMs,
        timeoutLabel: request.scriptPath || './a.out',
      });
      return { ...result, files: await changedProjectFiles(root, request.project) };
    } finally {
      if (!options.keepTempDir) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
