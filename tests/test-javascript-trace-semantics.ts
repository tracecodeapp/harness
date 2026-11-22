#!/usr/bin/env npx tsx

// Traced JavaScript and TypeScript Runs must compute what untraced Runs compute.
// Each program runs through the JavaScript worker twice (execute-code and
// execute-with-tracing) and the learner-visible results must match: success,
// output, error text, failure stage and console output. A program the tracer
// cannot instrument faithfully instead runs untraced: the same result, an empty
// trace and a `trace-unavailable` warning, never the learner's error. A case
// may fall back only when it says so; every other case must really be traced.
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
  trace?: { events?: unknown[] };
  traceUnavailable?: { code?: string; message?: string };
}

type Outcome =
  | { kind: 'result'; success: boolean; output: unknown; error?: string; stage?: string; console: string[] }
  | { kind: 'provider-error'; message: string };

/** How a traced run was recorded: kept apart from the learner-visible result. */
interface TraceShape {
  fallback?: { code?: string; message?: string };
  events: number;
}

const TRACE_UNAVAILABLE = {
  code: 'trace-unavailable',
  message: 'JavaScript tracing could not instrument this program without changing its behavior; this run has no trace.',
};

function fallbackProblem(shape: TraceShape): string | undefined {
  // Compared field by field: the worker's objects come from another realm.
  if (shape.fallback?.code !== TRACE_UNAVAILABLE.code || shape.fallback?.message !== TRACE_UNAVAILABLE.message) {
    return `fallback marker ${JSON.stringify(shape.fallback)}`;
  }
  if (shape.events !== 0) return `fallback trace has ${shape.events} events (expected an empty trace)`;
  return undefined;
}

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
  return Object.assign(function send<T>(type: string, payload?: unknown): Promise<T> {
    const id = String(++nextId);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Timed out waiting for ${type}`));
      }, 10_000);
      onmessage({ data: { id, type, payload, protocolToken: `token-${id}` } });
    });
  }, { context });
}

async function run(
  send: ReturnType<typeof createWorkerHarness>,
  testCase: TraceSemanticsCase,
  language: 'javascript' | 'typescript',
  traced: boolean,
  shapes?: TraceShape[]
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
    shapes?.push({
      ...(result.traceUnavailable ? { fallback: result.traceUnavailable } : {}),
      events: Array.isArray(result.trace?.events) ? result.trace.events.length : 0,
    });
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
  let fellBack = 0;
  for (const testCase of cases) {
    for (const language of ['javascript', 'typescript'] as const) {
      if (testCase.languages && !testCase.languages.includes(language)) continue;
      const label = `${language}/${testCase.id}`;
      const untraced = await run(send, testCase, language, false);
      const shapes: TraceShape[] = [];
      const traced = await run(send, testCase, language, true, shapes);
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
        failures.push(`${label}: traced run failed in the provider: ${traced.message}`);
        continue;
      }
      if (!isDeepStrictEqual(untraced, traced)) {
        failures.push(`${label}: traced ${JSON.stringify(traced)} != untraced ${JSON.stringify(untraced)}`);
        continue;
      }
      const shape = shapes[0]!;
      if (shape.fallback) {
        const problem = fallbackProblem(shape);
        if (problem) {
          failures.push(`${label}: ${problem}`);
          continue;
        }
        if (!testCase.fallbackAllowed && !testCase.fallbackRequired) {
          failures.push(`${label}: ran untraced (trace-unavailable) but this case must be traced`);
          continue;
        }
        fellBack += 1;
        console.log(`PASS: ${label} (untraced, trace-unavailable)`);
        continue;
      }
      if (testCase.fallbackRequired) {
        failures.push(`${label}: must run untraced with trace-unavailable, but was traced`);
        continue;
      }
      if (shape.events === 0) {
        failures.push(`${label}: traced run recorded no trace events`);
        continue;
      }
      console.log(`PASS: ${label}`);
    }
  }
  // Safety net: when instrumentation yields a program that does not compile
  // but the learner's program does, the Run is not blamed on the learner; it
  // runs untraced with an empty trace and the trace-unavailable warning.
  if (selected.size === 0) {
    const brokenSend = createWorkerHarness();
    await brokenSend('init');
    (brokenSend.context as Record<string, unknown>).instrumentCodeForTracing = async () => 'outer: { for (;;) { continue outer; } }';
    for (const language of ['javascript', 'typescript'] as const) {
      const program: TraceSemanticsCase = traceSemanticsCases.find(({ id }) => id === 'J1')!;
      const shapes: TraceShape[] = [];
      const traced = await run(brokenSend, program, language, true, shapes);
      const problem = shapes[0] ? fallbackProblem(shapes[0]) : 'no result';
      if (traced.kind !== 'result' || !traced.success || traced.output !== 0 || problem) {
        failures.push(
          `${language}/safety-net: an uncompilable instrumented program must fall back, got ` +
            `${JSON.stringify(traced)} (${problem ?? 'marker ok'})`
        );
      } else {
        console.log(`PASS: ${language}/safety-net`);
      }
    }
  }

  // The compile safety net checks the assembled runner (helpers, recorder
  // parameters and learner code together), not the instrumented source alone:
  // with the reserved-name rule switched off, a learner name that collides
  // with a helper still falls back instead of failing as a compile error.
  if (selected.size === 0) {
    const netSend = createWorkerHarness();
    await netSend('init');
    (netSend.context as Record<string, unknown>).findTracerReservedIdentifier = () => null;
    for (const language of ['javascript', 'typescript'] as const) {
      const program: TraceSemanticsCase = traceSemanticsCases.find(({ id }) => id === 'R1-helper-name-collision')!;
      const shapes: TraceShape[] = [];
      const traced = await run(netSend, program, language, true, shapes);
      const problem = shapes[0] ? fallbackProblem(shapes[0]) : 'no result';
      if (traced.kind !== 'result' || !traced.success || traced.output !== 2 || problem) {
        failures.push(
          `${language}/assembled-runner-net: a helper-name collision must fall back, got ` +
            `${JSON.stringify(traced)} (${problem ?? 'marker ok'})`
        );
      } else {
        console.log(`PASS: ${language}/assembled-runner-net`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} trace semantics failure(s):`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll trace semantics cases passed (${fellBack} ran untraced with trace-unavailable).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
