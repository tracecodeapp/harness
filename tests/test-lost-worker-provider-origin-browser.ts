#!/usr/bin/env npx tsx

/**
 * A browser worker lost after the learner's code was dispatched (the host
 * terminates it and its `error` event fires) is the provider's failure in
 * every runtime: the Judge throws `JudgeInfrastructureError` or reports each
 * case with `failure.origin: "provider"`, never `"program"`. Programs that
 * fail on their own (raise, exit, recurse too deep, exhaust memory, run out
 * of time) stay the program's or their limit's.
 *
 * Environment:
 * - TRACECODE_LOST_WORKER_LANGUAGES=python,csharp   restrict languages
 * - TRACECODE_LOST_WORKER_MODES=code,trace          restrict modes
 * - TRACECODE_LOST_WORKER_LEARNER=0                 skip the learner probes
 * - TRACECODE_LOST_WORKER_BROWSER_CHANNEL=...     Playwright Chromium channel
 *   (default: full Chromium on Linux, the bundled shell elsewhere)
 */

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import type {
  LostWorkerLanguage,
  LostWorkerMode,
  LostWorkerObservation,
} from './fixtures/lost-worker-provider-origin-entry';

const ALL_LANGUAGES: readonly LostWorkerLanguage[] = ['python', 'csharp', 'javascript', 'typescript', 'java', 'cpp'];
const ALL_MODES: readonly LostWorkerMode[] = ['code', 'code-batch', 'trace', 'trace-batch'];

function csv(name: string): string[] | undefined {
  const value = process.env[name]?.split(',').map((entry) => entry.trim()).filter(Boolean);
  return value?.length ? value : undefined;
}

const LANGUAGES = (csv('TRACECODE_LOST_WORKER_LANGUAGES') ?? ALL_LANGUAGES) as LostWorkerLanguage[];
const MODES = (csv('TRACECODE_LOST_WORKER_MODES') ?? ALL_MODES) as LostWorkerMode[];
const LEARNER = process.env.TRACECODE_LOST_WORKER_LEARNER !== '0';
// Linux C++ needs full Chromium: chromium-headless-shell crashes on a C++
// WebAssembly out-of-bounds write there (see the learner-failure matrix).
const BROWSER_CHANNEL = process.env.TRACECODE_LOST_WORKER_BROWSER_CHANNEL ||
  process.env.TRACECODE_MATRIX_BROWSER_CHANNEL ||
  (process.platform === 'linux' ? 'chromium' : undefined);
for (const language of LANGUAGES) assert(ALL_LANGUAGES.includes(language), `Unknown language ${language}`);
for (const mode of MODES) assert(ALL_MODES.includes(mode), `Unknown mode ${mode}`);

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

async function startServer(root: string) {
  const headers = {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(filePath)) {
      response.writeHead(404, headers).end('Not found');
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Length': String(statSync(filePath).size),
      'Content-Type': contentType(filePath),
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections?.();
    }),
  };
}

/** The lost worker is the provider's: an infrastructure throw, or provider-origin outcomes. */
function lostWorkerProblem(observation: LostWorkerObservation): string | undefined {
  if (observation.lostAfter.length === 0) {
    return 'no learner execute message was dispatched, so nothing was injected';
  }
  const causes = observation.typedCauses ?? [];
  return causes.length && causes.every((cause) => cause === 'provider:runtime-failure')
    ? undefined
    : `G3/lost-worker/typed-cause: expected provider:runtime-failure, got ${JSON.stringify(causes)}`;
}

/** A program that failed on its own stays the program's, or its limit's. */
function learnerProblem(observation: LostWorkerObservation): string | undefined {
  if (observation.threw !== undefined) return `threw: ${observation.threw}`;
  const wrong = observation.outcome.filter((entry) =>
    !entry.endsWith(':program') && !entry.endsWith(':limit')
  );
  return wrong.length === 0 ? undefined : `outcome ${JSON.stringify(observation.outcome)}`;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-lost-worker-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(root, 'workers'), '--languages', LANGUAGES.join(',')],
      process.cwd()
    );
    if (LANGUAGES.includes('cpp')) {
      const { tracecc } = await loadEngineRuntimePackages(resolve('.'));
      await symlink(tracecc.sourceRoot, join(root, 'tracecc'), 'dir');
    }
    await build({
      entryPoints: [resolve('tests/fixtures/lost-worker-provider-origin-entry.ts')],
      outfile: join(root, 'lost-worker.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(root, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(root));

    const browser = await chromium.launch({
      headless: true,
      ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
    });
    const problems: string[] = [];
    let controlHits = 0;
    try {
      for (const language of LANGUAGES) {
        const page = await browser.newPage();
        page.setDefaultTimeout(20 * 60_000);
        page.on('pageerror', (error) => console.error(`[${language} pageerror] ${error.message}`));
        try {
          await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
          const crashed = new Promise<never>((_, reject) => {
            page.once('crash', () => reject(new Error('the page crashed')));
          });
          crashed.catch(() => undefined);
          const observations = (await Promise.race([crashed, page.evaluate(async (options) => {
            const moduleUrl: string = '/lost-worker.mjs';
            const module = await import(moduleUrl);
            return module.runLostWorkerProbes(options);
          }, {
            assetBaseUrl: '/workers',
            language,
            modes: MODES,
            learner: LEARNER,
          })])) as LostWorkerObservation[];
          for (const observation of observations) {
            const problem = observation.probe === 'worker-lost-after-dispatch'
              ? lostWorkerProblem(observation)
              : learnerProblem(observation);
            if (!problem && controlHits === 0 && observation.probe === 'worker-lost-after-dispatch') {
              const [first, ...rest] = observation.typedCauses!;
              assert.equal(first, 'provider:runtime-failure');
              const red = lostWorkerProblem({ ...observation, typedCauses: ['limit:client-timeout', ...rest] });
              assert.match(red ?? '', /^G3\/lost-worker\/typed-cause:.*limit:client-timeout/u);
              controlHits += 1;
              console.log(`G3/lost-worker/typed-cause mutant hit=1 at browser receipt (${language}/${observation.mode})`);
            }
            const verdict = problem ? 'FAIL' : 'pass';
            console.log(
              `${verdict} ${language} ${observation.mode} ${observation.probe}: ` +
              `${observation.outcome.join('; ')}` +
              (observation.lostAfter.length ? ` [lost after ${[...new Set(observation.lostAfter)].join(',')}]` : '') +
              ` (${observation.elapsedMs} ms)`
            );
            if (problem) {
              const messages = [...new Set(observation.messages ?? [])].filter(Boolean);
              problems.push(
                `${language} ${observation.mode} ${observation.probe}: ${problem}` +
                (messages.length ? ` messages=${JSON.stringify(messages)}` : '')
              );
            }
          }
        } catch (error) {
          problems.push(`${language}: run failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
    if (controlHits !== 1) problems.push('G3/lost-worker/control: no passing live receipt to mutate');
    if (problems.length) {
      console.error(`\n${problems.length} lost-worker check(s) failed:`);
      for (const problem of problems) console.error(`- ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log('Lost-worker provider-origin checks passed.');
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
