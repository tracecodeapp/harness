import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function fixture(directory, id, functionName, source) {
  writeFileSync(join(directory, 'sources', `${id}.cs`), source);
  writeFileSync(join(directory, 'problems', `${id}.json`), `${JSON.stringify({ functionName })}\n`);
}

function generate(directory, drivers = false) {
  const output = join(directory, 'profile.json');
  const args = [
    'scripts/generate-traceclr-algorithm-profile.mjs',
    '--corpus-root', join(directory, 'sources'),
    '--problem-dir', join(directory, 'problems'),
    '--output', output,
    '--props-output', join(directory, 'profile.props'),
  ];
  if (drivers) args.push('--driver-output-dir', join(directory, 'drivers'));
  const result = spawnSync('node', args, { cwd: root, encoding: 'utf8' });
  return { result, profile: JSON.parse(readFileSync(output, 'utf8')) };
}

test('TraceCLR direct driver supports HashSet and fails closed on unsupported signatures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'traceclr-profile-policy-valid-'));
  try {
    mkdirSync(join(directory, 'sources'));
    mkdirSync(join(directory, 'problems'));
    fixture(directory, 'hashset', 'Unique', `
public class Solution
{
    public HashSet<int> Unique(int[] values) => new(values);
}
`);
    fixture(directory, 'ref-parameter', 'Bump', `
public class Solution
{
    public int Bump(ref int value) => ++value;
}
`);
    fixture(directory, 'multidimensional', 'Echo', `
public class Solution
{
    public int[,] Echo(int[,] value) => value;
}
`);
    fixture(directory, 'generic', 'Echo', `
public class Solution
{
    public T Echo<T>(T value) => value;
}
`);
    fixture(directory, 'list-node', 'Head', `
public class Solution
{
    public int Head(ListNode head) => head.val;
}
`);
    fixture(directory, 'tree-node', 'Root', `
public class Solution
{
    public int Root(TreeNode root) => root.val;
}
`);
    fixture(directory, 'optional-parameter', 'Add', `
public class Solution
{
    public int Add(int value, int increment = 1) => value + increment;
}
`);
    fixture(directory, 'deferred-enumerable', 'Expand', `
public class Solution
{
    public IEnumerable<int> Expand(int count) => Enumerable.Range(0, count);
}
`);
    const { result, profile } = generate(directory, true);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const contracts = new Map(profile.sources.map((source) => [source.path, source.wireContracts[0]]));
    assert.equal(contracts.get('hashset.cs').returnType.wireType, 'set<int32>');
    assert.equal(contracts.get('hashset.cs').directDriverSupported, true);
    assert.equal(contracts.get('ref-parameter.cs').supported, false);
    assert.match(contracts.get('ref-parameter.cs').unsupportedTypes.join('\n'), /ref parameter value/);
    assert.equal(contracts.get('multidimensional.cs').directDriverSupported, false);
    assert.match(contracts.get('multidimensional.cs').unsupportedTypes.join('\n'), /int\[,\]/);
    assert.equal(contracts.get('generic.cs').directDriverSupported, false);
    assert.match(contracts.get('generic.cs').directDriverUnsupportedReasons.join('\n'), /generic method/);
    assert.equal(contracts.get('list-node.cs').directDriverSupported, false);
    assert.match(
      contracts.get('list-node.cs').directDriverUnsupportedReasons.join('\n'),
      /reference-bearing node topology requires the compatibility runner/,
    );
    assert.equal(contracts.get('tree-node.cs').directDriverSupported, false);
    assert.match(
      contracts.get('tree-node.cs').directDriverUnsupportedReasons.join('\n'),
      /reference-bearing node topology requires the compatibility runner/,
    );
    assert.equal(contracts.get('optional-parameter.cs').directDriverSupported, false);
    assert.match(
      contracts.get('optional-parameter.cs').directDriverUnsupportedReasons.join('\n'),
      /optional parameter increment requires the compatibility runner/,
    );
    assert.equal(contracts.get('deferred-enumerable.cs').directDriverSupported, false);
    assert.match(
      contracts.get('deferred-enumerable.cs').directDriverUnsupportedReasons.join('\n'),
      /deferred IEnumerable result requires the compatibility runner/,
    );
    const manifest = JSON.parse(readFileSync(join(directory, 'drivers', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.sourcePath), ['hashset.cs']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('TraceCLR algorithm profile rejects syntax failures and forbidden process, file, and network APIs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'traceclr-profile-policy-denied-'));
  try {
    mkdirSync(join(directory, 'sources'));
    mkdirSync(join(directory, 'problems'));
    fixture(directory, 'network', 'Fetch', `
public class Solution
{
    public string Fetch(string url) => new System.Net.Http.HttpClient().GetStringAsync(url).Result;
}
`);
    fixture(directory, 'file', 'Read', `
public class Solution
{
    public string Read(string path) => System.IO.File.ReadAllText(path);
}
`);
    fixture(directory, 'process', 'Exit', `
public class Solution
{
    public int Exit(int code) { System.Environment.Exit(code); return code; }
}
`);
    fixture(directory, 'syntax', 'Broken', `
public class Solution
{
    public int Broken(int value) => value
}
`);
    const { result, profile } = generate(directory);
    assert.equal(result.status, 1);
    const diagnostics = profile.failures.flatMap((failure) => failure.diagnostics).join('\n');
    assert.match(diagnostics, /Denied assembly references: System.Net.Http/);
    assert.match(diagnostics, /Denied type references: System.IO.File/);
    assert.match(diagnostics, /Denied member references: System.Environment::Exit/);
    assert.match(diagnostics, /CS1002/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
