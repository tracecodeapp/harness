import assert from 'node:assert/strict';
import { assertGraph } from './graph.mjs';
import {
  checkCacheHit, checkPresentation, checkPublication, checkRedraw, checkRetainedRows, ordinaryRow,
} from './receipt.mjs';
import { jsRouteRequests, muxRequests, requestMatrix } from './requests.mjs';

const defined = (value) => value !== undefined && !(
  value && typeof value === 'object' && Object.hasOwn(value, '$gate.undefined')
);
const ownValue = (object, key) => Object.hasOwn(object, key) && defined(object[key]);
const errorText = (error) => error instanceof Error ? error.message : String(error);

// LF is optional after each captured message. Preserve embedded newlines,
// blank lines and all other characters.
function messages(stdout) {
  if (!stdout) return [];
  return stdout.replace(/\n$/, '').split('\n');
}

function unframeMessage(message) {
  return message.replace(/\n$/, '');
}

function requireValue(row, field, expected, expectedField, graph = false) {
  const present = Object.hasOwn(expected, expectedField);
  assert.equal(ownValue(row, field), present, `${field} presence`);
  if (present) (graph ? assertGraph : assert.deepEqual)(row[field], expected[expectedField]);
}

export function checkObservation(fixture, request, observation, record, registered = false) {
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
  const compileOnly = registered && fixture.syntax;
  const rows = request.cases.map((id) => fixture.cases.find((row) => row.id === id));
  check('@request', 'order', () => {
    assert.deepEqual(evaluation.cases.map((row) => row.caseId), compileOnly ? [] : request.cases);
  });
  check('@request', 'compile', () => {
    if (compileOnly) {
      assert.equal(evaluation.status, 'compile-failed');
      assert.equal(evaluation.compile.status, 'compile-failed');
      assert.equal(evaluation.compile.failure.origin, 'program');
      assert.equal(evaluation.compile.failure.stage, 'compile');
      assert.equal(evaluation.compile.timedOut, false);
      assert.notEqual(evaluation.compile.termination.exitCode, 0);
      assert.equal(evaluation.compile.stdout, '');
      assert(evaluation.compile.diagnostics.some(({ severity, source }) => severity === 'error' && source === fixture.language));
      return;
    }
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
      if (compileOnly) {
        for (const object of [reported, evaluation, evaluation.compile]) {
          for (const field of ['attachment', 'trace', 'traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded']) {
            assert(!Object.hasOwn(object, field), `Unexpected ${field} on compile failure`);
          }
        }
        const { compileProjection, tracedCompileProjection } = observation;
        const { trace, executionTimeMs, ...tracedCompile } = tracedCompileProjection;
        assert.equal(compileProjection.kind, 'failed');
        assert.equal(compileProjection.diagnosticStage, 'compile');
        assert.equal(compileProjection.error, evaluation.compile.failure.message);
        assert.deepEqual(compileProjection.consoleOutput, []);
        assert.deepEqual(tracedCompile, compileProjection);
        assert.equal(executionTimeMs, 0);
        assert.equal(trace.language, fixture.language);
        assert.equal(trace.runId, `${fixture.language}:compile`);
        assert.deepEqual(trace.events, []);
      } else if (request.route !== 'mux') assert(defined(observation.compileProjection));
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
      if (compileOnly) assert(!defined(reported.executionId));
      else assert.equal(typeof reported.executionId, 'string');
    } else if (request.mode === 'execute') {
      assert(!defined(reported.executionId));
    } else {
      if (registered) {
        assert.equal(reported.executionId, observation.retainedExecutionId);
        assert.equal(typeof reported.executionId, 'string');
        checkRetainedRows(observation);
      } else assert(!defined(reported.executionId) || reported.executionId === observation.retainedExecutionId);
    }
    for (const row of compileOnly ? [evaluation.compile] : evaluation.cases) {
      assert.equal(typeof row.sessionId, 'string');
      assert(Number.isInteger(row.pid));
    }
  });
  if (request.mode === 'submit') {
    check('@request', 'aggregate', () => {
      const graded = compileOnly ? [] : rows;
      const passed = graded.filter((row) => row.verdict === 'passed').length;
      const allPassed = !compileOnly && passed === graded.length;
      assert.equal(reported.passedCount, passed);
      assert.equal(reported.totalCount, graded.length);
      assert.equal(reported.verdict, allPassed ? 'passed' : 'failed');
      assert.equal(reported.policy.result, allPassed);
      assert.deepEqual(reported.policy.missingFacts, []);
    });
  }
  if (fixture.playgroundScript) {
    check('@request', 'app-request-shape', () => {
      assert.equal(submitted.execution.functionName, request.functionName);
      assert.equal(submitted.execution.executionStyle, 'function');
      assert.equal(submitted.execution.trace ?? false, request.trace);
      assert.equal(Object.hasOwn(submitted.execution, 'traceOptions'), false);
      assert.deepEqual(submitted.execution.limits, request.limits);
    });
  }
  if (request.route !== 'mux') {
    check('@request', 'worker-ack', () => {
      if (registered && request.id === 'redraw-b') {
        checkRedraw(observation);
        return;
      }
      const commands = observation.worker.filter((event) => event.action === 'command' && /execute|compile-run/.test(event.type));
      const acknowledged = commands.filter((command) => observation.worker.some((event) => (
        event.action === 'response' && event.id === command.id && event.generation === command.generation
      )));
      if (evaluation.status === 'compile-failed') assert.equal(commands.length, 0);
      else if (registered && request.mode === 'continuation') {
        const refusedBeforeDispatch = commands.length === 0 && evaluation.cases.length === request.cases.length &&
          evaluation.cases.every((row) => row.attachment?.status === 'refused');
        if (!refusedBeforeDispatch) assert(acknowledged.length > 0, 'No acknowledged observation dispatch');
        assert(commands.every(({ role, mode }) => role !== 'ordinary' && mode !== 'code'), 'Continuation dispatched ordinary execution');
      } else assert(acknowledged.length > 0, 'No acknowledged worker execution request');
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
        const admitted = commands.filter(({ type, tier }) => type === 'execute-prepared-code' && tier === fixture.expectedTier);
        assert(admitted.length > 0);
        if (fixture.retainedRunner) {
          assert.equal(admitted.length, 2);
          assert.equal(new Set(admitted.map(({ generation }) => generation)).size, 1);
        }
      } else if (fixture.language === 'java') {
        assert(commands.some(({ type }) => type === 'execute-prepared-runtime-program-batch'));
      } else if (fixture.gate === 'G1' && fixture.language === 'python') {
        const executions = commands.map((command) => ({
          command,
          reply: observation.worker.find((event) => event.action === 'response'
            && event.type === 'execute-result' && event.generation === command.generation && event.id === command.id),
        }));
        assert(executions.every(({ command, reply }) => command.tier === fixture.expectedTier && reply),
          `Missing execution reply for ${fixture.expectedTier}`);
        if (fixture.expectedTier === 'hard-isolated') {
          assert.deepEqual(executions.map(({ command }) => command.inputs), rows.map(({ input }) => input));
          assert.equal(new Set(commands.map(({ generation }) => generation)).size, rows.length);
          assert(commands.every(({ type }) => type === 'execute-prepared-program'));
        } else {
          assert.equal(executions.length, 1);
          const [{ command, reply }] = executions;
          assert.equal(command.type, 'execute-prepared-program-batch');
          assert.deepEqual(command.inputs, rows.map(({ input }) => input));
          assert.equal(reply.rows, rows.length);
          for (const row of evaluation.cases) {
            if (fixture.expectedTier === 'algorithm-fast') assert.equal(row.timings?.algorithmFastBatch, true);
            else {
              assert.notEqual(row.timings?.algorithmFastBatch, true);
              assert.equal(typeof row.timings?.filesystemBeginMs, 'number');
            }
          }
        }
      } else if (fixture.expectedTier === 'hard-isolated') {
        assert.equal(new Set(commands.map(({ generation }) => generation)).size, 2);
        assert(commands.every(({ type }) => type === 'execute-prepared-program'));
      } else {
        assert(commands.some(({ type, inputs }) => type === 'execute-prepared-program-batch' && inputs.length === 2));
      }
    });
  }
  if (fixture.nodeInputCompatibility && !request.route && request.id === 'submit-default-AB') {
    check('@request', 'node-materialization', () => {
      for (const row of evaluation.cases) {
        assert.equal(row.status, 'completed');
        assert.equal(typeof row.timings?.filesystemBeginMs, 'number');
        assert.notEqual(row.timings?.algorithmFastBatch, true);
      }
    });
  }
  if (request.id.startsWith('legacy-')) {
    check('@request', 'legacy-projection', () => {
      assert.equal(observation.legacy.requestId, submitted.id);
      assert.deepEqual(observation.legacy.results.map((row) => row.caseId), request.cases);
      if (compileOnly) {
        const compile = evaluation.compile;
        assert.equal(observation.legacy.compile.status, 'compile-failed');
        for (const expected of rows) {
          const result = observation.legacy.results.find(({ caseId }) => caseId === expected.id);
          assert.equal(result.success, false);
          assert.equal(result.passed, false);
          assert(!Object.hasOwn(result, 'output'));
          assert(!Object.hasOwn(result, 'trace'));
          requireValue(result, 'expected', expected, 'expected');
          assert.equal(result.error, compile.diagnostics.find(({ severity }) => severity === 'error')?.message);
          assert.equal(result.errorLine, compile.diagnostics[0]?.line);
          assert.deepEqual(result.consoleOutput, messages(compile.stdout));
        }
        return;
      }
      for (const expected of rows) {
        const legacy = observation.legacy.results.find((row) => row.caseId === expected.id);
        const raw = evaluation.cases.find((row) => row.caseId === expected.id);
        const ordinary = expected.status === 'completed';
        assert.equal(legacy.success, ordinary);
        assert.equal(legacy.passed, ordinary ? expected.verdict === 'passed' : undefined);
        assert.equal(ownValue(legacy, 'error'), !ordinary);
        requireValue(legacy, 'expected', expected, 'expected');
        requireValue(legacy, 'output', expected, 'actual', fixture.graph);
        assert.deepEqual(legacy.consoleOutput, messages(expected.stdout));
        if (!ordinary) assert.equal(legacy.error, raw?.diagnostics.find(({ severity }) => severity === 'error')?.message || raw?.stderr.trim());
      }
    });
  }

  if (registered && observation.journal?.length &&
      (request.mode !== 'continuation' || observation.retainedJournal?.length)) {
    check('@request', 'receipt-publication', () => checkPublication(request, observation));
    if (request.id === 'redraw-b' && observation.drawnJournal?.length) {
      check('@request', 'cache-hit', () => checkCacheHit(request, observation));
    }
  }

  if (compileOnly) return;
  for (const expected of rows) {
    const index = evaluation.cases.findIndex((row) => row.caseId === expected.id);
    if (index < 0) continue;
    const row = evaluation.cases[index];
    const consumer = (registered ? observation.ordinaryProjections : observation.projections)[index];
    check(expected.id, 'identity', () => {
      assert.equal(row.caseId, expected.id);
      requireValue(row, 'expected', expected, 'expected');
    });
    check(expected.id, 'status', () => {
      assert.equal(row.status, expected.status);
      const kind = expected.failure?.origin === 'limit' ? 'limit' : expected.failure ? 'failed' : 'completed';
      assert.equal(consumer.kind, kind);
      if (registered) {
        checkPresentation(row, consumer, observation.tracedProjections[index],
          request.selected.includes(expected.id), observation.workspaceDigest);
        assert.equal(observation.traceAliases[index], true, 'Trace does not share the frozen attachment trace');
      }
    });
    check(expected.id, 'value', () => {
      requireValue(row, 'value', expected, 'actual', fixture.graph);
      requireValue(consumer, 'output', expected, 'actual', fixture.graph);
    });
    check(expected.id, 'console', () => {
      if (fixture.consolePolicy && fixture.partialWrite === 'real-partial-write') {
        assert.deepEqual(messages(row.stdout), messages(expected.stdout));
      } else assert.equal(row.stdout, expected.stdout);
      if (!expected.failure) assert.equal(row.stderr, expected.stderr);
      assert.deepEqual(consumer.consoleOutput, messages(expected.stdout));
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
      const diagnostics = registered ? row.diagnostics
        : row.diagnostics.filter((entry) => entry.kind !== 'trace-truncated');
      if (registered) assert(diagnostics.every((entry) => entry.kind !== 'trace-truncated' && entry.code !== 'trace-unavailable'));
      if (expected.failure) {
        assert(diagnostics.some((entry) => entry.severity === 'error'
          && entry.source === fixture.language
          && (!expected.failure.reason || entry.code === expected.failure.reason)
          && (!expected.errorMarker || (entry.code === 'runtime' && entry.message.includes(expected.errorMarker)))));
      } else assert.deepEqual(diagnostics, expected.diagnostics);
    });
    const trace = registered ? row.attachment?.trace : row.trace;
    if (expected.anchor && request.selected.includes(expected.id)) {
      const events = trace?.events;
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
    if (expected.instrumentedLine && request.selected.includes(expected.id)) {
      check(expected.id, 'instrumented-line', () => {
        assert(trace?.events?.some((event) => event.line === expected.instrumentedLine),
          `No recorded event on learner line ${expected.instrumentedLine}`);
      });
    }
  }
}

export function checkConsoleAcrossPaths(fixture, observations, record, framing) {
  const requests = [
    ...requestMatrix(fixture.cases.map(({ id }) => id), fixture), ...muxRequests(fixture),
    ...jsRouteRequests(fixture).flatMap(({ requests }) => requests),
  ];
  for (const expected of fixture.cases) {
    const stdout = [];
    const planned = requests.filter((request) => request.cases.includes(expected.id));
    for (const request of planned) {
      const route = request.route ?? 'default';
      const observation = observations.find((item) => item.route === route && item.request === request.id);
      const result = observation?.reported?.evaluation?.cases.find((row) => row.caseId === expected.id);
      if (typeof result?.stdout !== 'string') continue;
      stdout.push({ route, request: request.id, bytes: result.stdout });
      if (result.stdout !== expected.stdout) {
        const framingOnly = JSON.stringify(messages(result.stdout)) === JSON.stringify(messages(expected.stdout));
        framing({ fixture: fixture.name, language: fixture.language, case: expected.id, route,
          request: request.id, expected: expected.stdout, received: result.stdout, framingOnly });
      }
    }
    if (stdout.length !== planned.length) continue;
    const id = `${fixture.gate}/${fixture.language}/${fixture.name}/all-routes/console-paths/${expected.id}/stdout-bytes`;
    const baselineRequest = fixture.playgroundScript ? 'execute-untraced' : `submit-default-${expected.id}`;
    const baseline = stdout.find((row) => row.route === 'default' && row.request === baselineRequest);
    const difference = stdout.find((row) => row.bytes !== baseline.bytes);
    record(difference ? { id, status: 'fail', message: 'Path console bytes differ', baseline, difference } : { id, status: 'pass' });
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
    check(expected.id, 'status', () => {
      assert.equal(row.kind, expected.failure ? 'failed' : 'completed');
      if (expected.errorMarker) {
        assert.equal(row.diagnosticStage, 'runtime');
        assert(row.error.includes(expected.errorMarker));
      }
    });
    check(expected.id, 'value', () => requireValue(row, 'output', expected, 'actual', fixture.graph));
    check(expected.id, 'console', () => assert.deepEqual(row.consoleOutput.map(unframeMessage), messages(expected.stdout)));
  }
}

export function compileDifferentialId(fixture) {
  return `${fixture.gate}/${fixture.language}/${fixture.name}/default/path-differential/@request/compile`;
}

export function checkDifferential(fixture, observations, record, registered = false) {
  if (registered && fixture.syntax) {
    const planned = requestMatrix(fixture.cases.map(({ id }) => id), fixture).filter(({ mode }) => mode !== 'continuation');
    const evaluations = planned.map(({ id }) => observations.find(({ request }) => request === id)?.reported?.evaluation);
    if (evaluations.some((evaluation) => !evaluation)) return;
    const id = compileDifferentialId(fixture);
    function compileProjection({ sessionId, pid, startedAt, endedAt, timings, ...ordinary }) {
      return ordinary;
    }
    try {
      const baseline = compileProjection(evaluations[0].compile);
      for (const [index, current] of evaluations.entries()) {
        assert.equal(current.status, 'compile-failed', planned[index].id);
        assert.deepEqual(compileProjection(current.compile), baseline, planned[index].id);
      }
      record({ id, status: 'pass' });
    } catch (error) {
      record({ id, status: 'fail', message: errorText(error) });
    }
    return;
  }
  for (const expected of fixture.cases) {
    const id = `${fixture.gate}/${fixture.language}/${fixture.name}/default/path-differential/${expected.id}/receipt`;
    const rows = observations.flatMap((observation) => !defined(observation.reported) ? [] : (
      observation.reported.evaluation.cases.filter((item) => item.caseId === expected.id).map((row) => ({ request: observation.request, row }))
    ));
    const baselineRequest = fixture.playgroundScript ? 'execute-untraced' : `submit-default-${expected.id}`;
    const baseline = rows.find(({ request }) => request === baselineRequest);
    if (!baseline || rows.length < 2) continue;
    function normalized(result) {
      const { sessionId, pid, startedAt, endedAt, timings, trace, value, ...row } =
        registered ? ordinaryRow(result) : result;
      return {
        ...row,
        diagnostics: registered ? row.diagnostics : row.diagnostics.filter((item) => item.kind !== 'trace-truncated'),
        valuePresent: registered ? ownValue(result, 'value') : defined(value),
      };
    }
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
