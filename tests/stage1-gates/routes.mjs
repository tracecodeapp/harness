// These imports resolve from the frozen source tree in the separate companion
// build. The default matrix imports only the installed public export.
import { createBrowserRuntimeHost, createBrowserRuntimeProviderRegistry } from './packages/runtime-browser/src/index.ts';
import { createBrowserJudgeHostFromRuntimeHost } from './src/internal/browser-judge.ts';
import { createJavaScriptBrowserRuntimeProvider } from './packages/runtime-javascript/src/browser-runtime-provider.ts';
import { createBrowserRuntimeHost as createDefaultRuntimeHost } from './src/browser.ts';
import { CppWorkerClient } from './packages/runtime-cpp/src/cpp-worker-client.ts';
import { createTraceCCBrowserCompilerService } from './packages/runtime-cpp/src/browser-runtime-provider.ts';

export function createJavaScriptRouteHost(language, algorithmExecution) {
  return createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    assetBaseUrl: location.origin + '/workers',
    providers: [language],
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider({ algorithmExecution }),
    ]),
    safeExecution: { workerLifecycle: 'warm-and-retire' },
  }));
}

export async function runCppDirect(fixture, batch) {
  const runtime = createDefaultRuntimeHost({ assetBaseUrl: location.origin + '/workers', providers: ['cpp'] });
  const assets = runtime.assets;
  const compiler = createTraceCCBrowserCompilerService({}, { assets });
  const client = new CppWorkerClient({
    workerUrl: assets.cppWorker,
    compilerWasmUrl: assets.cppCompilerWasm,
    linkerWasmUrl: assets.cppLinkerWasm,
    sysrootUrl: assets.cppSysroot,
    runtimeHeaderUrl: assets.cppRuntimeHeader,
    compilerIntegrity: assets.cppCompilerIntegrity,
    trustedCompilerService: compiler,
  });
  const source = {
    code: fixture.code, functionName: fixture.functionName, executionStyle: fixture.executionStyle,
    limits: fixture.limits,
  };
  try {
    const inputBatch = fixture.cases.map(({ input }) => structuredClone(input));
    if (batch) return (await client.executeCodeBatch({ ...source, inputBatch })).results;
    const results = [];
    for (const inputs of inputBatch) results.push(await client.executeCode({ ...source, inputs }));
    return results;
  } finally {
    client.terminate();
    compiler.terminate();
    runtime.dispose();
  }
}
