#!/usr/bin/env npx tsx

import { cppConformanceFixtures } from './conformance/cpp-fixtures';
import { createInitializedCppConformanceBridge, runCppConformanceFixture } from './conformance/cpp-runner';

const bridge = await createInitializedCppConformanceBridge();

let mutationMetadataCount = 0;

for (const fixture of cppConformanceFixtures) {
  const mutationKeys = Object.keys(fixture.expectedMutations);
  if (mutationKeys.length > 0) mutationMetadataCount += 1;

  console.log(`RUN: C++ conformance ${fixture.id}`);
  const result = await runCppConformanceFixture(bridge, fixture);
  if (!result.success) throw new Error(result.error || `${fixture.id}: conformance validation failed`);
  console.log(`PASS: C++ conformance ${fixture.id}`);
}

console.log(
  `PASS: C++ runtime conformance fixtures (${cppConformanceFixtures.length} fixtures, ${mutationMetadataCount} mutation metadata cases)`
);
