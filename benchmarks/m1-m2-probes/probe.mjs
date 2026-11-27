import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { appCommit, loadM2Catalog, releases, sha256 } from './inputs.mjs';

const [mode, output] = process.argv.slice(2);
assert.ok(mode === 'm2-dry' && output, 'probe.mjs m2-dry OUTPUT');
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

async function stage(version, languages) {
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
  const fallbackModules = [join(priorRoot, 'node_modules'), join(dirname(resolve(priorRoot)), 'node_modules')];
  const { realpath, symlink } = await import('node:fs/promises');
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
    await symlink(fallbackModules[0], modules);
  }
  command('node', ['dist/cli.cjs', 'sync-assets', join(site, 'workers'), '--languages', languages], packageRoot);
  const shim = join(dist, 'zlib-browser-shim.js');
  await build({
    entryPoints: [new URL('./browser.mjs', import.meta.url).pathname],
    outfile: join(site, 'entry.mjs'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    alias: { 'probe-judge': judge, zlib: shim, 'node:zlib': shim },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
  return serve(site);
}

const fixtures = await loadM2Catalog();
for (const { provenance } of fixtures) console.log(JSON.stringify(provenance));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
let complete = true;
try {
  console.log(JSON.stringify({
    job: process.env.HEAVY_JOBLOG_ID, browser: browser.version(), appCommit,
    tarballs: Object.fromEntries(Object.entries(releases).map(([version, { sha256 }]) => [version, sha256])),
  }));
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
          for (const { fixture, provenance: { problem, id } } of fixtures) {
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
} finally {
  await browser.close();
}
if (!complete) process.exitCode = 1;
