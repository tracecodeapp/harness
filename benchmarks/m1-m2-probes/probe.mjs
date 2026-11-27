import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  appCommit, languages, loadBinarySearch, loadHeavyFixtures, loadM2Catalog,
  mutationCanary, releases, sha256, tracemallocWitness,
} from './inputs.mjs';
import { packedM1Probe } from './packed-probe.mjs';

const [mode, output, heavyPath, heavySha256] = process.argv.slice(2);
assert.ok(['m1-dry', 'm2-dry', 'dry'].includes(mode) && output,
  'probe.mjs dry|m1-dry|m2-dry OUTPUT [HEAVY_FIXTURES SHA256]');
assert.ok(process.env.HEAVY_JOBLOG_ID, 'Run this dry run through the job logger');
const out = resolve(output);
const requireRig = createRequire('/root/ci/g8-candidates.qHpuBwkE/package.json');
const { chromium } = requireRig('playwright');
const { build } = requireRig('esbuild');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

async function serve(site) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = resolve(site, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (!path.startsWith(site + sep)) throw new Error('Invalid route');
      const file = await stat(path);
      if (!file.isFile()) throw new Error('Invalid route');
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Content-Length': file.size,
      });
      const stream = createReadStream(path);
      response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

function command(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} failed with exit ${result.status}`, { cause: result.error });
}

async function stage(version, languages, m1 = false) {
  const pin = releases[version];
  assert.equal(sha256(await readFile(pin.archive)), pin.sha256, version);
  const root = join(out, 'v' + version);
  const packageRoot = join(root, 'package');
  const site = join(root, 'site');
  await mkdir(site, { recursive: true });
  command('tar', ['-xzf', pin.archive], root);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
  assert.equal(manifest.version, version);
  const priorRoot = version === '0.21.0'
    ? '/root/ci/h021-release-0.21.0.iMFK5Rua/consumer-release/node_modules/@tracecode/harness'
    : `/root/ci/g8-candidates.qHpuBwkE/historical/v${version}/package`;
  const dist = join(packageRoot, 'dist');
  const judge = join(dist, 'judge.js');
  assert.equal(sha256(await readFile(judge)), sha256(await readFile(join(priorRoot, 'dist/judge.js'))));
  // Reuse the installed production trees of the two accepted rigs for this
  // dry run. The measured package's own dist and assets come from its archive.
  const installedRoot = await realpath(priorRoot);
  const modules = join(packageRoot, 'node_modules');
  if (version === '0.21.0') {
    // The exact release was installed by pnpm, with sibling dependencies in
    // its virtual store. Link only the declared production dependencies.
    await mkdir(modules, { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const dest = join(modules, dependency);
      await mkdir(dirname(dest), { recursive: true });
      await symlink(join(dirname(installedRoot), dependency), dest);
    }
  } else {
    await symlink(join(priorRoot, 'node_modules'), modules);
  }
  command('node', ['dist/cli.cjs', 'sync-assets', join(site, 'workers'), '--languages', languages], packageRoot);
  if (m1) {
    const target = join(site, 'workers/csharp/csharp-worker.js');
    assert.equal(sha256(await readFile(target)), '8a417f47a78ceeba7ee6396027bb28b996f84367c6602b389e5c0b477d2869f0');
    await copyFile(new URL('../../workers/csharp/csharp-worker.js', import.meta.url), target);
    console.log(JSON.stringify({ csharpJavaScriptOnly: true, servedWorkerSha256: sha256(await readFile(target)) }));
  }
  const shim = join(dist, 'zlib-browser-shim.js');
  await build({
    entryPoints: [new URL(m1 ? './m1-browser.mjs' : './browser.mjs', import.meta.url).pathname],
    outfile: join(site, 'entry.mjs'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    alias: { 'probe-judge': judge, zlib: shim, 'node:zlib': shim },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    ...(m1 && { plugins: [packedM1Probe()] }),
  });
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
  return serve(site);
}

async function dryM2(browser, heavy) {
  const fixtures = await loadM2Catalog();
  for (const { provenance } of fixtures) console.log(JSON.stringify(provenance));
  const jobs = [
    ...fixtures.map(({ fixture, provenance: { problem, id } }) => ({ fixture, problem, id })),
    ...(heavy ? [{ fixture: heavy.python, problem: 'p0c-heavy', id: heavy.python.cases[0].id }] : []),
    { fixture: tracemallocWitness, problem: 'tracemalloc-witness', id: 'tracemalloc-off' },
  ];
  let complete = true;
  for (const version of ['0.17.1', '0.20.1', '0.21.0']) {
    const { server, url } = await stage(version, 'python');
    try {
      for (const [profile, rate] of [['desktop', 1], ['phone', 4]]) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          await page.goto(url);
          await page.evaluate(async () => {
            const { openJudge } = await import('/entry.mjs');
            globalThis.probeJudge = await openJudge();
          });
          for (const { fixture, problem, id } of jobs) {
            const result = await page.evaluate((fixture) => globalThis.probeJudge.run(fixture, false), fixture);
            console.log(JSON.stringify({ version, profile, problem, id, ...result }));
            complete &&= result.pass && result.compileReceipt && result.caseReceipt;
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      server.close();
    }
  }
  return complete;
}

async function dryM1(browser, heavy) {
  const { server, url } = await stage('0.21.0', 'python,javascript,java,cpp,csharp', true);
  let complete = true;
  try {
    for (const language of languages) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(url);
        await page.evaluate(async (language) => {
          const { openM1 } = await import('/entry.mjs');
          globalThis.probeM1 = openM1(language);
        }, language);
        const jobs = [
          ['canary', mutationCanary(language)],
          ['binary-search', await loadBinarySearch(language, 10)],
          ...(heavy ? [['p0c-heavy', heavy[language]]] : []),
        ];
        for (const [kind, fixture] of jobs) {
          try {
            const preparation = await page.evaluate((fixture) => globalThis.probeM1.prepare(fixture), fixture);
            const prime = preparation.kind === 'prepared' &&
              await page.evaluate(() => globalThis.probeM1.prime());
            const pair = prime === 'completed' &&
              await page.evaluate(() => globalThis.probeM1.pair('batch', false, true));
            console.log(JSON.stringify({ probe: 'm1', language, kind, preparation, prime, pair }));
            complete &&= Boolean(pair?.pass);
          } catch (error) {
            complete = false;
            console.log(JSON.stringify({ probe: 'm1', language, kind, error: error.name, message: error.message }));
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    server.close();
  }
  return complete;
}

const heavy = heavyPath ? await loadHeavyFixtures(heavyPath, heavySha256) : undefined;
const browser = await chromium.launch({ channel: 'chromium', headless: true });
let complete = true;
try {
  console.log(JSON.stringify({
    job: process.env.HEAVY_JOBLOG_ID, browser: browser.version(), appCommit,
    tarballs: Object.fromEntries(Object.entries(releases).map(([version, { sha256 }]) => [version, sha256])),
    heavySha256: heavy ? heavySha256 : null,
  }));
  if (mode !== 'm2-dry') complete = await dryM1(browser, heavy);
  if (mode !== 'm1-dry') complete = (await dryM2(browser, heavy)) && complete;
} finally {
  await browser.close();
}
if (!complete) process.exitCode = 1;
