import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCsharpFreshSubmitControl,
  csharpWarmAttemptPlan,
  csharpWarmMetricName,
  csharpWarmModes,
  expandCsharpWarmGroups,
  openIsolatedCsharpWarmAttempt,
  requiresTrustedCsharpWarmArtifact,
} from './csharp-warm-policy.mjs';

const group = (journey) => ({
  language: 'csharp', cpu: 1, problem: 'binary-search', state: 'warm', journey,
  target: 20, versions: ['0.17.1', 'candidate-deploy'], continuation: journey === 'run',
});

test('C# Run expands into isolated fresh and one-primer repeat cells', () => {
  const expanded = expandCsharpWarmGroups([group('run')]);
  assert.deepEqual(expanded.map(({ csharpWarmMode }) => csharpWarmMode), [
    csharpWarmModes.fresh, csharpWarmModes.repeatRun,
  ]);
  assert.deepEqual(csharpWarmAttemptPlan(expanded[0]), { freshPage: true, primeJourney: undefined });
  assert.deepEqual(csharpWarmAttemptPlan(expanded[1]), { freshPage: true, primeJourney: 'run' });
  assert.equal(csharpWarmMetricName(expanded[1], 'verdicts'), 'repeatVerdicts');
});

test('C# Submit-after-Run has exactly one Run primer and no hidden control', () => {
  const expanded = expandCsharpWarmGroups([group('submit')], { submitAfterRun: true });
  assert.deepEqual(expanded.map(({ csharpWarmMode }) => csharpWarmMode), [
    csharpWarmModes.fresh, csharpWarmModes.submitAfterRun,
  ]);
  assert.deepEqual(csharpWarmAttemptPlan(expanded[1]), { freshPage: true, primeJourney: 'run' });
  assert.equal(csharpWarmMetricName(expanded[1], 'submitVerdicts'), 'submitAfterRunVerdicts');
});

test('0.20.1 is added only to fresh C# warm Submit', () => {
  const expanded = expandCsharpWarmGroups([
    group('submit'),
    group('run'),
    { ...group('submit'), state: 'cold' },
  ], { submitAfterRun: true });
  const controlled = addCsharpFreshSubmitControl(expanded, true);
  assert.deepEqual(controlled.map(({ csharpWarmMode, state, journey, versions }) => ({
    csharpWarmMode, state, journey, versions,
  })), [
    { csharpWarmMode: csharpWarmModes.fresh, state: 'warm', journey: 'submit',
      versions: ['0.17.1', '0.20.1', 'candidate-deploy'] },
    { csharpWarmMode: csharpWarmModes.submitAfterRun, state: 'warm', journey: 'submit',
      versions: ['0.17.1', 'candidate-deploy'] },
    { csharpWarmMode: csharpWarmModes.fresh, state: 'warm', journey: 'run',
      versions: ['0.17.1', 'candidate-deploy'] },
    { csharpWarmMode: csharpWarmModes.repeatRun, state: 'warm', journey: 'run',
      versions: ['0.17.1', 'candidate-deploy'] },
    { csharpWarmMode: undefined, state: 'cold', journey: 'submit',
      versions: ['0.17.1', 'candidate-deploy'] },
  ]);
  assert.equal(addCsharpFreshSubmitControl(expanded, false), expanded);
});

test('C# isolated attempt warms and optionally primes once, then closes once', async () => {
  const events = [];
  const repeat = expandCsharpWarmGroups([group('run')])[1];
  const isolated = await openIsolatedCsharpWarmAttempt(repeat, {
    open: async () => ({ id: 1 }),
    warm: async (page) => events.push(['warm', page.id]),
    prime: async (page, journey) => {
      events.push(['prime', page.id, journey]);
      return { receipt: true };
    },
    close: async (page) => events.push(['close', page.id]),
  });
  assert.deepEqual(events, [['warm', 1], ['prime', 1, 'run']]);
  assert.deepEqual(isolated.prime, { receipt: true });
  await isolated.close();
  assert.deepEqual(events.at(-1), ['close', 1]);
  await assert.rejects(isolated.close(), /closes exactly once/);
});

test('C# isolation closes a page when its primer fails', async () => {
  const events = [];
  const repeat = expandCsharpWarmGroups([group('run')])[1];
  await assert.rejects(openIsolatedCsharpWarmAttempt(repeat, {
    open: async () => ({ id: 2 }),
    warm: async () => {},
    prime: async () => { throw new Error('primer failed'); },
    close: async (page) => events.push(['close', page.id]),
  }), /primer failed/);
  assert.deepEqual(events, [['close', 2]]);
});

test('trusted standby evidence is required only on witness-validated C# paths', () => {
  const required = (overrides = {}) => requiresTrustedCsharpWarmArtifact({
    language: 'csharp', version: 'candidate-main', testedLanguage: 'java',
    fixedWarmWitness: false, liveControl: true, ...overrides,
  });
  assert.equal(required({ version: '0.17.1' }), true);
  assert.equal(required({ version: '0.20.1' }), true);
  assert.equal(required({ testedLanguage: 'csharp' }), true);
  assert.equal(required({ version: 'release-deploy', fixedWarmWitness: true }), true);
  assert.equal(required(), false, 'a Java candidate C# spot policy has no C# candidate witness');
  assert.equal(required({ language: 'python', version: '0.17.1' }), false);
});
