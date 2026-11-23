#!/usr/bin/env npx tsx

// "The untraced answer is the truth on whether a program compiles", through
// the real Judge, JavaScript client, worker and SES bundle, in Node: classic
// workers run in vm contexts and SES workers in worker threads.
//
// TRACECODE_TRACE_COMPILE_{LANGUAGES,STYLES,CASES,ROUTES}=a,b narrow the run.
// TRACECODE_TRACE_COMPILE_REPORT=out.json writes every observation.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import ts from 'typescript';
import {
  createBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
} from '../packages/runtime-browser/src';
import { createJavaScriptBrowserRuntimeProvider } from '../packages/runtime-javascript/src/browser-runtime-provider';
import { JavaScriptWorkerClient } from '../packages/runtime-javascript/src/javascript-worker-client';
import { createNativeHarness } from '../packages/runtime-native/src/index';
import { isRuntimeProviderError, isTraceUnavailableError } from '../packages/runtime-contracts/src/index';
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import { allCasesPassPolicy, createAlgorithmJudgeBundle } from '../src/judge';
import type { TraceCompileLanguage } from './fixtures/javascript-trace-compile-cases';
import { runUntracedRouteChecks } from './fixtures/javascript-untraced-route';
import {
  injectTraceBuildFault,
  runTraceCompileMatrix,
  type TraceBuildFault,
} from './fixtures/javascript-trace-compile-matrix';

const read = (...path: string[]) => readFileSync(join(process.cwd(), 'workers', ...path), 'utf8');
const WORKER = 'javascript-worker.js';
const SES_WORKER = 'javascript-ses-algorithm-worker.js';
const pristine = { worker: read('javascript', WORKER), ses: read('javascript', SES_WORKER) };
const policyScript = new vm.Script(read('shared', 'runtime-kernel-policy-classic.js'));
const librariesScript = new vm.Script(read('vendor', 'javascript-libraries.js'));

/** A failure of the runtime itself, not of building one program. */
interface RuntimeFault {
  readonly name: string;
  readonly compilerImportFails?: boolean;
  /** A posted message that kills its worker. */
  readonly kills?: (data: any, worker: 'classic' | 'ses') => boolean;
  /** A posted message that is never answered. */
  readonly swallows?: (data: any) => boolean;
  readonly edit?: { readonly file: string; readonly from: string; readonly to: string };
}

let activeFault: TraceBuildFault | undefined;
let runtimeFault: RuntimeFault | undefined;
const scripts = new Map<string, vm.Script>();

function workerSource(file: string, source: string): string {
  const injected = activeFault ? injectTraceBuildFault(file, source, activeFault) : source;
  const edit = runtimeFault?.edit;
  if (edit?.file !== file) return injected;
  assert.ok(injected.includes(edit.from), `${runtimeFault!.name}: anchor not found in ${file}`);
  return injected.replace(edit.from, () => edit.to);
}

function classicWorkerScript(): vm.Script {
  const key = `${activeFault ?? ''}/${runtimeFault?.edit ? runtimeFault.name : ''}`;
  let script = scripts.get(key);
  if (!script) {
    const source = workerSource(WORKER, pristine.worker);
    script = new vm.Script(source, { filename: WORKER });
    scripts.set(key, script);
  }
  return script;
}

class TestWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault?: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private terminated = false;
  private readonly post: (data: unknown) => void;
  private readonly stop: () => void;
  private readonly kind: 'classic' | 'ses';

  constructor(url: string | URL) {
    this.kind = String(url).includes(SES_WORKER) ? 'ses' : 'classic';
    const deliver = (data: unknown) => {
      if (!this.terminated) this.onmessage?.({ data });
    };
    if (String(url).includes(SES_WORKER)) {
      const source = workerSource(SES_WORKER, pristine.ses);
      const thread = new NodeWorker(
        `const { parentPort, workerData } = require('node:worker_threads');
         globalThis.self = globalThis;
         globalThis.location = { href: 'https://harness.test/workers/javascript/${SES_WORKER}', search: '' };
         globalThis.postMessage = (data) => parentPort.postMessage(data);
         const module = import('data:text/javascript;base64,' + Buffer.from(workerData).toString('base64'));
         parentPort.on('message', (data) => { void module.then(() => globalThis.onmessage({ data })); });`,
        { eval: true, workerData: source, execArgv: [], stderr: true, stdout: true }
      );
      thread.on('message', deliver);
      thread.on('error', (error) => this.onerror?.({ message: String(error) }));
      this.post = (data) => thread.postMessage(data);
      this.stop = () => void thread.terminate();
      return;
    }

    const self: Record<string, any> = {
      location: { search: new URL(String(url), 'https://harness.test/').search },
      postMessage: (data: unknown) => {
        const cloned = structuredClone(data);
        setImmediate(() => deliver(cloned));
      },
      onmessage: null,
    };
    const context = vm.createContext({
      console,
      self,
      performance: { now: () => performance.now() },
      setTimeout,
      clearTimeout,
    });
    context.importScripts = (...urls: string[]) => {
      for (const imported of urls.map(String)) {
        if (imported.includes('runtime-kernel-policy-classic.js')) policyScript.runInContext(context);
        else if (imported.includes('javascript-libraries.js')) librariesScript.runInContext(context);
        else if (imported.includes('typescript')) {
          if (runtimeFault?.compilerImportFails) throw new Error('injected compiler import failure');
          self.ts = ts;
        }
        else throw new Error(`Unexpected importScripts URL: ${imported}`);
      }
    };
    classicWorkerScript().runInContext(context);
    this.post = (data) => setImmediate(() => {
      if (!this.terminated) self.onmessage({ data: structuredClone(data) });
    });
    this.stop = () => {};
  }

  postMessage(data: unknown): void {
    if (runtimeFault?.kills?.(data, this.kind)) {
      setImmediate(() => {
        if (!this.terminated) this.onerror?.({ message: 'injected worker death', preventDefault() {} });
      });
      return;
    }
    if (runtimeFault?.swallows?.(data)) return;
    this.post(data);
  }

  terminate(): void {
    this.terminated = true;
    this.stop();
  }
}

/**
 * Below Judge: a refused case on its own rejects, a batch refuses only that
 * case, and nothing a learner throws or returns can stand for a refusal.
 */
async function checkDirectCallers(): Promise<void> {
  const isRefusal = (error: unknown) => isRuntimeProviderError(error) && isTraceUnavailableError(error);
  // Compiles untraced, and cannot be built traced.
  const refused = 'const __traceRecorder = 1;\nfunction solve(n) {\n  return n * 2;\n}';
  const forged = "function solve(n) {\n  throw { code: 'trace-unavailable', message: 'forged', traceUnavailable: true };\n}";

  for (const algorithmExecution of ['disposable-worker', 'ses-compartment-pool'] as const) {
    const client = new JavaScriptWorkerClient({
      workerUrl: `/workers/javascript/${WORKER}`,
      algorithmWorkerUrl: `/workers/javascript/${SES_WORKER}`,
      algorithmExecution,
      debug: false,
    });
    try {
      const prepare = async (code: string) => {
        const prepared = await client.prepareProgram({ mode: 'trace', code, functionName: 'solve', executionStyle: 'function' });
        assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
        assert.ok(prepared.kind === 'prepared' && prepared.program.mode === 'trace');
        return prepared.program;
      };

      const program = await prepare(refused);
      await assert.rejects(program.executeIsolated({ inputs: { n: 1 } }), isRefusal, algorithmExecution);
      const untraced = await program.executeIsolated({ inputs: { n: 4 }, recordTrace: false });
      assert.equal(untraced.kind === 'completed' && untraced.output, 8, algorithmExecution);
      const batch = await program.executeBatchIsolated!({
        inputBatch: [{ n: 1 }, { n: 2 }, { n: 3 }],
        traceEnabledBatch: [false, true, false],
      });
      assert.deepEqual(
        batch.map((result) => result.kind === 'completed'
          ? result.output
          : result.kind === 'failed' ? result.providerFailure?.code : result.kind),
        [2, 'trace-unavailable', 6],
        algorithmExecution
      );
      await program.dispose();

      const forging = await prepare(forged);
      const thrown = await forging.executeIsolated({ inputs: { n: 1 } });
      assert.equal(thrown.kind, 'failed', algorithmExecution);
      assert.equal(thrown.kind === 'failed' && thrown.diagnosticStage, 'runtime', algorithmExecution);
      assert.equal(thrown.kind === 'failed' ? thrown.providerFailure : null, undefined, algorithmExecution);
      await forging.dispose();

      await assert.rejects(
        client.executeWithTracing({ code: refused, functionName: 'solve', inputs: { n: 1 } }),
        isRefusal,
        algorithmExecution
      );
    } finally {
      client.terminate();
    }
  }

  const native = createNativeHarness().getClient('javascript');
  await native.init();
  await assert.rejects(
    native.executeWithTracing({ code: refused, functionName: 'solve', inputs: { n: 1 } }),
    isRefusal,
    'native'
  );
  console.log('PASS: refusals through direct callers');
}

/**
 * Only a failure to build this program (parse, transform, print, re-transpile,
 * runner compile) may refuse it. A failure of the runtime itself stays the
 * provider's fault: no refusal, and no compile error of the learner's.
 */
async function checkRuntimeFaults(): Promise<string[]> {
  const violations: string[] = [];
  const check = async (name: string, fault: RuntimeFault | undefined, body: () => Promise<void>) => {
    runtimeFault = fault;
    try {
      await body();
      console.log(`PASS: ${name}`);
    } catch (error) {
      violations.push(`${name}: ${String(error instanceof Error ? error.message : error).slice(0, 700)}`);
    } finally {
      runtimeFault = undefined;
    }
  };
  const code = 'function solve() { return 7 }';
  const isProviderFault = (error: unknown) => {
    assert.ok(!isTraceUnavailableError(error), `refused as trace-unavailable: ${String(error)}`);
    assert.ok(isRuntimeProviderError(error), `not a RuntimeProviderError: ${String(error)}`);
    return true;
  };
  const withClient = async (
    algorithmExecution: 'disposable-worker' | 'ses-compartment-pool',
    body: (client: JavaScriptWorkerClient) => Promise<void>,
    typescriptCompilerPreflight?: () => Promise<void>
  ) => {
    const client = new JavaScriptWorkerClient({
      workerUrl: `/workers/javascript/${WORKER}`,
      algorithmWorkerUrl: `/workers/javascript/${SES_WORKER}`,
      algorithmExecution,
      debug: false,
      ...(typescriptCompilerPreflight ? { typescriptCompilerPreflight } : {}),
    });
    try {
      await body(client);
    } finally {
      client.terminate();
    }
  };
  const tracedPreparation = { mode: 'trace', code, functionName: 'solve', executionStyle: 'function' } as const;
  const judgeRun = async (language: TraceCompileLanguage, fault?: TraceBuildFault) => {
    const host = createHost(fault);
    try {
      const started = await host.execute({
        bundle: await createAlgorithmJudgeBundle({
          id: `runtime-fault-${language}`,
          language,
          code,
          functionName: 'solve',
          executionStyle: 'function',
          trace: true,
          cases: ['1', '2', '3'].map((id) => ({ id, input: {}, expected: 7 })),
          policy: allCasesPassPolicy(),
        }),
        interactive: true,
        tracing: { caseIds: ['1'] },
      });
      if (started.executionId) await host.disposeExecution(started.executionId);
      return started.evaluation as any;
    } finally {
      await host.dispose();
      activeFault = undefined;
    }
  };

  const compilerImport: RuntimeFault = { name: 'compiler-import', compilerImportFails: true };
  for (const language of ['javascript', 'typescript'] as const) {
    await check(`compiler import fails, ${language} Judge Run: separate roles`, compilerImport, async () => {
      const result = await judgeRun(language);
      const text = JSON.stringify(result);
      assert.ok(!text.includes('"trace-unavailable"'), `refused: ${text}`);
      assert.ok(!text.includes('"stage":"compile"'), `blamed on the learner: ${text}`);
      if (language === 'typescript') {
        assert.ok(text.includes('"origin":"provider"'), `not a provider fault: ${text}`);
        assert.ok(text.includes('injected compiler import failure'), `lost the cause: ${text}`);
      } else {
        assert.equal(result.status, 'completed');
        assert(result.cases.every((row: any) => row.verdict.kind === 'passed'));
        assert.equal(result.cases[0].attachment?.status, 'refused');
        assert.equal(result.cases[0].attachment?.reason, 'observer-prepare');
      }
    });
    for (const route of ['disposable-worker', 'ses-compartment-pool'] as const) {
      await check(`compiler import fails, ${language} prepared trace on ${route}: provider fault`, compilerImport, () =>
        withClient(route, async (client) => {
          await assert.rejects(async () => {
            const prepared = await client.prepareProgram(tracedPreparation, language);
            assert.equal(prepared.kind, 'prepared', `blamed on the learner: ${JSON.stringify(prepared)}`);
            if (prepared.kind !== 'prepared' || prepared.program.mode !== 'trace') return;
            await prepared.program.executeIsolated({ inputs: {} });
          }, isProviderFault);
        })
      );
      await check(`compiler import fails, ${language} direct trace on ${route}: provider fault`, compilerImport, () =>
        withClient(route, async (client) => {
          await assert.rejects(client.executeWithTracing({ code, functionName: 'solve', inputs: {}, language }), isProviderFault);
        })
      );
    }
    await check(`compiler import fails, ${language} executor without a prepared build: no refusal`, compilerImport, async () => {
      const worker = new TestWorker(`/workers/javascript/${WORKER}?tracecodeRole=executor`);
      const reply = await new Promise<any>((resolve) => {
        worker.onmessage = ({ data }: { data: any }) => {
          if (data.id === 'direct') resolve(data);
        };
        worker.postMessage({
          id: 'direct',
          protocolToken: 'direct',
          type: 'execute-with-tracing',
          payload: { code, functionName: 'solve', inputs: {}, executionStyle: 'function', language },
        });
      });
      worker.terminate();
      assert.equal(reply.type, 'error', `not a provider fault: ${JSON.stringify(reply).slice(0, 300)}`);
      assert.notEqual(reply.payload.code, 'trace-unavailable', 'refused as trace-unavailable');
      assert.match(reply.payload.error, /injected compiler import failure/);
    });
    await check(`control, printer fault, ${language} Judge Run: still refuses`, undefined, async () => {
      const [traced, ...untraced] = (await judgeRun(language, 'printer-emits-invalid-code')).cases;
      assert.equal(traced.verdict.kind, 'passed', JSON.stringify(traced));
      assert.equal(traced.attachment?.status, 'refused', JSON.stringify(traced));
      assert.equal(traced.attachment?.reason, 'observer-prepare', JSON.stringify(traced));
      assert.deepEqual(untraced.map((result: any) => result.verdict.kind), ['passed', 'passed']);
    });
  }

  await check('observer worker loss preserves the ordinary result', {
    name: 'observer-death',
    kills: (data, worker) => worker === 'classic' && data.type === 'observe-execution',
  }, async () => {
    const [traced] = (await judgeRun('javascript')).cases;
    assert.equal(traced?.verdict?.kind, 'passed', JSON.stringify(traced));
    assert.equal(traced.attachment?.status, 'refused');
    assert.equal(traced.attachment?.reason, 'observer-runtime');
  });
  await check('an untraced build that fails only the first time: provider fault, not refused', {
    name: 'transient-untraced-build',
    edit: {
      file: WORKER,
      from: 'function buildFunctionExecutionRunner(',
      to: `let __injectedBuildFailed = false;
function buildFunctionExecutionRunner(...args) {
  if (!__injectedBuildFailed) {
    __injectedBuildFailed = true;
    throw new RangeError('injected transient build failure');
  }
  return buildFunctionExecutionRunnerOriginal(...args);
}
function buildFunctionExecutionRunnerOriginal(`,
    },
  }, () => withClient('disposable-worker', async (client) => {
    await assert.rejects(client.executeWithTracing({ code, functionName: 'solve', inputs: {} }), isProviderFault);
  }));
  for (const entry of ['executeIsolated', 'executeBatchIsolated'] as const) {
    await check(`an untraced build that fails only the first time, prepared ${entry}: provider fault, not refused`, {
      name: 'transient-untraced-build-prepared',
      edit: {
        file: WORKER,
        from: 'function buildFunctionExecutionRunner(',
        to: `let __injectedBuildFailed = false;
function buildFunctionExecutionRunner(...args) {
  if (!__injectedBuildFailed && WORKER_ROLE === 'executor') {
    __injectedBuildFailed = true;
    throw new RangeError('injected transient build failure');
  }
  return buildFunctionExecutionRunnerOriginal(...args);
}
function buildFunctionExecutionRunnerOriginal(`,
      },
    }, () => withClient('disposable-worker', async (client) => {
      const prepared = await client.prepareProgram(tracedPreparation);
      assert.equal(prepared.kind, 'prepared', `blamed on the learner: ${JSON.stringify(prepared)}`);
      if (prepared.kind !== 'prepared' || prepared.program.mode !== 'trace') return;
      const program = prepared.program;
      await assert.rejects(
        () => entry === 'executeIsolated'
          ? program.executeIsolated({ inputs: {} })
          : program.executeBatchIsolated!({ inputBatch: [{}] }),
        isProviderFault
      );
    }));
  }

  for (const [name, type] of [['coordinator', 'prepare-execution'], ['executor', 'execute-with-tracing']] as const) {
    await check(`${name} death: no refusal, no compile error`, {
      name: `${name}-death`,
      kills: (data, worker) => worker === 'classic' && data.type === type,
    }, () => withClient('disposable-worker', async (client) => {
      await assert.rejects(async () => {
        const prepared = await client.prepareProgram(tracedPreparation);
        assert.equal(prepared.kind, 'prepared', `blamed on the learner: ${JSON.stringify(prepared)}`);
        if (prepared.kind !== 'prepared' || prepared.program.mode !== 'trace') return;
        await prepared.program.executeIsolated({ inputs: {} });
      }, (error) => {
        assert.match(String(error), /injected worker death/);
        assert.ok(!isTraceUnavailableError(error), 'refused as trace-unavailable');
        return true;
      });
    }));
  }
  await check('abort while preparing: AbortError, no refusal', {
    name: 'abort',
    swallows: (data) => data.type === 'prepare-execution',
  }, () => withClient('disposable-worker', async (client) => {
    const controller = new AbortController();
    const pending = client.prepareProgram({ ...tracedPreparation, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError' && !isTraceUnavailableError(error));
  }));
  await check('compiler asset preflight fails: rejects, no refusal', undefined, () =>
    withClient('ses-compartment-pool', async (client) => {
      await assert.rejects(client.prepareProgram(tracedPreparation), (error) => {
        assert.match(String(error), /injected preflight failure/);
        assert.ok(!isTraceUnavailableError(error), 'refused as trace-unavailable');
        return true;
      });
    }, () => Promise.reject(new Error('injected preflight failure')))
  );
  return violations;
}

/** A failed request cannot change a later program's route or replay itself. */
async function checkPoolRoute(): Promise<string[]> {
  const violations: string[] = [];
  const code = 'function solve() { return 7 }';
  const base = { code, functionName: 'solve', executionStyle: 'function' } as const;
  const scenarios: ReadonlyArray<{
    fault: RuntimeFault;
    mode: 'code' | 'trace';
    traceOptions?: Record<string, unknown>;
    failure?: RegExp;
  }> = [
    { fault: { name: 'an unknown trace option' }, mode: 'trace', traceOptions: { notATraceControl: 1 } },
    {
      fault: { name: 'a traced execution that kills its worker', kills: (data, worker) => worker === 'ses' && data.type === 'execute-batch' && data.traceEnabledBatch?.[0] === true },
      mode: 'trace',
      failure: /injected worker death/,
    },
    {
      fault: {
        name: 'an error a live worker reports for one program',
        edit: {
          file: SES_WORKER,
          from: 'const execute = compartment.evaluate(factorySource',
          to: "if (source.code.includes('faulty')) throw new RangeError('injected program failure');\n  const execute = compartment.evaluate(factorySource",
        },
      },
      mode: 'code',
      failure: /injected program failure/,
    },
    {
      fault: { name: 'control, a worker crash on an untraced preparation', kills: (data, worker) => worker === 'ses' && data.type === 'prepare' && data.source.code.includes('faulty') },
      mode: 'code',
      failure: /injected worker death/,
    },
  ];
  for (const { fault, mode, traceOptions, failure } of scenarios) {
    runtimeFault = fault;
    const client = new JavaScriptWorkerClient({
      workerUrl: `/workers/javascript/${WORKER}`,
      algorithmWorkerUrl: `/workers/javascript/${SES_WORKER}`,
      algorithmExecution: 'ses-compartment-pool',
      debug: false,
    });
    try {
      const first = async () => {
        const prepared = await client.prepareProgram({
          ...base,
          mode,
          code: `${code} // faulty`.replace('return 7', 'const faulty = 7; return faulty'),
          ...(traceOptions ? { traceOptions: traceOptions as any } : {}),
        });
        assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
        try {
          return await prepared.program.executeIsolated({ inputs: {} });
        } finally {
          await prepared.program.dispose();
        }
      };
      if (failure) await assert.rejects(first, failure);
      else {
        const result = await first();
        assert.equal(result.kind === 'completed' && result.output, 7);
      }
      runtimeFault = undefined;
      const later = await client.prepareProgram({ ...base, mode: 'code' });
      assert.equal(later.kind, 'prepared');
      if (later.kind === 'prepared') {
        assert.equal(later.program.capabilities.profile, 'fast', 'the route of a later untraced program');
        const result = await later.program.executeIsolated({ inputs: {} });
        assert.equal(result.kind === 'completed' && result.output, 7);
        await later.program.dispose();
      }
      console.log(`PASS: pool route, ${fault.name}`);
    } catch (error) {
      violations.push(`pool route, ${fault.name}: ${String(error).slice(0, 500)}`);
    } finally {
      runtimeFault = undefined;
      client.terminate();
    }
  }
  return violations;
}

function createHost(fault?: TraceBuildFault) {
  activeFault = fault;
  return createBrowserJudgeHostFromRuntimeHost(createBrowserRuntimeHost({
    providerRegistry: createBrowserRuntimeProviderRegistry([createJavaScriptBrowserRuntimeProvider()]),
    providers: ['javascript', 'typescript'],
    featureOverrides: {
      worker: true,
      webAssembly: true,
      webCrypto: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
    },
    debug: false,
  }));
}

function list(name: string): string[] {
  return (process.env[`TRACECODE_TRACE_COMPILE_${name}`] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: TestWorker });
  const startedAt = Date.now();
  await checkDirectCallers();
  const faultViolations = [...await checkRuntimeFaults(), ...await checkPoolRoute()];
  for (const violation of faultViolations) console.error(`FAIL: ${violation}`);
  console.log(`${faultViolations.length ? 'FAIL' : 'PASS'}: runtime faults, ${faultViolations.length} violations`);
  const routeChecks = await runUntracedRouteChecks(createHost);
  for (const { name, compared, violations } of routeChecks) {
    for (const violation of violations) console.error(`FAIL: ${name}: ${violation}`);
    console.log(`${violations.length ? 'FAIL' : 'PASS'}: ${name} (${compared} compared, ${violations.length} violations)`);
  }
  const result = await runTraceCompileMatrix({
    languages: list('LANGUAGES'),
    styles: list('STYLES'),
    cases: list('CASES'),
    routes: list('ROUTES'),
    createHost,
  });
  if (process.env.TRACECODE_TRACE_COMPILE_REPORT) {
    writeFileSync(process.env.TRACECODE_TRACE_COMPILE_REPORT, `${JSON.stringify(result, null, 1)}\n`);
  }
  for (const violation of result.violations) console.error(`FAIL: ${violation}`);
  console.log(
    `${result.violations.length ? 'FAIL' : 'PASS'}: JavaScript trace compile truth, ${result.checked} programs, ` +
      `${result.violations.length} violations (${Math.round((Date.now() - startedAt) / 1000)} s)`
  );
  if (!result.checked) throw new Error('No trace compile programs selected.');
  const routeViolations = routeChecks.some(({ violations }) => violations.length > 0);
  process.exit(result.violations.length || faultViolations.length || routeViolations ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
