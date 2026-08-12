const startedAt = performance.now();
const { dotnet } = await import('./_framework/dotnet.js');
const runtime = await dotnet.create();
const exports = await runtime.getAssemblyExports(
  runtime.getConfig().mainAssemblyName
);
self.postMessage({ type: 'ready' });

function resolveCallStackRefs(events) {
  const definitions = new Map();
  return events.map((event) => {
    if (typeof event?.callStackId === 'number') {
      if (event.callStack) {
        definitions.set(event.callStackId, structuredClone(event.callStack));
      }
      const { callStackId, ...rest } = event;
      return rest;
    }
    if (typeof event?.callStackRef === 'number') {
      const callStack = definitions.get(event.callStackRef);
      if (callStack === undefined) {
        throw new Error(
          `TraceCLR event references undefined callStackRef ${event.callStackRef}`
        );
      }
      const { callStackRef, ...rest } = event;
      return { ...rest, callStack: structuredClone(callStack) };
    }
    return event;
  });
}

self.onmessage = (event) => {
  try {
    const artifact = Uint8Array.from(
      atob(event.data.artifactBase64),
      (value) => value.charCodeAt(0)
    );
    const input = Uint8Array.from(
      atob(event.data.inputBase64),
      (value) => value.charCodeAt(0)
    );
    if (event.data.mode === 'trace') {
      const response = JSON.parse(
        exports.TraceCode.CSharpAlgorithmRunner.Program.ExecutePreparedTrace(
          event.data.artifactBase64,
          event.data.artifactSha256,
          input,
          event.data.source,
          event.data.timeoutMs,
          event.data.maxTraceSteps,
          event.data.maxLineEvents,
          event.data.maxSingleLineHits,
          event.data.maxStoredEvents,
          event.data.minimalTrace,
          event.data.recordTrace
        )
      );
      self.postMessage({
        type: 'result',
        ...response,
        events: resolveCallStackRefs(response.events),
        output: Uint8Array.from(
          atob(response.outputBytes),
          (value) => value.charCodeAt(0)
        ),
        elapsedMs: performance.now() - startedAt,
      });
      return;
    }
    const output = exports.TraceCode.CSharpAlgorithmRunner.Program.Execute(
      artifact,
      input
    );
    self.postMessage({
      type: 'result',
      success: true,
      output,
      elapsedMs: performance.now() - startedAt,
    });
  } catch (error) {
    self.postMessage({
      type: 'result',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
