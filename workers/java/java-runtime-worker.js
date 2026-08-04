/*
 * TraceJVM provider for the existing Harness Java worker protocol.
 *
 * The canonical java-worker owns request normalization, source generation,
 * semantic instrumentation, output normalization, and protocol behavior.
 * This file supplies the small host-library surface that java-worker
 * historically received from CheerpJ, backed by TraceJVM instead.
 */

const traceJVMWorkerParameters = new URL(self.location.href).searchParams;
const configuredTraceJVMBaseUrl =
  traceJVMWorkerParameters.get('tracejvmBaseUrl');

function normalizeTraceJVMBaseUrl(value) {
  const url = new URL(value || '/tracejvm/', self.location.href);
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  url.search = '';
  url.hash = '';
  return url;
}

const TRACEJVM_BASE_URL = normalizeTraceJVMBaseUrl(
  configuredTraceJVMBaseUrl
);
const TRACEJVM_MODULE_URL = new URL('browser-client.js', TRACEJVM_BASE_URL);
const TRACEJVM_WASM_URL = new URL('bjvm_main.wasm', TRACEJVM_BASE_URL);
const TRACEJVM_COMPILER_URL = new URL('compiler', TRACEJVM_BASE_URL);
const TRACEJVM_CORE_PROFILE_URL = new URL('profiles/core', TRACEJVM_BASE_URL);
const TRACEJVM_HELPER_JAR_URL = new URL('./vendor/java-browser-helper.jar', self.location.href);
const CLASSIC_JAVA_WORKER_URL = new URL('./java-worker.js', self.location.href);
const TRACEKERNEL_SYSCALL_CLIENT_URL = new URL(
  './shared/tracekernel-syscall-client.js',
  self.location.href
);
const TRACEKERNEL_LOCAL_JAVA_HOST_URL = new URL(
  './shared/tracekernel-local-java-host.js',
  self.location.href
);

// The canonical Java worker removes ambient fetch authority while learner code
// runs. Declare only this provider's immutable runtime asset root so TraceJVM
// can continue demand-loading its pinned JDK image inside that boundary.
self.TraceCodeJavaProviderRuntimeFetchPrefixes = [
  TRACEJVM_BASE_URL.href,
];

const traceJVMStringFiles = new Map();
let traceJVMModulePromise;
let traceKernelLocalJavaHostModulePromise;
let traceJVMClientPromise;
let traceJVMHelperJarPromise;
let traceJVMRewriteProgramPromise;
const traceJVMCompileCache = new Map();
const TRACEJVM_COMPILE_CACHE_LIMIT = 64;
const traceJVMPreparedPrograms = new Map();
let traceJVMPreparedCompileCount = 0;
const traceJVMKernelChannels = new Map();
const traceJVMLocalKernelAuthorities = new Map();
const traceJVMPostMessage = self.postMessage.bind(self);
const traceJVMPendingExecutionScopeResets = new Map();
let traceJVMExecutionScopeResetSequence = 0;

const TRACE_OUTPUT_MARKER = '__TRACECODE_TRACE_OUTPUT__:';
const TRACE_EVENT_MARKER = '__TRACECODE_TRACE_EVENT__:';
const TRACE_LIMIT_MARKER = '__TRACECODE_TRACE_LIMIT__:';
const TRACE_DROPPED_MARKER = '__TRACECODE_TRACE_DROPPED__:';
const TRACE_ERROR_MARKER = '__TRACECODE_TRACE_ERROR__:';

const REWRITE_BRIDGE_SOURCE = `
package tracecode.harness.bridge;

import harness.browser.JavaRewriteLibrary;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public final class TraceJVMRewriteBridge {
  private static String decode(String value) {
    return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
  }

  private static String encode(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  public static void main(String[] args) {
    if (args.length != 6) {
      throw new IllegalArgumentException("TraceJVMRewriteBridge requires six arguments");
    }
    System.out.print(encode(JavaRewriteLibrary.rewriteSource(
        decode(args[0]),
        decode(args[1]),
        decode(args[2]),
        decode(args[3]),
        decode(args[4]),
        decode(args[5]))));
  }
}
`;

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeText(value) {
  return bytesToBase64(new TextEncoder().encode(String(value)));
}

function decodeText(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function markerValue(lines, marker) {
  const line = lines.find((candidate) => candidate.startsWith(marker));
  return line?.slice(marker.length);
}

async function loadTraceJVMModule() {
  traceJVMModulePromise ??= import(TRACEJVM_MODULE_URL.href);
  return traceJVMModulePromise;
}

async function loadLocalTraceKernelModule() {
  traceKernelLocalJavaHostModulePromise ??=
    import(TRACEKERNEL_LOCAL_JAVA_HOST_URL.href);
  return traceKernelLocalJavaHostModulePromise;
}

async function createLocalTraceKernelAuthority() {
  const { createLocalJavaKernelAuthority } =
    await loadLocalTraceKernelModule();
  return createLocalJavaKernelAuthority();
}

async function loadTraceJVMHelperJar() {
  traceJVMHelperJarPromise ??= (async () => {
    const response = await fetch(TRACEJVM_HELPER_JAR_URL);
    if (!response.ok) {
      throw new Error(
        `Could not load TraceJVM Harness helper JAR: ${response.status}`
      );
    }
    return {
      path: 'java-browser-helper.jar',
      content: new Uint8Array(await response.arrayBuffer()),
    };
  })();
  return traceJVMHelperJarPromise;
}

async function createTraceJVMClient() {
  const {
    TraceJVMCompiler,
    TraceJVMRunnerHost,
  } = await loadTraceJVMModule();
  const runtimeProfileBaseUrl =
    TRACEJVM_CORE_PROFILE_URL.href.replace(/\/+$/, '');
  const compiler = new TraceJVMCompiler({
    assets: {
      baseUrl: TRACEJVM_COMPILER_URL.href.replace(/\/+$/, ''),
    },
    platformArchiveUrl: `${runtimeProfileBaseUrl}/jdk23.jar`,
    platformClasspath: [{
      path: 'tracekernel-api.jar',
      url: `${runtimeProfileBaseUrl}/tracekernel-api.jar`,
    }],
  });
  const runnerHost = new TraceJVMRunnerHost({
    assets: {
      runtimeProfileBaseUrls: {
        core: runtimeProfileBaseUrl,
      },
      wasmUrl: TRACEJVM_WASM_URL.href,
    },
    runtimeProfile: 'core',
    retirementAfterExecutions: 1,
  });
  await Promise.all([
    compiler.initialize(),
    runnerHost.initialize(),
  ]);

  return {
    initialize() {
      return compiler.initialize();
    },
    compile(request) {
      return compiler.compile(request);
    },
    async createProcess(options = {}) {
      return runnerHost.createProcess(options);
    },
    dispose() {
      runnerHost.dispose();
      compiler.dispose();
    },
  };
}

async function getTraceJVMClient() {
  traceJVMClientPromise ??= createTraceJVMClient();
  return traceJVMClientPromise;
}

function invalidateTraceJVMClient() {
  void traceJVMClientPromise
    ?.then((client) => client.dispose())
    .catch(() => undefined);
  traceJVMClientPromise = undefined;
  traceJVMRewriteProgramPromise = undefined;
}

function unwrapTraceKernelResult(operation, result) {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw Object.assign(
      new Error('TraceKernel returned an invalid syscall response.'),
      { code: 'EPROTO' }
    );
  }
  if (!result.ok) {
    throw Object.assign(
      new Error(result.error?.message ?? 'TraceKernel syscall failed.'),
      { code: result.error?.code ?? 'EIO' }
    );
  }
  if (
    result.value &&
    typeof result.value === 'object' &&
    result.value.op === operation
  ) {
    const { op: _operation, ...value } = result.value;
    return Object.keys(value).length === 0 ? undefined : value;
  }
  return result.value;
}

function traceJVMProcessHost(programId) {
  const activeRequestId = self.TraceCodeActiveKernelRequestId;
  const kernelRequest = programId === false
    ? undefined
    : (
        (programId ? traceJVMKernelChannels.get(String(programId)) : undefined) ??
        (activeRequestId
          ? traceJVMKernelChannels.get(String(activeRequestId))
          : undefined)
      );
  const localAuthority = programId === false
    ? undefined
    : traceJVMLocalKernelAuthorities.get(String(programId));
  if (kernelRequest) {
    const Client = self.TraceCodeTraceKernelSharedSyscallClient;
    if (typeof Client !== 'function') {
      throw new Error('TraceKernel shared syscall client is unavailable.');
    }
    const client = kernelRequest.client ??= new Client(
      kernelRequest.channel,
      () => traceJVMPostMessage({
        id: kernelRequest.id,
        type: 'kernel-syscall',
        protocolToken: kernelRequest.protocolToken,
      })
    );
    return {
      kernelBound: true,
      dispatchSync(request) {
        return unwrapTraceKernelResult(
          request.operation,
          client.dispatchSync({
            ...(request.payload ?? {}),
            op: request.operation,
          })
        );
      },
      async dispatch(request) {
        return this.dispatchSync(request);
      },
      // The host owns the process-bound channel and closes it after the outer
      // request. A batch may replace several inner JVMs on that one process.
      close() {},
    };
  }
  if (localAuthority) {
    return {
      kernelBound: true,
      dispatchSync(request) {
        return unwrapTraceKernelResult(
          request.operation,
          localAuthority.dispatchSync(request)
        );
      },
      async dispatch(request) {
        return unwrapTraceKernelResult(
          request.operation,
          await localAuthority.dispatch(request)
        );
      },
      close() {},
    };
  }
  const unsupported = (request) => {
    throw Object.assign(
      new Error(
        `Unsupported Harness Java process host call: ` +
        `${request?.service}.${request?.operation}`
      ),
      { code: 'ENOSYS' }
    );
  };
  return {
    dispatchSync: unsupported,
    dispatch: async (request) => unsupported(request),
  };
}

function resetTraceKernelExecutionScope(programId) {
  const localAuthority = programId
    ? traceJVMLocalKernelAuthorities.get(String(programId))
    : undefined;
  if (localAuthority) {
    return localAuthority.resetExecutionScope();
  }
  const activeRequestId = self.TraceCodeActiveKernelRequestId;
  const kernelRequest =
    (programId
      ? traceJVMKernelChannels.get(String(programId))
      : undefined) ??
    (activeRequestId
      ? traceJVMKernelChannels.get(String(activeRequestId))
      : undefined);
  if (!kernelRequest) return Promise.resolve();

  const requestId =
    `java-case-reset-${++traceJVMExecutionScopeResetSequence}`;
  return new Promise((resolve, reject) => {
    traceJVMPendingExecutionScopeResets.set(requestId, {
      resolve,
      reject,
      protocolToken: kernelRequest.protocolToken,
    });
    traceJVMPostMessage({
      id: kernelRequest.id,
      type: 'kernel-execution-scope-reset',
      protocolToken: kernelRequest.protocolToken,
      payload: { requestId },
    });
  });
}

async function runInFreshTraceJVMProcess(client, request, programId) {
  const processFiles = request.processFiles;
  const host = traceJVMProcessHost(programId);
  if (host.kernelBound && processFiles?.length) {
    request = { ...request };
    delete request.processFiles;
  }
  const process = await client.createProcess({
    workingDirectory: '/workspace',
    ...(host.kernelBound ? { host } : {}),
  });
  try {
    for (const file of host.kernelBound ? processFiles ?? [] : []) {
      const normalizedPath = `/${String(file.path).replace(/^\/+/, '')}`;
      const parentPath = normalizedPath.slice(
        0,
        Math.max(1, normalizedPath.lastIndexOf('/'))
      );
      await host.dispatch({
        service: 'posix',
        operation: 'mkdir',
        payload: {
          path: parentPath,
          options: { recursive: true },
        },
      });
      const opened = await host.dispatch({
        service: 'posix',
        operation: 'open',
        payload: {
          path: normalizedPath,
          options: {
            access: 'write',
            create: true,
            truncate: true,
          },
        },
      });
      try {
        await host.dispatch({
          service: 'posix',
          operation: 'write',
          payload: {
            fd: opened.fd,
            bytes: file.content,
          },
        });
      } finally {
        await host.dispatch({
          service: 'posix',
          operation: 'close',
          payload: { fd: opened.fd },
        });
      }
    }
    return await process.run(request);
  } finally {
    process.dispose();
    host.close?.();
  }
}

async function runInLeasedTraceJVMBatchProcess(
  client,
  request,
  systemPropertiesBatch,
  programId,
  perCaseWallClockMs
) {
  const processFiles = request.processFiles;
  const results = [];
  let processCount = 0;
  let process;
  let host;

  const releaseProcess = () => {
    process?.dispose();
    process = undefined;
    host?.close?.();
    host = undefined;
  };

  const createProcess = async (remainingExecutions) => {
    processCount += 1;
    host = traceJVMProcessHost(programId);
    const kernelBound = host.kernelBound;
    process = await client.createProcess({
      workingDirectory: '/workspace',
      retirementAfterExecutions: remainingExecutions,
      ...(kernelBound ? { host } : {}),
    });
    for (const file of kernelBound ? processFiles ?? [] : []) {
      const normalizedPath = `/${String(file.path).replace(/^\/+/, '')}`;
      const parentPath = normalizedPath.slice(
        0,
        Math.max(1, normalizedPath.lastIndexOf('/'))
      );
      await host.dispatch({
        service: 'posix',
        operation: 'mkdir',
        payload: {
          path: parentPath,
          options: { recursive: true },
        },
      });
      const opened = await host.dispatch({
        service: 'posix',
        operation: 'open',
        payload: {
          path: normalizedPath,
          options: {
            access: 'write',
            create: true,
            truncate: true,
          },
        },
      });
      try {
        await host.dispatch({
          service: 'posix',
          operation: 'write',
          payload: {
            fd: opened.fd,
            bytes: file.content,
          },
        });
      } finally {
        await host.dispatch({
          service: 'posix',
          operation: 'close',
          payload: { fd: opened.fd },
        });
      }
    }
  };

  try {
    for (let index = 0; index < systemPropertiesBatch.length; index += 1) {
      if (!process) {
        await createProcess(systemPropertiesBatch.length - index);
      }
      const kernelBound = host.kernelBound;
      const timedOut = Symbol('tracejvm-case-timeout');
      let timeout;
      const run = process.run({
        ...request,
        ...(kernelBound && request.processFiles
          ? { processFiles: undefined }
          : {}),
        systemProperties: systemPropertiesBatch[index],
      });
      const timeoutResult =
        Number.isFinite(perCaseWallClockMs) && perCaseWallClockMs > 0
          ? new Promise((resolve) => {
              timeout = setTimeout(
                () => resolve(timedOut),
                perCaseWallClockMs
              );
            })
          : undefined;
      let result;
      try {
        const outcome = timeoutResult
          ? await Promise.race([run, timeoutResult])
          : await run;
        if (outcome === timedOut) {
          releaseProcess();
          result = {
            status: 'cancelled',
            exitCode: 124,
            stdout: '',
            stderr:
              `Java execution timed out after ${perCaseWallClockMs}ms.`,
            timings: {
              runtimeInitMs: 0,
              queueMs: 0,
              compileAndRunMs: perCaseWallClockMs,
              totalMs: perCaseWallClockMs,
            },
            isolation: {
              status: 'tainted',
              restored: [],
              taintReasons: ['wall-clock-timeout'],
              hardBoundaryRecommended: true,
            },
            retirementRecommended: true,
          };
        } else {
          result = outcome;
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      results.push(result);
      if (
        kernelBound &&
        index + 1 < systemPropertiesBatch.length
      ) {
        await resetTraceKernelExecutionScope(programId);
      }
      // The configured retirement threshold is the end of the batch. An
      // earlier recommendation therefore means the execution tainted the JVM
      // and the next case needs a hard process boundary.
      if (
        result.retirementRecommended &&
        index + 1 < systemPropertiesBatch.length
      ) {
        releaseProcess();
      }
    }
    return { results, processCount };
  } finally {
    releaseProcess();
  }
}

async function compileRewriteBridge(client, helperJar) {
  traceJVMRewriteProgramPromise ??= (async () => {
    const result = await client.compile({
      sources: [{
        path: 'tracecode/harness/bridge/TraceJVMRewriteBridge.java',
        content: REWRITE_BRIDGE_SOURCE,
      }],
      classpath: [helperJar],
    });
    if (
      result.status !== 'completed' ||
      result.exitCode !== 0 ||
      !result.program
    ) {
      throw new Error(
        result.stderr ||
        result.stdout ||
        `TraceJVM rewrite bridge compilation ended with ${result.status}.`
      );
    }
    return result.program;
  })();
  return traceJVMRewriteProgramPromise;
}

async function traceJVMRewriteSource(
  source,
  executionStyle,
  entryName,
  exportsSource,
  exportsClassName,
  packageName
) {
  const rewriteArguments = {
    source,
    executionStyle,
    entryName,
    exportsSource,
    exportsClassName,
    packageName,
  };
  for (const [name, value] of Object.entries(rewriteArguments)) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `TraceJVM source rewrite requires a string ${name}; received ${typeof value}.`
      );
    }
  }
  const atStage = async (stage, operation) => {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TraceJVM rewrite ${stage} failed: ${message}`, {
        cause: error,
      });
    }
  };
  const [client, helperJar] = await atStage('runtime preparation', () =>
    Promise.all([
      getTraceJVMClient(),
      loadTraceJVMHelperJar(),
    ])
  );
  const program = await atStage(
    'bridge compilation',
    () => compileRewriteBridge(client, helperJar)
  );
  const encodedArguments = await atStage('argument encoding', () =>
    Promise.resolve([
      source,
      executionStyle,
      entryName,
      exportsSource,
      exportsClassName,
      packageName,
    ].map(encodeText))
  );
  const result = await atStage('bridge execution', () => runInFreshTraceJVMProcess(client, {
    program,
    classpath: [helperJar],
    mainClass: 'tracecode.harness.bridge.TraceJVMRewriteBridge',
    args: encodedArguments,
  }, false));
  if (result.status !== 'completed' || result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
      `TraceJVM source rewrite ended with ${result.status}.`
    );
  }
  return atStage(
    'result decoding',
    () => Promise.resolve(decodeText(result.stdout.trim()))
  );
}

function sourcePathFromVirtualPath(sourcePath) {
  const name = String(sourcePath).replace(/\\/g, '/').split('/').at(-1);
  return name || 'Exports.java';
}

function processFiles() {
  return [...traceJVMStringFiles].map(([path, content]) => ({
    path,
    content: new TextEncoder().encode(content),
  }));
}

function compileFailureReport(compile, compilerDebugProfile) {
  return {
    success: false,
    output: null,
    events: [],
    compilerStdout: compile.stdout,
    compilerStderr: compile.stderr,
    runtimeError: 'Java compilation failed',
    compileTimeMs: compile.timings?.totalMs ?? 0,
    classLoadTimeMs: 0,
    runTimeMs: 0,
    compileCacheHit: false,
    compilerDebugProfile,
    traceLimitExceeded: false,
    droppedEventCount: 0,
  };
}

function executionReport(
  run,
  compile,
  compilerDebugProfile,
  compileCacheHit = false
) {
  const lines = run.stdout.split(/\r?\n/u);
  const encodedOutput = markerValue(lines, TRACE_OUTPUT_MARKER);
  const encodedError = markerValue(lines, TRACE_ERROR_MARKER);
  const events = lines
    .filter((line) => line.startsWith(TRACE_EVENT_MARKER))
    .map((line) => decodeText(line.slice(TRACE_EVENT_MARKER.length)));
  const runtimeError = encodedError
    ? decodeText(encodedError)
    : run.status !== 'completed' || run.exitCode !== 0
      ? run.stderr || `TraceJVM execution ended with ${run.status}.`
      : encodedOutput === undefined
        ? 'TraceJVM execution completed without a Harness result marker.'
        : undefined;
  const traceLimitExceeded =
    markerValue(lines, TRACE_LIMIT_MARKER) === 'true';
  const droppedEventCount = Number.parseInt(
    markerValue(lines, TRACE_DROPPED_MARKER) ?? '0',
    10
  );

  return {
    success: runtimeError === undefined,
    ...(encodedOutput ? { output: decodeText(encodedOutput) } : {}),
    events,
    compilerStdout: compile.stdout,
    compilerStderr: compile.stderr,
    ...(runtimeError ? { runtimeError } : {}),
    compileTimeMs: compileCacheHit ? 0 : (compile.timings?.totalMs ?? 0),
    classLoadTimeMs: 0,
    runTimeMs: run.timings?.compileAndRunMs ?? run.timings?.totalMs ?? 0,
    compileCacheHit,
    compilerDebugProfile,
    traceLimitExceeded,
    droppedEventCount: Number.isFinite(droppedEventCount)
      ? droppedEventCount
      : 0,
    ...(run.diagnostics?.bytecodeProfile
      ? { bytecodeProfile: run.diagnostics.bytecodeProfile }
      : {}),
    ...(run.diagnostics?.diagnosticError
      ? { diagnosticError: run.diagnostics.diagnosticError }
      : {}),
    isolation: run.isolation,
    retirementRecommended: false,
  };
}

async function compileSource(sourcePath, compilerDebugProfile) {
  const source = traceJVMStringFiles.get(sourcePath);
  if (source === undefined) {
    throw new Error(`Missing TraceJVM source file: ${sourcePath}`);
  }
  const [client, helperJar] = await Promise.all([
    getTraceJVMClient(),
    loadTraceJVMHelperJar(),
  ]);
  const cacheKey = `${sourcePath}\0${source}`;
  let compile = traceJVMCompileCache.get(cacheKey);
  const compileCacheHit = compile !== undefined;
  if (compile) {
    traceJVMCompileCache.delete(cacheKey);
    traceJVMCompileCache.set(cacheKey, compile);
  } else {
    compile = await client.compile({
      sources: [{
        path: sourcePathFromVirtualPath(sourcePath),
        content: source,
      }],
      classpath: [helperJar],
    });
    if (
      compile.status === 'completed' &&
      compile.exitCode === 0 &&
      compile.program
    ) {
      traceJVMCompileCache.set(cacheKey, compile);
      while (traceJVMCompileCache.size > TRACEJVM_COMPILE_CACHE_LIMIT) {
        traceJVMCompileCache.delete(traceJVMCompileCache.keys().next().value);
      }
    }
  }
  return {
    client,
    helperJar,
    compile,
    compileCacheHit,
    compilerDebugProfile,
  };
}

async function compileAndExecute(
  sourcePath,
  entryClass,
  compilerDebugProfile,
  maxStoredEvents
) {
  const context = await compileSource(sourcePath, compilerDebugProfile);
  if (
    context.compile.status !== 'completed' ||
    context.compile.exitCode !== 0 ||
    !context.compile.program
  ) {
    return compileFailureReport(context.compile, compilerDebugProfile);
  }
  const run = await runInFreshTraceJVMProcess(context.client, {
    program: context.compile.program,
    classpath: [context.helperJar],
    processFiles: processFiles(),
    mainClass: 'tracecode.browser.TraceExecutionRunner',
    args: [entryClass, String(maxStoredEvents)],
  });
  const report = executionReport(
    run,
    context.compile,
    compilerDebugProfile,
    context.compileCacheHit
  );
  return report;
}

async function traceJVMCompileAndRun(
  sourcePath,
  _classesDir,
  entryClass,
  _compileClasspath,
  compilerDebugProfile
) {
  return JSON.stringify(await compileAndExecute(
    sourcePath,
    entryClass,
    compilerDebugProfile,
    1
  ));
}

async function traceJVMCompileAndTrace(
  sourcePath,
  _classesDir,
  entryClass,
  _compileClasspath,
  compilerDebugProfile,
  maxStoredEvents = '50000'
) {
  return JSON.stringify(await compileAndExecute(
    sourcePath,
    entryClass,
    compilerDebugProfile,
    Number.parseInt(String(maxStoredEvents), 10) || 50_000
  ));
}

async function traceJVMCompileAndRunBatch(
  sourcePath,
  _classesDir,
  entryClassesText,
  _compileClasspath,
  compilerDebugProfile
) {
  const context = await compileSource(sourcePath, compilerDebugProfile);
  if (
    context.compile.status !== 'completed' ||
    context.compile.exitCode !== 0 ||
    !context.compile.program
  ) {
    return JSON.stringify({
      ...compileFailureReport(context.compile, compilerDebugProfile),
      results: [],
    });
  }

  const entryClasses = String(entryClassesText)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const results = [];
  for (const entryClass of entryClasses) {
    const run = await runInFreshTraceJVMProcess(context.client, {
      program: context.compile.program,
      classpath: [context.helperJar],
      processFiles: processFiles(),
      mainClass: 'tracecode.browser.TraceExecutionRunner',
      args: [entryClass, '1'],
    });
    const report = executionReport(
      run,
      context.compile,
      compilerDebugProfile,
      context.compileCacheHit
    );
    results.push({
      success: report.success,
      output: report.output,
      runtimeError: report.runtimeError,
      classLoadTimeMs: report.classLoadTimeMs,
      runTimeMs: report.runTimeMs,
    });
  }

  return JSON.stringify({
    success: results.every((result) => result.success),
    results,
    compilerStdout: context.compile.stdout,
    compilerStderr: context.compile.stderr,
    compileTimeMs: context.compileCacheHit
      ? 0
      : (context.compile.timings?.totalMs ?? 0),
    compileCacheHit: context.compileCacheHit,
    compilerDebugProfile,
  });
}

async function traceJVMPrepareRuntimeProgram(
  programId,
  sourcePath,
  compilerDebugProfile
) {
  const normalizedProgramId = String(programId);
  if (!normalizedProgramId) {
    throw new TypeError('TraceJVM prepared programs require a non-empty id.');
  }
  if (traceJVMPreparedPrograms.has(normalizedProgramId)) {
    throw new Error(`TraceJVM prepared program already exists: ${normalizedProgramId}`);
  }

  const context = await compileSource(
    String(sourcePath),
    String(compilerDebugProfile)
  );
  traceJVMPreparedCompileCount += context.compileCacheHit ? 0 : 1;
  if (
    context.compile.status !== 'completed' ||
    context.compile.exitCode !== 0 ||
    !context.compile.program
  ) {
    return JSON.stringify({
      ...compileFailureReport(context.compile, compilerDebugProfile),
      preparedCompileCount: traceJVMPreparedCompileCount,
    });
  }

  traceJVMPreparedPrograms.set(normalizedProgramId, {
    program: context.compile.program,
    compilerDebugProfile: String(compilerDebugProfile),
    compilerStdout: context.compile.stdout,
    compilerStderr: context.compile.stderr,
    compileTimeMs: context.compileCacheHit
      ? 0
      : (context.compile.timings?.totalMs ?? 0),
    compileCacheHit: context.compileCacheHit,
    executions: 0,
    retired: false,
  });

  return JSON.stringify({
    success: true,
    compilerStdout: context.compile.stdout,
    compilerStderr: context.compile.stderr,
    compileTimeMs: context.compileCacheHit
      ? 0
      : (context.compile.timings?.totalMs ?? 0),
    compileCacheHit: context.compileCacheHit,
    preparedCompileCount: traceJVMPreparedCompileCount,
    preparedArtifact: serializeTraceJVMPreparedProgram(
      context.compile.program
    ),
  });
}

async function traceJVMRunPreparedRuntimeProgram(
  programId,
  entryClass,
  maxStoredEvents = '1',
  preparedInputProperties = '{}',
  learnerFrame = ''
) {
  const normalizedProgramId = String(programId);
  const prepared = traceJVMPreparedPrograms.get(normalizedProgramId);
  if (!prepared) {
    throw new Error(`Unknown TraceJVM prepared program: ${normalizedProgramId}`);
  }
  if (prepared.retired) {
    throw new Error(
      `TraceJVM prepared program requires hard Worker retirement: ${normalizedProgramId}`
    );
  }

  const [client, helperJar] = await Promise.all([
    getTraceJVMClient(),
    loadTraceJVMHelperJar(),
  ]);
  const systemProperties = JSON.parse(String(preparedInputProperties));
  if (
    !systemProperties ||
    typeof systemProperties !== 'object' ||
    Array.isArray(systemProperties) ||
    Object.values(systemProperties).some((value) => typeof value !== 'string')
  ) {
    throw new TypeError(
      'TraceJVM prepared inputs must be string system properties.'
    );
  }
  const run = await runInFreshTraceJVMProcess(client, {
    program: prepared.program,
    classpath: [helperJar],
    systemProperties,
    mainClass: 'tracecode.browser.TraceExecutionRunner',
    args: [
      String(entryClass),
      String(Number.parseInt(String(maxStoredEvents), 10) || 1),
      String(learnerFrame),
    ],
  }, normalizedProgramId);
  prepared.executions += 1;
  const report = executionReport(
    run,
    {
      stdout: prepared.compilerStdout,
      stderr: prepared.compilerStderr,
      timings: { totalMs: prepared.compileTimeMs },
    },
    prepared.compilerDebugProfile,
    true
  );
  return JSON.stringify({
    ...report,
    preparedExecutionCount: prepared.executions,
    preparedCompileCount: traceJVMPreparedCompileCount,
  });
}

async function traceJVMRunPreparedRuntimeProgramBatch(
  programId,
  entryClass,
  maxStoredEvents = '1',
  preparedInputPropertiesBatch = '[]',
  perCaseWallClockMs = '0',
  learnerFrame = ''
) {
  const normalizedProgramId = String(programId);
  const prepared = traceJVMPreparedPrograms.get(normalizedProgramId);
  if (!prepared) {
    throw new Error(`Unknown TraceJVM prepared program: ${normalizedProgramId}`);
  }
  if (prepared.retired) {
    throw new Error(
      `TraceJVM prepared program requires hard Worker retirement: ${normalizedProgramId}`
    );
  }

  const [client, helperJar] = await Promise.all([
    getTraceJVMClient(),
    loadTraceJVMHelperJar(),
  ]);
  const systemPropertiesBatch = JSON.parse(
    String(preparedInputPropertiesBatch)
  );
  if (
    !Array.isArray(systemPropertiesBatch) ||
    systemPropertiesBatch.length === 0 ||
    systemPropertiesBatch.some(
      (properties) =>
        !properties ||
        typeof properties !== 'object' ||
        Array.isArray(properties) ||
        Object.values(properties).some((value) => typeof value !== 'string')
    )
  ) {
    throw new TypeError(
      'TraceJVM prepared batch inputs must be a non-empty array of string system-property maps.'
    );
  }
  let localAuthority;
  if (!traceJVMProcessHost(normalizedProgramId).kernelBound) {
    localAuthority = await createLocalTraceKernelAuthority();
    traceJVMLocalKernelAuthorities.set(normalizedProgramId, localAuthority);
  }
  let batch;
  try {
    batch = await runInLeasedTraceJVMBatchProcess(
      client,
      {
        program: prepared.program,
        classpath: [helperJar],
        mainClass: 'tracecode.browser.TraceExecutionRunner',
        args: [
          String(entryClass),
          String(Number.parseInt(String(maxStoredEvents), 10) || 1),
          String(learnerFrame),
        ],
      },
      systemPropertiesBatch,
      normalizedProgramId,
      Number.parseInt(String(perCaseWallClockMs), 10) || 0
    );
  } finally {
    if (localAuthority) {
      traceJVMLocalKernelAuthorities.delete(normalizedProgramId);
      await localAuthority.close();
    }
  }
  prepared.executions += batch.results.length;
  const reports = batch.results.map((run) =>
    executionReport(
      run,
      {
        stdout: prepared.compilerStdout,
        stderr: prepared.compilerStderr,
        timings: { totalMs: prepared.compileTimeMs },
      },
      prepared.compilerDebugProfile,
      true
    )
  );
  return JSON.stringify({
    success: reports.every((report) => report.success),
    results: reports,
    runnerProcessCount: batch.processCount,
    preparedExecutionCount: prepared.executions,
    preparedCompileCount: traceJVMPreparedCompileCount,
  });
}

function traceJVMDisposeRuntimeProgram(programId) {
  return traceJVMPreparedPrograms.delete(String(programId));
}

function serializeTraceJVMPreparedProgram(program) {
  return {
    schema: 'tracecode.java.tracejvm-prepared-program.v1',
    files: program.files.map((file) => ({
      path: file.path,
      contentBase64: bytesToBase64(file.content),
    })),
  };
}

function deserializeTraceJVMPreparedProgram(value) {
  if (
    !value ||
    value.schema !== 'tracecode.java.tracejvm-prepared-program.v1' ||
    !Array.isArray(value.files)
  ) {
    throw new TypeError('Invalid TraceJVM prepared program artifact.');
  }
  return {
    files: value.files.map((file) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        typeof file.contentBase64 !== 'string'
      ) {
        throw new TypeError('Invalid TraceJVM prepared class artifact.');
      }
      return {
        path: file.path,
        content: base64ToBytes(file.contentBase64),
      };
    }),
  };
}

function traceJVMRestoreRuntimeProgram(
  programId,
  serializedProgram,
  compilerDebugProfile
) {
  const normalizedProgramId = String(programId);
  if (!normalizedProgramId) {
    throw new TypeError('TraceJVM restored programs require a non-empty id.');
  }
  if (traceJVMPreparedPrograms.has(normalizedProgramId)) {
    throw new Error(`TraceJVM prepared program already exists: ${normalizedProgramId}`);
  }
  const artifact =
    typeof serializedProgram === 'string'
      ? JSON.parse(serializedProgram)
      : serializedProgram;
  traceJVMPreparedPrograms.set(normalizedProgramId, {
    program: deserializeTraceJVMPreparedProgram(artifact),
    compilerDebugProfile: String(compilerDebugProfile),
    compilerStdout: '',
    compilerStderr: '',
    compileTimeMs: 0,
    compileCacheHit: true,
    executions: 0,
    retired: false,
  });
  return true;
}

self.cheerpjInit = async () => {
  const [client] = await Promise.all([
    getTraceJVMClient(),
    loadLocalTraceKernelModule(),
  ]);
  await client.initialize();
};

self.cheerpOSAddStringFile = async (path, source) => {
  traceJVMStringFiles.set(String(path), String(source));
};

self.cheerpjRunLibrary = async () => ({
  harness: {
    browser: {
      JavaRewriteLibrary: {
        rewriteSource: traceJVMRewriteSource,
      },
    },
  },
  tracecode: {
    browser: {
      BrowserCompileAndTraceLibrary: {
        compileAndRun: traceJVMCompileAndRun,
        compileAndTrace: traceJVMCompileAndTrace,
        compileAndRunBatch: traceJVMCompileAndRunBatch,
        prepareRuntimeProgram: traceJVMPrepareRuntimeProgram,
        runPreparedRuntimeProgram: traceJVMRunPreparedRuntimeProgram,
        runPreparedRuntimeProgramBatch:
          traceJVMRunPreparedRuntimeProgramBatch,
        restoreRuntimeProgram: traceJVMRestoreRuntimeProgram,
        disposeRuntimeProgram: traceJVMDisposeRuntimeProgram,
        resetPersistentRuntimeStorage() {
          traceJVMStringFiles.clear();
        },
        deleteRuntimeRequestTree() {},
        restoreCompileCache() {
          return false;
        },
        commitCompileCache() {
          return false;
        },
        exportCompiledClassManifest() {
          return '';
        },
      },
    },
  },
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (
    message?.type === 'kernel-execution-scope-reset-complete' ||
    message?.type === 'kernel-execution-scope-reset-failed'
  ) {
    const requestId = String(message.payload?.requestId ?? '');
    const pending =
      traceJVMPendingExecutionScopeResets.get(requestId);
    if (
      !pending ||
      pending.protocolToken !== message.protocolToken
    ) {
      return;
    }
    event.stopImmediatePropagation();
    traceJVMPendingExecutionScopeResets.delete(requestId);
    if (message.type === 'kernel-execution-scope-reset-complete') {
      pending.resolve();
    } else {
      pending.reject(
        new Error(
          message.payload?.error ??
            'TraceKernel execution-scope reset failed.'
        )
      );
    }
    return;
  }
  if (
    !message?.kernelSyscallChannel ||
    !message.id
  ) {
    return;
  }
  const kernelRequest = {
    id: message.id,
    protocolToken: message.protocolToken,
    channel: message.kernelSyscallChannel,
  };
  traceJVMKernelChannels.set(String(message.id), kernelRequest);
  if (message.payload?.programId) {
    traceJVMKernelChannels.set(String(message.payload.programId), kernelRequest);
  }
});

self.TraceCodeReleaseKernelRequest = (requestId, programId) => {
  const request = traceJVMKernelChannels.get(String(requestId));
  request?.client?.close();
  traceJVMKernelChannels.delete(String(requestId));
  if (
    programId &&
    traceJVMKernelChannels.get(String(programId)) === request
  ) {
    traceJVMKernelChannels.delete(String(programId));
  }
};

const traceJVMLegacyClose = self.close.bind(self);
self.close = () => {
  invalidateTraceJVMClient();
  for (const pending of traceJVMPendingExecutionScopeResets.values()) {
    pending.reject(
      new Error('Java worker closed during TraceKernel execution-scope reset.')
    );
  }
  traceJVMPendingExecutionScopeResets.clear();
  traceJVMStringFiles.clear();
  traceJVMCompileCache.clear();
  traceJVMPreparedPrograms.clear();
  traceJVMLegacyClose();
};

self.importScripts(
  TRACEKERNEL_SYSCALL_CLIENT_URL.href,
  CLASSIC_JAVA_WORKER_URL.href
);
