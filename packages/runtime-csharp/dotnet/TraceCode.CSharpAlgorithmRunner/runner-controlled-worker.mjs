const { dotnet } = await import('./_framework/dotnet.js');
const runtime = await dotnet.create();
const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
const runner = exports.TraceCode.CSharpAlgorithmRunner.Program;
const learnerAssembly = new Uint8Array(
  await fetch('./TraceCode.TraceClrHostileProbe.dll').then((response) => {
    if (!response.ok) throw new Error(`Learner artifact HTTP ${response.status}`);
    return response.arrayBuffer();
  })
);

postMessage({
  type: 'ready',
  wasmHeapBytes: runtime.Module?.HEAPU8?.buffer?.byteLength ?? null,
});

addEventListener('message', (event) => {
  if (event.data?.type !== 'execute') return;
  postMessage({ type: 'started', mode: event.data.mode });
  const output = runner.Execute(learnerAssembly, new Uint8Array([event.data.mode]));
  postMessage({ type: 'result', output: Array.from(output) });
});
