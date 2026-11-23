import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { legacyCases, lineOf } from './legacy-cases.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const work = await mkdtemp(join(tmpdir(), 'cpp-step-gate-'));
let browser;
let server;
try {
  const workers = join(work, 'workers');
  execFileSync('corepack', ['pnpm', 'exec', 'tsx', 'src/cli.ts', 'sync-assets', workers, '--languages', 'cpp'],
    { stdio: 'inherit' });
  const lock = JSON.parse(await readFile('runtime-assets.lock.json', 'utf8')).engineDependencies.tracecc;
  const assetRoot = '/workers/cpp/tracecc/' + lock.consumerHash;
  const compilerAssets = lock.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const workerSha256 = sha256(await readFile(join(workers, 'cpp-worker.js')));
  const subject = execFileSync('git', ['rev-parse', process.env.CPP_STEP_SUBJECT ?? '96412c18'], { encoding: 'utf8' }).trim();
  const committedWorker = execFileSync('git', ['show', subject + ':workers/cpp/cpp-worker.js']);
  if (workerSha256 !== sha256(committedWorker)) throw new Error('Staged worker differs from subject ' + subject);
  const bundled = await build({
    stdin: {
      contents: [
        'export { CppWorkerClient } from "./packages/runtime-cpp/src/cpp-worker-client";',
        'export { TraceCCCompilerService } from "./packages/runtime-cpp/src/tracecc-compiler-service";',
      ].join('\n'),
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: 'tsconfig.base.json',
    alias: Object.fromEntries(['zlib', 'node:zlib'].map(name =>
      [name, resolve('packages/tracekernel/src/zlib-browser-shim.ts')])),
  });
  await writeFile(join(work, 'client.js'), bundled.outputFiles[0].contents);
  await writeFile(join(work, 'index.html'), '<!doctype html><title>C++ step gate</title>');
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = join(work, path === '/' ? 'index.html' : path);
    try {
      const bytes = await readFile(file);
      res.writeHead(200, {
        'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' })[extname(file)]
          ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => server.listen(0, '127.0.0.1', ready).once('error', reject));
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);

  await page.evaluate(async ({ assetRoot, compilerAssets }) => {
    const { CppWorkerClient, TraceCCCompilerService } = await import('/client.js');
    const asset = (path) => location.origin + assetRoot + '/' + path;
    const workerUrl = '/workers/cpp-worker.js';
    const compilerUrl = asset('tracecc-reactor.wasm');
    const resourcesUrl = asset('llvm-resources.tar');
    const runtimeHeaderUrl = asset('tracecode_runtime.hpp');
    const compiler = new TraceCCCompilerService({
      workerUrl, compilerUrl, resourcesUrl, runtimeHeaderUrl,
      compilerIntegrity: { assets: compilerAssets.map(({ path, ...entry }) => ({ ...entry, url: asset(path) })) },
      maxCompilesPerWorker: 8,
      shards: Object.fromEntries(['narrow', 'broad', 'map'].map(shard => [shard, {
        pchUrl: asset(shard + '.pch'),
        pchSourceUrl: asset(shard + '.source.hpp'),
        runtimeObjectUrl: asset(shard + '.o'),
      }])),
    });
    const client = new CppWorkerClient({
      workerUrl, runtimeHeaderUrl,
      compilerWasmUrl: compilerUrl, linkerWasmUrl: compilerUrl, sysrootUrl: resourcesUrl,
      trustedCompilerService: compiler, executionTimeoutMs: 60000, tracingTimeoutMs: 60000,
    });
    window.runWitness = async ({ code, functionName, inputs }) => {
      const request = { code, functionName, inputs, executionStyle: 'solution-method' };
      const ordinary = await client.executeCode(request);
      const traced = await client.executeWithTracing({ ...request, traceOptions: {
        maxSteps: 4000, maxLineEvents: 12000, maxHitsPerLine: 1000, maxEvents: 16000,
      } });
      return { ordinary, traced };
    };
  }, { assetRoot, compilerAssets });

  const rows = [];
  for (const c of legacyCases) {
    const assertions = [];
    const check = (key, expected, actual) => assertions.push({
      id: c.id + '/' + key, expected, actual, pass: equal(expected, actual),
    });
    let raw;
    try {
      raw = await page.evaluate(c => window.runWitness(c), c);
      if (c.invalid) {
        check('ordinary-compile-diagnostic', ['failed', 'compile', true],
          [raw.ordinary.kind, raw.ordinary.diagnosticStage, Boolean(raw.ordinary.error)]);
        check('trace-retains-diagnostic', ['failed', 'compile', true],
          [raw.traced.kind, raw.traced.diagnosticStage, Boolean(raw.traced.error)]);
      } else {
        check('ordinary', ['completed', c.output], [raw.ordinary.kind, raw.ordinary.output]);
        check('ordinary-console', [], raw.ordinary.consoleOutput);
        check('trace-result', ['completed', c.output], [raw.traced.kind, raw.traced.output]);
        check('trace-console', [], raw.traced.consoleOutput);
        check('trace-present', true, raw.traced.trace?.events?.length > 0);
        check('trace-complete', null, raw.traced.traceTruncated ?? null);
        for (const [index, step] of c.steps.entries()) {
          const line = lineOf(c.code, step.anchor);
          const values = (raw.traced.trace?.events ?? []).filter(event => event.line === line && event.kind === step.kind &&
            (event.target?.variable === step.variable ||
              (['call', 'return'].includes(step.kind) && event.function === step.variable)) &&
            equal(event.target?.path ?? [], step.path)).map(event =>
              step.kind === 'call' ? (event.args?.seed ?? null) : event.value);
          check('step-' + index, step.values, values);
        }
      }
    } catch (error) {
      raw = { ...raw, setupError: String(error) };
    }
    const status = raw.setupError || (c.invalid ? !assertions[0]?.pass :
      !assertions[0]?.pass || assertions.length !== 6 + c.steps.length)
      ? 'unexecuted' : assertions.every(a => a.pass) ? 'pass' : 'fail';
    rows.push({ id: c.id, family: c.family, status, assertions, raw });
    console.log(c.id, status, JSON.stringify(assertions.filter(a => !a.pass)), raw.setupError ?? '');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(process.argv[2] ?? 'cpp-step-legacy.json', JSON.stringify({
    head, subject, workerSha256, compiler: lock.releaseId, browser: browser.version(), rows,
  }, null, 2) + '\n');
  // An expected historical red must still exit red.
  if (rows.some(row => row.status !== 'pass')) process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(ready => server.close(ready));
  await rm(work, { recursive: true, force: true });
}
