import type {
  RuntimeCommandEventHandler,
  RuntimeCommandResult,
  RuntimeFile,
  RuntimeFileChange,
  RuntimeFileMutationPhase,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectEngineLeaseController,
  RuntimeProjectFileChangeApplyOptions,
  RuntimeProjectProcessInfo,
} from '@tracecode/harness-core';
import {
  runRuntimeProjectWorkerBridge,
  runtimeAbortSignalName,
  runtimeSignalExitCode,
  withRuntimeProjectCommandRunnerCapabilities,
} from '@tracecode/harness-core';
import type {
  TraceJVMBinaryFile,
  TraceJVMCompileRequest,
  TraceJVMCompileResult,
  TraceJVMExecuteResult,
  TraceJVMRunRequest,
} from '@tracecode/tracejvm';

type JavaProjectRequest = RuntimeProjectCommandRequest<'compile' | 'run'>;

export interface TraceJVMProjectClient {
  initialize?(signal?: AbortSignal): Promise<{ initializeMs: number }>;
  compile(request: TraceJVMCompileRequest): Promise<TraceJVMCompileResult>;
  run(request: TraceJVMRunRequest): Promise<TraceJVMExecuteResult>;
  /**
   * TraceJVM currently requires a hard Worker boundary for complete disposal.
   * A client handed to this adapter is always terminated after one invocation.
   */
  terminate(): void;
}

export interface TraceJVMProjectHostRequest<Payload = unknown> {
  readonly service: string;
  readonly operation: string;
  readonly payload?: Payload;
}

export interface TraceJVMProjectHost {
  dispatch(request: TraceJVMProjectHostRequest): Promise<unknown> | unknown;
}

export interface TraceJVMProjectClientContext {
  /** Absolute kernel working directory for this process invocation. */
  readonly cwd: string;
  /**
   * Process identity owning every descriptor and syscall issued by this
   * invocation.
   */
  readonly process?: RuntimeProjectProcessInfo;
  /**
   * Present when this command is attached to TraceKernel's process-bound
   * syscall dispatcher. This is structurally compatible with TraceJVM's
   * generic Worker host and does not expose TraceKernel transport internals.
   */
  readonly host?: TraceJVMProjectHost;
  /** Kernel owns fd 0, 1, and 2 for this invocation. */
  readonly hostStandardDescriptors: boolean;
}

export type TraceJVMProjectClientFactory =
  (
    context: TraceJVMProjectClientContext
  ) => TraceJVMProjectClient | Promise<TraceJVMProjectClient>;

export const TRACEJVM_PROJECT_CAPABILITIES = Object.freeze({
  provider: 'tracejvm',
  javaVersion: '23',
  filesystem: 'live-kernel-syscalls',
  descriptorStdio: true,
  terminalStdin: true,
  sockets: 'tracekernel-local-tcp',
  workerIsolation: 'per-invocation',
} as const);

export interface TraceJVMProjectExecutionReport {
  readonly pid?: number;
  readonly source: JavaProjectRequest['source'];
  readonly result: TraceJVMExecuteResult;
}

export interface TraceJVMProjectRunnerOptions {
  /**
   * Must return a fresh, unleased TraceJVM Worker client. The adapter never
   * admits one client to two javac/java invocations.
   */
  createClient: TraceJVMProjectClientFactory;
  timeoutMs?: number;
  applyFileChange?: (
    change: RuntimeFileChange,
    phase: RuntimeFileMutationPhase,
    options?: RuntimeProjectFileChangeApplyOptions
  ) => Promise<boolean | void>;
  onExecutionReport?: (report: TraceJVMProjectExecutionReport) => void;
}

interface ParsedCompileInvocation {
  sources: string[];
  classpath?: string;
  outputDirectory?: string;
}

interface KernelProcessCoordinator {
  released: boolean;
  activeClient?: TraceJVMProjectClient;
  tail: Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function commandError(message: string, exitCode = 2): RuntimeCommandResult {
  return {
    stdout: '',
    stderr: message.endsWith('\n') ? message : `${message}\n`,
    exitCode,
  };
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/gu, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`Path escapes the project workspace: ${path}`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function workspaceRoot(request: JavaProjectRequest): string {
  return (request.project.workspaceRoot ?? request.project.cwd ?? '/workspace')
    .replace(/\/+$/u, '');
}

function relativeCwd(request: JavaProjectRequest): string {
  const root = workspaceRoot(request);
  if (request.cwd === root) return '';
  if (request.cwd.startsWith(`${root}/`)) {
    return normalizePath(request.cwd.slice(root.length + 1));
  }
  throw new Error(`Java command cwd is outside the project workspace: ${request.cwd}`);
}

function resolveProjectPath(request: JavaProjectRequest, path: string): string {
  const root = workspaceRoot(request);
  if (path === root) return '';
  if (path.startsWith(`${root}/`)) {
    return normalizePath(path.slice(root.length + 1));
  }
  if (path.startsWith('/')) {
    throw new Error(`Java path is outside the project workspace: ${path}`);
  }
  const cwd = relativeCwd(request);
  return normalizePath(cwd ? `${cwd}/${path}` : path);
}

function decodeFile(file: RuntimeFile): Uint8Array {
  if (file.encoding !== 'base64') {
    return new TextEncoder().encode(file.contents);
  }
  const binary = atob(file.contents);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function projectFileMap(request: JavaProjectRequest): Map<string, RuntimeFile> {
  return new Map(
    request.project.files.map((file) => [normalizePath(file.path), file])
  );
}

function optionValue(
  args: readonly string[],
  index: number,
  option: string
): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`javac: option requires an argument -- ${option}`);
  }
  return value;
}

function assertJava23Option(option: string, value: string): void {
  if (value !== '23') {
    throw new Error(`${option}: TraceJVM supports Java 23; requested ${value}`);
  }
}

function parseCompileInvocation(args: readonly string[]): ParsedCompileInvocation {
  const parsed: ParsedCompileInvocation = { sources: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-d') {
      parsed.outputDirectory = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') {
      parsed.classpath = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--class-path=')) {
      parsed.classpath = arg.slice('--class-path='.length);
      continue;
    }
    if (
      arg === '--release' ||
      arg === '--source' ||
      arg === '-source' ||
      arg === '--target' ||
      arg === '-target'
    ) {
      assertJava23Option(arg, optionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (
      arg.startsWith('--release=') ||
      arg.startsWith('--source=') ||
      arg.startsWith('--target=')
    ) {
      const [option, value = ''] = arg.split('=', 2);
      assertJava23Option(option!, value);
      continue;
    }
    if (arg === '-encoding') {
      const value = optionValue(args, index, arg);
      if (value.toUpperCase() !== 'UTF-8') {
        throw new Error(
          `javac: TraceJVM source files are UTF-8; requested encoding ${value}`
        );
      }
      index += 1;
      continue;
    }
    if (
      arg === '-g' ||
      arg === '-g:none' ||
      arg === '-parameters' ||
      arg === '-proc:none' ||
      arg === '-nowarn'
    ) {
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`javac: unsupported option ${arg}`);
    }
    if (!arg.endsWith('.java')) {
      throw new Error(`javac: unsupported input ${arg}`);
    }
    parsed.sources.push(arg);
  }
  if (parsed.sources.length === 0) throw new Error('javac: no source files');
  return parsed;
}

function classpathFiles(
  request: JavaProjectRequest,
  specification: string | undefined
): TraceJVMBinaryFile[] {
  const files = projectFileMap(request);
  const entries = (specification ?? '.').split(':').filter(Boolean);
  const output: TraceJVMBinaryFile[] = [];
  for (const entry of entries) {
    const path = resolveProjectPath(request, entry);
    const exact = files.get(path);
    if (exact && (path.endsWith('.jar') || path.endsWith('.class'))) {
      output.push({
        path: path.split('/').at(-1)!,
        content: decodeFile(exact),
      });
      continue;
    }
    const prefix = path ? `${path}/` : '';
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix) || !filePath.endsWith('.class')) continue;
      output.push({
        path: filePath.slice(prefix.length),
        content: decodeFile(file),
      });
    }
  }
  return output;
}

function mapOutcome(
  result: TraceJVMExecuteResult,
  files?: RuntimeFile[]
): RuntimeCommandResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(files?.length ? { files } : {}),
  };
}

function combineWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal?: AbortSignal; cleanup(): void } {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal, cleanup() {} };
  }
  const controller = new AbortController();
  const handle = setTimeout(
    () => controller.abort({ signal: 'SIGKILL', source: 'execution-timeout' }),
    timeoutMs
  );
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    cleanup() {
      clearTimeout(handle);
    },
  };
}

function emitOutput(
  onEvent: RuntimeCommandEventHandler | undefined,
  stream: 'stdout' | 'stderr'
): (chunk: string) => void {
  return (chunk) => onEvent?.({ type: 'output', stream, data: chunk });
}

function cancelledResult(signal: AbortSignal | undefined): RuntimeCommandResult {
  const signalName = runtimeAbortSignalName(signal);
  return {
    stdout: '',
    stderr: '',
    exitCode: runtimeSignalExitCode(signalName),
    handledSignal: signalName,
  };
}

function terminateClient(client: TraceJVMProjectClient | undefined): void {
  try {
    client?.terminate();
  } catch {
    // Termination is a best-effort idempotent cleanup boundary. The operation
    // result or original infrastructure failure remains authoritative.
  }
}

interface KernelSyscallWireResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapKernelSyscallValue(
  operation: string,
  result: unknown
): unknown {
  if (!isRecord(result) || typeof result.ok !== 'boolean') {
    throw Object.assign(
      new Error('TraceKernel returned an invalid syscall response.'),
      { name: 'EPROTO' }
    );
  }
  const wire = result as unknown as KernelSyscallWireResult;
  if (!wire.ok) {
    const code =
      isRecord(wire.error) && typeof wire.error.code === 'string'
        ? wire.error.code
        : 'EIO';
    const message =
      isRecord(wire.error) && typeof wire.error.message === 'string'
        ? wire.error.message
        : `${code}: TraceKernel syscall failed`;
    throw Object.assign(new Error(message), { name: code });
  }
  if (
    isRecord(wire.value) &&
    wire.value.op === operation
  ) {
    const { op: _op, ...value } = wire.value;
    return Object.keys(value).length === 0 ? undefined : value;
  }
  return wire.value;
}

function createProcessHost(
  request: JavaProjectRequest
): TraceJVMProjectHost | undefined {
  const kernelSyscalls = request.kernelSyscalls;
  if (!kernelSyscalls) return undefined;
  const signalMailbox = request.kernelSignals?.mailbox;
  const signalState = signalMailbox
    ? new Int32Array(signalMailbox.buffer)
    : undefined;
  let signalSequence = 0;
  return Object.freeze({
    async dispatch(hostRequest: TraceJVMProjectHostRequest): Promise<unknown> {
      if (
        hostRequest.service === 'signal' &&
        hostRequest.operation === 'poll'
      ) {
        if (!signalState) return 0;
        const sequence = Atomics.load(signalState, 0);
        if (sequence === signalSequence) return 0;
        signalSequence = sequence;
        return Atomics.load(signalState, 1);
      }
      if (hostRequest.service !== 'posix') {
        throw Object.assign(
          new Error(`TraceJVM host service is not available: ${hostRequest.service}`),
          { name: 'ENOSYS' }
        );
      }
      const rawPayload = hostRequest.payload;
      if (rawPayload !== undefined && !isRecord(rawPayload)) {
        throw Object.assign(
          new Error('TraceJVM POSIX syscall payload must be an object.'),
          { name: 'EINVAL' }
        );
      }
      // tsup's declaration bundler does not preserve the predicate narrowing
      // across this generic public request boundary. The runtime guard above
      // establishes the record shape before the wire payload is spread.
      const payload = (rawPayload ?? {}) as Record<string, unknown>;
      const result = await kernelSyscalls.dispatch({
        ...payload,
        op: hostRequest.operation,
      });
      return unwrapKernelSyscallValue(hostRequest.operation, result);
    },
  });
}

function unsupportedSnapshot(request: JavaProjectRequest): RuntimeCommandResult | undefined {
  if ((request.project.symlinks?.length ?? 0) > 0) {
    return {
      ...commandError(
        'java: ENOTSUP: TraceJVM value adapter cannot materialize symbolic links'
      ),
      error: {
        code: 'ENOTSUP',
        message: 'TraceJVM value adapter cannot materialize symbolic links.',
        syscall: 'materialize',
      },
    };
  }
  if (request.options?.enablePreview === true) {
    return commandError('java: --enable-preview is not supported by TraceJVM');
  }
  if (request.options?.enableAssertions === true) {
    return commandError('java: -ea is not supported by TraceJVM');
  }
  return undefined;
}

async function executeWithClient(
  client: TraceJVMProjectClient,
  request: JavaProjectRequest,
  signal: AbortSignal | undefined,
  onEvent: RuntimeCommandEventHandler | undefined,
  onExecutionReport: TraceJVMProjectRunnerOptions['onExecutionReport']
): Promise<RuntimeCommandResult> {
  if (request.source === 'compile') {
    let invocation: ParsedCompileInvocation;
    try {
      invocation = parseCompileInvocation(request.args);
    } catch (error) {
      return commandError(error instanceof Error ? error.message : String(error));
    }
    const files = projectFileMap(request);
    const sources = invocation.sources.map((sourcePath) => {
      const path = resolveProjectPath(request, sourcePath);
      const file = files.get(path);
      if (!file) throw new Error(`javac: file not found: ${sourcePath}`);
      if (file.encoding === 'base64') {
        throw new Error(`javac: source file is not UTF-8 text: ${sourcePath}`);
      }
      return { path, content: file.contents };
    });
    const result = await client.compile({
      sources,
      classpath: classpathFiles(request, invocation.classpath),
      signal,
      onStdout: emitOutput(onEvent, 'stdout'),
      onStderr: emitOutput(onEvent, 'stderr'),
    });
    onExecutionReport?.({
      pid: request.process?.pid,
      source: request.source,
      result,
    });
    if (result.status === 'cancelled') return cancelledResult(signal);
    const outputDirectory = invocation.outputDirectory
      ? resolveProjectPath(request, invocation.outputDirectory)
      : relativeCwd(request);
    const changes = result.program?.files.map((file) => ({
      path: normalizePath(
        outputDirectory ? `${outputDirectory}/${file.path}` : file.path
      ),
      contents: encodeBase64(file.content),
      encoding: 'base64' as const,
    }));
    return mapOutcome(result, changes);
  }

  const options = request.options ?? {};
  const classpath =
    typeof options.classpath === 'string' ? options.classpath : undefined;
  const jarPath = typeof options.jarPath === 'string' ? options.jarPath : undefined;
  const mainClass =
    typeof options.jarMainClass === 'string'
      ? options.jarMainClass
      : request.scriptPath;
  const available = classpathFiles(request, classpath ?? jarPath);
  const result = await client.run({
    program: {
      files: available.filter((file) => file.path.endsWith('.class')),
    },
    classpath: available.filter((file) => file.path.endsWith('.jar')),
    mainClass,
    args: request.args,
    systemProperties: {
      ...(typeof options.systemProperties === 'object' &&
      options.systemProperties !== null
        ? (options.systemProperties as Record<string, string>)
        : {}),
      'user.dir': request.cwd,
    },
    signal,
    onStdout: emitOutput(onEvent, 'stdout'),
    onStderr: emitOutput(onEvent, 'stderr'),
  });
  onExecutionReport?.({
    pid: request.process?.pid,
    source: request.source,
    result,
  });
  return result.status === 'cancelled'
    ? cancelledResult(signal)
    : mapOutcome(result);
}

/**
 * Adapts TraceJVM's value-oriented public API to TraceKernel's javac/java
 * command boundary.
 *
 * javac still receives an immutable TKFS snapshot and commits its artifacts as
 * a final filesystem diff. Java application filesystem calls use the generic,
 * process-scoped host above, so concurrent runtimes observe the same
 * authoritative TraceKernel state. Standard descriptors, process pipes,
 * sockets, selectors, and watch services use that same host boundary.
 */
export function createTraceJVMProjectRunner(
  options: TraceJVMProjectRunnerOptions
): RuntimeProjectCommandRunner<JavaProjectRequest> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const coordinators =
    new WeakMap<RuntimeProjectEngineLeaseController, KernelProcessCoordinator>();
  const admittedClients = new WeakSet<object>();

  const coordinatorFor = (
    lease: RuntimeProjectEngineLeaseController
  ): KernelProcessCoordinator => {
    const existing = coordinators.get(lease);
    if (existing) return existing;
    const coordinator: KernelProcessCoordinator = {
      released: false,
      tail: Promise.resolve(),
    };
    coordinators.set(lease, coordinator);
    lease.attach({
      release: async () => {
        coordinator.released = true;
        terminateClient(coordinator.activeClient);
        await coordinator.tail.catch(() => undefined);
        coordinators.delete(lease);
      },
    });
    return coordinator;
  };

  const invoke = async (
    request: JavaProjectRequest,
    onEvent: RuntimeCommandEventHandler,
    engineLease: RuntimeProjectEngineLeaseController | undefined
  ): Promise<RuntimeCommandResult> => {
    const unsupported = unsupportedSnapshot(request);
    if (unsupported) return unsupported;
    const coordinator = engineLease
      ? coordinatorFor(engineLease)
      : ({ released: false, tail: Promise.resolve() } satisfies KernelProcessCoordinator);

    const execute = async (): Promise<RuntimeCommandResult> => {
      if (coordinator.released) {
        throw new Error('TraceJVM kernel process lease was released before execution.');
      }
      const bounded = combineWithTimeout(request.signal, timeoutMs);
      let client: TraceJVMProjectClient | undefined;
      const terminateActive = (): void => terminateClient(client);
      bounded.signal?.addEventListener('abort', terminateActive, { once: true });
      try {
        if (bounded.signal?.aborted) return cancelledResult(bounded.signal);
        client = await options.createClient(Object.freeze({
          cwd: request.cwd,
          process: request.process,
          host: createProcessHost(request),
          hostStandardDescriptors:
            request.kernelSyscalls !== undefined &&
            request.process?.descriptors?.includes(0) === true &&
            request.process.descriptors?.includes(1) === true &&
            request.process.descriptors?.includes(2) === true,
        }));
        if (
          (typeof client !== 'object' && typeof client !== 'function') ||
          client === null
        ) {
          throw new TypeError(
            'TraceJVM createClient must return a fresh Worker client object.'
          );
        }
        if (admittedClients.has(client)) {
          terminateClient(client);
          throw new Error(
            'TraceJVM createClient returned a client that was already admitted; mutable VM reuse across invocations is forbidden.'
          );
        }
        admittedClients.add(client);
        if (coordinator.released || bounded.signal?.aborted) {
          terminateClient(client);
          return cancelledResult(bounded.signal);
        }
        coordinator.activeClient = client;
        return await executeWithClient(
          client,
          request,
          bounded.signal,
          onEvent,
          options.onExecutionReport
        );
      } catch (error) {
        if (bounded.signal?.aborted) return cancelledResult(bounded.signal);
        throw error;
      } finally {
        bounded.signal?.removeEventListener('abort', terminateActive);
        if (coordinator.activeClient === client) {
          coordinator.activeClient = undefined;
        }
        terminateClient(client);
        bounded.cleanup();
      }
    };

    const operation = coordinator.tail.then(execute);
    coordinator.tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  };

  return withRuntimeProjectCommandRunnerCapabilities(
    (request) => runRuntimeProjectWorkerBridge({
      request,
      startPhase: request.source === 'compile' ? 'compile-start' : 'process-start',
      startMessage:
        request.source === 'compile'
          ? 'Starting TraceJVM browser compile'
          : 'Starting TraceJVM browser run',
      startDetail: {
        provider: 'tracejvm',
        source: request.source,
        scriptPath: request.scriptPath,
        args: request.args,
        cwd: request.cwd,
        pid: request.process?.pid,
      },
      finishPhase: request.source === 'compile' ? 'compile-end' : 'process-exit',
      finishMessage:
        request.source === 'compile'
          ? 'Finished TraceJVM browser compile'
          : 'Finished TraceJVM browser run',
      finishDetail: (result) => ({
        provider: 'tracejvm',
        source: request.source,
        exitCode: result.exitCode,
        pid: request.process?.pid,
      }),
      applyFileChange: options.applyFileChange,
      run: invoke,
    }),
    { descriptorStdio: TRACEJVM_PROJECT_CAPABILITIES.descriptorStdio }
  );
}
