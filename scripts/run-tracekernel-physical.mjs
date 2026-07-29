#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const argumentsSet = new Set(process.argv.slice(2));
const argumentValue = (name) => process.argv
  .slice(2)
  .find((argument) => argument.startsWith(`${name}=`))
  ?.slice(name.length + 1);
const useTunnel = argumentsSet.has('--tunnel');
const checkEngine = argumentValue('--check');
const requestedPort = Number(argumentValue('--port') ?? 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new TypeError('--port must be an integer from 0 to 65535.');
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const traceJVMRoot = resolve(
  argumentValue('--tracejvm-root') ??
    process.env.TRACECODE_TRACEJVM_ROOT ??
    join(repositoryRoot, '../tracejvm')
);
const traceJVMWorker = resolve(traceJVMRoot, 'dist/browser-worker.js');
const traceJVMRuntime = resolve(traceJVMRoot, 'runtime/assets');
if (!existsSync(traceJVMWorker) || !existsSync(traceJVMRuntime)) {
  throw new Error(
    `TraceJVM browser assets are missing beneath ${traceJVMRoot}. ` +
      'Run pnpm build in the TraceJVM checkout first.'
  );
}
const javascriptWorker = resolve(
  repositoryRoot,
  'workers/javascript/javascript-project-worker.js'
);
if (!existsSync(javascriptWorker)) {
  throw new Error(
    'The JavaScript project worker is missing. Run pnpm generate:javascript-project-worker first.'
  );
}

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), 'tracekernel-physical-')
);
const physicalBundlePath = join(temporaryDirectory, 'physical.js');
const reportToken = randomBytes(24).toString('base64url');
const reportDirectory = resolve(
  argumentValue('--report-dir') ??
    join(repositoryRoot, 'reports/tracekernel-physical')
);
mkdirSync(reportDirectory, { recursive: true });

await build({
  entryPoints: [
    resolve(
      repositoryRoot,
      'tests/fixtures/tracekernel-physical-entry.ts'
    ),
  ],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: physicalBundlePath,
  logLevel: 'silent',
  alias: {
    '@tracecode/tracejvm': resolve(traceJVMRoot, 'src/index.ts'),
  },
});

const physicalBundle = readFileSync(physicalBundlePath);
const physicalHtml = readFileSync(
  resolve(
    repositoryRoot,
    'tests/fixtures/tracekernel-physical.html'
  )
);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.jar', 'application/java-archive'],
  ['.policy', 'text/plain; charset=utf-8'],
]);

function setIsolationHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendFile(response, path) {
  const size = statSync(path).size;
  response.setHeader(
    'Content-Type',
    contentTypes.get(extname(path)) ?? 'application/octet-stream'
  );
  response.setHeader('Content-Length', size);
  response.end(readFileSync(path));
}

let reportSequence = 0;
let resolveReport;
let nextReport = new Promise((resolveReportPromise) => {
  resolveReport = resolveReportPromise;
});

function receiveReport(request, response, url) {
  if (url.searchParams.get('token') !== reportToken) {
    response.statusCode = 403;
    response.end('forbidden');
    return;
  }
  const chunks = [];
  let byteLength = 0;
  request.on('data', (chunk) => {
    byteLength += chunk.length;
    if (byteLength > 2 * 1024 * 1024) {
      response.statusCode = 413;
      response.end('report too large');
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (response.writableEnded) return;
    try {
      const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      reportSequence += 1;
      const timestamp = new Date()
        .toISOString()
        .replaceAll(':', '-')
        .replaceAll('.', '-');
      const path = join(
        reportDirectory,
        `${timestamp}-run-${reportSequence}-${report.status ?? 'unknown'}.json`
      );
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        `DEVICE_REPORT status=${report.status ?? 'unknown'} ` +
          `checks=${report.checks?.filter?.((entry) => entry.passed).length ?? 0}/` +
          `${report.checks?.length ?? 0} elapsedMs=${Math.round(report.elapsedMs ?? 0)}`
      );
      console.log(`DEVICE_REPORT_PATH ${path}`);
      resolveReport?.(report);
      nextReport = new Promise((resolveReportPromise) => {
        resolveReport = resolveReportPromise;
      });
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    } catch (error) {
      response.statusCode = 400;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

const server = createServer((request, response) => {
  setIsolationHeaders(response);
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/api/report') {
    receiveReport(request, response, url);
    return;
  }
  if (url.pathname === '/physical.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.setHeader('Content-Length', physicalBundle.byteLength);
    response.end(physicalBundle);
    return;
  }
  if (url.pathname === '/workers/javascript-project-worker.js') {
    sendFile(response, javascriptWorker);
    return;
  }
  if (url.pathname.startsWith('/tracejvm/')) {
    const requested = decodeURIComponent(
      url.pathname.slice('/tracejvm/'.length)
    );
    const relative = requested === 'browser-worker.js'
      ? 'dist/browser-worker.js'
      : `runtime/assets/${requested}`;
    const path = normalize(resolve(traceJVMRoot, relative));
    if (
      !path.startsWith(`${traceJVMRoot}/`) ||
      !existsSync(path) ||
      !statSync(path).isFile()
    ) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    sendFile(response, path);
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Length', physicalHtml.byteLength);
  response.end(physicalHtml);
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(requestedPort, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Physical-device server did not bind.');
}

const localUrl =
  `http://127.0.0.1:${address.port}/?autorun=1&token=${encodeURIComponent(reportToken)}`;
console.log(`LOCAL_DEVICE_URL ${localUrl}`);
console.log(`REPORT_DIRECTORY ${reportDirectory}`);

let tunnel;
let shuttingDown = false;

async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  tunnel?.kill('SIGTERM');
  const closed = new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
  server.closeAllConnections();
  await closed;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

async function runAutomatedCheck(engine) {
  const playwright = await import('playwright');
  const browserType = playwright[engine];
  if (!browserType) {
    throw new Error(
      `Unknown --check engine ${JSON.stringify(engine)}; expected chromium, firefox, or webkit.`
    );
  }
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(localUrl);
    let reportDeadline;
    const report = await Promise.race([
      nextReport.finally(() => {
        if (reportDeadline) clearTimeout(reportDeadline);
      }),
      new Promise((_, reject) => {
        reportDeadline = setTimeout(
          () => reject(new Error('Physical-device check timed out after 180 seconds.')),
          180_000
        );
      }),
    ]);
    if (report.status !== 'passed') {
      throw new Error(`Physical-device check failed: ${JSON.stringify(report)}`);
    }
    console.log(
      `PASS: TraceKernel physical runner in ${engine} ` +
        `(${report.checks.length}/${report.checks.length} checks)`
    );
  } finally {
    await browser.close();
  }
}

async function startTunnel() {
  tunnel = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${address.port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const publicOrigin = await new Promise((resolveOrigin, rejectOrigin) => {
    const timeout = setTimeout(() => {
      rejectOrigin(new Error('cloudflared did not publish a URL within 30 seconds.'));
    }, 30_000);
    const inspect = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
      if (!match) return;
      clearTimeout(timeout);
      resolveOrigin(match[0]);
    };
    tunnel.stdout.on('data', inspect);
    tunnel.stderr.on('data', inspect);
    tunnel.once('error', rejectOrigin);
    tunnel.once('exit', (code, signal) => {
      rejectOrigin(
        new Error(
          `cloudflared exited before publishing a URL ` +
            `(${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}).`
        )
      );
    });
  });
  const publicUrl =
    `${publicOrigin}/?autorun=1&token=${encodeURIComponent(reportToken)}`;
  console.log(`PHYSICAL_IPAD_URL ${publicUrl}`);
  console.log(
    'Keep this process running until both the foreground and post-background reports arrive.'
  );
}

try {
  if (checkEngine) {
    await runAutomatedCheck(checkEngine);
    await close();
  } else {
    if (useTunnel) await startTunnel();
    process.once('SIGINT', () => {
      void close().then(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void close().then(() => process.exit(0));
    });
    await new Promise(() => undefined);
  }
} catch (error) {
  await close();
  throw error;
}
