#!/usr/bin/env npx tsx

import {
  runtimeWorkspaceActorPreset,
  type KernelJournalRecord,
} from '../packages/harness-core/src/index';
import type {
  TraceKernelFileSystemMutation,
  TraceKernelProcessSnapshot,
} from '../packages/tracekernel/src/index';
import type { RuntimeKernelProcessRecord } from '../packages/harness-project/src/process-state';
import { WorkspaceEventState } from '../packages/harness-project/src/workspace-event-state';
import { WorkspaceJournal } from '../packages/harness-project/src/workspace-journal';

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  const principal = runtimeWorkspaceActorPreset('principal');
  const system = runtimeWorkspaceActorPreset('system');
  const snapshot = {
    pid: 7,
    ppid: 1,
    cwd: '/home/user/project',
    owner: { id: principal.id, kind: 'user' },
  } as TraceKernelProcessSnapshot;
  const process = {
    pid: snapshot.pid,
    actor: principal,
  } as RuntimeKernelProcessRecord;
  const emitted: KernelJournalRecord[] = [];
  const eventState = new WorkspaceEventState();
  const journal = new WorkspaceJournal({
    cwd: '/home/user/project',
    eventState,
    systemActor: system,
    authoritativeProcessSnapshot: ({ pid }) =>
      pid === snapshot.pid ? snapshot : undefined,
    resolveFileSystemMutationProcess: () => ({
      process,
      snapshot,
    }),
    emitJournalEvent: (record) => {
      emitted.push(record);
    },
  });

  const processRecord = journal.record(
    {
      kind: 'process',
      op: 'exec',
      pid: snapshot.pid,
      argv: 'node app.js',
      cwd: '/wrong',
    },
    undefined,
    principal
  );
  assertCondition(
    processRecord.kind === 'process' &&
      processRecord.pid === snapshot.pid &&
      processRecord.ppid === snapshot.ppid &&
      processRecord.cwd === snapshot.cwd &&
      processRecord.actor ===
        `${principal.kind}:${principal.id}`,
    'process entries should use the authoritative kernel snapshot'
  );

  journal.recordFileChange({
    type: 'file-change',
    change: { path: 'src/index.ts', contents: 'export {};\n' },
    phase: 'live',
    actor: principal,
  });
  const fileRecord = journal.journal().at(-1);
  assertCondition(
    fileRecord?.kind === 'fs' &&
      fileRecord.op === 'write' &&
      fileRecord.path === 'src/index.ts',
    'file changes should project into filesystem journal entries'
  );

  const secret = 'Bearer secret-token';
  journal.recordHttp(
    {
      method: 'POST',
      url: 'https://api.example.test/items',
      path: '/items',
      headers: {
        authorization: secret,
        'content-type': 'application/json',
        'idempotency-key': 'request-1',
      },
      body: '{"name":"item"}',
    },
    new URL('https://api.example.test/items'),
    'external',
    principal,
    undefined,
    {
      error: `upstream rejected ${secret}`,
      response: {
        status: 503,
        headers: { 'retry-after': '2' },
        body: '{"error":"unavailable"}',
      },
    }
  );
  const httpRecord = journal.journal().at(-1);
  assertCondition(
    httpRecord?.kind === 'http' &&
      httpRecord.authPresent === true &&
      typeof httpRecord.authFingerprint === 'string' &&
      !JSON.stringify(httpRecord).includes(secret) &&
      httpRecord.error?.includes('redacted') === true &&
      httpRecord.meta?.retryAfter === '2' &&
      typeof httpRecord.meta?.requestBodyFingerprint === 'string',
    'HTTP journal entries should fingerprint evidence and redact credentials'
  );

  journal.recordFileSystemMutation({
    generation: 1,
    eventType: 'change',
    operation: 'write',
    paths: ['/home/user/project/generated.txt'],
    origin: {},
  } satisfies TraceKernelFileSystemMutation);
  const mutationRecord = journal.journal().at(-1);
  assertCondition(
    mutationRecord?.kind === 'fs' &&
      mutationRecord.pid === snapshot.pid &&
      mutationRecord.path === 'generated.txt',
    'TraceKernel filesystem mutations should retain authoritative PID attribution'
  );
  assertCondition(
    emitted.length === journal.journal().length,
    'each recorded journal entry should emit exactly one event'
  );
}

main();
console.log('workspace journal tests passed');
