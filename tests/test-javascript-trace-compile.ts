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

let activeFault: TraceBuildFault | undefined;
const scripts = new Map<string, vm.Script>();

function classicWorkerScript(): vm.Script {
  const key = activeFault ?? '';
  let script = scripts.get(key);
  if (!script) {
    const source = activeFault ? injectTraceBuildFault(WORKER, pristine.worker, activeFault) : pristine.worker;
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

  constructor(url: string | URL) {
    const deliver = (data: unknown) => {
      if (!this.terminated) this.onmessage?.({ data });
    };
    if (String(url).includes(SES_WORKER)) {
      const source = activeFault ? injectTraceBuildFault(SES_WORKER, pristine.ses, activeFault) : pristine.ses;
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
        else if (imported.includes('typescript')) self.ts = ts;
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

function list(name: string): string[] {
  return (process.env[`TRACECODE_TRACE_COMPILE_${name}`] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: TestWorker });
  const startedAt = Date.now();
  await checkDirectCallers();
  const result = await runTraceCompileMatrix({
    languages: list('LANGUAGES'),
    styles: list('STYLES'),
    cases: list('CASES'),
    routes: list('ROUTES'),
    createHost(fault) {
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
    },
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
  process.exit(result.violations.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
