import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expandSuiteTask } from './suite-plan.mjs';
import { missingEvidence } from './leaf-ledger.mjs';

export const knownLeaves = {
  'tests/test-python-stopping-batch-clock-browser.ts': {
    id: 'python-stopping-clock',
    assertions: [
      'browser-worker',
      ...[['run', 1], ['run', 5], ['submit-stop', 1], ['submit-stop', 5], ['run', 0], ['submit-stop', 0]]
        .flatMap(([action, runaway]) => Array.from({ length: 10 }, (_, index) => `${action}/${runaway}/case-${index + 1}`)),
    ],
  },
  'tests/test-python-trace-cutoff-guard-browser.ts': {
    id: 'python-trace-cutoff', assertions: ['browser-worker', 'runaway', 'finishes', 'runsLong'],
  },
  'tests/test-python-untraced-line-guard-browser.ts': {
    id: 'python-line-guard', assertions: ['browser-worker', 'submit', 'run'],
  },
  'tests/test-tracekernel-hardening.ts': {
    id: 'js-destructured-iterable', assertions: ['judged-value', 'learner-assignment'],
    partial: true,
  },
};

export async function createSuiteFloor(root, directory, scripts, completePlan) {
  const inventory = JSON.parse(await readFile(new URL('./suite-inventory.json', import.meta.url), 'utf8'));
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  const failures = [];
  const legacy = new Set();
  if (completePlan && !isDeepStrictEqual([...scripts].sort(), Object.keys(inventory).sort())) {
    throw new Error('G7/suite/task-inventory-drift');
  }
  const plan = scripts.map((script) => {
    const observed = expandSuiteTask(root, script);
    if (!isDeepStrictEqual(observed, inventory[script])) throw new Error(`G7/suite/plan-drift/${script}`);
    return [script, observed];
  });
  await writeFile(join(output, 'plan.json'), JSON.stringify({ platform: process.platform, plan }, null, 2));
  return {
    async start(script) {
      const id = script.replace(/[^\w.-]+/gu, '_');
      const path = join(output, id + '.jsonl');
      const nonce = randomUUID();
      await writeFile(path, '', { flag: 'wx' });
      const file = new URL('./suite-preload.mjs', import.meta.url);
      const env = {
        ...process.env,
        TRACECODE_SUITE_ROOT: root,
        TRACECODE_SUITE_LEDGER: path,
        TRACECODE_SUITE_NONCE: nonce,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${file.href}`].filter(Boolean).join(' '),
      };
      return { path, nonce, env };
    },

    async finish(script, { path, nonce }, outputText) {
      const events = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const paths = inventory[script].flatMap(({ leaves }) => leaves);
      const counts = new Map();
      const issues = [];
      if (events.some((event) => event.nonce !== nonce)) issues.push(`G7/suite/${script}/foreign-nonce`);
      if (/^\s*ok\b[^\n]*#\s*(?:SKIP|TODO)\b/imu.test(outputText)) {
        issues.push(`G7/suite/${script}/skipped-test`);
      }
      for (const leaf of paths) counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
      for (const [leaf, count] of counts) {
        const starts = events.filter((event) => event.leaf === leaf && event.kind === 'process-start');
        const terminal = events.filter((event) => event.leaf === leaf && event.kind === 'process-end');
        if (starts.length < count) issues.push(`G7/suite/${leaf}/missing-leaf`);
        if (starts.length > count) issues.push(`G7/suite/${leaf}/repeated-leaf`);
        if (starts.length && !starts.every(({ pid }) => terminal.some((end) => end.pid === pid))) {
          issues.push(`G7/suite/${leaf}/missing-terminal`);
        }
        const expected = knownLeaves[leaf];
        if (expected) issues.push(...missingEvidence(expected.id, expected.assertions, events));
        if (!expected || expected.partial) legacy.add(leaf);
      }
      for (const { leaf } of events.filter(({ kind }) => kind === 'process-start')) {
        if (!counts.has(leaf)) issues.push(`G7/suite/${script}/unexpected-leaf/${leaf}`);
      }
      failures.push(...new Set(issues));
      for (const issue of new Set(issues)) console.error(issue);
    },

    async complete(results) {
      const ran = new Set(results);
      for (const script of scripts) {
        if (!ran.has(script)) failures.push(`G7/suite/${script}/missing-task`);
      }
      await writeFile(join(output, 'verdict.json'), JSON.stringify({
        failures, incomplete: [...legacy].sort(),
      }, null, 2));
      if (failures.length || legacy.size) {
        return `G7 suite floor: ${failures.length} evidence failure(s), ${legacy.size} leaf file(s) with incomplete assertion inventories. See ${dirname(join(output, 'verdict.json'))}.`;
      }
    },
  };
}
