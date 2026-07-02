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
import { getLanguageRuntimeInfo } from '@tracecode/harness-core';
import type { Language } from '@tracecode/harness-core';
import type {
  CommandContext,
  FileContent,
  IFileSystem,
} from 'just-bash/browser';
import type {
  RuntimeCommandEvent,
  RuntimeCommandOptions,
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
  RuntimeProjectTerminalEventHandler,
  RuntimeProjectTerminalInputState,
  RuntimeProjectTerminalInputStateReason,
  RuntimeProjectTerminalPrompt,
  RuntimeProjectTerminalRunOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
  RuntimeWorkspaceActor,
} from '@tracecode/harness-core';
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
import { normalizeTerminalAbsolutePath, terminalCwdLabel } from './paths';
import {
  leadingPersistentCdTarget,
  parseSimpleCommandWords,
  parseTerminalCommandList,
  type TerminalCommandListSegment,
} from './arg-parsers';



export class RuntimeProjectWorkspaceTerminalSession implements RuntimeProjectTerminalSession {
  private currentCwd: string;
  private readonly env: Record<string, string>;
  private currentInputState: RuntimeProjectTerminalInputState;
  private activeStdinPipe: RuntimeCommandOptions['stdinPipe'] | null = null;
  private activeTerminalEventHandler?: RuntimeProjectTerminalEventHandler;
  private activeStdinPrompt = '';
  private activeCommand = '';
  private activeRun = false;
  private readonly onTerminalEvent?: RuntimeProjectTerminalEventHandler;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      kernelInfo: RuntimeKernelInfo;
      resolveCwd: (currentCwd: string, target: string) => Promise<string>;
      runCommand: (command: string, options?: RuntimeCommandOptions) => Promise<RuntimeCommandResult>;
      jobRecords: () => readonly RuntimeProjectTerminalJobRecord[];
      isVerbose: () => boolean;
    },
    sessionOptions: RuntimeProjectTerminalSessionOptions = {}
  ) {
    this.currentCwd = sessionOptions.cwd ?? options.workspaceRoot;
    this.env = { ...(sessionOptions.env ?? {}) };
    this.onTerminalEvent = sessionOptions.onTerminalEvent;
    this.currentInputState = this.createInputState('command');
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get prompt(): RuntimeProjectTerminalPrompt {
    const user = this.options.kernelInfo.user.username;
    const host = this.options.kernelInfo.host.hostname;
    const label = terminalCwdLabel(this.options.workspaceRoot, this.currentCwd, this.options.kernelInfo.home);
    return {
      user,
      host,
      cwd: this.currentCwd,
      label,
      text: `${user}@${host} ${label} %`,
    };
  }

  get inputState(): RuntimeProjectTerminalInputState {
    return this.currentInputState;
  }

  writeStdin(data: string): boolean {
    if (!this.activeStdinPipe || this.currentInputState.mode !== 'stdin') return false;
    this.activeStdinPipe.write(data);
    this.activeStdinPrompt = '';
    this.setInputState('busy', 'stdin-submit');
    return true;
  }

  private createInputState(
    mode: RuntimeProjectTerminalInputState['mode'],
    label = this.prompt.text,
    command = this.activeCommand
  ): RuntimeProjectTerminalInputState {
    return {
      mode,
      prompt: this.prompt,
      label,
      hidden: mode === 'busy',
      disabled: mode === 'busy',
      ...(command ? { command } : {}),
    };
  }

  private emitTerminalEvent(reason: RuntimeProjectTerminalInputStateReason): void {
    const event = { type: 'input-state' as const, reason, state: this.currentInputState };
    this.onTerminalEvent?.(event);
    this.activeTerminalEventHandler?.(event);
  }

  private setInputState(
    mode: RuntimeProjectTerminalInputState['mode'],
    reason: RuntimeProjectTerminalInputStateReason,
    label = this.prompt.text
  ): RuntimeProjectTerminalInputState {
    this.currentInputState = this.createInputState(mode, label);
    this.emitTerminalEvent(reason);
    return this.currentInputState;
  }

  async run(command: string, options: RuntimeProjectTerminalRunOptions = {}): Promise<RuntimeCommandResult> {
    const trimmed = command.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };
    if (this.activeRun) {
      return {
        stdout: '',
        stderr: 'terminal: foreground command already running\n',
        exitCode: 16,
        error: {
          code: 'EBUSY',
          errno: 16,
          syscall: 'run',
          path: this.currentCwd,
          message: `EBUSY: terminal foreground command already running, ${this.currentCwd}`,
        },
      };
    }

    const commandList = parseTerminalCommandList(trimmed);
    if (commandList.some((segment) => segment.background)) {
      return this.runTerminalCommandList(trimmed, commandList, options);
    }

    return this.runForegroundTerminalSubmission(trimmed, options);
  }

  private async runTerminalCommandList(
    submittedCommand: string,
    segments: readonly TerminalCommandListSegment[],
    options: RuntimeProjectTerminalRunOptions
  ): Promise<RuntimeCommandResult> {
    this.activeRun = true;

    const previousStdinPipe = this.activeStdinPipe;
    const previousTerminalEventHandler = this.activeTerminalEventHandler;
    const previousStdinPrompt = this.activeStdinPrompt;
    const previousCommand = this.activeCommand;
    const ownedStdinPipe = options.stdinPipe
      ? undefined
      : canCreateRuntimeCommandStdinPipe()
        ? createRuntimeCommandStdinPipe()
        : undefined;
    const commandStdinPipe = options.stdinPipe ?? ownedStdinPipe;
    this.activeStdinPipe = commandStdinPipe ?? null;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = submittedCommand;
    this.setInputState('busy', 'command-start');

    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let error: RuntimeCommandError | undefined;
      for (const segment of segments) {
        if (segment.background) {
          stdout += this.startTerminalBackgroundCommand(segment.command, options, this.currentCwd);
          continue;
        }
        const result = await this.runForegroundTerminalCommand(segment.command, options, commandStdinPipe);
        stdout += result.stdout;
        stderr += result.stderr;
        exitCode = result.exitCode;
        error = result.error;
      }
      return {
        stdout,
        stderr,
        exitCode,
        ...(error ? { error } : {}),
      };
    } finally {
      ownedStdinPipe?.close();
      this.activeStdinPipe = previousStdinPipe;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      this.activeRun = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private async runForegroundTerminalSubmission(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions
  ): Promise<RuntimeCommandResult> {
    this.activeRun = true;

    const previousStdinPipe = this.activeStdinPipe;
    const previousTerminalEventHandler = this.activeTerminalEventHandler;
    const previousStdinPrompt = this.activeStdinPrompt;
    const previousCommand = this.activeCommand;
    const ownedStdinPipe = options.stdinPipe
      ? undefined
      : canCreateRuntimeCommandStdinPipe()
        ? createRuntimeCommandStdinPipe()
        : undefined;
    const commandStdinPipe = options.stdinPipe ?? ownedStdinPipe;
    this.activeStdinPipe = commandStdinPipe ?? null;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = trimmed;
    this.setInputState('busy', 'command-start');

    try {
      return await this.runForegroundTerminalCommand(trimmed, options, commandStdinPipe);
    } finally {
      ownedStdinPipe?.close();
      this.activeStdinPipe = previousStdinPipe;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      this.activeRun = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private async runForegroundTerminalCommand(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions,
    commandStdinPipe: RuntimeCommandOptions['stdinPipe']
  ): Promise<RuntimeCommandResult> {
    const words = parseSimpleCommandWords(trimmed);
    if (words?.[0] === 'cd') {
      if (words.length > 2) {
        return { stdout: '', stderr: 'cd: too many arguments\n', exitCode: 1 };
      }
      try {
        this.currentCwd = await this.options.resolveCwd(this.currentCwd, words[1] ?? this.options.workspaceRoot);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (error) {
        return { stdout: '', stderr: `cd: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
      }
    }

    if (words?.[0] === 'pwd' && words.length === 1) {
      return { stdout: `${this.currentCwd}\n`, stderr: '', exitCode: 0 };
    }

    let nextCwd: string | null = null;
    const leadingCdTarget = leadingPersistentCdTarget(trimmed);
    if (leadingCdTarget !== null) {
      try {
        nextCwd = await this.options.resolveCwd(this.currentCwd, leadingCdTarget ?? this.options.workspaceRoot);
      } catch {
        nextCwd = null;
      }
    }

    const handleCommandEvent = (event: RuntimeCommandEvent): void => {
      if (event.type === 'status' && !this.options.isVerbose()) return;
      if (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        this.activeStdinPipe &&
        !event.data.endsWith('\n')
      ) {
        this.activeStdinPrompt += event.data;
        const inputState = this.setInputState('stdin', 'stdin-prompt', this.activeStdinPrompt);
        options.onEvent?.({ ...event, terminal: { role: 'stdin-prompt', inputState } });
        return;
      }
      options.onEvent?.(event);
    };

    const result = await this.options.runCommand(trimmed, {
      ...options,
      stdinPipe: commandStdinPipe,
      presentation: 'terminal',
      foreground: true,
      cwd: this.currentCwd,
      env: {
        ...this.env,
        ...(options.env ?? {}),
        PWD: this.currentCwd,
      },
      onEvent: handleCommandEvent,
    });
    if (nextCwd) {
      this.currentCwd = nextCwd;
    }
    return result;
  }

  private startTerminalBackgroundCommand(
    command: string,
    options: RuntimeProjectTerminalRunOptions,
    cwd: string
  ): string {
    const previousJobPids = new Set(this.options.jobRecords().map((job) => job.pid));
    const handleBackgroundEvent = (event: RuntimeCommandEvent): void => {
      if (event.type === 'status' && !this.options.isVerbose()) return;
      options.onEvent?.(event);
    };
    const backgroundRun = this.options.runCommand(command, {
      ...options,
      stdinPipe: undefined,
      presentation: 'terminal',
      foreground: false,
      retainOnExit: true,
      cwd,
      env: {
        ...this.env,
        ...(options.env ?? {}),
        PWD: cwd,
      },
      onEvent: handleBackgroundEvent,
    });
    void backgroundRun.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ type: 'output', stream: 'stderr', data: `${message}\n` });
    });
    const job = this.options.jobRecords().find((candidate) =>
      !previousJobPids.has(candidate.pid) && candidate.command === command
    );
    if (!job) return '';
    const line = `[${job.index}] ${job.pid}\n`;
    options.onEvent?.({ type: 'output', stream: 'stdout', data: line });
    return line;
  }
}


export interface RuntimeProjectTerminalJobRecord {
  index: number;
  pid: number;
  command: string;
}


export function commandInputTokenBounds(input: string, cursor: number): { start: number; end: number } {
  let start = Math.max(0, Math.min(cursor, input.length));
  while (start > 0 && !/\s/.test(input[start - 1] ?? '')) start -= 1;

  let end = Math.max(0, Math.min(cursor, input.length));
  while (end < input.length && !/\s/.test(input[end] ?? '')) end += 1;

  return { start, end };
}


export function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}
