import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const appCommit = 'e4eca52506e838dacdef28078c39f012a5825cd7';
export const catalog = '/root/ci/corpus-catalog-ff-all/problems';
export const releases = {
  '0.21.0': {
    archive: '/root/ci/h021-release-0.21.0.iMFK5Rua/pin/harness-0.21.0-46b8baecd840.tgz',
    sha256: '935c61d9f3f961056216a88922af31fa03279b58beefe2a8ff5d829563b9da62',
  },
  '0.20.1': {
    archive: '/root/ci/g8-candidates.qHpuBwkE/archives/tracecode-harness-0.20.1.tgz',
    sha256: 'e0a4c4d47b4880a49040329112fc779500b3dbeed039934873b72585eaedaf13',
  },
  '0.17.1': {
    archive: '/root/ci/g8-candidates.qHpuBwkE/archives/tracecode-harness-0.17.1.tgz',
    sha256: 'e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3',
  },
};

const m2Catalog = [
  {
    problem: 'n-queens', id: 'h5',
    fileSha256: 'c6bc3203954c39f70a5475bd772301c825e6bae493ea65af505a6816f0580b6d',
    programSha256: '4935a997ca7400d129f4666ef4b4ecfd81e07c4f7f22c335146e790da3cd1627',
    inputSha256: '6caf899d67cf6d60680d8645cc09837f8d48c4d85ba0f8a4f112428fd03c358d',
  },
  {
    problem: 'open-the-lock', id: '3',
    fileSha256: '8b07bfbae6fdce144925a3efb12047eb74fd18a690e452771550a0d3121005d1',
    programSha256: 'b6d1b6c8f4286500c70d1f6d5cc9f010999d69296113e3d3b683648647abbd18',
    inputSha256: '93d68a344ec5be06794e08219df146554f9021a3d8707f184898d3fd0761c8c0',
  },
  {
    problem: 'open-the-lock', id: 'h6',
    fileSha256: '8b07bfbae6fdce144925a3efb12047eb74fd18a690e452771550a0d3121005d1',
    programSha256: 'b6d1b6c8f4286500c70d1f6d5cc9f010999d69296113e3d3b683648647abbd18',
    inputSha256: '60cc36594d3b8229b8ae0d5f6b89345a130105e6e8a11fe5475ea348202526d2',
  },
];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function loadM2Catalog() {
  return Promise.all(m2Catalog.map(async (pin) => {
    const path = join(catalog, `${pin.problem}.json`);
    const bytes = await readFile(path);
    assert.equal(sha256(bytes), pin.fileSha256, path);
    const problem = JSON.parse(bytes);
    const matches = problem.testCases.filter((item) => item.id === pin.id);
    assert.equal(matches.length, 1, `${path} case ${pin.id}`);
    const [{ input, expected, customValidator }] = matches;
    assert.equal(sha256(problem.solutionCode), pin.programSha256, path);
    assert.equal(sha256(JSON.stringify(input)), pin.inputSha256, `${path} case ${pin.id}`);
    const comparator = {
      schema: 'tracecode.judge.comparator.v1',
      mode: problem.compareMode ?? 'exact',
      ...(problem.customValidator && { customValidator: problem.customValidator }),
    };
    return {
      provenance: { appCommit, path, ...pin },
      fixture: {
        code: problem.solutionCode,
        functionName: problem.functionName,
        executionStyle: problem.executionStyle ?? 'function',
        comparison: comparator,
        cases: [{
          id: pin.id, input, expected,
          ...(customValidator && { comparator: { ...comparator, customValidator } }),
        }],
      },
    };
  }));
}
