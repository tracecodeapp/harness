import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  type BrowserJudgeHost,
  type JudgeAlgorithmSourceCase,
  type JudgeComparatorStrategy,
  type JudgeEvaluationResult,
} from '../src/judge';
import { createTraceCCRuntimeManifest, TRACECC_RUNTIME_ASSET_RELATIVE_PATH } from '../packages/runtime-cpp/src/tracecc-runtime-assets';
import { getLanguageRuntimeProfile, resolveBrowserRuntimeAssets } from '../src/tracekernel';
import { healthyProgram, matrixCells, type MatrixLanguage } from '../tests/fixtures/learner-failure-matrix-cases';

type Language = MatrixLanguage;
type Host = BrowserJudgeHost;
type Flavor = 'practice' | 'ios';
type BuildOptions = Parameters<typeof createAlgorithmJudgeBundle>[0];

export interface Program {
  id: string;
  code: string;
  functionName: string;
  executionStyle: BuildOptions['executionStyle'];
  cases: JudgeAlgorithmSourceCase<Record<string, unknown>, unknown>[];
  comparison?: JudgeComparatorStrategy;
  expectedStatus?: 'passed' | 'failed' | 'compile-failed' | 'runtime-error';
  stopAtFirstRunaway?: true;
}

const assetBaseUrl = '/workers';
const sameOrigin = resolveBrowserRuntimeAssets();
const desktopTraceBudget = {
  maxTraceSteps: 4000, maxLineEvents: 12000, maxSingleLineHits: 1000, maxStoredEvents: 16000,
};
const iosTraceBudget = {
  maxTraceSteps: 1000, maxLineEvents: 5000, maxSingleLineHits: 2000, maxStoredEvents: 1000,
};
const traceLimits = new Set(['trace-limit', 'trace-byte-limit']);
const runawayLimits = new Set(['client-timeout', 'line-limit', 'single-line-limit']);
let sequence = 0;

function createHost(language: Language): Host {
  return createBrowserJudgeHost({
    providers: [language],
    assetBaseUrl,
    debug: language === 'javascript' || language === 'typescript',
    assets: {
      pythonWorker: sameOrigin.pythonWorker,
      javascriptWorker: sameOrigin.javascriptWorker,
      javascriptAlgorithmWorker: sameOrigin.javascriptAlgorithmWorker,
      javaWorker: sameOrigin.javaWorker,
      csharpWorker: sameOrigin.csharpWorker,
      runtimeManifests: {
        cpp: createTraceCCRuntimeManifest(
          `${assetBaseUrl}/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}`,
          { workerUrl: sameOrigin.cppWorker },
        ),
      },
    },
    cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
  });
}

async function bundle(language: Language, program: Program, flavor?: Flavor) {
  const controls = getLanguageRuntimeProfile(language).capabilities.tracing.controls;
  const traceOptions = Object.fromEntries(Object.entries(
    flavor === 'ios' ? iosTraceBudget : desktopTraceBudget,
  ).filter(([key]) => controls[key as keyof typeof controls]));
  return createAlgorithmJudgeBundle({
    id: `host-history-${++sequence}-${program.id}`,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    cases: program.cases,
    comparison: program.comparison ?? { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
    policy: allCasesPassPolicy(),
    ...(language === 'java' && !crossOriginIsolated ? { limits: { wallClockMs: 60_000 } } : {}),
    ...(flavor !== undefined ? { trace: true, traceOptions } : {}),
  });
}

function observe(evaluation: JudgeEvaluationResult) {
  const compile = evaluation.compile;
  return {
    status: evaluation.status,
    compile: compile && {
      status: compile.status,
      stdout: compile.stdout,
      failure: compile.failure,
    },
    cases: evaluation.cases.map((item) => ({
      caseId: item.caseId,
      status: item.status,
      verdict: item.verdict,
      value: item.value,
      stdout: item.stdout,
      failure: item.failure,
      notRun: item.notRun,
    })),
  };
}

function traceEvidence(evaluation: JudgeEvaluationResult) {
  return {
    status: evaluation.status,
    compileFailure: evaluation.compile?.failure,
    cases: evaluation.cases.map((item) => ({
      status: item.status,
      verdict: item.verdict.kind,
      value: item.value,
      failure: item.failure,
      traceSteps: (item.trace as { traceStepCount?: number } | undefined)?.traceStepCount,
      attachment: item.attachment && { status: item.attachment.status, reason: 'reason' in item.attachment ? item.attachment.reason : undefined },
      hasReturnEvent: (item.trace as { events?: { kind: string }[] } | undefined)?.events?.some(({ kind }) => kind === 'return'),
      diagnostics: item.diagnostics.map(({ code, severity, message }) => ({ code, severity, message })),
    })),
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function simple(language: Language, id: string, code?: string, expected?: unknown, inputs = [3, 4]): Program {
  return {
    ...healthyProgram(language),
    ...(code ? { code } : {}),
    id,
    cases: inputs.map((n, i) => ({ id: `case-${i + 1}`, input: { n }, expected: expected ?? n })),
  };
}

function fixture(language: Language, kind: ReturnType<typeof matrixCells>[number]['kind'], id: string = kind): Program {
  const spec = matrixCells(language).find((candidate) => candidate.kind === kind);
  if (!spec) throw new Error(`Missing ${language} matrix fixture ${kind}`);
  return { ...simple(language, id), ...spec.program };
}

const mutationCode: Partial<Record<Language, string>> = {
  python: `import math
def solve(n):
    if n == 0:
        math._host_history = 37
    return getattr(math, "_host_history", 0)`,
  javascript: `let counter = 0;
function solve(n) { counter += 1; return counter; }`,
  typescript: `let counter = 0;
function solve(n: number) { counter += 1; return counter; }`,
  java: `class Solution {
  static int counter = 0;
  public int solve(int n) {
    counter += 1;
    return counter;
  }
}`,
  cpp: `class Solution {
public:
  int solve(int n) {
    static int counter = 0;
    counter += 1;
    return counter;
  }
};`,
  csharp: `public class Solution {
  static int counter = 0;
  public int Solve(int n) { return ++counter; }
}`,
};

const nameCode: Record<Language, string> = {
  python: `sys = 2
builtins = 3
def solve(n):
    print("host-history", n)
    return sys + builtins + n`,
  javascript: `function window() { return 2; }
function console() { return 3; }
function solve(n) { return window() + console() + n; }`,
  typescript: `function window() { return 2; }
function console() { return 3; }
function solve(n: number) { return window() + console() + n; }`,
  java: `class Solution {
  static int System = 2;
  static int Thread = 3;
  public int solve(int n) {
    java.lang.System.out.println("host-history " + n);
    return System + Thread + n;
  }
}`,
  cpp: `#include <cstdio>
class Solution {
  int stdout = 2, errno_value = 3;
public:
  int solve(int n) {
    std::printf("host-history %d\\n", n);
    return stdout + errno_value + n;
  }
};`,
  csharp: `public class Solution {
  const int System = 2, Console = 3;
  public int Solve(int n) {
    global::System.Console.WriteLine("host-history " + n);
    return System + Console + n;
  }
}`,
};

function jsRouteCanaries(language: 'javascript' | 'typescript') {
  const arg = language === 'typescript' ? 'n: number' : 'n';
  return [
    simple(language, 'top-level-process', `function process() {}\nfunction solve(${arg}) { return n; }`),
    simple(language, 'raw-import-text', 'const text = String.raw`import(x)`;\n' +
      `function solve(${arg}) { return text.length + n; }`),
  ].map((program) => ({
    ...program,
    cases: program.cases.map((item) => ({
      ...item,
      expected: (item.expected as number) + (program.id === 'raw-import-text' ? 9 : 0),
    })),
  }));
}

const costlyLoop: Record<Language, string> = {
  python: `def solve(n):
    if n == 2:
        while True: sum(range(2000000))
    return n`,
  javascript: `function solve(n) {
  let total = 0;
  while (n === 2) {
    for (let i = 0; i < 20000; i++) total = Math.imul(total ^ i, 31);
  }
  return n + total;
}`,
  typescript: `function solve(n: number): number {
  let total = 0;
  while (n === 2) {
    for (let i = 0; i < 20000; i++) total = Math.imul(total ^ i, 31);
  }
  return n + total;
}`,
  java: `class Solution {
  public int solve(int n) {
    int total = 0;
    while (n == 2) {
      for (int i = 0; i < 20000; i++) total = (total ^ i) * 31;
    }
    return n + total;
  }
}`,
  cpp: `class Solution {
public:
  int solve(int n) {
    volatile unsigned int total = 0;
    while (n == 2) {
      for (unsigned int i = 0; i < 20000; ++i) total = (total ^ i) * 31u;
    }
    return n + static_cast<int>(total);
  }
};`,
  csharp: `public class Solution {
  public int Solve(int n) {
    int total = 0;
    while (n == 2) {
      for (int i = 0; i < 20000; i++) total = unchecked((total ^ i) * 31);
    }
    return n + total;
  }
}`,
};

function midBatch(language: Language, cheap = false): Program {
  const code = cheap ? 'def solve(n):\n    if n == 2:\n        while True: pass\n    return n' : costlyLoop[language];
  return {
    ...simple(language, cheap ? 'mid-batch-cheap' : 'mid-batch-costly', code, undefined, [1, 2, 3, 4]),
    stopAtFirstRunaway: true,
  };
}

function traceLimitProgram(language: Language) {
  const program = fixture(language, 'trace-step-limit', 'limit-drawing');
  const repeats = Array.from({ length: 8 }, (_, i) => `total += ${i + 1}`);
  // Cross the recording budget with every individual line below the app's
  // single-line ceiling. Each execution uses the app's real trace options.
  program.code = program.code.replace('20000', '900').replace(
    /^( +)total \+= i(;?)$/m,
    (_, indent, semicolon) => repeats.map((line) => indent + line + semicolon).join('\n'),
  );
  if (language === 'cpp') {
    program.code = program.code.replace('i < 900', 'i < n');
    program.cases = simple('cpp', program.id, program.code, undefined, [900, 3]).cases;
  }
  return program;
}

function cppTraceFaultProbes(): Program[] {
  const deletedNode = simple('cpp', 'cpp-deleted-node', `class Solution {
public:
  int solve(int n) {
    ListNode* p = new ListNode(n);
    delete p;
    return n;
  }
};`);
  const alias = `#include <vector>
class Solution {
public:
  int solve(std::vector<int>& nums) {
    auto& cur = nums[0];
    cur = 0;
    return nums[0];
  }
};`;
  const vectorCases = [3, 5].map((n, index) => ({ id: `case-${index + 1}`, input: { nums: [n] }, expected: 0 }));
  const wrong = { ...simple('cpp', 'cpp-trace-wrong', alias), cases: vectorCases };
  const compile = {
    ...simple('cpp', 'cpp-trace-compile', '#include <type_traits>\n' +
      alias.replace('    cur = 0;', '    static_assert(std::is_reference_v<decltype(cur)>);\n    cur = 0;')),
    cases: vectorCases,
  };
  return [
    { ...deletedNode, expectedStatus: 'passed' },
    { ...fixture('cpp', 'memory-fault', 'cpp-wasm-trap'), expectedStatus: 'runtime-error' },
    { ...compile, expectedStatus: 'passed' },
    { ...wrong, expectedStatus: 'passed' },
  ];
}

function probes(language: Language): Program[] {
  const mutation = language === 'python'
    ? simple(language, 'module-state', mutationCode[language], 0)
    : simple(language, 'static-state', mutationCode[language], 1);
  const named = simple(language, 'runtime-names', nameCode[language]);
  named.cases = named.cases.map((item) => ({ ...item, expected: (item.expected as number) + 5 }));
  const heavy = fixture(language, 'trace-step-limit', 'heavy-finite');
  // Keep finite work close to the 4,000 recording-step ceiling. The separate
  // history program keeps the original 20,000 iterations and crosses it.
  heavy.code = heavy.code.replace('20000', '1900');
  const result: Program[] = [
    { ...simple(language, 'correct'), expectedStatus: 'passed' },
    { ...simple(language, 'wrong-answer', undefined, -100), expectedStatus: 'failed' },
    { ...fixture(language, 'division-by-zero', 'runtime-error'), expectedStatus: 'runtime-error' },
    { ...fixture(language, 'syntax', 'compile-error'), expectedStatus: 'compile-failed' },
    { ...fixture(language, 'unbounded-recursion', 'recursive-limit') },
    { ...heavy, expectedStatus: 'passed' },
    mutation,
    named,
    midBatch(language),
  ];
  if (language === 'javascript' || language === 'typescript') {
    result.push(...jsRouteCanaries(language));
    const argument = language === 'typescript' ? 'n: number' : 'n';
    result.push(simple(language, 'stdout', `function solve(${argument}) { console.log("host-history", n); return n; }`));
  }
  if (language === 'python') {
    result.push(midBatch(language, true));
    result.push(simple(language, 'interpreter-guards', `import sys
def solve(n):
    return sys.getrecursionlimit()`));
  }
  if (language === 'cpp') result.push(...cppTraceFaultProbes());
  return result;
}

type PreparedCases = {
  plain: Awaited<ReturnType<typeof bundle>>;
  firstCase?: Awaited<ReturnType<typeof bundle>>;
  stopAtFirstRunaway: boolean;
};

let state: {
  language: Language;
  host: Host;
  programs: Map<string, PreparedCases>;
  iosHost?: Host;
  abandoned: Partial<Record<Flavor, string>>;
} | undefined;

function current() {
  if (!state) throw new Error('Host has not been set up');
  return state;
}

export async function setup(language: Language, references: Program[]) {
  if (crossOriginIsolated) throw new Error('Practice requires a non-isolated document');
  if (state) throw new Error('Previous host is still live');
  observeWorkerTransport();
  const programs = [...references, ...probes(language)];
  const bundles = new Map<string, PreparedCases>();
  for (const program of programs) {
    bundles.set(program.id, {
      plain: await bundle(language, program),
      stopAtFirstRunaway: program.stopAtFirstRunaway ?? language !== 'python',
      ...(program.stopAtFirstRunaway ? { firstCase: await bundle(language, {
        ...program, cases: program.cases.slice(0, 1),
      }) } : {}),
    });
  }
  state = { language, host: createHost(language), programs: bundles, abandoned: {} };
  return programs.map(({ id, expectedStatus, stopAtFirstRunaway }) => ({
    id, expectedStatus, checkMidBatch: stopAtFirstRunaway === true,
  }));
}

async function executePlain(host: Host, plain: PreparedCases['plain'], stopAtFirstRunaway: boolean) {
  // Keep trace and interactive options out of the verdict request, including
  // when a retained drawing or an aborted request is still being cleaned up.
  try {
    return observe((await host.execute({ bundle: plain, stopAtFirstRunaway })).evaluation);
  } catch (error) {
    return { status: 'host-rejected', ...errorText(error) };
  }
}

export async function untraced(id: string, target: 'fresh' | 'shared' | 'ios', firstOnly = false) {
  const { language, programs, host: shared, iosHost } = current();
  const program = programs.get(id);
  const selected = firstOnly ? program?.firstCase : program?.plain;
  if (!selected || !program) throw new Error(`No bundle for ${id}`);
  const host = target === 'fresh' ? createHost(language) : target === 'ios' ? iosHost : shared;
  if (!host) throw new Error(`No host for ${target}`);
  try {
    return await executePlain(host, selected, program.stopAtFirstRunaway);
  } finally {
    if (target === 'fresh') host.dispose();
  }
}

export async function history(
  kind: 'interactive' | 'all' | 'trace-limit' | 'runaway' | 'compile-failure' |
    'refused' | 'disposed' | 'abandoned' | 'module-mutation' | 'changed-recursion-limit' | 'first-drawing',
  id?: string,
  flavor: Flavor = 'practice',
) {
  const currentState = current();
  const { language, programs } = currentState;
  const host = flavor === 'ios'
    ? currentState.iosHost ??= createHost(language)
    : currentState.host;
  const original = id ? programs.get(id)?.plain : undefined;
  let program = simple(language, 'drawing');
  if (kind === 'trace-limit') program = traceLimitProgram(language);
  if (kind === 'runaway') program = fixture(language, 'infinite-loop', 'runaway-drawing');
  if (kind === 'compile-failure') program = fixture(language, 'syntax', 'invalid-drawing');
  if (kind === 'module-mutation') program = simple(language, kind, mutationCode.python, 37, [0]);
  if (kind === 'changed-recursion-limit') {
    program = simple(language, kind, 'import sys\ndef solve(n):\n    sys.setrecursionlimit(1234)\n    return n', undefined, [3]);
  }
  if (kind === 'first-drawing') program.cases = program.cases.slice(0, 1);
  let traced = await bundle(language, program, flavor);
  if (original) {
    // Preserve the same code, cases, workspace and comparison. Change only
    // the execution mode and trace options.
    traced = {
      ...original,
      execution: {
        ...original.execution,
        trace: true,
        traceOptions: traced.execution.traceOptions,
      },
    };
  }
  const caseIds = traced.plan.cases.map((item) => item.id);
  try {
    if (kind === 'interactive' || kind === 'disposed' || kind === 'abandoned') {
      const initial = await host.execute({
        bundle: traced, interactive: true, tracing: { caseIds: caseIds.slice(0, 1) },
      });
      const executionId = initial.executionId;
      const first = traceEvidence(initial.evaluation);
      if (!executionId) {
        const excluded = id === 'cpp-trace-compile' && first.compileFailure?.origin === 'program' &&
          first.status === 'compile-failed'
          ? 'Compilation failed before a continuation could exist. The traced-only failure is covered separately.'
          : undefined;
        return { kind, initial: first, witnessed: false, excluded };
      }
      if (kind === 'abandoned') {
        currentState.abandoned[flavor] = executionId;
        return { kind, initial: first, retained: true, witnessed: true };
      }
      try {
        if (kind === 'interactive') {
          const continuation = await host.execute({ executionId, tracing: { caseIds: caseIds.slice(1) } });
          return { kind, initial: first, continuation: traceEvidence(continuation.evaluation), witnessed: true };
        }
      } finally {
        await host.disposeExecution(executionId);
      }
      try {
        await host.execute({ executionId, tracing: { caseIds: caseIds.slice(1) } });
        return { kind, initial: first, witnessed: false };
      } catch (error) {
        const rejection = errorText(error);
        return { kind, initial: first, rejection, witnessed: /disposed/i.test(rejection.message) };
      }
    }
    if (kind === 'refused') {
      try {
        await host.execute({ bundle: traced, tracing: { caseIds: ['unknown-case'] } });
        return { kind, witnessed: false };
      } catch (error) {
        const rejection = errorText(error);
        return { kind, rejection, witnessed: /unknown|missing/i.test(rejection.message) };
      }
    }
    // TraceCC reports the stored-event cutoff in Wasm, but the named-batch
    // parser can drop that status when the program exits successfully. Use
    // the same source with a short loop to establish the terminal event.
    let limitControl;
    if (kind === 'trace-limit' && language === 'cpp') {
      const controlCase = traced.plan.cases[1]!;
      const control = await host.execute({ bundle: traced, tracing: { caseIds: [controlCase.id] } });
      limitControl = traceEvidence(control.evaluation).cases[1];
    }
    const evaluation = kind === 'all' || kind === 'first-drawing'
      ? (await host.evaluateAlgorithm({ bundle: traced })).evaluation
      : (await host.execute({ bundle: traced, tracing: { caseIds: caseIds.slice(0, 1) }, stopAtFirstRunaway: true })).evaluation;
    const result = traceEvidence(evaluation);
    const hasLimit = (limits: Set<string>) => result.cases.some((item) =>
      (item.failure?.origin === 'limit' && limits.has(item.failure.reason)) ||
      item.diagnostics.some(({ code }) => code !== undefined && limits.has(code)),
    );
    const storedBudget = traced.execution.traceOptions?.maxStoredEvents;
    const cppSoftCutoff = kind === 'trace-limit' && language === 'cpp' &&
      limitControl?.hasReturnEvent === true && storedBudget !== undefined &&
      result.cases.some((item) => item.status === 'completed' && item.hasReturnEvent === false &&
        (item.traceSteps === storedBudget || item.traceSteps === storedBudget - 1));
    const tracedFailure = result.cases.some((item) => item.failure?.origin === 'program' || item.failure?.origin === 'limit');
    const tracedCompileFailure = id === 'cpp-trace-compile' && result.status === 'compile-failed' &&
      result.compileFailure?.origin === 'program';
    const witnessed = kind === 'compile-failure' ? result.status === 'compile-failed'
      : kind === 'trace-limit' ? hasLimit(traceLimits) || cppSoftCutoff ||
        result.cases.some(({ attachment, traceSteps }) => attachment?.status === 'truncated' && (traceSteps ?? 0) > 0)
      : kind === 'runaway' ? hasLimit(runawayLimits)
      : kind === 'all' ? result.cases.some((item) => (item.traceSteps ?? 0) > 0) || tracedCompileFailure ||
        (tracedFailure && (id === 'runtime-error' || id === 'recursive-limit'))
      : kind === 'first-drawing' ? result.cases.some((item) => (item.traceSteps ?? 0) > 0)
      : result.cases.some((item) => item.status === 'completed');
    return { kind, result, limitControl, cppSoftCutoff, witnessed };
  } catch (error) {
    return { kind, rejection: errorText(error), witnessed: false };
  }
}

export async function abandonCheck(flavor: Flavor) {
  const { abandoned, host: desktopHost, iosHost } = current();
  const executionId = abandoned[flavor];
  const host = flavor === 'ios' ? iosHost : desktopHost;
  if (!host || !executionId) throw new Error('No retained execution to check');
  const result = await host.execute({ executionId, tracing: { caseIds: ['case-2'] } });
  await host.disposeExecution(executionId);
  delete abandoned[flavor];
  return traceEvidence(result.evaluation);
}

export function close() {
  state?.iosHost?.dispose();
  state?.host.dispose();
  state = undefined;
}

let measurement: { drawing: Host; verdict?: Host } | undefined;

export async function openDrawingHost(language: Language) {
  const drawing = createHost(language);
  measurement = { drawing };
  const result = await drawing.evaluateAlgorithm({ bundle: await bundle(language, simple(language, 'drawing'), 'practice') });
  if (!result.evaluation.cases.every((item) => item.verdict.kind === 'passed') || !result.evaluation.cases.length) {
    throw new Error('Drawing host did not complete successfully');
  }
}

export async function measureSecondHost(language: Language, warm: boolean) {
  if (!measurement) throw new Error('No drawing host running');
  const program = await bundle(language, simple(language, 'verdict-measurement'));
  const start = performance.now();
  const verdict = createHost(language);
  const created = performance.now();
  measurement.verdict = verdict;
  const warmResult = warm ? await verdict.warmLanguage(language) : undefined;
  const ready = performance.now();
  const result = await verdict.execute({ bundle: program, stopAtFirstRunaway: true });
  const end = performance.now();
  if (warmResult?.success === false || !result.evaluation.cases.length ||
      !result.evaluation.cases.every((item) => item.verdict.kind === 'passed')) {
    throw new Error('Verdict host did not complete successfully');
  }
  return { warm, creationMs: created - start, warmupMs: warm ? ready - created : null,
    readyToVerdictMs: end - ready, creationToVerdictMs: end - start };
}

export function closeMeasurement() {
  measurement?.verdict?.dispose();
  measurement?.drawing.dispose();
  measurement = undefined;
}

type AbortShape = 'evaluate' | 'interactive';
type AbortPoint = 'prepare' | 'execute' | 'reply';
type WorkerEnvelope = {
  id?: string | number;
  type?: string;
  ok?: boolean;
  payload?: { phase?: string; stage?: string };
};

const preparationCommands = new Set(['prepare-execution', 'prepare-program', 'prepare-runtime-program']);
const executionCommands = new Set([
  'execute-with-tracing', 'execute-batch', 'execute-prepared-program',
  'execute-prepared-program-batch', 'execute-prepared-runtime-program',
  'execute-prepared-runtime-program-batch', 'execute-prepared-trace', 'observe-execution',
]);
const NativeWorker = globalThis.Worker;
let watchWorker: ((worker: Worker, direction: 'out' | 'in', envelope: WorkerEnvelope) => void) | undefined;
let workerGeneration = 0;
const workerRoutes: Array<{ generation: number; route: string; command: string }> = [];

export function takeWorkerRoutes() {
  return workerRoutes.splice(0);
}

// Preserve the app's host options and observe the existing transport. The
// listener is installed before the provider attaches its response handler.
class ObservedWorker extends NativeWorker {
  readonly #generation = ++workerGeneration;
  readonly #route: string;

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const runtimeUrl = new URL(String(url), location.href);
    this.#route = runtimeUrl.pathname.endsWith('/javascript-ses-algorithm-worker.js')
      ? 'ses-compartment-pool'
      : runtimeUrl.pathname.endsWith('/javascript-worker.js')
        ? runtimeUrl.searchParams.get('tracecodeRole') ?? 'classic'
        : '';
    this.addEventListener('message', ({ data }) => {
      if (data && typeof data === 'object') watchWorker?.(this, 'in', data);
    });
  }

  postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
    super.postMessage(message, transferOrOptions as StructuredSerializeOptions | undefined);
    if (message && typeof message === 'object') {
      const envelope = message as WorkerEnvelope;
      watchWorker?.(this, 'out', envelope);
      if (this.#route && envelope.type &&
          (executionCommands.has(envelope.type) || preparationCommands.has(envelope.type) || envelope.type === 'execute-code')) {
        workerRoutes.push({ generation: this.#generation, route: this.#route, command: envelope.type });
      }
    }
  }
}

function observeWorkerTransport() {
  if (globalThis.Worker !== ObservedWorker) globalThis.Worker = ObservedWorker;
}

async function evaluatePlain(host: Host, id = 'correct') {
  const program = current().programs.get(id);
  if (!program) throw new Error(`No bundle for ${id}`);
  const start = performance.now();
  try {
    const evaluated = await host.evaluateAlgorithm({
      bundle: program.plain, stopAtFirstRunaway: program.stopAtFirstRunaway,
    });
    return { observed: observe(evaluated.evaluation), elapsedMs: performance.now() - start };
  } catch (error) {
    return { observed: { status: 'host-rejected', ...errorText(error) },
      elapsedMs: performance.now() - start };
  }
}

export async function evaluateFresh() {
  const host = createHost(current().language);
  try {
    return await evaluatePlain(host);
  } finally {
    host.dispose();
  }
}

export function measureIdleVerdict() {
  return evaluatePlain(current().host);
}

export async function abortTrial(shape: AbortShape, point: AbortPoint, firstRequest: boolean, faultProbe?: string) {
  const { language, host: warmHost } = current();
  const host = firstRequest ? createHost(language) : warmHost;
  const fault = faultProbe && language === 'cpp' ? cppTraceFaultProbes().find(({ id }) => id === faultProbe) : undefined;
  if (faultProbe && !fault) throw new Error(`No C++ fault probe ${faultProbe}`);
  const drawing = fault ?? (point === 'execute'
    ? simple(language, 'abort-drawing', costlyLoop[language], undefined, [2])
    : simple(language, 'abort-drawing', undefined, undefined, [3]));
  const traced = await bundle(language, { ...drawing, cases: drawing.cases.slice(0, 1) }, 'practice');
  const controller = new AbortController();
  let latch: { worker: Worker; id: string | number; command: string } | undefined;
  let trigger: string | undefined;
  let abortToVerdict: ReturnType<typeof evaluatePlain> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let traceSettled = false;

  function abortAndEvaluate(at: string) {
    if (traceSettled || trigger) return;
    trigger = at;
    controller.abort(new DOMException('Aborted', 'AbortError'));
    // Intentionally submit in the same tick, before awaiting rejection or
    // cleanup of the previous request. This is the application's handoff.
    abortToVerdict = evaluatePlain(host);
  }

  observeWorkerTransport();
  watchWorker = (worker, direction, envelope) => {
    const { id, type } = envelope;
    if (id === undefined || trigger) return;
    if (direction === 'out' && type && !latch) {
      if (point === 'prepare' && preparationCommands.has(type)) {
        latch = { worker, id, command: type };
        queueMicrotask(() => abortAndEvaluate(`posted ${type}`));
      } else if (point !== 'prepare' && executionCommands.has(type)) {
        latch = { worker, id, command: type };
        if (point === 'execute') {
          // For providers without a case-start event, cancel the execution
          // RPC while it is outstanding. Only the wire boundary is observable.
          timer = setTimeout(() => abortAndEvaluate(`in-flight ${type}`), 0);
        }
      }
      return;
    }
    if (direction !== 'in' || latch?.worker !== worker || latch.id !== id) return;
    if (point === 'execute' &&
        ((type === 'batch-case-progress' && envelope.payload?.phase === 'started') ||
         (type === 'runtime-progress' && envelope.payload?.stage === 'request-start'))) {
      abortAndEvaluate(`${type} start`);
    }
    if (point === 'reply' &&
        (type === latch.command || type === 'execute-result' || type === 'error' || envelope.ok === true)) {
      abortAndEvaluate(`received ${type ?? latch.command} reply`);
    }
  };

  try {
    let settled;
    try {
      if (shape === 'evaluate') {
        const result = await host.evaluateAlgorithm({ bundle: traced, signal: controller.signal });
        settled = { status: 'resolved', evaluation: traceEvidence(result.evaluation) };
      } else {
        const result = await host.execute({
          bundle: traced, interactive: true, tracing: { caseIds: [traced.plan.cases[0]!.id] },
          signal: controller.signal,
        });
        if (result.executionId) await host.disposeExecution(result.executionId);
        settled = { status: 'resolved', evaluation: traceEvidence(result.evaluation) };
      }
    } catch (error) {
      settled = { status: 'rejected', ...errorText(error) };
    } finally {
      traceSettled = true;
    }
    const after = await abortToVerdict;
    const firstHostBatches: Record<string, Awaited<ReturnType<typeof executePlain>>> = {};
    if (firstRequest && after) {
      for (const [id, program] of current().programs) {
        if (program.firstCase) firstHostBatches[id] = await executePlain(host, program.plain, true);
      }
    }
    return {
      shape, point, firstRequest, trigger, command: latch?.command, settled, after, firstHostBatches,
      witnessed: trigger !== undefined && settled.status === 'rejected' &&
        'name' in settled && settled.name === 'AbortError',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    watchWorker = undefined;
    if (firstRequest) host.dispose();
  }
}
