#!/usr/bin/env npx tsx

import { runtimeWorkspaceActorPreset } from '../packages/runtime-core/src/index';
import {
  TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS,
  TRACEKERNEL_HTTP_MAX_BODY_BYTES,
  WorkspaceHttpState,
  normalizeRuntimeExternalHttpConfig,
  redactRuntimeDiagnosticUrl,
  syntheticIp,
  syntheticLatency,
} from '../packages/tracekernel/src/workspace/http-state';
import { workspaceHttpPolicy } from '../packages/tracekernel/src/workspace/http-policy';

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

function assertThrowsCode(
  operation: () => unknown,
  code: string,
  message: string
): void {
  try {
    operation();
  } catch (error) {
    assertEqual(
      (error as { code?: unknown }).code,
      code,
      `${message} error code`
    );
    return;
  }
  throw new Error(`${message}: expected ${code}`);
}

function assertThrows(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${message}: expected an error`);
}

function testExternalConfiguration(): void {
  const fetch = async () => ({ status: 204 });
  const normalized = normalizeRuntimeExternalHttpConfig({
    fetch,
    hosts: ['api.example', '*.service.example:8443'],
    timeoutMs: Number.POSITIVE_INFINITY,
    maxConcurrentRequests: 0,
    maxRequestsPerCommand: 12.9,
  });

  assertCondition(normalized, 'external HTTP configuration should normalize');
  assertEqual(
    normalized.timeoutMs,
    10_000,
    'non-finite timeout should fall back'
  );
  assertEqual(
    normalized.maxConcurrentRequests,
    1,
    'concurrency should clamp to at least one'
  );
  assertEqual(
    normalized.maxRequestsPerCommand,
    12,
    'request budget should be integral'
  );
  assertCondition(
    Array.isArray(normalized.hosts),
    'host allowlist should normalize to rules'
  );
  if (Array.isArray(normalized.hosts)) {
    assertEqual(normalized.hosts[0]?.hostname, 'api.example', 'exact host');
    assertEqual(
      normalized.hosts[1]?.wildcardSubdomains,
      true,
      'wildcard subdomain rule'
    );
    assertEqual(normalized.hosts[1]?.port, 8443, 'allowlisted port');
  }

  const clamped = normalizeRuntimeExternalHttpConfig({
    fetch,
    hosts: ['api.example'],
    timeoutMs: TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS + 1,
  });
  assertEqual(
    clamped?.timeoutMs,
    TRACEKERNEL_EXTERNAL_HTTP_MAX_TIMEOUT_MS,
    'timeout should respect the hard upper bound'
  );

  assertThrows(
    () =>
      normalizeRuntimeExternalHttpConfig({
        fetch,
        hosts: ['*'],
      }),
    'full wildcard string should be rejected'
  );
}

function testRequestAndResponseNormalization(): void {
  const request = workspaceHttpPolicy.normalizeRequest({
    method: 'post',
    url: 'https://api.example/items?limit=2',
    rawHeaders: [['X-Trace', 'one']],
    body: '{"ok":true}',
  });
  assertCondition(request.ok, `request should normalize: ${JSON.stringify(request)}`);
  if (!request.ok) return;
  assertEqual(request.request.method, 'POST', 'method should uppercase');
  assertEqual(
    request.request.path,
    '/items?limit=2',
    'path should derive from URL'
  );
  assertEqual(
    request.request.headers?.['x-trace'],
    'one',
    'raw headers should provide normalized lookup headers'
  );

  const invalidMethod = workspaceHttpPolicy.normalizeRequest({
    method: 'GET\r\nX-Evil: yes',
    url: 'https://api.example/',
  });
  assertCondition(!invalidMethod.ok, 'control characters in methods should fail');
  if (!invalidMethod.ok) {
    assertEqual(invalidMethod.error.code, 'EINVAL', 'invalid method code');
  }

  const invalidPath = workspaceHttpPolicy.normalizeRequest({
    method: 'GET',
    url: 'https://api.example/',
    path: 'relative',
  });
  assertCondition(!invalidPath.ok, 'relative request paths should fail');

  const oversizedBody = workspaceHttpPolicy.normalizeRequest({
    method: 'POST',
    url: 'https://api.example/',
    body: 'x'.repeat(TRACEKERNEL_HTTP_MAX_BODY_BYTES + 1),
  });
  assertCondition(!oversizedBody.ok, 'oversized request bodies should fail');
  if (!oversizedBody.ok) {
    assertEqual(oversizedBody.error.code, 'EMSGSIZE', 'body limit code');
  }

  const response = workspaceHttpPolicy.normalizeResponse({
    status: 201.9,
    headers: { 'X-Result': 'created' },
    body: 'ok',
  });
  assertEqual(response.status, 201, 'response status should be integral');
  assertEqual(
    response.headers?.['x-result'],
    'created',
    'response header keys should normalize'
  );
  assertEqual(
    response.rawHeaders?.[0]?.[0],
    'x-result',
    'normalized response should preserve a raw-header view'
  );

  assertThrowsCode(
    () => workspaceHttpPolicy.normalizeResponse({ status: 99 }),
    'EINVAL',
    'invalid response status should fail'
  );
}

function testBoundaryPolicy(): void {
  const principal = runtimeWorkspaceActorPreset('principal');
  const runtime = runtimeWorkspaceActorPreset('runtime');

  assertEqual(
    workspaceHttpPolicy.normalizeListenHost('*', principal),
    '0.0.0.0',
    'principal wildcard listen'
  );
  assertThrowsCode(
    () => workspaceHttpPolicy.normalizeListenHost('*', runtime),
    'EACCES',
    'runtime wildcard listen should fail closed'
  );
  assertEqual(
    workspaceHttpPolicy.normalizeConnectHost('localhost'),
    '127.0.0.1',
    'localhost connect target'
  );
  assertThrowsCode(
    () => workspaceHttpPolicy.normalizeConnectPort(0),
    'EADDRNOTAVAIL',
    'invalid connect port'
  );
  assertEqual(
    workspaceHttpPolicy.sanitizeDiagnosticField('a\r\nb'),
    'a\\r\\nb',
    'diagnostics should escape line breaks'
  );
  assertEqual(
    redactRuntimeDiagnosticUrl(
      'https://user:password@example.test/path?token=secret&safe=yes'
    ),
    'https://redacted:redacted@example.test/path?token=redacted&safe=yes',
    'diagnostic URLs should redact credentials and sensitive parameters'
  );
}

function testSessionState(): void {
  const state = new WorkspaceHttpState({
    fetch: async () => ({ status: 200 }),
    hosts: ['api.example'],
  });

  assertCondition(state.external, 'session state should own normalized egress');
  assertEqual(state.listeners.size, 0, 'listener table should start empty');
  assertEqual(state.requestLog.length, 0, 'request log should start empty');
  assertEqual(state.nextEphemeralPort, 49152, 'ephemeral port range should start predictably');
  assertEqual(
    syntheticIp('api.example'),
    syntheticIp('API.EXAMPLE'),
    'synthetic IP should be hostname-case independent'
  );
  assertEqual(
    syntheticLatency('api.example'),
    syntheticLatency('API.EXAMPLE'),
    'synthetic latency should be hostname-case independent'
  );
}

testExternalConfiguration();
testRequestAndResponseNormalization();
testBoundaryPolicy();
testSessionState();

console.log('workspace HTTP policy tests passed');
