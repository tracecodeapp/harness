import assert from 'node:assert/strict';
import { assertGraph } from './graph.mjs';

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
  const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/${request.route ?? 'default'}/${request.id}`;
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
  check('@request', 'compile-footprint', () => {
    if (evaluation.status === 'compile-failed') {
      assert.equal(evaluation.cases.length, 0);
      assert(!defined(reported.executionId));
      assert(defined(evaluation.compile.failure));
      if (request.route !== 'mux') assert(defined(observation.compileProjection));
    } else {
      assert.equal(evaluation.status, 'completed');
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
  if (request.route !== 'mux') {
    check('@request', 'worker-ack', () => {
      const commands = observation.worker.filter((event) => event.action === 'command' && /execute|compile-run/.test(event.type));
      const acknowledged = commands.filter((command) => observation.worker.some((event) => (
        event.action === 'response' && event.id === command.id && event.generation === command.generation
      )));
      if (evaluation.status === 'compile-failed') assert.equal(commands.length, 0);
      else assert(acknowledged.length > 0, 'No acknowledged worker execution request');
      if (request.route === 'ses-compartment-pool') assert(acknowledged.some((command) => command.worker.includes('ses-algorithm')));
      if (request.route === 'disposable-worker') assert(acknowledged.length && acknowledged.every((command) => !command.worker.includes('ses-algorithm')));
      if (request.mode === 'continuation') {
        assert(acknowledged.every((command) => command.trace !== false && !(Array.isArray(command.trace) && command.trace.includes(false))));
      }
    });
  }
  if (fixture.expectedTier && !request.route && request.id === 'submit-default-AB') {
    check('@request', 'admitted-tier', () => {
      const observations = observation.worker.filter((event) => event.action === 'response' && event.success === true);
      assert(observations.some((event) => event.tier === fixture.expectedTier && event.mode === 'code'), `No ${fixture.expectedTier} code artifact acknowledgement`);
      const commands = observation.worker.filter((event) => event.action === 'command' && /execute-prepared/.test(event.type));
      if (fixture.language === 'csharp') {
        assert(commands.some(({ type, tier }) => type === 'execute-prepared-code' && tier === 'algorithm-fast'));
      } else if (fixture.expectedTier === 'hard-isolated') {
        assert.equal(new Set(commands.map(({ generation }) => generation)).size, 2);
        assert(commands.every(({ type }) => type === 'execute-prepared-program'));
      } else {
        assert(commands.some(({ type, inputs }) => type === 'execute-prepared-program-batch' && inputs.length === 2));
      }
    });
  }
  if (request.id.startsWith('legacy-')) {
    check('@request', 'legacy-projection', () => {
      assert.equal(observation.legacy.requestId, submitted.id);
      assert.deepEqual(observation.legacy.results.map((row) => row.caseId), request.cases);
      for (const expected of rows) {
        const legacy = observation.legacy.results.find((row) => row.caseId === expected.id);
        const raw = evaluation.cases.find((row) => row.caseId === expected.id);
        const ordinary = expected.status === 'completed';
        assert.equal(legacy.success, ordinary);
        assert.equal(legacy.passed, ordinary ? expected.verdict === 'passed' : undefined);
        assert.equal(ownValue(legacy, 'error'), !ordinary);
        requireValue(legacy, 'expected', expected, 'expected');
        requireValue(legacy, 'output', expected, 'actual', fixture.graph);
        assert.deepEqual(legacy.consoleOutput, expected.stdout ? expected.stdout.replace(/\n$/, '').split('\n') : []);
        if (!ordinary) assert.equal(legacy.error, raw?.diagnostics.find(({ severity }) => severity === 'error')?.message || raw?.stderr.trim());
      }
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
      const kind = expected.failure?.origin === 'limit' ? 'limit' : expected.failure ? 'failed' : 'completed';
      assert.equal(consumer.kind, kind);
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
        assert(Array.isArray(events) && events.some((event) => event.line === expected.anchor && (
          (event.kind === 'snapshot' && event.target?.variable === 'n' && event.value === expected.anchorInput) ||
          (event.kind === 'stdout' && event.callStack?.at(-1)?.args?.n === expected.anchorInput)
        )), `No print-line event binding n=${expected.anchorInput}`);
      });
    }
  }
}

export function checkCppDirect(fixture, route, observation, record) {
  const prefix = `${fixture.gate}/cpp/${fixture.name}/${route}/code`;
  function check(caseId, assertion, compare) {
    const id = `${prefix}/${caseId}/${assertion}`;
    try {
      compare();
      record({ id, status: 'pass' });
    } catch (error) {
      record({ id, status: 'fail', message: errorText(error) });
    }
  }
  check('@request', 'worker-ack', () => {
    const type = route === 'generated-batch' ? 'compile-run-batch' : 'compile-run';
    const commands = observation.worker.filter((item) => item.type === type && item.action === 'command');
    assert.equal(commands.length, route === 'generated-batch' ? 1 : fixture.cases.length);
    for (const command of commands) {
      assert(observation.worker.some((item) => item.id === command.id && item.generation === command.generation && item.action === 'response'));
    }
  });
  check('@request', 'cardinality', () => assert.equal(observation.results.length, fixture.cases.length));
  for (const [index, expected] of fixture.cases.entries()) {
    const row = observation.results[index];
    if (!row) continue;
    check(expected.id, 'status', () => assert.equal(row.kind, 'completed'));
    check(expected.id, 'value', () => requireValue(row, 'output', expected, 'actual', fixture.graph));
    check(expected.id, 'console', () => assert.deepEqual(row.consoleOutput, []));
  }
}

export function checkDifferential(fixture, observations, record) {
  for (const expected of fixture.cases) {
    const id = `${fixture.gate}/${fixture.language}/${fixture.name}/default/path-differential/${expected.id}/receipt`;
    const rows = observations.flatMap((observation) => !defined(observation.reported) ? [] : (
      observation.reported.evaluation.cases.filter((item) => item.caseId === expected.id).map((row) => ({ request: observation.request, row }))
    ));
    const baseline = rows.find(({ request }) => request === `submit-default-${expected.id}`);
    if (!baseline || rows.length < 2) continue;
    const normalized = ({ sessionId, pid, startedAt, endedAt, timings, trace, value, ...row }) => ({
      ...row,
      diagnostics: row.diagnostics.filter((item) => item.kind !== 'trace-truncated'),
      valuePresent: defined(value),
    });
    try {
      for (const current of rows) {
        assert.deepEqual(normalized(current.row), normalized(baseline.row), current.request);
        if (ownValue(current.row, 'value')) {
          (fixture.graph ? assertGraph : assert.deepEqual)(current.row.value, baseline.row.value);
        }
      }
      record({ id, status: 'pass' });
    } catch (error) {
      record({ id, status: 'fail', message: errorText(error) });
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
