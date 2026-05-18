import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { emitRuntimeCommandFileChanges, emitRuntimeCommandOutput } from '../../harness-core/src/runtime-project';
import type {
  RuntimeCommandResult,
  RuntimeCommandEventHandler,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileEncoding,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '../../harness-core/src/runtime-project';

export type PythonProjectFileEncoding = RuntimeFileEncoding;
export type PythonProjectFile = RuntimeFile;
export type PythonProjectSnapshot = RuntimeProjectSnapshot;
export type PythonProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin' | 'module'
>;
export type PythonProjectCommandResult = RuntimeCommandResult;
export type PythonProjectCommandRunner = RuntimeProjectCommandRunner<PythonProjectCommandRequest>;

export interface NativePythonProjectRunnerOptions {
  pythonCommand?: string;
  timeoutMs?: number;
  keepTempDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const VIRTUAL_WORKSPACE_ROOT = '/workspace';

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

async function writeProjectFile(root: string, file: PythonProjectFile): Promise<void> {
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

function fileBytes(file: PythonProjectFile): Buffer {
  if (file.encoding === 'base64') {
    return Buffer.from(file.contents, 'base64');
  }
  return Buffer.from(file.contents, 'utf8');
}

function originalProjectFiles(project: PythonProjectSnapshot): Map<string, Buffer> {
  return new Map(project.files.map((file) => [assertSafeProjectPath(file.path), fileBytes(file)]));
}

function addDirectoryAncestors(directories: Set<string>, path: string): void {
  let current = dirname(path);
  while (current && current !== '.') {
    directories.add(current.replace(/\\/g, '/'));
    current = dirname(current);
  }
}

function originalProjectDirectories(project: PythonProjectSnapshot): Set<string> {
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

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  originalFiles: Map<string, Buffer>,
  originalDirectories: Set<string>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await stat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isDirectory()) {
    if (relativePath && !relativePath.startsWith('..')) {
      if (originalDirectories.has(relativePath)) {
        originalDirectories.delete(relativePath);
      } else {
        files.push({ path: relativePath, directory: true });
      }
    }
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(root, join(absolutePath, entry), originalFiles, originalDirectories, files);
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

async function changedProjectFiles(root: string, project: PythonProjectSnapshot): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  const originalFiles = originalProjectFiles(project);
  const originalDirectories = originalProjectDirectories(project);
  await collectChangedFiles(root, root, originalFiles, originalDirectories, files);
  for (const path of originalFiles.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of originalDirectories) {
    files.push({ path, directory: true, deleted: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function projectVirtualRoot(project: PythonProjectSnapshot): string {
  return project.workspaceRoot ?? project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
}

function projectVirtualAliases(project: PythonProjectSnapshot): string[] {
  return Array.from(new Set([
    project.workspaceAlias,
    VIRTUAL_WORKSPACE_ROOT,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0 && item !== projectVirtualRoot(project))));
}

function stripProjectVirtualPrefix(value: string, project: PythonProjectSnapshot): string | null {
  const roots = [projectVirtualRoot(project), ...projectVirtualAliases(project)];
  for (const root of roots) {
    if (value === root) return '';
    if (value.startsWith(`${root}/`)) return value.slice(root.length + 1);
  }
  return null;
}

function cwdForRequest(request: PythonProjectCommandRequest, root: string): string {
  const relativeCwd = stripProjectVirtualPrefix(request.cwd, request.project);
  if (relativeCwd !== null) {
    return relativeCwd ? join(root, relativeCwd) : root;
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function workspaceRelativeOperand(root: string, cwd: string, value: string, label: string, project?: PythonProjectSnapshot): string {
  const normalized = value.replace(/\\/g, '/');
  const relativeToVirtualRoot = project ? stripProjectVirtualPrefix(normalized, project) : null;
  if (relativeToVirtualRoot !== null) {
    return relativeToVirtualRoot ? join(root, relativeToVirtualRoot) : root;
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${label} must stay inside the workspace: ${value}`);
  }
  const absolute = resolve(cwd, normalized);
  const relativePath = relative(root, absolute).replace(/\\/g, '/');
  if (relativePath.startsWith('..')) {
    throw new Error(`${label} must stay inside the workspace: ${value}`);
  }
  return value;
}

function scriptPathForRequest(request: PythonProjectCommandRequest, root: string, cwd: string): string {
  const normalized = request.scriptPath.replace(/\\/g, '/');
  const virtualRelativePath = stripProjectVirtualPrefix(normalized, request.project);
  if (virtualRelativePath === '') {
    throw new Error(`Project file path must point to a file: ${request.scriptPath}`);
  }
  if (virtualRelativePath !== null) {
    return join(root, assertSafeProjectPath(virtualRelativePath));
  }
  try {
    const relativePath = assertSafeProjectPath(normalized);
    if (request.project.files.some((file) => file.path.replace(/\\/g, '/') === relativePath)) {
      return join(root, relativePath);
    }
  } catch {
    // Fall back to cwd-relative resolution below.
  }
  return resolve(cwd, workspaceRelativeOperand(root, cwd, request.scriptPath, 'Project file path', request.project));
}

function pythonArgsForRequest(request: PythonProjectCommandRequest, root: string, cwd: string): string[] {
  if (request.source === 'argument') {
    return ['-c', request.code, ...request.args];
  }

  if (request.source === 'module') {
    return ['-m', request.scriptPath, ...request.args];
  }

  if (request.source === 'stdin') {
    return ['-', ...request.args];
  }

  return [scriptPathForRequest(request, root, cwd), ...request.args];
}

async function writeWorkspaceSiteCustomize(supportDir: string, root: string, virtualRoot: string, virtualAliases: readonly string[]): Promise<void> {
  await writeFile(join(supportDir, 'sitecustomize.py'), `
import builtins
import io
import os

_tracecode_root = ${JSON.stringify(root)}
_tracecode_virtual_root = ${JSON.stringify(virtualRoot)}
_tracecode_virtual_aliases = ${JSON.stringify(virtualAliases)}

def _tracecode_map_path(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        original = os.fspath(value)
        if original == _tracecode_virtual_root:
            return _tracecode_root
        if isinstance(original, str) and original.startswith(_tracecode_virtual_root + "/"):
            return os.path.join(_tracecode_root, original[len(_tracecode_virtual_root) + 1:])
        for alias in _tracecode_virtual_aliases:
            if original == alias:
                return _tracecode_root
            if isinstance(original, str) and original.startswith(alias + "/"):
                return os.path.join(_tracecode_root, original[len(alias) + 1:])
    return value

def _tracecode_virtual_path(value):
    if isinstance(value, str):
        relative = os.path.relpath(value, _tracecode_root)
        if relative == ".":
            return _tracecode_virtual_root
        if not relative.startswith("..") and not os.path.isabs(relative):
            return _tracecode_virtual_root + "/" + relative.replace(os.sep, "/")
    return value

def _tracecode_patch_one_path(target, name):
    original = getattr(target, name, None)
    if original is None:
        return
    def patched(path, *args, **kwargs):
        return original(_tracecode_map_path(path), *args, **kwargs)
    setattr(target, name, patched)

def _tracecode_patch_two_paths(target, name):
    original = getattr(target, name, None)
    if original is None:
        return
    def patched(src, dst, *args, **kwargs):
        return original(_tracecode_map_path(src), _tracecode_map_path(dst), *args, **kwargs)
    setattr(target, name, patched)

_tracecode_original_open = builtins.open
def _tracecode_open(file, *args, **kwargs):
    return _tracecode_original_open(_tracecode_map_path(file), *args, **kwargs)
builtins.open = _tracecode_open
io.open = _tracecode_open

_tracecode_original_getcwd = os.getcwd
def _tracecode_getcwd():
    return _tracecode_virtual_path(_tracecode_original_getcwd())
os.getcwd = _tracecode_getcwd

_tracecode_original_chdir = os.chdir
def _tracecode_chdir(path):
    return _tracecode_original_chdir(_tracecode_map_path(path))
os.chdir = _tracecode_chdir

for _tracecode_name in [
    "access", "chmod", "chown", "listdir", "lstat", "mkdir", "makedirs", "readlink",
    "remove", "removedirs", "rmdir", "scandir", "stat", "unlink", "utime",
]:
    _tracecode_patch_one_path(os, _tracecode_name)

for _tracecode_name in ["link", "rename", "replace", "symlink"]:
    _tracecode_patch_two_paths(os, _tracecode_name)

for _tracecode_name in [
    "exists", "lexists", "getatime", "getctime", "getmtime", "getsize", "isdir",
    "isfile", "islink", "ismount", "realpath",
]:
    _tracecode_patch_one_path(os.path, _tracecode_name)

os.environ["PWD"] = _tracecode_getcwd()
`, 'utf8');
}

function pythonPathForRequest(request: PythonProjectCommandRequest, root: string, cwd: string, supportDir: string): string {
  const existing = mapPythonPathList(request.env.PYTHONPATH, root, cwd, request.project);
  if (typeof existing === 'string' && existing.length > 0) {
    return `${supportDir}${delimiter}${root}${delimiter}${existing}`;
  }
  return `${supportDir}${delimiter}${root}`;
}

function mapPythonPathList(value: unknown, root: string, cwd: string, project: PythonProjectSnapshot): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  return value
    .split(delimiter)
    .map((entry) => workspaceRelativeOperand(root, cwd, entry, 'Project path', project))
    .join(delimiter);
}

export function createNativePythonProjectRunner(
  options: NativePythonProjectRunnerOptions = {}
): PythonProjectCommandRunner {
  const pythonCommand = options.pythonCommand ?? 'python3';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-python-project-')));
    const supportDir = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-python-support-')));
    try {
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });
      await writeWorkspaceSiteCustomize(supportDir, root, projectVirtualRoot(request.project), projectVirtualAliases(request.project));

      const result = await new Promise<PythonProjectCommandResult>((resolve) => {
        const args = pythonArgsForRequest(request, root, cwd);
        emitCommandStatus(request.onEvent, 'process-start', `Starting ${pythonCommand}`, { command: pythonCommand, args, cwd });
        const child = spawn(pythonCommand, args, {
          cwd,
          env: {
            ...process.env,
            ...request.env,
            PYTHONPATH: pythonPathForRequest(request, root, cwd, supportDir),
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
          emitCommandStatus(request.onEvent, 'process-exit', `${pythonCommand} timed out`, { command: pythonCommand, exitCode: 124, timeoutMs });
          resolve({
            stdout,
            stderr: `${stderr}python3: execution timed out after ${timeoutMs}ms\n`,
            exitCode: 124,
          });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          const data = String(chunk);
          stdout += data;
          emitRuntimeCommandOutput(request.onEvent, 'stdout', data);
        });
        child.stderr.on('data', (chunk) => {
          const data = String(chunk);
          stderr += data;
          emitRuntimeCommandOutput(request.onEvent, 'stderr', data);
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          emitCommandStatus(request.onEvent, 'process-error', `${pythonCommand} failed to start`, { command: pythonCommand, error: error.message });
          resolve({
            stdout,
            stderr: `${stderr}${error.message}\n`,
            exitCode: 1,
          });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          emitCommandStatus(request.onEvent, 'process-exit', `${pythonCommand} exited`, { command: pythonCommand, exitCode: code ?? 1 });
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        });

        child.stdin.end(request.source === 'stdin' ? request.code : request.stdin);
      });

      const files = await changedProjectFiles(root, request.project);
      emitRuntimeCommandFileChanges(request.onEvent, files);
      return { ...result, files };
    } finally {
      if (!options.keepTempDir) {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(supportDir, { recursive: true, force: true }),
        ]);
      }
    }
  };
}
