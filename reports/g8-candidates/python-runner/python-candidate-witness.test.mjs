import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pythonCandidateCacheReceipt,
  pythonCandidateOutcome,
  pythonCandidateRequiresStopping,
} from './python-candidate-witness.mjs';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function runJournal(ordinaryWorker, observerWorker, caseCount) {
  return [
    {
      worker: ordinaryWorker,
      role: 'ordinary',
      phase: 'send',
      type: 'prepare-program',
      mode: 'code',
      timings: { compileCacheHit: false },
    },
    {
      worker: ordinaryWorker,
      role: 'ordinary',
      phase: 'send',
      type: 'execute-prepared-program-batch',
      mode: 'code',
      cases: caseCount,
      tier: 'algorithm-fast',
      stopAtFirstRunaway: true,
      timings: { artifactCacheHit: true },
    },
    {
      worker: observerWorker,
      role: 'observer',
      phase: 'send',
      type: 'prepare-program',
      mode: 'trace',
      observation: true,
      timings: {},
    },
    {
      worker: observerWorker,
      role: 'observer',
      phase: 'send',
      type: 'execute-prepared-program',
      mode: 'trace',
      observation: true,
      tier: 'algorithm-fast',
      timings: { artifactCacheHit: true },
    },
  ];
}

test('seeded controls accept one algorithm-fast stopping batch and a distinct observer', () => {
  const next = random(322026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const ordinaryWorker = 10 + Math.floor(next() * 1_000);
    let observerWorker = 10 + Math.floor(next() * 1_000);
    if (observerWorker === ordinaryWorker) observerWorker++;
    assert.equal(pythonCandidateOutcome(
      { python: { phases: runJournal(ordinaryWorker, observerWorker, caseCount) } },
      'run',
      caseCount,
      true,
    ), undefined);
  }
});

test('seeded controls reject a per-case worker restart', () => {
  const next = random(322026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const phases = runJournal(i + 10, i + 1_000, caseCount);
    phases.splice(1, 1, ...Array.from({ length: caseCount }, (_, index) => ({
      worker: i + 10 + index,
      role: 'ordinary',
      phase: 'send',
      type: 'execute-prepared-program',
      mode: 'code',
      tier: 'algorithm-fast',
    })));
    assert.equal(pythonCandidateOutcome({ python: { phases } }, 'run', caseCount, true),
      'Python worker, batch or observer witness differs');
  }
});

test('seeded controls reject a shared observer worker', () => {
  const next = random(322026);
  for (let i = 0; i < 32; i++) {
    const caseCount = 2 + Math.floor(next() * 30);
    const worker = 10 + Math.floor(next() * 1_000);
    assert.equal(pythonCandidateOutcome(
      { python: { phases: runJournal(worker, worker, caseCount) } },
      'run',
      caseCount,
      true,
    ), 'Python worker, batch or observer witness differs');
  }
});

test('algorithm-fast and stopping evidence fail closed', () => {
  const wrongTier = runJournal(1, 2, 10);
  wrongTier[1].tier = 'judge-compatible';
  assert.equal(pythonCandidateOutcome({ python: { phases: wrongTier } }, 'run', 10, true),
    'Python worker, batch or observer witness differs');

  const nonStopping = runJournal(1, 2, 10);
  nonStopping[1].stopAtFirstRunaway = false;
  assert.equal(pythonCandidateOutcome({ python: { phases: nonStopping } }, 'run', 10, true),
    'Python worker, batch or observer witness differs');

  const missingCases = runJournal(1, 2, 10);
  delete missingCases[1].cases;
  assert.equal(pythonCandidateOutcome({ python: { phases: missingCases } }, 'run', 10, true),
    'Python worker, batch or observer witness differs');
});

test('submit has no observer and deploy submit may use the baseline non-stopping policy', () => {
  const phases = runJournal(1, 2, 10).filter(({ role }) => role !== 'observer');
  phases[1].stopAtFirstRunaway = false;
  assert.equal(pythonCandidateOutcome({ python: { phases } }, 'submit', 10, false), undefined);
  assert.equal(pythonCandidateOutcome({ python: { phases } }, 'submit', 10, true),
    'Python worker, batch or observer witness differs');
});

test('only Run requires the #77 stopping batch evidence', () => {
  assert.equal(pythonCandidateRequiresStopping('run'), true);
  assert.equal(pythonCandidateRequiresStopping('submit'), false);
  assert.equal(pythonCandidateRequiresStopping('click'), false);
  assert.throws(() => pythonCandidateRequiresStopping('other'), /Unknown Python role/);
});

test('click carries only one observer execution', () => {
  const phases = runJournal(1, 2, 10).filter(({ role, type }) =>
    role === 'observer' && type === 'execute-prepared-program');
  assert.equal(pythonCandidateOutcome({ python: { phases } }, 'click', 1, false), undefined);
});

test('cache receipt preserves flags only where Python reports them', () => {
  const result = { python: { phases: runJournal(1, 2, 2) } };
  assert.deepEqual(pythonCandidateCacheReceipt(result), {
    ordinary: [
      { type: 'prepare-program', worker: 1, compileCacheHit: false, artifactCacheHit: undefined },
      { type: 'execute-prepared-program-batch', worker: 1, compileCacheHit: undefined, artifactCacheHit: true },
    ],
    observer: [
      { type: 'prepare-program', worker: 2, compileCacheHit: undefined, artifactCacheHit: undefined },
      { type: 'execute-prepared-program', worker: 2, compileCacheHit: undefined, artifactCacheHit: true },
    ],
  });
});
