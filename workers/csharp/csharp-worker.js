let runtimePromise = null;
let executeExport = null;

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

async function handleMessage(message) {
  if (message.type === 'init') {
    return initRuntime(message.payload?.assetBaseUrl);
  }

  if (message.type === 'execute-code' || message.type === 'execute-with-tracing') {
    await initRuntime(message.payload?.assetBaseUrl);
    const request = {
      source: message.payload?.code ?? '',
      functionName: message.payload?.functionName ?? '',
      inputs: message.payload?.inputs ?? {},
      executionStyle: message.payload?.executionStyle ?? 'solution-method',
      trace: message.type === 'execute-with-tracing',
      timeoutMs: message.payload?.timeoutMs,
      maxTraceSteps: message.payload?.maxTraceSteps,
    };
    return JSON.parse(executeExport(JSON.stringify(request)));
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
