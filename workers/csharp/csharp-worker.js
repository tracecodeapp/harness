let runtimePromise = null;
let executeExport = null;
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';
const IDLE_TIMEOUT_MS = 90_000;
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
let queuedTasks = 0;

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
  }, IDLE_TIMEOUT_MS);
}

function resolveAssetUrl(assetBaseUrl, pathname) {
  const normalizedBase = String(assetBaseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

function runWarmup() {
  const startedAt = now();
  const result = JSON.parse(executeExport(JSON.stringify(CSHARP_WARMUP_REQUEST)));
  if (!result?.success) {
    throw new Error(result?.error || 'C# runtime warmup failed.');
  }
  return elapsedMs(startedAt);
}

async function initRuntime(assetBaseUrl) {
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
      const { dotnet } = await import(resolveAssetUrl(assetBaseUrl, '_framework/dotnet.js'));
      const runtime = await dotnet.withApplicationArguments('tracecode-csharp-worker').create();
      const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
      executeExport = exports?.TraceCode?.CSharpHost?.CompilerHost?.Execute;
      if (typeof executeExport !== 'function') {
        throw new Error('Unable to resolve TraceCode.CSharpHost.CompilerHost.Execute JS export');
      }
      const initMs = elapsedMs(startedAt);
      const warmupMs = runWarmup();
      const totalMs = elapsedMs(startedAt);
      return {
        success: true,
        loadTimeMs: totalMs,
        timings: { totalMs, initMs, warmupMs },
      };
    })();
  }

  return runtimePromise;
}

function normalizeCSharpFile(file) {
  if (typeof file !== 'string') return file;
  return file.endsWith(CSHARP_LEGACY_USER_FILE)
    ? file.slice(0, -CSHARP_LEGACY_USER_FILE.length) + CSHARP_DEFAULT_FILE
    : file;
}

function normalizeCSharpResult(result) {
  if (!result || typeof result !== 'object') return result;
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
    ...(Array.isArray(result.events)
      ? {
          events: result.events.map((event) => {
            const normalizedFile = normalizeCSharpFile(event.file);
            return normalizedFile === undefined ? { ...event } : { ...event, file: normalizedFile };
          }),
        }
      : {}),
  };
}

async function handleMessage(message) {
  if (message.type === 'init') {
    return initRuntime(message.payload?.assetBaseUrl);
  }

  if (
    message.type === 'execute-code' ||
    message.type === 'execute-code-interview' ||
    message.type === 'execute-with-tracing'
  ) {
    const startedAt = now();
    await initRuntime(message.payload?.assetBaseUrl);
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
        hostCallMs,
        totalMs: elapsedMs(startedAt),
      },
    };
  }

  throw new Error(`Unsupported C# worker message type "${message.type}"`);
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;
  clearIdleTimer();
  queuedTasks += 1;

  queue = queue
    .catch(() => {})
    .then(async () => {
      const result = await handleMessage({ type, payload });
      self.postMessage({ id, type, payload: result });
    })
    .catch((error) => {
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
};

self.postMessage({ type: 'worker-ready' });
