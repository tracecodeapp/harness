import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkObservation, summarize } from './checks.mjs';
import { runGraphControls } from './graph.mjs';

const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
const [installationArg, assetsArg, evidenceArg] = process.argv.slice(2);
if (!installationArg || !assetsArg || !evidenceArg) throw new Error('Usage: run.mjs CONSUMER_ASSET_INSTALL ASSET_ROOT EVIDENCE');
const installation = resolve(installationArg);
const assets = resolve(assetsArg);
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });

function record(file, item) {
  appendFileSync(join(evidence, file), JSON.stringify(item) + '\n');
}
function checksum(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const assetRequest = path.startsWith('/workers/');
  const root = assetRequest ? assets : evidence;
  const name = resolve(root, assetRequest ? path.slice('/workers/'.length) : path.slice(1));
  const info = name.startsWith(root + sep) && statSync(name, { throwIfNoEntry: false });
  if (!info?.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[extname(name)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  createReadStream(name).pipe(response);
});
let browser;

try {
  const bundlePath = join(evidence, 'gate-browser.mjs');
  const built = await build({
    stdin: {
      contents: readFileSync(new URL('browser.mjs', import.meta.url), 'utf8'),
      resolveDir: installation,
      sourcefile: 'stage1-browser.mjs',
    },
    outfile: bundlePath, bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const installedJudge = Object.keys(built.metafile.inputs).find((name) => name.endsWith('/dist/judge.js'));
  assert(installedJudge && resolve(installedJudge).startsWith(installation + sep), 'Browser bundle must resolve installed /judge');
  record('identity.jsonl', { candidate: manifest.candidate, installedJudge, browserBundleSha256: checksum(bundlePath), node: process.version });
  writeFileSync(join(evidence, 'index.html'), '<!doctype html><meta charset="utf-8">');
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  record('identity.jsonl', { chromium: browser.version(), channel: 'chromium' });
  record('controls.jsonl', { graph: runGraphControls() });

  const filter = process.env.TRACECODE_STAGE1_FILTER ? new RegExp(process.env.TRACECODE_STAGE1_FILTER) : null;
  const matches = (row) => !filter || filter.test(`${row.gate}/${row.language}/${row.name}`);
  const inventory = manifest.inventory.filter((id) => !filter || filter.test(id.split('/').slice(0, 3).join('/')));
  const selectedFixtures = manifest.fixtures.filter(matches);
  assert(selectedFixtures.length, 'Filter selected no fixtures');
  const assertions = [];
  const recordAssertion = (item) => {
    assertions.push(item);
    record('assertions.jsonl', item);
  };
  const runtime = { setupMs: performance.now(), requests: 0, fixtureMs: {}, requestMs: {} };
  for (const cap of manifest.baselineCaps.filter((cap) => !filter || filter.test(`G6/${cap.language}/judged-byte-limit`))) {
    recordAssertion({ ...cap, status: 'fail', message: cap.reason, evidence: 'required-baseline-failure' });
  }
  for (const fixture of selectedFixtures) {
    const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
    const page = await browser.newPage();
    const started = performance.now();
    const nonce = randomUUID();
    const requests = manifest.requests.filter((request) => !fixture.untracedOnly || (
      request.mode === 'submit' && request.selected.length === 0
    ));
    try {
      await page.exposeFunction('recordGateObservation', (wire) => {
        const observation = JSON.parse(wire);
        assert.equal(observation.nonce, nonce, 'Browser observation nonce');
        const request = requests.find(({ id }) => id === observation.request);
        assert(request, 'Unknown request observation');
        record('observations.jsonl', { fixture: key, ...observation });
        runtime.requests++;
        runtime.requestMs[`${key}/${request.id}`] = observation.wallMs;
        checkObservation(fixture, request, observation, recordAssertion);
      });
      page.on('pageerror', (error) => record('browser.jsonl', { fixture: key, error: error.message }));
      page.on('requestfailed', (request) => record('browser.jsonl', { fixture: key, url: request.url(), failure: request.failure() }));
      page.on('response', (response) => {
        if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
          record('browser.jsonl', { fixture: key, url: response.url(), status: response.status() });
        }
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      const finished = await page.evaluate(async ({ fixture, requests, nonce }) => {
        const { runFixture } = await import('/gate-browser.mjs');
        return runFixture(fixture, requests, nonce);
      }, { fixture, requests, nonce });
      assert.equal(finished, nonce, 'Browser fixture completion nonce');
      record('browser.jsonl', { fixture: key, terminal: finished });
    } catch (error) {
      record('browser.jsonl', { fixture: key, setupError: error.message });
    } finally {
      runtime.fixtureMs[key] = performance.now() - started;
      await page.close();
      console.log(`${key} ${Math.round(runtime.fixtureMs[key])}ms`);
    }
  }
  const result = summarize(inventory, assertions);
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ...result, runtime, partial: Boolean(filter) }, null, 2) + '\n');
  console.log(JSON.stringify(result.counts));
  process.exitCode = Number(Boolean(result.missing.length || result.failed.length || result.unexpected.length || result.repeated.length));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
