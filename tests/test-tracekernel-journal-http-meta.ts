#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  type KernelJournalRecord,
} from '../packages/harness-project/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function httpRecords(workspace: Awaited<ReturnType<typeof createRuntimeWorkspace>>): Array<Extract<KernelJournalRecord, { kind: 'http' }>> {
  return workspace.journal().filter((record): record is Extract<KernelJournalRecord, { kind: 'http' }> => record.kind === 'http');
}

async function main(): Promise<void> {
  const bodyA = 'secret-body-alpha';
  const bodyB = 'secret-body-beta';
  const keyA = 'idem-secret-alpha';
  const keyB = 'idem-secret-beta';
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      hosts: ['meta.example'],
      fetch: async (request): Promise<import('../packages/harness-core/src/runtime-external-http').RuntimeExternalHttpResponse> => {
        const path = new URL(request.url).pathname;
        if (path === '/limited') {
          return {
            status: 429,
            headers: {
              'Retry-After': '15',
              'X-RateLimit-Limit': '20',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': '12345',
            },
            body: 'slow down\n',
          };
        }
        return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: `ok:${request.body ?? ''}\n` };
      },
    },
  });
  try {
    await workspace.http.request({
      method: 'POST',
      url: 'https://meta.example/same-a',
      headers: { 'Idempotency-Key': keyA, 'Content-Type': 'application/json' },
      body: bodyA,
    });
    await workspace.http.request({
      method: 'POST',
      url: 'https://meta.example/same-b',
      headers: { 'idempotency-key': keyA, 'content-type': 'application/json' },
      body: bodyA,
    });
    await workspace.http.request({
      method: 'POST',
      url: 'https://meta.example/different',
      headers: { 'Idempotency-Key': keyB, 'Content-Type': 'application/json' },
      body: bodyB,
    });
    await workspace.http.request({ url: 'https://meta.example/limited' });
    await workspace.http.request({ url: 'https://meta.example/plain' });

    const records = httpRecords(workspace);
    const sameA = records.find((record) => record.path === '/same-a');
    const sameB = records.find((record) => record.path === '/same-b');
    const different = records.find((record) => record.path === '/different');
    const limited = records.find((record) => record.path === '/limited');
    const plain = records.find((record) => record.path === '/plain');
    assertCondition(Boolean(sameA?.meta), `same-a should have http meta: ${JSON.stringify(sameA)}`);
    assertCondition(Boolean(sameB?.meta), `same-b should have http meta: ${JSON.stringify(sameB)}`);
    assertCondition(Boolean(different?.meta), `different should have http meta: ${JSON.stringify(different)}`);
    assertEqual(sameA?.meta?.idempotencyKeyFingerprint, sameB?.meta?.idempotencyKeyFingerprint, 'same idempotency key should have same fingerprint');
    assertEqual(sameA?.meta?.requestBodyFingerprint, sameB?.meta?.requestBodyFingerprint, 'same request body should have same fingerprint');
    assertEqual(sameA?.meta?.responseBodyFingerprint, sameB?.meta?.responseBodyFingerprint, 'same response body should have same fingerprint');
    assertCondition(
      sameA?.meta?.idempotencyKeyFingerprint !== different?.meta?.idempotencyKeyFingerprint,
      `different idempotency key should have different fingerprint: ${JSON.stringify(records)}`
    );
    assertCondition(
      sameA?.meta?.requestBodyFingerprint !== different?.meta?.requestBodyFingerprint,
      `different request body should have different fingerprint: ${JSON.stringify(records)}`
    );
    assertEqual(sameA?.meta?.contentType, 'application/json', 'request content-type should surface raw');

    assertEqual(limited?.meta?.retryAfter, '15', 'Retry-After should surface raw');
    assertEqual(limited?.meta?.rateLimit?.limit, '20', 'X-RateLimit-Limit should surface raw');
    assertEqual(limited?.meta?.rateLimit?.remaining, '0', 'X-RateLimit-Remaining should surface raw');
    assertEqual(limited?.meta?.rateLimit?.reset, '12345', 'X-RateLimit-Reset should surface raw');
    assertCondition(plain !== undefined && !('meta' in plain), `plain GET should omit meta: ${JSON.stringify(plain)}`);

    const serialized = JSON.stringify(workspace.journal());
    for (const secret of [bodyA, bodyB, keyA, keyB]) {
      assertCondition(!serialized.includes(secret), `journal must not contain raw body/idempotency value ${secret}: ${serialized}`);
    }
  } finally {
    workspace.dispose();
  }
}

await main();
console.log('tracekernel journal http meta tests passed');
