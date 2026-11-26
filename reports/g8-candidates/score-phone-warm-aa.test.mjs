import assert from 'node:assert/strict';
import test from 'node:test';

import { phoneWarmAaSampleDisposition } from './phone-warm-aa.mjs';

test('A/A scoring skips only explicit load exclusions', () => {
  assert.equal(phoneWarmAaSampleDisposition({ kept: false, excluded: 'initial load > 2.0' }),
    'excluded');
  assert.equal(phoneWarmAaSampleDisposition({ kept: true }), 'kept');
  assert.throws(() => phoneWarmAaSampleDisposition({ kept: false }), /false !== true/u);
  assert.throws(() => phoneWarmAaSampleDisposition({ kept: false, invalid: 'witness differs' }),
    /witness differs/u);
  assert.throws(() => phoneWarmAaSampleDisposition({ kept: true, excluded: 'initial load > 2.0' }),
    /cannot be kept/u);
});
