export type RuntimeFileEncoding = 'utf8' | 'base64';

/** Canonical, traversal-safe project path normalization shared by every surface. */
export function normalizeRuntimeProjectPath(path: string): string {
  if (path.includes('\0')) throw new Error('Project path must not contain NUL bytes.');
  const normalized = path.replace(/\\/g, '/');
  if (normalized.trim().length === 0) throw new Error('Project path must not be empty.');
  if (normalized.startsWith('/')) throw new Error(`Project path must be relative: ${path}`);
  if (/^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Project path must not include a drive prefix: ${path}`);
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Project path must not escape the workspace: ${path}`);
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Project path must point to a file: ${path}`);
  return parts.join('/');
}

export interface RuntimeFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  /** Permission bits, without the file-type bits. */
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export interface RuntimeSymlink {
  path: string;
  symlink: true;
  target: string;
}

export interface RuntimeFileDeletion {
  path: string;
  deleted: true;
}

export interface RuntimeDirectoryChange {
  path: string;
  directory: true;
  deleted?: true;
  /** Permission bits, without the file-type bits. */
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export type RuntimeDirectory = Omit<RuntimeDirectoryChange, 'directory' | 'deleted'>;

export type RuntimeFileChange = RuntimeFile | RuntimeSymlink | RuntimeFileDeletion | RuntimeDirectoryChange;

export type RuntimeWorkspaceActorKind = 'principal' | 'test' | 'hidden-test' | 'runtime' | 'system';

export interface RuntimeWorkspaceHttpCapabilities {
  listen?: boolean;
  dispatch?: boolean;
  externalFetch?: boolean;
  readDiagnostics?: boolean;
}

export interface RuntimeWorkspaceCapabilities {
  read?: readonly string[];
  write?: readonly string[];
  delete?: readonly string[];
  execute?: boolean;
  http?: RuntimeWorkspaceHttpCapabilities;
}

export interface RuntimeWorkspaceActor {
  id: string;
  kind: RuntimeWorkspaceActorKind;
  capabilities?: RuntimeWorkspaceCapabilities;
}

export type RuntimeWorkspaceHttpCapabilityPresetName = 'workspace' | 'system' | 'none';

export const RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS = {
  workspace: {
    listen: true,
    dispatch: true,
    readDiagnostics: true,
  },
  system: {
    listen: true,
    dispatch: true,
    externalFetch: true,
    readDiagnostics: true,
  },
  none: {},
} as const satisfies Record<RuntimeWorkspaceHttpCapabilityPresetName, RuntimeWorkspaceHttpCapabilities>;

export type RuntimeWorkspaceActorPresetName = RuntimeWorkspaceActorKind;

export const RUNTIME_WORKSPACE_ACTOR_PRESETS = {
  principal: {
    id: 'principal',
    kind: 'principal',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  test: {
    id: 'test',
    kind: 'test',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  'hidden-test': {
    id: 'hidden-test',
    kind: 'hidden-test',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace },
  },
  runtime: {
    id: 'runtime',
    kind: 'runtime',
    capabilities: {
      execute: true,
      http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.workspace,
    },
  },
  system: {
    id: 'system',
    kind: 'system',
    capabilities: { http: RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS.system },
  },
} as const satisfies Record<RuntimeWorkspaceActorPresetName, RuntimeWorkspaceActor>;

export function runtimeWorkspaceHttpCapabilitiesPreset(
  name: RuntimeWorkspaceHttpCapabilityPresetName
): RuntimeWorkspaceHttpCapabilities {
  return { ...RUNTIME_WORKSPACE_HTTP_CAPABILITY_PRESETS[name] };
}

export function runtimeWorkspaceActorPreset(
  name: RuntimeWorkspaceActorPresetName,
  options: {
    id?: string;
    capabilities?: RuntimeWorkspaceCapabilities;
  } = {}
): RuntimeWorkspaceActor {
  const preset = RUNTIME_WORKSPACE_ACTOR_PRESETS[name];
  const capabilities = options.capabilities ?? preset.capabilities;
  return {
    id: options.id ?? preset.id,
    kind: preset.kind,
    ...(capabilities ? { capabilities: cloneRuntimeWorkspaceCapabilities(capabilities) } : {}),
  };
}

function cloneRuntimeWorkspaceCapabilities(capabilities: RuntimeWorkspaceCapabilities): RuntimeWorkspaceCapabilities {
  return {
    ...(capabilities.read ? { read: [...capabilities.read] } : {}),
    ...(capabilities.write ? { write: [...capabilities.write] } : {}),
    ...(capabilities.delete ? { delete: [...capabilities.delete] } : {}),
    ...(capabilities.execute !== undefined ? { execute: capabilities.execute } : {}),
    ...(capabilities.http ? { http: { ...capabilities.http } } : {}),
  };
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

export interface RuntimeTraceKernelSchedulerConfig {
  maxConcurrentCommands?: number;
  maxQueuedCommands?: number;
}

export interface RuntimeTraceKernelConfig {
  version?: string;
  user?: RuntimeKernelUserConfig;
  host?: RuntimeKernelHostConfig;
  workspace?: RuntimeKernelWorkspaceConfig;
  workspaceAlias?: string | false;
  /**
   * Maximum number of processes in the workspace process table, including the
   * kernel's PID 1, persistent host-created processes, queued/running commands,
   * and unreaped zombies. Omit for no explicit process-table limit.
   */
  maxProcesses?: number;
  scheduler?: RuntimeTraceKernelSchedulerConfig;
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

export interface RuntimeProjectStorageSnapshot {
  usedBytes: number;
  capacityBytes: number;
  availableBytes: number;
  usedEntries: number;
  capacityEntries: number;
  availableEntries: number;
}

export interface RuntimeProjectSnapshot {
  files: RuntimeFile[];
  symlinks?: RuntimeSymlink[];
  kernelFiles?: RuntimeFile[];
  kernelDevices?: RuntimeKernelDeviceInfo[];
  directories?: string[];
  directoryMetadata?: RuntimeDirectory[];
  readonlyFiles?: readonly string[];
  hiddenFiles?: readonly string[];
  entrypoint?: string;
  cwd?: string;
  workspaceRoot?: string;
  workspaceAlias?: string;
  kernel?: RuntimeKernelInfo;
  storage?: RuntimeProjectStorageSnapshot;
}

export interface RuntimeProjectPatchBase {
  id?: string;
  version?: string;
  manifestHash: string;
}

export interface RuntimeProjectPatchOptions {
  base?: {
    id?: string;
    version?: string;
  };
}

export interface RuntimeProjectPatchFileWrite {
  kind: 'write';
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
  baseHash: string | null;
}

export interface RuntimeProjectPatchFileDelete {
  kind: 'delete';
  path: string;
  baseHash: string;
}

export interface RuntimeProjectPatchSymlinkWrite {
  kind: 'symlink';
  path: string;
  target: string;
  baseHash: string | null;
}

export interface RuntimeProjectPatchDirectoryCreate {
  kind: 'mkdir';
  path: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

export interface RuntimeProjectPatchDirectoryWrite {
  kind: 'directory';
  path: string;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  baseHash: string;
}

export interface RuntimeProjectPatchDirectoryDelete {
  kind: 'rmdir';
  path: string;
}

export type RuntimeProjectPatchChange =
  | RuntimeProjectPatchFileWrite
  | RuntimeProjectPatchSymlinkWrite
  | RuntimeProjectPatchFileDelete
  | RuntimeProjectPatchDirectoryCreate
  | RuntimeProjectPatchDirectoryWrite
  | RuntimeProjectPatchDirectoryDelete;

export interface RuntimeProjectPatch {
  version: 1;
  base: RuntimeProjectPatchBase;
  changes: RuntimeProjectPatchChange[];
}

export interface RuntimeKernelHttpListenOptions {
  host?: string;
  port: number;
  protocol?: 'http';
}

export interface RuntimeKernelHttpListenerInfo {
  id: string;
  pid: number;
  host: string;
  port: number;
  protocol: 'http';
  startedAt: string;
}

export interface RuntimeKernelHttpRequest {
  method: string;
  url: string;
  path: string;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  signal?: AbortSignal;
}

export interface RuntimeKernelHttpResponse {
  status: number;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  annotation?: unknown;
  error?: RuntimeKernelHttpError;
}

export interface RuntimeKernelHttpBodyPayload {
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
}

export interface RuntimeKernelHttpError {
  code: string;
  message: string;
}

export interface RuntimeKernelHttpBodyInit {
  body: string;
  bodyEncoding?: RuntimeFileEncoding;
}

export interface RuntimeWorkspaceHttpRequestOptions {
  method?: string;
  url: string;
  path?: string;
  headers?: Record<string, string>;
  rawHeaders?: readonly [string, string][];
  body?: string;
  bodyEncoding?: RuntimeFileEncoding;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeKernelHttpDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RuntimeWorkspaceHttpJsonRequestOptions extends Omit<RuntimeWorkspaceHttpRequestOptions, 'body' | 'bodyEncoding'> {
  body?: unknown;
}

export interface RuntimeWorkspaceHttpJsonResponse<T = unknown> extends RuntimeKernelHttpResponse {
  json: T;
  text: string;
}

export interface RuntimeWorkspaceHttpClient {
  request(options: RuntimeWorkspaceHttpRequestOptions): Promise<RuntimeKernelHttpResponse>;
  json<T = unknown>(options: RuntimeWorkspaceHttpJsonRequestOptions): Promise<RuntimeWorkspaceHttpJsonResponse<T>>;
  listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle;
}

export interface RuntimeKernelHttpListenerHandle {
  readonly id: string;
  readonly info: RuntimeKernelHttpListenerInfo;
  /**
   * Resolves once a transported listener has been accepted by the kernel.
   * In-process listeners are registered synchronously and may omit this.
   */
  readonly ready?: Promise<RuntimeKernelHttpListenerInfo>;
  close(): void;
}

export type RuntimeKernelHttpHandler = (request: RuntimeKernelHttpRequest) => Promise<RuntimeKernelHttpResponse> | RuntimeKernelHttpResponse;

export interface RuntimeKernelHttpBridge {
  listen(options: RuntimeKernelHttpListenOptions, handler: RuntimeKernelHttpHandler): RuntimeKernelHttpListenerHandle;
  dispatch(request: RuntimeKernelHttpRequest, options?: RuntimeKernelHttpDispatchOptions): Promise<RuntimeKernelHttpResponse>;
}

/**
 * Product-integration wrapper around one process-bound TraceKernel syscall
 * channel. Runtime workers receive only the shared channel and generation
 * buffer; servicing and lifecycle remain host-owned.
 */
export interface RuntimeKernelSyscallBridge {
  readonly channel: {
    readonly buffer: SharedArrayBuffer;
    readonly byteCapacity: number;
  };
  readonly generationBuffer?: SharedArrayBuffer;
  /**
   * Asynchronous runtime operations use the command MessagePort so blocking
   * kernel work never stalls the language worker's event loop. Requests and
   * results are the plain TraceKernel syscall wire contract.
   */
  dispatch(request: unknown): Promise<unknown>;
  service(): Promise<void>;
  close(): void;
}

export interface RuntimeKernelSignalNotification {
  readonly signal: string;
  readonly code: number;
}

export interface RuntimeKernelSignalMailbox {
  /**
   * Int32 layout: [monotonic sequence, latest signal number].
   * Standard POSIX notifications may coalesce before the runtime's next safe
   * point; they are not an ordered application event log.
   */
  readonly buffer: SharedArrayBuffer;
}

/**
 * Host-owned, non-terminating process notification stream.
 *
 * This is deliberately separate from `AbortSignal`: abort represents
 * cancellation and may retire a runtime worker, while POSIX notifications
 * such as SIGWINCH have a default disposition of ignore and must leave the
 * process and its engine lease alive.
 */
export interface RuntimeKernelSignalBridge {
  readonly mailbox: RuntimeKernelSignalMailbox;
  subscribe(
    listener: (notification: RuntimeKernelSignalNotification) => void
  ): () => void;
}

type RuntimeHttpBufferConstructor = {
  from(value: string, encoding: 'base64'): Uint8Array;
  from(value: Uint8Array): { toString(encoding: 'base64'): string };
};

function runtimeHttpGlobalBuffer(): RuntimeHttpBufferConstructor | undefined {
  return (globalThis as typeof globalThis & { Buffer?: RuntimeHttpBufferConstructor }).Buffer;
}

function runtimeHttpBytesFromBase64(value: string): Uint8Array {
  const buffer = runtimeHttpGlobalBuffer();
  if (buffer) return buffer.from(value, 'base64');

  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function runtimeHttpBase64FromBytes(bytes: Uint8Array): string {
  const buffer = runtimeHttpGlobalBuffer();
  if (buffer) return buffer.from(bytes).toString('base64');

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function runtimeHttpDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function runtimeHttpBodyBytes(message: RuntimeKernelHttpBodyPayload): Uint8Array {
  if (message.body === undefined) return new Uint8Array();
  return message.bodyEncoding === 'base64'
    ? runtimeHttpBytesFromBase64(message.body)
    : new TextEncoder().encode(message.body);
}

export function runtimeHttpBodyText(message: RuntimeKernelHttpBodyPayload): string {
  const bytes = runtimeHttpBodyBytes(message);
  return runtimeHttpDecodeUtf8(bytes) ?? new TextDecoder().decode(bytes);
}

export function runtimeHttpBodyFromBytes(bytes: Uint8Array): RuntimeKernelHttpBodyInit {
  const text = runtimeHttpDecodeUtf8(bytes);
  if (text !== null) return { body: text };
  return { body: runtimeHttpBase64FromBytes(bytes), bodyEncoding: 'base64' };
}

export function runtimeHttpBodyFromText(text: string): RuntimeKernelHttpBodyInit {
  return { body: text };
}

export function runtimeHttpRequestBytes(request: RuntimeKernelHttpRequest): Uint8Array {
  return runtimeHttpBodyBytes(request);
}

export function runtimeHttpRequestText(request: RuntimeKernelHttpRequest): string {
  return runtimeHttpBodyText(request);
}

export function runtimeHttpResponseBytes(response: RuntimeKernelHttpResponse): Uint8Array {
  return runtimeHttpBodyBytes(response);
}

export function runtimeHttpResponseText(response: RuntimeKernelHttpResponse): string {
  return runtimeHttpBodyText(response);
}

export type RuntimeKernelHttpProtocolMessage =
  | {
      type: 'kernel-http-listen';
      listenerId: string;
      options: RuntimeKernelHttpListenOptions;
    }
  | {
      type: 'kernel-http-listen-result';
      listenerId: string;
      info: RuntimeKernelHttpListenerInfo;
    }
  | {
      type: 'kernel-http-close';
      listenerId: string;
    }
  | {
      type: 'kernel-http-request';
      listenerId: string;
      requestId: string;
      request: RuntimeKernelHttpRequest;
    }
  | {
      type: 'kernel-http-abort-request';
      requestId: string;
    }
  | {
      type: 'kernel-http-response';
      requestId: string;
      response: RuntimeKernelHttpResponse;
    }
  | {
      type: 'kernel-http-dispatch';
      requestId: string;
      request: RuntimeKernelHttpRequest;
      timeoutMs?: number;
    }
  | {
      type: 'kernel-http-abort-dispatch';
      requestId: string;
    }
  | {
      type: 'kernel-http-dispatch-result';
      requestId: string;
      response: RuntimeKernelHttpResponse;
    }
  | {
      type: 'kernel-http-error';
      requestId?: string;
      listenerId?: string;
      error: string;
    };

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
  symlinks?: readonly RuntimeSymlink[];
  directories?: readonly string[];
  directoryMetadata?: readonly RuntimeDirectory[];
  skills?: readonly RuntimeFile[];
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

export interface RuntimeCommandExecutionLimits {
  maxCommandCount?: number;
  maxLoopIterations?: number;
  maxCallDepth?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

/**
 * Capabilities of the host terminal attached to a command. This is absent for
 * programmatic executions, so runtimes can distinguish a real terminal
 * session from captured pipes without guessing from presentation metadata.
 */
export interface RuntimeProjectTerminalCapabilities {
  isTTY: true;
  columns: number;
  rows: number;
  term: string;
  colorLevel: 0 | 1 | 2 | 3;
}

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdinPipe?: RuntimeCommandStdinPipe;
  signal?: AbortSignal;
  args?: string[];
  presentation?: 'programmatic' | 'terminal';
  terminal?: RuntimeProjectTerminalCapabilities;
  /** Process file-creation mask. Defaults to 0022 for a fresh shell. */
  umask?: number;
  foreground?: boolean;
  retainOnExit?: boolean;
  includeHiddenFiles?: boolean;
  executionLimits?: RuntimeCommandExecutionLimits;
  onEvent?: RuntimeCommandEventHandler;
  /**
   * Called once after the kernel has allocated and published the process but
   * before its command executor is admitted. Terminal background submission
   * uses this instead of inferring PID creation from synchronous timing.
   */
  onProcessStart?: (pid: number) => void;
  /**
   * Receives the shell variable changes the command produced relative to the
   * environment it started with: assignments/exports map to their final
   * value, `unset` variables map to `undefined`. Terminal sessions use this
   * to persist `export FOO=…` across submissions. Not called for commands
   * that bypass the shell (virtual executables).
   */
  onEnvChanges?: (changes: Record<string, string | undefined>) => void;
  /** Receives a foreground shell's updated file-creation mask. */
  onUmaskChange?: (umask: number) => void;
}

export interface RuntimeCommandCompletionMatch {
  name: string;
  kind: 'file' | 'directory';
}

export interface RuntimeCommandCompletion {
  input: string;
  cursor: number;
  matches: RuntimeCommandCompletionMatch[];
  replacementChanged: boolean;
}

export interface RuntimeCommandCompletionOptions {
  cwd?: string;
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

export function peekRuntimeCommandStdinPipeBytes(
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
  if (firstLength < length) out.set(state.bytes.subarray(0, length - firstLength), firstLength);
  return out;
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
  Atomics.notify(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
  return out;
}

/**
 * Backpressure-aware binary writer used by kernel pipe adapters.
 *
 * Interactive terminal writes intentionally retain their immediate
 * fail-when-full API. A process pipe instead suspends until the runtime has
 * consumed space so a slow child cannot cause snapshotting or dropped bytes.
 */
export async function writeRuntimeCommandStdinPipeBytes(
  pipe: RuntimeCommandStdinPipe,
  data: Uint8Array
): Promise<void> {
  const state = runtimeCommandStdinPipeState(pipe);
  let offset = 0;
  while (offset < data.byteLength) {
    if (Atomics.load(state.header, RUNTIME_STDIN_PIPE_CLOSED_INDEX) !== 0) {
      throw Object.assign(
        new Error('EPIPE: cannot write to closed live stdin pipe'),
        { code: 'EPIPE' }
      );
    }
    const readIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_READ_INDEX);
    const writeIndex = Atomics.load(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
    const capacity = state.bytes.byteLength;
    const available = readIndex <= writeIndex
      ? capacity - (writeIndex - readIndex) - 1
      : readIndex - writeIndex - 1;
    if (available === 0) {
      const waitAsync = (
        Atomics as typeof Atomics & {
          waitAsync?: (
            array: Int32Array,
            index: number,
            value: number
          ) => { readonly value: Promise<unknown> | string };
        }
      ).waitAsync;
      if (waitAsync) {
        const waiting = waitAsync(state.header, RUNTIME_STDIN_PIPE_READ_INDEX, readIndex).value;
        if (typeof waiting !== 'string') await waiting;
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      continue;
    }
    const length = Math.min(available, data.byteLength - offset);
    let nextWriteIndex = writeIndex;
    for (let index = 0; index < length; index += 1) {
      state.bytes[nextWriteIndex] = data[offset + index]!;
      nextWriteIndex = (nextWriteIndex + 1) % capacity;
    }
    offset += length;
    Atomics.store(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX, nextWriteIndex);
    Atomics.notify(state.header, RUNTIME_STDIN_PIPE_WRITE_INDEX);
  }
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: RuntimeFileChange[];
  error?: RuntimeCommandError;
  /** A runtime caught this signal and completed its own shutdown path. */
  handledSignal?: string;
}

const RUNTIME_SIGNAL_EXIT_CODES = new Map<string, number>([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGQUIT', 3],
  ['SIGKILL', 9],
  ['SIGTERM', 15],
]);

export function runtimeAbortSignalName(signal: AbortSignal | undefined, fallback = 'SIGTERM'): string {
  const reason = signal?.reason as { signal?: unknown } | undefined;
  const raw = typeof reason?.signal === 'string' && reason.signal.trim()
    ? reason.signal.trim()
    : fallback;
  const normalized = raw.toUpperCase().startsWith('SIG') ? raw.toUpperCase() : `SIG${raw.toUpperCase()}`;
  return RUNTIME_SIGNAL_EXIT_CODES.has(normalized) ? normalized : fallback;
}

export function runtimeSignalExitCode(signalName: string): number {
  const normalized = signalName.toUpperCase().startsWith('SIG') ? signalName.toUpperCase() : `SIG${signalName.toUpperCase()}`;
  return 128 + (RUNTIME_SIGNAL_EXIT_CODES.get(normalized) ?? RUNTIME_SIGNAL_EXIT_CODES.get('SIGTERM')!);
}

export interface RuntimeCommandError {
  code: string;
  message: string;
  errno?: number;
  syscall?: string;
  path?: string;
  detail?: Record<string, unknown>;
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

export type KernelJournalRecord = { seq: number; ts?: string } & (
  | {
      kind: 'fs';
      op: 'write' | 'delete' | 'mkdir' | 'rmdir' | 'rename' | 'copy';
      path: string;
      actor: string;
      pid?: number;
      phase?: string;
    }
  | {
      kind: 'process';
      op: 'exec' | 'exit';
      pid: number;
      ppid?: number;
      argv?: string;
      cwd?: string;
      exitCode?: number;
      actor?: string;
    }
  | {
      kind: 'http';
      op: 'request';
      method: string;
      host: string;
      path: string;
      status?: number;
      via: 'listener' | 'external' | 'loopback';
      actor?: string;
      pid?: number;
      authPresent: boolean;
      authFingerprint?: string;
      annotation?: unknown;
      error?: string;
      meta?: {
        idempotencyKeyFingerprint?: string;
        requestBodyFingerprint?: string;
        responseBodyFingerprint?: string;
        contentType?: string;
        retryAfter?: string;
        rateLimit?: {
          limit?: string;
          remaining?: string;
          reset?: string;
        };
      };
    }
);

export interface RuntimeKernelJournalEvent {
  type: 'kernel-journal';
  record: KernelJournalRecord;
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
  | RuntimeKernelJournalEvent
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

function normalizeRuntimeFileChangePath(path: unknown): string {
  if (typeof path !== 'string') {
    throw Object.assign(new Error('EINVAL: TraceKernel file-change path must be a string'), { code: 'EINVAL' });
  }
  if (path.includes('\0')) {
    throw Object.assign(new Error('EINVAL: TraceKernel file-change path must not contain NUL bytes'), { code: 'EINVAL' });
  }
  const normalized = path.replace(/\\/g, '/');
  if (normalized.trim().length === 0) {
    throw Object.assign(new Error('EINVAL: TraceKernel file-change path must not be empty'), { code: 'EINVAL' });
  }
  if (normalized.startsWith('/')) {
    throw Object.assign(new Error(`EACCES: TraceKernel file-change path must be relative: ${path}`), { code: 'EACCES' });
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw Object.assign(new Error(`EACCES: TraceKernel file-change path must not include a drive prefix: ${path}`), { code: 'EACCES' });
  }

  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw Object.assign(new Error(`EACCES: TraceKernel file-change path must not escape the workspace: ${path}`), { code: 'EACCES' });
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change path must point to an entry: ${path}`), { code: 'EINVAL' });
  }
  return parts.join('/');
}

export function normalizeRuntimeFileChange(change: RuntimeFileChange): RuntimeFileChange {
  if (!change || typeof change !== 'object') {
    throw Object.assign(new Error('EINVAL: TraceKernel file-change must be an object'), { code: 'EINVAL' });
  }
  const path = normalizeRuntimeFileChangePath((change as { path?: unknown }).path);
  const directory = (change as { directory?: unknown }).directory;
  const symlink = (change as { symlink?: unknown }).symlink;
  const target = (change as { target?: unknown }).target;
  const deleted = (change as { deleted?: unknown }).deleted;
  const contents = (change as { contents?: unknown }).contents;
  const encoding = (change as { encoding?: unknown }).encoding;
  const mode = (change as { mode?: unknown }).mode;
  const atimeMs = (change as { atimeMs?: unknown }).atimeMs;
  const mtimeMs = (change as { mtimeMs?: unknown }).mtimeMs;
  const metadata = {
    ...(mode !== undefined ? { mode: normalizeRuntimeFileMode(mode, path) } : {}),
    ...(atimeMs !== undefined ? { atimeMs: normalizeRuntimeFileTimestamp(atimeMs, path, 'atimeMs') } : {}),
    ...(mtimeMs !== undefined ? { mtimeMs: normalizeRuntimeFileTimestamp(mtimeMs, path, 'mtimeMs') } : {}),
  };
  if (directory !== undefined && directory !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change directory flag must be true: ${path}`), { code: 'EINVAL' });
  }
  if (symlink !== undefined && symlink !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change symlink flag must be true: ${path}`), { code: 'EINVAL' });
  }
  if (deleted !== undefined && deleted !== true) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change deleted flag must be true: ${path}`), { code: 'EINVAL' });
  }
  if (encoding !== undefined && encoding !== 'base64') {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change encoding is unsupported: ${path}`), { code: 'EINVAL' });
  }
  if (symlink === true) {
    if (directory !== undefined || deleted !== undefined || contents !== undefined || encoding !== undefined) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change must only include a target: ${path}`), { code: 'EINVAL' });
    }
    if (Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change metadata is unsupported: ${path}`), { code: 'EINVAL' });
    }
    if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
      throw Object.assign(new Error(`EINVAL: TraceKernel symlink file-change target is invalid: ${path}`), { code: 'EINVAL' });
    }
    return { path, symlink: true, target };
  }
  if (target !== undefined) {
    throw Object.assign(new Error(`EINVAL: TraceKernel non-symlink file-change must not include a target: ${path}`), { code: 'EINVAL' });
  }
  if (directory === true) {
    if (contents !== undefined || encoding !== undefined) {
      throw Object.assign(new Error(`EINVAL: TraceKernel directory file-change must not include contents: ${path}`), { code: 'EINVAL' });
    }
    if (deleted === true && Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel deleted directory file-change must not include metadata: ${path}`), { code: 'EINVAL' });
    }
    return { path, directory: true, ...metadata, ...(deleted === true ? { deleted: true } : {}) };
  }
  if (deleted === true) {
    if (contents !== undefined || encoding !== undefined) {
      throw Object.assign(new Error(`EINVAL: TraceKernel delete file-change must not include contents: ${path}`), { code: 'EINVAL' });
    }
    if (Object.keys(metadata).length > 0) {
      throw Object.assign(new Error(`EINVAL: TraceKernel delete file-change metadata is unsupported: ${path}`), { code: 'EINVAL' });
    }
    return { path, deleted: true };
  }
  if (typeof contents !== 'string') {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change contents must be a string: ${path}`), { code: 'EINVAL' });
  }
  return { path, contents, ...(encoding === 'base64' ? { encoding } : {}), ...metadata };
}

function normalizeRuntimeFileMode(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o7777) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change mode is invalid: ${path}`), { code: 'EINVAL' });
  }
  return value as number;
}

function normalizeRuntimeFileTimestamp(value: unknown, path: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`EINVAL: TraceKernel file-change ${field} is invalid: ${path}`), { code: 'EINVAL' });
  }
  return value;
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

export const RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES = 1024 * 1024;
export const RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES = 1024;
export const RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES = 4 * 1024 * 1024;
const RUNTIME_PROJECT_MAX_FINAL_DIFF_CHANGES = 4096;
const RUNTIME_PROJECT_MAX_FINAL_DIFF_FILE_BYTES = 16 * 1024 * 1024;
const RUNTIME_PROJECT_MAX_FINAL_DIFF_BYTES = 32 * 1024 * 1024;
const runtimeProjectTextEncoder = new TextEncoder();

export function runtimeProjectUtf8Bytes(value: string): number {
  return runtimeProjectTextEncoder.encode(value).byteLength;
}

export function runtimeProjectTruncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const nextBytes = runtimeProjectUtf8Bytes(char);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

function runtimeFileChangeByteSize(change: RuntimeFileChange): number {
  let size = runtimeProjectUtf8Bytes(change.path);
  if ((change as RuntimeSymlink).symlink === true) {
    return size + runtimeProjectUtf8Bytes((change as RuntimeSymlink).target);
  }
  const file = change as RuntimeFile;
  if (file.contents !== undefined) {
    size += file.encoding === 'base64'
      ? Math.ceil(file.contents.length * 3 / 4)
      : runtimeProjectUtf8Bytes(file.contents);
  }
  return size;
}

export function assertRuntimeFinalDiffBudget(changes: readonly RuntimeFileChange[] | undefined): void {
  if (!changes?.length) return;
  if (changes.length > RUNTIME_PROJECT_MAX_FINAL_DIFF_CHANGES) {
    throw Object.assign(new Error('EMSGSIZE: TraceKernel final-diff file-change count limit exceeded'), { code: 'EMSGSIZE' });
  }

  let totalBytes = 0;
  for (const change of changes) {
    const size = runtimeFileChangeByteSize(change);
    if (size > RUNTIME_PROJECT_MAX_FINAL_DIFF_FILE_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel final-diff file-change size limit exceeded'), { code: 'EMSGSIZE' });
    }
    totalBytes += size;
    if (totalBytes > RUNTIME_PROJECT_MAX_FINAL_DIFF_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel final-diff byte limit exceeded'), { code: 'EMSGSIZE' });
    }
  }
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRuntimeTimeoutError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

export function runtimeProjectInfrastructureFailure(
  error: unknown,
  signal: AbortSignal | undefined
): RuntimeCommandResult {
  const diagnostic = runtimeErrorMessage(error);
  const aborted = isRuntimeAbortError(error) || signal?.aborted;
  if (aborted) {
    const signalName = runtimeAbortSignalName(signal);
    const signalCode = RUNTIME_SIGNAL_EXIT_CODES.get(signalName) ?? RUNTIME_SIGNAL_EXIT_CODES.get('SIGTERM')!;
    return {
      stdout: '',
      stderr: '',
      exitCode: 128 + signalCode,
      error: {
        code: 'EINTR',
        errno: 4,
        syscall: 'wait4',
        message: 'Process interrupted by signal',
        detail: {
          signal: signalName,
          signalCode,
          diagnostic,
        },
      },
    };
  }
  if (isRuntimeTimeoutError(error)) {
    return {
      stdout: '',
      stderr: '',
      exitCode: 124,
      error: {
        code: 'ETIMEDOUT',
        errno: 110,
        message: 'Process timed out',
        detail: { diagnostic },
      },
    };
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: runtimeSignalExitCode('SIGKILL'),
    error: {
      code: 'EIO',
      errno: 5,
      message: 'Runtime process terminated unexpectedly',
      detail: {
        signal: 'SIGKILL',
        signalCode: RUNTIME_SIGNAL_EXIT_CODES.get('SIGKILL')!,
        diagnostic,
      },
    },
  };
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

  /**
   * Return a complete final transcript when a command also emitted live output events.
   *
   * Nested commands can be interrupted after streaming output but before their parent has copied
   * that output into its returned result. In that case the returned value is a shorter prefix of
   * the transcript already shown in the terminal. Treating it as new output replays that prefix.
   */
  completeFinalOutput(
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>
  ): Pick<RuntimeCommandResult, 'stdout' | 'stderr'> {
    return {
      stdout: this.completeStreamOutput(result.stdout, this.stdoutStreamed),
      stderr: this.completeStreamOutput(result.stderr, this.stderrStreamed),
    };
  }

  private completeStreamOutput(finalOutput: string, streamedOutput: string): string {
    if (!streamedOutput) return finalOutput;
    if (!finalOutput) return streamedOutput;
    if (finalOutput.includes(streamedOutput)) return finalOutput;
    if (streamedOutput.includes(finalOutput)) return streamedOutput;

    // Some adapters return only the unstreamed tail. Preserve the live transcript and append only
    // the portion that does not overlap its suffix.
    const maximumOverlap = Math.min(streamedOutput.length, finalOutput.length);
    for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
      if (streamedOutput.endsWith(finalOutput.slice(0, overlap))) {
        return `${streamedOutput}${finalOutput.slice(overlap)}`;
      }
    }
    return `${streamedOutput}${finalOutput}`;
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
  signal?: AbortSignal;
  applyFileChange(
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ): Promise<boolean | void>;
  emit(event: RuntimeCommandEvent): void;
}

async function awaitRuntimeAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (!signal) return { aborted: false, value: await promise };
  if (signal.aborted) return { aborted: true };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export class RuntimeProjectEventQueue {
  private queue: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | null = null;

  enqueue(event: RuntimeCommandEvent, options: RuntimeProjectEventQueueOptions): void {
    const execution = this.queue.then(async () => {
      if (this.failure) return;
      if (options.signal?.aborted) return;
      if (event.type !== 'file-change') {
        options.emit(event);
        return;
      }

      const change = normalizeRuntimeFileChange(event.change);
      const phase = event.phase ?? 'live';
      if (options.signal?.aborted) return;
      const applied = await awaitRuntimeAbortable(
        options.applyFileChange(change, phase, { signal: options.signal }),
        options.signal
      );
      if (!('value' in applied)) return;
      const shouldEmit = applied.value;
      if (options.signal?.aborted) return;
      if (shouldEmit === false) return;
      options.emit({
        ...event,
        change,
        phase,
        actor: event.actor ?? options.actor,
      });
    });
    // Own the rejection as soon as the work is created. A live runtime can
    // continue emitting events before its caller reaches flush(), and leaving
    // the rejection unattached until then makes Node report a false
    // unhandled-rejection failure. Preserve the first failure for flush while
    // keeping the serial queue usable for already-enqueued cleanup work.
    this.queue = execution.catch((error) => {
      this.failure ??= { error };
    });
  }

  async flush(): Promise<void> {
    const pending = this.queue;
    await pending;
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure.error;
  }
}

export interface RuntimeProjectFileChangeApplyOptions {
  signal?: AbortSignal;
}

export interface RuntimeProjectLiveIoControllerOptions {
  actor?: RuntimeWorkspaceActor;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
  onEvent?: RuntimeCommandEventHandler;
  signal?: AbortSignal;
}

export class RuntimeProjectLiveIoController {
  private readonly outputTracker = new RuntimeProjectOutputTracker();
  private readonly eventQueue: RuntimeProjectEventQueue | null;
  private readonly abortController = new AbortController();
  private readonly abortInputSignal?: AbortSignal;
  private readonly abortInputListener?: () => void;
  private readonly appliedFileChanges = new Map<string, string>();
  private readonly outputBytes: Record<RuntimeCommandEventStream, number> = { stdout: 0, stderr: 0 };
  private readonly truncatedOutputStreams = new Set<RuntimeCommandEventStream>();
  private liveFileChangeCount = 0;
  private liveFileChangeBytes = 0;
  private pendingFileChanges = 0;
  private closed = false;

  constructor(private readonly options: RuntimeProjectLiveIoControllerOptions) {
    this.eventQueue = options.applyFileChange ? new RuntimeProjectEventQueue() : null;
    this.abortInputSignal = options.signal;
    if (options.signal?.aborted) {
      this.abortController.abort();
    } else if (options.signal) {
      this.abortInputListener = () => this.abortController.abort();
      options.signal.addEventListener('abort', this.abortInputListener, { once: true });
    }
  }

  emit(event: RuntimeCommandEvent): void {
    const budgetedEvent = this.applyEventBudgets(event);
    if (!budgetedEvent) return;
    this.outputTracker.observe(budgetedEvent);
    this.options.onEvent?.(budgetedEvent);
  }

  handleRuntimeEvent(event: RuntimeCommandEvent): void {
    if (this.closed || this.abortController.signal.aborted) return;
    if (event.type === 'file-change') {
      event = { ...event, change: normalizeRuntimeFileChange(event.change) };
    }
    if (event.type === 'file-change' && !this.eventQueue) this.recordLiveFileChangeBudget(event.change);
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
      signal: this.abortController.signal,
      applyFileChange: async (change, phase, applyOptions) => {
        try {
          if (this.abortController.signal.aborted) return false;
          if (phase === 'live') this.recordLiveFileChangeBudget(change);
          if (this.abortController.signal.aborted) return false;
          const shouldEmit = await this.options.applyFileChange?.(change, phase, applyOptions);
          if (this.abortController.signal.aborted) return false;
          this.appliedFileChanges.set(runtimeFileChangePath(change), JSON.stringify(change));
          return shouldEmit;
        } finally {
          this.pendingFileChanges = Math.max(0, this.pendingFileChanges - 1);
        }
      },
      emit: (nextEvent) => this.emit(nextEvent),
    });
  }

  close(): void {
    this.closed = true;
    if (this.abortInputSignal && this.abortInputListener) {
      this.abortInputSignal.removeEventListener('abort', this.abortInputListener);
    }
  }

  private applyEventBudgets(event: RuntimeCommandEvent): RuntimeCommandEvent | null {
    if (event.type !== 'output') return event;
    if (this.truncatedOutputStreams.has(event.stream)) return null;
    const used = this.outputBytes[event.stream];
    const remaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = runtimeProjectUtf8Bytes(event.data);
    if (bytes <= remaining) {
      this.outputBytes[event.stream] = used + bytes;
      return event;
    }
    this.truncatedOutputStreams.add(event.stream);
    const marker = `\n[${event.stream} output truncated after ${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
    const truncated = `${runtimeProjectTruncateUtf8(event.data, Math.max(0, remaining))}${marker}`;
    this.outputBytes[event.stream] = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES + runtimeProjectUtf8Bytes(marker);
    return truncated ? { ...event, data: truncated } : null;
  }

  private recordLiveFileChangeBudget(change: RuntimeFileChange): void {
    this.liveFileChangeCount += 1;
    if (this.liveFileChangeCount > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change count limit exceeded'), { code: 'EMSGSIZE' });
    }
    const size = runtimeFileChangeByteSize(change);
    if (size > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change size limit exceeded'), { code: 'EMSGSIZE' });
    }
    this.liveFileChangeBytes += size;
    if (this.liveFileChangeBytes > RUNTIME_PROJECT_MAX_LIVE_FILE_CHANGE_BYTES) {
      throw Object.assign(new Error('EMSGSIZE: TraceKernel live file-change byte limit exceeded'), { code: 'EMSGSIZE' });
    }
  }

  async flush(): Promise<void> {
    await this.eventQueue?.flush();
  }

  filterAppliedResultFiles<Result extends RuntimeCommandResult>(result: Result): Result {
    if (this.appliedFileChanges.size === 0) return result;
    const appliedFileChanges = new Map(this.appliedFileChanges);
    this.appliedFileChanges.clear();
    return filterRuntimeCommandResultFiles(result, (change) => {
      const normalized = normalizeRuntimeFileChange(change);
      return appliedFileChanges.get(runtimeFileChangePath(normalized)) === JSON.stringify(normalized);
    }) as Result;
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
  assertRuntimeFinalDiffBudget(result.files);
  for (const file of result.files ?? []) {
    await applyFileChange(normalizeRuntimeFileChange(file), 'final-diff');
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
    request: Omit<Request, 'onEvent' | 'engineLease'>,
    onEvent: RuntimeCommandEventHandler,
    engineLease: RuntimeProjectEngineLeaseController | undefined
  ): Promise<Result>;
}

export async function runRuntimeProjectWorkerBridge<
  Request extends RuntimeProjectCommandRequest<string>,
  Result extends RuntimeCommandResult = RuntimeCommandResult
>(options: RuntimeProjectWorkerBridgeOptions<Request, Result>): Promise<Result> {
  const liveIo = new RuntimeProjectLiveIoController({
    applyFileChange: options.applyFileChange,
    onEvent: options.request.onEvent,
    signal: options.request.signal,
  });
  const io = createRuntimeProjectIoBridge((event) => liveIo.emit(event));
  const forwardWorkerEvent = (event: RuntimeCommandEvent): void => {
    liveIo.handleRuntimeEvent(event);
  };
  io.status(options.startPhase, options.startMessage, options.startDetail);
  const {
    onEvent: _onEvent,
    engineLease: _engineLease,
    ...workerRequest
  } = options.request;
  let result: Result;
  try {
    result = await options.run(workerRequest, forwardWorkerEvent, options.request.engineLease);
    liveIo.close();
    await liveIo.flush();
  } catch (error) {
    liveIo.close();
    const failedResult = runtimeProjectInfrastructureFailure(error, options.request.signal) as Result;
    liveIo.emitMissingFinalOutput(failedResult, (stream, data) => io.output(stream, data));
    io.status(options.finishPhase, options.finishMessage, {
      exitCode: failedResult.exitCode,
      error: failedResult.error?.message,
      ...(failedResult.error?.detail ?? {}),
    });
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

export type RuntimeWorkspaceMutationHandler = (revision: number) => void;

export interface RuntimeWorkspaceKernel {
  readonly info: RuntimeKernelInfo;
  readonly mutationVersion: number;
  createProcess(options: RuntimeWorkspaceProcessOptions): RuntimeWorkspaceProcess;
  readFile(path: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<string>;
  writeFile(path: string, contents: string, actor?: RuntimeWorkspaceActor, encoding?: RuntimeFileEncoding): Promise<void>;
  writeSkillFiles(files: readonly RuntimeFile[], actor?: RuntimeWorkspaceActor): Promise<void>;
  deleteFile(path: string, actor?: RuntimeWorkspaceActor): Promise<void>;
  applyFileChange(change: RuntimeFileChange, actor?: RuntimeWorkspaceActor, phase?: RuntimeFileMutationPhase): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  watchMutations(listener: RuntimeWorkspaceMutationHandler): RuntimeWorkspaceUnsubscribe;
}

export type RuntimeWorkspaceProcessSignalPolicy = 'standard' | 'system-only';

export interface RuntimeWorkspaceProcessOptions {
  /** Process name shown by ps and /proc. The kernel does not interpret this value. */
  name: string;
  actor: RuntimeWorkspaceActor;
  cwd?: string;
  env?: Record<string, string>;
  /** `system-only` processes cannot be signaled from workspace commands. */
  signalPolicy?: RuntimeWorkspaceProcessSignalPolicy;
}

/**
 * A persistent, kernel-owned process context for a host application surface.
 * Operations performed through the handle are journaled with this process's
 * actor and PID, and commands are created as its children.
 */
export interface RuntimeWorkspaceProcess {
  readonly pid: number;
  readonly name: string;
  readonly actor: RuntimeWorkspaceActor;
  readonly signalPolicy: RuntimeWorkspaceProcessSignalPolicy;
  readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string>;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  deleteFile(path: string): Promise<void>;
  applyFileChange(change: RuntimeFileChange, phase?: RuntimeFileMutationPhase): Promise<void>;
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  runProjectCommand(name: string, options?: RuntimeProjectCommandOptions): Promise<RuntimeCommandResult>;
  createTerminalSession(options?: RuntimeProjectTerminalSessionOptions): RuntimeProjectTerminalSession;
  /** System/control-plane teardown. This is not reachable through workspace signals. */
  dispose(): void;
}

export interface RuntimeWorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
  ino?: number;
  mode?: number;
  size?: number;
  mtimeMs?: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
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
  | 'stdin-eof'
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

export interface RuntimeProjectTerminalControlEvent {
  type: 'control';
  action: 'clear' | 'exit';
  exitCode?: number;
}

export type RuntimeProjectTerminalEvent =
  | RuntimeProjectTerminalInputStateEvent
  | RuntimeProjectTerminalControlEvent;

export type RuntimeProjectTerminalEventHandler = (event: RuntimeProjectTerminalEvent) => void;

export interface RuntimeProjectTerminalSession {
  readonly cwd: string;
  readonly prompt: RuntimeProjectTerminalPrompt;
  readonly inputState: RuntimeProjectTerminalInputState;
  readonly terminal: RuntimeProjectTerminalCapabilities;
  readonly history: readonly string[];
  readonly closed: boolean;
  /**
   * Interrupt the active foreground command as if the user pressed Ctrl+C.
   * Returns false when the terminal has no interruptible foreground command.
   */
  interrupt(): boolean;
  /** Close the active process stdin as if the user pressed Ctrl+D. */
  endStdin(): boolean;
  writeStdin(data: string): boolean;
  /** Resize the attached terminal for subsequent commands. */
  resize(columns: number, rows: number): void;
  run(command: string, options?: RuntimeProjectTerminalRunOptions): Promise<RuntimeCommandResult>;
}

export interface RuntimeProjectTerminalSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
  columns?: number;
  rows?: number;
  term?: string;
  umask?: number;
  onTerminalEvent?: RuntimeProjectTerminalEventHandler;
}

export interface RuntimeProjectTerminalRunOptions extends RuntimeCommandOptions {
  onTerminalEvent?: RuntimeProjectTerminalEventHandler;
}

export interface RuntimeProjectHiddenCommandAccess {
  readonly __runtimeProjectHiddenCommandAccessBrand?: never;
}

const RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY = Symbol.for(
  '@tracecode/harness-core/runtimeProjectHiddenCommandAccesses'
);

const runtimeProjectHiddenCommandAccesses = (() => {
  const globalRegistry = globalThis as typeof globalThis & Record<symbol, WeakSet<RuntimeProjectHiddenCommandAccess> | undefined>;
  globalRegistry[RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY] ??= new WeakSet<RuntimeProjectHiddenCommandAccess>();
  return globalRegistry[RUNTIME_PROJECT_HIDDEN_COMMAND_ACCESS_REGISTRY];
})();

export function createRuntimeProjectHiddenCommandAccess(): RuntimeProjectHiddenCommandAccess {
  const access = {};
  runtimeProjectHiddenCommandAccesses.add(access);
  return access;
}

export function isRuntimeProjectHiddenCommandAccess(value: unknown): value is RuntimeProjectHiddenCommandAccess {
  return typeof value === 'object' && value !== null &&
    runtimeProjectHiddenCommandAccesses.has(value as RuntimeProjectHiddenCommandAccess);
}

export interface RuntimeProjectCommandOptions extends RuntimeCommandOptions {
  hiddenCommandAccess?: RuntimeProjectHiddenCommandAccess;
  /** @deprecated Hidden project commands require a workspace-specific hiddenCommandAccess token. */
  allowHidden?: boolean;
}

export type RuntimeProjectCommandSource = 'argument' | 'file' | 'stdin';

export interface RuntimeProjectProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  /** Kernel descriptor identities inherited or installed before the runtime lease starts. */
  descriptors?: readonly number[];
}

export type RuntimeProjectEngineLeaseReleaseDisposition =
  | {
      readonly kind: 'reuse';
      readonly reason: 'revalidated';
    }
  | {
      readonly kind: 'destroy';
      readonly reason:
        | 'unvalidated'
        | 'execution-failure'
        | 'signaled'
        | 'interrupted'
        | 'revalidation-failure';
      readonly message?: string;
    };

/**
 * Host-only mutable engine resource attached to one kernel process.
 *
 * This object is stripped before a worker request is posted. TraceKernel calls
 * `revalidate` before a possible reuse disposition and calls `release`
 * exactly once after process execution.
 */
export interface RuntimeProjectEngineLeaseAttachment {
  revalidate?(): Promise<void> | void;
  release(
    disposition: RuntimeProjectEngineLeaseReleaseDisposition
  ): Promise<void> | void;
}

export interface RuntimeProjectEngineLeaseController {
  attach(attachment: RuntimeProjectEngineLeaseAttachment): void;
}

export interface RuntimeProjectCommandRequest<
  Source extends string = RuntimeProjectCommandSource
> {
  code: string;
  source: Source;
  scriptPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  process?: RuntimeProjectProcessInfo;
  /** Host-only actual worker/interpreter lease; never crosses the worker boundary. */
  engineLease?: RuntimeProjectEngineLeaseController;
  terminal?: RuntimeProjectTerminalCapabilities;
  stdinPipe?: RuntimeCommandStdinSharedBuffer;
  project: RuntimeProjectSnapshot;
  kernelHttp?: RuntimeKernelHttpBridge;
  kernelSyscalls?: RuntimeKernelSyscallBridge;
  /** Host-only live process notifications; never cloned into a worker request. */
  kernelSignals?: RuntimeKernelSignalBridge;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: RuntimeCommandEventHandler;
}

export interface RuntimeProjectCommandRunnerCapabilities {
  /**
   * The concrete runner can consume fd 0/1/2 through the supplied kernel
   * syscall bridge. Runners without this capability retain the compatibility
   * stdin transport and returned-output path.
   */
  readonly descriptorStdio?: boolean;
}

export type RuntimeProjectCommandRunner<
  Request extends RuntimeProjectCommandRequest<string> = RuntimeProjectCommandRequest
> = ((request: Request) => Promise<RuntimeCommandResult>) & {
  readonly capabilities?: RuntimeProjectCommandRunnerCapabilities;
};

export function withRuntimeProjectCommandRunnerCapabilities<
  Runner extends ((request: never) => Promise<RuntimeCommandResult>) & {
    readonly capabilities?: RuntimeProjectCommandRunnerCapabilities;
  },
>(
  runner: Runner,
  capabilities: RuntimeProjectCommandRunnerCapabilities
): Runner {
  return Object.assign(runner, {
    capabilities: Object.freeze({
      ...runner.capabilities,
      ...capabilities,
    }),
  });
}

export interface RuntimeWorkspace {
  readonly kernel: RuntimeWorkspaceKernel;
  readonly cwd: string;
  readonly http: RuntimeWorkspaceHttpClient;
  readonly projectSession?: RuntimeProjectSessionInfo;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  writeFiles(files: readonly RuntimeFile[]): Promise<void>;
  writeSkillFiles(files: readonly RuntimeFile[]): Promise<void>;
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
  runProjectCommand(name: string, options?: RuntimeProjectCommandOptions): Promise<RuntimeCommandResult>;
  completeCommand(input: string, cursor: number, options?: RuntimeCommandCompletionOptions): Promise<RuntimeCommandCompletion | null>;
  createTerminalSession(options?: RuntimeProjectTerminalSessionOptions): RuntimeProjectTerminalSession;
  checkExpiration(now?: Date | string | number): Promise<RuntimeProjectSessionLifecycle | null>;
  destroy(options?: { reason?: string; clearStorage?: boolean }): Promise<void>;
  snapshot(options?: { entrypoint?: string; includeHidden?: boolean }): Promise<RuntimeProjectSnapshot>;
  journal(sinceSeq?: number): readonly KernelJournalRecord[];
  exportPatch(base: RuntimeProjectSnapshot, options?: RuntimeProjectPatchOptions): Promise<RuntimeProjectPatch>;
  importPatch(base: RuntimeProjectSnapshot, patch: RuntimeProjectPatch, options?: RuntimeProjectPatchOptions): Promise<void>;
  watch(listener: RuntimeWorkspaceEventHandler): RuntimeWorkspaceUnsubscribe;
  dispose(): void;
}
