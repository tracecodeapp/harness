import { appendSuiteEvent } from './suite-events.mjs';

export function leafLedger(leaf) {
  const nonce = process.env.TRACECODE_SUITE_NONCE;
  function record(kind, id) {
    appendSuiteEvent({ leaf, kind, id });
  }
  record('start');
  return {
    nonce: nonce ?? 'standalone',
    checked(id) { record('assertion', id); },
    done() { record('done'); },
  };
}

export function missingEvidence(leaf, expected, events) {
  const issues = [];
  const own = events.filter((event) => event.leaf === leaf);
  if (!own.length) return [`G7/suite/${leaf}/missing-leaf`];
  const starts = own.filter((event) => event.kind === 'start');
  const ends = own.filter((event) => event.kind === 'done');
  if (starts.length !== 1 || ends.length !== 1 || own.at(-1)?.kind !== 'done' ||
      !own.every(({ pid, nonce }) => pid === starts[0]?.pid && nonce === starts[0]?.nonce)) {
    issues.push(`G7/suite/${leaf}/missing-or-duplicate-terminal`);
  }
  const seen = own.filter((event) => event.kind === 'assertion').map(({ id }) => id);
  if (!seen.length) issues.push(`G7/suite/${leaf}/zero-assertions`);
  for (const id of expected) {
    if (!seen.includes(id)) issues.push(`G7/suite/${leaf}/missing-assertion/${id}`);
  }
  for (const id of new Set(seen)) {
    if (!expected.includes(id) || seen.filter((actual) => actual === id).length !== 1) {
      issues.push(`G7/suite/${leaf}/unexpected-or-duplicate-assertion/${id}`);
    }
  }
  return issues;
}
