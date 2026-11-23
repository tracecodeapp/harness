import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
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
  /** Message types the injection answered by losing the worker. */
  readonly lostAfter: readonly string[];
  readonly elapsedMs: number;
}

interface Program {
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: 'function' | 'solution-method';
}

const injection = {
  armed: false,
  lostAfter: [] as string[],
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
    override postMessage(message: unknown, ...rest: unknown[]): void {
      (RealWorker.prototype.postMessage as (...args: unknown[]) => void).call(this, message, ...rest);
      const type = (message as { type?: unknown } | null)?.type;
      if (
        injection.armed &&
        typeof type === 'string' &&
        /^execute/u.test(type) &&
        carriesCaseInputs(message)
      ) {
        injection.lostAfter.push(type);
        this.terminate();
        this.dispatchEvent(new ErrorEvent('error', {
          message: `injected: worker lost after dispatch ${type}`,
        }));
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
  limits?: { readonly wallClockMs: number }
): Promise<{ outcome: string[]; threw?: string }> {
  sequence += 1;
  const caseCount = mode === 'code' || mode === 'trace' ? 1 : 2;
  const bundle = await createAlgorithmJudgeBundle({
    id: `lost-worker-${language}-${mode}-${sequence}`,
    language,
    code: program.code,
    functionName: program.functionName,
    executionStyle: program.executionStyle,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${index + 1}`,
      input: { n: index + 1 },
    })),
    trace: mode === 'trace' || mode === 'trace-batch',
    ...(limits ? { limits } : {}),
  });
  try {
    const receipt = await host.evaluateAlgorithm({
      bundle,
      stopAtFirstRunaway: false,
      signal: AbortSignal.timeout(110_000),
    });
    const { evaluation } = receipt;
    if (evaluation.status === 'compile-failed') {
      return {
        outcome: [`compile:${evaluation.compile.status}:${evaluation.compile.failure?.origin ?? 'none'}`],
      };
    }
    return {
      outcome: evaluation.cases.map((testCase) =>
        `case:${testCase.status}:${testCase.failure?.origin ?? 'none'}`
      ),
    };
  } catch (error) {
    const text = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    return { outcome: [`threw:${text.slice(0, 300)}`], threw: text.slice(0, 600) };
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
    injection.armed = true;
    const startedAt = performance.now();
    try {
      const result = await evaluate(host, language, healthyProgram(language), mode);
      observations.push({
        language,
        mode,
        probe: 'worker-lost-after-dispatch',
        ...result,
        lostAfter: [...injection.lostAfter],
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } finally {
      injection.armed = false;
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
