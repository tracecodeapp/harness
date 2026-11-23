import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const reportPath = resolve(process.env.TRACECODE_B4_REPORT ?? 'b4-installed-report.json');
const [, , tarball, digest] = process.argv;
assert(tarball && /^[0-9a-f]{64}$/u.test(digest ?? ''), 'Provide the canonical tarball path and SHA-256');
const fixtures = JSON.parse(await readFile(new URL('./b4-fixtures.json', import.meta.url), 'utf8'));
const sandbox = await mkdtemp(join(tmpdir(), 'tracecode-b4-installed-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 << 20 });
  if (result.status !== 0) throw new Error(`${program} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

let server;
let browser;
try {
  assert.equal(sha(await readFile(tarball)), digest, 'canonical tarball digest');
  await writeFile(join(sandbox, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@tracecode/harness': `file:${tarball}` },
  }));
  run('corepack', ['pnpm', 'install', '--prefer-offline', '--ignore-scripts'], sandbox);
  const installed = join(sandbox, 'node_modules/@tracecode/harness');
  const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const judge = join(installed, pkg.exports['./judge'].import);
  const packedJudge = spawnSync('tar', ['-xOzf', tarball, 'package/dist/judge.js'], { maxBuffer: 32 << 20 });
  assert.equal(packedJudge.status, 0, packedJudge.stderr.toString());
  assert.equal(sha(await readFile(judge)), sha(packedJudge.stdout), 'installed Judge matches tar member');
  run(process.execPath, [join(installed, pkg.bin['tracecode-harness']), 'sync-assets',
    join(sandbox, 'workers'), '--languages', 'javascript,typescript'], sandbox);
  const lock = JSON.parse(await readFile(join(installed, 'runtime-assets.lock.json'), 'utf8'));
  const identity = {
    candidate: run('git', ['rev-parse', 'HEAD']),
    tarball: sha(await readFile(tarball)),
    judge: sha(await readFile(judge)),
    workers: {},
    controls: {},
  };
  for (const asset of lock.components.javascript.files.filter(({ path }) => path.endsWith('/javascript-worker.js') ||
      path.endsWith('/javascript-ses-algorithm-worker.js'))) {
    identity.workers[asset.path] = sha(await readFile(join(sandbox, 'workers', basename(asset.path))));
    assert.equal(identity.workers[asset.path], asset.sha256, asset.path);
  }
  assert.equal(Object.keys(identity.workers).length, 2);
  const workerPath = join(sandbox, 'workers');
  const source = await readFile(join(workerPath, 'javascript-worker.js'), 'utf8');
  const insertion = "          drawing = await executeWithTracing({ ...payload, observation: true });";
  assert.equal(source.split(insertion).length, 2, 'observer worker seam must exist once');
  for (const [fault, inject] of Object.entries({
    'no-recorder': 'const recorder = createTraceRecorder; createTraceRecorder = undefined;',
    'observer-compile-fault': "payload = { ...payload, preparedExecution: { ...payload.preparedExecution, instrumentedCode: 'function {' } };",
    'observer-encoder-fault': 'const recorder = createTraceRecorder; createTraceRecorder = (options) => {\n' +
      '  const instance = recorder(options); const snapshot = instance.getRuntimeTrace;\n' +
      '  instance.getRuntimeTrace = (...args) => {\n' +
      '    const trace = snapshot(...args);\n' +
      '    if (trace.events.some((event) => event.kind === "stdout")) {\n' +
      '      self.postMessage({ type: "b4-injection-ack", token: payload.attemptToken, fault: "observer-encoder-fault" });\n' +
      '      throw new Error("B4 test encoder fault");\n' +
      '    }\n' +
      '    return trace;\n' +
      '  }; return instance;\n' +
      '};',
  })) {
    // Mutant overlays are test bytes with their own digests. Ordinary worker
    // commands in those variants still use the exact installed implementation.
    const mutated = source.replace(insertion, [
      '          {',
      inject.replace('payload = ', 'const observerPayload = '),
      fault === 'observer-encoder-fault' ? '' :
        `self.postMessage({ type: 'b4-injection-ack', token: payload.attemptToken, fault: ${JSON.stringify(fault)} });`,
      fault === 'observer-compile-fault'
        ? insertion.replace('...payload', '...observerPayload')
        : insertion,
      fault === 'observer-compile-fault' ? '' : 'createTraceRecorder = recorder;',
      '          }',
    ].filter(Boolean).join('\n'));
    await writeFile(join(workerPath, `b4-${fault}.js`), mutated);
    identity.controls[fault] = sha(mutated);
  }
  await build({
    entryPoints: [resolve('tests/stage1-gates/b4-browser.mjs')],
    bundle: true, platform: 'browser', format: 'esm',
    outfile: join(sandbox, 'gate.mjs'),
    alias: { '@tracecode/harness/judge': judge },
  });
  await writeFile(join(sandbox, 'index.html'), '<!doctype html><meta charset="utf-8">');
  server = createServer(async (request, response) => {
    try {
      const path = resolve(sandbox, '.' + new URL(request.url, 'http://localhost').pathname.replace(/^\/$/u, '/index.html'));
      if (!path.startsWith(sandbox + sep) || path.includes(`${sep}node_modules${sep}`)) return response.writeHead(404).end();
      const bytes = await readFile(path);
      response.setHeader('content-type', /\.m?js$/u.test(path) ? 'text/javascript' :
        path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.html') ? 'text/html' : 'application/json');
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const report = { identity, browser: browser.version(), receipts: [] };
  for (const fixture of fixtures) {
    const faults = fixture.name === 'stdout' ? [null, ...Object.keys(identity.controls)] : [null];
    for (const fault of faults) {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const receipt = await page.evaluate(async ({ fixture, fault }) => {
          const { runFixture } = await import('/gate.mjs');
          return runFixture(fixture, fault);
        }, { fixture, fault });
        report.receipts.push(receipt);
        for (const { id, pass } of receipt.assertions) console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`);
        if (receipt.error) console.error(receipt.fixture.join('/'), receipt.error);
        await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      } finally {
        await page.close();
      }
    }
  }
  if (report.receipts.some(({ error, assertions }) => error || assertions.length === 0 ||
      assertions.some(({ pass }) => !pass))) process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(sandbox, { recursive: true, force: true });
}
