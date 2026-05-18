import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

export type CSharpProjectFileEncoding = RuntimeFileEncoding;
export type CSharpProjectFile = RuntimeFile;
export type CSharpProjectSnapshot = RuntimeProjectSnapshot;
export type CSharpProjectCommandRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;
export type CSharpProjectCommandResult = RuntimeCommandResult;
export type CSharpProjectCommandRunner = RuntimeProjectCommandRunner<CSharpProjectCommandRequest>;

export interface NativeCSharpProjectRunnerOptions {
  dotnetCommand?: string;
  timeoutMs?: number;
  keepTempDir?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const VIRTUAL_WORKSPACE_ROOT = '/workspace';
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
    if (shouldRestoreExecutableMode(relativePath)) {
      await chmod(targetPath, 0o755);
    }
    return;
  }

  await writeFile(targetPath, file.contents, 'utf8');
}

async function writeProjectDirectory(root: string, path: string): Promise<void> {
  await mkdir(join(root, assertSafeProjectPath(path)), { recursive: true });
}

function fileBytes(file: CSharpProjectFile): Buffer {
  if (file.encoding === 'base64') return Buffer.from(file.contents, 'base64');
  return Buffer.from(file.contents, 'utf8');
}

async function collectFileBytes(root: string, absolutePath: string, files: Map<string, Buffer>): Promise<void> {
  const info = await stat(absolutePath);
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      await collectFileBytes(root, join(absolutePath, entry), files);
    }
    return;
  }

  if (!info.isFile()) return;

  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;
  files.set(relativePath, await readFile(absolutePath));
}

async function collectDirectories(root: string, absolutePath: string, directories: Set<string>): Promise<void> {
  const info = await stat(absolutePath);
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

async function collectChangedFiles(
  root: string,
  absolutePath: string,
  baselineFiles: Map<string, Buffer>,
  baselineDirectories: Set<string>,
  files: RuntimeFileChange[]
): Promise<void> {
  const info = await stat(absolutePath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
  if (info.isDirectory()) {
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('.tracecode-build/')) {
      if (baselineDirectories.has(relativePath)) {
        baselineDirectories.delete(relativePath);
      } else {
        files.push({ path: relativePath, directory: true });
      }
    }
    for (const entry of await readdir(absolutePath)) {
      await collectChangedFiles(root, join(absolutePath, entry), baselineFiles, baselineDirectories, files);
    }
    return;
  }

  if (!info.isFile()) return;

  if (!relativePath || relativePath.startsWith('..') || relativePath.startsWith('.tracecode-build/')) return;

  const contents = await readFile(absolutePath);
  const baseline = baselineFiles.get(relativePath);
  baselineFiles.delete(relativePath);
  if (baseline && Buffer.compare(baseline, contents) === 0) return;

  const utf8 = contents.toString('utf8');
  files.push(
    Buffer.compare(Buffer.from(utf8, 'utf8'), contents) === 0
      ? { path: relativePath, contents: utf8 }
      : { path: relativePath, contents: contents.toString('base64'), encoding: 'base64' }
  );
}

async function changedProjectFiles(
  root: string,
  baselineFiles: Map<string, Buffer>,
  baselineDirectories: Set<string>
): Promise<RuntimeFileChange[]> {
  const files: RuntimeFileChange[] = [];
  await collectChangedFiles(root, root, baselineFiles, baselineDirectories, files);
  for (const path of baselineFiles.keys()) {
    files.push({ path, deleted: true });
  }
  for (const path of baselineDirectories) {
    files.push({ path, directory: true, deleted: true });
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
  const normalized = value.replace(/\\/g, '/');
  if (normalized === VIRTUAL_WORKSPACE_ROOT) return '';
  if (normalized.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) return normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1);
  const roots = [projectVirtualRoot(project), ...projectVirtualAliases(project)];
  for (const root of roots) {
    if (normalized === root) return '';
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
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
    return join(root, normalized.slice(VIRTUAL_WORKSPACE_ROOT.length + 1));
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
      '    <TargetFramework>net8.0</TargetFramework>',
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
    stdin: string;
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
      settled = true;
      clearTimeout(timeout);
      emitCommandStatus(options.onEvent, 'process-error', `${command} failed to start`, { command, error: error.message });
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
      emitCommandStatus(options.onEvent, 'process-exit', `${command} exited`, { command, exitCode: code ?? 1 });
      resolveResult({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.stdin.end(options.stdin);
  });
}

async function resolveDotnetCommand(command: string): Promise<string> {
  if (command !== 'dotnet') return command;
  for (const candidate of [
    'dotnet',
    '/usr/local/share/dotnet/dotnet',
    '/usr/local/bin/dotnet',
    '/opt/homebrew/bin/dotnet',
  ]) {
    if (candidate === 'dotnet') continue;
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
  const dotnetCommand = options.dotnetCommand ?? 'dotnet';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const resolvedDotnetCommand = await resolveDotnetCommand(dotnetCommand);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-csharp-project-')));
    try {
      validateNativeProjectFileItems(request.project);
      for (const file of request.project.files) {
        await writeProjectFile(root, file);
      }
      for (const directory of request.project.directories ?? []) {
        await writeProjectDirectory(root, directory);
      }

      const cwd = cwdForRequest(request, root);
      await mkdir(cwd, { recursive: true });
      const projectPath = await ensureProjectFile(root, request);
      const projectArg = join(root, projectPath);

      if (request.source === 'compile') {
        const baseline = await snapshotFileBytes(root);
        const baselineDirectories = await snapshotDirectories(root);
        const result = await runProcess(resolvedDotnetCommand, ['build', projectArg, '--nologo', ...mappedDotnetArgs(root, request.args, request.project)], {
          cwd,
          env: request.env,
          stdin: request.stdin,
          timeoutMs,
          timeoutLabel: 'dotnet build',
          onEvent: request.onEvent,
        });
        if (result.exitCode !== 0) return result;
        const files = await changedProjectFiles(root, baseline, baselineDirectories);
        emitRuntimeCommandFileChanges(request.onEvent, files);
        return { ...result, files };
      }

      if (!shouldSkipBuildForRequest(request)) {
        const build = await runProcess(resolvedDotnetCommand, ['build', projectArg, '--nologo', ...mappedDotnetArgs(root, buildArgsForRequest(request), request.project)], {
          cwd,
          env: request.env,
          stdin: '',
          timeoutMs,
          timeoutLabel: 'dotnet build',
          onEvent: request.onEvent,
        });
        if (build.exitCode !== 0) return build;
      }

      const baseline = await snapshotFileBytes(root);
      const baselineDirectories = await snapshotDirectories(root);
      const run = await runProcess(resolvedDotnetCommand, ['run', '--project', projectArg, '--no-build', '--no-launch-profile', '--', ...request.args], {
        cwd,
        env: request.env,
        stdin: request.stdin,
        timeoutMs,
        timeoutLabel: 'dotnet run',
        onEvent: request.onEvent,
      });
      const files = await changedProjectFiles(root, baseline, baselineDirectories);
      emitRuntimeCommandFileChanges(request.onEvent, files);
      return { ...run, files };
    } finally {
      if (!options.keepTempDir) {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
