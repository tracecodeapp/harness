import {
  TraceJVMCompilerWorkerClient,
  TraceJVMWorkerClient,
  type TraceJVMBinaryFile,
  type TraceJVMCompileResult,
  type TraceJVMExecuteResult,
  type TraceJVMWorkerHost,
  type TraceJVMWorkerLike,
} from '@tracecode/tracejvm';

declare const __TRACECODE_TRACEJVM_HOT_AOT__: boolean;

interface TraceJVMTraceRequest {
  source: string;
  entryClass: string;
  maxStoredEvents: number;
  profileBytecode?: boolean;
}

interface TraceJVMTraceReport {
  success: boolean;
  output?: string;
  events: string[];
  compilerStdout: string;
  compilerStderr: string;
  runtimeError?: string;
  compileTimeMs: number;
  classLoadTimeMs: number;
  runTimeMs: number;
  compileCacheHit: boolean;
  compilerDebugProfile: string;
  traceLimitExceeded: boolean;
  droppedEventCount: number;
  bytecodeProfile?: unknown;
  diagnosticError?: string;
}

declare global {
  var runTraceJVMSemanticTrace:
    | ((request: TraceJVMTraceRequest) => Promise<TraceJVMTraceReport>)
    | undefined;
  var closeTraceJVMSemanticTrace: (() => void) | undefined;
}

const OUTPUT_MARKER = '__TRACECODE_TRACE_OUTPUT__:';
const EVENT_MARKER = '__TRACECODE_TRACE_EVENT__:';
const LIMIT_MARKER = '__TRACECODE_TRACE_LIMIT__:';
const DROPPED_MARKER = '__TRACECODE_TRACE_DROPPED__:';
const ERROR_MARKER = '__TRACECODE_TRACE_ERROR__:';

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function markerValue(lines: readonly string[], marker: string): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith(marker));
  return line?.slice(marker.length);
}

async function binaryFileFromUrl(
  path: string,
  url: string,
): Promise<TraceJVMBinaryFile> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load TraceJVM semantic trace fixture ${url}: ${response.status}`);
  }
  return {
    path,
    content: new Uint8Array(await response.arrayBuffer()),
  };
}

const compiler = new TraceJVMCompilerWorkerClient({
  compiler: {
    assets: {
      baseUrl: '/tracejvm/compiler',
    },
    platformArchiveUrl: '/tracejvm/profiles/core/jdk23.jar',
    platformClasspath: [{
      path: 'tracekernel-api.jar',
      url: '/tracejvm/profiles/core/tracekernel-api.jar',
    }],
  },
  createWorker: () => new Worker('/tracejvm/browser-worker.js', {
    type: 'module',
  }) as unknown as TraceJVMWorkerLike,
});

const helperJarPromise = binaryFileFromUrl(
  'java-browser-helper.jar',
  '/fixture/java-browser-helper.jar',
);
const unavailableHost: TraceJVMWorkerHost = Object.freeze({
  dispatch() {
    throw Object.assign(new Error('TraceKernel host is unavailable.'), {
      name: 'ENOSYS',
    });
  },
});
const prewarm = compiler.initialize();
void prewarm.catch(() => undefined);

globalThis.runTraceJVMSemanticTrace = async (request) => {
  const [helperJar] = await Promise.all([
    helperJarPromise,
    prewarm,
  ]);
  const startedAt = performance.now();
  const sourceClass = request.entryClass.split('.').at(-1);
  let compile: TraceJVMCompileResult;
  try {
    compile = await compiler.compile({
      sources: [{
        path: `${sourceClass ?? 'Exports'}.java`,
        content: request.source,
      }],
      classpath: [helperJar],
    });
  } catch (error) {
    throw error;
  }
  const compileEndedAt = performance.now();
  if (compile.status !== 'completed' || !compile.program) {
    return {
      success: false,
      events: [],
      compilerStdout: compile.stdout,
      compilerStderr: compile.stderr,
      compileTimeMs: compile.timings.totalMs,
      classLoadTimeMs: 0,
      runTimeMs: 0,
      compileCacheHit: false,
      compilerDebugProfile: 'full',
      traceLimitExceeded: false,
      droppedEventCount: 0,
    };
  }

  const runStartedAt = performance.now();
  let run: TraceJVMExecuteResult;
  const runner = new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: '/tracejvm/profiles/core',
        },
        wasmUrl: '/tracejvm/bjvm_main.wasm',
      },
      workingDirectory: '/',
      hostStandardDescriptors: false,
      runtimeProfile: 'core',
      retirementAfterExecutions: 1,
      experiments: {
        hotAot: __TRACECODE_TRACEJVM_HOT_AOT__,
      },
    },
    host: unavailableHost,
    createWorker: () => new Worker('/tracejvm/browser-worker.js', {
      type: 'module',
    }) as unknown as TraceJVMWorkerLike,
  });
  try {
    run = await runner.run({
      program: compile.program,
      classpath: [helperJar],
      mainClass: 'tracecode.browser.TraceExecutionRunner',
      args: [request.entryClass, String(request.maxStoredEvents)],
      diagnostics: {
        bytecodeProfile: request.profileBytecode,
      },
    });
  } finally {
    runner.terminate();
  }
  const runEndedAt = performance.now();
  const lines = run.stdout.split(/\r?\n/u);
  const output = markerValue(lines, OUTPUT_MARKER);
  const runtimeError = markerValue(lines, ERROR_MARKER);
  const events = lines
    .filter((line) => line.startsWith(EVENT_MARKER))
    .map((line) => decodeBase64(line.slice(EVENT_MARKER.length)));
  const traceLimitExceeded = markerValue(lines, LIMIT_MARKER) === 'true';
  const droppedEventCount = Number.parseInt(
    markerValue(lines, DROPPED_MARKER) ?? '0',
    10,
  );
  const success = run.status === 'completed' && runtimeError === undefined;

  return {
    success,
    ...(output !== undefined ? { output: decodeBase64(output) } : {}),
    events,
    compilerStdout: compile.stdout,
    compilerStderr: compile.stderr,
    ...(runtimeError !== undefined
      ? { runtimeError: decodeBase64(runtimeError) }
      : run.status !== 'completed'
        ? { runtimeError: run.stderr || `TraceJVM run ended with ${run.status}.` }
        : {}),
    compileTimeMs: compileEndedAt - startedAt,
    classLoadTimeMs: 0,
    runTimeMs: runEndedAt - runStartedAt,
    compileCacheHit: false,
    compilerDebugProfile: 'full',
    traceLimitExceeded,
    droppedEventCount: Number.isFinite(droppedEventCount) ? droppedEventCount : 0,
    ...(run.diagnostics?.bytecodeProfile
      ? { bytecodeProfile: run.diagnostics.bytecodeProfile }
      : {}),
    ...(run.diagnostics?.diagnosticError
      ? { diagnosticError: run.diagnostics.diagnosticError }
      : {}),
  };
};

globalThis.closeTraceJVMSemanticTrace = () => {
  compiler.terminate();
};
