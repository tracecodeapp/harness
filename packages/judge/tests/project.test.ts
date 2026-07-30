import assert from 'node:assert/strict';
import test from 'node:test';
import * as Effect from 'effect/Effect';
import * as Scope from 'effect/Scope';
import {
  evaluateJudgeVerdictPolicy,
  evaluateProjectJudgeBundle,
  evaluateProjectJudgeEvidenceBundle,
  PROJECT_ATTEMPT_SCHEMA,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_DEFINITION_SCHEMA,
  PROJECT_EXECUTION_EVIDENCE_SCHEMA,
  type JudgeFact,
  type JudgeKernelProcessOutcome,
  type JudgeProcessPlan,
  type JudgeProjectBundleV1,
  type JudgeProjectClaim,
  type JudgeProjectEvaluator,
  type JudgeProjectPort,
  type JudgeProjectProcess,
  type JudgeProjectWorkspace,
  type JudgeWorkspaceFile,
  validateProjectJudgeBundle,
} from '../src/index';

interface FakeSnapshot {
  readonly files: readonly JudgeWorkspaceFile[];
}

class FakeProjectProcess implements JudgeProjectProcess {
  constructor(
    readonly sessionId: string,
    readonly pid: number,
    private readonly outcome: JudgeKernelProcessOutcome
  ) {}

  wait() {
    return Effect.succeed(this.outcome);
  }

  signal() {
    return Effect.void;
  }
}

class FakeProjectWorkspace implements JudgeProjectWorkspace<FakeSnapshot> {
  private readonly files = new Map<string, JudgeWorkspaceFile>();
  private readonly observed: import('../src/index').JudgeObservation[] = [];

  constructor(
    readonly id: string,
    snapshot: FakeSnapshot | undefined,
    private readonly nextPid: () => number
  ) {
    for (const file of snapshot?.files ?? []) this.files.set(file.path, file);
  }

  mount(files: readonly JudgeWorkspaceFile[]) {
    return Effect.sync(() => {
      for (const file of files) this.files.set(file.path, file);
    });
  }

  snapshot() {
    return Effect.succeed({
      files: Object.freeze([...this.files.values()]),
    });
  }

  run(process: JudgeProcessPlan) {
    return Effect.sync(() => {
      const pid = this.nextPid();
      const command = [process.command, ...(process.args ?? [])].join(' ');
      const isReplay = command.includes('replay');
      const isProbe = command.includes('probe');
      if (isProbe) {
        this.observed.push({
          seq: this.observed.length + 1,
          kind: 'http',
          actor: 'judge',
          host: 'inventory.example.test',
          path: '/v1/items/one',
          status: 200,
          via: 'loopback',
        });
      }
      const exitCode = isReplay ? 1 : 0;
      const outcome: JudgeKernelProcessOutcome = {
        sessionId: this.id,
        pid,
        termination: { kind: 'exit', exitCode },
        stdout: isReplay ? '' : `${command} passed\n`,
        stderr: isReplay ? 'expected regression failure\n' : '',
        timedOut: false,
        startedAt: 10,
        endedAt: 20,
      };
      return new FakeProjectProcess(this.id, pid, outcome);
    });
  }

  observations() {
    return Effect.succeed(Object.freeze([...this.observed]));
  }
}

class FakeProjectPort implements JudgeProjectPort<FakeSnapshot> {
  private session = 0;
  private pid = 100;

  openWorkspace(options: {
    readonly snapshot?: FakeSnapshot;
  } = {}) {
    return Effect.acquireRelease(
      Effect.sync(() =>
        new FakeProjectWorkspace(
          `project-session-${++this.session}`,
          options.snapshot,
          () => ++this.pid
        )
      ),
      () => Effect.void
    );
  }
}

const files = (
  entries: Readonly<Record<string, string>>,
  visibility: JudgeWorkspaceFile['visibility'] = 'submission'
): readonly JudgeWorkspaceFile[] =>
  Object.entries(entries).map(([path, contents]) => ({
    path,
    contents,
    visibility,
  }));

const semanticFact = (
  workspaceDigest = 'sha256:submission'
): JudgeFact<string> => ({
  id: 'semantic.timeComplexity',
  schema: 1,
  value: 'logarithmic',
  subject: {
    workspaceDigest,
    entrypoint: '/workspace/src/index.js',
  },
  producer: {
    id: 'semantic-engine',
    version: '3.0.0',
  },
  verification: 'browser-asserted',
  confidence: 0.99,
});

function bundle(): JudgeProjectBundleV1 {
  return {
    schema: PROJECT_BUNDLE_SCHEMA,
    definition: {
      schema: PROJECT_DEFINITION_SCHEMA,
      id: 'catalog-service',
      revision: '4',
      workspace: {
        cwd: '/workspace',
        starter: {
          kind: 'inline',
          digest: 'sha256:starter',
          files: files({
            '/workspace/src/index.js': 'broken',
            '/workspace/tests/regression.test.js': 'old test',
          }),
        },
        privateFiles: {
          kind: 'inline',
          digest: 'sha256:private',
          files: files(
            { '/.tracecode/judge/probe.js': 'private probe' },
            'judge-private'
          ),
        },
      },
      steps: [
        {
          id: 'repository-tests',
          kind: 'command',
          workspace: { base: 'submission' },
          process: {
            command: 'npm',
            args: ['test'],
          },
        },
        {
          id: 'regression-replay',
          kind: 'command',
          workspace: {
            base: 'submission',
            overlays: [{
              source: 'starter',
              paths: ['/workspace/src/index.js'],
            }],
          },
          process: {
            command: 'npm',
            args: ['run', 'replay'],
          },
        },
        {
          id: 'acceptance',
          kind: 'command',
          workspace: { base: 'submission' },
          process: {
            command: 'node',
            args: ['/.tracecode/judge/probe.js'],
          },
        },
      ],
      evaluators: [{
        kind: 'debugging',
        version: 1,
        config: {},
      }],
      verdictPolicy: {
        schema: 'tracecode.judge.verdict-policy.v1',
        requires: [{
          id: 'semantic.timeComplexity',
          schema: 1,
          producer: 'semantic-engine',
          minimumVerification: 'browser-asserted',
        }],
        passWhen: {
          op: 'all',
          conditions: [
            {
              op: 'every',
              collection: { op: 'ref', path: 'claims' },
              variable: 'claim',
              condition: {
                op: 'eq',
                left: { op: 'ref', path: 'claim.status' },
                right: { op: 'literal', value: 'proven' },
              },
            },
            {
              op: 'complexity-at-most',
              actual: { op: 'fact', id: 'semantic.timeComplexity' },
              expected: { op: 'literal', value: 'logarithmic' },
            },
          ],
        },
        score: {
          kind: 'weighted-sum',
          dimensions: [
            {
              id: 'technical',
              weight: 3,
              when: {
                op: 'every',
                collection: { op: 'ref', path: 'claims' },
                variable: 'claim',
                condition: {
                  op: 'eq',
                  left: { op: 'ref', path: 'claim.status' },
                  right: { op: 'literal', value: 'proven' },
                },
              },
            },
            {
              id: 'complexity',
              weight: 1,
              when: {
                op: 'complexity-at-most',
                actual: { op: 'fact', id: 'semantic.timeComplexity' },
                expected: { op: 'literal', value: 'logarithmic' },
              },
            },
          ],
        },
      },
    },
    attempt: {
      schema: PROJECT_ATTEMPT_SCHEMA,
      attemptId: 'attempt-1',
      submittedWorkspace: {
        kind: 'inline',
        digest: 'sha256:submission',
        files: files({
          '/workspace/src/index.js': 'fixed',
          '/workspace/tests/regression.test.js': 'new regression test',
        }),
      },
      evidence: [{
        seq: 1,
        kind: 'edit',
        actor: 'learner',
        path: '/workspace/src/index.js',
      }],
      facts: [semanticFact()],
    },
  };
}

const debuggingEvaluator: JudgeProjectEvaluator = {
  kind: 'debugging',
  version: 1,
  evaluate: ({ receipt }) => {
    const tests = receipt.steps.find((step) => step.id === 'repository-tests');
    const replay = receipt.steps.find((step) => step.id === 'regression-replay');
    const acceptance = receipt.steps.find((step) => step.id === 'acceptance');
    const claims: JudgeProjectClaim[] = [
      {
        id: 'debugging.tests',
        label: 'Repository tests',
        status:
          tests?.kind === 'command' &&
          tests.process.termination.kind === 'exit' &&
          tests.process.termination.exitCode === 0
            ? 'proven'
            : 'contradicted',
        summary: 'Repository test result.',
        scored: true,
        evidence: [{ stepId: 'repository-tests', note: 'Submission tests.' }],
      },
      {
        id: 'debugging.regression',
        label: 'Regression replay',
        status:
          replay?.kind === 'command' &&
          replay.process.termination.kind === 'exit' &&
          replay.process.termination.exitCode !== 0
            ? 'proven'
            : 'contradicted',
        summary: 'Regression replay result.',
        scored: true,
        evidence: [{ stepId: 'regression-replay', note: 'Starter replay.' }],
      },
      {
        id: 'behavior.acceptance',
        label: 'Acceptance',
        status: acceptance?.observations.some((entry) =>
          entry.kind === 'http' && entry.status === 200
        )
          ? 'proven'
          : 'not-demonstrated',
        summary: 'Acceptance result.',
        scored: true,
        evidence: [{ stepId: 'acceptance', note: 'Acceptance probe.' }],
      },
    ];
    return Effect.succeed(Object.freeze(claims));
  },
};

test('evaluates a versioned project bundle into an isolated receipt, claims, score, and verdict', async () => {
  const result = await Effect.runPromise(
    evaluateProjectJudgeBundle(
      new FakeProjectPort(),
      bundle(),
      { evaluators: [debuggingEvaluator] }
    )
  );

  assert.equal(result.execution, 'completed');
  assert.equal(result.verdict, 'passed');
  assert.equal(result.score, 100);
  assert.equal(result.receipt?.steps.length, 3);
  assert.equal(new Set(
    result.receipt?.steps.flatMap((step) =>
      step.kind === 'command'
        ? [step.process.sessionId]
        : [step.service.sessionId, step.probe.sessionId]
    )
  ).size, 3);
  assert.deepEqual(result.receipt?.changedPaths, [
    '/workspace/src/index.js',
    '/workspace/tests/regression.test.js',
  ]);
  assert.deepEqual(
    result.claims.map((claim) => claim.status),
    ['proven', 'proven', 'proven']
  );
  assert.ok(
    result.receipt?.observations.some((entry) =>
      entry.kind === 'http' &&
      entry.stepId === 'acceptance' &&
      entry.status === 200
    )
  );
});

test('evaluates browser-produced execution evidence without opening a runtime', async () => {
  const input = bundle();
  const executed = await Effect.runPromise(
    evaluateProjectJudgeBundle(
      new FakeProjectPort(),
      input,
      { evaluators: [debuggingEvaluator] }
    )
  );
  assert.ok(executed.receipt);

  const result = await Effect.runPromise(
    evaluateProjectJudgeEvidenceBundle(
      {
        ...input,
        attempt: {
          ...input.attempt,
          executionEvidence: {
            schema: PROJECT_EXECUTION_EVIDENCE_SCHEMA,
            verification: 'browser-asserted',
            steps: executed.receipt.steps,
          },
        },
      },
      { evaluators: [debuggingEvaluator] }
    )
  );

  assert.equal(result.execution, 'completed');
  assert.equal(result.verdict, 'passed');
  assert.equal(result.receipt?.executionVerification, 'browser-asserted');
  assert.deepEqual(
    result.claims.map((claim) => claim.status),
    ['proven', 'proven', 'proven']
  );
});

test('does not apply semantic facts computed for another workspace', async () => {
  const value = bundle();
  const result = await Effect.runPromise(
    evaluateProjectJudgeBundle(
      new FakeProjectPort(),
      {
        ...value,
        attempt: {
          ...value.attempt,
          facts: [semanticFact('sha256:other-workspace')],
        },
      },
      { evaluators: [debuggingEvaluator] }
    )
  );

  assert.equal(result.execution, 'completed');
  assert.equal(result.verdict, 'not-evaluated');
  assert.equal(result.policy?.result, 'unknown');
  assert.equal(result.policy?.missingFacts.length, 1);
});

test('rejects project evidence and files that cross the Judge authority boundary', async () => {
  const value = bundle();
  await assert.rejects(
    Effect.runPromise(validateProjectJudgeBundle({
      ...value,
      definition: {
        ...value.definition,
        workspace: {
          ...value.definition.workspace,
          privateFiles: {
            kind: 'inline',
            digest: 'sha256:private',
            files: files({
              '/workspace/private-probe.js': 'private probe',
            }),
          },
        },
      },
    }, { evaluators: [debuggingEvaluator] })),
    /invalid visibility|Judge-private boundary/
  );

  const executed = await Effect.runPromise(
    evaluateProjectJudgeBundle(
      new FakeProjectPort(),
      value,
      { evaluators: [debuggingEvaluator] }
    )
  );
  assert.ok(executed.receipt);
  const malformedSteps = executed.receipt.steps.map((step, index) =>
    index === 0 && step.kind === 'command'
      ? {
          ...step,
          process: {
            ...step.process,
            pid: -1,
          },
        }
      : step
  );
  await assert.rejects(
    Effect.runPromise(validateProjectJudgeBundle({
      ...value,
      attempt: {
        ...value.attempt,
        executionEvidence: {
          schema: PROJECT_EXECUTION_EVIDENCE_SCHEMA,
          verification: 'browser-asserted',
          steps: malformedSteps,
        },
      },
    }, { evaluators: [debuggingEvaluator] })),
    /process result is invalid/
  );
});

test('uses three-valued passWhen semantics for missing quantified data', () => {
  const evaluation = evaluateJudgeVerdictPolicy(
    {
      schema: 'tracecode.judge.verdict-policy.v1',
      passWhen: {
        op: 'every',
        collection: { op: 'ref', path: 'cases' },
        variable: 'item',
        condition: {
          op: 'eq',
          left: { op: 'ref', path: 'item.verdict' },
          right: { op: 'literal', value: 'passed' },
        },
      },
    },
    {
      workspaceDigest: 'sha256:workspace',
      values: {},
    }
  );

  assert.equal(evaluation.result, 'unknown');
  assert.match(evaluation.trace.reason ?? '', /missing or is not an array/);
});
