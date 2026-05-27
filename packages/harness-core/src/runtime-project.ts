export type RuntimeFileEncoding = 'utf8' | 'base64';

export interface RuntimeFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
}

export interface RuntimeFileDeletion {
  path: string;
  deleted: true;
}

export interface RuntimeDirectoryChange {
  path: string;
  directory: true;
  deleted?: true;
}

export type RuntimeFileChange = RuntimeFile | RuntimeFileDeletion | RuntimeDirectoryChange;

export type RuntimeWorkspaceActorKind = 'principal' | 'runtime' | 'system';

export interface RuntimeWorkspaceCapabilities {
  read?: readonly string[];
  write?: readonly string[];
  delete?: readonly string[];
  execute?: boolean;
}

export interface RuntimeWorkspaceActor {
  id: string;
  kind: RuntimeWorkspaceActorKind;
  capabilities?: RuntimeWorkspaceCapabilities;
}

export type RuntimeFileMutationPhase = 'live' | 'flush' | 'final-diff';

export interface RuntimeKernelUserConfig {
  id?: string;
  username?: string;
  home?: string;
}

export interface RuntimeKernelHostConfig {
  hostname?: string;
  osName?: string;
}

export interface RuntimeKernelWorkspaceConfig {
  id?: string;
  name?: string;
  root?: string;
  startedAt?: string | Date;
}

export interface RuntimeTraceKernelConfig {
  version?: string;
  user?: RuntimeKernelUserConfig;
  host?: RuntimeKernelHostConfig;
  workspace?: RuntimeKernelWorkspaceConfig;
  workspaceAlias?: string | false;
}

export interface RuntimeKernelUserInfo {
  id: string;
  username: string;
  home: string;
}

export interface RuntimeKernelHostInfo {
  hostname: string;
  osName: string;
}

export interface RuntimeKernelWorkspaceInfo {
  id: string;
  name: string;
  root: string;
  startedAt: string;
}

export type RuntimeProjectSessionExpirationBehavior = 'none' | 'readonly' | 'destroy';

export interface RuntimeProjectSessionLifecycle {
  createdAt: string;
  lastOpenedAt: string;
  expiresAt?: string;
  expiredAt?: string;
  destroyedAt?: string;
  expirationBehavior: RuntimeProjectSessionExpirationBehavior;
}

export interface RuntimeKernelInfo {
  name: 'tracekernel';
  version: string;
  user: RuntimeKernelUserInfo;
  host: RuntimeKernelHostInfo;
  workspace: RuntimeKernelWorkspaceInfo;
  home: string;
  cwd: string;
  workspaceRoot: string;
  workspaceAlias?: string;
}

export interface RuntimeProjectSnapshot {
  files: RuntimeFile[];
  kernelFiles?: RuntimeFile[];
  kernelDevices?: RuntimeKernelDeviceInfo[];
  directories?: string[];
  readonlyFiles?: readonly string[];
  hiddenFiles?: readonly string[];
  entrypoint?: string;
  cwd?: string;
  workspaceRoot?: string;
  workspaceAlias?: string;
  kernel?: RuntimeKernelInfo;
}

export interface RuntimeProjectSessionFile extends RuntimeFile {
  readonly?: boolean;
  hidden?: boolean;
}

export interface RuntimeProjectSessionCommandMetadata {
  hidden?: boolean;
  label?: string;
  description?: string;
}

export interface RuntimeProjectSessionCommandStep extends RuntimeProjectSessionCommandMetadata {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RuntimeProjectSessionCommandGroup extends RuntimeProjectSessionCommandMetadata {
  steps: readonly RuntimeProjectSessionCommandStep[];
}

export type RuntimeProjectSessionCommand =
  | RuntimeProjectSessionCommandStep
  | RuntimeProjectSessionCommandGroup;

export type RuntimeProjectSessionCommandDefinition =
  | string
  | RuntimeProjectSessionCommandStep
  | (RuntimeProjectSessionCommandMetadata & { steps: readonly RuntimeProjectSessionCommandDefinition[] });

export interface RuntimeProjectSession {
  id: string;
  projectId?: string;
  projectSlug?: string;
  name?: string;
  language?: string;
  workspaceRoot?: string;
  cwd?: string;
  entrypoint?: string;
  env?: Record<string, string>;
  commands?: Record<string, RuntimeProjectSessionCommandDefinition>;
  files?: readonly RuntimeProjectSessionFile[];
  directories?: readonly string[];
  createdAt?: string;
  lastOpenedAt?: string;
  expiresAt?: string;
  expirationBehavior?: RuntimeProjectSessionExpirationBehavior;
  metadata?: Record<string, unknown>;
}

export interface RuntimeProjectSessionInfo {
  id: string;
  projectId?: string;
  projectSlug?: string;
  name?: string;
  language?: string;
  workspaceRoot: string;
  cwd: string;
  entrypoint?: string;
  env?: Record<string, string>;
  commands: Record<string, RuntimeProjectSessionCommand>;
  readonlyFiles: readonly string[];
  hiddenFiles: readonly string[];
  lifecycle: RuntimeProjectSessionLifecycle;
  metadata?: Record<string, unknown>;
}

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdinPipe?: RuntimeCommandStdinPipe;
  signal?: AbortSignal;
  args?: string[];
  onEvent?: RuntimeCommandEventHandler;
}

export interface RuntimeCommandStdinSharedBuffer {
  readonly buffer: SharedArrayBuffer;
}

export interface RuntimeCommandStdinPipe extends RuntimeCommandStdinSharedBuffer {
  write(data: string): void;
  close(): void;
}

const RUNTIME_STDIN_PIPE_HEADER_INTS = 3;
const RUNTIME_STDIN_PIPE_HEADER_BYTES = RUNTIME_STDIN_PIPE_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const RUNTIME_STDIN_PIPE_READ_INDEX = 0;
const RUNTIME_STDIN_PIPE_WRITE_INDEX = 1;
const RUNTIME_STDIN_PIPE_CLOSED_INDEX = 2;
const RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY = 64 * 1024;

function assertRuntimeCommandStdinPipeAvailable(): void {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
    throw new Error('Live stdin requires SharedArrayBuffer and Atomics.');
  }
}

export function canCreateRuntimeCommandStdinPipe(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
}

export function createRuntimeCommandStdinPipe(capacity = RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY): RuntimeCommandStdinPipe {
  assertRuntimeCommandStdinPipeAvailable();
  const byteCapacity = Math.max(2, Math.floor(capacity));
  const buffer = new SharedArrayBuffer(RUNTIME_STDIN_PIPE_HEADER_BYTES + byteCapacity);
  const header = new Int32Array(buffer, 0, RUNTIME_STDIN_PIPE_HEADER_INTS);
  const bytes = new Uint8Array(buffer, RUNTIME_STDIN_PIPE_HEADER_BYTES);
  const encoder = new TextEncoder();

  const availableWriteSlots = (): number => {
    const readIndex = Atomics.load(header, RUNTIME_STDIN_PIPE_READ_INDEX);
    const writeIndex = Atomics.load(header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
    return readIndex <= writeIndex
      ? byteCapacity - (writeIndex - readIndex) - 1
      : readIndex - writeIndex - 1;
  };

  return {
    buffer,
    write(data: string): void {
      if (!data) return;
      if (Atomics.load(header, RUNTIME_STDIN_PIPE_CLOSED_INDEX) !== 0) {
        throw new Error('Cannot write to closed live stdin pipe.');
      }
      const encoded = encoder.encode(data);
      if (encoded.byteLength > availableWriteSlots()) {
        throw new Error('Live stdin pipe is full.');
      }
      let writeIndex = Atomics.load(header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
      for (const byte of encoded) {
        bytes[writeIndex] = byte;
        writeIndex = (writeIndex + 1) % byteCapacity;
      }
      Atomics.store(header, RUNTIME_STDIN_PIPE_WRITE_INDEX, writeIndex);
      Atomics.notify(header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
    },
    close(): void {
      Atomics.store(header, RUNTIME_STDIN_PIPE_CLOSED_INDEX, 1);
      Atomics.notify(header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
    },
  };
}

export function createRuntimeCommandStdinPipeFromText(
  text: string,
  capacity = Math.max(RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY, new TextEncoder().encode(text).byteLength + 1)
): RuntimeCommandStdinPipe {
  const pipe = createRuntimeCommandStdinPipe(capacity);
  pipe.write(text);
  pipe.close();
  return pipe;
}

function runtimeCommandStdinPipeState(pipe: RuntimeCommandStdinSharedBuffer): {
  header: Int32Array;
  bytes: Uint8Array;
} {
  return {
    header: new Int32Array(pipe.buffer, 0, RUNTIME_STDIN_PIPE_HEADER_INTS),
    bytes: new Uint8Array(pipe.buffer, RUNTIME_STDIN_PIPE_HEADER_BYTES),
  };
}

function runtimeCommandStdinPipeAvailable(state: { header: Int32Array; bytes: Uint8Array }): number {
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const writeIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
  const capacity = state.bytes.byteLength;
  return readIndex <= writeIndex
    ? writeIndex - readIndex
    : capacity - readIndex + writeIndex;
}

export function runtimeCommandStdinPipeClosed(pipe: RuntimeCommandStdinSharedBuffer): boolean {
  const { header } = runtimeCommandStdinPipeState(pipe);
  return Atomics.load(header, RUNTIME_STDIN_PIPE_CLOSED_INDEX) !== 0;
}

export function runtimeCommandStdinPipeRemainingBytes(pipe: RuntimeCommandStdinSharedBuffer): number {
  return runtimeCommandStdinPipeAvailable(runtimeCommandStdinPipeState(pipe));
}

export function readRuntimeCommandStdinPipeBytes(
  pipe: RuntimeCommandStdinSharedBuffer,
  maxLength = RUNTIME_STDIN_PIPE_DEFAULT_CAPACITY
): Uint8Array {
  const state = runtimeCommandStdinPipeState(pipe);
  const available = runtimeCommandStdinPipeAvailable(state);
  if (available <= 0 || maxLength <= 0) return new Uint8Array();
  const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  const capacity = state.bytes.byteLength;
  const length = Math.min(Math.floor(maxLength), available);
  const out = new Uint8Array(length);
  const firstLength = Math.min(length, capacity - readIndex);
  out.set(state.bytes.subarray(readIndex, readIndex + firstLength), 0);
  if (firstLength < length) {
    out.set(state.bytes.subarray(0, length - firstLength), firstLength);
  }
  Atomics.store(state.header, RUNTIME_STDIN_PIPE_READ_INDEX, (readIndex + length) % capacity);
  return out;
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: RuntimeFileChange[];
}

export type RuntimeCommandEventStream = 'stdout' | 'stderr';

export type RuntimeKernelDevicePath = `/dev/${string}`;

export interface RuntimeKernelDeviceInfo {
  path: RuntimeKernelDevicePath;
  readable: boolean;
  writable: boolean;
  inputDevice?: RuntimeKernelDevicePath;
  outputDevice?: RuntimeKernelDevicePath;
}

export interface RuntimeCommandOutputEvent {
  type: 'output';
  stream: RuntimeCommandEventStream;
  device?: RuntimeKernelDevicePath;
  sourceDevice?: RuntimeKernelDevicePath;
  data: string;
  terminal?: RuntimeCommandOutputTerminalMetadata;
  actor?: RuntimeWorkspaceActor;
}

export interface RuntimeCommandOutputTerminalMetadata {
  role: 'stdin-prompt';
  inputState: RuntimeProjectTerminalInputState;
}

export interface RuntimeCommandStatusEvent {
  type: 'status';
  phase: string;
  message: string;
  detail?: Record<string, unknown>;
  actor?: RuntimeWorkspaceActor;
}

export interface RuntimeCommandFileChangeEvent {
  type: 'file-change';
  change: RuntimeFileChange;
  phase?: RuntimeFileMutationPhase;
  actor?: RuntimeWorkspaceActor;
}

export type RuntimeWorkspaceLifecyclePhase =
  | 'session-expired'
  | 'session-destroyed'
  | 'session-restored';

export interface RuntimeWorkspaceLifecycleEvent {
  type: 'lifecycle';
  phase: RuntimeWorkspaceLifecyclePhase;
  message: string;
  detail?: Record<string, unknown>;
  actor?: RuntimeWorkspaceActor;
}

export type RuntimeCommandEvent =
  | RuntimeCommandOutputEvent
  | RuntimeCommandStatusEvent
  | RuntimeCommandFileChangeEvent
  | RuntimeWorkspaceLifecycleEvent;

export type RuntimeCommandEventHandler = (event: RuntimeCommandEvent) => void;

export interface RuntimeProjectIoBridge {
  output(
    stream: RuntimeCommandEventStream,
    data: string,
    device?: RuntimeKernelDevicePath,
    sourceDevice?: RuntimeKernelDevicePath
  ): void;
  fileChange(change: RuntimeFileChange, phase?: RuntimeFileMutationPhase): void;
  status(phase: string, message: string, detail?: Record<string, unknown>): void;
}

export function createRuntimeProjectIoBridge(onEvent: RuntimeCommandEventHandler | undefined): RuntimeProjectIoBridge {
  return {
    output: (stream, data, device, sourceDevice) => {
      const outputDevice = device ?? (stream === 'stdout' ? '/dev/stdout' : '/dev/stderr');
      onEvent?.({
        type: 'output',
        stream,
        device: outputDevice,
        ...(sourceDevice && sourceDevice !== outputDevice ? { sourceDevice } : {}),
        data,
      });
    },
    fileChange: (change, phase = 'live') => {
      onEvent?.({ type: 'file-change', change, phase });
    },
    status: (phase, message, detail) => {
      onEvent?.({
        type: 'status',
        phase,
        message,
        ...(detail ? { detail } : {}),
      });
    },
  };
}

export function emitRuntimeCommandOutput(
  onEvent: RuntimeCommandEventHandler | undefined,
  stream: RuntimeCommandEventStream,
  data: string,
  device?: RuntimeKernelDevicePath
): void {
  createRuntimeProjectIoBridge(onEvent).output(stream, data, device);
}

export function runtimeFileChangePath(change: RuntimeFileChange): string {
  return change.path;
}

export function emitRuntimeCommandFileChanges(
  onEvent: RuntimeCommandEventHandler | undefined,
  changes: readonly RuntimeFileChange[] | undefined,
  phase: RuntimeFileMutationPhase = 'final-diff'
): void {
  if (!changes) return;
  const io = createRuntimeProjectIoBridge(onEvent);
  for (const change of changes) {
    io.fileChange(change, phase);
  }
}

export function filterRuntimeCommandResultFiles(
  result: RuntimeCommandResult,
  shouldFilter: (change: RuntimeFileChange) => boolean
): RuntimeCommandResult {
  if (!result.files?.length) return result;
  const files = result.files.filter((change) => !shouldFilter(change));
  if (files.length === result.files.length) return result;
  if (files.length > 0) return { ...result, files };
  const { files: _files, ...rest } = result;
  return rest;
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RuntimeProjectOutputTracker {
  private stdoutStreamed = '';
  private stderrStreamed = '';

  observe(event: RuntimeCommandEvent): void {
    if (event.type !== 'output') return;
    if (event.stream === 'stdout') this.stdoutStreamed += event.data;
    if (event.stream === 'stderr') this.stderrStreamed += event.data;
  }

  emitMissingFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    this.emitMissingStreamOutput('stdout', result.stdout, this.stdoutStreamed, output);
    this.emitMissingStreamOutput('stderr', result.stderr, this.stderrStreamed, output);
  }

  private emitMissingStreamOutput(
    stream: RuntimeCommandEventStream,
    finalOutput: string,
    streamedOutput: string,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    if (!finalOutput) return;
    if (!streamedOutput) {
      output(stream, finalOutput);
      return;
    }
    if (finalOutput.startsWith(streamedOutput)) {
      const suffix = finalOutput.slice(streamedOutput.length);
      if (suffix) output(stream, suffix);
    }
  }
}

export interface RuntimeProjectEventQueueOptions {
  actor?: RuntimeWorkspaceActor;
  applyFileChange(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): Promise<boolean | void>;
  emit(event: RuntimeCommandEvent): void;
}

export class RuntimeProjectEventQueue {
  private queue: Promise<void> = Promise.resolve();

  enqueue(event: RuntimeCommandEvent, options: RuntimeProjectEventQueueOptions): void {
    this.queue = this.queue.then(async () => {
      if (event.type !== 'file-change') {
        options.emit(event);
        return;
      }

      const phase = event.phase ?? 'live';
      const shouldEmit = await options.applyFileChange(event.change, phase);
      if (shouldEmit === false) return;
      options.emit({
        ...event,
        phase,
        actor: event.actor ?? options.actor,
      });
    });
  }

  flush(): Promise<void> {
    const pending = this.queue;
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}

export interface RuntimeProjectLiveIoControllerOptions {
  actor?: RuntimeWorkspaceActor;
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<boolean | void>;
  onEvent?: RuntimeCommandEventHandler;
}

export class RuntimeProjectLiveIoController {
  private readonly outputTracker = new RuntimeProjectOutputTracker();
  private readonly eventQueue: RuntimeProjectEventQueue | null;
  private readonly appliedFileChangePaths = new Set<string>();
  private pendingFileChanges = 0;

  constructor(private readonly options: RuntimeProjectLiveIoControllerOptions) {
    this.eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
  }

  emit(event: RuntimeCommandEvent): void {
    this.outputTracker.observe(event);
    this.options.onEvent?.(event);
  }

  handleRuntimeEvent(event: RuntimeCommandEvent): void {
    if (event.type !== 'file-change' && this.pendingFileChanges === 0) {
      this.emit(event);
      return;
    }
    if (!this.eventQueue) {
      this.emit(event);
      return;
    }
    if (event.type === 'file-change') this.pendingFileChanges += 1;
    this.eventQueue.enqueue(event, {
      actor: this.options.actor,
      applyFileChange: async (change, phase) => {
        try {
          const shouldEmit = await this.options.applyFileChange?.(change, phase);
          this.appliedFileChangePaths.add(runtimeFileChangePath(change));
          return shouldEmit;
        } finally {
          this.pendingFileChanges = Math.max(0, this.pendingFileChanges - 1);
        }
      },
      emit: (nextEvent) => this.emit(nextEvent),
    });
  }

  async flush(): Promise<void> {
    await this.eventQueue?.flush();
  }

  filterAppliedResultFiles<Result extends RuntimeCommandResult>(result: Result): Result {
    if (this.appliedFileChangePaths.size === 0) return result;
    return filterRuntimeCommandResultFiles(result, (change) =>
      this.appliedFileChangePaths.has(runtimeFileChangePath(change))
    ) as Result;
  }

  emitMissingFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    this.outputTracker.emitMissingFinalOutput(result, output);
  }
}

export async function applyRuntimeCommandResultFiles(
  result: RuntimeCommandResult,
  applyFileChange: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<void>
): Promise<RuntimeCommandResult> {
  for (const file of result.files ?? []) {
    await applyFileChange(file, 'final-diff');
  }
  const { files: _files, ...commandResult } = result;
  return commandResult;
}

export interface RuntimeProjectWorkerBridgeOptions<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
> {
  request: Request;
  startPhase: string;
  startMessage: string;
  startDetail?: Record<string, unknown>;
  finishPhase: string;
  finishMessage: string;
  finishDetail?: (result: Result) => Record<string, unknown>;
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<boolean | void>;
  run(
    request: Omit<Request, 'onEvent'>,
    onEvent: RuntimeCommandEventHandler
  ): Promise<Result>;
}

export async function runRuntimeProjectWorkerBridge<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
>(options: RuntimeProjectWorkerBridgeOptions<Request, Result>): Promise<Result> {
  const liveIo = new RuntimeProjectLiveIoController({
    applyFileChange: options.applyFileChange,
    onEvent: options.request.onEvent,
  });
  const io = createRuntimeProjectIoBridge((event) => liveIo.emit(event));
  const forwardWorkerEvent = (event: RuntimeCommandEvent): void => {
    liveIo.handleRuntimeEvent(event);
  };
  io.status(options.startPhase, options.startMessage, options.startDetail);
  const { onEvent: _onEvent, ...workerRequest } = options.request;
  let result: Result;
  try {
    result = await options.run(workerRequest, forwardWorkerEvent);
    await liveIo.flush();
  } catch (error) {
    const message = runtimeErrorMessage(error);
    const failedResult = {
      stdout: '',
      stderr: message ? `${message}\n` : 'Runtime project worker failed.\n',
      exitCode: 1,
    } as Result;
    liveIo.emitMissingFinalOutput(failedResult, (stream, data) => io.output(stream, data));
    io.status(options.finishPhase, options.finishMessage, { exitCode: failedResult.exitCode, error: message });
    return failedResult;
  }
  const commandResult = liveIo.filterAppliedResultFiles(result);
  liveIo.emitMissingFinalOutput(commandResult, (stream, data) => io.output(stream, data));
  io.status(
    options.finishPhase,
    options.finishMessage,
    options.finishDetail ? options.finishDetail(commandResult) : { exitCode: commandResult.exitCode }
  );
  return commandResult;
}

export type RuntimeWorkspaceEvent = RuntimeCommandEvent;

export type RuntimeWorkspaceEventHandler = (event: RuntimeWorkspaceEvent) => void;

export type RuntimeWorkspaceUnsubscribe = () => void;

export interface RuntimeWorkspaceKernel {
  readonly info: RuntimeKernelInfo;
  readFile(path: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<string>;
  writeFile(path: string, contents: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<void>;
  deleteFile(path: string, actor?: RuntimeWorkspaceActor): Promise<void>;
  applyFileChange(change: RuntimeFileChange, actor?: RuntimeWorkspaceActor, phase?: RuntimeFileMutationPhase): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
}

export interface RuntimeWorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface RuntimeWorkspaceRemoveOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface RuntimeProjectTerminalPrompt {
  user: string;
  host: string;
  cwd: string;
  label: string;
  text: string;
}

export type RuntimeProjectTerminalInputMode = 'command' | 'busy' | 'stdin';

export type RuntimeProjectTerminalInputStateReason =
  | 'initial'
  | 'command-start'
  | 'stdin-prompt'
  | 'stdin-submit'
  | 'command-finish';

export interface RuntimeProjectTerminalInputState {
  mode: RuntimeProjectTerminalInputMode;
  prompt: RuntimeProjectTerminalPrompt;
  label: string;
  hidden: boolean;
  disabled: boolean;
  command?: string;
}

export interface RuntimeProjectTerminalInputStateEvent {
  type: 'input-state';
  reason: RuntimeProjectTerminalInputStateReason;
  state: RuntimeProjectTerminalInputState;
}

export type RuntimeProjectTerminalEvent = RuntimeProjectTerminalInputStateEvent;

export type RuntimeProjectTerminalEventHandler = (event: RuntimeProjectTerminalEvent) => void;

export interface RuntimeProjectTerminalSession {
  readonly cwd: string;
  readonly prompt: RuntimeProjectTerminalPrompt;
  readonly inputState: RuntimeProjectTerminalInputState;
  writeStdin(data: string): boolean;
  run(command: string, options?: RuntimeProjectTerminalRunOptions): Promise<RuntimeCommandResult>;
}

export interface RuntimeProjectTerminalSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
  onTerminalEvent?: RuntimeProjectTerminalEventHandler;
}

export interface RuntimeProjectTerminalRunOptions extends RuntimeCommandOptions {
  onTerminalEvent?: RuntimeProjectTerminalEventHandler;
}

export type RuntimeProjectCommandSource = 'argument' | 'file' | 'stdin';

export interface RuntimeProjectCommandRequest<
  Source extends string = RuntimeProjectCommandSource
> {
  code: string;
  source: Source;
  scriptPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdinPipe?: RuntimeCommandStdinSharedBuffer;
  project: RuntimeProjectSnapshot;
  options?: Record<string, unknown>;
  onEvent?: RuntimeCommandEventHandler;
}

export type RuntimeProjectCommandRunner<
  Request extends RuntimeProjectCommandRequest<string> = RuntimeProjectCommandRequest
> = (request: Request) => Promise<RuntimeCommandResult>;

export interface RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly cwd: string;
  readonly projectSession?: RuntimeProjectSessionInfo;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  writeFiles(files: readonly RuntimeFile[]): Promise<void>;
  appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<RuntimeWorkspaceStat>;
  readDir(path?: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  moveFile(sourcePath: string, destinationPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  remove(path: string, options?: RuntimeWorkspaceRemoveOptions): Promise<void>;
  isReadOnly(path: string): boolean;
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  runProjectCommand(name: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  createTerminalSession(options?: RuntimeProjectTerminalSessionOptions): RuntimeProjectTerminalSession;
  checkExpiration(now?: Date | string | number): Promise<RuntimeProjectSessionLifecycle | null>;
  destroy(options?: { reason?: string; clearStorage?: boolean }): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  dispose(): void;
}
