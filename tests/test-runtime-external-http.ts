#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  createDefaultExternalHttpFetch,
  isBlockedExternalHttpHost,
  RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES,
  type RuntimeExternalHttpRequest,
  type RuntimeExternalHttpResponse,
} from '../packages/runtime-core/src/runtime-external-http';

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function externalRequest(overrides: Partial<RuntimeExternalHttpRequest> = {}): RuntimeExternalHttpRequest {
  return {
    method: 'GET',
    url: 'https://allowed.example/start',
    headers: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function expectReject(
  operation: () => Promise<RuntimeExternalHttpResponse>,
  expectedMessage: string
): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assertCondition(failure instanceof Error, `operation should reject with an Error containing ${expectedMessage}`);
  assertCondition(
    failure.message.includes(expectedMessage),
    `rejection should include ${JSON.stringify(expectedMessage)}: ${failure.message}`
  );
}

async function withMockFetch<T>(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  operation: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof globalThis.fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testTerminalDnsDotBlocklist(): void {
  for (const url of [
    'https://localhost./',
    'https://api.localhost./',
    'https://printer.local./',
    'https://svc.internal./',
    'https://metadata.google.internal./',
  ]) {
    assertCondition(isBlockedExternalHttpHost(new URL(url)) !== null, `terminal-dot hostname should be blocked: ${url}`);
  }
  assertCondition(
    isBlockedExternalHttpHost(new URL('https://public.example./')) === null,
    'a terminal dot alone should not classify a public hostname as private'
  );
}

function testNonPublicAddressSpaceBlocklist(): void {
  for (const url of [
    'https://100.64.0.1/',
    'https://198.18.0.1/',
    'https://224.0.0.1/',
    'https://router/',
    'https://router.home.arpa/',
    'https://router.lan/',
    'https://[fec0::1]/',
    'https://[ff02::1]/',
    'https://[64:ff9b::a00:1]/',
    'https://[2002:0a00:0001::1]/',
  ]) {
    assertCondition(isBlockedExternalHttpHost(new URL(url)) !== null, `non-public host should be blocked: ${url}`);
  }
  for (const url of [
    'https://100.63.255.255/',
    'https://100.128.0.0/',
    'https://public.example/',
    'https://[2606:4700:4700::1111]/',
  ]) {
    assertCondition(isBlockedExternalHttpHost(new URL(url)) === null, `public host should remain routable: ${url}`);
  }
}

async function testSameOriginRedirectsRemainSupported(): Promise<void> {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await withMockFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: '/final' } });
    }
    return new Response('redirected', { status: 200, headers: { 'content-type': 'text/plain' } });
  }, () => createDefaultExternalHttpFetch()(externalRequest({
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-request': 'preserved' },
    body: 'payload',
  })));

  assertCondition(calls.length === 2, `same-origin redirect should make two requests: ${calls.length}`);
  assertCondition(calls[0].init?.redirect === 'manual', 'native fetch redirect following should be disabled');
  assertCondition(calls[1].url === 'https://allowed.example/final', `relative redirect should resolve: ${calls[1].url}`);
  assertCondition(calls[1].init?.method === 'GET', `302 after POST should switch to GET: ${calls[1].init?.method}`);
  assertCondition(calls[1].init?.body === undefined, 'redirected GET should not retain the request body');
  assertCondition(!new Headers(calls[1].init?.headers).has('content-type'), 'redirected GET should drop content headers');
  assertCondition(new Headers(calls[1].init?.headers).get('x-request') === 'preserved', 'safe request headers should remain');
  assertCondition(result.status === 200 && result.body === 'redirected', `redirect response mismatch: ${JSON.stringify(result)}`);
}

async function testUnsafeRedirectsFailClosed(): Promise<void> {
  for (const [location, expectedMessage] of [
    ['https://other.example/next', 'cross-origin redirect'],
    ['https://localhost./secret', 'hostname localhost is blocked'],
    ['file:///etc/passwd', 'unsupported redirect URL scheme'],
  ] as const) {
    let calls = 0;
    await withMockFetch(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location } });
    }, async () => {
      await expectReject(() => createDefaultExternalHttpFetch()(externalRequest()), expectedMessage);
    });
    assertCondition(calls === 1, `unsafe redirect must not be fetched (${location}): ${calls}`);
  }
}

async function testOpaqueBrowserRedirectFailsClosed(): Promise<void> {
  const opaqueRedirect = {
    status: 0,
    type: 'opaqueredirect',
    headers: new Headers(),
    body: null,
  } as Response;
  await withMockFetch(async () => opaqueRedirect, async () => {
    await expectReject(
      () => createDefaultExternalHttpFetch()(externalRequest()),
      'browser did not expose the redirect target'
    );
  });
}

async function testRedirectCountIsBounded(): Promise<void> {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: `/redirect-${calls}` } });
  }, async () => {
    await expectReject(() => createDefaultExternalHttpFetch()(externalRequest()), 'redirect limit exceeded');
  });
  assertCondition(calls === 6, `five redirects should be allowed before failing closed: ${calls}`);
}

async function testResponseBodyLimitUsesStreaming(): Promise<void> {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads === 1) {
        controller.enqueue(new Uint8Array(RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES));
        return;
      }
      if (reads === 2) {
        controller.enqueue(new Uint8Array([1]));
        return;
      }
      controller.error(new Error('response reader consumed past the configured body limit'));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  await withMockFetch(async () => new Response(stream, { status: 200 }), async () => {
    await expectReject(
      () => createDefaultExternalHttpFetch()(externalRequest()),
      'TraceKernel external HTTP response body limit exceeded'
    );
  });
  assertCondition(reads === 2, `streaming reader should stop as soon as the cap is exceeded: ${reads}`);
  assertCondition(cancelled, 'oversized response stream should be cancelled');
}

async function testOversizedContentLengthFailsBeforeReading(): Promise<void> {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  await withMockFetch(async () => new Response(stream, {
    status: 200,
    headers: { 'content-length': String(RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES + 1) },
  }), async () => {
    await expectReject(
      () => createDefaultExternalHttpFetch()(externalRequest()),
      'TraceKernel external HTTP response body limit exceeded'
    );
  });
  assertCondition(reads === 0, `oversized Content-Length should fail before consuming the body: ${reads}`);
  assertCondition(cancelled, 'response rejected from Content-Length should be cancelled');
}

async function testBodylessResponseIgnoresRepresentationLength(): Promise<void> {
  const result = await withMockFetch(async () => new Response(null, {
    status: 200,
    headers: { 'content-length': String(RUNTIME_EXTERNAL_HTTP_MAX_BODY_BYTES + 1) },
  }), () => createDefaultExternalHttpFetch()(externalRequest({ method: 'HEAD' })));
  assertCondition(result.status === 200 && result.body === '', `bodyless response should remain valid: ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  testTerminalDnsDotBlocklist();
  testNonPublicAddressSpaceBlocklist();
  await testSameOriginRedirectsRemainSupported();
  await testUnsafeRedirectsFailClosed();
  await testOpaqueBrowserRedirectFailsClosed();
  await testRedirectCountIsBounded();
  await testResponseBodyLimitUsesStreaming();
  await testOversizedContentLengthFailsBeforeReading();
  await testBodylessResponseIgnoresRepresentationLength();
  console.log('PASS: external HTTP host, redirect, and streaming response policies are enforced');
}

test('runtime external http', main);
