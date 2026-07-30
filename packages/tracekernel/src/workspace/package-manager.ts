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
import { NODE_RUNTIME_COMPAT_VERSION } from '@tracecode/runtime-contracts';
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
import { DEFAULT_CWD } from './constants';
import { assertNoNul, basename, dirname, isWithinWorkspace, normalizeRuntimeProjectPath, resolveWorkspaceCommandPath, toProjectPath, toWorkspacePath } from './paths';
import { applyCommandResultFiles, filterHiddenSnapshotFiles, filterReadonlySnapshotFiles, snapshotCommandContext, type RuntimeFileChangeObserver } from './fs-observed';
import { commandEnv, commandStdinPipe } from './language-commands';
import { decodeCommandStdin } from './arg-parsers';



export interface NormalizedRuntimePackageManagerConfig {
  managers: readonly RuntimePackageManagerName[];
  dependencyProvider?: RuntimePackageDependencyProvider;
  autoLinkBins: boolean;
  npmVersion: string;
}


export type PackageManagerCommandName = RuntimePackageManagerName | 'npx';

export type PackageManagerOutputEmitter = (
  stream: RuntimeCommandEventStream,
  data: string,
  context?: CommandContext
) => void;


export interface ParsedPackageManagerInvocation {
  kind: 'version' | 'run' | 'exec' | 'install' | 'list' | 'unsupported';
  command: string;
  scriptName?: string;
  scriptArgs: string[];
  execCommand?: string;
  execArgs: string[];
  installCommand?: 'install' | 'ci' | 'add';
  installArgs: string[];
  prefix?: string;
  workspace?: string;
  ifPresent: boolean;
  silent: boolean;
  ignoreScripts: boolean;
}

class PackageManifestResolutionError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'EJSONPARSE' | 'EWORKSPACE',
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = 'PackageManifestResolutionError';
  }
}


export const DEFAULT_PACKAGE_MANAGERS: readonly RuntimePackageManagerName[] = ['npm'];

export const NPM_SCRIPT_ALIASES = new Map<string, string>([
  ['t', 'test'],
  ['test', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);

export const NPM_LIFECYCLE_LIST_SCRIPT_NAMES = new Set(['test', 'start', 'stop', 'restart']);


export function normalizePackageManagerConfig(
  config: boolean | RuntimePackageManagerConfig | undefined,
  defaultEnabled: boolean
): NormalizedRuntimePackageManagerConfig | null {
  if (config === false) return null;
  if (config === undefined && !defaultEnabled) return null;
  const source = typeof config === 'object' ? config : {};
  const managers = [...new Set((source.managers ?? DEFAULT_PACKAGE_MANAGERS)
    .filter((manager): manager is RuntimePackageManagerName => DEFAULT_PACKAGE_MANAGERS.includes(manager)))];
  if (managers.length === 0) return null;
  return {
    managers,
    ...(source.dependencyProvider ? { dependencyProvider: source.dependencyProvider } : {}),
    autoLinkBins: source.autoLinkBins !== false,
    npmVersion: source.npmVersion ?? '11.12.1',
  };
}


export function cleanPackageManagerPassthroughArgs(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : args;
}


export function parsePackageManagerInvocation(
  manager: PackageManagerCommandName,
  args: string[]
): ParsedPackageManagerInvocation {
  if (manager === 'npx') {
    if (args[0] === '--version' || args[0] === '-v') {
      return { kind: 'version', command: 'version', scriptArgs: [], execArgs: [], installArgs: [], ifPresent: false, silent: false, ignoreScripts: false };
    }
    const execArgs = cleanPackageManagerPassthroughArgs(args);
    return {
      kind: execArgs.length > 0 ? 'exec' : 'unsupported',
      command: 'exec',
      execCommand: execArgs[0],
      execArgs: execArgs.slice(1),
      scriptArgs: [],
      installArgs: [],
      ifPresent: false,
      silent: false,
      ignoreScripts: false,
    };
  }

  let prefix: string | undefined;
  let workspace: string | undefined;
  let ifPresent = false;
  let silent = false;
  let ignoreScripts = false;
  const installFlags: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      positional.push(...args.slice(index));
      break;
    }
    if (arg === '--version' || arg === '-v') {
      return { kind: 'version', command: 'version', scriptArgs: [], execArgs: [], installArgs: [], ifPresent, silent, ignoreScripts };
    }
    if (arg === '--if-present') {
      ifPresent = true;
      continue;
    }
    if (arg === '--silent' || arg === '-s') {
      silent = true;
      continue;
    }
    if (arg === '--prefix' || arg === '-C' || arg === '--cwd') {
      const value = args[index + 1];
      if (value !== undefined) {
        prefix = value;
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length);
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      prefix = arg.slice('--cwd='.length);
      continue;
    }
    if (arg === '--workspace' || arg === '-w') {
      const value = args[index + 1];
      if (value !== undefined) {
        workspace = value;
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
      continue;
    }
    if (arg === '--ignore-scripts' || arg.startsWith('--ignore-scripts=')) {
      ignoreScripts = true;
      installFlags.push(arg);
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0] ?? '';
  const rest = positional.slice(1);
  const common = { command, prefix, workspace, ifPresent, silent, ignoreScripts };

  if (command === '' || command === 'run' || command === 'run-script') {
    const scriptName = command === '' ? undefined : rest[0];
    return {
      ...common,
      kind: 'run',
      scriptName,
      scriptArgs: cleanPackageManagerPassthroughArgs(command === '' ? [] : rest.slice(1)),
      execArgs: [],
      installArgs: [],
    };
  }

  const aliasedScript = NPM_SCRIPT_ALIASES.get(command);
  if (aliasedScript) {
    return {
      ...common,
      kind: 'run',
      scriptName: aliasedScript,
      scriptArgs: cleanPackageManagerPassthroughArgs(rest),
      execArgs: [],
      installArgs: [],
    };
  }

  if (command === 'exec' || command === 'x' || command === 'dlx') {
    const execArgs = cleanPackageManagerPassthroughArgs(rest);
    return {
      ...common,
      kind: 'exec',
      execCommand: execArgs[0],
      execArgs: execArgs.slice(1),
      scriptArgs: [],
      installArgs: [],
    };
  }

  if (command === 'install' || command === 'i' || command === 'ci' || command === 'add') {
    return {
      ...common,
      kind: 'install',
      installCommand: command === 'i' ? 'install' : command,
      installArgs: [...installFlags, ...rest],
      scriptArgs: [],
      execArgs: [],
    };
  }

  if (command === 'list' || command === 'ls') {
    return {
      ...common,
      kind: 'list',
      scriptArgs: [],
      execArgs: [],
      installArgs: [],
    };
  }

  return {
    ...common,
    kind: 'unsupported',
    scriptArgs: [],
    execArgs: [],
    installArgs: [],
  };
}


export function packageNameDefaultBinName(name: string): string {
  return name.startsWith('@') ? basename(name) : name;
}


export function packageScripts(manifest: RuntimePackageManifest): Record<string, string> {
  const scripts = manifest.json.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  const normalized: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string') normalized[name] = command;
  }
  return normalized;
}


export function packageDependencies(manifest: RuntimePackageManifest): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const record = manifest.json[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const [name, version] of Object.entries(record)) {
      if (typeof version === 'string') dependencies[name] = version;
    }
  }
  return dependencies;
}


export async function readPackageManifestAt(
  ctx: CommandContext,
  directory: string
): Promise<RuntimePackageManifest | null> {
  const manifestPath = `${directory}/package.json`;
  if (!(await ctx.fs.exists(manifestPath))) return null;
  try {
    return {
      path: manifestPath,
      directory,
      json: JSON.parse(await ctx.fs.readFile(manifestPath)) as Record<string, unknown>,
    };
  } catch (error) {
    throw new PackageManifestResolutionError(
      'EJSONPARSE',
      manifestPath,
      error instanceof Error ? error.message : String(error)
    );
  }
}


export async function findNearestPackageManifest(
  ctx: CommandContext,
  workspaceRoot: string,
  startDirectory: string
): Promise<RuntimePackageManifest | null> {
  let current = startDirectory;
  while (isWithinWorkspace(workspaceRoot, current)) {
    const manifest = await readPackageManifestAt(ctx, current);
    if (manifest) return manifest;
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return null;
}


export function workspacePatterns(manifest: RuntimePackageManifest | null): string[] {
  const workspaces = manifest?.json.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === 'string');
  }
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter((value): value is string => typeof value === 'string');
    }
  }
  return [];
}


export function normalizeWorkspacePattern(pattern: string): string | null {
  assertNoNul(pattern, 'Workspace pattern');
  const normalized = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '';
  if (/^[A-Za-z]:\//.test(normalized)) return null;
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}


export async function packageWorkspaceCandidates(
  ctx: CommandContext,
  workspaceRoot: string,
  rootManifest: RuntimePackageManifest | null
): Promise<RuntimePackageManifest[]> {
  const manifests: RuntimePackageManifest[] = [];
  for (const pattern of workspacePatterns(rootManifest)) {
    const normalized = normalizeWorkspacePattern(pattern);
    if (normalized === null) continue;
    if (!normalized.includes('*')) {
      const manifest = await readPackageManifestAt(ctx, normalized ? toWorkspacePath(workspaceRoot, normalized) : workspaceRoot);
      if (manifest) manifests.push(manifest);
      continue;
    }
    const parts = normalized.split('/');
    const starIndex = parts.indexOf('*');
    if (starIndex === -1 || parts.indexOf('*', starIndex + 1) !== -1) continue;
    const parentPath = parts.slice(0, starIndex).join('/');
    const childSuffix = parts.slice(starIndex + 1).join('/');
    const parentDirectory = parentPath ? toWorkspacePath(workspaceRoot, parentPath) : workspaceRoot;
    if (!(await ctx.fs.exists(parentDirectory))) continue;
    for (const entry of await ctx.fs.readdir(parentDirectory)) {
      const candidateDirectory = childSuffix
        ? `${parentDirectory}/${entry}/${childSuffix}`
        : `${parentDirectory}/${entry}`;
      const manifest = await readPackageManifestAt(ctx, candidateDirectory);
      if (manifest) manifests.push(manifest);
    }
  }
  return manifests;
}


export async function resolveWorkspacePackageManifest(
  ctx: CommandContext,
  workspaceRoot: string,
  workspace: string,
  workspaceAlias?: string
): Promise<RuntimePackageManifest | null> {
  const rootManifest = await readPackageManifestAt(ctx, workspaceRoot);
  const directPath = (() => {
    try {
      return resolveWorkspaceCommandPath(workspaceRoot, workspaceRoot, workspace, workspaceAlias);
    } catch {
      return null;
    }
  })();
  if (directPath) {
    const manifest = await readPackageManifestAt(ctx, directPath);
    if (manifest) return manifest;
  }
  for (const manifest of await packageWorkspaceCandidates(ctx, workspaceRoot, rootManifest)) {
    if (manifest.json.name === workspace || toProjectPath(workspaceRoot, manifest.directory) === workspace) {
      return manifest;
    }
  }
  return null;
}


export async function resolvePackageManifestForInvocation(
  ctx: CommandContext,
  workspaceRoot: string,
  invocation: ParsedPackageManagerInvocation,
  workspaceAlias?: string
): Promise<RuntimePackageManifest> {
  if (invocation.workspace) {
    const workspaceManifest = await resolveWorkspacePackageManifest(ctx, workspaceRoot, invocation.workspace, workspaceAlias);
    if (!workspaceManifest) {
      throw new PackageManifestResolutionError(
        'EWORKSPACE',
        workspaceRoot,
        `No workspaces found matching ${JSON.stringify(invocation.workspace)}`
      );
    }
    return workspaceManifest;
  }

  const startDirectory = invocation.prefix
    ? resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, invocation.prefix, workspaceAlias)
    : ctx.cwd;
  const stat = await ctx.fs.stat(startDirectory).catch(() => null);
  const manifest = await findNearestPackageManifest(
    ctx,
    workspaceRoot,
    stat?.isFile ? dirname(startDirectory) : startDirectory
  );
  if (!manifest) {
    throw new PackageManifestResolutionError(
      'ENOENT',
      `${startDirectory.replace(/\/$/, '')}/package.json`,
      'Could not read package.json'
    );
  }
  return manifest;
}


export function packageBinSearchPaths(workspaceRoot: string, packageDirectory: string): string[] {
  const paths: string[] = [];
  let current = packageDirectory;
  while (isWithinWorkspace(workspaceRoot, current)) {
    paths.push(`${current}/node_modules/.bin`);
    if (current === workspaceRoot) break;
    current = dirname(current);
  }
  return paths;
}


export function withPackageScriptPath(env: Record<string, string>, workspaceRoot: string, packageDirectory: string): string {
  return [
    ...packageBinSearchPaths(workspaceRoot, packageDirectory),
    env.PATH,
    '/usr/bin',
    '/bin',
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).join(':');
}


export function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}


export function appendScriptArgs(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  return `${command} ${args.map(shellQuote).join(' ')}`;
}


export function npmExecLifecycleScript(command: string): string {
  return JSON.stringify(command);
}


export function lifecycleScriptNames(scriptName: string, scripts: Record<string, string>): string[] {
  const names: string[] = [];
  const pre = `pre${scriptName}`;
  const post = `post${scriptName}`;
  if (scripts[pre] !== undefined) names.push(pre);
  if (scripts[scriptName] !== undefined) names.push(scriptName);
  if (scripts[post] !== undefined) names.push(post);
  return names;
}


export function packageDisplayName(manifest: RuntimePackageManifest): string {
  const name = typeof manifest.json.name === 'string' && manifest.json.name.trim()
    ? manifest.json.name.trim()
    : basename(manifest.directory);
  const version = typeof manifest.json.version === 'string' && manifest.json.version.trim()
    ? manifest.json.version.trim()
    : '0.0.0';
  return `${name}@${version}`;
}


export function npmMissingScriptError(scriptName: string): string {
  return [
    `npm error Missing script: "${scriptName}"`,
    'npm error',
    'npm error To see a list of scripts, run:',
    'npm error   npm run',
    '',
  ].join('\n');
}


export function npmScriptBanner(manifest: RuntimePackageManifest, eventName: string, command: string): string {
  return `\n> ${packageDisplayName(manifest)} ${eventName}\n> ${command}\n\n`;
}


export function packageBinEntries(manifest: RuntimePackageManifest): Array<{ name: string; target: string }> {
  const bin = manifest.json.bin;
  const packageName = typeof manifest.json.name === 'string' ? manifest.json.name : '';
  if (typeof bin === 'string' && packageName) {
    return [{ name: packageNameDefaultBinName(packageName), target: bin }];
  }
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.entries(bin)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0)
    .map(([name, target]) => ({ name, target }));
}


export async function packageManifestsInNodeModules(
  ctx: CommandContext,
  nodeModulesDirectory: string
): Promise<RuntimePackageManifest[]> {
  if (!(await ctx.fs.exists(nodeModulesDirectory))) return [];
  const manifests: RuntimePackageManifest[] = [];
  for (const entry of await ctx.fs.readdir(nodeModulesDirectory)) {
    if (entry === '.bin') continue;
    const entryPath = `${nodeModulesDirectory}/${entry}`;
    if (entry.startsWith('@')) {
      for (const scopedEntry of await ctx.fs.readdir(entryPath).catch(() => [])) {
        const manifest = await readPackageManifestAt(ctx, `${entryPath}/${scopedEntry}`);
        if (manifest) manifests.push(manifest);
      }
      continue;
    }
    const manifest = await readPackageManifestAt(ctx, entryPath);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}


export async function ensurePackageBinShims(
  ctx: CommandContext,
  workspaceRoot: string,
  packageDirectory: string
): Promise<void> {
  for (const binDirectory of packageBinSearchPaths(workspaceRoot, packageDirectory)) {
    const nodeModulesDirectory = dirname(binDirectory);
    if (!(await ctx.fs.exists(nodeModulesDirectory))) continue;
    await ctx.fs.mkdir(binDirectory, { recursive: true });
    for (const manifest of await packageManifestsInNodeModules(ctx, nodeModulesDirectory)) {
      for (const bin of packageBinEntries(manifest)) {
        if (bin.name.includes('/') || bin.name.includes('\0')) continue;
        const shimPath = `${binDirectory}/${bin.name}`;
        if (await ctx.fs.exists(shimPath)) continue;
        const targetPath = resolveWorkspaceCommandPath(workspaceRoot, manifest.directory, bin.target);
        if (!isWithinWorkspace(manifest.directory, targetPath)) continue;
        await ctx.fs.writeFile(shimPath, `#!/bin/sh\nnode ${shellQuote(targetPath)} "$@"\n`);
        await ctx.fs.chmod(shimPath, 0o755);
      }
    }
  }
}


export function packageScriptEnv(
  manager: RuntimePackageManagerName,
  managerVersion: string,
  manifest: RuntimePackageManifest,
  workspaceRoot: string,
  originalCwd: string,
  baseEnv: Record<string, string>,
  eventName: string,
  script: string
): Record<string, string> {
  const nodeVersion = NODE_RUNTIME_COMPAT_VERSION;
  return {
    ...baseEnv,
    INIT_CWD: originalCwd,
    PWD: manifest.directory,
    PATH: withPackageScriptPath(baseEnv, workspaceRoot, manifest.directory),
    npm_lifecycle_event: eventName,
    npm_lifecycle_script: script,
    npm_package_name: typeof manifest.json.name === 'string' ? manifest.json.name : '',
    npm_package_version: typeof manifest.json.version === 'string' ? manifest.json.version : '',
    npm_config_user_agent: `${manager}/${managerVersion} node/v${nodeVersion} tracekernel x64 workspaces/false`,
    npm_execpath: `/usr/local/lib/node_modules/${manager}/bin/${manager}-cli.js`,
    npm_node_execpath: '/usr/local/bin/node',
  };
}


export async function runPackageScript(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  scriptName: string,
  scriptArgs: readonly string[],
  options: NormalizedRuntimePackageManagerConfig,
  ifPresent: boolean,
  silent: boolean,
  ignoreScripts: boolean,
  emitOutput?: PackageManagerOutputEmitter
): Promise<RuntimeCommandResult> {
  const scripts = packageScripts(manifest);
  if (
    scriptName === 'start' &&
    scripts.start === undefined &&
    await ctx.fs.exists(`${manifest.directory}/server.js`)
  ) {
    scripts.start = 'node server.js';
  }
  const events = ignoreScripts
    ? (scripts[scriptName] === undefined ? [] : [scriptName])
    : lifecycleScriptNames(scriptName, scripts);
  if (events.length === 0) {
    return ifPresent
      ? { stdout: '', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: npmMissingScriptError(scriptName), exitCode: 1 };
  }
  if (!ctx.exec) {
    return { stdout: '', stderr: `${manager}: package scripts require shell subcommand execution\n`, exitCode: 1 };
  }
  if (options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }

  let stdout = '';
  let stderr = '';
  for (const eventName of events) {
    const script = scripts[eventName]!;
    const command = appendScriptArgs(script, eventName === scriptName ? scriptArgs : []);
    if (!silent) {
      const banner = npmScriptBanner(manifest, eventName, command);
      stdout += banner;
      emitOutput?.('stdout', banner, ctx);
    }
    const result = await ctx.exec(command, {
      cwd: manifest.directory,
      env: packageScriptEnv(manager, options.npmVersion, manifest, workspaceRoot, ctx.cwd, commandEnv(ctx), eventName, script),
      stdin: decodeCommandStdin(ctx.stdin),
      signal: ctx.signal,
    });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) {
      return { stdout, stderr, exitCode: result.exitCode };
    }
  }
  return { stdout, stderr, exitCode: 0 };
}


export async function runPackageExec(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  command: string | undefined,
  args: readonly string[],
  options: NormalizedRuntimePackageManagerConfig
): Promise<RuntimeCommandResult> {
  if (!command) return { stdout: '', stderr: `${manager} exec: missing command\n`, exitCode: 1 };
  if (!ctx.exec) return { stdout: '', stderr: `${manager} exec requires shell subcommand execution\n`, exitCode: 1 };
  if (options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }
  const baseEnv = commandEnv(ctx);
  const nodeVersion = NODE_RUNTIME_COMPAT_VERSION;
  const shellCommand = appendScriptArgs(command, args);
  return ctx.exec(shellCommand, {
    cwd: manifest.directory,
    env: {
      ...baseEnv,
      INIT_CWD: ctx.cwd,
      PWD: manifest.directory,
      PATH: withPackageScriptPath(baseEnv, workspaceRoot, manifest.directory),
      npm_lifecycle_event: 'npx',
      npm_lifecycle_script: npmExecLifecycleScript(command),
      npm_package_name: typeof manifest.json.name === 'string' ? manifest.json.name : '',
      npm_package_version: typeof manifest.json.version === 'string' ? manifest.json.version : '',
      npm_config_user_agent: `${manager}/${options.npmVersion} node/v${nodeVersion} tracekernel x64 workspaces/false`,
      npm_execpath: `/usr/local/lib/node_modules/${manager}/bin/${manager}-cli.js`,
      npm_node_execpath: '/usr/local/bin/node',
    },
    stdin: decodeCommandStdin(ctx.stdin),
    signal: ctx.signal,
  });
}


export function listPackageScripts(manifest: RuntimePackageManifest): RuntimeCommandResult {
  const scripts = packageScripts(manifest);
  const names = Object.keys(scripts);
  if (names.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const lifecycleNames = names.filter((name) => NPM_LIFECYCLE_LIST_SCRIPT_NAMES.has(name));
  const otherNames = names.filter((name) => !NPM_LIFECYCLE_LIST_SCRIPT_NAMES.has(name));
  const lines: string[] = [];
  if (lifecycleNames.length > 0) {
    lines.push(`Lifecycle scripts included in ${packageDisplayName(manifest)}:`);
    for (const name of lifecycleNames) lines.push(`  ${name}`, `    ${scripts[name]}`);
  }
  if (otherNames.length > 0) {
    lines.push('available via `npm run`:');
    for (const name of otherNames) lines.push(`  ${name}`, `    ${scripts[name]}`);
  }
  return {
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
    exitCode: 0,
  };
}


export function listPackageDependencies(manifest: RuntimePackageManifest): RuntimeCommandResult {
  const name = typeof manifest.json.name === 'string' ? manifest.json.name : basename(manifest.directory);
  const version = typeof manifest.json.version === 'string' ? manifest.json.version : '0.0.0';
  const dependencies = packageDependencies(manifest);
  const lines = [`${name}@${version} ${manifest.directory}`];
  for (const [dependency, dependencyVersion] of Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`+-- ${dependency}@${dependencyVersion}`);
  }
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}


export async function runPackageInstall(
  manager: RuntimePackageManagerName,
  ctx: CommandContext,
  workspaceRoot: string,
  manifest: RuntimePackageManifest,
  invocation: ParsedPackageManagerInvocation,
  options: NormalizedRuntimePackageManagerConfig,
  entrypoint: string | undefined,
  workspaceAlias: string | undefined,
  kernel: RuntimeKernelInfo | undefined,
  readonlyFiles: readonly string[] | undefined,
  hiddenFiles: readonly string[] | undefined,
  includeHiddenFiles: (ctx?: CommandContext) => boolean,
  onFileChange: RuntimeFileChangeObserver | undefined
): Promise<RuntimeCommandResult> {
  if (!options.dependencyProvider) {
    return {
      stdout: '',
      stderr: [
        'npm error code ENETUNREACH',
        `npm error network ${manager} ${invocation.installCommand ?? 'install'} could not reach the package registry`,
        'npm error network This environment is offline. Use the dependencies already provided by the project.',
        '',
      ].join('\n'),
      exitCode: 1,
    };
  }
  const result = await applyCommandResultFiles(ctx, workspaceRoot, await options.dependencyProvider.install({
    manager,
    command: invocation.installCommand ?? 'install',
    args: invocation.installArgs,
    cwd: manifest.directory,
    env: commandEnv(ctx),
    manifest,
    project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles(ctx)),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  }), onFileChange);
  if (result.exitCode === 0 && options.autoLinkBins) {
    await ensurePackageBinShims(ctx, workspaceRoot, manifest.directory);
  }
  return result;
}


export async function runPackageManagerCommand(
  commandName: PackageManagerCommandName,
  args: string[],
  ctx: CommandContext,
  workspaceRoot: string,
  options: NormalizedRuntimePackageManagerConfig,
  entrypoint: string | undefined,
  workspaceAlias: string | undefined,
  kernel: RuntimeKernelInfo | undefined,
  readonlyFiles: readonly string[] | undefined,
  hiddenFiles: readonly string[] | undefined,
  includeHiddenFiles: (ctx?: CommandContext) => boolean,
  onFileChange: RuntimeFileChangeObserver | undefined,
  emitOutput?: PackageManagerOutputEmitter
): Promise<RuntimeCommandResult> {
  const manager: RuntimePackageManagerName = commandName === 'npx' ? 'npm' : commandName;
  const invocation = parsePackageManagerInvocation(commandName, args);
  if (invocation.kind === 'version') {
    return { stdout: `${options.npmVersion}\n`, stderr: '', exitCode: 0 };
  }

  let manifest: RuntimePackageManifest;
  try {
    manifest = await resolvePackageManifestForInvocation(ctx, workspaceRoot, invocation, workspaceAlias);
  } catch (error) {
    if (error instanceof PackageManifestResolutionError) {
      if (error.code === 'ENOENT') {
        return {
          stdout: '',
          stderr: [
            'npm error code ENOENT',
            'npm error syscall open',
            `npm error path ${error.path}`,
            'npm error errno -2',
            `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${error.path}'`,
            'npm error enoent This is related to npm not being able to find a file.',
            'npm error enoent',
            '',
          ].join('\n'),
          exitCode: 254,
        };
      }
      if (error.code === 'EJSONPARSE') {
        return {
          stdout: '',
          stderr: [
            'npm error code EJSONPARSE',
            `npm error JSON.parse Invalid package.json: ${error.message}`,
            'npm error JSON.parse Failed to parse JSON data.',
            'npm error JSON.parse Note: package.json must be actual JSON, not just JavaScript.',
            '',
          ].join('\n'),
          exitCode: 1,
        };
      }
      return {
        stdout: '',
        stderr: `npm error code EWORKSPACES\nnpm error ${error.message}\n`,
        exitCode: 1,
      };
    }
    return { stdout: '', stderr: `${manager}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
  }

  switch (invocation.kind) {
    case 'run':
      if (!invocation.scriptName) return listPackageScripts(manifest);
      return runPackageScript(
        manager,
        ctx,
        workspaceRoot,
        manifest,
        invocation.scriptName,
        invocation.scriptArgs,
        options,
        invocation.ifPresent,
        invocation.silent,
        invocation.ignoreScripts,
        emitOutput
      );
    case 'exec':
      return runPackageExec(manager, ctx, workspaceRoot, manifest, invocation.execCommand, invocation.execArgs, options);
    case 'install':
      return runPackageInstall(manager, ctx, workspaceRoot, manifest, invocation, options, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange);
    case 'list':
      return listPackageDependencies(manifest);
    case 'unsupported':
    default:
      return { stdout: '', stderr: `${manager}: unsupported package manager command '${invocation.command}'\n`, exitCode: 1 };
  }
}


export function createPackageManagerProjectCommands(
  config: boolean | RuntimePackageManagerConfig = true,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  emitOutput?: PackageManagerOutputEmitter,
  hiddenFiles?: readonly string[],
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false
): ProjectWorkspaceCommand[] {
  const normalized = normalizePackageManagerConfig(config, true);
  if (!normalized) return [];
  const commands: ProjectWorkspaceCommand[] = normalized.managers.map((manager) =>
    defineCommand(manager, (args, ctx) =>
      runPackageManagerCommand(manager, args, ctx, workspaceRoot, normalized, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange, emitOutput))
  );
  if (normalized.managers.includes('npm')) {
    commands.push(defineCommand('npx', (args, ctx) =>
      runPackageManagerCommand('npx', args, ctx, workspaceRoot, normalized, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles, onFileChange, emitOutput)));
  }
  return commands;
}
