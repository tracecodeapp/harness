import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUncapturedShapeGuard,
  measurementShapeKey,
} from './measurement-shapes.mjs';

const scopes = ['desktop', 'phone', 'spot'];
const versions = ['0.17.1', 'candidate-main'];
const groups = [
  { language: 'python', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'run',
    continuation: true, pythonWarmMode: 'fresh-page' },
  { language: 'python', cpu: 4, problem: 'permutations', state: 'warm', journey: 'run',
    continuation: false, pythonWarmMode: 'repeat-run', pairedControlFor: 'candidate-main' },
  { language: 'python', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'submit',
    continuation: false, pythonWarmMode: 'submit-after-run' },
  { language: 'csharp', cpu: 1, problem: 'permutations', state: 'cold', journey: 'submit',
    continuation: false },
];

test('fails on the first rejected attempt for every uncaptured scope, group and version', () => {
  for (const scope of scopes) {
    for (const group of groups) {
      for (const version of versions) {
        const guard = createUncapturedShapeGuard(scope);
        const result = guard.observe(group, version, { invalid: 'seeded witness rejection' });
        assert.equal(result.action, 'fail-fast', result.key);
      }
    }
  }
});

test('a real kept attempt captures only its exact shape', () => {
  const group = groups[1];
  const guard = createUncapturedShapeGuard('phone');
  assert.equal(guard.observe(group, '0.17.1', { kept: true }).action, 'captured');
  assert.equal(guard.observe(group, '0.17.1', { invalid: 'later transient' }).action,
    'known-reject');
  assert.equal(guard.observe(group, 'candidate-main', { invalid: 'different version' }).action,
    'fail-fast');
  assert.equal(guard.observe({ ...group, problem: 'binary-search' }, '0.17.1',
    { invalid: 'different cell' }).action, 'fail-fast');
});

test('pre-recorded captures suppress fail-fast without crossing pair or scope boundaries', () => {
  const group = groups[1];
  const key = measurementShapeKey('phone', group, '0.17.1');
  const guard = createUncapturedShapeGuard('phone', [key]);
  assert.equal(guard.observe(group, '0.17.1', { refusal: 'seeded refusal' }).action,
    'known-reject');
  assert.equal(createUncapturedShapeGuard('desktop', [key])
    .observe(group, '0.17.1', { invalid: 'wrong scope' }).action, 'fail-fast');
  assert.equal(guard.observe({ ...group, pairedControlFor: 'candidate-deploy' }, '0.17.1',
    { invalid: 'wrong pair' }).action, 'fail-fast');
});
