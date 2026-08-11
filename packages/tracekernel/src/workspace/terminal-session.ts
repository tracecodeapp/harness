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
  RuntimeProjectOutputTracker,
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
import { getLanguageRuntimeInfo } from '@tracecode/runtime-contracts';
import type { Language } from '@tracecode/runtime-contracts';
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
  RuntimeCommandOutputEvent,
  RuntimeProjectTerminalInputStateReason,
  RuntimeProjectTerminalPrompt,
  RuntimeProjectTerminalCapabilities,
  RuntimeProjectTerminalRunOptions,
  RuntimeProjectTerminalSession,
  RuntimeProjectTerminalSessionOptions,
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
import { normalizeTerminalAbsolutePath, terminalCwdLabel } from './paths';
import {
  leadingPersistentCdTarget,
  parseSimpleCommandWords,
  parseTerminalCommandList,
  type TerminalCommandListSegment,
} from './arg-parsers';



const TERMINAL_SESSION_TRANSIENT_ENV_KEYS = new Set([
  'PWD',
  'OLDPWD',
  'OPTIND',
  'SHELLOPTS',
  'BASHOPTS',
  '_',
]);

const TERMINAL_EXIT_MIN = -(2n ** 63n);
const TERMINAL_EXIT_MAX = (2n ** 63n) - 1n;

function parseTerminalExitCode(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value)) return null;
  try {
    const parsed = BigInt(value.startsWith('+') ? value.slice(1) : value);
    if (parsed < TERMINAL_EXIT_MIN || parsed > TERMINAL_EXIT_MAX) return null;
    return Number(((parsed % 256n) + 256n) % 256n);
  } catch {
    return null;
  }
}

function terminalFilesystemErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b|no such file or directory/i.test(message)) return 'No such file or directory';
  if (/\bENOTDIR\b|not a directory/i.test(message)) return 'Not a directory';
  if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i.test(message)) return 'Permission denied';
  if (/\bEROFS\b|read-only file system|readonly project/i.test(message)) return 'Read-only file system';
  return message;
}

function normalizeTerminalFilesystemStderr(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => {
      const missingMetadata = line.match(/^(?:chmod|chown): cannot access '([^']+)': No such file or directory$/);
      if (missingMetadata) {
        const target = runtimeKernelMetadataTarget(missingMetadata[1] ?? '');
        if (target.kind === 'error' && target.reason === 'proc-read-only') {
          return line.replace(/No such file or directory$/, 'Read-only file system');
        }
      }
      const rawReadonly = line.match(/^EROFS: read-only file system, [^']+ '([^']+)'$/);
      if (rawReadonly) {
        return `bash: ${rawReadonly[1]}: Read-only file system`;
      }
      if (!/^(?:bash|chmod|chown|cp|install|ln|mkdir|mv|rm|rmdir|touch|truncate): /.test(line)) {
        return line;
      }
      return line
        .replace(/Kernel (?:proc path|device namespace) is read-only:.*$/i, 'Read-only file system')
        .replace(/(?:EROFS: )?(?:read-only file system|readonly project (?:file|subtree)),.*$/i, 'Read-only file system')
        .replace(/ENOENT: no such file or directory,.*$/i, 'No such file or directory')
        .replace(/ENOTDIR: not a directory,.*$/i, 'Not a directory')
        .replace(/(?:EACCES|EPERM): (?:permission denied|operation not permitted),.*$/i, 'Permission denied');
    })
    .join('\n');
}

export class RuntimeProjectWorkspaceTerminalSession implements RuntimeProjectTerminalSession {
  private currentCwd: string;
  private readonly env: Record<string, string>;
  private currentInputState: RuntimeProjectTerminalInputState;
  private activeStdinPipe: RuntimeCommandOptions['stdinPipe'] | null = null;
  private activeStdinEnded = false;
  private activeTerminalEventHandler?: RuntimeProjectTerminalEventHandler;
  private activeStdinPrompt = '';
  private activeCommand = '';
  private activeRun = false;
  private sessionClosed = false;
  private terminalColumns: number;
  private terminalRows: number;
  private readonly terminalTerm: string;
  private currentUmask: number;
  private readonly commandHistory: string[] = [];
  private activeCommandAbortController: AbortController | null = null;
  private activeTerminalSignalDelivered = false;
  private readonly onTerminalEvent?: RuntimeProjectTerminalEventHandler;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      kernelInfo: RuntimeKernelInfo;
      resolveCwd: (currentCwd: string, target: string) => Promise<string>;
      runCommand: (command: string, options?: RuntimeCommandOptions) => Promise<RuntimeCommandResult>;
      signalForeground?: (signal: 'SIGINT' | 'SIGQUIT') => boolean;
      terminalInputRouter?: {
        write(data: string): 'kernel' | 'legacy' | 'rejected';
        end(): 'kernel' | 'legacy' | 'rejected';
      };
      resizeTerminal?: (columns: number, rows: number) => void;
      closeTerminal?: () => void;
      jobRecords: () => readonly RuntimeProjectTerminalJobRecord[];
      isVerbose: () => boolean;
    },
    sessionOptions: RuntimeProjectTerminalSessionOptions = {}
  ) {
    this.currentCwd = sessionOptions.cwd ?? options.workspaceRoot;
    this.env = { ...(sessionOptions.env ?? {}) };
    this.terminalColumns = this.normalizeTerminalDimension(sessionOptions.columns, 80, 'columns');
    this.terminalRows = this.normalizeTerminalDimension(sessionOptions.rows, 24, 'rows');
    this.terminalTerm = sessionOptions.term?.trim() || 'dumb';
    this.currentUmask = this.normalizeUmask(sessionOptions.umask);
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
      text: `${user}@${host} ${label} $`,
    };
  }

  get inputState(): RuntimeProjectTerminalInputState {
    return this.currentInputState;
  }

  get terminal(): RuntimeProjectTerminalCapabilities {
    return {
      isTTY: true,
      columns: this.terminalColumns,
      rows: this.terminalRows,
      term: this.terminalTerm,
      colorLevel: 0,
    };
  }

  get history(): readonly string[] {
    return [...this.commandHistory];
  }

  get closed(): boolean {
    return this.sessionClosed;
  }

  resize(columns: number, rows: number): void {
    this.terminalColumns = this.normalizeTerminalDimension(columns, this.terminalColumns, 'columns');
    this.terminalRows = this.normalizeTerminalDimension(rows, this.terminalRows, 'rows');
    this.options.resizeTerminal?.(this.terminalColumns, this.terminalRows);
  }

  close(): void {
    this.closeSession();
  }

  private closeSession(exitCode?: number): void {
    if (this.sessionClosed) return;
    this.sessionClosed = true;
    this.options.closeTerminal?.();
    if (exitCode !== undefined) {
      this.emitControlEvent('exit', exitCode);
    }
  }

  private normalizeTerminalDimension(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`terminal ${name} must be a positive integer`);
    }
    return value;
  }

  interrupt(): boolean {
    return this.signalForeground('SIGINT');
  }

  private signalForeground(signal: 'SIGINT' | 'SIGQUIT'): boolean {
    if (!this.activeRun || this.activeTerminalSignalDelivered) return false;
    if (this.options.signalForeground?.(signal)) {
      this.activeTerminalSignalDelivered = true;
      return true;
    }
    const controller = this.activeCommandAbortController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort({
      signal,
      signalCode: signal === 'SIGINT' ? 2 : 3,
    });
    this.activeTerminalSignalDelivered = true;
    return true;
  }

  writeStdin(data: string): boolean {
    if (!this.activeRun || this.activeStdinEnded) return false;
    const signalCharacter = [...data].find(
      (character) => character === '\x03' || character === '\x1c'
    );
    if (signalCharacter) {
      if (this.activeTerminalSignalDelivered) return false;
      if (this.options.terminalInputRouter?.write(signalCharacter) === 'kernel') {
        this.activeTerminalSignalDelivered = true;
        return true;
      }
      return this.signalForeground(
        signalCharacter === '\x03' ? 'SIGINT' : 'SIGQUIT'
      );
    }
    const routed = this.options.terminalInputRouter?.write(data);
    // The terminal resource is published asynchronously when the first
    // command starts. Preserve input submitted during that startup window in
    // the command pipe; once the terminal exists, the router becomes the
    // authoritative line discipline.
    const route = routed === 'rejected' && this.activeStdinPipe !== null
      ? 'legacy'
      : routed ?? (this.activeStdinPipe !== null ? 'legacy' : 'rejected');
    if (route === 'legacy') {
      this.activeStdinPipe?.write(data);
    }
    const accepted = route !== 'rejected';
    if (accepted && this.currentInputState.mode === 'stdin') {
      this.activeStdinPrompt = '';
      // A foreground TTY keeps presenting an editable line after Enter. The
      // line discipline may buffer that input until the child reads it, but
      // the terminal itself must not disappear and look frozen in between
      // reads.
      this.setInputState('stdin', 'stdin-submit', '');
    }
    return accepted;
  }

  endStdin(): boolean {
    if (!this.activeRun || this.activeStdinEnded) return false;
    const routed = this.options.terminalInputRouter?.end();
    const route = routed === 'rejected' && this.activeStdinPipe !== null
      ? 'legacy'
      : routed ?? (this.activeStdinPipe !== null ? 'legacy' : 'rejected');
    if (route === 'rejected') return false;
    this.activeStdinEnded = true;
    if (route === 'legacy') {
      this.activeStdinPipe?.close();
    }
    this.activeStdinPrompt = '';
    this.setInputState('busy', 'stdin-eof');
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

  private emitControlEvent(action: 'clear' | 'exit', exitCode?: number): void {
    const event = {
      type: 'control' as const,
      action,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
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

  private showForegroundInputLine(): RuntimeProjectTerminalInputState {
    const acceptsInput =
      this.activeStdinPipe !== null || this.options.terminalInputRouter !== undefined;
    return this.setInputState(
      acceptsInput ? 'stdin' : 'busy',
      'command-start',
      acceptsInput ? '' : this.prompt.text
    );
  }

  async run(command: string, options: RuntimeProjectTerminalRunOptions = {}): Promise<RuntimeCommandResult> {
    const trimmed = command.trim();
    if (!trimmed) return { stdout: '', stderr: '', exitCode: 0 };
    if (this.sessionClosed) {
      return {
        stdout: '',
        stderr: 'terminal: session is closed\n',
        exitCode: 1,
        error: {
          code: 'EBADF',
          errno: 9,
          syscall: 'run',
          path: this.currentCwd,
          message: `EBADF: terminal session is closed, ${this.currentCwd}`,
        },
      };
    }
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

    this.commandHistory.push(trimmed);
    if (this.commandHistory.length > 1000) this.commandHistory.shift();

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
    this.activeTerminalSignalDelivered = false;

    const previousStdinPipe = this.activeStdinPipe;
    const previousStdinEnded = this.activeStdinEnded;
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
    this.activeStdinEnded = false;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = submittedCommand;
    // A foreground process owns the terminal immediately. Keep an empty TTY
    // input line visible while it runs so input can be buffered before the
    // child performs its first read.
    this.showForegroundInputLine();

    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let error: RuntimeCommandError | undefined;
      for (const segment of segments) {
        if (segment.background) {
          stdout += await this.startTerminalBackgroundCommand(
            segment.command,
            options,
            this.currentCwd
          );
          continue;
        }
        const result = await this.runForegroundTerminalCommand(segment.command, options, commandStdinPipe);
        stdout += result.stdout;
        stderr += result.stderr;
        exitCode = result.exitCode;
        error = result.error;
        if (this.sessionClosed) break;
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
      this.activeStdinEnded = previousStdinEnded;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      this.activeRun = false;
      this.activeTerminalSignalDelivered = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private async runForegroundTerminalSubmission(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions
  ): Promise<RuntimeCommandResult> {
    this.activeRun = true;
    this.activeTerminalSignalDelivered = false;

    const previousStdinPipe = this.activeStdinPipe;
    const previousStdinEnded = this.activeStdinEnded;
    const previousTerminalEventHandler = this.activeTerminalEventHandler;
    const previousStdinPrompt = this.activeStdinPrompt;
    const previousCommand = this.activeCommand;
    const commandAbortController = new AbortController();
    const forwardExternalAbort = (): void => {
      if (!commandAbortController.signal.aborted) {
        commandAbortController.abort(options.signal?.reason);
      }
    };
    if (options.signal?.aborted) {
      forwardExternalAbort();
    } else {
      options.signal?.addEventListener('abort', forwardExternalAbort, { once: true });
    }
    const ownedStdinPipe = options.stdinPipe
      ? undefined
      : canCreateRuntimeCommandStdinPipe()
        ? createRuntimeCommandStdinPipe()
        : undefined;
    const commandStdinPipe = options.stdinPipe ?? ownedStdinPipe;
    this.activeStdinPipe = commandStdinPipe ?? null;
    this.activeStdinEnded = false;
    this.activeTerminalEventHandler = options.onTerminalEvent;
    this.activeStdinPrompt = '';
    this.activeCommand = trimmed;
    this.activeCommandAbortController = commandAbortController;
    // Match an interactive shell: Enter advances to a fresh terminal line,
    // and that line remains available to the foreground process as stdin.
    this.showForegroundInputLine();

    try {
      const result = await this.runForegroundTerminalCommand(
        trimmed,
        { ...options, signal: commandAbortController.signal },
        commandStdinPipe
      );
      this.closeFromCompletedCommandList(trimmed);
      return result;
    } finally {
      options.signal?.removeEventListener('abort', forwardExternalAbort);
      ownedStdinPipe?.close();
      this.activeStdinPipe = previousStdinPipe;
      this.activeStdinEnded = previousStdinEnded;
      this.activeTerminalEventHandler = previousTerminalEventHandler;
      this.activeStdinPrompt = previousStdinPrompt;
      this.activeCommand = previousCommand;
      if (this.activeCommandAbortController === commandAbortController) {
        this.activeCommandAbortController = null;
      }
      this.activeRun = false;
      this.activeTerminalSignalDelivered = false;
      this.setInputState('command', 'command-finish');
    }
  }

  private closeFromCompletedCommandList(command: string): void {
    if (this.sessionClosed) return;
    const segments = parseTerminalCommandList(command);
    if (segments.length <= 1) return;
    for (const segment of segments) {
      if (segment.background) continue;
      const words = parseSimpleCommandWords(segment.command);
      if (words?.[0] !== 'exit' || words.length > 2) continue;
      const exitCode = words[1] === undefined ? 0 : parseTerminalExitCode(words[1]) ?? 2;
      this.closeSession(exitCode);
      return;
    }
  }

  private async runForegroundTerminalCommand(
    trimmed: string,
    options: RuntimeProjectTerminalRunOptions,
    commandStdinPipe: RuntimeCommandOptions['stdinPipe']
  ): Promise<RuntimeCommandResult> {
    const outputTracker = new RuntimeProjectOutputTracker();
    const words = parseSimpleCommandWords(trimmed);
    if (words?.[0] === 'clear' && words.length === 1) {
      this.emitControlEvent('clear');
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (words?.[0] === 'exit') {
      if (words.length > 2) {
        return { stdout: '', stderr: 'exit: too many arguments\n', exitCode: 1 };
      }
      const requestedExitCode = words[1] === undefined ? 0 : parseTerminalExitCode(words[1]);
      if (requestedExitCode === null) {
        this.closeSession(2);
        return {
          stdout: '',
          stderr: `exit: ${words[1]}: numeric argument required\n`,
          exitCode: 2,
        };
      }
      const exitCode = requestedExitCode;
      this.closeSession(exitCode);
      return { stdout: '', stderr: '', exitCode };
    }
    if (words?.[0] === 'cd') {
      if (words.length > 2) {
        return { stdout: '', stderr: 'cd: too many arguments\n', exitCode: 1 };
      }
      try {
        this.currentCwd = await this.options.resolveCwd(this.currentCwd, words[1] ?? this.options.workspaceRoot);
        return { stdout: '', stderr: '', exitCode: 0 };
      } catch (error) {
        return {
          stdout: '',
          stderr: `cd: ${words[1] ?? this.options.workspaceRoot}: ${terminalFilesystemErrorDetail(error)}\n`,
          exitCode: 1,
        };
      }
    }

    if (words?.[0] === 'pwd' && words.length === 1) {
      return { stdout: `${this.currentCwd}\n`, stderr: '', exitCode: 0 };
    }

    if (words?.[0] === 'history') {
      if (words.length === 2 && words[1] === '-c') {
        this.commandHistory.length = 0;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (words.length > 2 || (words[1] !== undefined && !/^\d+$/.test(words[1]))) {
        return { stdout: '', stderr: 'history: usage: history [-c] [n]\n', exitCode: 2 };
      }
      const requested = words[1] === undefined ? this.commandHistory.length : Number(words[1]);
      const start = Math.max(0, this.commandHistory.length - requested);
      return {
        stdout: this.commandHistory.slice(start).map((entry, index) => `${String(start + index + 1).padStart(5)}  ${entry}\n`).join(''),
        stderr: '',
        exitCode: 0,
      };
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

    let pendingStdoutEvent: RuntimeCommandOutputEvent | undefined;
    const flushPendingStdout = (): void => {
      if (!this.activeStdinPrompt || !pendingStdoutEvent) return;
      options.onEvent?.({
        ...pendingStdoutEvent,
        data: this.activeStdinPrompt,
      });
      this.activeStdinPrompt = '';
      pendingStdoutEvent = undefined;
    };
    const handleTerminalStdinRead = (): void => {
      const prompt = this.activeStdinPrompt;
      const inputState = this.setInputState('stdin', 'stdin-prompt', prompt);
      if (prompt && pendingStdoutEvent) {
        options.onEvent?.({
          ...pendingStdoutEvent,
          data: prompt,
          terminal: { role: 'stdin-prompt', inputState },
        });
      }
      this.activeStdinPrompt = '';
      pendingStdoutEvent = undefined;
    };
    const handleCommandEvent = (event: RuntimeCommandEvent): void => {
      outputTracker.observe(event);
      if (event.type === 'status' && !this.options.isVerbose()) return;
      if (
        event.type === 'output' &&
        event.stream === 'stdout' &&
        this.activeStdinPipe
      ) {
        const combined = this.activeStdinPrompt + event.data;
        if (combined.includes('\r')) {
          this.activeStdinPrompt = combined;
          pendingStdoutEvent = event;
          flushPendingStdout();
          return;
        }
        const lastNewline = combined.lastIndexOf('\n');
        if (lastNewline < 0) {
          this.activeStdinPrompt = combined;
          pendingStdoutEvent = event;
          return;
        }
        const completeOutput = combined.slice(0, lastNewline + 1);
        this.activeStdinPrompt = combined.slice(lastNewline + 1);
        pendingStdoutEvent = this.activeStdinPrompt ? event : undefined;
        options.onEvent?.({ ...event, data: completeOutput });
        return;
      }
      if (event.type === 'output' && event.stream === 'stderr') {
        options.onEvent?.({
          ...event,
          data: normalizeTerminalFilesystemStderr(event.data),
        });
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
        TERM: this.terminalTerm,
        NO_COLOR: '1',
        COLUMNS: String(this.terminalColumns),
        LINES: String(this.terminalRows),
      },
      terminal: this.terminal,
      onTerminalStdinRead: handleTerminalStdinRead,
      umask: this.currentUmask,
      onEvent: handleCommandEvent,
      onEnvChanges: (changes) => this.applySessionEnvChanges(changes),
      onUmaskChange: (umask) => {
        this.currentUmask = this.normalizeUmask(umask);
      },
    });
    flushPendingStdout();
    const completeOutput = outputTracker.completeFinalOutput(result);
    const completeResult = {
      ...result,
      ...completeOutput,
      stderr: normalizeTerminalFilesystemStderr(completeOutput.stderr),
    };
    if (completeResult.error?.code === 'EINTR' && typeof completeResult.error.detail?.signal === 'string') {
      const signalCode = typeof completeResult.error.detail.signalCode === 'number'
        ? completeResult.error.detail.signalCode
        : 2;
      return {
        ...completeResult,
        exitCode: 128 + signalCode,
        // Preserve the structured signal for the terminal renderer, but do
        // not expose the kernel's parent-side syscall bookkeeping as stderr.
        stderr: completeResult.stderr,
      };
    }
    if (nextCwd) {
      this.currentCwd = nextCwd;
    }
    return completeResult;
  }

  // Persist shell variable changes (export FOO=…, FOO=…, unset FOO) onto the
  // session so later submissions observe them, like an interactive shell.
  // Path-state bookkeeping stays owned by the terminal's own cwd tracking.
  private applySessionEnvChanges(changes: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(changes)) {
      if (TERMINAL_SESSION_TRANSIENT_ENV_KEYS.has(key)) continue;
      if (value === undefined) {
        delete this.env[key];
      } else {
        this.env[key] = value;
      }
    }
  }

  private async startTerminalBackgroundCommand(
    command: string,
    options: RuntimeProjectTerminalRunOptions,
    cwd: string
  ): Promise<string> {
    const previousJobPids = new Set(this.options.jobRecords().map((job) => job.pid));
    let resolveProcessStarted!: () => void;
    const processStarted = new Promise<void>((resolve) => {
      resolveProcessStarted = resolve;
    });
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
        TERM: this.terminalTerm,
        NO_COLOR: '1',
        COLUMNS: String(this.terminalColumns),
        LINES: String(this.terminalRows),
      },
      terminal: this.terminal,
      umask: this.currentUmask,
      onEvent: handleBackgroundEvent,
      onProcessStart: () => {
        resolveProcessStarted();
      },
    });
    void backgroundRun.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      options.onEvent?.({ type: 'output', stream: 'stderr', data: `${message}\n` });
    });
    await Promise.race([
      processStarted,
      backgroundRun.then(() => undefined, () => undefined),
    ]);
    const job = this.options.jobRecords().find((candidate) =>
      !previousJobPids.has(candidate.pid) && candidate.command === command
    );
    if (!job) return '';
    const line = `[${job.index}] ${job.pid}\n`;
    options.onEvent?.({ type: 'output', stream: 'stdout', data: line });
    return line;
  }

  private normalizeUmask(value: number | undefined): number {
    return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 0o777
      ? value
      : 0o022;
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
