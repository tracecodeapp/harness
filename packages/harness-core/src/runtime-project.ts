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

export type RuntimeFileChange = RuntimeFile | RuntimeFileDeletion;

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
  directories?: string[];
  entrypoint?: string;
  cwd?: string;
  workspaceRoot?: string;
  workspaceAlias?: string;
  kernel?: RuntimeKernelInfo;
}

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  args?: string[];
  onEvent?: RuntimeCommandEventHandler;
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: RuntimeFileChange[];
}

export type RuntimeCommandEventStream = 'stdout' | 'stderr';

export type RuntimeKernelDevicePath =
  | '/dev/stdin'
  | '/dev/stdout'
  | '/dev/stderr'
  | '/dev/tty';

export interface RuntimeCommandOutputEvent {
  type: 'output';
  stream: RuntimeCommandEventStream;
  device?: RuntimeKernelDevicePath;
  data: string;
  actor?: RuntimeWorkspaceActor;
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

export type RuntimeCommandEvent =
  | RuntimeCommandOutputEvent
  | RuntimeCommandStatusEvent
  | RuntimeCommandFileChangeEvent;

export type RuntimeCommandEventHandler = (event: RuntimeCommandEvent) => void;

export interface RuntimeProjectIoBridge {
  output(stream: RuntimeCommandEventStream, data: string, device?: RuntimeKernelDevicePath): void;
  fileChange(change: RuntimeFileChange, phase?: RuntimeFileMutationPhase): void;
  status(phase: string, message: string, detail?: Record<string, unknown>): void;
}

export function createRuntimeProjectIoBridge(onEvent: RuntimeCommandEventHandler | undefined): RuntimeProjectIoBridge {
  return {
    output: (stream, data, device) => {
      onEvent?.({
        type: 'output',
        stream,
        device: device ?? (stream === 'stdout' ? '/dev/stdout' : '/dev/stderr'),
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

export class RuntimeProjectOutputTracker {
  private stdoutStreamed = false;
  private stderrStreamed = false;

  observe(event: RuntimeCommandEvent): void {
    if (event.type !== 'output') return;
    if (event.stream === 'stdout') this.stdoutStreamed = true;
    if (event.stream === 'stderr') this.stderrStreamed = true;
  }

  emitMissingFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>,
    output: (stream: RuntimeCommandEventStream, data: string) => void
  ): void {
    if (result.stdout && !this.stdoutStreamed) output('stdout', result.stdout);
    if (result.stderr && !this.stderrStreamed) output('stderr', result.stderr);
  }
}

export interface RuntimeProjectEventQueueOptions {
  actor?: RuntimeWorkspaceActor;
  applyFileChange(change: RuntimeFileChange, phase: RuntimeFileMutationPhase): Promise<void>;
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
      await options.applyFileChange(event.change, phase);
      options.emit({
        ...event,
        phase,
        actor: event.actor ?? options.actor,
      });
    });
  }

  flush(): Promise<void> {
    return this.queue;
  }
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
  applyFileChange?: (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<void>;
  run(
    request: Omit<Request, 'onEvent'>,
    onEvent: RuntimeCommandEventHandler
  ): Promise<Result>;
}

export async function runRuntimeProjectWorkerBridge<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
>(options: RuntimeProjectWorkerBridgeOptions<Request, Result>): Promise<Result> {
  const outputTracker = new RuntimeProjectOutputTracker();
  const eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
  const io = createRuntimeProjectIoBridge((event) => {
    outputTracker.observe(event);
    options.request.onEvent?.(event);
  });
  const emitWorkerEvent = (event: RuntimeCommandEvent): void => {
    outputTracker.observe(event);
    options.request.onEvent?.(event);
  };
  const forwardWorkerEvent = (event: RuntimeCommandEvent): void => {
    if (eventQueue) {
      eventQueue.enqueue(event, {
        applyFileChange: options.applyFileChange as (change: RuntimeFileChange, phase: RuntimeFileMutationPhase) => Promise<void>,
        emit: emitWorkerEvent,
      });
      return;
    }
    emitWorkerEvent(event);
  };
  io.status(options.startPhase, options.startMessage, options.startDetail);
  const { onEvent: _onEvent, ...workerRequest } = options.request;
  const result = await options.run(workerRequest, forwardWorkerEvent);
  await eventQueue?.flush();
  io.status(
    options.finishPhase,
    options.finishMessage,
    options.finishDetail ? options.finishDetail(result) : { exitCode: result.exitCode }
  );
  outputTracker.emitMissingFinalOutput(result, (stream, data) => io.output(stream, data));
  return result;
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
  snapshot(options?: { entrypoint?: string }): Promise<RuntimeProjectSnapshot>;
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
  stdin: string;
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
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  snapshot(options?: { entrypoint?: string }): Promise<RuntimeProjectSnapshot>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  dispose(): void;
}
