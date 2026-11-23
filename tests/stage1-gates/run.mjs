import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkCppDirect, checkDifferential, checkObservation, summarize } from './checks.mjs';
import { runGraphControls } from './graph.mjs';
import { appFixtureName, appSpec, cppDirectRoutes, jsRouteRequests, requestMatrix } from './requests.mjs';
import { exerciseMux, loadMux } from './mux.mjs';

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
  const candidateSource = process.env.TRACECODE_STAGE1_CANDIDATE_SOURCE;
  if (candidateSource) {
    const shim = join(candidateSource, 'packages/tracekernel/src/zlib-browser-shim.ts');
    await build({
      stdin: {
        contents: readFileSync(new URL('routes.mjs', import.meta.url), 'utf8'),
        resolveDir: candidateSource,
        sourcefile: 'stage1-provider-companions.mjs',
      },
      tsconfig: join(candidateSource, 'tsconfig.base.json'),
      alias: { zlib: shim, 'node:zlib': shim },
      outfile: join(evidence, 'gate-routes.mjs'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
  record('identity.jsonl', {
    candidate: process.env.TRACECODE_STAGE1_SUBJECT ?? manifest.candidate,
    installedJudge, browserBundleSha256: checksum(bundlePath), node: process.version,
  });
  writeFileSync(join(evidence, 'index.html'), '<!doctype html><meta charset="utf-8">');
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  record('identity.jsonl', { chromium: browser.version(), channel: 'chromium' });
  record('controls.jsonl', { graph: runGraphControls() });

  const filter = process.env.TRACECODE_STAGE1_FILTER ? new RegExp(process.env.TRACECODE_STAGE1_FILTER) : null;
  const matches = (row) => !filter || filter.test(`${row.gate}/${row.language}/${row.name}`);
  const inventory = manifest.inventory.filter((id) => !filter || filter.test(id.split('/').slice(0, 3).join('/')));
  const appInput = process.env.TRACECODE_STAGE1_APP_INPUT;
  const app = appInput ? JSON.parse(readFileSync(appInput, 'utf8')) : null;
  if (app) {
    assert.equal(app.revision, 'fcea04982d5c0aa3d2112e188cff7ef9b22d5753');
    assert.deepEqual(app.fixtures.map((fixture) => ({ name: fixture.name, cases: fixture.cases.map(({ id }) => id) })),
      appSpec.map((fixture) => ({ name: appFixtureName(fixture), cases: fixture.cases })));
    record('identity.jsonl', { app: app.revision, appInputSha256: checksum(appInput) });
  }
  const selectedFixtures = [...manifest.fixtures, ...(app?.fixtures ?? [])].filter(matches);
  const muxPath = process.env.TRACECODE_STAGE1_MUX_INPUT;
  const mux = muxPath ? await loadMux(muxPath, evidence) : null;
  if (mux) record('identity.jsonl', { mux: mux.muxPin, scope: 'pinned slot adapter, no stored result writer' });
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
  async function exercise(fixture, requests, options = {}) {
    const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
    const page = await browser.newPage();
    const started = performance.now();
    const nonce = randomUUID();
    const observed = [];
    try {
      await page.exposeFunction('recordGateObservation', (wire) => {
        const observation = JSON.parse(wire);
        assert.equal(observation.nonce, nonce, 'Browser observation nonce');
        const request = requests.find(({ id }) => id === observation.request);
        assert(request, 'Unknown request observation');
        record('observations.jsonl', { fixture: key, route: options.route, control: options.control, ...observation });
        if (options.control) options.onObservation(observation);
        else {
          runtime.requests++;
          runtime.requestMs[`${key}/${options.route ?? 'default'}/${request.id}`] = observation.wallMs;
          observed.push(observation);
        }
        checkObservation(fixture, request, observation, options.record ?? recordAssertion);
      });
      page.on('pageerror', (error) => record('browser.jsonl', { fixture: key, error: error.message }));
      page.on('requestfailed', (request) => record('browser.jsonl', { fixture: key, url: request.url(), failure: request.failure() }));
      page.on('response', (response) => {
        if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
          record('browser.jsonl', { fixture: key, url: response.url(), status: response.status() });
        }
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      const finished = await page.evaluate(async ({ fixture, requests, nonce, mutation }) => {
        const { runFixture } = await import('/gate-browser.mjs');
        return runFixture(fixture, requests, nonce, mutation);
      }, { fixture, requests, nonce, mutation: options.control });
      assert.equal(finished, nonce, 'Browser fixture completion nonce');
      record('browser.jsonl', { fixture: key, terminal: finished });
    } catch (error) {
      record('browser.jsonl', { fixture: key, setupError: error.message });
    } finally {
      runtime.fixtureMs[options.control ? `control/${options.control}` : `${key}/${options.route ?? 'default'}`] = performance.now() - started;
      await page.close();
      console.log(`${key} ${options.control ?? 'baseline'} ${Math.round(performance.now() - started)}ms`);
    }
    if (!options.control && !options.route && !fixture.untracedOnly && manifest.fixtures.some(({ name, language }) => name === fixture.name && language === fixture.language)) {
      checkDifferential(fixture, observed, recordAssertion);
    }
  }
  for (const fixture of selectedFixtures) {
    if (fixture.name === 'ses-constructor-key') {
      for (const row of fixture.cases) {
        const actual = runInNewContext(`${fixture.code}\nnew Solution().detectDrift(snapshot)`, row.input);
        assert.equal(actual, row.actual, 'Node constructor-key witness');
        record('controls.jsonl', { fixture: fixture.name, language: fixture.language, case: row.id, actual, route: 'ordinary-node' });
      }
    }
    const stimulus = { traceOptions: manifest.traceOptions, ...fixture };
    await exercise(stimulus, requestMatrix(fixture.cases.map(({ id }) => id), fixture));
    if (candidateSource) {
      for (const { route, requests } of jsRouteRequests(fixture)) {
        await exercise({ ...stimulus, algorithmExecution: route }, requests, { route });
      }
      for (const route of cppDirectRoutes(fixture)) {
        const started = performance.now();
        const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
        const page = await browser.newPage();
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
          const observation = await page.evaluate(async ({ fixture, batch }) => {
            const { observeCppDirect } = await import('/gate-browser.mjs');
            return observeCppDirect(fixture, batch);
          }, { fixture: stimulus, batch: route === 'generated-batch' });
          record('observations.jsonl', { fixture: key, route, ...observation });
          checkCppDirect(fixture, route, observation, recordAssertion);
        } catch (error) {
          record('browser.jsonl', { fixture: key, route, setupError: error.message });
        } finally {
          runtime.fixtureMs[`${key}/${route}`] = performance.now() - started;
          await page.close();
        }
      }
    }
    if (mux) {
      const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
      try {
        const started = performance.now();
        await exerciseMux(mux.JudgeBrowserSlot, browser, `http://127.0.0.1:${server.address().port}`, stimulus, (request, observation) => {
          record('observations.jsonl', { fixture: key, route: 'mux', request: request.id, ...observation });
          checkObservation(stimulus, request, observation, recordAssertion);
          runtime.requests++;
          runtime.requestMs[`${key}/mux/${request.id}`] = observation.wallMs;
        });
        runtime.fixtureMs[`${key}/mux`] = performance.now() - started;
      } catch (error) {
        record('browser.jsonl', { fixture: key, route: 'mux', setupError: error.message });
      }
    }
  }
  const baseline = new Map(assertions.map((item) => [item.id, item.status]));
  const controlFailures = [];
  for (const control of manifest.controls.filter((control) => !filter || filter.test(control.fixture))) {
    const fixture = selectedFixtures.find((fixture) => `${fixture.gate}/${fixture.language}/${fixture.name}` === control.fixture);
    const expectedKey = (key) => `${control.fixture}/default/${key}`;
    const targets = control.keys.map(expectedKey);
    const unchanged = (control.unchanged ?? []).map(expectedKey);
    const controlResults = new Map();
    const hits = [];
    await exercise(fixture, manifest.requests.filter((request) => control.requests.includes(request.id)), {
      control: control.seed,
      onObservation: (observation) => { if (Array.isArray(observation.seedHits)) hits.push(...observation.seedHits); },
      record: (item) => controlResults.set(item.id, item.status),
    });
    const good = [...targets, ...unchanged].every((key) => baseline.get(key) === 'pass');
    const red = targets.every((key) => controlResults.get(key) === 'fail');
    const preserved = unchanged.every((key) => controlResults.get(key) === 'pass');
    const pass = good && red && preserved && hits.length === control.hits;
    if (!pass) controlFailures.push(control.seed);
    record('controls.jsonl', { seed: control.seed, pass, good, red, preserved, hits, targets, results: Object.fromEntries(controlResults) });
  }
  const result = summarize(inventory, assertions);
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ...result, controlFailures, runtime, partial: Boolean(filter) }, null, 2) + '\n');
  console.log(JSON.stringify(result.counts));
  process.exitCode = Number(Boolean(result.missing.length || result.failed.length || result.unexpected.length || result.repeated.length || controlFailures.length));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
