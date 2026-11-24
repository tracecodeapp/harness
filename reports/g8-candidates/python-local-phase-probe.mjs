import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [siteArg, corpusArg, candidateRuntimeArg = '1'] = process.argv.slice(2);
assert.ok(siteArg && corpusArg,
  'Usage: python-local-phase-probe.mjs <staged site> <app corpus> [candidate-runtime 0|1]');
const site = resolve(siteArg);
const corpus = resolve(corpusArg);
const candidateRuntime = candidateRuntimeArg === '1';
assert.ok(candidateRuntime || candidateRuntimeArg === '0');
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
assert.ok(playwrightModule, 'Set PLAYWRIGHT_MODULE to playwright/index.mjs');
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.whl': 'application/octet-stream',
};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = resolve(site, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  const stat = path.startsWith(site + sep) && statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return response.writeHead(404).end();
  response.writeHead(200, {
    'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=3600',
  });
  const stream = createReadStream(path);
  response.on('close', () => stream.destroy());
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});
await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', ready);
});

const problem = JSON.parse(await readFile(join(corpus, 'problems/binary-search.json'), 'utf8'));
const comparison = {
  schema: 'tracecode.judge.comparator.v1',
  mode: problem.compareMode ?? 'exact',
  ...(problem.customValidator && { customValidator: problem.customValidator }),
};
const fixture = {
  id: problem.id,
  language: 'python',
  code: problem.solutionCode,
  functionName: problem.functionName,
  executionStyle: problem.executionStyle ?? 'function',
  comparison,
  traceBudget: {
    maxTraceSteps: 4_000,
    maxLineEvents: 12_000,
    maxSingleLineHits: 1_000,
    maxStoredEvents: 16_000,
  },
  cases: problem.testCases.map(({ id, input, expected, customValidator }, index) => ({
    id: id ?? 'case-' + (index + 1), input, expected,
    ...(customValidator && { comparator: { ...comparison, customValidator } }),
  })),
};

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(240_000);
page.on('console', (message) => process.stderr.write('[page] ' + message.text() + '\n'));
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'load' });
  await page.evaluate(async ({ candidateRuntime }) => {
    const { createSession } = await import('/entry.mjs');
    window.bench = createSession('python', false, true, candidateRuntime);
  }, { candidateRuntime });
  const warm = await page.evaluate(() => window.bench.warm());
  const first = await page.evaluate((fixture) => window.bench.initial(fixture, 'run', false), fixture);
  const second = await page.evaluate((fixture) => window.bench.initial(fixture, 'run', false), fixture);
  await page.evaluate(() => window.bench.release());
  console.log(JSON.stringify({
    candidateRuntime,
    warm,
    first: { elapsedMs: first.elapsedMs, firstTraceMs: first.firstTraceMs, python: first.python },
    second: { elapsedMs: second.elapsedMs, firstTraceMs: second.firstTraceMs, python: second.python },
  }, null, 2));
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
}
