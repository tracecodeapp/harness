import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { appFixtureName, appSpec } from './requests.mjs';

const [appPath, outputPath] = process.argv.slice(2);
if (!appPath || !outputPath) throw new Error('Usage: app-cases.mjs READ_ONLY_APP_REPO OUTPUT_OUTSIDE_GIT_OR_IGNORED');
assert(!resolve(outputPath).startsWith(resolve(appPath) + sep), 'App inputs must stay outside the app checkout');
if (resolve(outputPath).startsWith(process.cwd() + sep)) {
  execFileSync('git', ['check-ignore', '--quiet', '--', resolve(outputPath)]);
}
const head = () => execFileSync('git', ['-C', appPath, 'show', '-s', '--format=%H', 'origin/main'], { encoding: 'utf8' }).trim();
const revision = head();
const sources = {};
function app(path) {
  const bytes = execFileSync('git', ['-C', appPath, 'show', `origin/main:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  sources[path] = createHash('sha256').update(bytes).digest('hex');
  return bytes.toString('utf8');
}
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
const fixtures = appSpec.map(({ name, stage, candidateFile, cases: pinnedCases }) => {
  const published = appJson(`data/interviews/${name}.json`);
  const candidate = appJson(`data/interview-private/candidates/${candidateFile}.unpublished.json`).problems[name].stages[stage - 1];
  const samples = published.stages[stage - 1].sampleTests;
  const indexed = new Map([...samples, ...candidate.correctness, ...candidate.performance].map((row) => [row.id, row]));
  // Keep the original sample and exercise the expanded stage with its current
  // public samples and one correctness case from the same app revision.
  const wanted = name === 'blast-radius-analysis'
    ? [...samples.map(({ id }) => id), candidate.correctness[0].id]
    : pinnedCases;
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
assert.equal(head(), revision, 'App origin/main moved while reading fixture files');
writeFileSync(outputPath, JSON.stringify({ revision, sources, fixtures }) + '\n', { flag: 'wx', mode: 0o600 });
