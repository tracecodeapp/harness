import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogWitnesses, syntheticWitnesses } from './cases.mjs';
import { controls } from './controls.mjs';
import { inspect, knownGood, passingStatuses } from './oracle.mjs';

const [command, catalog, argument, receiptPath] = process.argv.slice(2);
if (!catalog || !['candidate', 'controls', 'prototype'].includes(command)) {
  throw new Error('Usage: run.mjs <candidate|controls|prototype> <catalog-root> [adapter.mjs|replay.json] [report.json]');
}
const references = catalogWitnesses(catalog);
const witnesses = [...syntheticWitnesses, ...references];
const manifestSha256 = createHash('sha256').update(JSON.stringify(witnesses)).digest('hex');
const rows = [];
const good = new Map(witnesses.map(witness => [witness.request.id, knownGood(witness)]));
const candidateCase = async (adapter, witness) => {
  try {
    const receipt = await adapter.runCase(structuredClone(witness.request));
    return { ...inspect(witness, receipt), raw: receipt };
  } catch (error) {
    return { status: 'unexecuted', assertions: [], error: String(error) };
  }
};

if (command === 'candidate') {
  const adapter = await import(pathToFileURL(resolve(argument)).href);
  if (typeof adapter.runCase !== 'function') throw new Error('Adapter must export runCase(request)');
  for (const witness of witnesses) {
    rows.push({ id: witness.request.id, ...await candidateCase(adapter, witness) });
  }
} else if (command === 'prototype') {
  const data = JSON.parse(readFileSync(argument, 'utf8'));
  for (const witness of references) {
    const id = witness.request.id;
    const raw = data[id];
    const result = raw?.out?.match(/^__TRACECODE_RESULT__(.+)$/m);
    const certified = raw && raw.broken === null && raw.exit?.length === 2 && raw.exit.every(x => x === 0) &&
      ['exit', 'output', 'syscalls', 'memory'].every(key => raw.certificate[key] === true);
    const assertions = [];
    const check = (idSuffix, expected, actual) => assertions.push({
      id: id + '/' + idSuffix, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual),
    });
    check('prototype/ordinary', witness.expected.ordinary.value, result && JSON.parse(result[1]));
    check('prototype/endpoint-certificate', true, Boolean(certified));
    if (!assertions.every(a => a.pass)) {
      rows.push({ id, status: 'unexecuted', assertions, raw });
      continue;
    }
    const lineOf = range => witness.request.source.slice(0, range.start).split('\n').length;
    const entries = Object.entries(witness.request.sites);
    const projected = raw.steps.flatMap(step => {
      const site = entries.find(([, range]) => step.line === lineOf(range));
      if (!site || step.fn !== witness.request.functionName) return [];
      const name = id === 'binary-search' ? 'mid' : 'cur';
      const observed = step.state[name];
      return [{ site: site[0], observation: observed === undefined || observed === '<uninitialized>'
        ? { state: 'unavailable' } : { state: 'value', value: observed } }];
    });
    const expected = witness.expected.attachment.events.map(({ site, observation }) => ({ site, observation }));
    check('prototype/count', expected.length, projected.length);
    for (const [i, event] of expected.entries()) check('prototype/event-' + i, event, projected[i]);
    rows.push({ id, status: assertions.every(a => a.pass) ? 'projection-pass' : 'wrong', assertions, raw });
  }
} else {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    async function paint(stream) {
      await page.evaluate(({ status, reason, coverage, events }) => {
        const heading = document.createElement('p');
        heading.textContent = JSON.stringify({ status, reason, coverage });
        const timeline = document.createElement('ol');
        for (const event of events) {
          const entry = document.createElement('li');
          entry.textContent = JSON.stringify(event);
          timeline.append(entry);
        }
        document.body.replaceChildren(heading, timeline);
      }, stream);
      const heading = page.locator('body > p');
      await heading.waitFor({ state: 'visible' });
      const entries = await page.locator('li').all();
      const events = [];
      for (const entry of entries) {
        assert(await entry.isVisible(), 'Expected visible timeline entry');
        events.push(JSON.parse(await entry.innerText()));
      }
      return { ...JSON.parse(await heading.innerText()), events };
    }
    for (const witness of witnesses) {
      const receipt = structuredClone(good.get(witness.request.id));
      receipt.drawing = await paint(receipt.attachment);
      const result = inspect(witness, receipt);
      assert(passingStatuses.has(result.status), JSON.stringify(result.assertions.filter(a => !a.pass)));
      rows.push({ id: witness.request.id + '/control-good', ...result });
    }
    for (const [name, id, assertion, inject] of controls) {
      for (const layer of ['attachment', 'drawing']) {
        const witness = witnesses.find(w => w.request.id === id);
        const receipt = structuredClone(good.get(id));
        const changed = structuredClone(receipt.attachment);
        inject(changed, witness.request, good);
        assert.notDeepEqual(changed, receipt.attachment);
        if (layer === 'attachment') receipt.attachment = changed;
        receipt.drawing = await paint(changed);
        const result = inspect(witness, receipt);
        const want = id + '/' + layer + '/' + assertion;
        assert.equal(result.assertions.find(a => a.id === want)?.pass, false, name + ' missed ' + want);
        assert(!passingStatuses.has(result.status));
        assert(result.assertions.filter(a => a.id.startsWith(id + '/ordinary/')).every(a => a.pass));
        if (layer === 'drawing') {
          assert(result.assertions.filter(a => a.id.startsWith(id + '/attachment/')).every(a => a.pass));
        }
        rows.push({ id: name + '/' + layer, status: 'control-caught', mutantStatus: result.status,
          assertions: result.assertions });
      }
    }
  } finally {
    await browser.close();
  }
}

for (const row of rows) {
  const failed = row.assertions.filter(a => !a.pass);
  console.log(row.id, row.status, failed.length ? JSON.stringify(failed[0]) : '', row.error ?? '');
}
const report = { command, manifestSha256, rows, counts: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status =>
  [status, rows.filter(row => row.status === status).length])) };
console.log(JSON.stringify(report.counts));
if (receiptPath) writeFileSync(receiptPath, JSON.stringify(report, null, 2) + '\n');
if (command !== 'controls' && rows.some(row => !passingStatuses.has(row.status))) process.exitCode = 1;
