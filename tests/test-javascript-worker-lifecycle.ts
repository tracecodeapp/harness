#!/usr/bin/env npx tsx

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
} from '../packages/runtime-browser/src';
import {
  getBrowserRuntimeHostPreparedProvider,
} from '../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  createJavaScriptBrowserRuntimeProvider,
} from '../packages/runtime-javascript/src/browser-runtime-provider';
import { JavaScriptWorkerClient } from '../packages/runtime-javascript/src/javascript-worker-client';
import { createJavaScriptRuntimeClient } from '../packages/runtime-javascript/src/javascript-runtime-client';
import { createJavaScriptPreparedProgram } from '../packages/runtime-javascript/src/javascript-prepared-program';
import type {
  CodeExecutionResult,
  RuntimePreparedCodeCall,
} from '../packages/runtime-contracts/src/index';

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

  hasPreparedIntrinsicMutation(): boolean {
    return Boolean(
      vm.runInContext(
        'Array.prototype.__tracecodePreparedIntrinsic',
        this.context
      )
    );
  }
}

function resetVmWorkers(): void {
  for (const worker of VmJavaScriptWorker.instances) {
    if (!worker.terminated) worker.terminate();
  }
  VmJavaScriptWorker.instances.length = 0;
  VmJavaScriptWorker.typeScriptImports.clear();
}

function preparedMutationSource(language: 'javascript' | 'typescript'): string {
  if (language === 'typescript') {
    return `let lexicalCount = 0;
class PreparedState {
  static count = 0;
}
function solve(values: number[], marker: string) {
  lexicalCount += 1;
  PreparedState.count += 1;
  (globalThis as any).__tracecodePreparedGlobal =
    ((globalThis as any).__tracecodePreparedGlobal ?? 0) + 1;
  (module.exports as any).__tracecodePreparedModule =
    ((module.exports as any).__tracecodePreparedModule ?? 0) + 1;
  (Array.prototype as any).__tracecodePreparedIntrinsic =
    ((Array.prototype as any).__tracecodePreparedIntrinsic ?? 0) + 1;
  values.push(lexicalCount);
  return {
    lexicalCount,
    staticCount: PreparedState.count,
    globalCount: (globalThis as any).__tracecodePreparedGlobal,
    moduleCount: (module.exports as any).__tracecodePreparedModule,
    intrinsicCount: (Array.prototype as any).__tracecodePreparedIntrinsic,
    marker,
    values
  };
}`;
  }
  return `let lexicalCount = 0;
class PreparedState {
  static count = 0;
}
function solve(values, marker) {
  lexicalCount += 1;
  PreparedState.count += 1;
  globalThis.__tracecodePreparedGlobal =
    (globalThis.__tracecodePreparedGlobal ?? 0) + 1;
  module.exports.__tracecodePreparedModule =
    (module.exports.__tracecodePreparedModule ?? 0) + 1;
  Array.prototype.__tracecodePreparedIntrinsic =
    (Array.prototype.__tracecodePreparedIntrinsic ?? 0) + 1;
  values.push(lexicalCount);
  return {
    lexicalCount,
    staticCount: PreparedState.count,
    globalCount: globalThis.__tracecodePreparedGlobal,
    moduleCount: module.exports.__tracecodePreparedModule,
    intrinsicCount: Array.prototype.__tracecodePreparedIntrinsic,
    marker,
    values
  };
}`;
}

async function exercisePreparedProvider(
  language: 'javascript' | 'typescript'
): Promise<void> {
  resetVmWorkers();
  const workerClient = new JavaScriptWorkerClient({
    workerUrl: '/workers/javascript/javascript-worker.js',
    debug: false,
  });
  const runtime = createJavaScriptRuntimeClient(language, workerClient);

  try {
    const prepared = await runtime.prepareProgram({
      mode: 'code',
      code: preparedMutationSource(language),
      functionName: 'solve',
      executionStyle: 'function',
    });
    assertCondition(
      prepared.kind === 'prepared' && prepared.program.mode === 'code',
      `${language} code preparation failed: ${JSON.stringify(prepared)}`
    );
    assertCondition(
      prepared.program.capabilities.caseIsolation === 'fresh-case-state' &&
        prepared.program.capabilities.maxConcurrency === 1,
      `${language} prepared program reported unsafe isolation capabilities`
    );
    assert.equal(
      typeof prepared.program.executeBatchIsolated,
      'function',
      `${language} should expose the fresh-worker batch path`
    );
    assertCondition(
      typeof prepared.timings?.totalMs === 'number' &&
        (language === 'typescript'
          ? prepared.timings.compileCacheHit === false &&
            typeof prepared.timings.compileMs === 'number'
          : typeof prepared.timings.rewriteMs === 'number'),
      `${language} preparation did not report preparation timings: ${JSON.stringify(prepared.timings)}`
    );

    const firstInput = [11];
    const secondInput = [22];
    const [firstCase, secondCase] = await Promise.all([
      prepared.program.executeIsolated({
        inputs: { marker: 'first', values: firstInput },
      }),
      prepared.program.executeIsolated({
        inputs: { marker: 'second', values: secondInput },
      }),
    ]);
    for (const [label, result, expectedValues, marker] of [
      ['first', firstCase, [11, 1], 'first'],
      ['second', secondCase, [22, 1], 'second'],
    ] as const) {
      assertCondition(
        result.kind === 'completed',
        `${language} ${label} prepared case failed: ${JSON.stringify(result)}`
      );
      assertCondition(
        JSON.stringify(result.output) ===
          JSON.stringify({
            lexicalCount: 1,
            staticCount: 1,
            globalCount: 1,
            moduleCount: 1,
            intrinsicCount: 1,
            marker,
            values: expectedValues,
          }),
        `${language} ${label} prepared case leaked mutable state: ${JSON.stringify(result.output)}`
      );
      assertCondition(
        result.timings?.artifactCacheHit === true &&
          typeof result.timings.runMs === 'number' &&
          typeof result.timings.totalMs === 'number',
        `${language} ${label} prepared case did not report cached-artifact run timings`
      );
    }
    assert.deepEqual(
      firstInput,
      [11],
      `${language} prepared execution mutated the caller's first input`
    );
    assert.deepEqual(
      secondInput,
      [22],
      `${language} prepared execution mutated the caller's second input`
    );

    const coordinator = VmJavaScriptWorker.instances.find(
      (worker) => worker.role === 'coordinator'
    );
    assertCondition(
      coordinator,
      `${language} prepared execution did not create a trusted coordinator`
    );
    assertCondition(
      coordinator.postedTypes.filter((type) => type === 'prepare-execution')
        .length === 1,
      `${language} prepared code should prepare exactly once for multiple cases`
    );
    const codeExecutors = VmJavaScriptWorker.instances.filter(
      (worker) =>
        worker.role === 'executor' &&
        worker.postedTypes.includes('execute-code')
    );
    assertCondition(
      codeExecutors.length === 2 &&
        codeExecutors.every(
          (worker) =>
            worker.terminated && worker.hasPreparedIntrinsicMutation()
        ),
      `${language} prepared cases must each use and retire a fresh executor`
    );
    assertCondition(
      !coordinator.hasPreparedIntrinsicMutation(),
      `${language} coordinator artifact observed executor prototype state`
    );
    assertCondition(
      (VmJavaScriptWorker.typeScriptImports.get('executor') ?? 0) === 0,
      `${language} prepared executors must not load the TypeScript compiler`
    );

    const tracePrepared = await runtime.prepareProgram({
      mode: 'trace',
      code:
        language === 'typescript'
          ? `function increment(value: number): number {
  const next = value + 1;
  return next;
}`
          : `function increment(value) {
  const next = value + 1;
  return next;
}`,
      functionName: 'increment',
      executionStyle: 'function',
    });
    assertCondition(
      tracePrepared.kind === 'prepared' &&
        tracePrepared.program.mode === 'trace',
      `${language} trace preparation failed: ${JSON.stringify(tracePrepared)}`
    );
    const [firstTrace, secondTrace] = await Promise.all([
      tracePrepared.program.executeIsolated({ inputs: { value: 4 } }),
      tracePrepared.program.executeIsolated({ inputs: { value: 8 } }),
    ]);
    assertCondition(
      firstTrace.kind === 'completed' &&
        firstTrace.output === 5 &&
        firstTrace.trace.events.length > 0 &&
        firstTrace.trace.events.some(
          (event) => event.kind === 'return' && event.line === 3
        ) &&
        firstTrace.timings?.artifactCacheHit === true &&
        typeof firstTrace.timings.runMs === 'number' &&
        secondTrace.kind === 'completed' &&
        secondTrace.output === 9 &&
        secondTrace.trace.events.length > 0 &&
        secondTrace.trace.events.some(
          (event) => event.kind === 'return' && event.line === 3
        ) &&
        secondTrace.timings?.artifactCacheHit === true &&
        typeof secondTrace.timings.runMs === 'number',
      `${language} prepared trace cases failed: ${JSON.stringify([
        firstTrace,
        secondTrace,
      ])}`
    );
    assertCondition(
      coordinator.postedTypes.filter((type) => type === 'prepare-execution')
        .length === 2,
      `${language} prepared trace should add exactly one preparation`
    );

    const cancellable = await runtime.prepareProgram({
      mode: 'code',
      code:
        language === 'typescript'
          ? `async function maybeWait(wait: boolean): Promise<number> {
  if (wait) await new Promise<void>(() => {});
  return 42;
}`
          : `async function maybeWait(wait) {
  if (wait) await new Promise(() => {});
  return 42;
}`,
      functionName: 'maybeWait',
      executionStyle: 'function',
    });
    assertCondition(
      cancellable.kind === 'prepared' && cancellable.program.mode === 'code',
      `${language} cancellation fixture failed to prepare`
    );
    const limited = await cancellable.program.executeIsolated({
      inputs: { wait: true },
      limits: { wallClockMs: 5 },
    });
    assertCondition(
      limited.kind === 'limit' &&
        limited.reason === 'client-timeout' &&
        limited.timings?.totalMs === 5,
      `${language} prepared execution did not honor its wall-clock limit: ${JSON.stringify(limited)}`
    );
    const abortController = new AbortController();
    const cancelled = cancellable.program.executeIsolated({
      inputs: { wait: true },
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(), 5);
    await assert.rejects(
      cancelled,
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError',
      `${language} prepared execution did not propagate cancellation`
    );
    const recovered = await cancellable.program.executeIsolated({
      inputs: { wait: false },
    });
    assertCondition(
      recovered.kind === 'completed' && recovered.output === 42,
      `${language} prepared program could not execute after a cancelled case: ${JSON.stringify(recovered)}`
    );

    const activeAtDispose = cancellable.program.executeIsolated({
      inputs: { wait: true },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const executorCountBeforeDispose = VmJavaScriptWorker.instances.length;
    const disposal = Promise.all([
      cancellable.program.dispose(),
      cancellable.program.dispose(),
    ]);
    await assert.rejects(
      activeAtDispose,
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError',
      `${language} disposal did not abort an active prepared execution`
    );
    await disposal;
    await assert.rejects(
      cancellable.program.executeIsolated({ inputs: { wait: false } }),
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError',
      `${language} disposed prepared program accepted another case`
    );
    assert.equal(
      VmJavaScriptWorker.instances.length,
      executorCountBeforeDispose,
      `${language} disposed prepared program allocated a worker`
    );
    await tracePrepared.program.dispose();
    await prepared.program.dispose();

    if (language === 'typescript') {
      const failed = await runtime.prepareProgram({
        mode: 'code',
        code: 'function broken(value: number { return value; }',
        functionName: 'broken',
        executionStyle: 'function',
      });
      assertCondition(
        failed.kind === 'failed' &&
          failed.diagnosticStage === 'compile' &&
          failed.errorLine === 1 &&
          typeof failed.error === 'string' &&
          failed.error.length > 0,
        `Invalid TypeScript preparation should return a compile failure: ${JSON.stringify(failed)}`
      );
    }
  } finally {
    workerClient.terminate();
    resetVmWorkers();
  }
}

async function exercisePreparedDisposalOwner(): Promise<void> {
  let disposeCalls = 0;
  let observedLifecycleAbort = false;
  const program = createJavaScriptPreparedProgram({
    mode: 'code',
    executeCode: (
      call: RuntimePreparedCodeCall
    ): Promise<CodeExecutionResult> =>
      new Promise((resolve, reject) => {
        if (!call.signal) {
          reject(new Error('Prepared execution did not receive a lifecycle signal.'));
          return;
        }
        call.signal.addEventListener(
          'abort',
          () => {
            observedLifecycleAbort = true;
            resolve({
              kind: 'completed',
              output: 1,
              consoleOutput: [],
            });
          },
          { once: true }
        );
      }),
    dispose: () => {
      disposeCalls += 1;
    },
  });
  const activeCase = program.executeIsolated({ inputs: {} });
  await Promise.resolve();
  await Promise.all([program.dispose(), program.dispose(), program.dispose()]);
  await activeCase;
  assert.equal(
    disposeCalls,
    1,
    'Prepared-program owner must dispose its artifact exactly once'
  );
  assert.equal(
    observedLifecycleAbort,
    true,
    'Prepared-program disposal must abort active cases before releasing artifacts'
  );
}

async function executeHostProgram(
  host: ReturnType<typeof createBrowserRuntimeHost>,
  language: 'javascript' | 'typescript',
  value: number
): Promise<void> {
  const provider = getBrowserRuntimeHostPreparedProvider(host, language);
  const preparation = await provider.prepareProgram({
    mode: 'code',
    code:
      language === 'typescript'
        ? 'function increment(value: number): number { return value + 1; }'
        : 'function increment(value) { return value + 1; }',
    functionName: 'increment',
    executionStyle: 'function',
  });
  assertCondition(
    preparation.kind === 'prepared' && preparation.program.mode === 'code',
    `${language} host preparation failed: ${JSON.stringify(preparation)}`
  );
  const execution = await preparation.program.executeIsolated({
    inputs: { value },
  });
  assertCondition(
    execution.kind === 'completed' && execution.output === value + 1,
    `${language} host execution failed: ${JSON.stringify(execution)}`
  );
  await preparation.program.dispose();
}

async function exerciseSharedProviderLanguageDisposal(): Promise<void> {
  resetVmWorkers();
  const host = createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([
      createJavaScriptBrowserRuntimeProvider(),
    ]),
    providers: ['javascript', 'typescript'],
    featureOverrides: {
      worker: true,
      webAssembly: true,
      webCrypto: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    },
    debug: false,
  });

  try {
    await executeHostProgram(host, 'javascript', 1);
    const staleProvider = getBrowserRuntimeHostPreparedProvider(
      host,
      'javascript'
    );
    const stalePreparation = await staleProvider.prepareProgram({
      mode: 'code',
      code: 'function stale(value) { return value; }',
      functionName: 'stale',
      executionStyle: 'function',
    });
    assertCondition(
      stalePreparation.kind === 'prepared' &&
        stalePreparation.program.mode === 'code',
      'JavaScript stale-generation fixture did not prepare'
    );
    const firstGeneration = [...VmJavaScriptWorker.instances];
    assertCondition(
      firstGeneration.some((worker) => !worker.terminated),
      'JavaScript host execution did not leave a reusable shared worker generation'
    );

    host.disposeLanguage('javascript');
    await assert.rejects(
      stalePreparation.program.executeIsolated({ inputs: { value: 1 } }),
      (error: unknown) =>
        error instanceof Error && error.name === 'AbortError',
      'Language reset must invalidate prepared artifacts from the retired generation'
    );
    assertCondition(
      firstGeneration.every((worker) => worker.terminated),
      'Disposing JavaScript must retire every worker in its shared JavaScript/TypeScript generation'
    );

    await executeHostProgram(host, 'typescript', 2);
    const secondGeneration = VmJavaScriptWorker.instances.slice(
      firstGeneration.length
    );
    assertCondition(
      secondGeneration.length > 0 &&
        secondGeneration.some((worker) => !worker.terminated),
      'TypeScript did not reacquire fresh workers after JavaScript disposal'
    );

    host.disposeLanguage('typescript');
    assertCondition(
      secondGeneration.every((worker) => worker.terminated),
      'Disposing TypeScript must retire every worker in its shared JavaScript/TypeScript generation'
    );

    await executeHostProgram(host, 'javascript', 3);
    const thirdGeneration = VmJavaScriptWorker.instances.slice(
      firstGeneration.length + secondGeneration.length
    );
    assertCondition(
      thirdGeneration.length > 0 &&
        thirdGeneration.some((worker) => !worker.terminated),
      'JavaScript did not reacquire fresh workers after TypeScript disposal'
    );

    host.dispose();
    assertCondition(
      thirdGeneration.every((worker) => worker.terminated),
      'Whole-host disposal must terminate the final shared JavaScript/TypeScript worker generation'
    );
  } finally {
    host.dispose();
    resetVmWorkers();
  }
}

async function exerciseRetireOnlyPolicy(): Promise<void> {
  resetVmWorkers();
  const client = new JavaScriptWorkerClient({
    workerUrl: '/workers/javascript/javascript-worker.js',
    debug: false,
    prewarmAfterUse: false,
  });
  try {
    await client.init();
    const first = await client.executeCode({
      code: 'function identity(value) { return value; }',
      functionName: 'identity',
      inputs: { value: 1 },
      executionStyle: 'function',
      language: 'javascript',
    });
    assertCondition(
      first.kind === 'completed' && first.output === 1,
      `Retire-only JavaScript execution failed: ${JSON.stringify(first)}`
    );
    assertCondition(
      VmJavaScriptWorker.instances
        .filter((worker) => worker.role === 'executor')
        .every((worker) => worker.terminated),
      'Retire-only must not replenish a clean standby after execution'
    );

    const countAfterFirst = VmJavaScriptWorker.instances.length;
    const second = await client.executeCode({
      code: 'function identity(value) { return value; }',
      functionName: 'identity',
      inputs: { value: 2 },
      executionStyle: 'function',
      language: 'javascript',
    });
    assertCondition(
      second.kind === 'completed' &&
        second.output === 2 &&
        VmJavaScriptWorker.instances.length > countAfterFirst,
      'Retire-only must construct a fresh executor lazily for the next command'
    );
  } finally {
    client.terminate();
    resetVmWorkers();
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
    const plainOnlyResult = await plainJavaScriptClient.executeCode({ code: 'function add(a, b) { return a + b; }', functionName: 'add', inputs: { a: 2, b: 3 }, executionStyle: 'function', language: 'javascript' });
    assertCondition(
      plainOnlyResult.kind === 'completed' && plainOnlyResult.output === 5,
      `Plain-only JavaScript execution failed: ${JSON.stringify(plainOnlyResult)}`
    );
    const computedConstructorEscape = await plainJavaScriptClient.executeCode({ code: `function escape() {
  const key = 'con' + 'structor';
  const scope = ({})[key][key]('return self')();
  return scope.fetch('https://escape.invalid/');
}`, functionName: 'escape', inputs: {}, executionStyle: 'function', language: 'javascript' });
    assertCondition(
      computedConstructorEscape.kind === 'failed' &&
        computedConstructorEscape.error === 'fetch is not defined',
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

    const poisonResult = await client.executeCode({ code: `function poison(value: number) {
  (Array.prototype as any).__tracecodeLifecyclePoison = 7331;
  return value + 1;
}`, functionName: 'poison', inputs: { value: 1 }, executionStyle: 'function', language: 'typescript' });
    assertCondition(
      poisonResult.kind === 'completed' && poisonResult.output === 2,
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

    const inspectResult = await client.executeCode({ code: `function inspect(): number | null {
  return (Array.prototype as any).__tracecodeLifecyclePoison ?? null;
}`, functionName: 'inspect', inputs: {}, executionStyle: 'function', language: 'typescript' });
    assertCondition(
      inspectResult.kind === 'completed' && inspectResult.output === null,
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
    const javaScriptResult = await client.executeCode({ code: 'function add(a, b) { return a + b; }', functionName: 'add', inputs: { a: 4, b: 5 }, executionStyle: 'function', language: 'javascript' });
    assertCondition(
      javaScriptResult.kind === 'completed' && javaScriptResult.output === 9,
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

    const batchResult = await client.executeCodeBatch({ code: 'function double(value: number): number { return value * 2; }', functionName: 'double', inputBatch: [{ value: 2 }, { value: 5 }], executionStyle: 'function', language: 'typescript' });
    assertCondition(
      batchResult.results.every((result) => result.kind === 'completed') &&
        JSON.stringify(batchResult.results.map((result) => (result.kind === 'completed' ? result.output : undefined))) === JSON.stringify([4, 10]),
      `Prepared TypeScript batch execution failed: ${JSON.stringify(batchResult)}`
    );
    for (const language of ['javascript', 'typescript'] as const) {
      const intrinsicBatch = await client.executeCodeBatch({
        code:
          language === 'typescript'
            ? `function poison(caseNumber: number): number | null {
  const previous = (Array.prototype as any).__tracecodeBatchPoison ?? null;
  (Array.prototype as any).__tracecodeBatchPoison = caseNumber;
  return previous;
}`
            : `function poison(caseNumber) {
  const previous = Array.prototype.__tracecodeBatchPoison ?? null;
  Array.prototype.__tracecodeBatchPoison = caseNumber;
  return previous;
}`,
        functionName: 'poison',
        inputBatch: [{ caseNumber: 1 }, { caseNumber: 2 }],
        executionStyle: 'function',
        language,
      });
      assertCondition(
        intrinsicBatch.results.every(
          (result) => result.kind === 'completed' && result.output === null
        ),
        `${language} batch leaked realm intrinsics between cases: ${JSON.stringify(intrinsicBatch)}`
      );
    }

    const traceResult = await client.executeWithTracing({ code: `function increment(value) {
  return value + 1;
}`, functionName: 'increment', inputs: { value: 7 }, executionStyle: 'function', language: 'javascript' });
    assertCondition(
      traceResult.kind === 'completed' &&
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
    const workerCountAfterTermination = VmJavaScriptWorker.instances.length;
    await assert.rejects(
      client.executeCode({
        code: 'function shouldNotRun() { return 1; }',
        functionName: 'shouldNotRun',
        inputs: {},
        executionStyle: 'function',
        language: 'javascript',
      }),
      /terminated/,
      'Terminal client disposal must not restart a worker generation'
    );
    assert.equal(
      VmJavaScriptWorker.instances.length,
      workerCountAfterTermination,
      'Terminal client disposal allocated a new worker'
    );
    await exercisePreparedProvider('javascript');
    await exercisePreparedProvider('typescript');
    await exercisePreparedDisposalOwner();
    await exerciseSharedProviderLanguageDisposal();
    await exerciseRetireOnlyPolicy();
    console.log('PASS: JavaScript/TypeScript coordinator and disposable execution lifecycle');
  } finally {
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    } else {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWorker,
      });
    }
  }
}

test('javascript worker lifecycle', main);
