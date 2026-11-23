import assert from 'node:assert/strict';
import { assertGraph } from './graph.mjs';

const absent = { '$gate.undefined': true };
const defined = (value) => value !== undefined && !(
  value && typeof value === 'object' && Object.hasOwn(value, '$gate.undefined')
);
const ownValue = (object, key) => Object.hasOwn(object, key) && defined(object[key]);
const errorText = (error) => error instanceof Error ? error.message : String(error);

function requireValue(row, field, expected, expectedField, graph = false) {
  const present = Object.hasOwn(expected, expectedField);
  assert.equal(ownValue(row, field), present, `${field} presence`);
  if (present) (graph ? assertGraph : assert.deepEqual)(row[field], expected[expectedField]);
}

export function checkObservation(fixture, request, observation, record) {
  const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/default/${request.id}`;
  function check(caseId, assertion, comparison) {
    const id = `${prefix}/${caseId}/${assertion}`;
    try {
      comparison();
      record({ id, status: 'pass' });
    } catch (error) {
      record({ id, status: 'fail', message: errorText(error) });
    }
  }

  if (!defined(observation.reported)) return;
  const { reported, submitted } = observation;
  const { evaluation } = reported;
  const rows = request.cases.map((id) => fixture.cases.find((row) => row.id === id));
  check('@request', 'order', () => assert.deepEqual(evaluation.cases.map((row) => row.caseId), request.cases));
  check('@request', 'compile', () => {
    assert.equal(evaluation.status, 'completed');
    if (request.mode !== 'continuation' || defined(evaluation.compile)) {
      assert.equal(evaluation.compile?.status, 'compiled');
      assert(!defined(evaluation.compile?.failure));
    }
  });
  check('@request', 'correlation', () => {
    if (request.mode === 'submit') {
      assert.equal(reported.bundleId, submitted.id);
      assert.equal(reported.workspaceDigest, submitted.workspaceDigest);
      assert.equal(reported.schema, 'tracecode.judge.algorithm-receipt.v1');
    } else if (request.mode === 'initial') {
      assert.equal(typeof reported.executionId, 'string');
    } else {
      assert(!defined(reported.executionId) || reported.executionId === observation.retainedExecutionId);
    }
    for (const row of evaluation.cases) {
      assert.equal(typeof row.sessionId, 'string');
      assert(Number.isInteger(row.pid));
    }
  });
  if (request.mode === 'submit') {
    check('@request', 'aggregate', () => {
      const passed = rows.filter((row) => row.verdict === 'passed').length;
      const allPassed = passed === rows.length;
      assert.equal(reported.passedCount, passed);
      assert.equal(reported.totalCount, rows.length);
      assert.equal(reported.verdict, allPassed ? 'passed' : 'failed');
      assert.equal(reported.policy.result, allPassed);
      assert.deepEqual(reported.policy.missingFacts, []);
    });
  }

  for (const expected of rows) {
    const index = evaluation.cases.findIndex((row) => row.caseId === expected.id);
    if (index < 0) continue;
    const row = evaluation.cases[index];
    const consumer = observation.projections[index];
    check(expected.id, 'identity', () => {
      assert.equal(row.caseId, expected.id);
      requireValue(row, 'expected', expected, 'expected');
    });
    check(expected.id, 'status', () => {
      assert.equal(row.status, expected.status);
      assert.equal(consumer.kind, expected.status === 'timed-out' ? 'limit' : expected.status === 'runtime-error' ? 'failed' : 'completed');
    });
    check(expected.id, 'value', () => {
      requireValue(row, 'value', expected, 'actual', fixture.graph);
      requireValue(consumer, 'output', expected, 'actual', fixture.graph);
    });
    check(expected.id, 'console', () => {
      assert.equal(row.stdout, expected.stdout);
      if (!expected.failure) assert.equal(row.stderr, expected.stderr);
      assert.deepEqual(consumer.consoleOutput, expected.stdout === '' ? [] : expected.stdout.slice(0, -1).split('\n'));
    });
    check(expected.id, 'failure', () => {
      assert(!defined(row.notRun));
      if (!expected.failure) assert(!defined(row.failure));
      else {
        for (const [key, value] of Object.entries(expected.failure)) assert.equal(row.failure?.[key], value, key);
      }
    });
    check(expected.id, 'verdict', () => assert.equal(row.verdict.kind, expected.verdict));
    check(expected.id, 'termination', () => {
      if (expected.status === 'completed') assert.deepEqual(row.termination, { kind: 'exit', exitCode: 0 });
      else assert.notEqual(row.termination.exitCode, 0);
      assert.equal(row.timedOut, expected.status === 'timed-out');
    });
    check(expected.id, 'diagnostics', () => {
      const diagnostics = row.diagnostics.filter((entry) => entry.kind !== 'trace-truncated');
      if (expected.failure) {
        assert(diagnostics.some((entry) => entry.severity === 'error'
          && entry.source === fixture.language
          && (!expected.failure.reason || entry.code === expected.failure.reason)));
      } else assert.deepEqual(diagnostics, expected.diagnostics);
    });
    if (expected.anchor && request.selected.includes(expected.id)) {
      const events = row.trace?.events;
      check(expected.id, 'source-event', () => {
        assert(Array.isArray(events) && events.some((event) => (
          event.line === expected.anchor || event.source?.line === expected.anchor
        )), `No recorded event on print line ${expected.anchor}`);
      });
      check(expected.id, 'case-binding', () => {
        assert(Array.isArray(events) && events.some((event) => (
          event.line === expected.anchor || event.source?.line === expected.anchor
        ) && (
          event.variables?.n === expected.anchorInput ||
          event.locals?.n === expected.anchorInput ||
          event.snapshot?.n === expected.anchorInput
        )), `No print-line event binding n=${expected.anchorInput}`);
      });
    }
  }
}

export function summarize(inventory, results) {
  assert.equal(new Set(inventory).size, inventory.length, 'Duplicate inventory ID');
  const expected = new Set(inventory);
  const seen = new Set();
  const unexpected = [];
  const repeated = [];
  const failed = [];
  const passed = [];
  for (const result of results) {
    if (!expected.has(result.id)) unexpected.push(result.id);
    if (seen.has(result.id)) repeated.push(result.id);
    seen.add(result.id);
    (result.status === 'pass' ? passed : failed).push(result.id);
  }
  const missing = inventory.filter((id) => !seen.has(id));
  const counts = new Map();
  function count(ids, field) {
    for (const id of ids) {
      const key = id.split('/').slice(0, 2).join('/');
      const info = counts.get(key) ?? { expected: 0, seen: 0, passed: 0, failed: 0, missing: 0 };
      info[field]++;
      counts.set(key, info);
    }
  }
  count(inventory, 'expected');
  count(seen, 'seen');
  count(passed, 'passed');
  count(failed, 'failed');
  count(missing, 'missing');
  return { counts: Object.fromEntries(counts), unexpected, repeated, failed, missing };
}
