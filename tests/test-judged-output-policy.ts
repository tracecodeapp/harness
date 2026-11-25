import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JUDGED_OUTPUT_POLICY_DEFAULTS,
  resolveJudgedOutputPolicy,
} from '../packages/runtime-contracts/src/judged-output-policy';
import type { Language } from '../packages/runtime-contracts/src/index';

const BYTES = 8 * 1024 * 1024;

test('product defaults per language (C-SEAM-CONTRACT.md §3)', () => {
  for (const language of ['javascript', 'typescript', 'java', 'csharp'] as const) {
    assert.deepEqual(JUDGED_OUTPUT_POLICY_DEFAULTS[language], {
      maxBytes: BYTES, maxItems: 250_000, maxNodes: 1_000_000, maxDepth: 64,
    });
  }
  assert.deepEqual(JUDGED_OUTPUT_POLICY_DEFAULTS.cpp, {
    maxBytes: BYTES, maxItems: 250_000, maxNodes: 1_000_000, maxDepth: 10_000,
  });
  assert.equal(JUDGED_OUTPUT_POLICY_DEFAULTS.python, undefined);
  assert.equal(Object.isFrozen(JUDGED_OUTPUT_POLICY_DEFAULTS), true);
  for (const policy of Object.values(JUDGED_OUTPUT_POLICY_DEFAULTS)) {
    assert.equal(Object.isFrozen(policy), true);
  }
});

test('resolution: Python and unknown languages get no policy', () => {
  assert.equal(resolveJudgedOutputPolicy('python'), undefined);
  assert.equal(resolveJudgedOutputPolicy('python', { maxBytes: 1 }), undefined);
  assert.equal(resolveJudgedOutputPolicy('cobol' as Language), undefined);
  assert.equal(resolveJudgedOutputPolicy('toString' as Language), undefined);
  assert.equal(resolveJudgedOutputPolicy('__proto__' as Language), undefined);
});

test('resolution: only non-negative safe integers below the default lower a field', () => {
  const defaults = JUDGED_OUTPUT_POLICY_DEFAULTS.javascript!;
  assert.deepEqual(resolveJudgedOutputPolicy('javascript'), { policy: defaults, lowered: false });
  assert.equal(resolveJudgedOutputPolicy('javascript', 'maxBytes')?.policy, defaults);
  assert.deepEqual(resolveJudgedOutputPolicy('javascript', { maxBytes: 1024 }), {
    policy: { ...defaults, maxBytes: 1024 }, lowered: true,
  });
  assert.equal(Object.isFrozen(resolveJudgedOutputPolicy('javascript', { maxBytes: 1024 })?.policy), true);
  for (const value of [defaults.maxBytes, defaults.maxBytes + 1, -1, 1.5, Number.NaN, Infinity, '1', null, 2 ** 60]) {
    assert.deepEqual(resolveJudgedOutputPolicy('javascript', { maxBytes: value }), {
      policy: defaults, lowered: false,
    }, String(value));
  }
  assert.deepEqual(resolveJudgedOutputPolicy('javascript', { maxBytes: 0, maxDepth: 1 })?.policy, {
    ...defaults, maxBytes: 0, maxDepth: 1,
  });
});

test('resolution: accessors, proxies and inherited fields are never consulted', () => {
  let read = false;
  const accessor = { get maxBytes() { read = true; return 1; } };
  assert.equal(resolveJudgedOutputPolicy('javascript', accessor)?.lowered, false);
  assert.equal(read, false);
  const inherited = Object.create({ maxBytes: 1 });
  assert.equal(resolveJudgedOutputPolicy('javascript', inherited)?.lowered, false);
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
  assert.equal(resolveJudgedOutputPolicy('javascript', hostile)?.lowered, false);
});
