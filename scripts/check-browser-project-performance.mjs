#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_BASELINE = 'tests/fixtures/browser-project-performance-baseline.json';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function readJson(pathname, label) {
  const absolutePath = resolve(pathname);
  try {
    return { absolutePath, value: JSON.parse(await readFile(absolutePath, 'utf8')) };
  } catch (error) {
    throw new Error(`Unable to read ${label} ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const reportPath = option('report');
if (!reportPath) throw new Error('Usage: node scripts/check-browser-project-performance.mjs --report=reports/file.json');

const baselineDocument = await readJson(option('baseline', DEFAULT_BASELINE), 'performance baseline');
const reportDocument = await readJson(reportPath, 'browser project benchmark report');
const baseline = baselineDocument.value;
const report = reportDocument.value;

if (baseline?.schemaVersion !== 'tracecode-browser-project-performance-baseline-v1') {
  throw new Error(`Unsupported performance baseline schema in ${baselineDocument.absolutePath}.`);
}
if (report?.schemaVersion !== 'tracecode-public-browser-project-benchmark-v1') {
  throw new Error(`Unsupported browser project report schema in ${reportDocument.absolutePath}.`);
}

const engine = report?.options?.engine;
const engineBaseline = baseline?.p50Ms?.[engine];
if (!engineBaseline || typeof engineBaseline !== 'object') {
  throw new Error(`Performance baseline does not define browser engine ${JSON.stringify(engine)}.`);
}

const relativeTolerance = baseline?.tolerance?.relative;
const absoluteTolerance = baseline?.tolerance?.absoluteMsByPhase;
if (typeof relativeTolerance !== 'number' || relativeTolerance < 0 || !absoluteTolerance) {
  throw new Error('Performance baseline tolerance is malformed.');
}

const reportLanguages = new Set(report?.options?.languages ?? []);
const summaries = new Map(
  (Array.isArray(report?.summaries) ? report.summaries : []).map((summary) => [
    `${summary.language}:${summary.phase}`,
    summary,
  ])
);
const failures = [];
const checked = [];

for (const [language, phases] of Object.entries(engineBaseline)) {
  if (!reportLanguages.has(language)) continue;
  for (const [phase, baselineP50Ms] of Object.entries(phases)) {
    const summary = summaries.get(`${language}:${phase}`);
    if (!summary) {
      failures.push(`${language}/${phase}: report summary is missing`);
      continue;
    }
    if (summary.attempted < baseline.samplesPerCell || summary.passed !== summary.attempted) {
      failures.push(
        `${language}/${phase}: requires ${baseline.samplesPerCell} passing samples, received ${summary.passed}/${summary.attempted}`
      );
      continue;
    }
    if (typeof summary.wallP50Ms !== 'number') {
      failures.push(`${language}/${phase}: p50 is unavailable`);
      continue;
    }
    const phaseSlack = absoluteTolerance[phase];
    if (typeof phaseSlack !== 'number' || phaseSlack < 0) {
      failures.push(`${language}/${phase}: baseline phase tolerance is missing`);
      continue;
    }
    const maximumMs = baselineP50Ms * (1 + relativeTolerance) + phaseSlack;
    checked.push({ language, phase, baselineP50Ms, actualP50Ms: summary.wallP50Ms, maximumMs });
    if (summary.wallP50Ms > maximumMs) {
      failures.push(
        `${language}/${phase}: p50 ${summary.wallP50Ms.toFixed(1)}ms exceeds ${maximumMs.toFixed(1)}ms `
        + `(baseline ${baselineP50Ms.toFixed(1)}ms)`
      );
    }
  }
}

if (checked.length === 0) throw new Error(`No baseline cells matched report engine ${engine}.`);
for (const cell of checked) {
  console.log(
    `${engine}/${cell.language}/${cell.phase}: ${cell.actualP50Ms.toFixed(1)}ms `
    + `(baseline ${cell.baselineP50Ms.toFixed(1)}ms, ceiling ${cell.maximumMs.toFixed(1)}ms)`
  );
}
if (failures.length > 0) {
  throw new Error(`Browser project performance gate failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}
console.log(`PASS: ${checked.length} ${engine} browser project performance cells`);
