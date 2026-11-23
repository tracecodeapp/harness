// Run on the Chromium build host against an unpacked Harness tarball.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

assert.ok(process.argv[2], 'Supply the unpacked Harness package directory');
const root = resolve(process.argv[2]);
const contentTypes = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const assets = new Map();
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8">');
    return;
  }
  const path = resolve(root, '.' + pathname);
  if (!path.startsWith(root + sep) || !pathname.startsWith('/workers/')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    assets.set(pathname, createHash('sha256').update(bytes).digest('hex'));
    response.writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
let watchdog;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  page.on('requestfailed', (request) => console.error(request.url(), request.failure()?.errorText));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await Promise.race([
    page.evaluate(async () => {
      const workerUrl = '/workers/python/python-worker.js';
      const runtimeAssets = {
        runtimeUrl: location.origin + '/workers/python/python-runtime.js',
        snippetsUrl: location.origin + '/workers/python/generated-python-harness-snippets.js',
        loaderUrl: location.origin + '/workers/python/pyodide-0.29.3/pyodide.js',
        indexUrl: location.origin + '/workers/python/pyodide-0.29.3/',
        loaderFormat: 'classic-script',
      };

      const workers = [];
      async function client() {
        const worker = new Worker(workerUrl);
        workers.push(worker);
        await new Promise((accept, reject) => {
          worker.addEventListener('message', ({ data }) => {
            if (data.type === 'worker-ready') accept();
          });
          worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true });
        });
        const request = (type, payload) => new Promise((accept, reject) => {
          const id = crypto.randomUUID();
          const protocolToken = crypto.randomUUID();
          function onMessage({ data }) {
            if (data.id !== id || data.protocolToken !== protocolToken) return;
            if (data.type === 'batch-case-progress') return;
            worker.removeEventListener('message', onMessage);
            if (data.type === 'error') reject(new Error(data.payload.error));
            else accept({ type: data.type, payload: data.payload });
          }
          worker.addEventListener('message', onMessage);
          worker.postMessage({ type, id, protocolToken, payload });
        });
        await request('init', { runtimeAssets });
        return request;
      }
      async function prepare(request, body) {
        const { type, payload } = await request('prepare-program', body);
        if (type !== 'prepare-result' || !payload.success) throw new Error(JSON.stringify(payload));
        return payload.artifact;
      }
      async function batch(request, artifact, inputBatch) {
        return request('execute-prepared-program-batch', { mode: 'code', artifact, inputBatch, stopAtFirstRunaway: true });
      }

      try {
        const ordinary = await client();
        const observer = await client();
        const code = [
          'def solve(value):',
          '    print(value)',
          '    if value == 1:',
          '        raise ValueError("invalid input")',
          '    return value + 1',
        ].join('\n');
        const functionName = 'solve';
        const artifact = await prepare(ordinary, { code, mode: 'code', functionName });
        const observe = async (traceOptions) => {
          const instrumented = await prepare(observer, { code, mode: 'trace', functionName, observationOnly: true, traceOptions });
          if (instrumented.userCode === artifact.userCode) throw new Error('Worker reused the ordinary code object');
          return observer('execute-prepared-program', { mode: 'trace', artifact: instrumented, inputs: { value: 6 } });
        };
        const [fast, drawn] = await Promise.all([
          batch(ordinary, artifact, [{ value: 1 }, { value: 6 }]),
          observe({}),
        ]);
        const byte = await observe({ maxTraceBytes: 1 });
        const compatible = await prepare(ordinary, { code: 'import ast\n' + code, mode: 'code', functionName });
        const compat = await batch(ordinary, compatible, [{ value: 1 }, { value: 6 }]);
        const scriptArtifact = await prepare(ordinary, {
          code: 'print("before")\nraise RuntimeError("oops")',
          mode: 'code',
          functionName: null,
        });
        const script = await ordinary('execute-prepared-program', { mode: 'code', artifact: scriptArtifact, inputs: {} });
        return {
          fast, drawn, byte, compat, script,
          tiers: [artifact, compatible, scriptArtifact].map((entry) => entry.isolationProfile.tier),
        };
      } finally {
        for (const worker of workers) worker.terminate();
      }
    }),
    new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Installed Python worker test exceeded its deadline')), 90_000);
    }),
  ]);
  assert.deepEqual(results.tiers, ['algorithm-fast', 'judge-compatible', 'hard-isolated']);
  for (const [run, line] of [[results.fast, 4], [results.compat, 5]]) {
    assert.equal(run.type, 'execute-result');
    assert.deepEqual(run.payload.results.map(({ consoleOutput }) => consoleOutput), [['1'], ['6']]);
    assert.equal(run.payload.results[0].diagnosticStage, 'runtime');
    assert.equal(run.payload.results[0].error, `ValueError on line ${line}: invalid input`);
    assert.equal(run.payload.results[1].output, 7);
    for (const row of run.payload.results) {
      for (const key of ['trace', 'attachment', 'traceUnavailable', 'traceUnavailableRun', 'untracedRunNeeded']) {
        assert.equal(Object.hasOwn(row, key), false, key);
      }
    }
  }
  assert.equal(results.script.type, 'execute-result');
  assert.equal(results.script.payload.error, 'RuntimeError on line 2: oops');
  assert.deepEqual(results.script.payload.consoleOutput, ['before']);
  assert.equal(results.drawn.type, 'execute-result');
  assert.equal(results.drawn.payload.observation.recorderCompleted, true);
  assert.equal(results.drawn.payload.output, null);
  assert.ok(results.drawn.payload.trace.events.some((event) => event.kind === 'line' && event.line === 5));
  assert.equal(results.byte.payload.observation.cut, 'byte-budget');
  assert.ok(results.byte.payload.observation.attemptedEvents > 0);
  assert.deepEqual(results.byte.payload.trace.events, []);
  console.log(JSON.stringify({ witness: 'installed-python-ordinary-worker', tiers: results.tiers, assets: Object.fromEntries(assets) }));
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  await new Promise((done) => server.close(done));
}
