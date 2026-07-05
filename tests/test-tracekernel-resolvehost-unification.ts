#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  syntheticIp,
  syntheticLatency,
} from '../packages/harness-project/src/index';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function pingIdentity(stdout: string): { ip: string; latency: string } {
  const ip = /\(([^)]+)\): 56 data bytes/.exec(stdout)?.[1];
  const latency = /time=([0-9.]+) ms/.exec(stdout)?.[1];
  if (!ip || !latency) throw new Error(`could not parse ping identity from: ${stdout}`);
  return { ip, latency };
}

function identityBody(host: string, workspace: Awaited<ReturnType<typeof createRuntimeWorkspace>>): string {
  const resolution = workspace.resolveHost(host);
  if (!resolution.reachable) return 'unreachable\n';
  return `ip=${resolution.ip} latency=${resolution.latencyMs.toFixed(2)} via=${resolution.via}\n`;
}

async function assertReachableAgreement(
  workspace: Awaited<ReturnType<typeof createRuntimeWorkspace>>,
  host: string,
  curlUrl: string
): Promise<void> {
  const resolution = workspace.resolveHost(host);
  assertCondition(resolution.reachable, `${host} should resolve: ${JSON.stringify(resolution)}`);
  if (!resolution.reachable) return;

  const ping = await workspace.runCommand(`ping -c 1 ${host}`);
  assertEqual(ping.exitCode, 0, `${host} ping should succeed: ${JSON.stringify(ping)}`);
  const parsedPing = pingIdentity(ping.stdout);
  assertEqual(parsedPing.ip, resolution.ip, `${host} ping IP should match resolveHost`);
  assertEqual(parsedPing.latency, resolution.latencyMs.toFixed(2), `${host} ping latency should match resolveHost`);

  const curl = await workspace.runCommand(`curl -s ${curlUrl}`);
  assertEqual(curl.exitCode, 0, `${host} curl should succeed: ${JSON.stringify(curl)}`);
  assertEqual(
    curl.stdout,
    `ip=${resolution.ip} latency=${resolution.latencyMs.toFixed(2)} via=${resolution.via}\n`,
    `${host} curl identity should match resolveHost byte-for-byte`
  );
  assertCondition(curl.stderr === '', `${host} curl should not write stderr: ${JSON.stringify(curl)}`);
}

async function main(): Promise<void> {
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      allowHttp: true,
      hosts: ['external.example'],
      fetch: async (request) => ({
        status: 200,
        body: identityBody(new URL(request.url).hostname, workspace),
      }),
    },
  });
  const listener = workspace.http.listen({ host: 'listener.example', port: 3811 }, (request) => ({
    status: 200,
    body: identityBody(new URL(request.url).hostname, workspace),
  }));
  const loopback = workspace.http.listen({ host: '127.0.0.1', port: 3812 }, (request) => ({
    status: 200,
    body: identityBody(new URL(request.url).hostname, workspace),
  }));
  try {
    await assertReachableAgreement(workspace, 'listener.example', 'http://listener.example:3811/id');
    await assertReachableAgreement(workspace, 'external.example', 'http://external.example/id');
    await assertReachableAgreement(workspace, 'localhost', 'http://localhost:3812/id');

    const externalResolution = workspace.resolveHost('external.example');
    assertCondition(externalResolution.reachable, `external.example should resolve: ${JSON.stringify(externalResolution)}`);
    if (externalResolution.reachable) {
      assertEqual(externalResolution.ip, syntheticIp('external.example'), 'external synthetic IP should be deterministic');
      assertEqual(externalResolution.latencyMs, syntheticLatency('external.example'), 'external synthetic latency should be deterministic');
    }

    const unknownResolution = workspace.resolveHost('unknown.example');
    assertCondition(!unknownResolution.reachable, `unknown.example should not resolve: ${JSON.stringify(unknownResolution)}`);
    const unknownPing = await workspace.runCommand('ping -c 1 unknown.example');
    assertEqual(unknownPing.exitCode, 68, `unknown ping should fail as unreachable: ${JSON.stringify(unknownPing)}`);
    const unknownCurl = await workspace.runCommand('curl -s http://unknown.example/id');
    assertEqual(unknownCurl.exitCode, 7, `unknown curl should render typed host unreachable: ${JSON.stringify(unknownCurl)}`);
    assertCondition(!/Error:|stack|at .*\.ts:/i.test(`${unknownCurl.stdout}${unknownCurl.stderr}`), `curl should not expose a raw exception: ${JSON.stringify(unknownCurl)}`);
    const unknownResponse = await workspace.http.request({ url: 'http://unknown.example/id' });
    assertEqual(unknownResponse.error?.code, 'EHOSTUNREACH', `workspace.http.request should return typed EHOSTUNREACH: ${JSON.stringify(unknownResponse)}`);
    assertCondition(
      !/Error:|stack|at .*\.ts:/i.test(`${unknownResponse.body ?? ''}${unknownResponse.error?.message ?? ''}`),
      `workspace.http.request should not expose a raw exception: ${JSON.stringify(unknownResponse)}`
    );
  } finally {
    listener.close();
    loopback.close();
    workspace.dispose();
  }
}

await main();
console.log('tracekernel resolveHost unification tests passed');
