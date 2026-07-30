import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALGORITHM_BUNDLE_SCHEMA,
  algorithmSourcePath,
  createAlgorithmJudgeBundle,
  createAlgorithmJudgeReceipt,
  createJudgeComparator,
  validateAlgorithmJudgeBundle,
  type JudgeAlgorithmBundle,
  type JudgeEvaluationResult,
  type JudgeFact,
} from '../src/index';
import * as Effect from 'effect/Effect';

function completedEvaluation(
  verdicts: readonly ('passed' | 'failed')[]
): JudgeEvaluationResult {
  return {
    planId: 'binary-search',
    status: 'completed',
    cases: verdicts.map((verdict, index) => ({
      sessionId: `session-${index}`,
      pid: index + 1,
      termination: { kind: 'exit', exitCode: 0 },
      stdout: '',
      stderr: '',
      diagnostics: [],
      timedOut: false,
      caseId: `case-${index}`,
      status: 'completed',
      value: index,
      expected: index,
      verdict: verdict === 'passed'
        ? {
            kind: 'passed',
            comparatorId: 'test',
            comparison: { matched: true },
          }
        : {
            kind: 'failed',
            comparatorId: 'test',
            comparison: { matched: false },
          },
    })),
  };
}

function complexityFact(
  workspaceDigest: string,
  value: string
): JudgeFact<string> {
  return {
    id: 'runtimeComplexity',
    schema: 1,
    value,
    subject: { workspaceDigest, entrypoint: 'search' },
    producer: { id: 'semantic-engine', version: '3.0.0' },
    verification: 'browser-asserted',
    confidence: 0.9,
  };
}

function bundle(
  facts: readonly JudgeFact[]
): JudgeAlgorithmBundle {
  return {
    schema: ALGORITHM_BUNDLE_SCHEMA,
    id: 'binary-search-submission',
    workspaceDigest: 'sha256:submission',
    execution: {
      sourcePath: '/workspace/binary_search.py',
      functionName: 'search',
      executionStyle: 'solution-method',
    },
    plan: {
      id: 'binary-search',
      runtime: 'python',
      workspace: {
        files: [{
          path: '/workspace/binary_search.py',
          contents: 'def search(): pass',
          visibility: 'submission',
        }],
      },
      driver: { files: [] },
      run: { command: 'python' },
      cases: [{ id: 'case-1', input: {}, expected: 0 }],
    },
    facts,
    policy: {
      schema: 'tracecode.judge.verdict-policy.v1',
      requires: [{
        id: 'runtimeComplexity',
        schema: 1,
        producer: 'semantic-engine',
        minimumVerification: 'browser-asserted',
        minimumConfidence: 0.8,
      }],
      passWhen: {
        op: 'all',
        conditions: [
          {
            op: 'eq',
            left: { op: 'ref', path: 'allCasesPassed' },
            right: { op: 'literal', value: true },
          },
          {
            op: 'complexity-at-most',
            actual: { op: 'fact', id: 'runtimeComplexity' },
            expected: { op: 'literal', value: 'logarithmic' },
          },
        ],
      },
    },
  };
}

test('algorithm receipt combines case verdicts with a bound semantic fact', () => {
  const receipt = createAlgorithmJudgeReceipt(
    bundle([complexityFact('sha256:submission', 'logarithmic')]),
    completedEvaluation(['passed', 'passed']),
    '2026-01-01T00:00:00.000Z'
  );
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.passedCount, 2);
  assert.equal(receipt.totalCount, 2);
  assert.equal(receipt.policy.result, true);
});

test('algorithm receipt rejects slow, stale, and missing semantic evidence', () => {
  const slow = createAlgorithmJudgeReceipt(
    bundle([complexityFact('sha256:submission', 'linear')]),
    completedEvaluation(['passed'])
  );
  assert.equal(slow.verdict, 'failed');

  const stale = createAlgorithmJudgeReceipt(
    bundle([complexityFact('sha256:different', 'logarithmic')]),
    completedEvaluation(['passed'])
  );
  assert.equal(stale.verdict, 'indeterminate');
  assert.equal(stale.policy.missingFacts.length, 1);

  const failingCase = createAlgorithmJudgeReceipt(
    bundle([complexityFact('sha256:submission', 'logarithmic')]),
    completedEvaluation(['passed', 'failed'])
  );
  assert.equal(failingCase.verdict, 'failed');
});

test('declarative comparators preserve product comparison semantics', () => {
  const unordered = createJudgeComparator({
    schema: 'tracecode.judge.comparator.v1',
    mode: 'unordered-nested-array',
  });
  assert.equal(
    unordered.compare({
      planId: 'three-sum',
      caseId: 'one',
      input: {},
      expected: [[-1, 0, 1], [-1, -1, 2]],
      actual: [[2, -1, -1], [1, 0, -1]],
    }).matched,
    true
  );

  const twoSum = createJudgeComparator({
    schema: 'tracecode.judge.comparator.v1',
    customValidator: 'two-sum-indices',
  });
  assert.equal(
    twoSum.compare({
      planId: 'two-sum',
      caseId: 'one',
      input: { nums: [2, 7, 11, 15], target: 9 },
      expected: [0, 1],
      actual: [1, 0],
    }).matched,
    true
  );

  const byCase = createJudgeComparator({
    schema: 'tracecode.judge.comparator-policy.v1',
    default: {
      schema: 'tracecode.judge.comparator.v1',
      mode: 'exact',
    },
    cases: {
      flexible: {
        schema: 'tracecode.judge.comparator.v1',
        customValidator: 'two-sum-indices',
      },
    },
  });
  assert.equal(
    byCase.compare({
      planId: 'two-sum',
      caseId: 'strict',
      input: { nums: [2, 7], target: 9 },
      expected: [0, 1],
      actual: [1, 0],
    }).matched,
    false
  );
  assert.equal(
    byCase.compare({
      planId: 'two-sum',
      caseId: 'flexible',
      input: { nums: [2, 7], target: 9 },
      expected: [0, 1],
      actual: [1, 0],
    }).matched,
    true
  );
});

test('algorithm bundles remain JSON-portable and reject authority drift', async () => {
  const portable = bundle([
    complexityFact('sha256:submission', 'logarithmic'),
  ]);
  const roundTrip = JSON.parse(
    JSON.stringify(portable)
  ) as JudgeAlgorithmBundle;
  assert.deepEqual(roundTrip, portable);
  await Effect.runPromise(validateAlgorithmJudgeBundle(roundTrip));

  await assert.rejects(
    Effect.runPromise(validateAlgorithmJudgeBundle({
      ...roundTrip,
      comparison: {
        schema: 'tracecode.judge.comparator-policy.v1',
        default: {
          schema: 'tracecode.judge.comparator.v1',
          mode: 'exact',
        },
        cases: {
          missing: {
            schema: 'tracecode.judge.comparator.v1',
            mode: 'exact',
          },
        },
      },
    })),
    /unknown case/
  );

  let pathological: unknown = {
    op: 'eq',
    left: { op: 'literal', value: true },
    right: { op: 'literal', value: true },
  };
  for (let depth = 0; depth < 40; depth += 1) {
    pathological = { op: 'not', condition: pathological };
  }
  await assert.rejects(
    Effect.runPromise(validateAlgorithmJudgeBundle({
      ...roundTrip,
      policy: {
        schema: 'tracecode.judge.verdict-policy.v1',
        passWhen: pathological,
      },
    } as unknown as JudgeAlgorithmBundle)),
    /maximum expression depth/
  );

  await assert.rejects(
    Effect.runPromise(validateAlgorithmJudgeBundle({
      ...roundTrip,
      policy: {
        schema: 'tracecode.judge.verdict-policy.v1',
        passWhen: {
          op: 'eq',
          left: { op: 'ref', path: '__proto__.passed' },
          right: { op: 'literal', value: true },
        },
      },
    })),
    /reference path is unsafe/
  );

  await assert.rejects(
    Effect.runPromise(validateAlgorithmJudgeBundle({
      ...roundTrip,
      comparison: {
        schema: 'tracecode.judge.comparator-policy.v1',
        default: {
          schema: 'tracecode.judge.comparator.v1',
          customValidator: 'execute-product-callback',
        },
      },
    } as unknown as JudgeAlgorithmBundle)),
    /unsupported custom validator/
  );

  await assert.rejects(
    Effect.runPromise(validateAlgorithmJudgeBundle({
      ...roundTrip,
      facts: [{
        ...complexityFact('sha256:submission', 'logarithmic'),
        value: Number.POSITIVE_INFINITY,
      }],
    })),
    /numeric values must be finite/
  );
});

test('the shared bundle builder binds source, comparison, and facts to one workspace', async () => {
  const built = await createAlgorithmJudgeBundle({
    id: 'binary-search-attempt',
    language: 'python',
    code: 'def search(nums, target):\n    return -1\n',
    functionName: 'search',
    executionStyle: 'solution-method',
    cases: [{
      id: 'found',
      input: { nums: [1, 3, 5], target: 3 },
      expected: [1, 3],
      comparator: {
        schema: 'tracecode.judge.comparator.v1',
        mode: 'unordered-array',
      },
    }],
    comparison: {
      schema: 'tracecode.judge.comparator.v1',
      mode: 'exact',
    },
    facts: [{
      id: 'runtimeComplexity',
      schema: 1,
      value: 'logarithmic',
      entrypoint: 'search',
      producer: { id: 'semantic-engine', version: '3.0.0' },
      verification: 'browser-asserted',
    }],
  });

  assert.equal(
    built.execution.sourcePath,
    '/workspace/search.py'
  );
  assert.equal(
    built.plan.workspace.files[0]?.path,
    built.execution.sourcePath
  );
  assert.match(built.workspaceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    built.facts?.[0]?.subject.workspaceDigest,
    built.workspaceDigest
  );
  assert.equal(built.facts?.[0]?.subject.entrypoint, 'search');
  assert.equal(built.comparison?.default.mode, 'exact');
  assert.equal(
    built.comparison?.cases?.found?.mode,
    'unordered-array'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built);
  await Effect.runPromise(validateAlgorithmJudgeBundle(built));

  assert.equal(algorithmSourcePath('java', 'ignored'), '/workspace/Solution.java');
  assert.equal(algorithmSourcePath('csharp', 'ignored'), '/workspace/Solution.cs');
});
