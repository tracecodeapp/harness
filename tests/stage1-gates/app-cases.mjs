import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { appFixtureName, appSpec } from './requests.mjs';

const [appPath, outputPath] = process.argv.slice(2);
if (!appPath || !outputPath) throw new Error('Usage: app-cases.mjs READ_ONLY_APP_REPO OUTPUT_OUTSIDE_GIT');
assert(!resolve(outputPath).startsWith(process.cwd() + sep), 'App inputs must stay outside the Harness checkout');
const revision = 'fcea04982d5c0aa3d2112e188cff7ef9b22d5753';
const app = (path) => execFileSync('git', ['-C', appPath, 'show', `${revision}:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const appJson = (path) => JSON.parse(app(path));

function blastOracle({ n, edges, updates }) {
  const graph = Array.from({ length: n }, () => new Map());
  function edge(from, to, delta) {
    graph[from].set(to, Math.max(0, (graph[from].get(to) ?? 0) + delta));
  }
  for (const [from, to] of edges) edge(from, to, 1);
  const outputs = [];
  for (const [kind, from, to] of updates) {
    if (kind === 'add' || kind === 'remove') {
      edge(from, to, kind === 'add' ? 1 : -1);
    } else {
      assert.equal(kind, 'query');
      const seen = new Set([from]);
      for (const node of seen) {
        for (const [child, count] of graph[node]) if (count > 0) seen.add(child);
      }
      outputs.push(seen.size);
    }
  }
  return outputs;
}

function searchOracle({ operations, k }) {
  const scores = new Map();
  const outputs = [];
  for (const [kind, term, score] of operations) {
    if (kind === 'add') {
      scores.set(term, (scores.get(term) ?? 0) + score);
    } else {
      assert.equal(kind, 'query');
      const matches = [...scores].filter(([word]) => word.startsWith(term));
      matches.sort(([a, aScore], [b, bScore]) => bScore - aScore || (a < b ? -1 : a > b ? 1 : 0));
      outputs.push(matches.slice(0, k).map(([word]) => word));
    }
  }
  return outputs;
}

const oracles = { 'blast-radius-analysis': blastOracle, 'search-autocomplete': searchOracle };
const fixtures = appSpec.map(({ name, stage, candidateFile, cases: wanted }) => {
  const published = appJson(`data/interviews/${name}.json`);
  const candidate = appJson(`data/interview-private/candidates/${candidateFile}.unpublished.json`).problems[name].stages[stage - 1];
  const indexed = new Map([
    ...published.stages[stage - 1].sampleTests, ...candidate.correctness, ...candidate.performance,
  ].map((row) => [row.id, row]));
  const cases = wanted.map((id) => {
    const { input, expected } = indexed.get(id);
    const actual = oracles[name](input);
    assert.deepEqual(actual, expected, `${name}/${id} app expectation agrees with independently computed answer`);
    return { id, input, expected, actual, status: 'completed', verdict: 'passed', stdout: '', stderr: '', diagnostics: [] };
  });
  return {
    gate: 'G6', name: appFixtureName({ name, stage }), language: 'cpp',
    code: app(`data/reference-solutions/cpp/interviews/${name}/stage-${stage}.cpp`),
    functionName: candidate.judge.functionName, executionStyle: candidate.judge.executionStyle,
    limits: { wallClockMs: candidate.judge.wallTimeMs }, cases,
  };
});
writeFileSync(outputPath, JSON.stringify({ revision, fixtures }) + '\n');
