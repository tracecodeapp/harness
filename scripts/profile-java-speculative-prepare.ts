#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserServer,
  type BrowserType,
  type Page,
} from 'playwright';
import type { RuntimeExecutionTimings } from '../packages/runtime-contracts/src';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

interface Args {
  engines: BrowserEngine[];
  revisions: number;
  cpuRate: number;
  isolated: boolean;
  settleMs: number;
  sampleMs: number;
  headful: boolean;
  output?: string;
}

interface ProcessSnapshot {
  at: number;
  rootPid: number;
  processCount: number;
  rssBytes: number;
  cpuPercent: number;
}

interface SampledPhase<Result> {
  result: Result;
  before: ProcessSnapshot;
  after: ProcessSnapshot;
  peak: ProcessSnapshot;
  samples: ProcessSnapshot[];
}

interface BrowserMemorySnapshot {
  readonly performanceMemory?: {
    readonly usedJSHeapSize: number;
    readonly totalJSHeapSize: number;
    readonly jsHeapSizeLimit: number;
  };
  readonly userAgentSpecificMemory?: {
    readonly bytes: number;
    readonly breakdown: ReadonlyArray<{
      readonly bytes: number;
      readonly types: readonly string[];
    }>;
  };
  readonly userAgentSpecificMemoryError?: string;
}

interface ResponsivenessProfile {
  wallMs: number;
  intervalSamples: number;
  maxTimerDelayMs: number;
  p95TimerDelayMs: number;
  longTaskSupported: boolean;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
}

interface PreparationResult {
  timings?: RuntimeExecutionTimings;
  responsiveness: ResponsivenessProfile;
}

interface ExecutionResult {
  success: boolean;
  outputs: unknown[];
  eventCounts: number[];
  timings: Array<RuntimeExecutionTimings | undefined>;
  responsiveness: ResponsivenessProfile;
}

interface PhaseCheckpoint {
  process: ProcessSnapshot;
  browserMemory: BrowserMemorySnapshot;
}

interface PhysicalFootprintSnapshot {
  readonly scenario: 'cold' | 'warm' | 'prepared' | 'disposed';
  readonly rendererPid: number;
  readonly rendererRssBytes: number;
  readonly currentBytes: number;
  readonly peakBytes: number;
}

interface EngineReport {
  schema: 'tracecode.java-speculative-prepare-profile.v1';
  engine: BrowserEngine;
  cpuRate: number;
  isolated: boolean;
  revisions: number;
  environment: Record<string, unknown>;
  checkpoints: Record<string, PhaseCheckpoint>;
  init: SampledPhase<{
    result: { success: boolean; loadTimeMs: number };
    responsiveness: ResponsivenessProfile;
  }>;
  abandoned: {
    prepare: SampledPhase<PreparationResult>;
    prepared: PhaseCheckpoint;
    disposed: PhaseCheckpoint;
  };
  prepareThenRun: {
    prepare: SampledPhase<PreparationResult>;
    execute: SampledPhase<ExecutionResult>;
    disposed: PhaseCheckpoint;
  };
  churn: Array<{
    revision: number;
    prepare: SampledPhase<PreparationResult>;
    afterDispose: ProcessSnapshot;
    browserMemory: BrowserMemorySnapshot;
  }>;
  summary: Record<string, number | null>;
}

const browserTypes: Record<BrowserEngine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    engines: ['chromium'],
    revisions: 20,
    cpuRate: 1,
    isolated: false,
    settleMs: 1_500,
    sampleMs: 50,
    headful: false,
  };
  for (const token of argv) {
    const [name, rawValue = ''] = token.split('=', 2);
    if (name === '--engines') {
      const engines = rawValue.split(',').filter(Boolean) as BrowserEngine[];
      if (
        engines.length === 0 ||
        engines.some((engine) => !(engine in browserTypes))
      ) {
        throw new Error(`Invalid browser engine list: ${rawValue}`);
      }
      args.engines = engines;
    } else if (name === '--revisions') {
      args.revisions = positiveInteger(rawValue, name);
    } else if (name === '--cpu-rate') {
      args.cpuRate = positiveNumber(rawValue, name);
    } else if (name === '--settle-ms') {
      args.settleMs = nonNegativeInteger(rawValue, name);
    } else if (name === '--sample-ms') {
      args.sampleMs = positiveInteger(rawValue, name);
    } else if (name === '--isolated') {
      args.isolated = rawValue === 'true';
    } else if (name === '--headful') {
      args.headful = rawValue === 'true';
    } else if (name === '--output') {
      args.output = resolve(rawValue);
    } else if (name === '--help') {
      console.log([
        'Usage: pnpm profile:java-speculative [options]',
        '  --engines=chromium,firefox,webkit',
        '  --revisions=20',
        '  --cpu-rate=1          Chromium only; DevTools CPU throttling multiplier.',
        '  --isolated=false      Enables COOP/COEP and detailed Chromium memory.',
        '  --settle-ms=1500',
        '  --sample-ms=50',
        '  --headful=false',
        '  --output=reports/java-speculative-profile.json',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.cpuRate !== 1 && args.engines.some((engine) => engine !== 'chromium')) {
    throw new Error('DevTools CPU throttling is only available for Chromium profiles.');
  }
  return args;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a number greater than or equal to one.`);
  }
  return parsed;
}

function contentType(path: string): string {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.jar')) return 'application/java-archive';
  return 'application/octet-stream';
}

function resolveTraceJVMRoot(): string {
  const configured = process.env.TRACECODE_TRACEJVM_ROOT;
  const candidates = configured
    ? [resolve(configured)]
    : [resolve('../tracejvm'), resolve('../../tracejvm')];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, 'dist/browser-client.js'))
  );
  if (!root) {
    throw new Error(
      `Could not locate TraceJVM. Checked: ${candidates.join(', ')}. ` +
      'Set TRACECODE_TRACEJVM_ROOT to its repository root.'
    );
  }
  return root;
}

function safeFile(root: string, relative: string): string | undefined {
  const path = normalize(join(root, relative));
  if (!path.startsWith(`${normalize(root)}${sep}`)) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function processSnapshot(rootPid: number): ProcessSnapshot {
  const output = execFileSync(
    'ps',
    ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='],
    { encoding: 'utf8' }
  );
  const rows = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    return match
      ? [{
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssKiB: Number(match[3]),
          cpuPercent: Number(match[4]),
        }]
      : [];
  });
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  const included = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (included.has(pid)) continue;
    included.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  const selected = rows.filter((row) => included.has(row.pid));
  return {
    at: Date.now(),
    rootPid,
    processCount: selected.length,
    rssBytes: selected.reduce((sum, row) => sum + row.rssKiB * 1024, 0),
    cpuPercent: selected.reduce((sum, row) => sum + row.cpuPercent, 0),
  };
}

function parseVmmapBytes(value: string, unit: string): number {
  const multiplier = unit === 'G'
    ? 1024 ** 3
    : unit === 'M'
      ? 1024 ** 2
      : unit === 'K'
        ? 1024
        : 1;
  return Number(value) * multiplier;
}

function captureLargestRendererFootprint(
  rootPid: number,
  scenario: PhysicalFootprintSnapshot['scenario']
): PhysicalFootprintSnapshot {
  const output = execFileSync(
    'ps',
    ['-axo', 'pid=,ppid=,rss=,command='],
    { encoding: 'utf8' }
  );
  const rows = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match
      ? [{
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssBytes: Number(match[3]) * 1024,
          command: match[4] ?? '',
        }]
      : [];
  });
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        (row.ppid === rootPid || descendants.has(row.ppid)) &&
        !descendants.has(row.pid)
      ) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const renderer = rows
    .filter((row) =>
      descendants.has(row.pid) && row.command.includes('--type=renderer')
    )
    .sort((left, right) => right.rssBytes - left.rssBytes)[0];
  if (!renderer) throw new Error(`No Chromium renderer found for ${scenario}.`);
  const vmmap = execFileSync('/usr/bin/vmmap', ['-summary', String(renderer.pid)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const current = /Physical footprint:\s+([\d.]+)([KMG]?)/.exec(vmmap);
  const peak = /Physical footprint \(peak\):\s+([\d.]+)([KMG]?)/.exec(vmmap);
  if (!current || !peak) {
    throw new Error(`Could not parse Chromium ${scenario} physical footprint.`);
  }
  return {
    scenario,
    rendererPid: renderer.pid,
    rendererRssBytes: renderer.rssBytes,
    currentBytes: parseVmmapBytes(current[1]!, current[2]!),
    peakBytes: parseVmmapBytes(peak[1]!, peak[2]!),
  };
}

async function sampled<Result>(
  rootPid: number,
  sampleMs: number,
  operation: () => Promise<Result>
): Promise<SampledPhase<Result>> {
  const samples = [processSnapshot(rootPid)];
  const timer = setInterval(() => {
    try {
      samples.push(processSnapshot(rootPid));
    } catch {
      // A browser process may be between generations while a sample lands.
    }
  }, sampleMs);
  try {
    const result = await operation();
    const after = processSnapshot(rootPid);
    samples.push(after);
    const peak = samples.reduce((largest, current) =>
      current.rssBytes > largest.rssBytes ? current : largest
    );
    return { result, before: samples[0]!, after, peak, samples };
  } finally {
    clearInterval(timer);
  }
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function numberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function delta(left: number, right: number): number {
  return left - right;
}

function summarize(report: Omit<EngineReport, 'summary'>): EngineReport['summary'] {
  const warmedRss = report.checkpoints.warmed.process.rssBytes;
  const prepareWall = report.churn.map((item) => item.prepare.result.responsiveness.wallMs);
  const rewrite = report.churn.flatMap((item) => {
    const value = numberField(item.prepare.result.timings, 'rewriteMs');
    return value === undefined ? [] : [value];
  });
  const compile = report.churn.flatMap((item) => {
    const value = numberField(item.prepare.result.timings, 'compileMs');
    return value === undefined ? [] : [value];
  });
  const timerP95 = report.churn.map((item) => item.prepare.result.responsiveness.p95TimerDelayMs);
  const timerMax = report.churn.map((item) => item.prepare.result.responsiveness.maxTimerDelayMs);
  const peakRss = Math.max(
    report.abandoned.prepare.peak.rssBytes,
    report.prepareThenRun.prepare.peak.rssBytes,
    report.prepareThenRun.execute.peak.rssBytes,
    ...report.churn.map((item) => item.prepare.peak.rssBytes)
  );
  return {
    warmCompilerRssDeltaBytes: delta(warmedRss, report.checkpoints.beforeInit.process.rssBytes),
    retainedPreparationRssDeltaBytes: delta(report.abandoned.prepared.process.rssBytes, warmedRss),
    abandonedAfterDisposeRssDeltaBytes: delta(report.abandoned.disposed.process.rssBytes, warmedRss),
    churnAfterDisposeRssDeltaBytes: delta(report.checkpoints.afterChurn.process.rssBytes, warmedRss),
    peakRssDeltaBytes: delta(peakRss, warmedRss),
    medianPrepareWallMs: median(prepareWall),
    medianRewriteMs: median(rewrite),
    medianCompileMs: median(compile),
    medianPrepareP95TimerDelayMs: median(timerP95),
    maxPrepareTimerDelayMs: timerMax.length > 0 ? Math.max(...timerMax) : null,
    executeWallMs: report.prepareThenRun.execute.result.responsiveness.wallMs,
    executePeakRssDeltaBytes: delta(report.prepareThenRun.execute.peak.rssBytes, warmedRss),
  };
}

async function browserMemory(page: Page, detailed: boolean): Promise<BrowserMemorySnapshot> {
  return page.evaluate((withBreakdown) =>
    globalThis.javaSpeculativePrepareProfile!.snapshotMemory(withBreakdown),
  detailed);
}

async function checkpoint(
  page: Page,
  rootPid: number,
  detailedMemory: boolean
): Promise<PhaseCheckpoint> {
  return {
    process: processSnapshot(rootPid),
    browserMemory: await browserMemory(page, detailedMemory),
  };
}

async function startBrowser(
  engine: BrowserEngine,
  args: Args
): Promise<{ server: BrowserServer; browser: Browser; rootPid: number }> {
  const browserServer = await browserTypes[engine].launchServer({
    headless: !args.headful,
    ...(engine === 'chromium' && !args.isolated
      ? { args: ['--enable-precise-memory-info'] }
      : {}),
  });
  const browser = await browserTypes[engine].connect(browserServer.wsEndpoint());
  const rootPid = browserServer.process().pid;
  if (!rootPid) throw new Error(`${engine} browser process did not expose a pid.`);
  return { server: browserServer, browser, rootPid };
}

async function runEngine(
  engine: BrowserEngine,
  args: Args,
  origin: string
): Promise<EngineReport> {
  const launched = await startBrowser(engine, args);
  const { server: browserServer, browser, rootPid } = launched;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const rendered = `[console] ${message.text()}`;
        browserErrors.push(rendered);
        console.error(`${engine}: ${rendered}`);
      }
    });
    page.on('pageerror', (error) => {
      const rendered = `[pageerror] ${error.message}`;
      browserErrors.push(rendered);
      console.error(`${engine}: ${rendered}`);
    });
    await page.goto(`${origin}/?isolated=${args.isolated}`);
    await page.waitForFunction(() => Boolean(globalThis.javaSpeculativePrepareProfile));
    if (engine === 'chromium' && args.cpuRate !== 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.cpuRate });
    }
    const detailedMemory = engine === 'chromium' && args.isolated;
    const environment = await page.evaluate(() =>
      globalThis.javaSpeculativePrepareProfile!.environment()
    );
    const checkpoints: Record<string, PhaseCheckpoint> = {
      // Measuring agent-specific memory before the Java module worker starts can
      // perturb Chromium's first worker generation. OS RSS remains the cold baseline.
      beforeInit: await checkpoint(page, rootPid, false),
    };
    console.log(`${engine}: warming compiler (${args.cpuRate}x CPU, ${args.isolated ? 'isolated' : 'ordinary'})`);
    const init = await sampled(rootPid, args.sampleMs, () =>
      page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.init())
    );
    if (!init.result.result.success) throw new Error(`${engine}: Java warmup failed.`);
    await delay(args.settleMs);
    checkpoints.warmed = await checkpoint(page, rootPid, detailedMemory);

    console.log(`${engine}: profiling an abandoned preparation`);
    const abandonedPrepare = await sampled(rootPid, args.sampleMs, () =>
      page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.prepare('abandoned'))
    );
    const abandonedPrepared = await checkpoint(page, rootPid, detailedMemory);
    await page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.disposePrepared());
    await delay(args.settleMs);
    const abandonedDisposed = await checkpoint(page, rootPid, detailedMemory);

    console.log(`${engine}: profiling prepare followed by the ten-case batch`);
    const usedPrepare = await sampled(rootPid, args.sampleMs, () =>
      page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.prepare('used'))
    );
    const execute = await sampled(rootPid, args.sampleMs, () =>
      page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.execute())
    );
    if (!execute.result.success || execute.result.outputs.length !== 10) {
      throw new Error(`${engine}: prepared Java batch did not complete all ten cases.`);
    }
    await page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.disposePrepared());
    await delay(args.settleMs);
    const usedDisposed = await checkpoint(page, rootPid, detailedMemory);

    const churn: EngineReport['churn'] = [];
    for (let revision = 1; revision <= args.revisions; revision += 1) {
      console.log(`${engine}: abandoned revision ${revision}/${args.revisions}`);
      const prepare = await sampled(rootPid, args.sampleMs, () =>
        page.evaluate((value) =>
          globalThis.javaSpeculativePrepareProfile!.prepare(`churn-${value}`),
        revision)
      );
      await page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.disposePrepared());
      churn.push({
        revision,
        prepare,
        afterDispose: processSnapshot(rootPid),
        browserMemory: await browserMemory(page, false),
      });
    }
    await delay(args.settleMs);
    checkpoints.afterChurn = await checkpoint(page, rootPid, detailedMemory);

    await page.evaluate(() => globalThis.javaSpeculativePrepareProfile!.shutdown());
    await delay(args.settleMs);
    checkpoints.afterShutdown = await checkpoint(page, rootPid, detailedMemory);
    if (browserErrors.length > 0) {
      throw new Error(`${engine} browser errors:\n${browserErrors.join('\n')}`);
    }

    const reportWithoutSummary: Omit<EngineReport, 'summary'> = {
      schema: 'tracecode.java-speculative-prepare-profile.v1',
      engine,
      cpuRate: args.cpuRate,
      isolated: args.isolated,
      revisions: args.revisions,
      environment,
      checkpoints,
      init,
      abandoned: {
        prepare: abandonedPrepare,
        prepared: abandonedPrepared,
        disposed: abandonedDisposed,
      },
      prepareThenRun: {
        prepare: usedPrepare,
        execute,
        disposed: usedDisposed,
      },
      churn,
    };
    return {
      ...reportWithoutSummary,
      summary: summarize(reportWithoutSummary),
    };
  } finally {
    await browser.close().catch(() => undefined);
    await browserServer.close().catch(() => undefined);
  }
}

async function runPhysicalFootprintScenario(
  scenario: PhysicalFootprintSnapshot['scenario'],
  args: Args,
  origin: string
): Promise<PhysicalFootprintSnapshot> {
  const launched = await startBrowser('chromium', args);
  const { server, browser, rootPid } = launched;
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/?isolated=${args.isolated}`);
    await page.waitForFunction(() => Boolean(globalThis.javaSpeculativePrepareProfile));
    if (scenario !== 'cold') {
      const init = await page.evaluate(() =>
        globalThis.javaSpeculativePrepareProfile!.init()
      );
      if (!init.result.success) throw new Error('Java physical-profile warmup failed.');
    }
    if (scenario === 'prepared' || scenario === 'disposed') {
      await page.evaluate(() =>
        globalThis.javaSpeculativePrepareProfile!.prepare('physical-footprint')
      );
    }
    if (scenario === 'disposed') {
      await page.evaluate(() =>
        globalThis.javaSpeculativePrepareProfile!.disposePrepared()
      );
    }
    await delay(args.settleMs);
    const footprint = captureLargestRendererFootprint(rootPid, scenario);
    await page.evaluate(() =>
      globalThis.javaSpeculativePrepareProfile!.shutdown()
    );
    return footprint;
  } finally {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const traceJVMRoot = resolveTraceJVMRoot();
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'java-speculative-prepare-profile-')
  );
  const bundlePath = join(temporaryDirectory, 'profile.js');
  let staticServer: ReturnType<typeof createServer> | undefined;

  try {
  await build({
    entryPoints: [
      resolve('tests/fixtures/java-speculative-prepare-profile-browser-entry.ts'),
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const staticRoutes = new Map<string, string>([
    ['/workers/java-runtime-worker.js', resolve('workers/java/java-runtime-worker.js')],
    ['/workers/java-worker.js', resolve('workers/java/java-worker.js')],
    ['/workers/java-source-augmentations.js', resolve('workers/java/java-source-augmentations.js')],
    ['/workers/shared/tracekernel-syscall-client.js', resolve('workers/shared/tracekernel-syscall-client.js')],
    ['/workers/shared/tracekernel-local-java-host.js', resolve('workers/shared/tracekernel-local-java-host.js')],
    ['/workers/shared/runtime-kernel-policy-classic.js', resolve('workers/shared/runtime-kernel-policy-classic.js')],
    ['/workers/vendor/java-browser-helper.jar', resolve('workers/vendor/java-browser-helper.jar')],
  ]);
  staticServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (args.isolated) {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname === '/profile.js') {
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.end(readFileSync(bundlePath));
      return;
    }
    const staticPath = staticRoutes.get(url.pathname);
    if (staticPath) {
      response.setHeader('content-type', contentType(staticPath));
      response.end(readFileSync(staticPath));
      return;
    }
    if (url.pathname.startsWith('/tracejvm/')) {
      const requested = url.pathname.slice('/tracejvm/'.length);
      const relative = requested === 'browser-client.js'
        ? 'dist/browser-client.js'
        : requested === 'browser-worker.js'
          ? 'dist/browser-worker.js'
          : requested.startsWith('compiler/')
            ? `.cache/teavm-javac/artifacts/${requested.slice('compiler/'.length)}`
          : `runtime/assets/${requested}`;
      const path = safeFile(traceJVMRoot, relative);
      if (!path) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('content-type', contentType(path));
      response.end(readFileSync(path));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta charset="utf-8"><title>Java speculative prepare profile</title><script src="/profile.js"></script>');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    staticServer!.once('error', rejectListen);
    staticServer!.listen(0, '127.0.0.1', resolveListen);
  });
  const address = staticServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Java speculative profile server did not bind.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const reports: EngineReport[] = [];
  for (const engine of args.engines) {
    reports.push(await runEngine(engine, args, origin));
  }
  const physicalFootprints: PhysicalFootprintSnapshot[] = [];
  if (process.platform === 'darwin' && args.engines.includes('chromium')) {
    for (const scenario of ['cold', 'warm', 'prepared', 'disposed'] as const) {
      console.log(`chromium: measuring ${scenario} renderer physical footprint`);
      physicalFootprints.push(
        await runPhysicalFootprintScenario(scenario, args, origin)
      );
    }
  }
  const coldFootprint = physicalFootprints.find((item) => item.scenario === 'cold');
  const warmFootprint = physicalFootprints.find((item) => item.scenario === 'warm');
  const preparedFootprint = physicalFootprints.find(
    (item) => item.scenario === 'prepared'
  );
  const disposedFootprint = physicalFootprints.find(
    (item) => item.scenario === 'disposed'
  );
  const output = {
    schema: 'tracecode.java-speculative-prepare-campaign.v1',
    createdAt: new Date().toISOString(),
    args,
    reports,
    physicalMemory: {
      methodology: 'fresh-largest-renderer-vmmap-summary',
      scenarios: physicalFootprints,
      warmCurrentDeltaBytes:
        coldFootprint && warmFootprint
          ? warmFootprint.currentBytes - coldFootprint.currentBytes
          : null,
      preparedCurrentDeltaBytes:
        warmFootprint && preparedFootprint
          ? preparedFootprint.currentBytes - warmFootprint.currentBytes
          : null,
      disposedCurrentDeltaBytes:
        warmFootprint && disposedFootprint
          ? disposedFootprint.currentBytes - warmFootprint.currentBytes
          : null,
    },
  };
    if (args.output) {
      mkdirSync(dirname(args.output), { recursive: true });
      writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    }
  console.log(JSON.stringify({
    output: args.output,
    reports: reports.map((report) => ({
      engine: report.engine,
      cpuRate: report.cpuRate,
      isolated: report.isolated,
      summary: report.summary,
    })),
    physicalMemory: output.physicalMemory,
  }, null, 2));
  } finally {
    if (staticServer) {
      await new Promise<void>((resolveClose) => staticServer!.close(() => resolveClose()));
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
