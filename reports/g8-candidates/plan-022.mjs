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
    file: 'python.py', functionName: 'count_placements', input: { size: 13 }, expected: 73712,
    sha256: '43fd2c5e51a1ad06836613fe15a1c822c78f9dd42bf1a6dde8269ea6f1002353',
  },
  cpp: {
    file: 'cpp.cpp', functionName: 'checksum', input: { rounds: 400000000 }, expected: -748346367,
    sha256: '0f375ced8e807cbfee0fa6e51ba810aef030a1294663e520405cb58d6b1c00c8',
  },
  java: {
    file: 'java.java', functionName: 'checksum', input: { rounds: 50000000 }, expected: -288021375,
    sha256: '05fdaf87743b40350d5f1e010d442ff47a06d743ae63cb883df76aec329144f1',
  },
  csharp: {
    file: 'csharp.cs', functionName: 'checksum', input: { rounds: 17000000 }, expected: 463212609,
    sha256: '59d5d49f7a64cf8021e0f3b0106612da9d859cab03c3afae9d69735e07ba77f3',
  },
});

export async function heavyFixture022(language) {
  const { file, functionName, input, expected, sha256 } = heavyCases022[language];
  const code = await readFile(new URL(`./heavy-022/${file}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(code).digest('hex'), sha256, file);
  return {
    id: 'heavy-022', language, code, functionName, executionStyle: 'function',
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
    traceBudget: {}, cases: [{ id: 'heavy-022', input, expected }],
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
