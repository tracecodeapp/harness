import { AsyncLocalStorage } from 'node:async_hooks';
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
} from '../../harness-core/src/runtime-project';
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
} from '../../harness-core/src/runtime-kernel';
import { getLanguageRuntimeInfo } from '../../harness-core/src/runtime-language-info';
import type { Language } from '../../harness-core/src/runtime-types';
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
} from '../../harness-core/src/runtime-project';
import type {
  CppProjectCommandRunner,
  CSharpProjectCommandRunner,
  CreateRuntimeWorkspaceOptions,
  JavaProjectCommandRunner,
  JavaScriptProjectCommandRequest,
  JavaScriptProjectCommandRunner,
  ProjectWorkspaceCommand,
  PythonProjectCommandRequest,
  PythonProjectCommandRunner,
  RuntimePackageDependencyProvider,
  RuntimePackageInstallRequest,
  RuntimePackageManagerConfig,
  RuntimePackageManagerName,
  RuntimePackageManifest,
  TypeScriptProjectCommandRunner,
} from './index';
import { DEFAULT_CWD, TRACEKERNEL_BIN_PATH, TRACEKERNEL_EXEC_COMMAND } from './constants';
import { applyCommandResultFiles, filterReadonlySnapshotDeletions, filterReadonlySnapshotFiles, snapshotCommandContext, type RuntimeFileChangeObserver } from './fs-observed';
import { decodeCommandStdin, parsePythonInvocation, isCommandResult, parseNodeInvocation, isNodeCommandResult, parseTscInvocation, isTscCommandResult, expandJavaCommandArgfiles, parseJavacInvocation, isJavacCommandResult, primaryJavacSourceArg, parseJavaInvocation, isJavaCommandResult, extractStoredJarMainClass, parseCppCompileInvocation, isCppCompileCommandResult, cppOutputPathFromArgs, parseDotnetInvocation, isDotnetCommandResult } from './arg-parsers';
import { expandParsedScriptInvocation, expandWorkspaceGlobArgs, resolveWorkspaceCommandPath, resolveWorkspaceContextPath, toProjectPath } from './paths';
import type { NormalizedRuntimePackageManagerConfig } from './package-manager';


export type TraceKernelCommandKind = 'control' | 'runtime' | 'package-manager' | 'tool' | 'virtual-executable';


export interface TraceKernelCommandInfo {
  name: string;
  path: string;
  kind: TraceKernelCommandKind;
  adapter: string;
  available: boolean;
  language?: Language;
  displayName?: string;
  versionLabel?: string;
  description?: string;
}


export interface TraceKernelRuntimeInfo {
  language: Language;
  displayName: string;
  versionLabel: string;
  available: boolean;
  adapter: string;
  commands: string[];
  paths: string[];
  runtime: ReturnType<typeof getLanguageRuntimeInfo>['runtime'];
  compiler?: ReturnType<typeof getLanguageRuntimeInfo>['compiler'];
  standard?: string;
}


export function traceKernelCommandPath(command: string): string {
  return `${TRACEKERNEL_BIN_PATH}/${command}`;
}


export function commandEnv(ctx: CommandContext): Record<string, string> {
  return Object.fromEntries(ctx.env.entries());
}


export function commandStdinPipe(ctx: CommandContext) {
  const stdin = decodeCommandStdin(ctx.stdin);
  return stdin ? createRuntimeCommandStdinPipeFromText(stdin) : undefined;
}


export function commandInfo(
  name: string,
  kind: TraceKernelCommandKind,
  adapter: string,
  options: Omit<TraceKernelCommandInfo, 'name' | 'path' | 'kind' | 'adapter' | 'available'> = {}
): TraceKernelCommandInfo {
  return {
    name,
    path: traceKernelCommandPath(name),
    kind,
    adapter,
    available: true,
    ...options,
  };
}


export function languageCommandInfo(
  language: Language,
  name: string,
  adapter: string,
  description?: string
): TraceKernelCommandInfo {
  const info = getLanguageRuntimeInfo(language);
  return commandInfo(name, 'runtime', adapter, {
    language,
    displayName: info.displayName,
    versionLabel: info.versionLabel,
    ...(description ? { description } : {}),
  });
}


export function createTraceKernelCommandRegistry(
  options: CreateRuntimeWorkspaceOptions,
  packageManagerConfig: NormalizedRuntimePackageManagerConfig | null
): TraceKernelCommandInfo[] {
  const commands: TraceKernelCommandInfo[] = [
    commandInfo('bg', 'control', 'tracekernel job control'),
    commandInfo('curl', 'tool', 'tracekernel HTTP bridge'),
    commandInfo('fg', 'control', 'tracekernel job control'),
    commandInfo('jobs', 'control', 'tracekernel job control'),
    commandInfo('kill', 'control', 'tracekernel process control'),
    commandInfo('ls', 'tool', 'tracekernel-aware directory listing'),
    commandInfo('ps', 'control', 'tracekernel process table'),
    commandInfo('tracekernelctl', 'control', 'tracekernel control plane'),
    commandInfo(TRACEKERNEL_EXEC_COMMAND, 'control', 'tracekernel virtual executable dispatcher'),
    commandInfo('wait', 'control', 'tracekernel process control'),
    commandInfo('which', 'tool', 'tracekernel command resolver'),
    commandInfo('command', 'tool', 'tracekernel command resolver'),
  ];

  if (options.pythonRunner) {
    commands.push(
      languageCommandInfo('python', 'python3', 'Python project command adapter'),
      languageCommandInfo('python', 'python', 'Python project command adapter')
    );
  }
  if (options.nodeRunner) {
    commands.push(languageCommandInfo(
      'javascript',
      'node',
      'Node-compatible JavaScript project command adapter',
      'Adapter command for JavaScript project execution; browser workspaces run this through the worker-backed JavaScript lane.'
    ));
  }
  if (options.typescriptRunner) {
    commands.push(languageCommandInfo('typescript', 'tsc', 'TypeScript project compile adapter'));
  }
  if (options.javaRunner) {
    commands.push(
      languageCommandInfo('java', 'javac', 'Java project compile adapter'),
      languageCommandInfo('java', 'java', 'Java project run adapter')
    );
  }
  if (options.cppRunner) {
    for (const compiler of ['clang++', 'clang', 'gcc', 'cc', 'g++', 'c++']) {
      commands.push(languageCommandInfo('cpp', compiler, 'C/C++ project compile adapter'));
    }
    commands.push(commandInfo('a.out', 'virtual-executable', 'C++ virtual executable adapter', {
      language: 'cpp',
      displayName: getLanguageRuntimeInfo('cpp').displayName,
      versionLabel: getLanguageRuntimeInfo('cpp').versionLabel,
      description: 'Default C++ project executable produced by compile commands.',
    }));
  }
  if (options.csharpRunner) {
    commands.push(languageCommandInfo('csharp', 'dotnet', '.NET/C# project command adapter'));
  }
  if (packageManagerConfig?.managers.includes('npm')) {
    commands.push(
      commandInfo('npm', 'package-manager', 'npm-compatible project package manager adapter'),
      commandInfo('npx', 'package-manager', 'npm-compatible project executable adapter')
    );
  }

  const deduped = new Map<string, TraceKernelCommandInfo>();
  for (const command of commands) {
    if (!deduped.has(command.name)) deduped.set(command.name, command);
  }
  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}


export function traceKernelRuntimeRegistry(commands: readonly TraceKernelCommandInfo[]): TraceKernelRuntimeInfo[] {
  const runtimes: TraceKernelRuntimeInfo[] = [];
  const runtimeLanguages: Language[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
  for (const language of runtimeLanguages) {
    const info = getLanguageRuntimeInfo(language);
    const languageCommands = commands.filter((command) => command.language === language && command.kind === 'runtime');
    runtimes.push({
      language,
      displayName: info.displayName,
      versionLabel: info.versionLabel,
      available: languageCommands.length > 0,
      adapter: languageCommands.map((command) => command.adapter).filter(Boolean)[0] ?? 'not configured',
      commands: languageCommands.map((command) => command.name),
      paths: languageCommands.map((command) => command.path),
      runtime: info.runtime,
      ...(info.compiler ? { compiler: info.compiler } : {}),
      ...(info.standard ? { standard: info.standard } : {}),
    });
  }
  return runtimes;
}


export function createPythonProjectCommands(
  runner: PythonProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runPython = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parsePythonInvocation(args);
    if (isCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Python project command adapter\n', stderr: '', exitCode: 0 };
    }

    const stdin = decodeCommandStdin(ctx.stdin);
    let parsedScript: { scriptFile: string | null; scriptArgs: string[] };
    try {
      parsedScript = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.scriptFile, parsed.scriptArgs, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let code: string;
    let scriptPath: string;
    let source: PythonProjectCommandRequest['source'];

    if (parsed.code !== null) {
      code = parsed.code;
      scriptPath = '-c';
      source = 'argument';
    } else if (parsed.module !== null) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(parsed.module)) {
        return { stdout: '', stderr: `python3: No module named '${parsed.module.slice(0, 200)}'\n`, exitCode: 1 };
      }
      code = `import runpy; runpy.run_module(${JSON.stringify(parsed.module)}, run_name='__main__')`;
      scriptPath = parsed.module;
      source = 'module';
    } else if (parsedScript.scriptFile === '-') {
      code = stdin;
      scriptPath = '-';
      source = 'stdin';
    } else if (parsedScript.scriptFile !== null) {
      let absolutePath: string;
      try {
        absolutePath = resolveWorkspaceContextPath(ctx, workspaceRoot, parsedScript.scriptFile, 'Python script path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
      }
      if (!(await ctx.fs.exists(absolutePath))) {
        return {
          stdout: '',
          stderr: `python3: can't open file '${parsedScript.scriptFile}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }
      code = await ctx.fs.readFile(absolutePath);
      scriptPath = toProjectPath(workspaceRoot, absolutePath);
      source = 'file';
    } else if (stdin.trim().length > 0) {
      code = stdin;
      scriptPath = '<stdin>';
      source = 'stdin';
    } else {
      return {
        stdout: '',
        stderr: 'python3: no input provided (use -c CODE, -m MODULE, or provide a script file)\n',
        exitCode: 2,
      };
    }

    const stdinPipe = source === 'stdin' ? undefined : commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  return [
    defineCommand('python3', runPython),
    defineCommand('python', runPython),
  ];
}


export function createNodeProjectCommands(
  runner: JavaScriptProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runNode = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseNodeInvocation(args);
    if (isNodeCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Node project command adapter\n', stderr: '', exitCode: 0 };
    }

    const stdin = decodeCommandStdin(ctx.stdin);
    let parsedScript: { scriptFile: string | null; scriptArgs: string[] };
    try {
      parsedScript = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.scriptFile, parsed.scriptArgs, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let code: string;
    let scriptPath: string;
    let source: JavaScriptProjectCommandRequest['source'];

    if (parsed.code !== null) {
      code = parsed.code;
      scriptPath = '-e';
      source = 'argument';
    } else if (parsedScript.scriptFile === '-') {
      code = stdin;
      scriptPath = '-';
      source = 'stdin';
    } else if (parsedScript.scriptFile !== null) {
      let absolutePath: string;
      try {
        absolutePath = resolveWorkspaceContextPath(ctx, workspaceRoot, parsedScript.scriptFile, 'Node script path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 9 };
      }
      if (!(await ctx.fs.exists(absolutePath))) {
        return {
          stdout: '',
          stderr: `node: cannot find module '${parsedScript.scriptFile}'\n`,
          exitCode: 1,
        };
      }
      const stat = await ctx.fs.stat(absolutePath);
      if (!stat.isFile && !stat.isDirectory) {
        return {
          stdout: '',
          stderr: `node: cannot find module '${parsedScript.scriptFile}'\n`,
          exitCode: 1,
        };
      }
      code = stat.isFile ? await ctx.fs.readFile(absolutePath) : '';
      scriptPath = toProjectPath(workspaceRoot, absolutePath);
      source = 'file';
    } else if (stdin.trim().length > 0) {
      code = stdin;
      scriptPath = '<stdin>';
      source = 'stdin';
    } else {
      return {
        stdout: '',
        stderr: 'node: no input provided (use -e CODE or provide a script file)\n',
        exitCode: 9,
      };
    }

    const stdinPipe = source === 'stdin' ? undefined : commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(
        parsed.inputType || parsed.requireModules.length > 0
          ? {
              options: {
                ...(parsed.inputType ? { inputType: parsed.inputType } : {}),
                ...(parsed.requireModules.length > 0 ? { require: parsed.requireModules } : {}),
              },
            }
          : {}
      ),
    }), onFileChange);
  };

  return [
    defineCommand('node', runNode),
  ];
}


export function createTypeScriptProjectCommands(
  runner: TypeScriptProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runTsc = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseTscInvocation(args);
    if (isTscCommandResult(parsed)) return parsed;
    if (parsed.showVersion) {
      return { stdout: 'TypeScript project command adapter\n', stderr: '', exitCode: 0 };
    }
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'compile',
      scriptPath: 'tsconfig.json',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  return [
    defineCommand('tsc', runTsc),
  ];
}


export function createJavaProjectCommands(
  runner: JavaProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runJavac = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandJavaCommandArgfiles(args, ctx, workspaceRoot);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    let globExpandedArgs: string[];
    try {
      globExpandedArgs = await expandWorkspaceGlobArgs(expandedArgs, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseJavacInvocation(globExpandedArgs);
    if (isJavacCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Java project command adapter\n', stderr: '', exitCode: 0 };
    }

    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'compile',
      scriptPath: primaryJavacSourceArg(parsed.args),
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), onFileChange);
  };

  const runJava = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandJavaCommandArgfiles(args, ctx, workspaceRoot);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseJavaInvocation(expandedArgs);
    if (isJavaCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'Java project command adapter\n', stderr: '', exitCode: 0 };
    }

    let parsedJar: { scriptFile: string | null; scriptArgs: string[] };
    let programArgs: string[];
    try {
      parsedJar = await expandParsedScriptInvocation(ctx, workspaceRoot, parsed.jarPath, parsed.programArgs, workspaceAlias);
      programArgs = parsed.jarPath ? parsedJar.scriptArgs : await expandWorkspaceGlobArgs(parsed.programArgs, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const jarPath = parsed.jarPath ? parsedJar.scriptFile : null;
    let jarMainClass: string | null = null;
    if (jarPath) {
      let absoluteJarPath: string;
      try {
        absoluteJarPath = resolveWorkspaceContextPath(ctx, workspaceRoot, jarPath, 'Java jar path');
      } catch (error) {
        return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
      }
      if (!(await ctx.fs.exists(absoluteJarPath))) {
        return { stdout: '', stderr: `Error: Unable to access jarfile ${jarPath}\n`, exitCode: 1 };
      }
      jarMainClass = extractStoredJarMainClass(await ctx.fs.readFileBuffer(absoluteJarPath));
    }

    const stdinPipe = commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath: jarPath ?? parsed.mainClass ?? '<main>',
      args: programArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: {
        ...(jarPath ? { jarPath, classpath: jarPath } : parsed.classpath ? { classpath: parsed.classpath } : {}),
        ...(jarMainClass ? { jarMainClass } : {}),
        ...(Object.keys(parsed.systemProperties).length > 0 ? { systemProperties: parsed.systemProperties } : {}),
        ...(parsed.enablePreview ? { enablePreview: true } : {}),
        ...(parsed.enableAssertions ? { enableAssertions: true } : {}),
      },
    }), onFileChange);
  };

  return [
    defineCommand('javac', runJavac),
    defineCommand('java', runJava),
  ];
}


export function createCppProjectCommands(
  runner: CppProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  options: {
    recordExecutablePath?: (path: string) => void;
    entrypoint?: string;
    onFileChange?: RuntimeFileChangeObserver;
    workspaceAlias?: string;
    kernel?: RuntimeKernelInfo;
    readonlyFiles?: readonly string[];
    hiddenFiles?: readonly string[];
    includeHiddenFiles?: () => boolean;
  } = {}
): ProjectWorkspaceCommand[] {
  const runCompiler = (compilerCommand: string) => async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, options.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    const parsed = parseCppCompileInvocation(expandedArgs);
    if (isCppCompileCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: `${compilerCommand} project command adapter\n`, stderr: '', exitCode: 0 };
    }

    const result = await runner({
      code: parsed.args.includes('-') ? decodeCommandStdin(ctx.stdin) : '',
      source: 'compile',
      scriptPath: parsed.args.find((arg) => /\.(?:c|cc|cpp|cxx)$/i.test(arg)) ?? '<compile>',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel, options.readonlyFiles, options.hiddenFiles, options.includeHiddenFiles?.() ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: { compilerCommand },
    });
    const commandResult = await applyCommandResultFiles(ctx, workspaceRoot, result, options.onFileChange);
    if (commandResult.exitCode === 0) {
      options.recordExecutablePath?.(toProjectPath(workspaceRoot, resolveWorkspaceCommandPath(workspaceRoot, ctx.cwd, cppOutputPathFromArgs(parsed.args), options.workspaceAlias)));
    }
    return commandResult;
  };

  const runExecutable = (defaultPath: string) => async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, options.workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
    const stdinPipe = commandStdinPipe(ctx);
    return applyCommandResultFiles(ctx, workspaceRoot, await runner({
      code: '',
      source: 'run',
      scriptPath: defaultPath,
      args: expandedArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotCommandContext(ctx, workspaceRoot, options.entrypoint, options.workspaceAlias, options.kernel, options.readonlyFiles, options.hiddenFiles, options.includeHiddenFiles?.() ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }), options.onFileChange);
  };

  return [
    defineCommand('clang++', runCompiler('clang++')),
    defineCommand('clang', runCompiler('clang')),
    defineCommand('gcc', runCompiler('gcc')),
    defineCommand('cc', runCompiler('cc')),
    defineCommand('g++', runCompiler('g++')),
    defineCommand('c++', runCompiler('c++')),
    defineCommand('./a.out', runExecutable('./a.out')),
    defineCommand('a.out', runExecutable('a.out')),
  ];
}


export function createCSharpProjectCommands(
  runner: CSharpProjectCommandRunner,
  workspaceRoot: string = DEFAULT_CWD,
  entrypoint?: string,
  onFileChange?: RuntimeFileChangeObserver,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  includeHiddenFiles: () => boolean = () => false
): ProjectWorkspaceCommand[] {
  const runDotnet = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    let expandedArgs: string[];
    try {
      expandedArgs = await expandWorkspaceGlobArgs(args, ctx, workspaceRoot, workspaceAlias);
    } catch (error) {
      return { stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
    }
    const parsed = parseDotnetInvocation(expandedArgs);
    if (isDotnetCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: 'C# project command adapter\n', stderr: '', exitCode: 0 };
    }

    const project = filterReadonlySnapshotFiles(
      await snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles()),
      readonlyFiles,
      hiddenFiles
    );

    const stdinPipe = parsed.source === 'run' ? commandStdinPipe(ctx) : undefined;
    const result = await runner({
      code: '',
      source: parsed.source,
      scriptPath: parsed.scriptPath,
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(parsed.buildArgs || parsed.noBuild
        ? {
            options: {
              ...(parsed.buildArgs ? { buildArgs: parsed.buildArgs } : {}),
              ...(parsed.noBuild ? { noBuild: true } : {}),
            },
          }
        : {}),
    });
    return applyCommandResultFiles(
      ctx,
      workspaceRoot,
      filterReadonlySnapshotDeletions(result, readonlyFiles),
      onFileChange
    );
  };

  return [
    defineCommand('dotnet', runDotnet),
  ];
}
