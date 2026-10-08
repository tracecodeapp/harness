import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { runCommand, startPreviewServer, waitForHttp } from './example-preview-process';

const options = { shutdownGraceMs: 100, startupTimeoutMs: 2_000 };

test('preview combines the split ANSI label and URL emitted by Vite in CI', { timeout: 5_000 }, async () => {
  const preview = startPreviewServer(process.execPath, ['-e', `
    process.on('SIGUSR1', () => process.stdout.write('http://127.0.0.1:\\x1b[1m5354\\x1b[22m/\\x1b[39m\\n'));
    process.stdout.write('\\x1b[1mLocal\\x1b[22m:   \\x1b[36m');
    setInterval(() => {}, 1000);
  `], process.cwd(), options);
  try {
    await once(preview.process.stdout!, 'data');
    preview.process.kill('SIGUSR1');
    assert.equal(await preview.waitForUrl, 'http://127.0.0.1:5354');
  } finally {
    await preview.stop();
  }
});

test('the baseline URL parser rejects the exact ANSI format that stalled SQL', () => {
  const reported = '\x1b[1mLocal\x1b[22m:   \x1b[36mhttp://127.0.0.1:\x1b[1m5354\x1b[22m/\x1b[39m\n';
  assert.equal(reported.match(/Local:\s+(http:\/\/[^\s/]+:\d+\/?)/), null);
});

test('preview spawn and early exit failures settle both waits', { timeout: 5_000 }, async () => {
  const missing = startPreviewServer('/tracecode-missing-preview-command', [], process.cwd(), options);
  await assert.rejects(missing.waitForUrl, /ENOENT/);
  await assert.rejects(missing.waitForExit, /ENOENT/);
  await assert.rejects(missing.stop(), /ENOENT/);

  const failed = startPreviewServer(process.execPath, ['-e', 'process.exit(7)'], process.cwd(), options);
  await assert.rejects(failed.waitForUrl, /exited before reporting/);
  await assert.rejects(failed.waitForExit, /exit code 7/);
  const originalFailure = new Error('Original smoke failure');
  await assert.rejects(failed.stop(originalFailure), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], originalFailure);
    assert.match(error.errors[1].message, /exit code 7/);
    return true;
  });
});

test('preview startup has a deadline and reaps a process ignoring SIGTERM', { timeout: 5_000 }, async () => {
  const preview = startPreviewServer(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], process.cwd(), { ...options, startupTimeoutMs: 500 });
  await assert.rejects(preview.waitForUrl, /preview startup timed out/);
  await preview.stop();
  assert.equal(preview.process.signalCode, 'SIGKILL');
});

test('an unexpected preview kill remains a failure', { timeout: 5_000 }, async () => {
  const preview = startPreviewServer(process.execPath, ['-e', `
    process.stdout.write('Local: http://127.0.0.1:5354/\\n');
    setInterval(() => {}, 1000);
  `], process.cwd(), options);
  await preview.waitForUrl;
  preview.process.kill('SIGKILL');
  await assert.rejects(preview.waitForExit, /exited unexpectedly with signal SIGKILL/);
  await assert.rejects(preview.stop(), /exited unexpectedly with signal SIGKILL/);
});

test('command execution has a deadline and escalates shutdown', { timeout: 5_000 }, async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], process.cwd(), { timeoutMs: 500, shutdownGraceMs: 100 }), /timed out after 500ms/);
});

test('HTTP readiness bounds a connection that never sends headers', { timeout: 5_000 }, async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(waitForHttp(`http://127.0.0.1:${address.port}`, 100), /HTTP readiness/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('shutdown closes pipes and the server owned by an exited wrapper', { timeout: 5_000 }, async () => {
  const serverCode = `
    const http = require('node:http');
    process.on('SIGTERM', () => {});
    const server = http.createServer((req,res) => res.end('ready'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('Local: http://127.0.0.1:' + server.address().port + '/\\n');
    });
  `;
  const preview = startPreviewServer(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(serverCode)}], {stdio:'inherit'});
  `], process.cwd(), options);
  try {
    const url = await preview.waitForUrl;
    await waitForHttp(url, 1_000);
    // The wrapper dies before its child; stopping must still reach the child.
    preview.process.kill('SIGTERM');
    await preview.stop();
    assert.equal(preview.process.stdout?.destroyed, true);
    assert.equal(preview.process.stderr?.destroyed, true);
    const parsed = new URL(url);
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) });
    const [error] = await once(socket, 'error');
    assert.equal((error as NodeJS.ErrnoException).code, 'ECONNREFUSED');
  } finally {
    await preview.stop();
  }
});
