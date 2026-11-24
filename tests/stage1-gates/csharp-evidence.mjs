import assert from 'node:assert/strict';

// Terminal markers are minted only after the browser verifies the native
// worker event, the request ID and the worker protocol token.
export function checkCsharpAcknowledgement(observation, continuation, admittedCount) {
  const { worker, journal } = observation;
  if (!Array.isArray(worker)) return false;
  const commands = worker.filter(({ action }) => action === 'command');
  const starts = worker.filter(({ action }) => action === 'ordinary-start');
  const ordinary = commands.filter(({ type, mode }) => type === 'execute-prepared-code' && mode === 'code');
  const same = (command, event) => command.id === event.id && command.generation === event.generation;
  const terminal = (command) => worker.find((event) => event.action === 'response' &&
    event.csharpTerminal === true && same(command, event));

  if (continuation) {
    assert.equal(starts.length, 0, 'Continuation started an ordinary case');
    const executions = commands.filter(({ type }) => /execute|compile-run/.test(type));
    assert(executions.every(({ type, mode, role }) => type === 'execute-prepared-trace' &&
      mode === 'trace' && role !== 'ordinary'), 'Continuation dispatched ordinary execution');
    if (!executions.length) {
      const rows = observation.reported.evaluation.cases;
      return rows.length > 0 && rows.every(({ attachment }) => attachment?.status === 'refused') &&
        Array.isArray(journal) && journal.some(({ phase }) => phase === 'public-resolve');
    }
    assert.equal(executions.length, 1);
    const [command] = executions;
    const reply = terminal(command);
    assert(!Array.isArray(reply?.startedCaseIndexes) || !reply.startedCaseIndexes.length,
      'Observer terminal acknowledged an ordinary start');
    if (command.csharpProtocol !== true || typeof command.attemptToken !== 'string' ||
        !command.attemptToken.length || reply?.recorderToken !== command.attemptToken || !Array.isArray(journal)) return false;
    const [row] = observation.reported.evaluation.cases;
    const drawing = row?.attachment;
    if (!drawing) return false;
    const phases = ['observer-start', 'observer-end', 'attachment-bind'].map((phase) => journal.filter(
      (event) => event.phase === phase && event.caseId === row.caseId && event.attemptToken === command.attemptToken &&
        event.evaluationId === drawing.evaluationId && event.workspaceDigest === drawing.workspaceDigest &&
        event.generation === drawing.generation
    ));
    if (phases.some((entries) => !entries.length)) return false;
    assert(phases.every((entries) => entries.length === 1), 'Duplicate C# observer lifecycle evidence');
    const [[start], [end], [bind]] = phases;
    assert(start.sequence < end.sequence && end.sequence < bind.sequence, 'C# observer lifecycle is out of order');
    return true;
  }

  assert(starts.every((event) => ordinary.some((command) => same(command, event))), 'Unmatched ordinary start');
  if (!ordinary.length) return false;
  assert.equal(ordinary.length, admittedCount, 'Ordinary C# command count differs from admitted case count');
  let complete = true;
  for (const command of ordinary) {
    const reply = terminal(command);
    const observed = starts.filter((event) => same(command, event));
    assert(observed.length <= 1 && observed.every(({ caseIndex }) => caseIndex === 0), 'Invalid C# ordinary start');
    if (command.reportsStarts !== true || !Array.isArray(reply?.startedCaseIndexes)) {
      complete = false;
      continue;
    }
    assert.deepEqual(reply.startedCaseIndexes, [0]);
    if (!observed.length) {
      complete = false;
      continue;
    }
    assert.deepEqual(observed.map(({ caseIndex }) => caseIndex), [0]);
    assert(worker.indexOf(observed[0]) < worker.indexOf(reply), 'Start followed its terminal reply');
  }
  return complete;
}
