// Usage: node run.mjs CONSUMER ASSETS OUT.json FIXTURE.json
import { createReadStream, readFileSync, realpathSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const [consumerArg, assetsArg, outArg, fixtureArg] = process.argv.slice(2);
const consumer = realpathSync(consumerArg); const assets = resolve(assetsArg);
const page = mkdtempSync(join(tmpdir(), 'sample-'));
await build({ stdin: { contents: readFileSync(fileURLToPath(new URL('sample-page.mjs', import.meta.url)), 'utf8'), resolveDir: consumer, sourcefile: 'p.mjs' },
  outfile: join(page, 'p.mjs'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(join(page, 'index.html'), '<!doctype html><meta charset="utf-8">');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const a = path.startsWith('/workers/'); const root = a ? assets : page;
  const name = resolve(root, a ? path.slice(9) : path.slice(1));
  const info = name.startsWith(root + sep) && statSync(name, { throwIfNoEntry: false });
  if (!info?.isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': types[extname(name)] ?? 'application/octet-stream', 'Content-Length': info.size,
    'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  createReadStream(name).pipe(response);
});
await new Promise((d) => server.listen(0, '127.0.0.1', d));
const browser = await chromium.launch({ channel: process.platform === 'linux' ? 'chromium' : undefined, headless: true });
try {
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  const result = await tab.evaluate(async (f) => (await import('/p.mjs')).sample(f), JSON.parse(readFileSync(fixtureArg, 'utf8')));
  writeFileSync(outArg, JSON.stringify(result, null, 2) + '\n');
  const d = result.run.evaluation.compile?.diagnostics?.[0];
  console.log('run', result.run.evaluation.status, JSON.stringify(d), 'submit', result.submit.evaluation.status, result.submit.verdict?.kind ?? result.submit.verdict);
} finally { await browser.close(); server.close(); }
