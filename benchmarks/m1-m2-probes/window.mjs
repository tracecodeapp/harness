import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { languages, loadBinarySearch, loadM2Catalog, releases } from './inputs.mjs';

const target = 20;
const loadGate = 2;
const versions = ['0.21.0', '0.20.1', '0.17.1'];
const profiles = [['desktop', 1], ['phone', 4]];
const versionOrders = [
  [0, 1, 2], [2, 0, 1], [1, 2, 0],
  [2, 1, 0], [0, 2, 1], [1, 0, 2],
];

export async function openSession(browser, url, rate, kind, language = 'python') {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(url);
    await page.evaluate(async ({ kind, language }) => {
      const entry = await import('/entry.mjs');
      if (kind === 'm1') globalThis.probeM1 = entry.openM1(language);
      else globalThis.probeJudge = await entry.openJudge();
    }, { kind, language });
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function waitForQuiet(deadline) {
  while (Date.now() < deadline) {
    if (loadavg()[0] <= loadGate) return true;
    await delay(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  return false;
}

async function bounded(deadline, operation) {
  const cancel = new AbortController();
  try {
    return await Promise.race([
      operation(),
      delay(Math.max(0, deadline - Date.now()), null, { signal: cancel.signal }),
    ]);
  } finally {
    cancel.abort();
  }
}

const failure = (error) => ({ error: error.name ?? 'Error' });

async function collectM1(browser, url, cells, heavy, dry, deadline, record) {
  for (const [problem, n] of cells) {
    for (const language of languages) {
      if (Date.now() >= deadline) return;
      if (!dry.m1[language] || (problem === 'heavy' && !dry.m1Heavy[language])) {
        await record({ probe: 'm1', problem, n, language, skipped: 'dry-run verdict or transport failed' });
        continue;
      }
      if (language === 'csharp' && n > 64) {
        await record({ probe: 'm1', problem, n, language, skipped: 'the published singleton runner rotates after at most 64 cases' });
        continue;
      }
      let session;
      try {
        session = await bounded(deadline, () => openSession(browser, url, 1, 'm1', language));
        if (!session) return;
        const { page } = session;
        const fixture = problem === 'binary-search' ? await loadBinarySearch(language, n)
          : { ...heavy[language], cases: Array.from({ length: n }, (_, index) => ({
            ...heavy[language].cases[0], id: String(index + 1),
          })) };
        const prepare = () => bounded(deadline, () => page.evaluate(async (fixture) => {
          const preparation = await globalThis.probeM1.prepare(fixture);
          return preparation.kind === 'prepared' && await globalThis.probeM1.prime() === 'completed';
        }, fixture));
        const ready = await prepare();
        if (ready === null) return;
        if (!ready) throw new Error('Prepared provider did not prime');
        let kept = 0;
        for (let index = 0; kept < target && await waitForQuiet(deadline); index++) {
          // Keep the shipped C# worker lease from rotating between N=10 pairs.
          // Preparation and the warm-up request are outside the timed arms.
          if (language === 'csharp' && index > 0 && n === 10) {
            const primed = await prepare();
            if (primed === null) return;
            if (!primed) throw new Error('C# retained runner did not prime');
          }
          const warmup = index < 3;
          const first = index % 2 === 0 ? 'batch' : 'singleton';
          const before = loadavg()[0];
          const pair = await bounded(deadline, () => page.evaluate(
            (first) => globalThis.probeM1.pair(first, true), first,
          ));
          const after = loadavg()[0];
          const cut = pair === null || Date.now() >= deadline;
          const admissible = !warmup && !cut && before <= loadGate && pair.pass;
          await record({
            probe: 'm1', problem, n, language, index, first, warmup, before, after, admissible,
            ...(cut ? { discarded: '45-minute M1 cap' } : { pair }),
          });
          if (cut) return;
          if (admissible) kept++;
          if (!pair.pass && (pair.batch.error || pair.singleton.error)) break;
        }
      } catch (error) {
        await record({ probe: 'm1', problem, n, language, ...failure(error) });
      } finally {
        await session?.context.close();
      }
    }
  }
}

async function collectM2(browser, sites, heavy, deadline, record) {
  const catalog = await loadM2Catalog();
  const cases = [
    ...catalog.map(({ fixture, provenance }) => ({
      key: provenance.problem + '/' + provenance.id, fixture,
    })),
    { key: 'p0c-heavy', fixture: heavy.python },
  ];
  for (const [profile, rate] of profiles) {
    const sessions = new Map();
    try {
      for (const version of versions) {
        const session = await bounded(deadline, () => openSession(browser, sites[version], rate, 'm2'));
        if (!session) return;
        sessions.set(version, session);
        const warm = await bounded(deadline, () => session.page.evaluate(
          (fixture) => globalThis.probeJudge.run(fixture, false), cases[0].fixture,
        ));
        if (!warm?.pass) throw new Error('M2 warm-up failed for ' + version);
        await record({ probe: 'm2', profile, version, warmup: true });
      }
      for (const { key, fixture } of cases) {
        const counts = Object.fromEntries(versions.map((version) => [version, 0]));
        // Keep version alternation for incomplete cells. A version that already
        // reached 20 stays in the round, with surplus attempts outside scoring.
        for (let round = 0; Object.values(counts).some((count) => count < target); round++) {
          for (const versionIndex of versionOrders[round % versionOrders.length]) {
            if (!await waitForQuiet(deadline)) return;
            const version = versions[versionIndex];
            const { page } = sessions.get(version);
            await page.bringToFront();
            const before = loadavg()[0];
            const result = await bounded(deadline, () => page.evaluate(
              (fixture) => globalThis.probeJudge.run(fixture, true), fixture,
            )).catch(failure);
            const after = loadavg()[0];
            const cut = result === null || Date.now() >= deadline;
            const admissible = !cut && counts[version] < target && before <= loadGate &&
              result.pass && Number.isFinite(result.totalMs);
            await record({
              probe: 'm2', key, profile, version, round, before, after, admissible,
              ...(cut ? { discarded: 'M2 window cap' } : { result }),
            });
            if (cut) return;
            if (admissible) counts[version]++;
          }
        }
      }
    } finally {
      for (const { context } of sessions.values()) await context.close();
    }
  }
}

export async function validateWindow(config, probeCommit) {
  assert.equal(process.env.P0F_COORDINATOR_WINDOW, '1', 'Coordinator must open the window');
  const receipt = JSON.parse(await readFile(config.selftestReceipt, 'utf8'));
  assert.deepEqual(receipt, {
    schema: 'tracecode.speed-022.selftest.v1',
    pass: true, rigCommit: config.rigCommit, tarballSha256: releases['0.21.0'].sha256,
  });
  const dry = JSON.parse(await readFile(config.dryReceipt, 'utf8'));
  assert.equal(dry.probeCommit, probeCommit, 'Dry-run receipt must match the sampling commit');
  assert.equal(dry.browser, '145.0.7632.6');
  assert.equal(dry.rigCommit, config.rigCommit);
  assert.equal(dry.heavySha256, config.heavySha256);
  assert.equal(dry.m2Pass, true, 'M2 correctness receipts must pass before sampling');
  for (const language of languages) {
    assert.equal(typeof dry.m1[language], 'boolean');
    assert.equal(typeof dry.m1Heavy[language], 'boolean');
  }
  return dry;
}

export async function collectWindow(browser, sites, output, heavy, dry) {
  assert.equal(browser.version(), dry.browser);
  const journal = join(output, 'samples.jsonl');
  await writeFile(journal, '', { flag: 'wx' });
  const record = async (row) => appendFile(journal, JSON.stringify(row) + '\n');
  const starts = Date.now();
  await record({
    probe: 'window', browser: dry.browser, probeCommit: dry.probeCommit, canaries: dry.m1,
    rigCommit: dry.rigCommit, heavySha256: dry.heavySha256,
    tarballs: Object.fromEntries(Object.entries(releases).map(([version, { sha256 }]) => [version, sha256])),
  });
  try {
    const m1Deadline = starts + 45 * 60_000;
    await collectM1(browser, sites.m1, [['binary-search', 10]], heavy, dry, m1Deadline, record);
    if (await waitForQuiet(Math.min(Date.now() + 15_000, m1Deadline))) {
      const control = await browser.newContext();
      try {
        const page = await control.newPage();
        await page.goto(sites.m1);
        const before = loadavg()[0];
        const diagnostic = await bounded(Math.min(Date.now() + 10_000, m1Deadline), () => page.evaluate(async () => {
          const { measureHostControls } = await import('/entry.mjs');
          return measureHostControls();
        }));
        const after = loadavg()[0];
        if (diagnostic && before <= loadGate && after <= loadGate) {
          await record({ probe: 'm1-controls', before, after, ...diagnostic });
        }
      } catch (error) {
        await record({ probe: 'm1-controls', ...failure(error) });
      } finally {
        await control.close();
      }
    }
    await collectM1(browser, sites.m1, [['binary-search', 100], ['heavy', 10], ['heavy', 100]],
      heavy, dry, m1Deadline, record);
  } catch (error) {
    // A partial M1 must leave the M2 phase runnable in the same window.
    await record({ probe: 'm1', ...failure(error) });
  }
  await collectM2(browser, sites, heavy, Date.now() + 40 * 60_000, record);
  await record({ probe: 'window-end' });
}
