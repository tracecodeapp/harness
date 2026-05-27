import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

import type { CppConformanceFixture } from './cpp-fixtures';

export interface CppExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  diagnosticStage?: string;
  generatedSource?: string;
  consoleOutput?: string[];
  trace?: { events?: unknown[]; lineEventCount?: number; traceStepCount?: number };
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

export interface CppBridge {
  handleInit(payload: unknown): Promise<unknown>;
  handleWarmup(payload: unknown): Promise<CppExecutionResult>;
  handleCompileRun(payload: unknown): Promise<CppExecutionResult>;
  handleExecuteWithTracing(payload: unknown): Promise<CppExecutionResult>;
}

export interface CppConformanceRunResult {
  success: boolean;
  expectedOutput: unknown;
  untraced?: CppExecutionResult;
  traced?: CppExecutionResult;
  phase?: 'untraced' | 'traced' | 'mutation';
  error?: string;
}

export function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeJson(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nExpected: ${expectedJson}\nReceived: ${actualJson}`);
  }
}

export async function loadCppConformanceBridge(): Promise<CppBridge> {
  const compilerBundle = await import(pathToFileURL(`${process.cwd()}/node_modules/@yowasp/clang/gen/bundle.js`).href);
  const sharedKernelPolicySource = (await readFile('workers/shared/runtime-kernel-policy.js', 'utf8'))
    .replace(/\bexport\s+/g, '');
  const workerSource = (await readFile('workers/cpp/cpp-worker.js', 'utf8')).replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/shared\/runtime-kernel-policy\.js['"];\s*/,
    ''
  );

  const readAsset = async (url: string | URL) => {
    const pathname = String(url).replace('file://', '');
    const data = await readFile(pathname);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      text: async () => data.toString('utf8'),
    };
  };

  const sandbox: Record<string, unknown> = {
    console,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Date,
    performance,
    Uint8Array,
    BigInt,
    Map,
    Set,
    Error,
    JSON,
    Object,
    String,
    Number,
    Math,
    RegExp,
    Promise,
    globalThis: null,
    self: null,
    postMessage() {},
    fetch: readAsset,
    crypto: globalThis.crypto,
    __tracecodeCppCompilerBundle: compilerBundle,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const script = new vm.Script(
    sharedKernelPolicySource + '\n' +
      'const isRuntimeDeviceDirectory = isRuntimeKernelDeviceDirectory;\n' +
      'const isRuntimeDeviceNamespacePath = isRuntimeKernelDeviceNamespacePath;\n' +
      'const isRuntimeProcPath = isRuntimeKernelProcPath;\n' +
      workerSource +
      '\nglobalThis.__tracecodeCppConformance = { handleInit, handleWarmup, handleCompileRun, handleExecuteWithTracing };',
    {
      importModuleDynamically(specifier) {
        return import(specifier);
      },
    }
  );
  await script.runInContext(context);

  const bridge = sandbox.__tracecodeCppConformance;
  if (!bridge || typeof bridge !== 'object') {
    throw new Error('C++ conformance bridge was not initialized.');
  }
  return bridge as CppBridge;
}

export async function initCppConformanceBridge(bridge: CppBridge): Promise<void> {
  await bridge.handleInit({
    assets: {
      compilerBundleUrl: pathToFileURL(`${process.cwd()}/node_modules/@yowasp/clang/gen/bundle.js`).href,
      clangWasmUrl: 'file:///missing/clang.wasm',
      lldWasmUrl: 'file:///missing/lld.wasm',
      sysrootUrl: 'file:///missing/sysroot.tar',
      runtimeHeaderUrl: `file://${process.cwd()}/workers/cpp/tracecode_runtime.hpp`,
    },
  });
  const warmup = await bridge.handleWarmup({});
  if (!warmup.success) {
    throw new Error(`C++ conformance warmup failed: ${warmup.error || JSON.stringify(warmup)}`);
  }
}

export async function createInitializedCppConformanceBridge(): Promise<CppBridge> {
  const bridge = await loadCppConformanceBridge();
  await initCppConformanceBridge(bridge);
  return bridge;
}

export async function runCppConformanceFixture(
  bridge: CppBridge,
  fixture: CppConformanceFixture,
  options: { includeGeneratedSource?: boolean } = {}
): Promise<CppConformanceRunResult> {
  const expectedOutput = fixture.expectedHarnessOutput ?? fixture.expectedReturn;
  const mutationKeys = Object.keys(fixture.expectedMutations);
  const untraced = await bridge.handleCompileRun({
    name: fixture.id,
    code: fixture.source,
    functionName: fixture.methodName,
    inputs: fixture.input,
  });

  let phase: CppConformanceRunResult['phase'];
  let error: string | undefined;
  if (!untraced.success) {
    phase = 'untraced';
    error = `${fixture.id}: untraced execution failed: ${untraced.error || JSON.stringify(untraced)}`;
  } else if (!jsonEqual(untraced.output, expectedOutput)) {
    phase = 'untraced';
    error = `${fixture.id}: untraced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(untraced.output)}`;
  }

  const traced = await bridge.handleExecuteWithTracing({
    name: fixture.id,
    code: fixture.source,
    functionName: fixture.methodName,
    inputs: fixture.input,
    options: options.includeGeneratedSource ? { includeGeneratedSource: true } : {},
  });

  if (!error) {
    if (!traced.success) {
      phase = 'traced';
      error = `${fixture.id}: traced execution failed: ${traced.error || JSON.stringify(traced)}`;
    } else if (!jsonEqual(traced.output, untraced.output)) {
      phase = 'traced';
      error = `${fixture.id}: traced output drifted from untraced output\nUntraced: ${stableStringify(untraced.output)}\nTraced: ${stableStringify(traced.output)}`;
    } else if (!jsonEqual(traced.output, expectedOutput)) {
      phase = 'traced';
      error = `${fixture.id}: traced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(traced.output)}`;
    } else if (fixture.expectedHarnessOutput !== undefined && mutationKeys.length > 0 && !jsonEqual(traced.output, fixture.expectedMutations[mutationKeys[0]])) {
      phase = 'mutation';
      error = `${fixture.id}: void mutation output mismatch\nExpected: ${stableStringify(fixture.expectedMutations[mutationKeys[0]])}\nReceived: ${stableStringify(traced.output)}`;
    }
  }

  return {
    success: !error,
    expectedOutput,
    untraced,
    traced,
    ...(phase ? { phase } : {}),
    ...(error ? { error } : {}),
  };
}
