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
const TRACEJVM_BASE_URL = new URL(
  configuredTraceJVMBaseUrl || '/tracejvm/',
  self.location.href
);
const TRACEJVM_MODULE_URL = new URL('browser-client.js', TRACEJVM_BASE_URL);
const TRACEJVM_WORKER_URL = new URL('browser-worker.js', TRACEJVM_BASE_URL);
const TRACEJVM_WASM_URL = new URL('bjvm_main.wasm', TRACEJVM_BASE_URL);
const TRACEJVM_CORE_PROFILE_URL = new URL('profiles/core', TRACEJVM_BASE_URL);
const TRACEJVM_HELPER_JAR_URL = new URL('./vendor/java-browser-helper.jar', self.location.href);
const CLASSIC_JAVA_WORKER_URL = new URL('./java-worker.js', self.location.href);

const traceJVMStringFiles = new Map();
let traceJVMModulePromise;
let traceJVMClientPromise;
let traceJVMHelperJarPromise;
let traceJVMRewriteProgramPromise;
const traceJVMCompileCache = new Map();
const TRACEJVM_COMPILE_CACHE_LIMIT = 64;

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
  const { TraceJVMWorkerClient } = await loadTraceJVMModule();
  return new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: TRACEJVM_CORE_PROFILE_URL.href.replace(/\/+$/, ''),
        },
        wasmUrl: TRACEJVM_WASM_URL.href,
      },
      runtimeProfile: 'core',
      retirementAfterExecutions: 64,
    },
    createWorker: () => new Worker(TRACEJVM_WORKER_URL, {
      type: 'module',
    }),
  });
}

async function getTraceJVMClient() {
  traceJVMClientPromise ??= createTraceJVMClient();
  return traceJVMClientPromise;
}

function invalidateTraceJVMClient() {
  void traceJVMClientPromise
    ?.then((client) => client.terminate())
    .catch(() => undefined);
  traceJVMClientPromise = undefined;
  traceJVMRewriteProgramPromise = undefined;
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
  const result = await atStage('bridge execution', () => client.run({
    program,
    classpath: [helperJar],
    mainClass: 'tracecode.harness.bridge.TraceJVMRewriteBridge',
    args: encodedArguments,
  }));
  if (result.status !== 'completed' || result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
      `TraceJVM source rewrite ended with ${result.status}.`
    );
  }
  if (result.retirementRecommended) {
    invalidateTraceJVMClient();
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
  const run = await context.client.run({
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
  if (run.retirementRecommended) invalidateTraceJVMClient();
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
    const run = await context.client.run({
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
    if (run.retirementRecommended) invalidateTraceJVMClient();
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

self.cheerpjInit = async () => {
  const client = await getTraceJVMClient();
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

const traceJVMLegacyClose = self.close.bind(self);
self.close = () => {
  invalidateTraceJVMClient();
  traceJVMStringFiles.clear();
  traceJVMCompileCache.clear();
  traceJVMLegacyClose();
};

self.importScripts(CLASSIC_JAVA_WORKER_URL.href);
