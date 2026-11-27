import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkDeferredDrawing, ledgerFor, ordinaryProjection, seedReplayedAStart } from './gb-oracle.mjs';
import { deferredScenarios } from './deferred-browser.mjs';
import { assertDeferred, deferredChecks } from './deferred-oracle.mjs';
import { schedulerInjection } from './gb-probe.mjs';
import { loadMux, runMux } from './gb-mux.mjs';
import { summarize } from './checks.mjs';

const gates = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(await readFile(join(gates, 'gb-fixtures.json'), 'utf8'));
const [installationArg, assetsArg, evidenceArg] = process.argv.slice(2);
if (!installationArg || !assetsArg || !evidenceArg) throw new Error('Usage: gb-run.mjs INSTALLATION ASSET_ROOT EVIDENCE');
const output = resolve(evidenceArg);
const consumer = resolve(installationArg);
const assets = resolve(assetsArg);
const site = join(output, 'site');
const runId = randomUUID();
const attestedSubject = await readFile(join(output, 'candidate.sha'), 'utf8')
  .then((value) => value.trim(), (error) => {
    if (error.code !== 'ENOENT') throw error;
  });
const requestedSubject = process.env.TRACECODE_STAGE1_SUBJECT;
const candidate = attestedSubject ?? requestedSubject ?? fixtures.candidate;
assert.match(candidate, /^[0-9a-f]{40}$/u);
if (requestedSubject) assert.equal(candidate, requestedSubject, 'Installed subject differs from the requested subject');
const timer = performance.now();
const select = (variable) => process.env[variable]?.split(',').filter(Boolean);
const languages = select('GB_LANGUAGES');
const names = select('GB_FIXTURES');
const routeFilter = select('GB_ROUTES');
// Additional scheduler-only fault routes are opt-in so the frozen
// qualification inventory remains byte-for-byte comparable.
const probes = select('GB_PROBES') ?? [];
for (const probe of probes) assert(schedulerInjection(probe), `Unknown scheduler probe ${probe}`);
const optionalFixtures = fixtures.fixtures.filter(({ name }) => name === 'stdout').flatMap((fixture) =>
  [...new Set(probes)].filter((name) => !fixtures.fixtures.some((existing) =>
    existing.language === fixture.language && existing.name === name))
    .map((name) => ({ ...fixture, name, routes: ['run-first'] })));
const inventory = [...fixtures.fixtures, ...optionalFixtures].flatMap((fixture) =>
  fixture.routes.map((route) => ({ fixture, route })));
const requested = inventory.filter(({ fixture, route }) =>
  (!languages || languages.includes(fixture.language)) && (!names || names.includes(fixture.name)) &&
  (!routeFilter || routeFilter.includes(route)));

function key(fixture, route) {
  return [fixture.gate, fixture.language, fixture.name, route].join('/');
}

function installedRequire() {
  return createRequire(join(consumer, 'package.json'));
}

async function serve() {
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  };
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const asset = pathname.startsWith('/workers/');
    const root = asset ? assets : site;
    const name = pathname === '/' || pathname === '/no-coep' ? 'index.html' : pathname.slice(asset ? '/workers/'.length : 1);
    const file = resolve(root, decodeURIComponent(name));
    if (!file.startsWith(root + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    const isolation = pathname === '/no-coep' ? {} : {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };
    response.writeHead(200, {
      ...isolation,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Content-Length': statSync(file).size,
    });
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server;
}

async function prepareSite() {
  const fromConsumer = installedRequire();
  await mkdir(site, { recursive: true });
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
  const judge = fromConsumer.resolve('@tracecode/harness/judge');
  assert(judge.startsWith(consumer + sep), 'Judge must resolve inside the installed consumer');
  // Resolve the public ESM export from the disposable consumer. Do not bundle
  // source or resolve any package through the lane checkout's workspace.
  const built = await build({
    metafile: true,
    entryPoints: [join(gates, 'gb-browser.mjs')],
    plugins: [{
      name: 'installed-public-judge',
      setup(builder) {
        builder.onResolve({ filter: /^@tracecode\/harness\/(judge|tracekernel)$/ }, ({ path, pluginData }) => {
          if (pluginData?.resolvingInstalledJudge) return;
          return builder.resolve(path, {
            resolveDir: consumer, kind: 'import-statement', pluginData: { resolvingInstalledJudge: true },
          });
        });
      },
    }],
    absWorkingDir: consumer,
    outfile: join(site, 'gate.mjs'),
    platform: 'browser',
    format: 'esm',
    bundle: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const judgeEntry = Object.keys(built.metafile.inputs).find((path) => path.endsWith('/dist/judge.js'));
  assert(judgeEntry, 'Browser bundle must include the public ESM Judge');
  const resolvedJudge = realpathSync(resolve(consumer, judgeEntry));
  assert.equal(resolvedJudge, process.env.TRACECODE_STAGE1_VERIFIED_JUDGE, 'Browser bundle must use the byte-verified ESM Judge');
  const [sha256] = (await readFile(join(output, 'tarball.sha256'), 'utf8')).split(/\s+/u);
  assert.match(sha256, /^[0-9a-f]{64}$/u);
  const browserBundleSha256 = createHash('sha256').update(await readFile(join(site, 'gate.mjs'))).digest('hex');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { head, candidate, sha256, browserBundleSha256, publicExport: judgeEntry, setupMs: performance.now() - timer };
}

function summarizeSample(sample) {
  const evaluation = sample?.result?.evaluation;
  if (!evaluation) return sample?.unavailable ?? sample?.rejection?.message ?? 'missing receipt';
  if (evaluation.status === 'compile-failed') {
    return `compile-failed(${evaluation.compile?.failure?.origin}/${evaluation.compile?.failure?.stage ?? evaluation.compile?.failure?.reason})`;
  }
  return evaluation.cases.map((row) => {
    const outcome = row.failure ? `${row.failure.origin}/${row.failure.reason ?? row.failure.stage}`
      : row.notRun ? row.notRun.reason : JSON.stringify(row.value);
    return `${row.caseId}:${row.status}:${outcome}`;
  }).join(' ');
}

function controls(samples) {
  const out = [];
  const requestedKeys = new Set(requested.map(({ fixture, route }) => key(fixture, route)));
  const seed = (fixture, route, sample, name, assertion, mutate) => {
    if (!sample) return out.push({ name, status: 'unavailable', reason: 'Missing control baseline' });
    const id = `${key(fixture, route)}/${assertion}`;
    const state = (value) => ledgerFor(fixture, route, value).receipts.find((receipt) => receipt.id === id);
    const before = state(sample);
    const mutant = structuredClone(sample);
    const hits = mutate(mutant);
    const after = state(mutant);
    const status = before?.status === 'passed' && after?.status === 'failed' && hits === 1 ? 'caught' : 'unproven';
    out.push({ name, status, id, hits, before, after });
  };
  const g4 = fixtures.fixtures.find(({ gate, language, name }) => gate === 'G4' && language === 'python' && name === 'three-rows');
  if (requestedKeys.has(key(g4, 'submit-omitted-A'))) seed(g4, 'submit-omitted-A', samples.get(key(g4, 'submit-omitted-A')), 'timeout overwrites completed A', 'A/status', (sample) => {
    const row = sample.result?.evaluation.cases[0];
    if (!row) return 0;
    row.status = 'timed-out';
    row.failure = { origin: 'limit', reason: 'client-timeout', message: 'Seeded batch timeout' };
    delete row.value;
    return 1;
  });

  const transport = fixtures.fixtures.find(({ language, name }) => language === 'python' && name === 'transport');
  const clock = samples.get(key(transport, 'clock-virtual'));
  if (requestedKeys.has(key(transport, 'clock-virtual'))) {
    seed(transport, 'clock-virtual', clock, 'restart A in a fresh generation', 'A/ordinary-start-count', seedReplayedAStart);
  }

  const g5 = fixtures.fixtures.find(({ gate, language, name }) => gate === 'G5' && language === 'javascript' && name === 'stdout');
  if (requestedKeys.has(key(g5, 'submit-omitted'))) seed(g5, 'submit-omitted', samples.get(key(g5, 'submit-omitted')), 'observer output replaces judged value', 'A/value', (sample) => {
    const row = sample.result?.evaluation.cases[0];
    if (!row) return 0;
    row.value = 999;
    return 1;
  });

  const refused = fixtures.fixtures.find(({ name }) => name === 'no-recorder');
  // A checker-level control using a reference envelope.
  const carrier = samples.get(key(g5, 'submit-omitted'));
  if (carrier?.result?.evaluation?.cases?.[0]) {
    const reference = structuredClone(carrier);
    reference.result.evaluation.cases[0].attachment = {
      status: 'refused', cause: 'recorder-unavailable', events: [],
    };
    seed(refused, 'run-first', reference, 'empty synthetic success replaces typed refusal', 'A/provenance', (sample) => {
      sample.result.evaluation.cases[0].attachment = { status: 'complete', events: [] };
      return 1;
    });
  } else if (requestedKeys.has(key(g5, 'submit-omitted'))) {
    out.push({ name: 'empty synthetic success replaces typed refusal', status: 'unavailable', reason: 'Missing control baseline' });
  }
  return out;
}

async function main() {
  assert(requested.length, 'Selection matches no cases');
  await mkdir(output, { recursive: true });
  const planned = requested.flatMap(({ fixture, route }) => ledgerFor(fixture, route).expected);
  const deferred = !routeFilter && !names ? [...new Set(requested.map(({ fixture }) => fixture.language))]
    .flatMap((language) => deferredScenarios(language).map((scenario) => {
      const name = scenario.suffix ? 'three-rows' : scenario.cut ? scenario.name : 'stdout';
      const fixture = fixtures.fixtures.find((entry) => entry.language === language && entry.name === name);
      const prefix = `G5/${language}/${scenario.name}/deferred`;
      planned.push(...Object.keys(deferredChecks(scenario, {})).map((key) => `${prefix}/${key}`));
      return { fixture, scenario, prefix };
    })) : [];
  const deferredPhases = [];
  assert.equal(new Set(planned).size, planned.length, 'Duplicate planned assertion ID');
  await writeFile(join(output, 'planned.json'), JSON.stringify({ runId, candidate, planned }, null, 2));
  const meta = await prepareSite();
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const log = createWriteStream(join(output, 'raw.ndjson'), { flags: 'a' });
  const samples = new Map();
  const notes = [];
  const browserTime = performance.now();
  let browser;
  try {
    const mux = process.env.TRACECODE_STAGE1_MUX_INPUT && requested.some(({ route }) => route === 'mux-shape')
      ? await loadMux(process.env.TRACECODE_STAGE1_MUX_INPUT, output) : undefined;
    if (mux) meta.muxPin = mux.muxPin;
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    meta.browser = browser.version();
    for (const { fixture, scenario, prefix } of deferred) {
      const page = await browser.newPage();
      let sample;
      try {
        await page.goto(origin);
        sample = await page.evaluate(async ({ fixture, scenario }) => {
          const { runDeferredFixture } = await import('/gate.mjs');
          return runDeferredFixture(fixture, scenario);
        }, { fixture, scenario });
      } catch (error) {
        sample = { error: { message: error.message } };
      } finally {
        await page.close();
      }
      await new Promise((done, reject) => {
        log.write(JSON.stringify({ runId, id: prefix, sample }) + '\n', (error) => error ? reject(error) : done());
      });
      const assertions = assertDeferred(prefix, scenario, sample, (row, report) => checkDeferredDrawing(fixture, scenario, row, report));
      deferredPhases.push({ id: prefix, step8Owned: [], receipts: assertions.map((item) => ({
        ...item, status: item.status === 'pass' ? 'passed' : 'failed',
      })) });
    }
    for (const fixture of new Set(requested.map((item) => item.fixture))) {
      const page = await browser.newPage();
      const routes = requested.filter((item) => item.fixture === fixture).map((item) => item.route);
      const label = [fixture.gate, fixture.language, fixture.name].join('/');
      const crashed = new Promise((_, reject) => page.once('crash', () => reject(new Error('Chromium renderer crashed'))));
      crashed.catch(() => {});
      let deadline;
      try {
        page.on('requestfailed', (request) => notes.push({ label, url: request.url(), failure: request.failure() }));
        page.on('pageerror', (error) => notes.push({ label, error: error.message }));
        if (mux && routes.includes('mux-shape')) {
          await page.exposeFunction('gbRunMux', (bundle) => runMux(mux, page, origin + '/', fixture.language, bundle));
        }
        await page.exposeFunction('gbReceipt', async (sample) => {
          const id = key(fixture, sample.route);
          assert(routes.includes(sample.route) && !samples.has(id), `Unexpected or duplicate browser ACK ${id}`);
          samples.set(id, sample);
          await new Promise((done, reject) => {
            log.write(JSON.stringify({ runId, id, sample }) + '\n', (error) => error ? reject(error) : done());
          });
          console.log(`${id} ${Math.round(sample.durationMs)}ms ${summarizeSample(sample)}`);
        });
        await page.goto(fixture.noInterruptBuffer ? `${origin}/no-coep` : origin);
        const done = await Promise.race([
          crashed,
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Fixture service deadline expired')), 245000); }),
          page.evaluate(async ({ fixture, routes, runId }) => {
            const gate = await import('/gate.mjs');
            await gate.runFixture(fixture, { routes }, globalThis.gbReceipt);
            return runId;
          }, { fixture, routes, runId }),
        ]);
        assert.equal(done, runId, 'Missing terminal browser ACK');
      } catch (error) {
        notes.push({ label, error: error.message });
        console.error(`${label} incomplete ${error.message}`);
      } finally {
        clearTimeout(deadline);
        await page.close();
      }
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((done) => log.end(done));
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }

  const phases = requested.map(({ fixture, route }) => {
    const id = key(fixture, route);
    const sample = samples.get(id);
    const ledger = ledgerFor(fixture, route, sample);
    return {
      id, summary: summarizeSample(sample), durationMs: sample?.durationMs, setupMs: sample?.setupMs,
      ordinary: sample?.result?.evaluation ? ordinaryProjection(sample.result.evaluation) : undefined,
      ...ledger,
    };
  });
  phases.push(...deferredPhases);
  const count = (status) => phases.flatMap((phase) => phase.receipts).filter((receipt) => receipt.status === status).length;
  const step8Owned = new Set(phases.flatMap((phase) => phase.step8Owned));
  const inventoryReceipt = summarize(planned.filter((id) => !step8Owned.has(id)), phases.flatMap((phase) => phase.receipts.map((receipt) => ({
    ...receipt, status: receipt.status === 'passed' ? 'pass' : 'fail',
  }))));
  assert.equal(inventoryReceipt.repeated.length, 0);
  assert.equal(inventoryReceipt.unexpected.length, 0);
  for (const id of step8Owned) {
    const counts = inventoryReceipt.counts[id.split('/').slice(0, 2).join('/')];
    counts.expected++;
    counts.step8Owned = (counts.step8Owned ?? 0) + 1;
  }
  const report = {
    runId, ...meta, browserMs: performance.now() - browserTime, wallMs: performance.now() - timer,
    checks: { expected: planned.length, seen: count('passed') + count('failed'), passed: count('passed'), failed: count('failed'),
      missing: inventoryReceipt.missing.length, step8Owned: step8Owned.size },
    byLanguage: inventoryReceipt.counts, unexpected: inventoryReceipt.unexpected, repeated: inventoryReceipt.repeated,
    phases, notes, controls: controls(samples),
  };
  const filename = `gb-${runId}.json`;
  await writeFile(join(output, filename), JSON.stringify(report, null, 2) + '\n');
  console.log(`${basename(filename)} ${JSON.stringify(report.checks)} chromium=${meta.browser} browserMs=${Math.round(report.browserMs)}`);
  for (const control of report.controls) console.log(`control ${control.name} ${control.status}`);
  if (report.checks.failed || report.checks.missing || report.notes.some((note) => note.error) ||
    report.controls.some((control) => control.status !== 'caught')) process.exitCode = 1;
}

await main();
