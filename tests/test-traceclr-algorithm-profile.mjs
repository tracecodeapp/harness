import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(
  'packages/runtime-csharp/traceclr-algorithm-profile.config.json',
  'utf8'
));
const profile = JSON.parse(readFileSync(
  'packages/runtime-csharp/traceclr-algorithm-profile.json',
  'utf8'
));
const props = readFileSync(
  'packages/runtime-csharp/dotnet/TraceClr.AlgorithmProfile.props',
  'utf8'
);
const hostProject = readFileSync(
  'packages/runtime-csharp/dotnet/TraceCode.CSharpHost/TraceCode.CSharpHost.csproj',
  'utf8'
);

function propsItems(name) {
  return [...props.matchAll(new RegExp(`<${name} Include="([^"]+)" \\/>`, 'gu'))]
    .map((match) => match[1]);
}

test('TraceCLR profile is a complete, deterministic corpus inventory', () => {
  assert.equal(config.schema, 'tracecode.traceclr-algorithm-profile-config.v1');
  assert.equal(profile.schema, 'tracecode.traceclr-algorithm-profile.v1');
  assert.equal(profile.targetFramework, config.targetFramework);
  assert.deepEqual(profile.policy, {
    deniedAssemblyPrefixes: [...config.deniedAssemblyPrefixes].sort(),
    deniedTypePrefixes: [...config.deniedTypePrefixes].sort(),
    deniedMemberPrefixes: [...config.deniedMemberPrefixes].sort(),
  });
  assert.equal(profile.corpus.sourceCount, profile.sources.length);
  assert.equal(profile.corpus.compiledSourceCount, profile.sources.length);
  assert.equal(profile.corpus.failureCount, 0);
  assert.deepEqual(profile.failures, []);
  assert.match(profile.corpus.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(new Set(profile.sources.map((source) => source.path)).size, profile.sources.length);
  for (const source of profile.sources) {
    assert.equal(source.status, 'compiled', source.path);
    assert.match(source.sha256, /^[a-f0-9]{64}$/u, source.path);
    assert.ok(source.wireContracts.length > 0, `${source.path} has no callable contract`);
  }
});

test('TraceCLR minimal runner roots are derived from observed learner references', () => {
  assert.deepEqual(
    profile.algorithmRunnerRootAssemblies,
    [...new Set([
      ...profile.directAssemblyReferences,
      ...config.algorithmRunnerHostAssemblies,
    ])].sort()
  );
  for (const forbiddenPrefix of config.deniedAssemblyPrefixes) {
    assert.equal(
      profile.directAssemblyReferences.some((assembly) => assembly.startsWith(forbiddenPrefix)),
      false,
      `${forbiddenPrefix} leaked into the algorithm profile`
    );
  }
});

test('TraceCLR generated MSBuild roots match the machine-readable profile', () => {
  assert.deepEqual(
    propsItems('TraceClrAlgorithmCompilerAssembly'),
    profile.compilerReferenceAssemblies
  );
  assert.deepEqual(
    propsItems('TraceClrAlgorithmRunnerRootAssembly'),
    profile.runnerRootAssemblies
  );
  assert.deepEqual(
    propsItems('TraceClrMinimalRunnerRootAssembly'),
    profile.algorithmRunnerRootAssemblies
  );
});

test('TraceCLR compiler optimization preserves the project BCL surface', () => {
  for (const assembly of [
    'System.Collections.Concurrent',
    'System.Collections.Immutable',
    'System.Linq.Expressions',
    'System.Reflection.Metadata',
  ]) {
    assert.match(hostProject, new RegExp(`\\$\\(TargetDir\\)${assembly}\\.dll`, 'u'));
  }
  assert.match(hostProject, /@\(TraceClrAlgorithmCompilerAssembly/u);
});

test('TraceCLR wire boundary is explicit and its exceptions are reviewed', () => {
  const contracts = profile.sources.flatMap((source) =>
    source.wireContracts.map((contract) => ({ source: source.path, ...contract }))
  );
  assert.ok(contracts.length >= profile.sources.length);
  assert.deepEqual(
    [...new Set(contracts.filter((contract) => !contract.supported).map((contract) => contract.source))],
    ['accounts-merge.cs', 'currency-arbitrage-detector.cs', 'mini-parser.cs']
  );
  for (const contract of contracts.filter((candidate) => candidate.supported)) {
    assert.deepEqual(contract.unsupportedTypes, [], `${contract.source}: ${contract.signature}`);
  }
  assert.equal(contracts.filter((contract) => contract.directDriverSupported).length, 230);
  for (const contract of contracts) {
    if (contract.directDriverSupported) {
      assert.equal(contract.kind, 'method', `${contract.source}: ${contract.signature}`);
      assert.equal(contract.supported, true, `${contract.source}: ${contract.signature}`);
      assert.deepEqual(contract.directDriverUnsupportedReasons, []);
    } else {
      assert.ok(
        contract.directDriverUnsupportedReasons.length > 0,
        `${contract.source}: ${contract.signature} has no direct-driver reason`
      );
    }
  }
});
