#!/usr/bin/env npx tsx

import {
  createRuntimeWorkspace,
  syntheticIp,
  syntheticLatency,
} from '../packages/harness-project/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertSyntheticHostPurity(): void {
  const ip = syntheticIp('x');
  assertEqual(syntheticIp('x'), ip, 'syntheticIp should be stable for the same host');
  assertCondition(/^192\.0\.2\.(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/.test(ip), `synthetic IP should use TEST-NET-1: ${ip}`);

  const latency = syntheticLatency('x');
  assertEqual(syntheticLatency('x'), latency, 'syntheticLatency should be stable for the same host');
  assertCondition(latency >= 0.1 && latency <= 3, `synthetic latency should stay in the small deterministic band: ${latency}`);
}

async function testTraceKernelPing(): Promise<void> {
  const externalCalls: string[] = [];
  const workspace = await createRuntimeWorkspace({
    externalHttp: {
      allowHttp: true,
      hosts: ['declared.example'],
      fetch: async (request) => {
        externalCalls.push(request.url);
        return { status: 200, body: `${request.url}\n` };
      },
    },
  });
  const listener = workspace.http.listen({ host: 'listener.example', port: 3800 }, () => ({
    status: 200,
    body: 'listener\n',
  }));
  try {
    assertSyntheticHostPurity();

    const externalResolution = workspace.resolveHost('declared.example');
    assertCondition(externalResolution.reachable, `declared external host should resolve: ${JSON.stringify(externalResolution)}`);
    if (externalResolution.reachable) {
      assertEqual(externalResolution.via, 'external', 'declared host should resolve via externalHttp');
      assertEqual(externalResolution.ip, syntheticIp('declared.example'), 'external host should use deterministic synthetic IP');
      assertEqual(externalResolution.latencyMs, syntheticLatency('declared.example'), 'external host should use deterministic latency');
    }

    const externalPing = await workspace.runCommand('ping -c 2 declared.example');
    assertEqual(externalPing.exitCode, 0, `external ping should exit 0: ${JSON.stringify(externalPing)}`);
    assertEqual(externalPing.stderr, '', 'external ping should not write stderr');
    assertCondition(
      externalPing.stdout === [
        `PING declared.example (${syntheticIp('declared.example')}): 56 data bytes`,
        `64 bytes from ${syntheticIp('declared.example')}: icmp_seq=0 ttl=64 time=${syntheticLatency('declared.example').toFixed(2)} ms`,
        `64 bytes from ${syntheticIp('declared.example')}: icmp_seq=1 ttl=64 time=${syntheticLatency('declared.example').toFixed(2)} ms`,
        '--- declared.example ping statistics ---',
        '2 packets transmitted, 2 received, 0% packet loss',
        `round-trip min/avg/max = ${syntheticLatency('declared.example').toFixed(2)}/${syntheticLatency('declared.example').toFixed(2)}/${syntheticLatency('declared.example').toFixed(2)} ms`,
        '',
      ].join('\n'),
      `external ping stdout mismatch: ${JSON.stringify(externalPing)}`
    );

    const loopbackResolution = workspace.resolveHost('localhost');
    assertCondition(loopbackResolution.reachable, `localhost should resolve: ${JSON.stringify(loopbackResolution)}`);
    if (loopbackResolution.reachable) {
      assertEqual(loopbackResolution.via, 'loopback', 'localhost should resolve via loopback');
      assertEqual(loopbackResolution.ip, '127.0.0.1', 'localhost should use loopback IP');
      assertEqual(loopbackResolution.latencyMs, 0.05, 'localhost should use loopback latency');
    }
    const loopbackPing = await workspace.runCommand('ping -c 1 localhost');
    assertEqual(loopbackPing.exitCode, 0, `loopback ping should exit 0: ${JSON.stringify(loopbackPing)}`);
    assertCondition(loopbackPing.stdout.includes('PING localhost (127.0.0.1): 56 data bytes'), `loopback ping header mismatch: ${loopbackPing.stdout}`);
    assertCondition(loopbackPing.stdout.includes('time=0.05 ms'), `loopback ping latency mismatch: ${loopbackPing.stdout}`);

    const literalHostPort = await workspace.runCommand('ping localhost:3000');
    assertEqual(literalHostPort.exitCode, 68, `ping should treat host:port as a literal host: ${JSON.stringify(literalHostPort)}`);
    assertEqual(literalHostPort.stderr, 'ping: cannot resolve localhost:3000: Unknown host\n', 'host:port literal stderr mismatch');
    const externalHostPort = await workspace.runCommand('ping declared.example:443');
    assertEqual(externalHostPort.exitCode, 68, `ping should not parse external host:port authorities: ${JSON.stringify(externalHostPort)}`);
    assertEqual(externalHostPort.stderr, 'ping: cannot resolve declared.example:443: Unknown host\n', 'external host:port literal stderr mismatch');

    const unknown = await workspace.runCommand('ping nope.example.com');
    assertEqual(unknown.exitCode, 68, `unknown ping should exit 68 without throwing: ${JSON.stringify(unknown)}`);
    assertEqual(unknown.stdout, '', 'unknown ping should not write stdout');
    assertEqual(unknown.stderr, 'ping: cannot resolve nope.example.com: Unknown host\n', 'unknown ping stderr mismatch');
    assertEqual(workspace.resolveHost('nope.example.com').reachable, false, 'unknown host should not resolve');

    const firstResolution = workspace.resolveHost('declared.example');
    const secondResolution = workspace.resolveHost('declared.example');
    assertCondition(
      firstResolution.reachable && secondResolution.reachable &&
        firstResolution.ip === secondResolution.ip &&
        firstResolution.latencyMs === secondResolution.latencyMs,
      `resolveHost should be deterministic: ${JSON.stringify({ firstResolution, secondResolution })}`
    );
    const firstPing = await workspace.runCommand('ping -c 2 declared.example');
    const secondPing = await workspace.runCommand('ping -c 2 declared.example');
    assertEqual(secondPing.stdout, firstPing.stdout, 'two ping runs should have byte-identical stdout');
    assertEqual(secondPing.stderr, firstPing.stderr, 'two ping runs should have byte-identical stderr');

    const listenerResolution = workspace.resolveHost('listener.example');
    assertCondition(listenerResolution.reachable, `listener host should resolve: ${JSON.stringify(listenerResolution)}`);
    if (listenerResolution.reachable) {
      assertEqual(listenerResolution.via, 'listener', 'listener host should resolve via listener');
      assertEqual(listenerResolution.ip, syntheticIp('listener.example'), 'listener host should use deterministic synthetic IP');
      assertEqual(listenerResolution.latencyMs, syntheticLatency('listener.example'), 'listener host should use deterministic latency');
    }

    const reachableCurl = await workspace.runCommand('curl -s http://declared.example/ok');
    assertEqual(reachableCurl.exitCode, 0, `curl should reach declared external host: ${JSON.stringify(reachableCurl)}`);
    assertEqual(reachableCurl.stdout, 'http://declared.example/ok\n', 'curl external response mismatch');
    assertCondition(workspace.resolveHost('declared.example').reachable, 'curl-reachable host should be reachable from resolveHost');

    const blockedCurl = await workspace.runCommand('curl -s http://blocked.example/');
    assertEqual(blockedCurl.exitCode, 7, `curl should reject undeclared external host gracefully: ${JSON.stringify(blockedCurl)}`);
    assertEqual(workspace.resolveHost('blocked.example').reachable, false, 'curl-blocked host should not be reachable from resolveHost');
    assertEqual(externalCalls.join('\n'), 'http://declared.example/ok', 'external fetch delegate should only see allowed curl request');
  } finally {
    listener.close();
    workspace.dispose();
  }
}

await testTraceKernelPing();
console.log('tracekernel ping tests passed');
