import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
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

export type JavaScriptProjectFileEncoding = RuntimeFileEncoding;
export type JavaScriptProjectFile = RuntimeFile;
export type JavaScriptProjectSnapshot = RuntimeProjectSnapshot;
export type JavaScriptProjectCommandRequest = RuntimeProjectCommandRequest<
  'argument' | 'file' | 'stdin'
>;
export type JavaScriptProjectCommandResult = RuntimeCommandResult;
export type JavaScriptProjectCommandRunner = RuntimeProjectCommandRunner<JavaScriptProjectCommandRequest>;

export interface NativeJavaScriptProjectRunnerOptions {
  nodeCommand?: string;
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

async function writeProjectFile(root: string, file: JavaScriptProjectFile): Promise<void> {
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

function fileBytes(file: JavaScriptProjectFile): Buffer {
  if (file.encoding === 'base64') {
    return Buffer.from(file.contents, 'base64');
  }
  return Buffer.from(file.contents, 'utf8');
}

function originalProjectFiles(project: JavaScriptProjectSnapshot): Map<string, Buffer> {
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

async function changedProjectFiles(root: string, project: JavaScriptProjectSnapshot): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  const originalFiles = originalProjectFiles(project);
  await collectChangedFiles(root, root, originalFiles, files);
  for (const path of originalFiles.keys()) {
    files.push({ path, deleted: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function cwdForRequest(request: JavaScriptProjectCommandRequest, root: string): string {
  const projectCwd = request.project.cwd ?? '/workspace';
  if (request.cwd === projectCwd) return root;
  if (request.cwd.startsWith(`${projectCwd}/`)) {
    return join(root, request.cwd.slice(projectCwd.length + 1));
  }
  throw new Error(`Project cwd must stay inside the workspace: ${request.cwd}`);
}

function workspaceRelativeOperand(root: string, cwd: string, value: string, label: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return root;
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    return join(root, normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
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

function scriptPathForRequest(request: JavaScriptProjectCommandRequest, root: string, cwd: string): string {
  const projectCwd = request.project.cwd ?? VIRTUAL_WORKSPACE_ROOT;
  const normalized = request.scriptPath.replace(/\\/g, '/');
  if (normalized === projectCwd) {
    throw new Error(`Project file path must point to a file: ${request.scriptPath}`);
  }
  if (normalized.startsWith(`${projectCwd}/`)) {
    return join(root, assertSafeProjectPath(normalized.slice(projectCwd.length + 1)));
  }
  try {
    const relativePath = assertSafeProjectPath(normalized);
    if (request.project.files.some((file) => file.path.replace(/\\/g, '/') === relativePath)) {
      return join(root, relativePath);
    }
  } catch {
    // Fall back to cwd-relative resolution below.
  }
  return resolve(cwd, workspaceRelativeOperand(root, cwd, request.scriptPath, 'Project file path'));
}

function nodeArgsForRequest(request: JavaScriptProjectCommandRequest, root: string, cwd: string): string[] {
  const inputType = request.options?.inputType === 'module' || request.options?.inputType === 'commonjs'
    ? [`--input-type=${request.options.inputType}`]
    : [];
  const requireModules = Array.isArray(request.options?.require)
    ? request.options.require.filter((item): item is string => typeof item === 'string')
    : [];
  const requireArgs = requireModules.flatMap((moduleName) => ['--require', workspaceRelativeOperand(root, cwd, moduleName, 'Project path')]);
  if (request.source === 'argument') {
    return [...inputType, ...requireArgs, '-e', request.code, ...request.args];
  }

  if (request.source === 'stdin') {
    return [...inputType, ...requireArgs, '-', ...request.args];
  }

  return [...requireArgs, scriptPathForRequest(request, root, cwd), ...request.args];
}

function nodePathForRequest(request: JavaScriptProjectCommandRequest, root: string, cwd: string): string {
  const existing = mapNodePathList(request.env.NODE_PATH, root, cwd);
  if (typeof existing === 'string' && existing.length > 0) {
    return `${root}${delimiter}${existing}`;
  }
  return root;
}

function mapNodePathList(value: unknown, root: string, cwd: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  return value
    .split(delimiter)
    .map((entry) => workspaceRelativeOperand(root, cwd, entry, 'Project path'))
    .join(delimiter);
}

async function writeWorkspacePreload(supportDir: string, root: string, patchCwd: boolean): Promise<string> {
  const preloadPath = join(supportDir, 'tracecode-workspace-preload.cjs');
  await writeFile(preloadPath, `
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = ${JSON.stringify(root)};
const virtualRoot = ${JSON.stringify(VIRTUAL_WORKSPACE_ROOT)};

function mapPath(value) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') return value;
    const mappedPath = mapPath(decodeURIComponent(value.pathname));
    return typeof mappedPath === 'string' ? mappedPath : value;
  }
  if (typeof value !== 'string') return value;
  if (value === virtualRoot) return root;
  if (value.startsWith(virtualRoot + '/')) return path.join(root, value.slice(virtualRoot.length + 1));
  return value;
}

function virtualPath(value) {
  if (typeof value !== 'string') return value;
  const relativePath = path.relative(root, value).replace(/\\\\/g, '/');
  if (!relativePath || relativePath === '.') return virtualRoot;
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return virtualRoot + '/' + relativePath;
  return value;
}

function patchObject(target, names) {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function patchedPathMethod(first, ...rest) {
      return original.call(this, mapPath(first), ...rest);
    };
  }
}

patchObject(fs, [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
  'createReadStream', 'createWriteStream', 'exists', 'existsSync', 'lstat', 'lstatSync', 'mkdir',
  'mkdirSync', 'open', 'openSync', 'opendir', 'opendirSync', 'readFile', 'readFileSync', 'readdir',
  'readdirSync', 'readlink', 'readlinkSync', 'realpath', 'realpathSync', 'rm', 'rmSync', 'rmdir',
  'rmdirSync', 'stat', 'statSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes',
  'utimesSync', 'watch', 'writeFile', 'writeFileSync',
]);

for (const name of ['cp', 'cpSync', 'copyFile', 'copyFileSync', 'link', 'linkSync', 'rename', 'renameSync', 'symlink', 'symlinkSync']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function patchedTwoPathMethod(from, to, ...rest) {
    return original.call(this, mapPath(from), mapPath(to), ...rest);
  };
}

if (fs.promises) {
  patchObject(fs.promises, [
    'access', 'appendFile', 'chmod', 'chown', 'lstat', 'mkdir', 'open', 'opendir', 'readFile',
    'readdir', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'utimes',
    'writeFile',
  ]);
  for (const name of ['cp', 'copyFile', 'link', 'rename', 'symlink']) {
    const original = fs.promises[name];
    if (typeof original !== 'function') continue;
    fs.promises[name] = function patchedPromiseTwoPathMethod(from, to, ...rest) {
      return original.call(this, mapPath(from), mapPath(to), ...rest);
    };
  }
}

const originalCwd = process.cwd.bind(process);
const originalChdir = process.chdir.bind(process);
process.chdir = (dir) => originalChdir(mapPath(dir));
if (${JSON.stringify(patchCwd)}) {
  process.cwd = () => virtualPath(originalCwd());
  process.env.PWD = virtualPath(originalCwd());
}

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  let mappedRequest = mapPath(request);
  if (
    typeof request === 'string' &&
    (request.startsWith('./') || request.startsWith('../')) &&
    parent &&
    typeof parent.filename === 'string'
  ) {
    mappedRequest = path.resolve(path.dirname(mapPath(parent.filename)), request);
  }
  try {
    return originalResolveFilename.call(this, mappedRequest, parent, isMain, options);
  } catch (error) {
    if (
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      typeof request === 'string' &&
      !request.startsWith('./') &&
      !request.startsWith('../') &&
      !path.isAbsolute(request) &&
      !Module.builtinModules.includes(request) &&
      !Module.builtinModules.includes(request.replace(/^node:/, ''))
    ) {
      for (const candidate of [path.join(root, request), path.join(root, 'node_modules', request)]) {
        try {
          return originalResolveFilename.call(this, candidate, parent, isMain, options);
        } catch {
          // Try the next workspace-root candidate.
        }
      }
    }
    throw error;
  }
};
`, 'utf8');
  return preloadPath;
}

export function createNativeJavaScriptProjectRunner(
  options: NativeJavaScriptProjectRunnerOptions = {}
): JavaScriptProjectCommandRunner {
  const nodeCommand = options.nodeCommand ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-javascript-project-')));
    const supportDir = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-javascript-support-')));
    try {
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });
      const preloadPath = await writeWorkspacePreload(supportDir, root, request.source !== 'argument');

      const result = await new Promise<JavaScriptProjectCommandResult>((resolve) => {
        const args = nodeArgsForRequest(request, root, cwd);
        emitCommandStatus(request.onEvent, 'process-start', `Starting ${nodeCommand}`, { command: nodeCommand, args, cwd });
        const child = spawn(nodeCommand, args, {
          cwd,
          env: {
            ...process.env,
            ...request.env,
            NODE_OPTIONS: `${request.env.NODE_OPTIONS ?? ''} --require ${preloadPath}`.trim(),
            NODE_PATH: nodePathForRequest(request, root, cwd),
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
          resolve({
            stdout,
            stderr: `${stderr}node: execution timed out after ${timeoutMs}ms\n`,
            exitCode: 124,
          });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          const data = String(chunk);
          stdout += data;
          request.onEvent?.({ type: 'output', stream: 'stdout', data });
        });
        child.stderr.on('data', (chunk) => {
          const data = String(chunk);
          stderr += data;
          request.onEvent?.({ type: 'output', stream: 'stderr', data });
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
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
          emitCommandStatus(request.onEvent, 'process-exit', `${nodeCommand} exited`, { command: nodeCommand, exitCode: code ?? 1 });
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        });

        child.stdin.end(request.source === 'stdin' ? request.code : request.stdin);
      });

      return { ...result, files: await changedProjectFiles(root, request.project) };
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
