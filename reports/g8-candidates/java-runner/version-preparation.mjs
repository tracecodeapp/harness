import assert from 'node:assert/strict';

export const historicalPackageSha256 = Object.freeze({
  '0.17.1': 'e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3',
  '0.20.1': 'e0a4c4d47b4880a49040329112fc779500b3dbeed039934873b72585eaedaf13',
});

export function candidatePreparationSourceVersion(version, candidate) {
  return candidate && version === 'candidate-deploy' ? 'candidate-main' : version;
}

export function assertExactHistoricalPackage(version, metadata) {
  const expected = historicalPackageSha256[version];
  if (expected) assert.equal(metadata.sha256, expected,
    `${version} live control does not contain its pinned release bytes`);
}
