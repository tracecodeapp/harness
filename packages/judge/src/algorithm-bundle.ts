import {
  ALGORITHM_BUNDLE_SCHEMA,
  type JudgeAlgorithmBundle,
  type JudgeAlgorithmExecution,
} from './algorithm-model';
import type {
  JudgeComparatorPolicy,
  JudgeComparatorStrategy,
} from './comparator-strategy';
import type { JudgeFact } from './facts';
import type { JudgeCasePlan } from './model';
import { allCasesPassPolicy } from './algorithm-evaluate';
import type { JudgeVerdictPolicy } from './policy';

export type JudgeAlgorithmLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'csharp'
  | 'cpp';

export interface JudgeAlgorithmSourceCase<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
> {
  readonly id: string;
  readonly input: Input;
  readonly expected?: Expected;
  readonly comparator?: JudgeComparatorStrategy;
}

export type UnboundJudgeFact<Value = unknown> =
  Omit<JudgeFact<Value>, 'subject'> & {
    readonly entrypoint?: string;
  };

export interface CreateAlgorithmJudgeBundleOptions<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
> {
  readonly id: string;
  readonly language: JudgeAlgorithmLanguage;
  readonly code: string;
  readonly functionName?: string | null;
  readonly executionStyle?: JudgeAlgorithmExecution['executionStyle'];
  readonly cases: readonly JudgeAlgorithmSourceCase<Input, Expected>[];
  readonly comparison?: JudgeComparatorStrategy;
  readonly policy?: JudgeVerdictPolicy;
  readonly facts?: readonly UnboundJudgeFact[];
  readonly limits?: JudgeAlgorithmExecution['limits'];
  readonly trace?: boolean;
  readonly traceOptions?: JudgeAlgorithmExecution['traceOptions'];
}

function safeSourceSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return normalized || 'solution';
}

export function algorithmSourcePath(
  language: JudgeAlgorithmLanguage,
  functionName?: string | null
): string {
  const base = safeSourceSegment(functionName ?? 'solution');
  switch (language) {
    case 'python':
      return `/workspace/${base}.py`;
    case 'javascript':
      return `/workspace/${base}.js`;
    case 'typescript':
      return `/workspace/${base}.ts`;
    case 'java':
      return '/workspace/Solution.java';
    case 'csharp':
      return '/workspace/Solution.cs';
    case 'cpp':
      return `/workspace/${base}.cpp`;
  }
}

export async function algorithmWorkspaceDigest(input: {
  readonly language: JudgeAlgorithmLanguage;
  readonly sourcePath: string;
  readonly code: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    `tracecode.judge.algorithm-source.v1\0${input.language}\0${input.sourcePath}\0${input.code}`
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function comparisonPolicy<
  Input extends Record<string, unknown>,
  Expected,
>(
  options: CreateAlgorithmJudgeBundleOptions<Input, Expected>
): JudgeComparatorPolicy | undefined {
  const cases = Object.fromEntries(
    options.cases.flatMap((testCase) =>
      testCase.comparator
        ? [[testCase.id, testCase.comparator]]
        : []
    )
  );
  if (!options.comparison && Object.keys(cases).length === 0) return undefined;
  return {
    schema: 'tracecode.judge.comparator-policy.v1',
    default: options.comparison ?? {
      schema: 'tracecode.judge.comparator.v1',
      mode: 'exact',
    },
    ...(Object.keys(cases).length > 0 ? { cases } : {}),
  };
}

function planCases<
  Input extends Record<string, unknown>,
  Expected,
>(
  cases: readonly JudgeAlgorithmSourceCase<Input, Expected>[]
): readonly JudgeCasePlan<Input, Expected>[] {
  return cases.map((testCase) => ({
    id: testCase.id,
    input: testCase.input,
    ...(Object.prototype.hasOwnProperty.call(testCase, 'expected')
      ? { expected: testCase.expected }
      : {}),
  }));
}

/**
 * Lowers product-owned algorithm content into the complete, serializable
 * Judge authority contract. Browser and mux callers use this same builder;
 * language runtimes never own expected values, comparators, or verdicts.
 */
export async function createAlgorithmJudgeBundle<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Expected = unknown,
>(
  options: CreateAlgorithmJudgeBundleOptions<Input, Expected>
): Promise<JudgeAlgorithmBundle<Input, Expected>> {
  const sourcePath = algorithmSourcePath(
    options.language,
    options.functionName
  );
  const workspaceDigest = await algorithmWorkspaceDigest({
    language: options.language,
    sourcePath,
    code: options.code,
  });
  const comparison = comparisonPolicy(options);
  return {
    schema: ALGORITHM_BUNDLE_SCHEMA,
    id: options.id,
    workspaceDigest,
    execution: {
      sourcePath,
      ...(options.functionName !== undefined
        ? { functionName: options.functionName }
        : {}),
      ...(options.executionStyle !== undefined
        ? { executionStyle: options.executionStyle }
        : {}),
      ...(options.trace === true ? { trace: true } : {}),
      ...(options.traceOptions !== undefined
        ? { traceOptions: options.traceOptions }
        : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
    },
    plan: {
      id: options.id,
      runtime: options.language,
      workspace: {
        cwd: '/workspace',
        files: [{
          path: sourcePath,
          contents: options.code,
          visibility: 'submission',
        }],
      },
      driver: { files: [] },
      run: {
        command: 'judge-runtime-run',
        ...(options.limits?.wallClockMs !== undefined
          ? { timeoutMs: options.limits.wallClockMs }
          : {}),
      },
      cases: planCases(options.cases),
      isolation: {
        mode: 'fresh-session-per-case',
      },
    },
    policy: options.policy ?? allCasesPassPolicy(),
    ...(comparison ? { comparison } : {}),
    ...(options.facts
      ? {
          facts: options.facts.map(({ entrypoint, ...fact }) => ({
            ...fact,
            subject: {
              workspaceDigest,
              ...(entrypoint ? { entrypoint } : {}),
            },
          })),
        }
      : {}),
  };
}
