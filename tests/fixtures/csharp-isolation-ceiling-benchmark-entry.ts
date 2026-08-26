import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

type Strategy = 'compatibility' | 'algorithm-fast';

interface ObservedRun {
  readonly strategy: Strategy;
  readonly caseCount: number;
  readonly elapsedMs: number;
  readonly workerCount: number;
  readonly maximumActiveWorkers: number;
  readonly verdict: string;
  readonly passedCases: number;
}

declare global {
  var runCSharpIsolationCeilingBenchmark:
    | ((
        assetBaseUrl: string,
        rounds: number,
        strategies: readonly Strategy[]
      ) => Promise<readonly ObservedRun[]>)
    | undefined;
}

function sourceFor(strategy: Strategy): string {
  return [
    'using System;',
    'using System.Collections.Generic;',
    ...(strategy === 'compatibility' ? ['using System.IO;'] : []),
    'public class Solution {',
    '  public bool ContainsDuplicate(int[] nums) {',
    ...(strategy === 'compatibility'
      ? [
          '    // Compiler-visible capability reference forces the broad compatibility tier.',
          '    if (nums.Length < 0) _ = File.Exists("/tmp/never");',
        ]
      : []),
    '    var seen = new HashSet<int>();',
    '    foreach (int value in nums) {',
    '      if (!seen.Add(value)) return true;',
    '    }',
    '    return false;',
    '  }',
    '}',
  ].join('\n');
}

function cases(count: number): Array<{
  id: string;
  input: { nums: number[] };
  expected: boolean;
}> {
  return Array.from({ length: count }, (_, index) => {
    const length = 170 + (index % 100);
    const nums = Array.from({ length }, (_unused, offset) =>
      index * 10_000 + offset
    );
    const expected = index % 2 === 1;
    if (expected) nums[nums.length - 1] = nums[0]!;
    return {
      id: `${count}-${index + 1}`,
      input: { nums },
      expected,
    };
  });
}

globalThis.runCSharpIsolationCeilingBenchmark = async (
  assetBaseUrl: string,
  rounds: number,
  strategies: readonly Strategy[]
): Promise<readonly ObservedRun[]> => {
  const NativeWorker = globalThis.Worker;
  const results: ObservedRun[] = [];
  for (const strategy of strategies) {
    for (const caseCount of [10, 100] as const) {
      for (let round = 0; round < rounds; round += 1) {
        const workerUrls: string[] = [];
        let activeWorkers = 0;
        let maximumActiveWorkers = 0;
        class ObservedWorker extends NativeWorker {
          private retired = false;

          constructor(url: string | URL, options?: WorkerOptions) {
            workerUrls.push(String(url));
            super(url, options);
            activeWorkers += 1;
            maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
          }

          override terminate(): void {
            if (!this.retired) {
              this.retired = true;
              activeWorkers -= 1;
            }
            super.terminate();
          }
        }
        globalThis.Worker = ObservedWorker;
        const host = createBrowserJudgeHost({
          assetBaseUrl,
          providers: ['csharp'],
          csharp: { preparedBatchConcurrency: 4 },
          safeExecution: { prewarmAfterUse: false },
        });
        try {
          await host.warmLanguage('csharp');
          workerUrls.length = 0;
          activeWorkers = 0;
          maximumActiveWorkers = 0;
          const bundle = await createAlgorithmJudgeBundle({
            id: `csharp-isolation-${strategy}-${caseCount}-${round}`,
            language: 'csharp',
            code: sourceFor(strategy),
            functionName: 'ContainsDuplicate',
            executionStyle: 'solution-method',
            cases: cases(caseCount),
          });
          const startedAt = performance.now();
          const receipt = await host.evaluateAlgorithm({ bundle });
          const elapsedMs = performance.now() - startedAt;
          const passedCases = receipt.evaluation.status === 'completed'
            ? receipt.evaluation.cases.filter(
                (testCase) => testCase.verdict.kind === 'passed'
              ).length
            : 0;
          results.push({
            strategy,
            caseCount,
            elapsedMs,
            workerCount: workerUrls.filter((url) =>
              url.includes('csharp-worker.js')
            ).length,
            maximumActiveWorkers,
            verdict: receipt.verdict,
            passedCases,
          });
        } finally {
          host.dispose();
          globalThis.Worker = NativeWorker;
        }
      }
    }
  }
  return results;
};

