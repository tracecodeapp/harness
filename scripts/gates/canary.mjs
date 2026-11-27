import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

async function serve(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const file = resolve(root, '.' + decodeURIComponent(pathname));
      if (!file.startsWith(root + sep)) return response.writeHead(404).end();
      const info = await stat(file);
      if (!info.isFile()) return response.writeHead(404).end();
      response.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function prepareSite(site, entry) {
  execFileSync(process.execPath, [
    'dist/cli.cjs', 'sync-assets', join(site, 'workers'), '--inventory',
  ], { stdio: 'inherit' });
  const built = await build({
    entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', metafile: true,
    outfile: join(site, 'canary.mjs'), define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!Object.hasOwn(built.metafile.inputs, 'dist/judge.js')) {
    throw new Error('Canary must resolve the built @tracecode/harness/judge export.');
  }
  await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
}

async function collectReceipts(site) {
  const server = await serve(site);
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const rows = await page.evaluate(async () => {
      const { programs, runCanary } = await import('/canary.mjs');
      const rows = [];
      for (const language of Object.keys(programs)) {
        try {
          rows.push(await runCanary(language));
        } catch (error) {
          rows.push({ language, failure: { stage: 'setup or teardown', message: error.message } });
        }
      }
      return rows;
    });
    return { rev: process.env.GATE_REV, browser: browser.version(), rows };
  } finally {
    try {
      await browser?.close();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }
}

async function canary(entry) {
  const output = process.env.GATE_OUTPUT;
  if (!output || !entry) throw new Error('Run the canary with scripts/gates/run-cell.sh.');
  const site = await mkdtemp(join(output, 'site-'));
  try {
    await prepareSite(site, entry);
    const receipt = await collectReceipts(site);
    await writeFile(join(output, 'canary.json'), JSON.stringify(receipt, null, 2) + '\n');
    for (const row of receipt.rows) console.log(JSON.stringify(row));
    if (receipt.rows.length !== 6 || receipt.rows.some(({ failure }) => failure)) process.exitCode = 1;
  } finally {
    await rm(site, { recursive: true, force: true });
  }
}

try {
  await canary(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
