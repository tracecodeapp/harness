import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { finalReleaseLanguages, releaseJourneyGroups } from './final-release-plan.mjs';

export const production022 = Object.freeze({
  version: '0.21.0',
  sha256: '935c61d9f3f961056216a88922af31fa03279b58beefe2a8ff5d829563b9da62',
});

export const heavyCases022 = Object.freeze({
  javascript: {
    file: 'javascript.js', functionName: 'checksum', input: { rounds: 480000000 }, expected: 80934913,
    sha256: 'a94e90384fc533fc19d9fa423924d75c1240490c2f35e4b2ccab568e46fd1b2e',
  },
  typescript: {
    file: 'typescript.ts', functionName: 'checksum', input: { rounds: 480000000 }, expected: 80934913,
    sha256: '73e223af3116dd53e558e134000073cebe4ad5779cbc04eb2854b21c777b2d1f',
  },
  python: {
    file: 'python.py', functionName: 'count_placements', input: { size: 12, edge_columns: 2 }, expected: 2612,
    // The default untraced guard cuts this deterministic search short.
    limits: { maxLineEvents: 2_000_000, maxSingleLineHits: 500_000 },
    sha256: '0a8319c442e9416d7ceaff4cad5d36a1eed13730e7f6a822b33b14cdf4e39a60',
  },
  cpp: {
    file: 'cpp.cpp', functionName: 'checksum', input: { rounds: 300000000 }, expected: 687201025,
    sha256: 'e266bab481854af93276a5894c4747039433f0d4736136d8d46c8d8b4309188d',
  },
  java: {
    file: 'java.java', functionName: 'checksum', input: { rounds: 30000000 }, expected: -1664503935,
    sha256: '7a4fe5feb5f1f72a8ffe1910d25e5c84f0c27dc5b173fb14f68baae4826de2a2',
  },
  csharp: {
    file: 'csharp.cs', functionName: 'checksum', input: { rounds: 13000000 }, expected: -432775359,
    sha256: 'dce93e1c15d4c15ddb1e3779b60341a58c915e2446ce44978af5c1a890288b3c',
  },
});

export async function heavyFixture022(language) {
  const { file, functionName, input, expected, sha256, limits } = heavyCases022[language];
  const code = await readFile(new URL(`./heavy-022/${file}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(code).digest('hex'), sha256, file);
  return {
    id: 'heavy-022', language, code, functionName, executionStyle: 'function',
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
    traceBudget: {}, cases: [{ id: 'heavy-022', input: { ...input }, expected }],
    ...(limits && { limits: { ...limits } }),
  };
}

export function windowPlan022() {
  return finalReleaseLanguages.flatMap((language) => [
    ...['desktop', 'phone'].flatMap((scope) => releaseJourneyGroups(language, scope)),
    { language, cpu: 1, problem: 'heavy-022', state: 'warm', journey: 'submit',
      target: 20, continuation: false, versions: ['0.17.1', 'candidate-deploy'] },
  ]).map(({ pairedControlFor, ...group }, groupIndex) => ({
    ...group, groupIndex, versions: [production022.version, group.versions.at(-1)],
    ...(pairedControlFor && { pairedControlFor }),
  }));
}

export function selftestPlan022() {
  return windowPlan022().map((group) => ({ ...group, target: 1, versions: [production022.version] }));
}
