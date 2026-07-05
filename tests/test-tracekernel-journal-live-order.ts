#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type KernelJournalRecord,
  type RuntimeCommandEvent,
} from '../packages/harness-project/src/index';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nactual: ${actualJson}\nexpected: ${expectedJson}`);
  }
}

function journalEvents(events: readonly RuntimeCommandEvent[]): KernelJournalRecord[] {
  return events
    .filter((event): event is Extract<RuntimeCommandEvent, { type: 'kernel-journal' }> => event.type === 'kernel-journal')
    .map((event) => event.record);
}

function outputIndex(events: readonly RuntimeCommandEvent[], text: string): number {
  const index = events.findIndex((event) => event.type === 'output' && event.stream === 'stdout' && event.data.includes(text));
  assertCondition(index !== -1, `missing stdout event containing ${JSON.stringify(text)} in ${JSON.stringify(events)}`);
  return index;
}

function journalIndex(events: readonly RuntimeCommandEvent[], predicate: (record: KernelJournalRecord) => boolean): number {
  const index = events.findIndex((event) => event.type === 'kernel-journal' && predicate(event.record));
  assertCondition(index !== -1, `missing journal event in ${JSON.stringify(events)}`);
  return index;
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    files: [{ path: 'live-order.js', contents: 'runner\n' }],
    externalHttp: {
      hosts: ['live-order.example'],
      fetch: async () => ({ status: 200, body: 'response\n' }),
    },
    nodeRunner: async (request) => {
      request.onEvent?.({ type: 'file-change', phase: 'live', change: { path: 'live-order.txt', contents: 'file\n' } });
      request.onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'before-http\n' });
      const response = await request.kernelHttp?.dispatch({
        method: 'GET',
        url: 'https://live-order.example/path',
        path: '/path',
      });
      request.onEvent?.({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-http\n' });
      return {
        stdout: '',
        stderr: '',
        exitCode: response?.status === 200 ? 0 : 1,
      };
    },
  });
  const events: RuntimeCommandEvent[] = [];
  const baselineSeq = workspace.journal().at(-1)?.seq ?? 0;
  const unsubscribe = workspace.watch((event) => events.push(event));
  try {
    const result = await workspace.runCommand('node live-order.js');
    assertCondition(result.exitCode === 0, `live-order command should succeed: ${JSON.stringify(result)}`);

    const liveJournal = journalEvents(events);
    const snapshot = workspace.journal(baselineSeq);
    assertDeepEqual(liveJournal, snapshot, 'live kernel-journal events should deep-equal journal() order and content');
    assertDeepEqual(
      liveJournal.map((record) => record.seq),
      [...liveJournal].map((record) => record.seq).sort((left, right) => left - right),
      'live journal seq should be monotonic'
    );

    const before = outputIndex(events, 'before-http\n');
    const after = outputIndex(events, 'after-http\n');
    const fs = journalIndex(events, (record) => record.kind === 'fs' && record.path === 'live-order.txt');
    const http = journalIndex(events, (record) => record.kind === 'http' && record.host === 'live-order.example');
    const exit = journalIndex(events, (record) => record.kind === 'process' && record.op === 'exit');
    assertCondition(fs < before, `fs journal should precede stdout emitted after the write: ${JSON.stringify(events)}`);
    assertCondition(before < http, `http journal should follow stdout before curl: ${JSON.stringify(events)}`);
    assertCondition(http < after, `http journal should precede stdout after curl: ${JSON.stringify(events)}`);
    assertCondition(after < exit, `process exit journal should follow final stdout: ${JSON.stringify(events)}`);
  } finally {
    unsubscribe();
    await workspace.destroy();
  }
}

await main();
console.log('tracekernel journal live-order tests passed');
