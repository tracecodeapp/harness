#!/usr/bin/env node
/**
 * Correct-program time per language and action (Run, Submit, traced Submit,
 * Submit with stopAtFirstRunaway) through the public BrowserJudgeHost, compared
 * with a recorded baseline (0.19.0 on the same machine), so stopping semantics
 * cannot make a correct program slower unnoticed.
 *
 * - TRACECODE_TIMING_LANGUAGES=python,java   restrict languages
 * - TRACECODE_TIMING_REPEATS=5               warm repeats per action (default 5)
 * - TRACECODE_TIMING_CASES=10                cases per evaluation (default 10)
 * - TRACECODE_TIMING_REPORT=out.json         write the samples
 * - TRACECODE_TIMING_BASELINE_ROOT=dir       a checkout of the baseline release (0.19.0)
 *                                            with this file and its entry copied in:
 *                                            measured in the same run, interleaved
 *                                            (baseline, current, current, baseline),
 *                                            so both share the machine's state. This
 *                                            is the comparison the gate trusts.
 * - TRACECODE_TIMING_BASELINE=file.json      otherwise, compare with a saved report
 *                                            (default: the checked-in 0.19.0 numbers,
 *                                            which are machine- and load-specific and
 *                                            therefore only reported, never enforced)
 * - TRACECODE_TIMING_RECORD_ONLY=1           print, never fail
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { runCommand } from './example-app-smoke';
import { loadEngineRuntimePackages } from '../scripts/runtime-package-assets.mjs';
import type { TimingAction, TimingLanguage, TimingSample } from './fixtures/correct-program-timing-entry';

const ALL_LANGUAGES: readonly TimingLanguage[] = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
const LANGUAGES = (process.env.TRACECODE_TIMING_LANGUAGES?.split(',').map((value) => value.trim()).filter(Boolean)
  ?? ALL_LANGUAGES) as TimingLanguage[];
const REPEATS = Number(process.env.TRACECODE_TIMING_REPEATS ?? 5);
const CASES = Number(process.env.TRACECODE_TIMING_CASES ?? 10);
const DEFAULT_BASELINE = resolve('tests/fixtures/correct-program-timing-baseline-0.19.0.json');
const BASELINE = process.env.TRACECODE_TIMING_BASELINE ?? DEFAULT_BASELINE;
const RECORD_ONLY = process.env.TRACECODE_TIMING_RECORD_ONLY === '1';
// A regression is a warm median this much slower than the baseline's: both a
// ratio and an absolute floor, so millisecond noise on fast languages does not
// fail the gate while a per-request regression does.
const MAX_RATIO = 1.3;
const MIN_REGRESSION_MS = 150;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
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
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Timing server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    }),
  };
}

async function measure(root: string): Promise<TimingSample[]> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-correct-program-timing-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await runCommand(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'sync-assets', join(tempRoot, 'workers'), '--languages', LANGUAGES.join(',')],
      root
    );
    if (LANGUAGES.includes('cpp')) {
      const { tracecc } = await loadEngineRuntimePackages(root);
      await symlink(tracecc.sourceRoot, join(tempRoot, 'tracecc'), 'dir');
    }
    await build({
      absWorkingDir: root,
      entryPoints: [join(root, 'tests/fixtures/correct-program-timing-entry.ts')],
      outfile: join(tempRoot, 'timing.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2022'],
      alias: {
        zlib: join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
        'node:zlib': join(root, 'packages/tracekernel/src/zlib-browser-shim.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">\n', 'utf8');
    server = await startServer(resolve(tempRoot));
    const browser = await chromium.launch({ headless: true });
    const samples: TimingSample[] = [];
    try {
      for (const language of LANGUAGES) {
        const page = await browser.newPage();
        page.setDefaultTimeout(30 * 60_000);
        page.on('pageerror', (error) => console.error(`[${language} pageerror] ${error.message}`));
        await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
        const languageSamples = (await page.evaluate(async (options) => {
          const moduleUrl: string = '/timing.mjs';
          const module = await import(moduleUrl);
          return module.runTiming(options);
        }, { assetBaseUrl: '/workers', language, caseCount: CASES, repeats: REPEATS })) as TimingSample[];
        samples.push(...languageSamples);
        await page.close();
      }
    } finally {
      await browser.close();
    }
    return samples;
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Pools rounds of the same build: every warm sample, the median cold time. */
function pool(rounds: readonly (readonly TimingSample[])[]): TimingSample[] {
  const pooled = new Map<string, TimingSample[]>();
  for (const round of rounds) {
    for (const sample of round) {
      const key = `${sample.language}:${sample.action}`;
      pooled.set(key, [...(pooled.get(key) ?? []), sample]);
    }
  }
  return [...pooled.values()].map((samples) => ({
    ...samples[0]!,
    coldMs: median(samples.map((sample) => sample.coldMs)),
    warmMs: samples.flatMap((sample) => sample.warmMs),
    completedCases: Math.min(...samples.map((sample) => sample.completedCases)),
  }));
}

async function main(): Promise<void> {
  const baselineRoot = process.env.TRACECODE_TIMING_BASELINE_ROOT
    ? resolve(process.env.TRACECODE_TIMING_BASELINE_ROOT)
    : undefined;
  const current = resolve('.');
  let samples: TimingSample[];
  let baseline: TimingSample[];
  let enforce = !RECORD_ONLY;
  let baselineLabel: string;
  if (baselineRoot) {
    const baselineRounds: TimingSample[][] = [];
    const currentRounds: TimingSample[][] = [];
    // Interleaved, so drift in the machine's load affects both builds alike.
    baselineRounds.push(await measure(baselineRoot));
    currentRounds.push(await measure(current));
    currentRounds.push(await measure(current));
    baselineRounds.push(await measure(baselineRoot));
    samples = pool(currentRounds);
    baseline = pool(baselineRounds);
    baselineLabel = `${baselineRoot} (same run, interleaved)`;
    if (process.env.TRACECODE_TIMING_BASELINE_REPORT) {
      await writeFile(resolve(process.env.TRACECODE_TIMING_BASELINE_REPORT), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    }
  } else {
    samples = await measure(current);
    baseline = existsSync(BASELINE)
      ? (JSON.parse(await readFile(BASELINE, 'utf8')) as TimingSample[])
      : [];
    baselineLabel = existsSync(BASELINE) ? BASELINE : 'no baseline';
    // A saved report was measured under another load: report, never enforce,
    // unless a specific report was chosen explicitly.
    if (!process.env.TRACECODE_TIMING_BASELINE) enforce = false;
  }
  if (process.env.TRACECODE_TIMING_REPORT) {
    await writeFile(resolve(process.env.TRACECODE_TIMING_REPORT), `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
  }
  const baselineOf = (language: TimingLanguage, action: TimingAction) =>
    baseline.find((sample) => sample.language === language && sample.action === action);

  const failures: string[] = [];
  console.log(`\n| language | action | cold ms | warm median ms | baseline warm ms | ratio | completed |`);
  console.log('|---|---|---:|---:|---:|---:|---:|');
  for (const sample of samples) {
    const warm = median(sample.warmMs);
    const base = baselineOf(sample.language, sample.action);
    const baseWarm = base ? median(base.warmMs) : Number.NaN;
    const ratio = Number.isFinite(baseWarm) && baseWarm > 0 ? warm / baseWarm : Number.NaN;
    console.log(
      `| ${sample.language} | ${sample.action} | ${Math.round(sample.coldMs)} | ${Math.round(warm)} | ` +
        `${Number.isFinite(baseWarm) ? Math.round(baseWarm) : '—'} | ${Number.isFinite(ratio) ? ratio.toFixed(2) : '—'} | ` +
        `${sample.completedCases}/${sample.caseCount} |`
    );
    if (sample.completedCases !== sample.caseCount) {
      failures.push(`${sample.language}/${sample.action}: ${sample.completedCases}/${sample.caseCount} cases completed`);
    }
    if (Number.isFinite(baseWarm) && warm > baseWarm * MAX_RATIO && warm - baseWarm > MIN_REGRESSION_MS) {
      failures.push(
        `${sample.language}/${sample.action}: warm median ${Math.round(warm)} ms against the baseline's ` +
          `${Math.round(baseWarm)} ms (over ${MAX_RATIO}x and ${MIN_REGRESSION_MS} ms slower)`
      );
    }
  }
  if (failures.length > 0) {
    console.log(
      `\nCorrect-program timing regressions against ${baselineLabel}` +
        `${enforce ? '' : ' (reported, not enforced)'}:\n${failures.map((line) => `  ${line}`).join('\n')}`
    );
    if (enforce) process.exitCode = 1;
    return;
  }
  console.log(`\nCorrect-program timing: ${samples.length} measurements, no regression against ${baselineLabel}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
