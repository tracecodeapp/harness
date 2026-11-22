#!/usr/bin/env npx tsx

// Traced JavaScript and TypeScript Runs must compute what untraced Runs compute.
// Each program runs through the JavaScript worker twice (execute-code and
// execute-with-tracing) and the learner-visible results must match: success,
// output, error text, failure stage and console output. A program the tracer
// cannot instrument faithfully may instead be refused as a provider failure
// (ERR_HARNESS_TRACE_UNAVAILABLE), never reported as the learner's error.
//
// TRACECODE_TRACE_SEMANTICS_CASES=J1,J4 runs only those case ids.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { traceSemanticsCases, type TraceSemanticsCase } from './fixtures/javascript-trace-semantics-cases';

interface WorkerMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

interface WorkerResult {
  success?: boolean;
  output?: unknown;
  error?: string;
  diagnosticStage?: string;
  consoleOutput?: string[];
}

type Outcome =
  | { kind: 'result'; success: boolean; output: unknown; error?: string; stage?: string; console: string[] }
  | { kind: 'provider-error'; message: string };

function createWorkerHarness() {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const selfObject: Record<string, unknown> = {
    location: { search: '' },
    onmessage: null,
    ts,
    postMessage: (message: WorkerMessage) => {
      const entry = message.id ? pending.get(message.id) : undefined;
      if (!entry || !message.id) return;
      pending.delete(message.id);
      if (message.type === 'error') {
        const payload = message.payload as { error?: unknown } | undefined;
        entry.reject(new Error(String(payload?.error ?? 'Worker error')));
        return;
      }
      entry.resolve(message.payload);
    },
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
      const name = String(url);
      if (name.includes('runtime-kernel-policy-classic.js')) {
        vm.runInContext(readFileSync(join(process.cwd(), 'workers/shared/runtime-kernel-policy-classic.js'), 'utf8'), context);
      } else if (name.includes('javascript-libraries.js')) {
        vm.runInContext(readFileSync(join(process.cwd(), 'workers/vendor/javascript-libraries.js'), 'utf8'), context);
      } else if (name.includes('typescript')) {
        selfObject.ts = ts;
      } else {
        throw new Error(`Unexpected importScripts URL: ${name}`);
      }
    }
  };
  vm.runInContext(readFileSync(join(process.cwd(), 'workers/javascript/javascript-worker.js'), 'utf8'), context, {
    filename: 'javascript-worker.js',
  });
  const onmessage = selfObject.onmessage as (event: { data: WorkerMessage }) => void;
  return function send<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Timed out waiting for ${type}`));
      }, 10_000);
      onmessage({ data: { id, type, payload, protocolToken: `token-${id}` } });
    });
  };
}

async function run(
  send: ReturnType<typeof createWorkerHarness>,
  testCase: TraceSemanticsCase,
  language: 'javascript' | 'typescript',
  traced: boolean
): Promise<Outcome> {
  const payload = {
    code: (language === 'typescript' && testCase.typescript) || testCase.code,
    functionName: testCase.functionName ?? 'solve',
    inputs: testCase.inputs ?? {},
    executionStyle: testCase.executionStyle ?? 'function',
    language,
  };
  try {
    const result = await send<WorkerResult>(traced ? 'execute-with-tracing' : 'execute-code', payload);
    return {
      kind: 'result',
      success: result.success === true,
      output: result.output,
      ...(result.success ? {} : { error: result.error, stage: result.diagnosticStage }),
      console: result.consoleOutput ?? [],
    };
  } catch (error) {
    return { kind: 'provider-error', message: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const selected = new Set(
    (process.env.TRACECODE_TRACE_SEMANTICS_CASES ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  );
  const cases = traceSemanticsCases.filter(({ id }) => selected.size === 0 || selected.has(id));
  if (cases.length === 0) throw new Error('No trace semantics cases selected.');
  const send = createWorkerHarness();
  await send('init');
  const failures: string[] = [];
  let refused = 0;
  for (const testCase of cases) {
    for (const language of ['javascript', 'typescript'] as const) {
      if (testCase.languages && !testCase.languages.includes(language)) continue;
      const label = `${language}/${testCase.id}`;
      const untraced = await run(send, testCase, language, false);
      const traced = await run(send, testCase, language, true);
      if (untraced.kind !== 'result') {
        failures.push(`${label}: untraced run failed in the provider: ${untraced.message}`);
        continue;
      }
      if (Object.hasOwn(testCase, 'expected') &&
        !(untraced.success && isDeepStrictEqual(untraced.output, testCase.expected))) {
        failures.push(`${label}: untraced result is not the expected value: ${JSON.stringify(untraced)}`);
        continue;
      }
      if (traced.kind === 'provider-error') {
        if (traced.message.includes('Tracing is unavailable for this program') && testCase.refusalAllowed) {
          refused += 1;
          console.log(`REFUSED: ${label} (${traced.message})`);
          continue;
        }
        failures.push(`${label}: traced run failed in the provider: ${traced.message}`);
        continue;
      }
      if (testCase.refusalRequired) {
        failures.push(`${label}: tracing should have been refused, got ${JSON.stringify(traced)}`);
        continue;
      }
      if (!isDeepStrictEqual(untraced, traced)) {
        failures.push(`${label}: traced ${JSON.stringify(traced)} != untraced ${JSON.stringify(untraced)}`);
        continue;
      }
      console.log(`PASS: ${label}`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} trace semantics failure(s):`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll trace semantics cases passed (${refused} refused).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
