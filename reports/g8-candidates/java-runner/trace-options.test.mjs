import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTraceOptions } from './trace-options.mjs';

const budget = { maxTraceSteps: 4_000, maxLineEvents: 12_000, maxStoredEvents: 16_000 };
const publishedControls = { maxTraceSteps: true, maxStoredEvents: true };

test('published Java instrumentation keeps the published runtime control set', () => {
  assert.deepEqual(selectTraceOptions(budget, publishedControls, false), {
    maxTraceSteps: 4_000,
    maxStoredEvents: 16_000,
  });
});

test('a 0.21 Java candidate keeps its extended trace controls', () => {
  assert.deepEqual(selectTraceOptions(budget, publishedControls, true), budget);
});
