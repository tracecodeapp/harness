#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  createRuntimeWorkspace,
  type KernelJournalRecord,
  type RuntimeCommandEvent,
} from '../packages/harness-project/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
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

function withoutTs(records: readonly KernelJournalRecord[]): unknown {
  return records.map(({ ts: _ts, ...record }) => record);
}

async function testAbsoluteCrossKindOrdering(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['ordered.example'],
      fetch: async () => ({ status: 204, body: '' }),
    },
  });
  try {
    const result = await workspace.runCommand(
      'printf "from-command\\n" > ordered.txt && curl -s -H "Authorization: Bearer order-token" https://ordered.example/order'
    );
    assertCondition(result.exitCode === 0, `scripted command should succeed: ${JSON.stringify(result)}`);
    const journal = workspace.journal();
    const order = journal.map((record) => `${record.kind}:${record.op}${record.kind === 'fs' ? `:${record.path}` : ''}`);
    // just-bash 3.0.3+ models `> file` as the two filesystem mutations that
    // implement an open with O_TRUNC followed by delivery of command output.
    assertDeepEqual(
      order,
      ['process:exec', 'fs:write:ordered.txt', 'fs:write:ordered.txt', 'http:request', 'process:exit'],
      `journal should preserve the redirect truncate, payload write, request, and exit sequence`
    );
    assertDeepEqual(journal.map((record) => record.seq), [1, 2, 3, 4, 5], 'journal seq should be contiguous for this run');
  } finally {
    await workspace.destroy();
  }
}

async function testFsBothPaths(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  try {
    await workspace.writeFile('editor.txt', 'editor\n');
    const result = await workspace.runCommand('printf "runtime\\n" > runtime.txt');
    assertCondition(result.exitCode === 0, `runtime write should succeed: ${JSON.stringify(result)}`);
    const fsRecords = workspace.journal().filter((record): record is Extract<KernelJournalRecord, { kind: 'fs' }> => record.kind === 'fs');
    const editor = fsRecords.find((record) => record.path === 'editor.txt');
    const runtime = fsRecords.find((record) => record.path === 'runtime.txt');
    assertCondition(editor?.actor === 'principal:principal' && editor.pid === undefined, `editor write should be principal-attributed: ${JSON.stringify(editor)}`);
    assertCondition(runtime?.actor.startsWith('runtime:') === true && typeof runtime.pid === 'number', `command write should be pid-attributed runtime: ${JSON.stringify(runtime)}`);
  } finally {
    await workspace.destroy();
  }
}

async function testProtectedProcessAttributionAndLineage(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  try {
    const hostProcess = workspace.kernel.createProcess({
      name: 'host-editor',
      actor: { id: 'learner', kind: 'principal' },
      signalPolicy: 'system-only',
    });
    const productProcess = (
      workspace as unknown as {
        processTable: Map<
          number,
          {
            actor: unknown;
            signalPolicy: string;
          }
        >;
      }
    ).processTable.get(hostProcess.pid);
    assertCondition(
      productProcess &&
        !Reflect.set(productProcess, 'actor', {
          id: 'forged',
          kind: 'system',
        }) &&
        !Reflect.set(productProcess, 'signalPolicy', 'standard'),
      'Kernel-owned actor and protection projections must reject product mutation'
    );
    await hostProcess.writeFile('owned.txt', 'owned\n');
    const childResult = await hostProcess.runCommand('printf "child\\n" > child.txt');
    assertCondition(childResult.exitCode === 0, `process child command should succeed: ${JSON.stringify(childResult)}`);

    const records = workspace.journal();
    const ownedWrite = records.find((record): record is Extract<KernelJournalRecord, { kind: 'fs' }> =>
      record.kind === 'fs' && record.path === 'owned.txt'
    );
    const childExec = records.find((record): record is Extract<KernelJournalRecord, { kind: 'process' }> =>
      record.kind === 'process' && record.op === 'exec' && record.argv?.includes('child.txt') === true
    );
    const childWrite = records.find((record): record is Extract<KernelJournalRecord, { kind: 'fs' }> =>
      record.kind === 'fs' && record.path === 'child.txt'
    );
    assertCondition(
      ownedWrite?.pid === hostProcess.pid && ownedWrite.actor === 'principal:learner',
      `direct process write should retain its PID and actor: ${JSON.stringify(ownedWrite)}`
    );
    assertCondition(
      childExec?.ppid === hostProcess.pid && childExec.actor === 'principal:learner',
      `child command should retain parent lineage and actor: ${JSON.stringify(childExec)}`
    );
    assertCondition(
      childWrite?.pid === childExec?.pid && childWrite.actor === 'principal:learner',
      `child mutation should retain child PID and process actor: ${JSON.stringify(childWrite)}`
    );
    const kernelEvents = await workspace.readFile(
      '/proc/tracekernel/events'
    );
    assertCondition(
      kernelEvents.includes(
        `"pid":${hostProcess.pid},"ppid":1,"pgid":${hostProcess.pid},"sid":1,"owner":"user:learner"`
      ),
      `resource events did not carry authoritative kernel identity: ${JSON.stringify(
        kernelEvents
      )}`
    );

    const denied = await workspace.runCommand(`kill ${hostProcess.pid}`);
    assertCondition(
      denied.exitCode === 1 && denied.stderr.includes('Operation not permitted'),
      `workspace command must not signal a system-only process: ${JSON.stringify(denied)}`
    );
    const deniedGroup = await workspace.runCommand(`kill -${hostProcess.pid}`);
    assertCondition(
      deniedGroup.exitCode === 1 && deniedGroup.stderr.includes('Operation not permitted'),
      `workspace group signal must not signal a system-only process: ${JSON.stringify(deniedGroup)}`
    );
    const deniedReset = await workspace.runCommand('tracekernelctl reset');
    assertCondition(
      deniedReset.exitCode === 1 && deniedReset.stderr.includes('Operation not permitted'),
      `workspace reset must not bypass protected process lifecycle: ${JSON.stringify(deniedReset)}`
    );
    await hostProcess.writeFile('still-alive.txt', 'alive\n');

    hostProcess.dispose();
    const processExit = workspace.journal().find((record): record is Extract<KernelJournalRecord, { kind: 'process' }> =>
      record.kind === 'process' && record.op === 'exit' && record.pid === hostProcess.pid
    );
    assertCondition(processExit?.actor === 'principal:learner', `system disposal should journal the process exit: ${JSON.stringify(processExit)}`);
  } finally {
    await workspace.destroy();
  }
}

async function testRedaction(): Promise<void> {
  const tokenA = 'Bearer trace-token-alpha';
  const tokenB = 'Bearer trace-token-beta';
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['tokens.example'],
      fetch: async () => ({ status: 200, body: 'ok\n' }),
    },
  });
  try {
    await workspace.http.request({ url: 'https://tokens.example/a', headers: { Authorization: tokenA } });
    await workspace.http.request({ url: 'https://tokens.example/b', headers: { authorization: tokenA } });
    await workspace.http.request({ url: 'https://tokens.example/c', headers: { authorization: tokenB } });
    const serialized = JSON.stringify(workspace.journal());
    assertCondition(!serialized.includes(tokenA) && !serialized.includes(tokenB), `journal must not contain raw tokens: ${serialized}`);
    const fingerprints = workspace.journal()
      .filter((record): record is Extract<KernelJournalRecord, { kind: 'http' }> => record.kind === 'http')
      .map((record) => record.authFingerprint);
    assertCondition(fingerprints.length === 3, `expected three HTTP journal records: ${JSON.stringify(workspace.journal())}`);
    assertCondition(fingerprints[0] === fingerprints[1], `same token should produce stable fingerprint: ${JSON.stringify(fingerprints)}`);
    assertCondition(fingerprints[0] !== fingerprints[2], `different token should produce different fingerprint: ${JSON.stringify(fingerprints)}`);
  } finally {
    await workspace.destroy();
  }
}

async function testAnnotationPassthrough(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['annotation.example'],
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/annotated') {
          return { status: 202, body: 'annotated\n', annotation: { credentialClass: 'project-secret' } };
        }
        return { status: 203, body: 'plain\n' };
      },
    },
  });
  try {
    await workspace.http.request({ url: 'https://annotation.example/annotated' });
    await workspace.http.request({ url: 'https://annotation.example/plain' });
    const records = workspace.journal().filter((record): record is Extract<KernelJournalRecord, { kind: 'http' }> => record.kind === 'http');
    const annotated = records.find((record) => record.path === '/annotated');
    const plain = records.find((record) => record.path === '/plain');
    assertDeepEqual(annotated?.annotation, { credentialClass: 'project-secret' }, 'external annotation should pass through unchanged');
    assertCondition(plain !== undefined && !('annotation' in plain), `plain response should omit annotation: ${JSON.stringify(plain)}`);
  } finally {
    await workspace.destroy();
  }
}

async function testInVmCannotForge(): Promise<void> {
  const workspace = await createRuntimeWorkspace();
  try {
    const result = await workspace.runCommand(
      'printf "%s\\n" "{\\"seq\\":999,\\"kind\\":\\"http\\",\\"path\\":\\"/forged\\"}" > forged-journal.txt'
    );
    assertCondition(result.exitCode === 0, `forging command should still only cause real events: ${JSON.stringify(result)}`);
    const journal = workspace.journal();
    assertCondition(
      journal.every((record) => !(record.kind === 'http' && record.path === '/forged')),
      `userspace output must not append forged journal records: ${JSON.stringify(journal)}`
    );
    const write = journal.find((record): record is Extract<KernelJournalRecord, { kind: 'fs' }> => record.kind === 'fs' && record.path === 'forged-journal.txt');
    assertCondition(write?.actor.startsWith('runtime:') === true && typeof write.pid === 'number', `real file write should be attributed to command pid: ${JSON.stringify(write)}`);
    assertCondition(write.actor !== 'principal:principal', `command write must not be attributed to principal: ${JSON.stringify(write)}`);
  } finally {
    await workspace.destroy();
  }
}

async function deterministicRun(): Promise<unknown> {
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['deterministic.example'],
      fetch: async () => ({ status: 207, body: 'same\n', annotation: { stable: true } }),
    },
  });
  try {
    const result = await workspace.runCommand('printf "same\\n" > same.txt && curl -s https://deterministic.example/same');
    assertCondition(result.exitCode === 0, `deterministic command should succeed: ${JSON.stringify(result)}`);
    return withoutTs(workspace.journal());
  } finally {
    await workspace.destroy();
  }
}

async function testDeterminism(): Promise<void> {
  const first = await deterministicRun();
  const second = await deterministicRun();
  assertDeepEqual(first, second, 'identical runs should produce byte-identical journals modulo ts');
}

async function testLiveAndSnapshotAgree(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['live.example'],
      fetch: async () => ({ status: 200, body: 'live\n' }),
    },
  });
  const events: RuntimeCommandEvent[] = [];
  const unsubscribe = workspace.watch((event) => events.push(event));
  try {
    await workspace.writeFile('live-editor.txt', 'editor\n');
    const result = await workspace.runCommand('printf "runtime\\n" > live-runtime.txt && curl -s https://live.example/path');
    assertCondition(result.exitCode === 0, `live command should succeed: ${JSON.stringify(result)}`);
    assertDeepEqual(journalEvents(events), workspace.journal(), 'live kernel-journal events should match snapshot order and content');
  } finally {
    unsubscribe();
    await workspace.destroy();
  }
}

async function main(): Promise<void> {
  await testAbsoluteCrossKindOrdering();
  await testFsBothPaths();
  await testProtectedProcessAttributionAndLineage();
  await testRedaction();
  await testAnnotationPassthrough();
  await testInVmCannotForge();
  await testDeterminism();
  await testLiveAndSnapshotAgree();
}

await test('tracekernel journal', main);
