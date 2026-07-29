#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

interface ProviderFixture {
  rawEvents: string[];
  trace: unknown;
  output?: unknown;
  executionTimeMs?: number;
  timings?: unknown;
  traceLimitExceeded?: boolean;
  droppedEventCount?: number;
}

interface ProviderReport {
  schema: 'tracecode.java-trace-provider-report.v1';
  provider: 'cheerpj' | 'tracejvm';
  fixtures: Record<string, ProviderFixture>;
  errors?: Record<string, string>;
}

interface FixtureDifference {
  fixture: string;
  rawEventsEqual: boolean;
  normalizedTraceEqual: boolean;
  outputEqual: boolean;
  cheerpJ: ProviderFixture;
  traceJVM: ProviderFixture;
}

function runProvider(
  provider: ProviderReport['provider'],
  reportPath: string,
  fixtures?: readonly string[],
): number {
  const startedAt = performance.now();
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'tests/test-runtime-trace-fixtures.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRACECODE_RUNTIME_TRACE_LANGUAGES: 'java',
        TRACECODE_JAVA_TRACE_PROVIDER: provider,
        TRACECODE_JAVA_TRACE_REPORT: reportPath,
        ...(fixtures ? { TRACECODE_RUNTIME_TRACE_FIXTURE: fixtures.join(',') } : {}),
        ...(provider === 'cheerpj'
          ? { TRACECODE_CHEERPJ_BROWSER: 'chromium' }
          : { TRACECODE_TRACEJVM_BROWSER: 'chromium' }),
      },
      stdio: 'inherit',
      timeout: Number.parseInt(
        process.env.TRACECODE_JAVA_TRACE_PROVIDER_PROCESS_TIMEOUT_MS ?? '180000',
        10,
      ),
      killSignal: 'SIGKILL',
    },
  );
  if (result.error) {
    throw new Error(
      `${provider} semantic trace fixture run failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${provider} semantic trace fixture run ${
        result.signal ? `ended with ${result.signal}` : `exited ${result.status}`
      }.`,
    );
  }
  return performance.now() - startedAt;
}

function readReport(path: string): ProviderReport {
  const report = JSON.parse(readFileSync(path, 'utf8')) as ProviderReport;
  if (report.schema !== 'tracecode.java-trace-provider-report.v1') {
    throw new Error(`Unsupported Java trace provider report at ${path}.`);
  }
  return report;
}

function javaFixtureNames(): string[] {
  const fixtureRoot = resolve('fixtures/runtime-parity');
  const configuredFixtures = new Set(
    (process.env.TRACECODE_RUNTIME_TRACE_FIXTURE ?? '')
      .split(',')
      .map((fixture) => fixture.trim())
      .filter(Boolean),
  );
  return readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((fixture) => {
      if (configuredFixtures.size > 0 && !configuredFixtures.has(fixture)) {
        return false;
      }
      const definition = JSON.parse(
        readFileSync(join(fixtureRoot, fixture, 'case.json'), 'utf8'),
      ) as { languages?: string[] };
      return definition.languages === undefined || definition.languages.includes('java');
    })
    .sort();
}

function fixtureReportId(fixture: string): string {
  const definition = JSON.parse(
    readFileSync(join(resolve('fixtures/runtime-parity'), fixture, 'case.json'), 'utf8'),
  ) as { id?: string };
  return definition.id ?? fixture;
}

function runProviderInFreshChunks(
  provider: ProviderReport['provider'],
  temporaryDirectory: string,
  fixtures: readonly string[],
  chunkSizeEnvironmentVariable: string,
): { report: ProviderReport; elapsedMs: number; chunkCount: number } {
  const configuredChunkSize = Number(
    process.env[chunkSizeEnvironmentVariable] ?? 16,
  );
  if (!Number.isSafeInteger(configuredChunkSize) || configuredChunkSize <= 0) {
    throw new Error(`${chunkSizeEnvironmentVariable} must be positive.`);
  }
  const merged: ProviderReport = {
    schema: 'tracecode.java-trace-provider-report.v1',
    provider,
    fixtures: {},
    errors: {},
  };
  const preseedDirectory = process.env.TRACECODE_JAVA_TRACE_PRESEEDED_REPORT_DIR;
  if (preseedDirectory) {
    for (const name of readdirSync(resolve(preseedDirectory)).sort()) {
      if (!name.startsWith(`${provider}-`) || !name.endsWith('.json')) continue;
      const report = readReport(join(resolve(preseedDirectory), name));
      if (report.provider !== provider) continue;
      Object.assign(merged.fixtures, report.fixtures);
      Object.assign(merged.errors!, report.errors ?? {});
    }
  }
  let elapsedMs = 0;
  let chunkCount = 0;

  function runChunk(chunk: readonly string[], label: string): void {
    const reportPath = join(temporaryDirectory, `${provider}-${label}.json`);
    try {
      elapsedMs += runProvider(provider, reportPath, chunk);
      chunkCount += 1;
      Object.assign(merged.fixtures, readReport(reportPath).fixtures);
    } catch (error) {
      if (chunk.length > 1) {
        const midpoint = Math.ceil(chunk.length / 2);
        runChunk(chunk.slice(0, midpoint), `${label}-left`);
        runChunk(chunk.slice(midpoint), `${label}-right`);
        return;
      }
      const fixture = chunk[0];
      if (!fixture) return;
      merged.errors![fixtureReportId(fixture)] =
        error instanceof Error ? error.message : String(error);
    }
  }

  const pendingFixtures = fixtures.filter((fixture) => {
    const id = fixtureReportId(fixture);
    return !merged.fixtures[id] && !merged.errors?.[id];
  });
  for (let start = 0; start < pendingFixtures.length; start += configuredChunkSize) {
    runChunk(pendingFixtures.slice(start, start + configuredChunkSize), String(start));
  }
  return { report: merged, elapsedMs, chunkCount };
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'java-trace-provider-diff-'));
try {
  const fixtures = javaFixtureNames();
  const cheerpJRun = runProviderInFreshChunks(
    'cheerpj',
    temporaryDirectory,
    fixtures,
    'TRACECODE_CHEERPJ_DIFFERENTIAL_CHUNK_SIZE',
  );
  const cheerpJ = cheerpJRun.report;
  const traceJVMRun = runProviderInFreshChunks(
    'tracejvm',
    temporaryDirectory,
    fixtures,
    'TRACECODE_TRACEJVM_DIFFERENTIAL_CHUNK_SIZE',
  );
  const traceJVM = traceJVMRun.report;
  const fixtureNames = [...new Set([
    ...Object.keys(cheerpJ.fixtures),
    ...Object.keys(traceJVM.fixtures),
    ...Object.keys(cheerpJ.errors ?? {}),
    ...Object.keys(traceJVM.errors ?? {}),
  ])].sort();
  const missing = fixtureNames.filter(
    (fixture) =>
      (!cheerpJ.fixtures[fixture] && !cheerpJ.errors?.[fixture]) ||
      (!traceJVM.fixtures[fixture] && !traceJVM.errors?.[fixture]),
  );
  const providerFailureFixtures = new Set([
    ...Object.keys(cheerpJ.errors ?? {}),
    ...Object.keys(traceJVM.errors ?? {}),
  ]);
  const differences: FixtureDifference[] = [];
  for (const fixture of fixtureNames) {
    const left = cheerpJ.fixtures[fixture];
    const right = traceJVM.fixtures[fixture];
    if (!left || !right) continue;
    const difference = {
      fixture,
      rawEventsEqual: isDeepStrictEqual(left.rawEvents, right.rawEvents),
      normalizedTraceEqual: isDeepStrictEqual(left.trace, right.trace),
      outputEqual: isDeepStrictEqual(left.output, right.output),
      cheerpJ: left,
      traceJVM: right,
    };
    if (
      !difference.rawEventsEqual ||
      !difference.normalizedTraceEqual ||
      !difference.outputEqual
    ) {
      differences.push(difference);
    }
  }

  const report = {
    schema: 'tracecode.java-trace-provider-differential.v1',
    comparedFixtures: fixtureNames.length,
    exactMatches:
      fixtureNames.length -
      missing.length -
      differences.length -
      providerFailureFixtures.size,
    missing,
    differences,
    providerFailures: {
      cheerpJ: cheerpJ.errors ?? {},
      traceJVM: traceJVM.errors ?? {},
    },
    timing: {
      cheerpJElapsedMs: Math.round(cheerpJRun.elapsedMs),
      cheerpJChunkCount: cheerpJRun.chunkCount,
      traceJVMElapsedMs: Math.round(traceJVMRun.elapsedMs),
      traceJVMChunkCount: traceJVMRun.chunkCount,
    },
  };
  const outputPath = process.env.TRACECODE_JAVA_TRACE_DIFFERENTIAL_REPORT;
  if (outputPath) {
    writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`JAVA_TRACE_PROVIDER_COMPARED ${report.comparedFixtures}`);
  console.log(`JAVA_TRACE_PROVIDER_EXACT_MATCHES ${report.exactMatches}`);
  console.log(`JAVA_TRACE_PROVIDER_MISSING ${missing.length}`);
  console.log(`JAVA_TRACE_PROVIDER_DIFFERENCES ${differences.length}`);
  console.log(`JAVA_TRACE_PROVIDER_CHEERPJ_FAILURES ${Object.keys(report.providerFailures.cheerpJ).length}`);
  console.log(`JAVA_TRACE_PROVIDER_TRACEJVM_FAILURES ${Object.keys(report.providerFailures.traceJVM).length}`);
  if (
    missing.length > 0 ||
    differences.length > 0 ||
    Object.keys(report.providerFailures.cheerpJ).length > 0 ||
    Object.keys(report.providerFailures.traceJVM).length > 0
  ) {
    console.error(JSON.stringify({
      missing,
      differences,
      providerFailures: report.providerFailures,
    }, null, 2));
    process.exitCode = 1;
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
