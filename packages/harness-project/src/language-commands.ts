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
} from '@tracecode/harness-core';
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
} from '@tracecode/harness-core';
import { BROWSER_PROJECT_NODE_COMPAT_VERSION, getLanguageRuntimeInfo } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
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
} from '@tracecode/harness-core';
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
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
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

export type RuntimeProjectSnapshotProvider = (
  ctx: CommandContext,
  includeHiddenFiles: boolean
) => Promise<RuntimeProjectSnapshot>;


export interface TraceKernelCommandHelp {
  summary: string;
  usage: string;
  options?: readonly string[];
  notes?: readonly string[];
  flags?: readonly string[];
}


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
  help?: TraceKernelCommandHelp;
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


function runWithCommandContext<Request extends RuntimeProjectCommandRequest<string>>(
  runner: RuntimeProjectCommandRunner<Request>,
  request: Request,
  ctx: CommandContext
): Promise<RuntimeCommandResult> {
  return (runner as (request: Request, ctx: CommandContext) => Promise<RuntimeCommandResult>)(request, ctx);
}


function snapshotProjectProvider(
  workspaceRoot: string,
  entrypoint?: string,
  workspaceAlias?: string,
  kernel?: RuntimeKernelInfo,
  readonlyFiles?: readonly string[],
  hiddenFiles?: readonly string[],
  snapshotProject?: RuntimeProjectSnapshotProvider
): RuntimeProjectSnapshotProvider {
  return snapshotProject ?? ((ctx, includeHiddenFiles) =>
    snapshotCommandContext(ctx, workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles, includeHiddenFiles)
  );
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


function commandHelp(
  summary: string,
  usage: string,
  options: readonly string[] = [],
  config: { notes?: readonly string[]; flags?: readonly string[] } = {}
): TraceKernelCommandHelp {
  return {
    summary,
    usage,
    ...(options.length > 0 ? { options } : {}),
    ...(config.notes ? { notes: config.notes } : {}),
    flags: config.flags ?? ['--help'],
  };
}


function languageHelp(name: string): TraceKernelCommandHelp {
  if (name === 'python' || name === 'python3') {
    return commandHelp('run Python code', `${name} [OPTIONS] [-c COMMAND | -m MODULE | SCRIPT] [ARG]...`, [
      '-c COMMAND          execute the Python code in COMMAND',
      '-m MODULE           run a supported library module as a script',
      '-V, --version       print the Python version and exit',
      '-                   read the program from standard input',
    ], { flags: ['--help', '-h'] });
  }
  if (name === 'node') {
    return commandHelp('run JavaScript with the Node.js-compatible runtime', 'node [OPTIONS] [SCRIPT] [ARG]...', [
      '-e, --eval CODE     evaluate JavaScript code',
      '-p, --print CODE    evaluate and print the result',
      '-r, --require MOD   preload a supported module',
      '--input-type TYPE   set the input module type',
      '-v, --version       print the runtime version and exit',
      '-                   read the program from standard input',
    ], { flags: ['--help', '-h'] });
  }
  if (name === 'tsc') {
    return commandHelp('compile a TypeScript project', 'tsc [OPTIONS] [FILE]...', [
      '-p, --project PATH  compile the project at PATH',
      '--noEmit            type-check without writing output files',
      '-v, --version       print the compiler version and exit',
    ], { flags: ['--help', '-h'] });
  }
  if (name === 'javac') {
    return commandHelp('compile Java source files', 'javac [OPTIONS] SOURCE...', [
      '-cp, -classpath PATH  specify the class path',
      '-d DIR               write class files under DIR',
      '--release RELEASE    compile for the specified Java release',
      '--enable-preview     enable preview language features',
      '--version            print the compiler version and exit',
    ], { flags: ['--help', '-help', '-h', '-?'] });
  }
  if (name === 'java') {
    return commandHelp('run a Java application', 'java [OPTIONS] MAINCLASS [ARG]...\n       java [OPTIONS] -jar JARFILE [ARG]...', [
      '-cp, -classpath PATH  specify the class path',
      '-jar JARFILE          execute the main class in JARFILE',
      '-DNAME=VALUE          set a system property',
      '-ea                    enable assertions',
      '--enable-preview      allow preview class files',
      '--version             print the runtime version and exit',
    ], { flags: ['--help', '-help', '-h', '-?'] });
  }
  if (name === 'dotnet') {
    return commandHelp('build and run .NET applications', 'dotnet [OPTIONS] [COMMAND] [ARG]...', [
      '--info              display .NET environment information',
      '--version           print the SDK version and exit',
      'build [PROJECT]     build a project',
      'run [-- ARGS...]    build and run a project',
    ], { flags: ['--help', '-h'] });
  }
  return commandHelp('compile C and C++ source files', `${name} [OPTIONS] FILE...`, [
    '-o FILE             write the executable to FILE',
    '-I DIR              add an include search path',
    '-D NAME[=VALUE]     define a preprocessor macro',
    '-std=STANDARD       select the language standard',
    '-c                  compile without linking',
    '--version           print the compiler version and exit',
  ]);
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
    help: languageHelp(name),
  });
}


export function createTraceKernelCommandRegistry(
  options: CreateRuntimeWorkspaceOptions,
  packageManagerConfig: NormalizedRuntimePackageManagerConfig | null
): TraceKernelCommandInfo[] {
  const commands: TraceKernelCommandInfo[] = [
    commandInfo('bg', 'control', 'shell job control', {
      help: commandHelp('move a job to the background', 'bg [PID|%JOB]'),
    }),
    commandInfo('curl', 'tool', 'HTTP client', {
      help: commandHelp('transfer data from or to a URL', 'curl [OPTIONS] URL', [
        '-d, --data DATA       send form data in a request body',
        '--json JSON           send a JSON request body',
        '-G, --get             append supplied data to the query string',
        '-H, --header HEADER   add a request header',
        '-X, --request METHOD  specify the request method',
        '-i, --include         include response headers',
        '-I, --head            fetch response headers only',
        '-f, --fail            fail on HTTP error status',
        '--fail-with-body      fail on HTTP error and retain the body',
        '-L, --location        follow redirects',
        '-o, --output FILE     write the response body to FILE',
        '-w, --write-out FMT   print response metadata using FMT',
        '--max-time SECONDS    limit the operation duration',
        '-s, --silent          suppress progress and errors',
        '-S, --show-error      show errors when used with --silent',
        '-v, --verbose         show request and response details',
        '-k, --insecure        allow connections without certificate checks',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('df', 'tool', 'filesystem capacity', {
      help: commandHelp('report logical workspace filesystem usage', 'df [OPTION]... [FILE]...', [
        '-h, --human-readable  print human-readable byte counts',
        '-i, --inodes          report entry capacity instead of bytes',
        '-k                    report 1024-byte blocks',
        '-P                    use the portable output shape',
      ]),
    }),
    commandInfo('du', 'tool', 'filesystem usage', {
      help: commandHelp('estimate logical workspace entry usage', 'du [OPTION]... [FILE]...', [
        '-a, --all             write counts for files as well as directories',
        '-b, --bytes           print exact logical byte counts',
        '-h, --human-readable  print human-readable byte counts',
        '-k                    print 1024-byte logical block counts',
        '-s, --summarize       display only a total for each argument',
        '-c, --total           append a grand total',
        '--max-depth=N         print directories at most N levels below an argument',
      ]),
    }),
    commandInfo('fg', 'control', 'shell job control', {
      help: commandHelp('move a job to the foreground', 'fg [PID|%JOB]'),
    }),
    commandInfo('fastfetch', 'tool', 'system information', {
      help: commandHelp('display TraceKernel system information', 'fastfetch [OPTION]', [
        '--version           print the TraceKernel fastfetch version and exit',
      ]),
    }),
    commandInfo('getconf', 'tool', 'system configuration lookup', {
      help: commandHelp('query system configuration values', 'getconf NAME'),
    }),
    commandInfo('getent', 'tool', 'identity and host database lookup', {
      help: commandHelp('query an identity or host database', 'getent DATABASE [KEY]'),
    }),
    commandInfo('groups', 'tool', 'group identity', {
      help: commandHelp('display group membership', 'groups [USER]'),
    }),
    commandInfo('jobs', 'control', 'shell job control', {
      help: commandHelp('display active jobs', 'jobs [-l]', [
        '-l                  include process IDs',
      ]),
    }),
    commandInfo('hostname', 'tool', 'kernel host identity', {
      help: commandHelp('display the TraceKernel host name', 'hostname [-s|-f]', [
        '-s                  display the short host name',
        '-f                  display the configured host name',
      ]),
    }),
    commandInfo('id', 'tool', 'kernel user identity', {
      help: commandHelp('display user and group identity', 'id [-u|-g] [-n] [USER]', [
        '-u                  display only the user ID',
        '-g                  display only the primary group ID',
        '-n                  display the name instead of a numeric ID',
      ]),
    }),
    commandInfo('kill', 'control', 'process control', {
      help: commandHelp('send a signal to a process or process group', 'kill [-SIGNAL] PID...', [
        '-SIGNAL             signal name or number; SIGTERM is the default',
        '--                  end option processing',
      ]),
    }),
    commandInfo('lsof', 'tool', 'open file and network socket inspection', {
      help: commandHelp('list processes listening on a TCP port', 'lsof -i :PORT', [
        '-i :PORT            select a listening TCP port',
      ], { flags: ['--help', '-h', '-?'] }),
    }),
    commandInfo('locale', 'tool', 'locale configuration', {
      help: commandHelp('display locale configuration', 'locale [-a|charmap]'),
    }),
    commandInfo('ls', 'tool', 'directory listing', {
      help: commandHelp('list directory contents', 'ls [OPTION]... [FILE]...', [
        '-a, --all            include entries starting with .',
        '-A, --almost-all     include hidden entries except . and ..',
        '-d, --directory      list directories themselves',
        '-F, --classify       append file-type indicators',
        '-h, --human-readable print human-readable sizes with -l',
        '-l                   use a long listing format',
        '-r, --reverse        reverse the selected ordering',
        '-R, --recursive      list subdirectories recursively',
        '-S                   sort by size, largest first',
        '-t                   sort by modification time, newest first',
        '-1                   list one entry per line',
      ]),
    }),
    commandInfo('man', 'tool', 'command manual', {
      help: commandHelp('display the manual for an available command', 'man COMMAND'),
    }),
    commandInfo('mktemp', 'tool', 'temporary file creation', {
      help: commandHelp('create a unique temporary file or directory', 'mktemp [OPTION]... [TEMPLATE]', [
        '-d, --directory     create a directory instead of a file',
        '-p, --tmpdir DIR    interpret TEMPLATE relative to DIR',
        '--suffix=SUFFIX     append SUFFIX to the generated name',
        '-u, --dry-run       print a name without creating it',
        '-q, --quiet         suppress creation diagnostics',
      ]),
    }),
    commandInfo('mount', 'tool', 'mounted filesystem inspection', {
      help: commandHelp('display the TraceKernel filesystem topology', 'mount [-l]', [
        '-l, --show-labels   include the virtual filesystem source label',
      ]),
    }),
    commandInfo('neofetch', 'tool', 'fastfetch compatibility alias', {
      help: commandHelp('display TraceKernel system information', 'neofetch [OPTION]', [
        '--version           print the TraceKernel fastfetch version and exit',
      ]),
    }),
    commandInfo('pgrep', 'control', 'process lookup', {
      help: commandHelp('find processes by name or command line', 'pgrep [-aflx] PATTERN', [
        '-a                  list PID and full command line',
        '-f                  match against the full command line',
        '-l                  list PID and process name',
        '-x                  require an exact match',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('ping', 'tool', 'network reachability probe', {
      help: commandHelp('send reachability probes to a host', 'ping [-c COUNT] HOST', [
        '-c COUNT            stop after COUNT replies',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('pkill', 'control', 'process control', {
      help: commandHelp('signal processes selected by name or command line', 'pkill [-fx] [-SIGNAL] PATTERN', [
        '-f                  match against the full command line',
        '-x                  require an exact match',
        '-SIGNAL             signal name or number; SIGTERM is the default',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('ps', 'control', 'process table', {
      help: commandHelp('display the process table', 'ps [-e|-f|-ef|aux]', [
        '-e                  include every process',
        '-f                  use the full process format',
        'aux                 use the BSD-style process format',
      ]),
    }),
    commandInfo('ss', 'tool', 'socket inspection', {
      help: commandHelp('display listening sockets', 'ss [-ltnp]', [
        '-l, --listening     display listening sockets',
        '-t, --tcp           select TCP sockets',
        '-n, --numeric       keep addresses and ports numeric',
        '-p, --processes     show the owning process',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('stat', 'tool', 'file metadata inspection', {
      help: commandHelp('display file status', 'stat [OPTION]... FILE...', [
        '-L, --dereference   follow symbolic links',
        '-c, --format FORMAT use FORMAT instead of the default display',
        'FORMAT              supports %n %N %s %F %a %A %u %U %g %G %Y %y %i %h',
      ]),
    }),
    commandInfo('stty', 'tool', 'terminal settings inspection', {
      help: commandHelp('inspect terminal line settings', 'stty [-a|size]', [
        '-a                  display the supported terminal settings',
        'size                print terminal rows and columns',
      ]),
    }),
    commandInfo('tput', 'tool', 'terminal capability lookup', {
      help: commandHelp('query capabilities of the current terminal', 'tput CAPABILITY', [
        'cols                print the terminal width',
        'lines               print the terminal height',
        'colors              print the supported color count',
        'longname            print the terminal description',
      ]),
    }),
    commandInfo('tracekernelctl', 'control', 'kernel control plane', {
      help: commandHelp('inspect and control the TraceKernel workspace', 'tracekernelctl COMMAND [ARG]...', [
        'status              display kernel and scheduler status',
        'verbose [MODE]      toggle or set verbose terminal output',
        'kill PID [SIGNAL]   signal a workspace process',
        'wait [PID]          wait for a child process to exit',
        'reset               reset the workspace when policy permits',
      ]),
    }),
    commandInfo('tty', 'tool', 'terminal identity', {
      help: commandHelp('print the terminal connected to standard input', 'tty [-s]', [
        '-s                  print nothing; return terminal status only',
      ]),
    }),
    commandInfo('umask', 'control', 'file creation mask', {
      help: commandHelp('display or set the shell file creation mask', 'umask [-p|-S] [MODE]', [
        '-p                  print a reusable shell command',
        '-S                  display the mask as symbolic allowed permissions',
        'MODE                set an octal or symbolic permission mask',
      ]),
    }),
    commandInfo('uname', 'tool', 'kernel identity', {
      help: commandHelp('display TraceKernel system information', 'uname [OPTION]...', [
        '-a, --all           display all available fields',
        '-s                  display the kernel name',
        '-n                  display the host name',
        '-r                  display the kernel release',
        '-v                  display the kernel build identity',
        '-m                  display the machine architecture',
        '-o                  display the operating system name',
      ]),
    }),
    commandInfo(TRACEKERNEL_EXEC_COMMAND, 'control', 'virtual executable dispatcher', {
      help: commandHelp('dispatch a TraceKernel virtual executable', `${TRACEKERNEL_EXEC_COMMAND} EXECUTABLE [ARG]...`),
    }),
    commandInfo('wait', 'control', 'process control', {
      help: commandHelp('wait for a child process to exit', 'wait [PID]'),
    }),
    commandInfo('wget', 'tool', 'HTTP downloader', {
      help: commandHelp('retrieve a resource over HTTP or HTTPS', 'wget [OPTION]... URL', [
        '-q, --quiet         suppress non-error output',
        '-O, --output-document FILE  write the response to FILE; use - for stdout',
        '--spider            check that the resource is reachable without downloading it',
        '-T, --timeout SECONDS  limit the operation duration',
        '--header HEADER     add a request header',
        '--post-data DATA    send DATA in a POST request',
      ], { flags: ['--help', '-h'] }),
    }),
    commandInfo('which', 'tool', 'command resolver', {
      help: commandHelp('locate commands in the command path', 'which [-a] COMMAND...', [
        '-a                  print every matching path',
      ]),
    }),
    commandInfo('whoami', 'tool', 'kernel user identity', {
      help: commandHelp('display the current user name', 'whoami'),
    }),
    commandInfo('command', 'tool', 'command resolver', {
      help: commandHelp('execute a command or describe how it resolves', 'command [-pVv] COMMAND [ARG]...', [
        '-p                  use the standard command path',
        '-v                  print the resolved command path',
        '-V                  print the resolved command path',
      ]),
    }),
  ];

  if (options.pythonRunner) {
    commands.push(
      languageCommandInfo('python', 'python3', 'CPython runtime'),
      languageCommandInfo('python', 'python', 'CPython runtime')
    );
  }
  if (options.nodeRunner) {
    commands.push(languageCommandInfo(
      'javascript',
      'node',
      'Node.js-compatible runtime',
      'Node.js-compatible command for JavaScript project execution.'
    ));
  }
  if (options.typescriptRunner) {
    commands.push(languageCommandInfo('typescript', 'tsc', 'TypeScript compiler'));
  }
  if (options.javaRunner) {
    commands.push(
      languageCommandInfo('java', 'javac', 'OpenJDK compiler'),
      languageCommandInfo('java', 'java', 'OpenJDK runtime')
    );
  }
  if (options.cppRunner) {
    for (const compiler of ['clang++', 'clang', 'gcc', 'cc', 'g++', 'c++']) {
      commands.push(languageCommandInfo('cpp', compiler, 'Clang/LLVM compiler'));
    }
    commands.push(commandInfo('a.out', 'virtual-executable', 'native executable', {
      language: 'cpp',
      displayName: getLanguageRuntimeInfo('cpp').displayName,
      versionLabel: getLanguageRuntimeInfo('cpp').versionLabel,
      description: 'Default C++ project executable produced by compile commands.',
      help: commandHelp('run the default compiled C++ executable', 'a.out [ARG]...'),
    }));
  }
  if (options.csharpRunner) {
    commands.push(languageCommandInfo('csharp', 'dotnet', '.NET SDK'));
  }
  if (packageManagerConfig?.managers.includes('npm')) {
    commands.push(
      commandInfo('npm', 'package-manager', 'npm package manager', {
        help: commandHelp('run package scripts and inspect the project package', 'npm COMMAND [ARG]...', [
          'run [SCRIPT]       list scripts or run SCRIPT',
          'start              run the start script',
          'test               run the test script',
          'exec COMMAND       run a package executable',
          'install            install declared dependencies',
          'list               list declared dependencies',
          '-v, --version      print the npm-compatible version and exit',
        ], { flags: ['--help', '-h'] }),
      }),
      commandInfo('npx', 'package-manager', 'npm package executable', {
        help: commandHelp('run a package executable', 'npx COMMAND [ARG]...', [
          '-v, --version      print the npm-compatible version and exit',
          '--                  end npx option processing',
        ], { flags: ['--help', '-h'] }),
      })
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
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false,
  snapshotProject = snapshotProjectProvider(workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles)
): ProjectWorkspaceCommand[] {
  const runPython = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parsePythonInvocation(args);
    if (isCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      const version = /CPython\s+([0-9.]+)/.exec(getLanguageRuntimeInfo('python').runtime.detail ?? '')?.[1]
        ?? /Python\s+([0-9.]+)/.exec(getLanguageRuntimeInfo('python').versionLabel)?.[1]
        ?? '3';
      return { stdout: `Python ${version}\n`, stderr: '', exitCode: 0 };
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
    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotProject(ctx, includeHiddenFiles(ctx)),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx), onFileChange);
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
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false,
  snapshotProject = snapshotProjectProvider(workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles)
): ProjectWorkspaceCommand[] {
  const runNode = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseNodeInvocation(args);
    if (isNodeCommandResult(parsed)) return parsed;

    if (parsed.showVersion) {
      return { stdout: `v${BROWSER_PROJECT_NODE_COMPAT_VERSION}\n`, stderr: '', exitCode: 0 };
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
      code = stat.isFile ? stripNodeShebang(await ctx.fs.readFile(absolutePath)) : '';
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
    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code,
      source,
      scriptPath,
      args: parsedScript.scriptArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotProject(ctx, includeHiddenFiles(ctx)),
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
    }, ctx), onFileChange);
  };

  return [
    defineCommand('node', runNode),
  ];
}

function stripNodeShebang(code: string): string {
  if (!code.startsWith('#!')) return code;
  return code.replace(/^#![^\r\n]*(?:\r?\n|$)/, (line) => line.replace(/[^\r\n]/g, ' '));
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
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false,
  snapshotProject = snapshotProjectProvider(workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles)
): ProjectWorkspaceCommand[] {
  const runTsc = async (args: string[], ctx: CommandContext): Promise<RuntimeCommandResult> => {
    const parsed = parseTscInvocation(args);
    if (isTscCommandResult(parsed)) return parsed;
    if (parsed.showVersion) {
      const version = getLanguageRuntimeInfo('typescript').compiler?.version ?? 'unknown';
      return { stdout: `Version ${version}\n`, stderr: '', exitCode: 0 };
    }
    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code: '',
      source: 'compile',
      scriptPath: 'tsconfig.json',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotProject(ctx, includeHiddenFiles(ctx)),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx), onFileChange);
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
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false,
  snapshotProject = snapshotProjectProvider(workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles)
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
      const version = getLanguageRuntimeInfo('java').compiler?.version ?? 'unknown';
      return { stdout: `javac ${version}\n`, stderr: '', exitCode: 0 };
    }

    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code: '',
      source: 'compile',
      scriptPath: primaryJavacSourceArg(parsed.args),
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotProject(ctx, includeHiddenFiles(ctx)),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx), onFileChange);
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
      const version = getLanguageRuntimeInfo('java').runtime.version ?? 'unknown';
      const banner = [
        `openjdk ${version}`,
        `OpenJDK Runtime Environment (build ${version})`,
        `OpenJDK 64-Bit Server VM (build ${version}, mixed mode)`,
        '',
      ].join('\n');
      return expandedArgs.includes('-version')
        ? { stdout: '', stderr: banner, exitCode: 0 }
        : { stdout: banner, stderr: '', exitCode: 0 };
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
    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code: '',
      source: 'run',
      scriptPath: jarPath ?? parsed.mainClass ?? '<main>',
      args: programArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotProject(ctx, includeHiddenFiles(ctx)),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: {
        ...(jarPath ? { jarPath, classpath: jarPath } : parsed.classpath ? { classpath: parsed.classpath } : {}),
        ...(jarMainClass ? { jarMainClass } : {}),
        ...(Object.keys(parsed.systemProperties).length > 0 ? { systemProperties: parsed.systemProperties } : {}),
        ...(parsed.enablePreview ? { enablePreview: true } : {}),
        ...(parsed.enableAssertions ? { enableAssertions: true } : {}),
      },
    }, ctx), onFileChange);
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
    includeHiddenFiles?: (ctx?: CommandContext) => boolean;
    snapshotProject?: RuntimeProjectSnapshotProvider;
  } = {}
): ProjectWorkspaceCommand[] {
  const snapshotProject = options.snapshotProject ?? snapshotProjectProvider(
    workspaceRoot,
    options.entrypoint,
    options.workspaceAlias,
    options.kernel,
    options.readonlyFiles,
    options.hiddenFiles
  );
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
      const version = getLanguageRuntimeInfo('cpp').compiler?.version ?? 'unknown';
      return {
        stdout: `clang version ${version}\nTarget: wasm32-unknown-wasi\nThread model: posix\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    const result = await runWithCommandContext(runner, {
      code: parsed.args.includes('-') ? decodeCommandStdin(ctx.stdin) : '',
      source: 'compile',
      scriptPath: parsed.args.find((arg) => /\.(?:c|cc|cpp|cxx)$/i.test(arg)) ?? '<compile>',
      args: parsed.args,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      project: await snapshotProject(ctx, options.includeHiddenFiles?.(ctx) ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      options: { compilerCommand },
    }, ctx);
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
    return applyCommandResultFiles(ctx, workspaceRoot, await runWithCommandContext(runner, {
      code: '',
      source: 'run',
      scriptPath: defaultPath,
      args: expandedArgs,
      cwd: ctx.cwd,
      env: commandEnv(ctx),
      ...(stdinPipe ? { stdinPipe: { buffer: stdinPipe.buffer } } : {}),
      project: await snapshotProject(ctx, options.includeHiddenFiles?.(ctx) ?? false),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx), options.onFileChange);
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
  includeHiddenFiles: (ctx?: CommandContext) => boolean = () => false,
  snapshotProject = snapshotProjectProvider(workspaceRoot, entrypoint, workspaceAlias, kernel, readonlyFiles, hiddenFiles)
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
      const version = getLanguageRuntimeInfo('csharp').runtime.version ?? 'unknown';
      if (expandedArgs.includes('--info')) {
        return {
          stdout: [
            '.NET SDK:',
            ` Version:           ${version}`,
            '',
            'Runtime Environment:',
            ' OS Name:     tracekernel',
            ' OS Platform: tracekernel',
            ' RID:         tracekernel-x64',
            '',
            'Host:',
            `  Version:      ${version}`,
            '  Architecture: x64',
            '',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: `${version}\n`, stderr: '', exitCode: 0 };
    }

    const project = filterReadonlySnapshotFiles(
      await snapshotProject(ctx, includeHiddenFiles(ctx)),
      readonlyFiles,
      hiddenFiles
    );

    const stdinPipe = parsed.source === 'run' ? commandStdinPipe(ctx) : undefined;
    const result = await runWithCommandContext(runner, {
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
    }, ctx);
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
