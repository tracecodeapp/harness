import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkConsoleAcrossPaths, checkCppDirect, checkDifferential, checkObservation, compileDifferentialId, summarize } from './checks.mjs';
import { runGraphControls } from './graph.mjs';
import { appFixtureAssertionIds, appFixtureName, appSpec, cppDirectRoutes, jsRouteRequests, muxRequests, requestMatrix } from './requests.mjs';
import { installAppTraceArchive } from './app-trace-archive.mjs';
import { admitsCppValueAdapter } from './cpp-admission.mjs';
import { checkCppNaturalShape, cppNaturalShapeId, cppNaturalShapeRequests, cppNaturalShapes } from './cpp-natural-shapes.mjs';
import { cppRefusalFor } from './cpp-refusal.mjs';
import { checkJudgedByteLimit, judgedByteLimitFixtures, judgedByteLimitRequest } from './judged-byte-limit.mjs';
import { exerciseMux, loadMux } from './mux.mjs';
import { hasReceiptEvidence, receiptEvidenceIds } from './receipt.mjs';
import { retainedControlTargets } from './worker-evidence.mjs';
import { deferredScenarios } from './deferred-browser.mjs';
import { assertDeferred } from './deferred-oracle.mjs';
import { checkPresentation } from './receipt.mjs';

const manifest = JSON.parse(readFileSync(new URL('manifest.json', import.meta.url), 'utf8'));
const [installationArg, assetsArg, evidenceArg] = process.argv.slice(2);
if (!installationArg || !assetsArg || !evidenceArg) throw new Error('Usage: run.mjs CONSUMER_ASSET_INSTALL ASSET_ROOT EVIDENCE');
const installation = realpathSync(installationArg);
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
    'Cross-Origin-Resource-Policy': 'cross-origin',
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
    alias: {
      'stage1-worker-evidence': fileURLToPath(new URL('worker-evidence.mjs', import.meta.url)),
      'stage1-deferred-browser': fileURLToPath(new URL('deferred-browser.mjs', import.meta.url)),
    },
    external: ['/gate-routes.mjs', '/gate-app-trace-wire.mjs'],
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const installedJudge = Object.keys(built.metafile.inputs).find((name) => name.endsWith('/dist/judge.js'));
  assert(installedJudge, 'Browser bundle must resolve installed /judge');
  const resolvedJudge = realpathSync(installedJudge);
  assert(resolvedJudge.startsWith(installation + sep), 'Resolved /judge must be inside the isolated consumer');
  assert.equal(resolvedJudge, process.env.TRACECODE_STAGE1_VERIFIED_JUDGE, 'Browser bundle must load the byte-verified /judge');
  let candidateSource = process.env.TRACECODE_STAGE1_CANDIDATE_SOURCE;
  if (candidateSource) {
    const shim = join(candidateSource, 'packages/tracekernel/src/zlib-browser-shim.ts');
    try {
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
    } catch (error) {
      record('browser.jsonl', { route: 'provider-companions', setupError: error.message });
      candidateSource = undefined;
    }
  }
  record('identity.jsonl', {
    candidate: process.env.TRACECODE_STAGE1_SUBJECT ?? manifest.candidate,
    installedJudge: resolvedJudge, judgeSha256: checksum(resolvedJudge), browserBundleSha256: checksum(bundlePath), node: process.version,
  });
  writeFileSync(join(evidence, 'index.html'), '<!doctype html><meta charset="utf-8">');
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  record('identity.jsonl', { chromium: browser.version(), channel: 'chromium' });
  record('controls.jsonl', { graph: runGraphControls() });

  const filter = process.env.TRACECODE_STAGE1_FILTER ? new RegExp(process.env.TRACECODE_STAGE1_FILTER) : null;
  const matches = (row) => !filter || filter.test(`${row.gate}/${row.language}/${row.name}`);
  const plannedInventory = manifest.inventory.filter((id) => !filter || filter.test(id.split('/').slice(0, 3).join('/')));
  const inventory = new Set(plannedInventory);
  assert.equal(inventory.size, plannedInventory.length, 'Duplicate manifest inventory ID');
  const appInput = process.env.TRACECODE_STAGE1_APP_INPUT;
  let appFixtures = [];
  if (appInput) {
    try {
      const app = JSON.parse(readFileSync(appInput, 'utf8'));
      assert.deepEqual(app.fixtures.map(({ name, language, gate }) => ({ name, language, gate })),
        appSpec.map((spec) => ({ name: appFixtureName(spec), language: 'cpp', gate: 'G6' })));
      if (app.sources) {
        assert.match(app.revision, /^[a-f0-9]{40}$/);
        const paths = appSpec.flatMap(({ name, stage, candidateFile }) => [
          `data/interviews/${name}.json`,
          `data/interview-private/candidates/${candidateFile}.unpublished.json`,
          `data/reference-solutions/cpp/interviews/${name}/stage-${stage}.cpp`,
        ]);
        assert.deepEqual(Object.keys(app.sources).sort(), paths.sort());
        for (const digest of Object.values(app.sources)) assert.match(digest, /^[a-f0-9]{64}$/);
        for (const [index, fixture] of app.fixtures.entries()) {
          const { name, stage } = appSpec[index];
          const source = `data/reference-solutions/cpp/interviews/${name}/stage-${stage}.cpp`;
          assert.equal(createHash('sha256').update(fixture.code).digest('hex'), app.sources[source]);
          const ids = fixture.cases.map(({ id }) => id);
          assert.equal(new Set(ids).size, ids.length);
          if (name === 'blast-radius-analysis') assert.equal(ids.length, 6);
          else assert.deepEqual(ids, appSpec[index].cases);
        }
      } else {
        assert.equal(app.revision, 'fcea04982d5c0aa3d2112e188cff7ef9b22d5753');
        assert.deepEqual(app.fixtures.map(({ cases }) => cases.map(({ id }) => id)), appSpec.map(({ cases }) => cases));
      }
      copyFileSync(new URL('app-trace-wire.mjs', import.meta.url), join(evidence, 'gate-app-trace-wire.mjs'));
      record('identity.jsonl', { app: app.revision, appInputSha256: checksum(appInput), appSources: app.sources });
      appFixtures = app.fixtures.map((fixture) => ({ ...fixture, archiveAppTraces: true }));
      for (const fixture of appFixtures.filter(matches)) {
        const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/`;
        for (const id of inventory) if (id.startsWith(prefix)) inventory.delete(id);
        for (const id of appFixtureAssertionIds(fixture)) {
          assert(!inventory.has(id), `Duplicate app assertion ID ${id}`);
          inventory.add(id);
        }
      }
    } catch (error) {
      record('browser.jsonl', { route: 'app-fixtures', setupError: error.message });
    }
  }
  const subject = process.env.TRACECODE_STAGE1_SUBJECT ?? manifest.candidate;
  const cppValueAdapter = admitsCppValueAdapter(subject, process.env.TRACECODE_STAGE1_CANDIDATE_SOURCE);
  const selectedFixtures = [...manifest.fixtures, ...appFixtures, ...cppNaturalShapes(subject, cppValueAdapter)].filter(matches);
  const selectedByteLimits = judgedByteLimitFixtures.filter(matches);
  const muxPath = process.env.TRACECODE_STAGE1_MUX_INPUT;
  let mux;
  if (muxPath) {
    try {
      mux = await loadMux(muxPath, evidence);
    } catch (error) {
      record('browser.jsonl', { route: 'mux', setupError: error.message });
    }
  }
  if (mux) record('identity.jsonl', { mux: mux.muxPin, scope: 'pinned slot adapter, no stored result writer' });
  assert(selectedFixtures.length || selectedByteLimits.length, 'Filter selected no fixtures');
  const assertions = [];
  const recordAssertion = (item) => {
    assertions.push(item);
    record('assertions.jsonl', item);
  };
  const receiptLanguages = new Set((process.env.TRACECODE_STAGE1_RECEIPT_LANGUAGES ?? '').split(',').filter(Boolean));
  function judgePath(fixture, requests, observed, options = {}) {
    if (fixture.naturalShape) {
      const byId = new Map(requests.map((request) => [request.id, request]));
      for (const request of requests) {
        const id = cppNaturalShapeId(fixture, request);
        assert(!inventory.has(id), `Duplicate natural shape assertion ID ${id}`);
        inventory.add(id);
      }
      for (const observation of observed) {
        checkCppNaturalShape(fixture, byId.get(observation.request), observation, recordAssertion);
      }
      return;
    }
    const publicRoute = !options.route || options.route === 'mux';
    const registered = Boolean(fixture.cppRefusal) || (subject !== manifest.candidate &&
      (observed.some(hasReceiptEvidence) || (publicRoute && receiptLanguages.has(fixture.language))));
    const compileOnly = registered && (fixture.syntax || fixture.cppRefusal);
    const applicable = requests.filter(({ mode }) => !compileOnly || mode !== 'continuation');
    if (registered && !options.control) {
      if (compileOnly) {
        const path = `${fixture.gate}/${fixture.language}/${fixture.name}/${options.route ?? 'default'}/`;
        const continuations = new Set(requests.filter(({ mode }) => mode === 'continuation').map(({ id }) => id));
        for (const id of inventory) {
          if (!id.startsWith(path)) continue;
          const [requestId, caseId] = id.slice(path.length).split('/');
          if (caseId !== '@request' || continuations.has(requestId)) inventory.delete(id);
        }
        if (!options.route) inventory.add(compileDifferentialId(fixture));
        if (fixture.cppRefusal) {
          for (const id of continuations) inventory.add(`${path}${id}/@request/skipped`);
        }
      }
      for (const request of applicable) {
        for (const id of receiptEvidenceIds(fixture, request)) {
          assert(!inventory.has(id), `Duplicate receipt evidence ID ${id}`);
          inventory.add(id);
        }
      }
    }
    const byId = new Map((fixture.cppRefusal ? requests : applicable).map((request) => [request.id, request]));
    for (const observation of observed) {
      const request = byId.get(observation.request);
      if (request) checkObservation(fixture, request, observation, options.record ?? recordAssertion, registered);
    }
    return registered;
  }
  const runtime = { setupMs: performance.now(), requests: 0, fixtureMs: {}, requestMs: {} };
  const deferredFixtures = JSON.parse(readFileSync(new URL('deferred-fixtures.json', import.meta.url), 'utf8'));
  for (const language of new Set(deferredFixtures.filter((fixture) => matches({
    ...fixture, gate: 'G1', name: 'stdout',
  })).map((fixture) => fixture.language))) {
    for (const scenario of deferredScenarios(language)) {
      const fixtureName = scenario.suffix ? 'three-rows' : scenario.cut ? scenario.name : 'stdout';
      const fixture = deferredFixtures.find((entry) => entry.language === language && entry.name === fixtureName);
      const page = await browser.newPage();
      let report;
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
        report = await page.evaluate(async ({ fixture, scenario }) => {
          const { runDeferredFixture } = await import('/gate-browser.mjs');
          return runDeferredFixture(fixture, scenario);
        }, { fixture, scenario });
      } catch (error) {
        report = { error: { message: error.message } };
      } finally {
        await page.close();
      }
      const prefix = `G1/${language}/${scenario.name}/deferred`;
      record('deferred.jsonl', { prefix, ...report });
      const receipts = assertDeferred(prefix, scenario, report, (row, { presentation, workspaceDigest }) => {
        checkPresentation(row, presentation.ordinaryProjections[0], presentation.tracedProjections[0], true, workspaceDigest);
        if (!scenario.suffix) {
          const expected = fixture.cases[0];
          assert.equal(row.status, 'completed');
          assert.equal(row.verdict.kind, expected.grade);
          assert.deepEqual(row.value, expected.actual);
          assert.equal(row.stdout, expected.stdout);
        }
      });
      for (const item of receipts) {
        assert(!inventory.has(item.id), `Duplicate deferred assertion ${item.id}`);
        inventory.add(item.id);
        recordAssertion(item);
      }
    }
  }
  async function exercise(fixture, requests, options = {}) {
    const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
    const page = await browser.newPage();
    const started = performance.now();
    const nonce = randomUUID();
    const observed = [];
    let disposeArchive;
    try {
      if (fixture.archiveAppTraces) disposeArchive = await installAppTraceArchive(page, evidence);
      await page.exposeFunction('recordGateObservation', (wire) => {
        const observation = JSON.parse(wire);
        assert.equal(observation.nonce, nonce, 'Browser observation nonce');
        const request = requests.find(({ id }) => id === observation.request);
        assert(request, 'Unknown request observation');
        record('observations.jsonl', { fixture: key, route: options.route, control: options.control, ...observation });
        options.onObservation?.(observation);
        if (!options.control) {
          runtime.requests++;
          runtime.requestMs[`${key}/${options.route ?? 'default'}/${request.id}`] = observation.wallMs;
        }
        observed.push(observation);
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
      try { await page.close(); } finally { await disposeArchive?.(); }
      console.log(`${key} ${options.control ?? 'baseline'} ${Math.round(performance.now() - started)}ms`);
    }
    if (fixture.judgedByteLimit !== undefined) {
      recordAssertion(checkJudgedByteLimit(fixture, observed));
      return;
    }
    const registered = judgePath(fixture, requests, observed, options);
    if (!options.control && !options.route && !fixture.cppRefusal && !fixture.untracedOnly &&
        manifest.fixtures.some(({ name, language }) => name === fixture.name && language === fixture.language)) {
      checkDifferential(fixture, observed, recordAssertion, registered);
    }
    return registered;
  }
  for (const fixture of selectedByteLimits) {
    if (fixture.judgedByteLimit === undefined) recordAssertion(checkJudgedByteLimit(fixture, []));
    else await exercise(fixture, [judgedByteLimitRequest]);
  }
  for (const fixture of selectedFixtures) {
    if (fixture.naturalShape) {
      await exercise(fixture, cppNaturalShapeRequests(fixture));
      continue;
    }
    if (fixture.name === 'ses-constructor-key') {
      for (const row of fixture.cases) {
        const actual = runInNewContext(`${fixture.code}\nnew Solution().detectDrift(snapshot)`, row.input);
        assert.equal(actual, row.actual, 'Node constructor-key witness');
        record('controls.jsonl', { fixture: fixture.name, language: fixture.language, case: row.id, actual, route: 'ordinary-node' });
      }
    }
    const cppRefusal = cppRefusalFor(fixture, subject, manifest.candidate, receiptLanguages.has('cpp'), cppValueAdapter);
    const csharpAcknowledgements = fixture.language === 'csharp' && subject !== manifest.candidate &&
      subject !== '440dbd828870901be49cf0caefb0ade9bd88c034' &&
      (subject === '09378c5d0306c49b435de85c56e001444b7a4820' || receiptLanguages.has('csharp'));
    const stimulus = { traceOptions: manifest.traceOptions, ...fixture, cppRefusal, csharpAcknowledgements };
    if (cppRefusal) {
      const prefix = `${fixture.gate}/${fixture.language}/${fixture.name}/`;
      for (const id of inventory) {
        if (!id.startsWith(prefix)) continue;
        const [route, request, caseId] = id.slice(prefix.length).split('/');
        if (route === 'all-routes' || request === 'path-differential' ||
            (route !== 'default' && route !== 'mux' && caseId !== '@request')) inventory.delete(id);
      }
      for (const route of cppDirectRoutes(fixture)) inventory.add(`${prefix}${route}/code/@request/compile`);
    }
    const crossPathObservations = [];
    const keepCrossPath = (observation, route = 'default') => {
      if (cppRefusal || fixture.consolePolicy) crossPathObservations.push({ ...observation, route });
    };
    await exercise(stimulus, requestMatrix(fixture.cases.map(({ id }) => id), fixture), { onObservation: keepCrossPath });
    if (candidateSource) {
      for (const { route, requests } of jsRouteRequests(fixture)) {
        await exercise({ ...stimulus, algorithmExecution: route }, requests, { route, onObservation: (observation) => keepCrossPath(observation, route) });
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
          checkCppDirect(stimulus, route, observation, recordAssertion);
        } catch (error) {
          record('browser.jsonl', { fixture: key, route, setupError: error.message });
        } finally {
          runtime.fixtureMs[`${key}/${route}`] = performance.now() - started;
          await page.close();
        }
      }
    }
    if (mux) {
      const observed = [];
      const key = `${fixture.gate}/${fixture.language}/${fixture.name}`;
      try {
        const started = performance.now();
        await exerciseMux(mux.JudgeBrowserSlot, browser, `http://127.0.0.1:${server.address().port}`, stimulus, (request, observation) => {
          record('observations.jsonl', { fixture: key, route: 'mux', request: request.id, ...observation });
          keepCrossPath({ request: request.id, ...observation }, 'mux');
          observed.push({ ...observation, request: request.id });
          runtime.requests++;
          runtime.requestMs[`${key}/mux/${request.id}`] = observation.wallMs;
        }, evidence);
        runtime.fixtureMs[`${key}/mux`] = performance.now() - started;
      } catch (error) {
        record('browser.jsonl', { fixture: key, route: 'mux', setupError: error.message });
      }
      judgePath(stimulus, muxRequests(fixture), observed, { route: 'mux' });
    }
    if (cppRefusal) {
      checkDifferential(stimulus, crossPathObservations, recordAssertion, true);
    } else if (fixture.consolePolicy) {
      checkConsoleAcrossPaths(fixture, crossPathObservations, recordAssertion, (observation) => record('console-framing.jsonl', observation));
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
    const observedValues = new Map();
    const requests = requestMatrix(fixture.cases.map(({ id }) => id), fixture);
    const controlled = requests.filter((request) => control.requests.includes(request.id));
    const hitRequests = new Set();
    const registered = await exercise(fixture, controlled, {
      control: control.seed,
      onObservation: (observation) => {
        if (Array.isArray(observation.seedHits) && observation.seedHits.length) {
          hits.push(...observation.seedHits);
          hitRequests.add(observation.request);
        }
        for (const row of observation.reported?.evaluation?.cases ?? []) {
          observedValues.set(`${observation.request}/${row.caseId}/value`, row.value);
        }
      },
      record: (item) => controlResults.set(item.id, item.status),
    });
    const good = [...targets, ...unchanged].every((key) => baseline.get(key) === 'pass');
    const red = targets.every((key) => controlResults.get(key) === 'fail');
    const preserved = unchanged.every((key) => controlResults.get(key) === 'pass');
    const correctFault = control.keys.every((key) => {
      const observed = observedValues.get(key);
      if (control.seed === 'split-second-edge') return observed === 12;
      if (control.seed === 'list-field') return observed?.value === 1;
      const caseId = key.split('/')[1];
      return observed === fixture.cases.find(({ id }) => id === caseId).actual + 1;
    });
    const retainedTargets = retainedControlTargets(control, controlled, registered);
    const expectedHits = control.hits - retainedTargets.length;
    const redispatched = retainedTargets.some((key) => hitRequests.has(key.split('/')[0]));
    const pass = good && red && preserved && correctFault && !redispatched && hits.length === expectedHits;
    if (!pass) controlFailures.push(control.seed);
    record('controls.jsonl', { seed: control.seed, pass, good, red, preserved, correctFault, expectedHits, redispatched, hits, targets,
      observedValues: Object.fromEntries(observedValues), results: Object.fromEntries(controlResults) });
  }
  const result = summarize([...inventory], assertions);
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ...result, controlFailures, runtime, partial: Boolean(filter) }, null, 2) + '\n');
  console.log(JSON.stringify(result.counts));
  process.exitCode = Number(Boolean(result.missing.length || result.failed.length || result.unexpected.length || result.repeated.length || controlFailures.length));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
