#!/usr/bin/env npx tsx

import {
  WorkspaceEventState,
  type KernelJournalEntry,
} from '../packages/tracekernel/src/workspace/workspace-event-state';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function processEntry(pid: number): KernelJournalEntry {
  return {
    kind: 'process',
    op: 'exec',
    pid,
    argv: `command-${pid}`,
  };
}

function testBoundedKernelEvents(): void {
  const state = new WorkspaceEventState(2);
  state.recordKernelEvent({ type: 'first' });
  state.recordKernelEvent({ type: 'second', pid: 2 });
  const latest = state.recordKernelEvent({
    type: 'third',
    pid: 3,
    detail: { state: 'running' },
  });

  assertEqual(latest.seq, 3, 'event sequence should be monotonic');
  assertCondition(
    !Number.isNaN(new Date(latest.time).getTime()),
    'event timestamp should be an ISO date'
  );
  const events = state.kernelEvents();
  assertEqual(events.length, 2, 'event history should respect retention');
  assertEqual(events[0]?.type, 'second', 'retention should discard oldest event');
  assertEqual(events[1]?.detail?.state, 'running', 'event detail should survive');
}

function testJournalReads(): void {
  const state = new WorkspaceEventState(2);
  state.recordJournal(processEntry(1));
  state.recordJournal(processEntry(2));
  const third = state.recordJournal(processEntry(3));

  assertEqual(third.seq, 3, 'journal sequence should be monotonic');
  const journal = state.journal();
  assertEqual(journal.length, 2, 'journal should respect retention');
  assertEqual(journal[0]?.seq, 2, 'journal should retain the newest range');
  assertEqual(state.journal(2).length, 1, 'journal should filter by sequence');

  const copy = [...state.journal()];
  copy.splice(0);
  assertEqual(
    state.journal().length,
    2,
    'journal snapshots should not expose the mutable backing array'
  );
}

function testWatchLifecycle(): void {
  const state = new WorkspaceEventState();
  const phases: string[] = [];
  const unwatchFirst = state.watch((event) => {
    if (event.type === 'status') phases.push(`first:${event.phase}`);
  });
  state.watch((event) => {
    if (event.type === 'status') phases.push(`second:${event.phase}`);
  });

  state.dispatch({ type: 'status', phase: 'queued', message: 'Queued' });
  unwatchFirst();
  state.dispatch({ type: 'status', phase: 'running', message: 'Running' });
  state.clearWatchers();
  state.dispatch({ type: 'status', phase: 'finished', message: 'Finished' });

  assertEqual(
    phases.join(','),
    'first:queued,second:queued,second:running',
    'watchers should unsubscribe and clear deterministically'
  );
}

testBoundedKernelEvents();
testJournalReads();
testWatchLifecycle();

console.log('workspace event state tests passed');
