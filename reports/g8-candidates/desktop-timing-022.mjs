import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const languages = ['javascript', 'python', 'csharp'];
const arms = ['withBus', 'withoutBus'];
const warmupTrials = 2;
const measuredTrials = 20;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function summarize(rows) {
  return languages.flatMap((language) => ['verdicts', 'firstTrace'].map((metric) => {
    const cell = Object.fromEntries(arms.map((arm) => {
      const values = rows.filter((row) => row.language === language && row.arm === arm && row.admissible)
        .map((row) => row[metric]);
      return [arm, { count: values.length, medianMs: median(values) }];
    }));
    const { withBus, withoutBus } = cell;
    const ratio = withBus.medianMs > 0 && withoutBus.medianMs !== null
      ? withoutBus.medianMs / withBus.medianMs : null;
    const deltaMs = ratio === null ? null : withoutBus.medianMs - withBus.medianMs;
    const complete = arms.every((arm) => cell[arm].count === measuredTrials);
    const moved = ratio !== null && Math.abs(ratio - 1) > 0.05 && Math.abs(deltaMs) >= 5;
    return { language, metric, ...cell, ratio, deltaMs,
      result: !complete || ratio === null ? 'undecided' : moved ? 'moved' : 'no measurable move' };
  }));
}

// Both arms use the same published package and Run journey. Each attempt starts with
// a fresh page and a warmed runtime, as in the rig's fresh warm Python and C# groups.
export async function compareDesktopBus022({
  browser, launchWithBus, openPage, fixtures, warm, waitForQuiet, pressure, maxLoad,
  initial, outcome, refusal, samplesPath, out, rigCommit, production,
}) {
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_RUNTIME_DIR,
    'The with-bus arm requires the root session bus environment');
  const rows = [];
  const control = await launchWithBus();
  let error;
  try {
    assert.equal(control.version(), browser.version(), 'The timing arms must use the same Chromium');
    const contexts = {
      withBus: await control.newContext(),
      withoutBus: await browser.newContext(),
    };
    for (const [index, language] of languages.entries()) {
      const order = index % 2 === 0 ? arms : [...arms].reverse();
      const group = { language, cpu: 1, problem: 'binary-search', state: 'warm', journey: 'run' };
      const fixture = fixtures[language];
      const expectedIds = fixture.cases.map(({ id }) => id);
      for (let trial = 1; trial <= warmupTrials + measuredTrials; trial++) {
        for (const arm of order) {
          await waitForQuiet();
          const row = { language, arm, trial, warmup: trial <= warmupTrials };
          let page;
          try {
            page = await openPage(contexts[arm], group);
            await page.bringToFront();
            const setup = await warm(page);
            assert.equal(setup.success, true, setup.error?.message ?? 'Warmup failed');
            row.beforeInitial = pressure();
            if (row.beforeInitial.oneMinute > maxLoad) {
              row.excluded = 'initial load > ' + maxLoad;
            } else {
              const result = await initial(page, fixture, 'run', false);
              row.invalid = refusal(result) ?? outcome(result, expectedIds);
              row.verdicts = result.elapsedMs;
              row.firstTrace = result.firstTraceMs;
              if (!Number.isFinite(row.verdicts) || !Number.isFinite(row.firstTrace)) {
                row.invalid ??= 'Missing verdict or first-case trace timing';
              }
            }
          } catch (failure) {
            row.invalid = failure.message;
          } finally {
            await page?.close().catch(() => {});
          }
          row.admissible = !row.warmup && !row.excluded && !row.invalid;
          rows.push(row);
          await appendFile(samplesPath, JSON.stringify(row) + '\n');
        }
      }
      console.log(JSON.stringify({ kind: 'desktop-timing-progress', language, attempts: rows.length }));
    }
  } catch (failure) {
    error = failure.message;
    throw failure;
  } finally {
    try {
      await control.close();
    } finally {
      const summary = {
        jobId: process.env.HEAVY_JOBLOG_ID, rigCommit, production, chromium: browser.version(),
        maxLoad, warmupTrials, measuredTrials, attempts: rows.length, error, cells: summarize(rows),
      };
      await writeFile(join(out, 'desktop-timing.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ kind: 'desktop-timing-summary', ...summary }));
    }
  }
}
