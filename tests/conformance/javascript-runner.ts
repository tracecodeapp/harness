import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

export interface JavaScriptConformanceFixture {
  id: string;
  title: string;
  entryStyle: string;
  methodName: string;
  source: string;
  input: Record<string, unknown>;
  expectedReturn: unknown;
  expectedMutations: Record<string, unknown>;
  expectedHarnessOutput?: unknown;
  coverage: string[];
  notes: string;
}

export interface JavaScriptExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  errorLine?: number;
  consoleOutput?: string[];
  trace?: { events?: unknown[]; lineEventCount?: number; traceStepCount?: number };
  lineEventCount?: number;
  traceStepCount?: number;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

export interface JavaScriptBridge {
  sendMessage<T>(type: string, payload?: unknown): Promise<T>;
}

export interface JavaScriptConformanceRunResult {
  success: boolean;
  expectedOutput: unknown;
  untraced?: JavaScriptExecutionResult;
  traced?: JavaScriptExecutionResult;
  phase?: 'untraced' | 'traced';
  error?: string;
}

const UNDEFINED_SENTINEL = '**undefined**';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface WorkerSelfObject {
  location: { search: string };
  postMessage: (message: WorkerMessage) => void;
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  ts?: unknown;
}

function normalizeForJson(value: unknown): unknown {
  if (value === undefined) return { __tracecodeUndefined: true };
  if (value === UNDEFINED_SENTINEL) return { __tracecodeUndefined: true };
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeForJson(child)])
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function loadJavaScriptLibrariesIntoContext(context: vm.Context): void {
  const vendorPath = join(process.cwd(), 'workers', 'vendor', 'javascript-libraries.js');
  vm.runInContext(readFileSync(vendorPath, 'utf8'), context, {
    filename: 'javascript-libraries.js',
  });
}

export async function createInitializedJavaScriptConformanceBridge(language: 'javascript' | 'typescript'): Promise<JavaScriptBridge> {
  const workerSource = await readFile(join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js'), 'utf8');
  const pending = new Map<
    string,
    { protocolToken: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  let ready = false;
  let nextId = 0;

  const selfObject: WorkerSelfObject = {
    location: { search: '' },
    postMessage: (message: WorkerMessage) => {
      if (message.type === 'worker-ready') {
        ready = true;
        return;
      }
      const id = message.id;
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      if (message.protocolToken !== entry.protocolToken) return;
      pending.delete(id);
      clearTimeout(entry.timeout);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
    onmessage: null,
    ts,
  };

  const context = vm.createContext({
    console,
    self: selfObject,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
  });

  (context as Record<string, unknown>).importScripts = (...urls: string[]) => {
    for (const url of urls) {
      if (String(url).includes('javascript-libraries.js')) {
        loadJavaScriptLibrariesIntoContext(context);
      } else if (String(url).includes('typescript')) {
        selfObject.ts = ts;
      } else {
        throw new Error(`Unexpected importScripts URL in JavaScript conformance test: ${url}`);
      }
    }
  };

  vm.runInContext(workerSource, context, { filename: 'javascript-worker.js' });
  const onmessage = selfObject.onmessage;
  if (typeof onmessage !== 'function') throw new Error('JavaScript worker did not register onmessage handler.');
  if (!ready) throw new Error('JavaScript worker did not emit worker-ready.');

  async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    const protocolToken = `javascript-conformance-token-${id}`;
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(new Error(`Timed out waiting for response: ${type}`));
      }, 10_000);
      pending.set(id, { protocolToken, resolve: resolve as (value: unknown) => void, reject, timeout });
    });

    onmessage?.({ data: { id, type, payload, protocolToken } });
    return responsePromise;
  }

  const init = await sendMessage<{ success: boolean; error?: string }>('init');
  if (!init.success) throw new Error(`JavaScript runtime init failed: ${init.error ?? 'unknown error'}`);
  const warmup = await sendMessage<{ success: boolean; error?: string }>('warmup', { language });
  if (!warmup.success) throw new Error(`JavaScript runtime warmup failed: ${warmup.error ?? 'unknown error'}`);
  return { sendMessage };
}

export function javascriptExecutionStyleFor(entryStyle: string): 'function' | 'solution-method' {
  if (entryStyle === 'top_level_function' || entryStyle === 'module_function' || entryStyle === 'stdin_program') return 'function';
  return 'solution-method';
}

export async function runJavaScriptConformanceFixture(
  bridge: JavaScriptBridge,
  fixture: JavaScriptConformanceFixture,
  language: 'javascript' | 'typescript'
): Promise<JavaScriptConformanceRunResult> {
  const expectedOutput = fixture.expectedHarnessOutput ?? fixture.expectedReturn;
  const payload = {
    code: fixture.source,
    functionName: fixture.entryStyle === 'stdin_program' ? '' : fixture.methodName,
    inputs: fixture.input,
    executionStyle: javascriptExecutionStyleFor(fixture.entryStyle),
    language,
  };

  const untraced = await bridge.sendMessage<JavaScriptExecutionResult>('execute-code', payload);
  let phase: JavaScriptConformanceRunResult['phase'];
  let error: string | undefined;
  if (!untraced.success) {
    phase = 'untraced';
    error = `${fixture.id}: untraced execution failed: ${untraced.error || JSON.stringify(untraced)}`;
  } else if (!jsonEqual(untraced.output, expectedOutput)) {
    phase = 'untraced';
    error = `${fixture.id}: untraced output mismatch\nExpected: ${stableStringify(expectedOutput)}\nReceived: ${stableStringify(untraced.output)}`;
  }

  const traced = await bridge.sendMessage<JavaScriptExecutionResult>('execute-with-tracing', payload);
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
