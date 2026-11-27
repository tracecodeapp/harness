#!/usr/bin/env npx tsx

// A JavaScript or TypeScript drawing has a finite byte budget and a per-event
// cap (0.21.1, backlog P30). Through the real Judge, JavaScript client,
// classic worker and SES bundle, in Node: classic workers run in vm contexts
// and SES workers in worker threads.
//
// - A runaway recursion's drawing is cut at the budget: `truncated` with
//   `byte-budget` (the receipt's `trace-byte-limit`), a non-empty prefix
//   within the budget, and the observation stops at the cut.
// - A correct deep recursion keeps its plain verdict; only its drawing is cut,
//   on every recording path.
// - One event over the per-event cap cuts the drawing there.
// - A normal traced Run's drawing is byte-identical to the baseline's.
//
// TRACECODE_BYTE_BUDGET_WORKER_REF=<ref> loads both workers from that git ref
// instead of the working tree (v0.21.0 is the red run).
// TRACECODE_BYTE_BUDGET_BASELINE_REF (default v0.21.0) is the release every
// normal drawing must match.
// TRACECODE_BYTE_BUDGET_REPORT=out.json writes what each check measured.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { createBrowserJudgeHostFromRuntimeHost } from '../src/internal/browser-judge';
import { allCasesPassPolicy, createAlgorithmJudgeBundle, judgeCaseExecutionOutcome } from '../src/judge';

type Language = 'javascript' | 'typescript';
type Sources = { readonly worker: string; readonly ses: string };

const WORKER = 'javascript-worker.js';
const SES_WORKER = 'javascript-ses-algorithm-worker.js';
const workerPath = (file: string) => `workers/javascript/${file}`;
const readTree = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const readRef = (ref: string, path: string) =>
  execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const candidateRef = process.env.TRACECODE_BYTE_BUDGET_WORKER_REF;
const baselineRef = process.env.TRACECODE_BYTE_BUDGET_BASELINE_REF ?? 'v0.21.0';
const candidate: Sources = candidateRef
  ? { worker: readRef(candidateRef, workerPath(WORKER)), ses: readRef(candidateRef, workerPath(SES_WORKER)) }
  : { worker: readTree(workerPath(WORKER)), ses: readTree(workerPath(SES_WORKER)) };
const baseline: Sources = {
  worker: readRef(baselineRef, workerPath(WORKER)),
  ses: readRef(baselineRef, workerPath(SES_WORKER)),
};

/** The budget the working tree ships, which the red run is held to as well. */
function shippedConstant(name: string): number {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(readTree(workerPath(WORKER)));
  assert.ok(match, `${name} not found in ${WORKER}`);
  const value = Function(`return (${match[1]});`)() as unknown;
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `${name} = ${String(value)}`);
  return value;
}
const MAX_BYTES = shippedConstant('DEFAULT_TRACE_MAX_BYTES');
const MAX_EVENT_BYTES = Math.min(shippedConstant('DEFAULT_TRACE_MAX_EVENT_BYTES'), MAX_BYTES);

// The app's trace options (its lib/utils.ts getTracingOptions).
const APP_DEFAULT = { maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000 };
const APP_BACKTRACKING = { maxTraceSteps: 4000, maxLineEvents: 20000, maxSingleLineHits: 4000, maxStoredEvents: 16000 };

// The recorder counts each event's bytes from its parts. In the classic
// worker the test loads, every count is also checked against the event's
// whole serialization, the unit's definition.
const COUNT_ANCHOR = '    const bytes = retainedEventBytes(event);\n';
const byteCounts = { checked: 0, mismatches: [] as string[] };
const countedWorker = candidate.worker.includes(COUNT_ANCHOR)
  ? candidate.worker.replace(COUNT_ANCHOR, `${COUNT_ANCHOR}    {
      const exact = self.__utf8Length(JSON.stringify({ ...event, runId: byteUnitRunId, file: byteUnitFile }));
      self.__byteCounts.checked += 1;
      if (exact !== bytes && self.__byteCounts.mismatches.length < 20) {
        self.__byteCounts.mismatches.push(\`counted \${bytes}, serialized \${exact}: \${JSON.stringify({ ...event, callStack: undefined }).slice(0, 200)}\`);
      }
    }
`)
  : undefined;

const policyScript = new vm.Script(readTree('workers/shared/runtime-kernel-policy-classic.js'));
const librariesScript = new vm.Script(readTree('workers/vendor/javascript-libraries.js'));
let active: Sources = candidate;
const classicScripts = new Map<string, vm.Script>();

function classicScript(source: string): vm.Script {
  let script = classicScripts.get(source);
  if (!script) {
    script = new vm.Script(source, { filename: WORKER });
    classicScripts.set(source, script);
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
      const thread = new NodeWorker(
        `const { parentPort, workerData } = require('node:worker_threads');
         globalThis.self = globalThis;
         globalThis.location = { href: 'https://harness.test/workers/javascript/${SES_WORKER}', search: '' };
         globalThis.postMessage = (data) => parentPort.postMessage(data);
         const module = import('data:text/javascript;base64,' + Buffer.from(workerData).toString('base64'));
         parentPort.on('message', (data) => { void module.then(() => globalThis.onmessage({ data })); });`,
        { eval: true, workerData: active.ses, execArgv: [], stderr: true, stdout: true }
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
      __byteCounts: byteCounts,
      // Node's UTF-8 count, independent of the recorder's own.
      __utf8Length: (text: string) => Buffer.byteLength(text, 'utf8'),
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
    classicScript(active === candidate && countedWorker ? countedWorker : active.worker).runInContext(context);
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

function createHost() {
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

/** The recorder's unit: each exported event's JSON, which carries its runId and file. */
function measure(events: readonly unknown[]) {
  let bytes = 0;
  let largestEvent = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    bytes += size;
    largestEvent = Math.max(largestEvent, size);
  }
  return { events: events.length, bytes, largestEvent };
}

function plain(value: unknown): any {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** What a learner is told about a case, which a drawing must never change. */
function answer(row: any): unknown {
  return plain({
    status: row.status,
    verdict: row.verdict,
    value: row.value,
    failure: row.failure,
    notRun: row.notRun,
    stdout: row.stdout,
  });
}

interface Program {
  readonly name: string;
  readonly code: Record<Language, string>;
  readonly functionName: string;
  readonly executionStyle: 'function' | 'solution-method';
  readonly cases: ReadonlyArray<{ readonly id: string; readonly input: Record<string, unknown>; readonly expected: unknown }>;
  /** The case drawn on Run. */
  readonly drawn: string;
}

// The learner-failure matrix's recursion program: a missing base case.
const RUNAWAY: Program = {
  name: 'missing base case',
  code: {
    javascript: 'class Solution {\n  f(x) {\n    if (x >= 2) return this.f(x + 1) + 1;\n    return x + 1;\n  }\n}\n',
    typescript: 'class Solution {\n  f(x: number): number {\n    if (x >= 2) return this.f(x + 1) + 1;\n    return x + 1;\n  }\n}\n',
  },
  functionName: 'f',
  executionStyle: 'solution-method',
  cases: [{ id: 'case-1', input: { x: 1 }, expected: 2 }, { id: 'case-2', input: { x: 2 }, expected: 3 }],
  drawn: 'case-2',
};

// Correct, and 400 frames deep with a wide argument: its full drawing is
// hundreds of megabytes, over any budget this release may choose.
const WIDE_ROW = Array.from({ length: 16 }, (_, index) => `row-${index}-${'x'.repeat(12)}`);
const DEEP: Program = {
  name: 'correct deep recursion',
  code: {
    javascript: 'function solve(rows, depth) {\n  if (depth === 0) return rows.length;\n  return solve(rows, depth - 1);\n}\n',
    typescript: 'function solve(rows: string[], depth: number): number {\n  if (depth === 0) return rows.length;\n  return solve(rows, depth - 1);\n}\n',
  },
  functionName: 'solve',
  executionStyle: 'function',
  cases: [{ id: 'deep', input: { rows: WIDE_ROW, depth: 400 }, expected: WIDE_ROW.length }],
  drawn: 'deep',
};

// One live value whose single snapshot event is over the per-event cap.
const OVERSIZED: Program = {
  name: 'one oversized event',
  code: {
    javascript: 'function solve(n) {\n  const text = "x".repeat(n);\n  return text.length;\n}\n',
    typescript: 'function solve(n: number): number {\n  const text: string = "x".repeat(n);\n  return text.length;\n}\n',
  },
  functionName: 'solve',
  executionStyle: 'function',
  cases: [{ id: 'big', input: { n: 1 << 20 }, expected: 1 << 20 }],
  drawn: 'big',
};

// Ordinary programs whose drawings are far inside the budget.
const NORMAL: readonly Program[] = [
  {
    name: 'binary search',
    code: {
      javascript: 'class Solution {\n  search(nums, target) {\n    let lo = 0, hi = nums.length - 1;\n    while (lo <= hi) {\n      const mid = (lo + hi) >> 1;\n      if (nums[mid] === target) return mid;\n      if (nums[mid] < target) lo = mid + 1;\n      else hi = mid - 1;\n    }\n    return -1;\n  }\n}\n',
      typescript: 'class Solution {\n  search(nums: number[], target: number): number {\n    let lo = 0, hi = nums.length - 1;\n    while (lo <= hi) {\n      const mid = (lo + hi) >> 1;\n      if (nums[mid] === target) return mid;\n      if (nums[mid] < target) lo = mid + 1;\n      else hi = mid - 1;\n    }\n    return -1;\n  }\n}\n',
    },
    functionName: 'search',
    executionStyle: 'solution-method',
    cases: [
      { id: 'found', input: { nums: [-1, 0, 3, 5, 9, 12], target: 9 }, expected: 4 },
      { id: 'missing', input: { nums: [-1, 0, 3, 5, 9, 12], target: 2 }, expected: -1 },
    ],
    drawn: 'found',
  },
  {
    name: 'small recursion',
    code: {
      javascript: 'function solve(n) {\n  if (n < 2) return n;\n  return solve(n - 1) + solve(n - 2);\n}\n',
      typescript: 'function solve(n: number): number {\n  if (n < 2) return n;\n  return solve(n - 1) + solve(n - 2);\n}\n',
    },
    functionName: 'solve',
    executionStyle: 'function',
    cases: [{ id: 'fib', input: { n: 7 }, expected: 13 }],
    drawn: 'fib',
  },
  {
    name: 'nested loops',
    code: {
      javascript: 'function solve(grid) {\n  let total = 0;\n  const seen = new Map();\n  for (let r = 0; r < grid.length; r++) {\n    for (let c = 0; c < grid[r].length; c++) {\n      total += grid[r][c];\n      seen.set(`${r},${c}`, total);\n    }\n  }\n  return total;\n}\n',
      typescript: 'function solve(grid: number[][]): number {\n  let total = 0;\n  const seen = new Map<string, number>();\n  for (let r = 0; r < grid.length; r++) {\n    for (let c = 0; c < grid[r].length; c++) {\n      total += grid[r][c];\n      seen.set(`${r},${c}`, total);\n    }\n  }\n  return total;\n}\n',
    },
    functionName: 'solve',
    executionStyle: 'function',
    cases: [{ id: 'grid', input: { grid: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }, expected: 45 }],
    drawn: 'grid',
  },
];

function bundleFor(program: Program, language: Language, trace: boolean, traceOptions?: Record<string, number>) {
  return createAlgorithmJudgeBundle({
    id: `${program.name}-${language}-${trace}`.replace(/[^\w-]/g, '-'),
    language,
    code: program.code[language],
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    trace,
    ...(trace && traceOptions ? { traceOptions } : {}),
    cases: program.cases.map((entry) => ({ ...entry })),
    policy: allCasesPassPolicy(),
  });
}

/** Untraced Submit, then an interactive Run that draws one case. */
async function judgeRun(program: Program, language: Language, traceOptions?: Record<string, number>) {
  const host = createHost();
  try {
    const submit = (await host.evaluateAlgorithm({ bundle: await bundleFor(program, language, false) })).evaluation as any;
    const startedAt = performance.now();
    const started = await host.execute({
      bundle: await bundleFor(program, language, true, traceOptions),
      interactive: true,
      tracing: { caseIds: [program.drawn] },
    });
    const runMs = performance.now() - startedAt;
    if (started.executionId) await host.disposeExecution(started.executionId);
    const run = started.evaluation as any;
    const row = run.cases.find((entry: any) => entry.caseId === program.drawn);
    const submitted = submit.cases.find((entry: any) => entry.caseId === program.drawn);
    assert.ok(row && submitted, `${program.name}: no row for ${program.drawn}`);
    return { submit, run, row, submitted, runMs };
  } finally {
    await host.dispose();
  }
}

type Route = 'direct' | 'disposable-worker' | 'ses-compartment-pool';
const ROUTES: readonly Route[] = ['direct', 'disposable-worker', 'ses-compartment-pool'];

/** One traced execution below Judge, on one recording path. */
async function directTrace(program: Program, language: Language, route: Route, input: Record<string, unknown>) {
  const client = new JavaScriptWorkerClient({
    workerUrl: `/workers/javascript/${WORKER}`,
    algorithmWorkerUrl: `/workers/javascript/${SES_WORKER}`,
    algorithmExecution: route === 'ses-compartment-pool' ? 'ses-compartment-pool' : 'disposable-worker',
    debug: false,
  });
  try {
    const base = { code: program.code[language], functionName: program.functionName, executionStyle: program.executionStyle };
    if (route === 'direct') {
      return await client.executeWithTracing({ ...base, inputs: input, language }) as any;
    }
    const prepared = await client.prepareProgram({ mode: 'trace', ...base }, language);
    assert.ok(prepared.kind === 'prepared' && prepared.program.mode === 'trace', JSON.stringify(prepared));
    try {
      const result = await prepared.program.executeIsolated({ inputs: input }) as any;
      // The pool route records in the SES bundle's own copy of the recorder.
      assert.equal(Boolean(result.timings?.algorithmFastBatch), route === 'ses-compartment-pool', `${route}: wrong recorder`);
      return result;
    } finally {
      await prepared.program.dispose();
    }
  } finally {
    client.terminate();
  }
}

const report: Record<string, unknown> = { maxBytes: MAX_BYTES, maxEventBytes: MAX_EVENT_BYTES, candidateRef: candidateRef ?? 'working tree', baselineRef };
const violations: string[] = [];

async function check(name: string, body: () => Promise<unknown>): Promise<void> {
  try {
    report[name] = await body();
    console.log(`PASS: ${name}`);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 900);
    violations.push(`${name}: ${message}`);
    report[name] = { failed: message };
    console.error(`FAIL: ${name}: ${message}`);
  }
}

/** A drawing cut by the byte budget: a prefix within it, stopped at the cut. */
function assertByteCut(row: any, language: Language, where: string, { nonEmpty }: { nonEmpty: boolean }) {
  const attachment = row.attachment;
  assert.equal(attachment?.status, 'truncated', `${where}: attachment ${attachment?.status}/${attachment?.reason}`);
  assert.equal(attachment.reason, 'byte-budget', `${where}: cut by ${attachment.reason}`);
  const outcome = judgeCaseExecutionOutcome(row, { language, trace: true }) as any;
  assert.equal(outcome.traceTruncated, 'trace-byte-limit', `${where}: presented as ${outcome.traceTruncated}`);
  const size = measure(attachment.trace.events);
  if (nonEmpty) assert.ok(size.events > 0, `${where}: empty prefix`);
  assert.ok(size.bytes <= MAX_BYTES, `${where}: ${size.bytes} bytes over the ${MAX_BYTES} budget`);
  assert.ok(size.largestEvent <= MAX_EVENT_BYTES, `${where}: an event of ${size.largestEvent} bytes`);
  // The observation stopped at the first event that did not fit.
  assert.equal(attachment.attemptedEvents, size.events + 1, `${where}: ${attachment.attemptedEvents} attempted`);
  return { ...size, attemptedEvents: attachment.attemptedEvents };
}

async function main(): Promise<void> {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: TestWorker });
  const startedAt = Date.now();
  console.log(`budget ${MAX_BYTES} bytes, per-event cap ${MAX_EVENT_BYTES} bytes; workers from ${candidateRef ?? 'the working tree'}`);

  for (const language of ['javascript', 'typescript'] as const) {
    for (const [label, options] of [['app default', APP_DEFAULT], ['backtracking limits', APP_BACKTRACKING]] as const) {
      await check(`${language} runaway recursion, ${label}: cut at the budget, verdict unchanged`, async () => {
        const { row, submitted, runMs } = await judgeRun(RUNAWAY, language, options);
        assert.deepEqual(answer(row), answer(submitted), 'the Run answer differs from untraced Submit');
        assert.notEqual(row.verdict?.kind, 'passed');
        return { ...assertByteCut(row, language, label, { nonEmpty: true }), runMs: Math.round(runMs) };
      });
    }

    await check(`${language} correct deep recursion, Run: verdict passes, drawing cut`, async () => {
      const { row, submitted, runMs } = await judgeRun(DEEP, language, APP_BACKTRACKING);
      assert.equal(row.verdict?.kind, 'passed', JSON.stringify(answer(row)));
      assert.deepEqual(answer(row), answer(submitted), 'the Run answer differs from untraced Submit');
      return { ...assertByteCut(row, language, 'Run', { nonEmpty: true }), runMs: Math.round(runMs) };
    });
    for (const route of ROUTES) {
      await check(`${language} correct deep recursion, ${route} trace: completes, drawing cut`, async () => {
        const result = await directTrace(DEEP, language, route, DEEP.cases[0]!.input);
        assert.equal(result.kind, 'completed', JSON.stringify({ ...result, trace: undefined }).slice(0, 400));
        assert.deepEqual(result.output, DEEP.cases[0]!.expected);
        assert.equal(result.traceTruncated, 'trace-byte-limit', `truncated by ${result.traceTruncated}`);
        const size = measure(result.trace.events);
        assert.ok(size.events > 0, 'empty prefix');
        assert.ok(size.bytes <= MAX_BYTES, `${size.bytes} bytes over the ${MAX_BYTES} budget`);
        assert.ok(size.largestEvent <= MAX_EVENT_BYTES, `an event of ${size.largestEvent} bytes`);
        return size;
      });
    }

    await check(`${language} one event over the cap, Run: cut there`, async () => {
      const { row, submitted } = await judgeRun(OVERSIZED, language, APP_DEFAULT);
      assert.equal(row.verdict?.kind, 'passed', JSON.stringify(answer(row)));
      assert.deepEqual(answer(row), answer(submitted), 'the Run answer differs from untraced Submit');
      return assertByteCut(row, language, 'Run', { nonEmpty: false });
    });
    for (const route of ROUTES) {
      await check(`${language} one event over the cap, ${route} trace: cut there`, async () => {
        const result = await directTrace(OVERSIZED, language, route, OVERSIZED.cases[0]!.input);
        assert.equal(result.kind, 'completed', JSON.stringify({ ...result, trace: undefined }).slice(0, 400));
        assert.equal(result.output, OVERSIZED.cases[0]!.expected);
        assert.equal(result.traceTruncated, 'trace-byte-limit', `truncated by ${result.traceTruncated}`);
        const size = measure(result.trace.events);
        assert.ok(size.largestEvent <= MAX_EVENT_BYTES, `an event of ${size.largestEvent} bytes`);
        return size;
      });
    }

    for (const program of NORMAL) {
      await check(`${language} ${program.name}: drawing byte-identical to ${baselineRef}`, async () => {
        const drawings: Record<string, string[]> = {};
        for (const [side, sources] of [['baseline', baseline], ['candidate', candidate]] as const) {
          active = sources;
          try {
            const texts: string[] = [];
            for (const options of [APP_DEFAULT, APP_BACKTRACKING]) {
              const { row } = await judgeRun(program, language, options);
              assert.equal(row.attachment?.status, 'drawn', `${side}: ${row.attachment?.status}/${row.attachment?.reason}`);
              texts.push(JSON.stringify({ answer: answer(row), trace: row.attachment.trace }));
            }
            for (const route of ROUTES) {
              const result = await directTrace(program, language, route, program.cases[0]!.input);
              assert.equal(result.traceTruncated, undefined, `${side} ${route}: truncated by ${result.traceTruncated}`);
              texts.push(JSON.stringify({ kind: result.kind, output: result.output, trace: result.trace }));
            }
            drawings[side] = texts;
          } finally {
            active = candidate;
          }
        }
        drawings.baseline!.forEach((text, index) => {
          assert.equal(drawings.candidate![index], text, `drawing ${index} differs from ${baselineRef}`);
        });
        return { drawings: drawings.candidate!.length, bytes: drawings.candidate!.map((text) => text.length) };
      });
    }
  }

  await check('the classic recorder counts every event exactly', async () => {
    assert.ok(countedWorker, 'the count anchor is missing from the candidate worker');
    assert.ok(byteCounts.checked > 10_000, `only ${byteCounts.checked} events counted`);
    assert.deepEqual(byteCounts.mismatches, []);
    return { checked: byteCounts.checked };
  });

  if (process.env.TRACECODE_BYTE_BUDGET_REPORT) {
    writeFileSync(process.env.TRACECODE_BYTE_BUDGET_REPORT, `${JSON.stringify(report, null, 1)}\n`);
  }
  console.log(
    `${violations.length ? 'FAIL' : 'PASS'}: JavaScript trace byte budget, ${violations.length} violations ` +
      `(${Math.round((Date.now() - startedAt) / 1000)} s)`
  );
  process.exit(violations.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
