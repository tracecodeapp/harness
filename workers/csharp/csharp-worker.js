let runtimePromise = null;
let warmupPromise = null;
let executeExport = null;
let configuredAssetBaseUrl = null;
const WORKER_DEBUG = (() => {
  try {
    return typeof self !== 'undefined' && typeof self.location?.search === 'string' && self.location.search.includes('dev=');
  } catch {
    return false;
  }
})();
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const CSHARP_WARMUP_REQUEST = Object.freeze({
  source: 'public class Solution { public int Add(int a, int b) { return a + b; } }',
  functionName: 'Add',
  inputs: { a: 1, b: 2 },
  executionStyle: 'solution-method',
  trace: false,
  timeoutMs: 1_000,
});

let queue = Promise.resolve();
let idleTimer = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let queuedTasks = 0;

function emitRuntimeDiagnostic(level, phase, message, detail) {
  if (!WORKER_DEBUG && level !== 'error') return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info';
  console[method]('[TraceRuntime]', {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    component: 'CSharpWorker',
    runtime: 'csharp',
    phase,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(now() - startedAt));
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    self.postMessage({ type: 'idle-timeout' });
    self.close();
  }, idleTimeoutMs);
}

function applyWorkerOptions(payload) {
  const requestedIdleTimeoutMs = Number(payload?.idleTimeoutMs);
  if (Number.isFinite(requestedIdleTimeoutMs) && requestedIdleTimeoutMs >= 1_000) {
    idleTimeoutMs = Math.round(requestedIdleTimeoutMs);
  }
}

function resolveAssetUrl(assetBaseUrl, pathname) {
  const normalizedBase = String(assetBaseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function configureAssetBaseUrl(assetBaseUrl) {
  if (typeof assetBaseUrl === 'string' && assetBaseUrl.trim()) {
    if (!configuredAssetBaseUrl || (!executeExport && !runtimePromise)) {
      configuredAssetBaseUrl = assetBaseUrl;
    }
  }
  return configuredAssetBaseUrl || assetBaseUrl;
}

function runWarmup() {
  const startedAt = now();
  const result = JSON.parse(executeExport(JSON.stringify(CSHARP_WARMUP_REQUEST)));
  if (!result?.success) {
    throw new Error(result?.error || 'C# runtime warmup failed.');
  }
  return elapsedMs(startedAt);
}

async function loadRuntime(assetBaseUrl) {
  const resolvedAssetBaseUrl = configureAssetBaseUrl(assetBaseUrl);
  if (executeExport) {
    return {
      success: true,
      loadTimeMs: 0,
      timings: { totalMs: 0, initMs: 0, warmupMs: 0 },
    };
  }

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const startedAt = now();
      const { dotnet } = await import(resolveAssetUrl(resolvedAssetBaseUrl, '_framework/dotnet.js'));
      const runtime = await dotnet.withApplicationArguments('tracecode-csharp-worker').create();
      const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
      executeExport = exports?.TraceCode?.CSharpHost?.CompilerHost?.Execute;
      if (typeof executeExport !== 'function') {
        throw new Error('Unable to resolve TraceCode.CSharpHost.CompilerHost.Execute JS export');
      }
      const initMs = elapsedMs(startedAt);
      const totalMs = elapsedMs(startedAt);
      return {
        success: true,
        loadTimeMs: totalMs,
        timings: { totalMs, initMs, warmupMs: 0 },
      };
    })();
    runtimePromise.catch(() => {
      runtimePromise = null;
      executeExport = null;
    });
  }

  return runtimePromise;
}

function handleInit(assetBaseUrl) {
  const startedAt = now();
  configureAssetBaseUrl(assetBaseUrl);
  const totalMs = elapsedMs(startedAt);
  return {
    success: true,
    loadTimeMs: totalMs,
    timings: { totalMs, initMs: 0, warmupMs: 0 },
  };
}

async function warmRuntime(assetBaseUrl) {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const startedAt = now();
      const runtimeStartedAt = now();
      const runtimeResult = await loadRuntime(assetBaseUrl);
      const initMs = elapsedMs(runtimeStartedAt);
      const warmupMs = runWarmup();
      const totalMs = elapsedMs(startedAt);
      return {
        success: true,
        loadTimeMs: totalMs,
        timings: {
          totalMs,
          initMs: initMs || runtimeResult.timings?.initMs || 0,
          warmupMs,
        },
      };
    })();
    warmupPromise.catch(() => {
      warmupPromise = null;
    });
  }

  return warmupPromise;
}

function normalizeCSharpFile(file) {
  if (typeof file !== 'string') return file;
  return file.endsWith(CSHARP_LEGACY_USER_FILE)
    ? file.slice(0, -CSHARP_LEGACY_USER_FILE.length) + CSHARP_DEFAULT_FILE
    : file;
}

function normalizeCSharpResult(result) {
  if (!result || typeof result !== 'object') return result;
  const normalizedEvents = Array.isArray(result.events)
    ? result.events.map((event) => {
        const normalizedFile = normalizeCSharpFile(event.file);
        return normalizedFile === undefined ? { ...event } : { ...event, file: normalizedFile };
      })
    : null;
  const normalizedTrace =
    result.trace && typeof result.trace === 'object' && Array.isArray(result.trace.events)
      ? {
          ...result.trace,
          events: result.trace.events.map((event) => {
            const normalizedFile = normalizeCSharpFile(event.file);
            return normalizedFile === undefined ? { ...event } : { ...event, file: normalizedFile };
          }),
        }
      : normalizedEvents
        ? {
            schemaVersion: result.schemaVersion,
            language: 'csharp',
            events: normalizedEvents,
            lineEventCount: result.lineEventCount,
            traceStepCount: result.traceStepCount,
          }
        : null;
  return {
    ...result,
    ...(Array.isArray(result.diagnostics)
      ? {
          diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            file: normalizeCSharpFile(diagnostic.file),
          })),
        }
      : {}),
    ...(normalizedEvents ? { events: normalizedEvents } : {}),
    ...(normalizedTrace ? { trace: normalizedTrace } : {}),
  };
}

async function handleMessage(message) {
  if (message.type === 'init') {
    return handleInit(message.payload?.assetBaseUrl);
  }

  if (message.type === 'warmup') {
    return warmRuntime(message.payload?.assetBaseUrl);
  }

  if (
    message.type === 'execute-code' ||
    message.type === 'execute-code-interview' ||
    message.type === 'execute-with-tracing'
  ) {
    const startedAt = now();
    const runtimeStartedAt = now();
    const runtimeResult = await loadRuntime(message.payload?.assetBaseUrl);
    const initMs = elapsedMs(runtimeStartedAt) || runtimeResult.timings?.initMs || 0;
    const request = {
      source: message.payload?.code ?? '',
      functionName: message.payload?.functionName ?? '',
      inputs: message.payload?.inputs ?? {},
      executionStyle: message.payload?.executionStyle ?? 'solution-method',
      trace: message.type === 'execute-with-tracing',
      timeoutMs: message.payload?.timeoutMs,
      maxTraceSteps: message.payload?.maxTraceSteps,
      maxLineEvents: message.payload?.maxLineEvents,
      maxSingleLineHits: message.payload?.maxSingleLineHits,
      maxStoredEvents: message.payload?.maxStoredEvents,
      minimalTrace: message.payload?.minimalTrace,
    };
    const hostCallStartedAt = now();
    const result = normalizeCSharpResult(JSON.parse(executeExport(JSON.stringify(request))));
    const hostCallMs = elapsedMs(hostCallStartedAt);
    return {
      ...result,
      timings: {
        ...(result?.timings && typeof result.timings === 'object' ? result.timings : {}),
        initMs,
        hostCallMs,
        totalMs: elapsedMs(startedAt),
      },
    };
  }

  throw new Error(`Unsupported C# worker message type "${message.type}"`);
}

// Keep globalThis.onmessage unset before dotnet.js loads; newer .NET worker bootstraps
// use that signal to enable sidecar mode.
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;
  clearIdleTimer();
  applyWorkerOptions(payload);
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      const result = await handleMessage({ type, payload });
      self.postMessage({ id, type, payload: result });
    })
    .catch((error) => {
      emitRuntimeDiagnostic('error', 'worker-request-failed', 'C# worker request failed.', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      self.postMessage({
        id,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    })
    .finally(() => {
      queuedTasks = Math.max(0, queuedTasks - 1);
      if (queuedTasks === 0) resetIdleTimer();
    });
});

emitRuntimeDiagnostic('info', 'worker-ready', 'C# worker is ready.');
self.postMessage({ type: 'worker-ready' });
