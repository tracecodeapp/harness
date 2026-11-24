import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandPythonWarmGroups,
  pythonWarmAttemptPlan,
  pythonWarmMetricName,
  pythonWarmModes,
  openIsolatedPythonWarmAttempt,
} from './python-warm-policy.mjs';

const group = (journey) => ({
  language: 'python', cpu: 1, problem: 'binary-search', state: 'warm',
  journey, target: 20, versions: ['0.17.1', 'candidate'], continuation: journey === 'run',
});

test('expands Python warm Run into a fresh cell and an explicit repeat cell', () => {
  const expanded = expandPythonWarmGroups([group('run')]);
  assert.deepEqual(expanded.map(({ pythonWarmMode }) => pythonWarmMode), [
    pythonWarmModes.fresh,
    pythonWarmModes.repeatRun,
  ]);
  assert.deepEqual(pythonWarmAttemptPlan(expanded[0]), { freshPage: true, primeJourney: undefined });
  assert.deepEqual(pythonWarmAttemptPlan(expanded[1]), { freshPage: true, primeJourney: 'run' });
  assert.equal(pythonWarmMetricName(expanded[1], 'verdicts'), 'repeatVerdicts');
});

test('adds Submit-after-Run only when receipts have enabled that formal cell', () => {
  assert.deepEqual(expandPythonWarmGroups([group('submit')]).map(({ pythonWarmMode }) => pythonWarmMode), [
    pythonWarmModes.fresh,
  ]);
  const submit = { ...group('submit'), versions: ['0.17.1', 'candidate', '0.20.1'] };
  const expanded = expandPythonWarmGroups([submit], { submitAfterRun: true });
  assert.deepEqual(expanded.map(({ pythonWarmMode }) => pythonWarmMode), [
    pythonWarmModes.fresh,
    pythonWarmModes.submitAfterRun,
  ]);
  assert.deepEqual(expanded[0].versions, ['0.17.1', 'candidate', '0.20.1']);
  assert.deepEqual(expanded[1].versions, ['0.17.1', 'candidate']);
  assert.deepEqual(pythonWarmAttemptPlan(expanded[1]), { freshPage: true, primeJourney: 'run' });
  assert.equal(pythonWarmMetricName(expanded[1], 'submitVerdicts'), 'submitAfterRunVerdicts');
});

test('never reuses a page between measured warm attempts', async () => {
  let nextPage = 0;
  const opened = [], warmed = [], measured = [], closed = [];
  const operations = {
    open: async () => { const page = { id: ++nextPage }; opened.push(page.id); return page; },
    warm: async (page) => warmed.push(page.id),
    prime: async () => assert.fail('fresh cell must not prime'),
    close: async (page) => closed.push(page.id),
  };
  const fresh = { ...group('run'), pythonWarmMode: pythonWarmModes.fresh };
  for (let attempt = 0; attempt < 2; attempt++) {
    const isolated = await openIsolatedPythonWarmAttempt(fresh, operations);
    measured.push(isolated.page.id);
    await isolated.close();
  }
  assert.deepEqual(opened, [1, 2]);
  assert.deepEqual(warmed, [1, 2]);
  assert.deepEqual(measured, [1, 2]);
  assert.deepEqual(closed, [1, 2]);
});

test('repeat cell has exactly one same-page Run immediately before measurement', async () => {
  const actions = [];
  const repeat = { ...group('run'), pythonWarmMode: pythonWarmModes.repeatRun };
  const isolated = await openIsolatedPythonWarmAttempt(repeat, {
    open: async () => { actions.push('open'); return { id: 77 }; },
    warm: async (page) => actions.push(`warm:${page.id}`),
    prime: async (page, journey) => actions.push(`${journey}:prime:${page.id}`),
    close: async (page) => actions.push(`close:${page.id}`),
  });
  actions.push(`run:measure:${isolated.page.id}`);
  await isolated.close();
  assert.deepEqual(actions, ['open', 'warm:77', 'run:prime:77', 'run:measure:77', 'close:77']);
});

test('Submit-after-Run has one same-page Run and no intervening action', async () => {
  const actions = [];
  const repeat = { ...group('submit'), pythonWarmMode: pythonWarmModes.submitAfterRun };
  const isolated = await openIsolatedPythonWarmAttempt(repeat, {
    open: async () => { actions.push('open'); return { id: 91 }; },
    warm: async (page) => actions.push(`warm:${page.id}`),
    prime: async (page, journey) => actions.push(`${journey}:prime:${page.id}`),
    close: async (page) => actions.push(`close:${page.id}`),
  });
  actions.push(`submit:measure:${isolated.page.id}`);
  await isolated.close();
  assert.deepEqual(actions, ['open', 'warm:91', 'run:prime:91', 'submit:measure:91', 'close:91']);
});

test('closes the isolated page when warmup or the primer fails', async () => {
  const closed = [];
  const repeat = { ...group('run'), pythonWarmMode: pythonWarmModes.repeatRun };
  await assert.rejects(openIsolatedPythonWarmAttempt(repeat, {
    open: async () => ({ id: 5 }),
    warm: async () => {},
    prime: async () => { throw new Error('seeded primer failure'); },
    close: async (page) => closed.push(page.id),
  }), /seeded primer failure/);
  assert.deepEqual(closed, [5]);
});
