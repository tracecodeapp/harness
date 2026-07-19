#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { chromium } from 'playwright';

import {
  assertCondition,
  runCommand,
  startPreviewServer,
  waitForHttp,
} from './example-app-smoke';

declare global {
  interface Window {
    __tracecodeSqlSmoke?: {
      status: 'loading' | 'ready' | 'error';
      trace?: {
        engine: { kind: string; dialect: string; persistence?: string; capabilities?: string[] };
        events: Array<{
          kind: string;
          sql?: { operation?: string };
          action?: string;
          status?: string;
          rows?: { rowCountKnown?: number };
        }>;
      };
      rowCount?: number;
      rollbackCount?: number;
      isolatedRun?: {
        success: boolean;
        isolation: string;
        caseCount: number;
        destructivePassed?: boolean;
        freshReadPassed?: boolean;
        freshReadCount?: number;
        attemptTraceKinds?: string[];
        setupTraceVisible: boolean;
        assertionTraceVisible: boolean;
      };
      error?: string;
    };
  }
}

async function runSqlBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => window.__tracecodeSqlSmoke?.status === 'ready' || window.__tracecodeSqlSmoke?.status === 'error',
      undefined,
      { timeout: 180_000 }
    );

    const result = await page.evaluate(() => window.__tracecodeSqlSmoke);
    assertCondition(result?.status === 'ready', `SQL browser smoke failed: ${JSON.stringify(result)}`);
    assertCondition(result.rowCount === 2, `PGlite smoke should return two completed rows: ${JSON.stringify(result)}`);
    assertCondition(result.rollbackCount === 0, `PGlite transaction smoke should roll back failed inserts: ${JSON.stringify(result)}`);
    assertCondition(result.trace?.engine.kind === 'pglite', 'SQL browser smoke should trace PGlite engine kind');
    assertCondition(result.trace.engine.dialect === 'postgres', 'SQL browser smoke should trace Postgres dialect');
    assertCondition(result.trace.engine.persistence === 'memory', 'SQL browser smoke should trace memory persistence');
    assertCondition(
      result.trace.engine.capabilities?.includes('explain-json') === true,
      'SQL browser smoke should advertise explain-json only when plan capture is enabled'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'statement' && event.sql?.operation === 'select'),
      'SQL browser smoke should include a select statement event'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'batch' && event.status === 'ok'),
      'SQL browser smoke should include a successful exec batch event'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'error'),
      'SQL browser smoke should include a transaction error event'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'transaction' && event.action === 'rollback'),
      'SQL browser smoke should include a transaction rollback event'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'plan'),
      'SQL browser smoke should include a harness EXPLAIN estimate plan event'
    );
    assertCondition(
      result.trace.events.some((event) => event.kind === 'result' && event.rows?.rowCountKnown === 2),
      'SQL browser smoke should include the sampled SELECT result rows'
    );
    assertCondition(
      result.isolatedRun?.isolation === 'fresh-database',
      `SQL browser isolation smoke should use fresh database isolation: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.caseCount === 2,
      `SQL browser isolation smoke should run two cases: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.success === false,
      `SQL browser isolation smoke should report overall failure for the destructive case: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.destructivePassed === false,
      `Destructive SQL case should fail after dropping the table: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.freshReadPassed === true,
      `Fresh SQL case should still see the baseline snapshot: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.freshReadCount === 3,
      `Fresh SQL case should see all seeded customers: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.attemptTraceKinds?.includes('statement') === true,
      `Destructive attempt trace should include user SQL statements: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.setupTraceVisible === false,
      `Setup traces should be hidden from product output: ${JSON.stringify(result)}`
    );
    assertCondition(
      result.isolatedRun.assertionTraceVisible === false,
      `Assertion traces should be hidden from product output: ${JSON.stringify(result)}`
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exampleDir = join(repoRoot, 'examples', 'sql-browser');
  const previewPort = 5300 + Math.floor(Math.random() * 200);

  await runCommand('pnpm', ['--dir', exampleDir, 'build'], repoRoot);

  const preview = startPreviewServer(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    exampleDir
  );

  try {
    const previewUrl = await preview.waitForUrl;
    await waitForHttp(previewUrl, 30_000);
    await runSqlBrowserSmoke(previewUrl);
  } finally {
    if (!preview.process.killed) {
      preview.process.kill('SIGTERM');
    }
    await preview.waitForExit;
  }

  console.log('PASS: SQL browser example runs PGlite and exports a valid SQL trace');
}

test('sql browser example', main);
