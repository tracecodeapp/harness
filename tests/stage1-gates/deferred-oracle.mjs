import assert from 'node:assert/strict';

const phase = (journal, name) => journal.filter((event) => event.phase === name);
const scoped = (left, right) => left && right &&
  ['evaluationId', 'workspaceDigest', 'generation'].every((key) => left[key] === right[key]);
const ordinary = ({ attachment, trace, ...row }) => row;
const grading = ({ attachment, trace, sessionId, pid, timings, startedAt, endedAt, ...row }) => row;

export function deferredChecks(scenario, report, checkDrawing) {
  const checks = {};
  const check = (route, name, assertion) => { checks[`${route}/@request/${name}`] = assertion; };
  const run = 'run-first-deferred';
  const draw = 'draw-first-deferred';
  const { initial, continuation, caseId, verdict, draw: drawing, joined, workspaceDigest } = report;
  const { fault, dispose, suffix, cut } = scenario;
  const all = [...(initial ?? []), ...(continuation ?? [])];
  const binds = phase(all, 'attachment-bind');
  const starts = phase(all, 'observer-start');
  const row = verdict?.evaluation.cases.find((candidate) => candidate.caseId === caseId);
  const drawnRow = drawing?.evaluation.cases[0];
  const [commit] = phase(initial ?? [], 'ordinary-commit');
  const [resolve] = phase(initial ?? [], 'public-resolve');
  const [resolved] = phase(continuation ?? [], 'public-resolve');

  check(run, 'ordinary-commit', () => {
    assert.equal(phase(initial, 'ordinary-commit').length, 1);
    assert.equal(phase(initial, 'public-resolve').length, 1);
    assert.equal(resolve.request, 'initial');
    assert.equal(commit.workspaceDigest, workspaceDigest);
    assert(scoped(resolve, commit) && commit.sequence < resolve.sequence);
    assert.equal(typeof verdict.executionId, 'string');
  });
  check(run, 'drawing-free-verdict', () => {
    assert.deepEqual(verdict?.deferredDrawings, [caseId]);
    assert(verdict.evaluation.cases.length > 0);
    for (const row of verdict.evaluation.cases) {
      assert(!Object.hasOwn(row, 'attachment'), 'Verdict row carries attachment');
      assert(!Object.hasOwn(row, 'trace'), 'Verdict row carries compatibility trace');
    }
  });
  if (!fault && !dispose) check(run, 'joined-grading', () => {
    assert.deepEqual(verdict.evaluation.cases.map(grading), joined.evaluation.cases.map(grading));
    assert.deepEqual(report.verdictGrade, report.joinedGrade);
  });
  if (!fault && !suffix) check(run, 'verdict-before-observer-end', () => {
    const acks = phase(all, 'injection-ack').filter((event) => event.point === 'observe' && event.fault === 'stall');
    const ends = phase(all, 'observer-end').filter((event) => event.caseId === caseId);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].caseId, caseId);
    assert(scoped(acks[0], commit));
    assert.equal(ends.length, 1);
    assert(scoped(ends[0], commit) && resolve.sequence < ends[0].sequence, 'Verdict resolved after observer-end');
  });
  if (dispose) {
    check(draw, 'disposed', () => {
      assert.equal(report.rejection?.name, 'JudgePlanError');
      assert.equal(phase(continuation, 'public-resolve').length, 0);
      assert.equal(binds.length, 0, 'Disposed observer published a bind');
    });
    return checks;
  }
  check(draw, 'continuation-resolve', () => {
    for (const name of ['ordinary-commit', 'ordinary-write-attempt', 'ordinary-case-started']) {
      assert.equal(phase(continuation, name).length, 0, name);
    }
    assert.equal(phase(continuation, 'public-resolve').length, 1);
    assert.equal(resolved.request, 'continuation');
    assert(scoped(resolved, commit) && resolve.sequence < resolved.sequence);
    assert.equal(drawing.executionId, verdict.executionId);
    assert.deepEqual(drawing.evaluation.cases.map(({ caseId }) => caseId), [caseId]);
    assert.deepEqual(ordinary(drawnRow), row);
    assert.deepEqual(report.verdictAfterDraw, verdict);
  });
  check(draw, 'scoped-bind', () => {
    assert.equal(binds.length, 1);
    const [bind] = binds;
    assert.equal(bind.caseId, caseId);
    assert.equal(drawnRow.attachment.caseId, caseId);
    assert(scoped(bind, commit) && scoped(drawnRow.attachment, commit));
    assert(commit.sequence < bind.sequence && bind.sequence < resolved.sequence);
  });
  check(draw, 'observer-start-count', () => {
    const expected = suffix || fault?.point === 'prepare' ? 0 : 1;
    assert.equal(starts.length, expected, 'Unexpected observer-start count across both journals');
    if (expected) {
      assert.equal(starts[0].caseId, caseId);
      assert(scoped(starts[0], commit));
      assert.equal(starts[0].attemptToken, binds[0].attemptToken);
    }
  });
  check(draw, 'drawing', () => {
    const attachment = drawnRow.attachment;
    if (suffix) {
      assert.equal(row.status, 'not-run');
      assert.equal(attachment.status, 'refused');
      assert.equal(attachment.reason, 'case-not-run');
    } else if (fault) {
      const acks = phase(all, 'injection-ack');
      assert.equal(acks.length, 1);
      assert.equal(acks[0].point, fault.point);
      assert.equal(acks[0].fault, fault.fault);
      assert(scoped(acks[0], commit) && acks[0].sequence < binds[0].sequence);
      assert.equal(acks[0].caseId, fault.point === 'prepare' ? undefined : caseId);
      assert.equal(acks[0].attemptToken, fault.point === 'prepare' ? undefined : binds[0].attemptToken);
      assert.equal(attachment.status, 'refused');
      assert.equal(attachment.reason, fault.reason);
    } else if (cut) {
      assert.equal(attachment.status, 'truncated');
      assert.equal(attachment.reason, cut);
      if (cut === 'byte-budget') assert.equal(attachment.trace.events.length, 0);
      assert(Number.isSafeInteger(attachment.attemptedEvents) && attachment.attemptedEvents > attachment.trace.events.length);
      if (cut === 'step-budget') assert(attachment.trace.events.length > 0);
    } else {
      assert.equal(attachment.status, 'drawn');
      assert(attachment.trace.events.length > 0);
    }
    checkDrawing(drawnRow, report);
  });
  return checks;
}

export function assertDeferred(prefix, scenario, report, checkDrawing) {
  return Object.entries(deferredChecks(scenario, report, checkDrawing)).map(([key, check]) => {
    const id = `${prefix}/${key}`;
    try {
      if (report.error) throw new Error(report.error.message);
      check();
      return { id, status: 'pass' };
    } catch (error) {
      return { id, status: 'fail', message: error.message };
    }
  });
}
