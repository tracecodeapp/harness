import { inspect } from './oracle.mjs';

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

function lineRange(source, line) {
  const lines = source.split('\n');
  const start = lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0);
  return { file: 'solution.cpp', start, end: start + lines[line - 1].length };
}

export function gradeProducerHistory(command, witnesses, data) {
  const legacy = command === 'producer-legacy';
  if (legacy && data.subject !== '96412c18413ae41bd7e060f54d56d4d1a9ab8574') {
    throw new Error('Unexpected legacy worker subject');
  }
  return witnesses.map(witness => {
    const { request, expected } = witness;
    const { id, source, sourceSha256 } = request;
    const row = legacy ? data.rows.find(r => r.id === id) : data[id];
    if (row?.sourceSha256 !== sourceSha256 || row.raw?.setupError) {
      return { id, status: 'unexecuted', assertions: [], raw: row };
    }
    let ordinary;
    let events;
    const assertions = [];
    if (legacy) {
      const result = row.raw.ordinary;
      ordinary = { kind: result.kind, value: result.output, console: result.consoleOutput };
      if (row.raw.traced?.kind !== 'completed' || !Array.isArray(row.raw.traced.trace?.events)) {
        return { id, status: 'unexecuted', assertions, raw: row };
      }
      const rhsLines = new Set(Object.entries(request.projection).filter(([, kinds]) => kinds.includes('read'))
        .map(([site]) => lineOf(source, request.sites[site].start)));
      // Legacy events are anchored by line only. Carry those reads as partial
      // evidence rather than guessing which of several same-line sites ran.
      events = row.raw.traced.trace.events.filter(event => event.kind === 'read' && rhsLines.has(event.line))
        .map(event => ({
          kind: event.kind, range: lineRange(source, event.line),
          observation: { state: 'value', value: event.value },
        }));
    } else {
      const resultLine = row.out?.match(/^__TRACECODE_RESULT__(.+)$/gm);
      const certified = row.broken === null && row.exit?.length === 2 && row.exit.every(x => x === 0) &&
        ['exit', 'output', 'syscalls', 'memory'].every(key => row.certificate?.[key] === true);
      if (!certified || resultLine?.length !== 1 || !Array.isArray(row.steps)) {
        return { id, status: 'unexecuted', assertions, raw: row };
      }
      const result = JSON.parse(resultLine[0].slice('__TRACECODE_RESULT__'.length));
      ordinary = { kind: 'completed', value: result, console: [] };
      events = [];
      if (request.supportedKinds.includes('availability')) {
        const range = request.sites.declare;
        const name = source.slice(range.start, range.end);
        events = row.steps.filter(step => step.fn === request.functionName && step.line === lineOf(source, range.start))
          .map(step => ({
            kind: 'availability', range, invocation: 1, phase: 'before', object: name, subobject: [],
            observation: step.state[name] === undefined || step.state[name] === '<uninitialized>'
              ? { state: 'unavailable' } : { state: 'value', value: step.state[name] },
          }));
        // Missing after events must not hide the stale before observation, and
        // the next statement's snapshot cannot stand in for local.init.
        events.forEach((event, i) => {
          const before = expected.attachment.events.filter(step => step.phase === 'before')[i];
          assertions.push({
            id: id + '/historical/before-' + i, expected: before?.observation, actual: event.observation,
            pass: JSON.stringify(before?.observation) === JSON.stringify(event.observation),
          });
        });
      }
    }
    // Neither historical subject emitted typed per-operation refusals.
    const receipt = { caseId: id, sourceSha256, ordinary, attachment: {
      status: 'complete', reason: null, coverage: [0, events.length], events, refusals: [],
    } };
    const result = inspect(witness, receipt);
    const kind = request.supportedKinds[0];
    const observed = events.filter(event => event.kind === kind).length;
    assertions.unshift({ id: id + '/historical/supported-' + kind, expected: expected.attachment.events.length,
      actual: observed, pass: expected.attachment.events.length === observed });
    return { id, ...result, assertions: [...assertions, ...result.assertions], raw: row };
  });
}
