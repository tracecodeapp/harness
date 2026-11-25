import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitsCppValueAdapter, cppValueAdapterMerge } from './cpp-admission.mjs';
import { cppNaturalShapeRequests, cppNaturalShapes } from './cpp-natural-shapes.mjs';
import { cppRefusalFor } from './cpp-refusal.mjs';

const preMergePin = '255291b89316be9392dabafe39f5fb0b403ae2fc';
const capPins = ['98068e382702ca0719aeadfcbe28f3d4b1249ec4', '77b6545d7e1b4c714a0de80d3267b4c34a53121c'];

test('post-merge ancestry enables both G6 checks and a pre-merge source pin stays excluded', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ga-cpp-admission-'));
  try {
    const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    const tree = git(['mktree'], '');
    const commit = (label, ...parents) => git([
      '-c', 'user.name=GA fixture', '-c', 'user.email=ga@example.test',
      'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', label,
    ]);
    const before = commit('Before the adapter');
    const implementation = commit('Implement the adapter', before);
    const merge = commit('Merge the adapter', before, implementation);
    const descendant = commit('Later candidate', merge);
    const macroFixture = { gate: 'G6', language: 'cpp', name: 'cpp-delete-macro' };
    for (const subject of [merge, descendant, before]) {
      const admits = admitsCppValueAdapter(subject, repo, merge);
      const expected = subject !== before;
      assert.equal(admits, expected);
      assert.equal(cppNaturalShapes(subject, admits).flatMap(cppNaturalShapeRequests).length, expected ? 90 : 0);
      assert.equal(cppRefusalFor(macroFixture, subject, '', true, admits)?.code,
        expected ? 'cpp-macro-operation-unsupported' : undefined);
    }
    assert.equal(admitsCppValueAdapter(descendant), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('when source ancestry is unavailable the fallback admits both cap pins and excludes #92', () => {
  for (const subject of [cppValueAdapterMerge, ...capPins]) {
    assert.equal(admitsCppValueAdapter(subject), true, subject);
  }
  assert.equal(admitsCppValueAdapter(preMergePin), false);
});
