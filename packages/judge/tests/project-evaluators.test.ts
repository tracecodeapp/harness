import assert from 'node:assert/strict';
import test from 'node:test';
import * as Effect from 'effect/Effect';
import {
  PROJECT_RECEIPT_SCHEMA,
  debuggingProjectEvaluatorV1,
  type JudgeObservation,
  type JudgeProjectClaim,
  type JudgeProjectReceiptV1,
} from '../src/index';

// A Headway-style debugging project: `npm test` and `npm run probe` may both
// reproduce, and the reported failure is a contradiction of a rate limit of
// three requests per key.
const CONFIG = {
  relevantPaths: ['src/rate-limit.js'],
  regressionTestPaths: ['test/rate-limit.test.js'],
  reproductionCommands: ['test', 'probe'],
  repositoryTestsStepId: 'repository-tests',
  regressionReplayStepId: 'regression-replay',
  failureSignal: {
    kind: 'invariant-contradiction',
    invariant: { kind: 'rate-limit', pathPrefix: '/v1/arrivals/', limit: 3 },
  },
};

const at = (second: number) => new Date(Date.UTC(2026, 10, 18, 0, 0, second)).toISOString();

function request(
  seq: number,
  key: string,
  status: number,
  observedAt?: string
): JudgeObservation {
  return {
    seq,
    kind: 'http',
    actor: 'learner',
    method: 'GET',
    host: '127.0.0.1',
    path: '/v1/arrivals/central-station',
    status,
    via: 'listener',
    pid: 7,
    authFingerprint: key,
    ...(status === 429 ? { meta: { retryAfter: '60' } } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
}

function command(
  seq: number,
  name: 'test' | 'probe',
  times?: { startedAt: string; completedAt: string }
): JudgeObservation {
  return {
    seq,
    kind: 'process',
    actor: 'learner',
    command: name,
    argv: name === 'test' ? 'npm test' : 'npm run probe',
    exitCode: 0,
    ...(times ?? {}),
  };
}

// The test exercises the limit correctly (three accepted, then 429); the probe
// sends five accepted requests under one key, contradicting the limit at its
// third and fourth requests.
function testRun(first: number, timed = false): JudgeObservation[] {
  const t = (offset: number) => (timed ? at(first + offset) : undefined);
  return [
    request(first, 'test-key', 200, t(0)),
    request(first + 1, 'test-key', 200, t(1)),
    request(first + 2, 'test-key', 200, t(2)),
    request(first + 3, 'test-key', 429, t(3)),
    command(first + 4, 'test', timed ? { startedAt: at(first - 1), completedAt: at(first + 4) } : undefined),
  ];
}

function probeRun(first: number, timed = false): JudgeObservation[] {
  const t = (offset: number) => (timed ? at(first + offset) : undefined);
  return [
    ...[0, 1, 2, 3, 4].map((offset) => request(first + offset, 'probe-key', 200, t(offset))),
    command(first + 10, 'probe', timed ? { startedAt: at(first - 1), completedAt: at(first + 10) } : undefined),
  ];
}

function receipt(observations: JudgeObservation[]): JudgeProjectReceiptV1 {
  const editSeq = Math.max(...observations.map((event) => event.seq)) + 1;
  return {
    schema: PROJECT_RECEIPT_SCHEMA,
    definition: { id: 'headway', revision: '1' },
    attemptId: 'attempt',
    artifacts: { submission: 'submission', starter: 'starter' },
    changes: [{ path: 'src/rate-limit.js', kind: 'modified' }],
    changedPaths: ['src/rate-limit.js'],
    executionVerification: 'judge-executed',
    steps: [],
    observations: [
      ...observations,
      { seq: editSeq, kind: 'edit', actor: 'learner', path: 'src/rate-limit.js' },
    ],
    facts: [],
  };
}

async function reproduced(observations: JudgeObservation[]): Promise<JudgeProjectClaim> {
  const claims = await Effect.runPromise(
    debuggingProjectEvaluatorV1.evaluate({ config: CONFIG, receipt: receipt(observations) } as never)
  );
  const claim = claims.find((entry) => entry.id === 'debugging.reproduced');
  assert.ok(claim, 'the debugging evaluator reports the reproduction claim');
  return claim;
}

const cited = (claim: JudgeProjectClaim) => claim.evidence.map((entry) => entry.observationSeq);

test('a probe that contradicts the invariant before the test is cited by its observations, not by a command', async () => {
  const claim = await reproduced([...probeRun(1), ...testRun(20)]);
  assert.equal(claim.status, 'proven');
  assert.deepEqual(cited(claim), [3, 4], 'the contradicting requests are the evidence');
  assert.ok(claim.evidence.every((entry) => entry.stepId === undefined));
});

test('a passing test followed by a contradicting probe cites the probe observations, never the test', async () => {
  // Mirrors the Headway replay: the test's requests and process, then the
  // probe's five accepted requests and its process.
  const claim = await reproduced([...testRun(1), ...probeRun(10)]);
  assert.equal(claim.status, 'proven');
  assert.deepEqual(cited(claim), [12, 13]);
  assert.ok(!cited(claim).includes(5), 'the passing test process is not reproduction evidence');
});

test('a reproduction command is named when timestamps tie it to the contradicting observations', async () => {
  const claim = await reproduced([...testRun(1, true), ...probeRun(10, true)]);
  assert.equal(claim.status, 'proven');
  assert.deepEqual(cited(claim), [20, 12, 13]);
  assert.match(claim.evidence[0]!.note, /reproduction/u);
});

test('no command is named when another process overlaps the contradicting observations', async () => {
  const observations = [...testRun(1, true), ...probeRun(10, true)];
  // The test process ran across the probe's requests as well.
  const overlapping = observations.map((event) =>
    event.kind === 'process' && event.command === 'test'
      ? { ...event, seq: 16, completedAt: at(30) }
      : event
  );
  const claim = await reproduced(overlapping);
  assert.equal(claim.status, 'proven');
  assert.deepEqual(cited(claim), [12, 13], 'ambiguous attribution names no process');
});

test('a run where only the passing test ran does not demonstrate the reproduction', async () => {
  const claim = await reproduced(testRun(1));
  assert.equal(claim.status, 'not-demonstrated');
  assert.deepEqual(cited(claim), [5], 'the test ran, but the configured failure was not observed');
  assert.match(claim.evidence[0]!.note, /not observed/u);
});
