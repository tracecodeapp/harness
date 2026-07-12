#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { JavaScriptWorkerClient } from '../packages/harness-browser/src/javascript-worker-client';

interface ProtocolMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface WorkerSelf {
  location: { search: string };
  postMessage: (message: ProtocolMessage) => void;
  onmessage: ((event: { data: ProtocolMessage }) => void) | null;
  ts?: unknown;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workerSource = readFileSync(
  join(process.cwd(), 'workers', 'javascript', 'javascript-worker.js'),
  'utf8'
);
const javascriptLibrariesSource = readFileSync(
  join(process.cwd(), 'workers', 'vendor', 'javascript-libraries.js'),
  'utf8'
);
const runtimeKernelPolicySource = readFileSync(
  join(process.cwd(), 'workers', 'shared', 'runtime-kernel-policy-classic.js'),
  'utf8'
);

class VmJavaScriptWorker {
  static readonly instances: VmJavaScriptWorker[] = [];
  static readonly typeScriptImports = new Map<string, number>();

  onmessage: ((event: MessageEvent<ProtocolMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly role: string;
  readonly postedTypes: string[] = [];
  terminated = false;
  private readonly workerSelf: WorkerSelf;
  private readonly context: vm.Context;

  constructor(readonly url: string | URL) {
    const parsedUrl = new URL(String(url), 'https://harness.test/');
    this.role = parsedUrl.searchParams.get('tracecodeRole') ?? 'legacy';
    VmJavaScriptWorker.instances.push(this);

    this.workerSelf = {
      location: { search: parsedUrl.search },
      postMessage: (message) => {
        queueMicrotask(() => {
          if (!this.terminated) {
            this.onmessage?.({ data: message } as MessageEvent<ProtocolMessage>);
          }
        });
      },
      onmessage: null,
    };

    const context = vm.createContext({
      console,
      self: this.workerSelf,
      performance: { now: () => performance.now() },
      setTimeout,
      clearTimeout,
    });
    this.context = context;
    (context as Record<string, unknown>).importScripts = (...urls: string[]) => {
      for (const importUrl of urls) {
        if (String(importUrl).includes('javascript-libraries.js')) {
          vm.runInContext(javascriptLibrariesSource, context, { filename: 'javascript-libraries.js' });
          continue;
        }
        if (String(importUrl).includes('runtime-kernel-policy-classic.js')) {
          vm.runInContext(runtimeKernelPolicySource, context, { filename: 'runtime-kernel-policy-classic.js' });
          continue;
        }
        if (String(importUrl).includes('typescript')) {
          VmJavaScriptWorker.typeScriptImports.set(
            this.role,
            (VmJavaScriptWorker.typeScriptImports.get(this.role) ?? 0) + 1
          );
          this.workerSelf.ts = ts;
          continue;
        }
        throw new Error(`Unexpected worker import in lifecycle test: ${importUrl}`);
      }
    };

    vm.runInContext(workerSource, context, { filename: 'javascript-worker.js' });
  }

  postMessage(message: ProtocolMessage): void {
    this.postedTypes.push(message.type);
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        this.workerSelf.onmessage?.({ data: message });
      } catch (error) {
        this.onerror?.({
          message: error instanceof Error ? error.message : String(error),
          filename: 'javascript-worker.js',
          lineno: 0,
          colno: 0,
        } as ErrorEvent);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  hasLifecyclePoison(): boolean {
    return Boolean(vm.runInContext('Array.prototype.__tracecodeLifecyclePoison', this.context));
  }
}

async function main(): Promise<void> {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: VmJavaScriptWorker,
  });

  try {
    const plainJavaScriptClient = new JavaScriptWorkerClient({
      workerUrl: '/workers/javascript/javascript-worker.js',
      debug: false,
    });
    const plainOnlyResult = await plainJavaScriptClient.executeCode(
      'function add(a, b) { return a + b; }',
      'add',
      { a: 2, b: 3 },
      'function',
      'javascript'
    );
    assertCondition(
      plainOnlyResult.success === true && plainOnlyResult.output === 5,
      `Plain-only JavaScript execution failed: ${JSON.stringify(plainOnlyResult)}`
    );
    const computedConstructorEscape = await plainJavaScriptClient.executeCode(
      `function escape() {
  const key = 'con' + 'structor';
  const scope = ({})[key][key]('return self')();
  return scope.fetch('https://escape.invalid/');
}`,
      'escape',
      {},
      'function',
      'javascript'
    );
    assertCondition(
      computedConstructorEscape.success === false &&
        computedConstructorEscape.error?.includes('EACCES') === true,
      `Computed Function-constructor escape should fail at the executor boundary: ${JSON.stringify(computedConstructorEscape)}`
    );
    assertCondition(
      VmJavaScriptWorker.instances.filter((worker) => worker.role === 'coordinator').length === 0,
      'Plain JavaScript execution should not create a compiler coordinator'
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('executor') ?? 0) === 0,
      'Plain JavaScript execution should not import TypeScript in its disposable worker'
    );
    plainJavaScriptClient.terminate();
    VmJavaScriptWorker.instances.length = 0;
    VmJavaScriptWorker.typeScriptImports.clear();

    const client = new JavaScriptWorkerClient({
      workerUrl: '/workers/javascript/javascript-worker.js',
      debug: false,
    });

    const poisonResult = await client.executeCode(
      `function poison(value: number) {
  (Array.prototype as any).__tracecodeLifecyclePoison = 7331;
  return value + 1;
}`,
      'poison',
      { value: 1 },
      'function',
      'typescript'
    );
    assertCondition(
      poisonResult.success === true && poisonResult.output === 2,
      `First prepared TypeScript execution failed: ${JSON.stringify(poisonResult)}`
    );
    const firstCoordinator = VmJavaScriptWorker.instances.find((worker) => worker.role === 'coordinator');
    const firstExecutor = VmJavaScriptWorker.instances.find((worker) => worker.role === 'executor');
    assertCondition(firstCoordinator && firstExecutor, 'The first run should create coordinator and executor workers');
    assertCondition(firstExecutor.hasLifecyclePoison(), 'Poison control should mutate the execution worker intrinsic');
    assertCondition(
      !firstCoordinator.hasLifecyclePoison(),
      'Execution-worker poisoning must not reach the trusted coordinator intrinsic'
    );

    const inspectResult = await client.executeCode(
      `function inspect(): number | null {
  return (Array.prototype as any).__tracecodeLifecyclePoison ?? null;
}`,
      'inspect',
      {},
      'function',
      'typescript'
    );
    assertCondition(
      inspectResult.success === true && inspectResult.output === null,
      `Disposable execution worker leaked a poisoned intrinsic into a later run: ${JSON.stringify(inspectResult)}`
    );

    const coordinatorWorkers = VmJavaScriptWorker.instances.filter((worker) => worker.role === 'coordinator');
    const executorWorkers = VmJavaScriptWorker.instances.filter((worker) => worker.role === 'executor');
    const usedExecutorWorkers = executorWorkers.filter((worker) =>
      worker.postedTypes.some((type) => type.startsWith('execute-'))
    );
    const standbyExecutorWorkers = executorWorkers.filter((worker) =>
      worker.postedTypes.every((type) => !type.startsWith('execute-'))
    );
    assertCondition(coordinatorWorkers.length === 1, 'Repeated TypeScript runs should reuse one trusted coordinator worker');
    assertCondition(
      usedExecutorWorkers.length === 2 && usedExecutorWorkers.every((worker) => worker.terminated),
      'Each TypeScript run should receive a fresh execution worker that is terminated after use'
    );
    assertCondition(
      standbyExecutorWorkers.length === 1 &&
        !standbyExecutorWorkers[0].terminated &&
        !standbyExecutorWorkers[0].hasLifecyclePoison(),
      'One clean, unused execution worker should remain prewarmed for the next command'
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('coordinator') ?? 0) === 1,
      'The persistent coordinator should load the TypeScript compiler exactly once'
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('executor') ?? 0) === 0,
      'Disposable TypeScript execution workers should consume prepared JavaScript without loading the compiler'
    );
    assertCondition(
      coordinatorWorkers[0].postedTypes.every((type) => !type.startsWith('execute-')),
      'The trusted coordinator must never receive a user-code execution message'
    );

    const compilerImportsBeforeJavaScript = VmJavaScriptWorker.typeScriptImports.get('coordinator') ?? 0;
    const prepareMessagesBeforeJavaScript = coordinatorWorkers[0].postedTypes.filter(
      (type) => type === 'prepare-execution'
    ).length;
    const javaScriptResult = await client.executeCode(
      'function add(a, b) { return a + b; }',
      'add',
      { a: 4, b: 5 },
      'function',
      'javascript'
    );
    assertCondition(
      javaScriptResult.success === true && javaScriptResult.output === 9,
      `Plain JavaScript execution failed: ${JSON.stringify(javaScriptResult)}`
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('coordinator') ?? 0) === compilerImportsBeforeJavaScript,
      'Plain JavaScript execution should not load the TypeScript compiler'
    );
    assertCondition(
      coordinatorWorkers[0].postedTypes.filter((type) => type === 'prepare-execution').length ===
        prepareMessagesBeforeJavaScript,
      'Plain JavaScript execution should bypass compiler preparation'
    );

    const batchResult = await client.executeCodeBatch(
      'function double(value: number): number { return value * 2; }',
      'double',
      [{ value: 2 }, { value: 5 }],
      'function',
      'typescript'
    );
    assertCondition(
      batchResult.success === true &&
        JSON.stringify(batchResult.results.map((result) => result.output)) === JSON.stringify([4, 10]),
      `Prepared TypeScript batch execution failed: ${JSON.stringify(batchResult)}`
    );

    const traceResult = await client.executeWithTracing(
      `function increment(value) {
  return value + 1;
}`,
      'increment',
      { value: 7 },
      undefined,
      'function',
      'javascript'
    );
    assertCondition(
      traceResult.success === true &&
        traceResult.output === 8 &&
        Array.isArray(traceResult.trace?.events) &&
        traceResult.trace.events.some((event) => event.kind === 'return'),
      `Prepared JavaScript tracing failed: ${JSON.stringify(traceResult)}`
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('coordinator') ?? 0) === 1,
      'Repeated TypeScript preparation and JavaScript instrumentation should reuse the loaded compiler'
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('executor') ?? 0) === 0,
      'Prepared batch and tracing execution workers must remain compiler-free'
    );

    client.terminate();
    assertCondition(coordinatorWorkers[0].terminated, 'Explicit client termination should stop the persistent coordinator');
    assertCondition(
      standbyExecutorWorkers[0].terminated,
      'Explicit client termination should stop the clean standby executor'
    );
    console.log('PASS: JavaScript/TypeScript coordinator and disposable execution lifecycle');
  } finally {
    if (originalWorker === undefined) {
      delete (globalThis as typeof globalThis & { Worker?: typeof Worker }).Worker;
    } else {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWorker,
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
