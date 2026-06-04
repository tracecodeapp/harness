import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export interface CppConformanceIsolatedRunOptions {
  includeGeneratedSource?: boolean;
  timeoutMs?: number;
}

const CPP_CONFORMANCE_CHILD_ARG = '--__tracecode-cpp-conformance-child';
const CPP_CONFORMANCE_CHILD_RESULT_PREFIX = '__TRACECODE_CPP_CONFORMANCE_RESULT__';
const DEFAULT_CPP_CONFORMANCE_FIXTURE_TIMEOUT_MS = 15_000;

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

function expectedCppFixtureOutput(fixture: CppConformanceFixture): unknown {
  return fixture.expectedHarnessOutput ?? fixture.expectedReturn;
}

function failedIsolatedCppConformanceResult(
  fixture: CppConformanceFixture,
  error: string,
  phase: CppConformanceRunResult['phase'] = 'untraced'
): CppConformanceRunResult {
  return {
    success: false,
    expectedOutput: expectedCppFixtureOutput(fixture),
    phase,
    error,
  };
}

function appendBoundedOutput(current: string, chunk: Buffer, maxBytes: number): string {
  if (Buffer.byteLength(current) >= maxBytes) return current;
  const remaining = maxBytes - Buffer.byteLength(current);
  return `${current}${chunk.subarray(0, Math.max(0, remaining)).toString('utf8')}`;
}

export async function runCppConformanceFixtureInIsolatedProcess(
  fixture: CppConformanceFixture,
  options: CppConformanceIsolatedRunOptions = {}
): Promise<CppConformanceRunResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(Number(options.timeoutMs)))
    : DEFAULT_CPP_CONFORMANCE_FIXTURE_TIMEOUT_MS;
  const modulePath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, modulePath, CPP_CONFORMANCE_CHILD_ARG], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const maxBufferedOutputBytes = 4 * 1024 * 1024;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBoundedOutput(stdout, chunk, maxBufferedOutputBytes);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedOutput(stderr, chunk, maxBufferedOutputBytes);
  });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(JSON.stringify({
    fixture,
    includeGeneratedSource: options.includeGeneratedSource === true,
  }));

  try {
    const { code, signal } = await closed;
    if (timedOut) {
      return failedIsolatedCppConformanceResult(
        fixture,
        `${fixture.id}: C++ conformance fixture timed out after ${timeoutMs}ms`
      );
    }
    const resultLine = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(CPP_CONFORMANCE_CHILD_RESULT_PREFIX));
    if (!resultLine) {
      return failedIsolatedCppConformanceResult(
        fixture,
        `${fixture.id}: isolated C++ conformance runner exited without a result` +
          (code === 0 ? '' : ` (exit=${code ?? 'null'} signal=${signal ?? 'null'})`) +
          (stderr ? `\n${stderr}` : '')
      );
    }
    return JSON.parse(resultLine.slice(CPP_CONFORMANCE_CHILD_RESULT_PREFIX.length)) as CppConformanceRunResult;
  } catch (error) {
    return failedIsolatedCppConformanceResult(
      fixture,
      `${fixture.id}: isolated C++ conformance runner failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readCppConformanceChildStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runCppConformanceChild(): Promise<void> {
  const payload = JSON.parse(await readCppConformanceChildStdin()) as {
    fixture: CppConformanceFixture;
    includeGeneratedSource?: boolean;
  };
  const bridge = await createInitializedCppConformanceBridge();
  const result = await runCppConformanceFixture(bridge, payload.fixture, {
    includeGeneratedSource: payload.includeGeneratedSource === true,
  });
  process.stdout.write(`${CPP_CONFORMANCE_CHILD_RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

if (process.argv.includes(CPP_CONFORMANCE_CHILD_ARG)) {
  runCppConformanceChild().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
