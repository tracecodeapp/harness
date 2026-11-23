import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
  isRuntimeProviderError,
  judgeCaseExecutionOutcome,
} from '../../src/judge';
import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';

/**
 * Page side of tests/test-lost-worker-provider-origin-browser.ts.
 *
 * `installWorkerLossInjection` replaces the page's `Worker` with a subclass
 * that, while armed, terminates the worker and fires its `error` event right
 * after posting a message that carries the learner's inputs. The host loses
 * the worker after it dispatched the learner's code, for a reason the program
 * did not cause.
 */

export type LostWorkerLanguage = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';
export type LostWorkerMode = 'code' | 'code-batch' | 'trace' | 'trace-batch';

export interface LostWorkerObservation {
  readonly language: LostWorkerLanguage;
  readonly mode: LostWorkerMode;
  readonly probe: string;
  /**
   * threw:<text> when the host rejected, otherwise the Judge's outcome:
   * compile:<status>:<origin> or one case:<status>:<origin> per case.
   */
  readonly outcome: readonly string[];
  readonly threw?: string;
  readonly typedCauses?: readonly string[];
  readonly cases?: readonly {
    readonly id: string;
    readonly verdict: string;
    readonly value?: unknown;
    readonly conversion: string;
  }[];
  /** Each case's (or the compile's) failure message, when it has one. */
  readonly messages?: readonly string[];
  /** Message types the injection answered by losing the worker. */
  readonly lostAfter: readonly string[];
  readonly injectionAcks?: readonly string[];
  readonly elapsedMs: number;
}

interface Program {
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: 'function' | 'solution-method';
}

type Boundary = 'dispatch' | 'before-start' | 'after-a-finish' | 'after-b-start' | 'result-decode';
const injection = {
  boundary: undefined as Boundary | undefined,
  lostAfter: [] as string[],
  hits: [] as string[],
  failureText: 'Execution did not complete',
};

/** Every case's input is `{ n: <number> }`. */
function isCaseInput(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { n?: unknown }).n === 'number'
  );
}

/**
 * The message runs one of the bundle's cases. Preparation-time executions
 * (C# probes its runner before any case) carry other inputs and are left
 * alone: a worker lost there is already the provider's.
 */
function carriesCaseInputs(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : undefined;
  return [record, payload].some((candidate) =>
    candidate !== undefined && (
      isCaseInput(candidate.inputs) ||
      (Array.isArray(candidate.inputBatch) && candidate.inputBatch.some(isCaseInput))
    )
  );
}

export function installWorkerLossInjection(): void {
  const scope = globalThis as unknown as { Worker: typeof Worker; __lostWorkerInstalled__?: boolean };
  if (scope.__lostWorkerInstalled__) return;
  scope.__lostWorkerInstalled__ = true;
  const RealWorker = scope.Worker;
  scope.Worker = class LosableWorker extends RealWorker {
    private pendingExecutions = new Map<unknown, string>();

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event: MessageEvent) => {
        const { id, type, payload } = event.data ?? {};
        const request = this.pendingExecutions.get(id);
        if (!request || !injection.boundary) return;
        if (type === 'batch-case-progress') {
          const stage = payload?.index === 0 && payload.phase === 'finished' ? 'after-a-finish'
            : payload?.index === 1 && payload.phase === 'started' ? 'after-b-start' : undefined;
          if (injection.boundary === stage && !injection.hits.length) {
            injection.hits.push(`${stage}:${id}`);
            // The cut comes from the worker's message. Delivery to the
            // provider and retention of the completed prefix are separate checks.
            queueMicrotask(() => this.lose(request));
          }
          return;
        }
        if (injection.boundary === 'result-decode' && type === request && payload && typeof payload === 'object') {
          this.pendingExecutions.delete(id);
          if (injection.hits.length) return;
          injection.hits.push(`result-decode:${id}`);
          injection.lostAfter.push(request);
          event.stopImmediatePropagation();
          this.dispatchEvent(new MessageEvent('message', {
            data: { ...event.data, payload: { ...payload, __traceEventTransport: null } },
          }));
        }
      });
    }

    private lose(request: string) {
      injection.lostAfter.push(request);
      this.terminate();
      this.dispatchEvent(new ErrorEvent('error', { message: injection.failureText }));
    }

    override postMessage(message: unknown, ...rest: unknown[]): void {
      const { id, type } = (message ?? {}) as { id?: unknown; type?: unknown };
      const learnerRequest = typeof type === 'string' && /^execute/u.test(type) && carriesCaseInputs(message);
      const boundary = injection.boundary;
      if (boundary === 'before-start' && learnerRequest) {
        injection.hits.push(`${boundary}:${id}`);
        this.lose(type);
        return;
      }
      if (boundary && learnerRequest) this.pendingExecutions.set(id, type);
      (RealWorker.prototype.postMessage as (...args: unknown[]) => void).call(this, message, ...rest);
      if (boundary === 'dispatch' && learnerRequest) {
        injection.hits.push(`${boundary}:${id}`);
        this.lose(type);
      }
    }
  } as typeof Worker;
}

function healthyProgram(language: LostWorkerLanguage): Program {
  switch (language) {
    case 'python':
      return { code: 'def solve(n):\n    return n + 1\n', functionName: 'solve', executionStyle: 'function' };
    case 'javascript':
      return { code: 'function solve(n) {\n  return n + 1;\n}\n', functionName: 'solve', executionStyle: 'function' };
    case 'typescript':
      return { code: 'function solve(n: number): number {\n  return n + 1;\n}\n', functionName: 'solve', executionStyle: 'function' };
    case 'java':
      return { code: 'class Solution {\n  public int solve(int n) {\n    return n + 1;\n  }\n}\n', functionName: 'solve', executionStyle: 'solution-method' };
    case 'csharp':
      return { code: 'public class Solution {\n  public int Solve(int n) {\n    return n + 1;\n  }\n}\n', functionName: 'Solve', executionStyle: 'solution-method' };
    case 'cpp':
      return { code: 'class Solution {\npublic:\n  int solve(int n) {\n    return n + 1;\n  }\n};\n', functionName: 'solve', executionStyle: 'solution-method' };
  }
}

/** Learner programs that fail on their own; each must stay the program's (or its limit). */
function learnerPrograms(language: LostWorkerLanguage): Readonly<Record<string, Program>> {
  switch (language) {
    case 'python': {
      const fn = (body: string): Program => ({
        code: `import sys\n\ndef solve(n):\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n`,
        functionName: 'solve',
        executionStyle: 'function',
      });
      return {
        raises: fn('raise ValueError("boom")'),
        'sys-exit': fn('sys.exit(3)'),
        'deep-recursion': fn('return solve(n + 1) + 1'),
        'memory-exhaustion': fn('blocks = []\nwhile True:\n    blocks.append(bytearray(64 * 1024 * 1024))'),
        'time-limit': fn('while True:\n    n += 1'),
      };
    }
    case 'csharp': {
      const method = (body: string): Program => ({
        code: `using System;\nusing System.Collections.Generic;\npublic class Solution {\n  public int Solve(int n) {\n${body}\n  }\n}\n`,
        functionName: 'Solve',
        executionStyle: 'solution-method',
      });
      return {
        raises: method('    throw new InvalidOperationException("boom");'),
        'environment-exit': method('    Environment.Exit(3);\n    return n;'),
        'deep-recursion': method('    return Solve(n + 1) + 1;'),
        'memory-exhaustion': method('    var blocks = new List<byte[]>();\n    while (blocks.Count >= 0) blocks.Add(new byte[64 * 1024 * 1024]);\n    return blocks.Count;'),
        'time-limit': method('    while (n > 0) n = n == 1 ? 2 : 1;\n    return n;'),
      };
    }
    default:
      return {};
  }
}

function createHost(assetBaseUrl: string, language: LostWorkerLanguage) {
  return createBrowserJudgeHost({
    assetBaseUrl,
    providers: [language],
    ...(language === 'cpp'
      ? {
          assets: { runtimeManifests: { cpp: createTraceCCRuntimeManifest('/tracecc') } },
          // The web app's C++ configuration.
          cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
        }
      : {}),
  });
}

type Host = ReturnType<typeof createHost>;

let sequence = 0;

async function evaluate(
  host: Host,
  language: LostWorkerLanguage,
  program: Program,
  mode: LostWorkerMode,
  limits?: { readonly wallClockMs: number },
  boundaryBatch = false,
): Promise<Pick<LostWorkerObservation, 'outcome' | 'threw' | 'messages' | 'typedCauses' | 'cases'>> {
  sequence += 1;
  const caseCount = boundaryBatch ? 3 : mode === 'code' || mode === 'trace' ? 1 : 2;
  const bundle = await createAlgorithmJudgeBundle({
    id: `lost-worker-${language}-${mode}-${sequence}`,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index + 1}`,
      input: { n: boundaryBatch ? (index + 1) * 11 : index + 1 },
      ...(boundaryBatch ? { expected: (index + 1) * 11 + 1 } : {}),
    })),
    trace: mode === 'trace' || mode === 'trace-batch',
    ...(limits ? { limits } : {}),
  });
  try {
    const receipt = await host.evaluateAlgorithm({
      bundle,
      stopAtFirstRunaway: boundaryBatch,
      signal: AbortSignal.timeout(110_000),
    });
    const { evaluation } = receipt;
    const cause = (failure: { origin: string; stage?: string; reason?: string } | undefined) =>
      failure ? `${failure.origin}:${failure.stage ?? failure.reason}` : 'none';
    if (evaluation.status === 'compile-failed') {
      return {
        outcome: [`compile:${evaluation.compile.status}:${evaluation.compile.failure?.origin ?? 'none'}`],
        messages: [evaluation.compile.failure?.message?.slice(0, 300) ?? ''],
        typedCauses: [cause(evaluation.compile.failure)],
      };
    }
    return {
      outcome: evaluation.cases.map((testCase) =>
        `case:${testCase.status}:${testCase.failure?.origin ?? 'none'}`
      ),
      messages: evaluation.cases.map((testCase) => testCase.failure?.message?.slice(0, 300) ?? ''),
      typedCauses: evaluation.cases.map(({ failure }) => cause(failure)),
      cases: evaluation.cases.map((row) => {
        let conversion;
        try {
          conversion = judgeCaseExecutionOutcome(row, { language }).kind;
        } catch (error) {
          conversion = isRuntimeProviderError(error) ? `provider:${error.reason}` : 'unclassified';
        }
        return { id: row.caseId, verdict: row.verdict.kind, value: row.value, conversion };
      }),
    };
  } catch (error) {
    const text = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    const inner = error instanceof Error ? error.cause : undefined;
    const provider = isRuntimeProviderError(error) ? error : isRuntimeProviderError(inner) ? inner : undefined;
    return {
      outcome: [`threw:${text.slice(0, 300)}`], threw: text.slice(0, 600),
      typedCauses: provider ? [`provider:${provider.reason}`] : [],
    };
  }
}

export interface LostWorkerOptions {
  readonly assetBaseUrl: string;
  readonly language: LostWorkerLanguage;
  readonly modes: readonly LostWorkerMode[];
  readonly learner: boolean;
}

export async function runLostWorkerProbes(
  options: LostWorkerOptions
): Promise<LostWorkerObservation[]> {
  installWorkerLossInjection();
  const { language } = options;
  const observations: LostWorkerObservation[] = [];
  for (const mode of options.modes) {
    // A fresh host per probe: the injection loses every worker the host
    // dispatches learner code to.
    const host = createHost(options.assetBaseUrl, language);
    injection.lostAfter = [];
    injection.hits = [];
    injection.boundary = 'dispatch';
    const startedAt = performance.now();
    try {
      const result = await evaluate(host, language, healthyProgram(language), mode);
      observations.push({
        language,
        mode,
        probe: 'worker-lost-after-dispatch',
        ...result,
        lostAfter: [...injection.lostAfter],
        injectionAcks: [...injection.hits],
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } finally {
      injection.boundary = undefined;
      host.dispose();
    }
  }
  // Startup loss is injected at the first learner command on every default
  // route. Python's real stopping-batch progress also admits phase-specific
  // cuts and its reply decoder has a transferable result envelope.
  const boundaries: readonly Boundary[] = language === 'python'
    ? ['before-start', 'after-a-finish', 'after-b-start', 'result-decode'] : ['before-start'];
  if (options.modes.includes('code-batch')) for (const boundary of boundaries) {
    const host = createHost(options.assetBaseUrl, language);
    injection.lostAfter = [];
    injection.hits = [];
    injection.boundary = boundary;
    const startedAt = performance.now();
    try {
      const result = await evaluate(host, language, healthyProgram(language), 'code-batch', undefined, true);
      observations.push({
        language, mode: 'code-batch', probe: boundary, ...result,
        lostAfter: [...injection.lostAfter], injectionAcks: [...injection.hits],
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } finally {
      injection.boundary = undefined;
      host.dispose();
    }
  }
  if (options.learner) {
    const host = createHost(options.assetBaseUrl, language);
    try {
      for (const [probe, program] of Object.entries(learnerPrograms(language))) {
        for (const mode of options.modes) {
          const startedAt = performance.now();
          const result = await evaluate(
            host,
            language,
            program,
            mode,
            probe === 'time-limit' ? { wallClockMs: 3_000 }
              : probe === 'memory-exhaustion' ? { wallClockMs: 10_000 }
              : undefined
          );
          observations.push({
            language,
            mode,
            probe,
            ...result,
            lostAfter: [],
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }
      }
    } finally {
      host.dispose();
    }
  }
  return observations;
}
