let runtimePromise = null;
let executeExport = null;
const CSHARP_DEFAULT_FILE = 'solution.cs';
const CSHARP_LEGACY_USER_FILE = 'UserCode.cs';

function resolveAssetUrl(assetBaseUrl, pathname) {
  const normalizedBase = String(assetBaseUrl || '').replace(/\/+$/, '');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

async function initRuntime(assetBaseUrl) {
  if (executeExport) {
    return { success: true, loadTimeMs: 0 };
  }

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const startedAt = performance.now();
      const { dotnet } = await import(resolveAssetUrl(assetBaseUrl, '_framework/dotnet.js'));
      const runtime = await dotnet.withApplicationArguments('tracecode-csharp-worker').create();
      const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
      executeExport = exports?.TraceCode?.CSharpHost?.CompilerHost?.Execute;
      if (typeof executeExport !== 'function') {
        throw new Error('Unable to resolve TraceCode.CSharpHost.CompilerHost.Execute JS export');
      }
      return { success: true, loadTimeMs: Math.round(performance.now() - startedAt) };
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
    return normalizeCSharpResult(JSON.parse(executeExport(JSON.stringify(request))));
  }

  throw new Error(`Unsupported C# worker message type "${message.type}"`);
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  handleMessage({ type, payload })
    .then((result) => {
      self.postMessage({ id, type, payload: result });
    })
    .catch((error) => {
      self.postMessage({
        id,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    });
};

self.postMessage({ type: 'worker-ready' });
