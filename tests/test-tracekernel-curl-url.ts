#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  createRuntimeWorkspace,
  type RuntimeKernelHttpRequest,
} from '../packages/harness-project/src/index';
import {
  CURL_PROTOCOLS,
  DEFAULT_CURL_SCHEME,
  resolveCurlUrl,
} from '../packages/tracekernel/src/workspace/curl-url';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testResolveCurlUrlMatrix(): void {
  const cases: Array<{ input: string; scheme: string; url: string }> = [
    { input: 'larkfield.com', scheme: 'http', url: 'http://larkfield.com' },
    { input: 'larkfield.com:80', scheme: 'http', url: 'http://larkfield.com:80' },
    { input: 'larkfield.com:443', scheme: 'http', url: 'http://larkfield.com:443' },
    { input: 'localhost:3000', scheme: 'http', url: 'http://localhost:3000' },
    { input: 'http://127.0.0.1:3000', scheme: 'http', url: 'http://127.0.0.1:3000' },
    { input: 'http:80', scheme: 'http', url: 'http://http:80' },
    { input: 'gopher://x', scheme: 'gopher', url: 'gopher://x' },
  ];
  for (const entry of cases) {
    const resolved = resolveCurlUrl(entry.input, CURL_PROTOCOLS, DEFAULT_CURL_SCHEME);
    assertCondition(
      resolved.scheme === entry.scheme && resolved.url === entry.url,
      `resolveCurlUrl mismatch for ${entry.input}: ${JSON.stringify(resolved)}`
    );
  }
}

async function testCurlUrlResolutionAndTypedErrors(): Promise<void> {
  const externalRequests: RuntimeKernelHttpRequest[] = [];
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      allowHttp: true,
      hosts: () => true,
      fetch: async (request) => {
        if (new URL(request.url).hostname === 'http') {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND http'), { code: 'ENOTFOUND' });
        }
        externalRequests.push({
          method: request.method,
          url: request.url,
          path: new URL(request.url).pathname,
          headers: request.headers,
        });
        return { status: 200, body: `${request.url}\n` };
      },
    },
  });
  const listener = workspace.http.listen({ host: '127.0.0.1', port: 3000 }, (request) => ({
    status: 200,
    body: `${request.url}\n`,
  }));
  try {
    const commands: Array<{ command: string; stdout: string }> = [
      { command: 'curl -s larkfield.com', stdout: 'http://larkfield.com/\n' },
      { command: 'curl -s larkfield.com:80', stdout: 'http://larkfield.com/\n' },
      { command: 'curl -s larkfield.com:443', stdout: 'http://larkfield.com:443/\n' },
      { command: 'curl -s localhost:3000', stdout: 'http://localhost:3000/\n' },
      { command: 'curl -s http://127.0.0.1:3000', stdout: 'http://127.0.0.1:3000/\n' },
    ];
    for (const entry of commands) {
      const result = await workspace.runCommand(entry.command);
      assertCondition(result.exitCode === 0, `${entry.command} should succeed: ${JSON.stringify(result)}`);
      assertCondition(result.stdout === entry.stdout, `${entry.command} stdout mismatch: ${JSON.stringify(result)}`);
      assertCondition(!result.stderr.includes('EINVAL'), `${entry.command} should not leak EINVAL: ${JSON.stringify(result)}`);
    }

    const authorityRule = await workspace.runCommand('curl -s http:80');
    assertCondition(authorityRule.exitCode === 6, `http:80 should follow native curl authority parsing: ${JSON.stringify(authorityRule)}`);
    assertCondition(authorityRule.stdout === '', `http:80 should not print a raw kernel body: ${JSON.stringify(authorityRule)}`);
    assertCondition(
      authorityRule.stderr === 'curl: (6) Could not resolve host: http\n' &&
        !authorityRule.stderr.includes('EINVAL') &&
        !authorityRule.stderr.toLowerCase().includes('tracekernel'),
      `http:80 should not leak EINVAL: ${JSON.stringify(authorityRule)}`
    );

    const unsupported = await workspace.runCommand('curl -s gopher://x');
    assertCondition(unsupported.exitCode === 1, `unsupported protocol should exit 1: ${JSON.stringify(unsupported)}`);
    assertCondition(
      unsupported.stderr === 'curl: (1) Protocol "gopher" not supported\n',
      `unsupported protocol stderr mismatch: ${JSON.stringify(unsupported)}`
    );

    const badPath = await workspace.http.request({ url: 'http://localhost:3000/', path: '80' });
    assertCondition(badPath.status === 400, `bad request path should return status 400: ${JSON.stringify(badPath)}`);
    assertCondition(badPath.error?.code === 'EINVAL', `bad request path should be typed EINVAL: ${JSON.stringify(badPath)}`);
    assertCondition(badPath.body?.includes("invalid HTTP request path '80'") === true, `bad request path body mismatch: ${JSON.stringify(badPath)}`);

    const malformedKernelRequest = await workspace.runCommand("curl -s -X 'BAD METHOD' http://localhost:3000/");
    assertCondition(
      malformedKernelRequest.exitCode === 3,
      `typed kernel EINVAL should become curl exit 3: ${JSON.stringify(malformedKernelRequest)}`
    );
    assertCondition(
      malformedKernelRequest.stderr === 'curl: (3) URL malformed\n',
      `typed kernel EINVAL should render curl-shaped stderr: ${JSON.stringify(malformedKernelRequest)}`
    );
    assertCondition(
      !malformedKernelRequest.stderr.includes('EINVAL') && !malformedKernelRequest.stderr.includes('TraceKernel HTTP'),
      `curl stderr should not leak kernel diagnostics: ${JSON.stringify(malformedKernelRequest)}`
    );

    assertCondition(
      externalRequests.map((request) => request.url).join('\n') === [
        'http://larkfield.com/',
        'http://larkfield.com/',
        'http://larkfield.com:443/',
      ].join('\n'),
      `external request URL matrix mismatch: ${JSON.stringify(externalRequests)}`
    );
  } finally {
    listener.close();
    workspace.dispose();
  }
}

async function main(): Promise<void> {
  testResolveCurlUrlMatrix();
  await testCurlUrlResolutionAndTypedErrors();
}

await test('tracekernel curl url', main);
