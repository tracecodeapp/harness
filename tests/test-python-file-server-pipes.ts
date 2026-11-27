import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitForHttp } from './example-preview-process';
import { startPythonFileServer } from './helpers/python-file-server';

const REQUESTS = 1_000;

async function stop(server: ChildProcess) {
  const closed = once(server, 'close');
  server.kill();
  await closed;
}

test('Python file serving keeps responding beyond the old pipe limit', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tracecode-file-server-pipes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), 'ok');

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  const released = once(listener, 'close');
  listener.close();
  await released;

  const origin = `http://127.0.0.1:${port}`;
  // Enlarge each log line so 1,000 requests exceed the pipe capacity on Linux and macOS.
  const url = `${origin}/index.html?padding=${'x'.repeat(4096)}`;
  async function requestFile() {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  }

  const original = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    `ThreadingHTTPServer(("127.0.0.1", ${port}), SimpleHTTPRequestHandler).serve_forever()`,
  ].join('\n')], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForHttp(origin, 5_000);
    let completed = 0;
    await assert.rejects(async () => {
      for (; completed < REQUESTS; completed++) await requestFile();
    }, { name: 'TimeoutError' });
    assert.ok(completed > 0 && completed < REQUESTS);
    original.stderr.resume();
    await requestFile();
    t.diagnostic(`Unread stderr stalled after ${completed} requests. Draining stderr restored service.`);
  } finally {
    await stop(original);
  }

  const fixed = startPythonFileServer(directory, port);
  try {
    await waitForHttp(origin, 5_000);
    for (let completed = 0; completed < REQUESTS; completed++) await requestFile();
    t.diagnostic(`The shared server completed all ${REQUESTS} requests.`);
  } finally {
    await stop(fixed);
  }
});
