import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Effect from 'effect/Effect';
import {
  PROJECT_RECEIPT_SCHEMA,
  debuggingProjectEvaluatorV1,
  type JudgeObservation,
} from '../packages/judge/src/index';
import type { RuntimeKernelHttpResponse } from '../packages/runtime-contracts/src/index';
import { BrowserProjectJudgePort } from '../src/internal/browser-project-judge';

test('journal timestamps let the debugging grader cite the reproduction command', async () => {
  const path = '/arrivals/central';
  const command = 'python -c pass';
  const port = new BrowserProjectJudgePort({
    providers: ['python'],
    runtimeProviders: {
      python: {
        async execute({ kernelHttp }) {
          assert.ok(kernelHttp);
          const listener = kernelHttp.listen(
            { host: '127.0.0.1', port: 0 },
            () => ({ status: 200, body: 'ok' })
          );
          try {
            for (let i = 0; i < 2; i++) {
              const response: RuntimeKernelHttpResponse = await kernelHttp.dispatch({
                method: 'GET',
                path,
                url: `http://127.0.0.1:${listener.info.port}${path}`,
                headers: { authorization: 'Bearer probe-key' },
              });
              assert.equal(response.status, 200);
            }
          } finally {
            listener.close();
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    },
  });
  const observations = await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const workspace = yield* port.openWorkspace();
      const process = yield* workspace.run({ command: 'python', args: ['-c', 'pass'] });
      const outcome = yield* process.wait();
      assert.equal(outcome.termination.exitCode, 0, outcome.stderr);
      return yield* workspace.observations();
    }))
  );

  const reproduction = observations.find(
    (observation) => observation.kind === 'process' && observation.argv === command
  );
  assert.ok(reproduction, `expected a process observation for "${command}"`);
  const requests = observations.filter((observation) => observation.kind === 'http');
  assert.equal(requests.length, 2);

  async function reproductionEvidence(evidence: readonly JudgeObservation[]) {
    const claims = await Effect.runPromise(debuggingProjectEvaluatorV1.evaluate({
      config: {
        relevantPaths: ['rate-limit.py'],
        regressionTestPaths: ['test_rate_limit.py'],
        reproductionCommands: [command],
        repositoryTestsStepId: 'repository-tests',
        regressionReplayStepId: 'regression-replay',
        failureSignal: {
          kind: 'invariant-contradiction',
          invariant: { kind: 'rate-limit', pathPrefix: '/arrivals/', limit: 1 },
        },
      },
      receipt: {
        schema: PROJECT_RECEIPT_SCHEMA,
        definition: { id: 'rate-limit', revision: '1' },
        attemptId: 'journal-attribution',
        artifacts: { submission: 'submission', starter: 'starter' },
        changes: [],
        changedPaths: [],
        executionVerification: 'judge-executed',
        steps: [],
        observations: evidence,
        facts: [],
      },
    }));
    const claim = claims.find((entry) => entry.id === 'debugging.reproduced');
    assert.equal(claim?.status, 'proven');
    return claim.evidence.map((entry) => entry.observationSeq);
  }

  const requestSeqs = requests.map((request) => request.seq);
  const untimed = observations.map((observation) => {
    if (observation.kind === 'process') {
      const { startedAt, completedAt, ...record } = observation;
      return record;
    }
    if (observation.kind === 'http') {
      const { observedAt, ...record } = observation;
      return record;
    }
    return observation;
  });
  assert.deepEqual(await reproductionEvidence(untimed), requestSeqs);
  assert.deepEqual(
    await reproductionEvidence(observations),
    [reproduction.seq, ...requestSeqs],
    `stamped journal should make the grader cite "${command}"`
  );
});
