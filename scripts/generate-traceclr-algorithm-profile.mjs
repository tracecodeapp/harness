import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const driverOutputDirectory = option('--driver-output-dir');

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return args[index + 1];
}

const configPath = join(root, 'packages/runtime-csharp/traceclr-algorithm-profile.config.json');
const profilePath = join(root, 'packages/runtime-csharp/traceclr-algorithm-profile.json');
const propsPath = join(root, 'packages/runtime-csharp/dotnet/TraceClr.AlgorithmProfile.props');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const customCorpusRoot = option('--corpus-root');
const customProblemDirectory = option('--problem-dir');
if (Boolean(customCorpusRoot) !== Boolean(customProblemDirectory)) {
  throw new Error('--corpus-root and --problem-dir must be provided together.');
}
const productRoot = customCorpusRoot
  ? undefined
  : resolve(
      option('--product-root')
        ?? process.env.TRACECODE_PRODUCT_ROOT
        ?? join(root, '..', '..', 'algoflow')
    );
const corpusRoot = resolve(customCorpusRoot ?? join(
  productRoot,
  'data/reference-solutions/csharp/practice'
));
const problemDirectory = resolve(customProblemDirectory ?? join(productRoot, 'data/problems'));
for (const required of [corpusRoot, problemDirectory]) {
  if (!existsSync(required)) {
    throw new Error(
      `TraceCLR product corpus is unavailable at ${required}. `
      + 'Set TRACECODE_PRODUCT_ROOT or pass --product-root.'
    );
  }
}

const runtimes = spawnSync('dotnet', ['--list-runtimes'], { encoding: 'utf8' });
if (runtimes.status !== 0) {
  throw new Error(`dotnet --list-runtimes failed: ${runtimes.stderr || runtimes.stdout}`);
}
const targetMajor = Number(/^net(\d+)\./.exec(config.targetFramework)?.[1]);
const candidates = runtimes.stdout
  .split(/\r?\n/u)
  .map((line) => /^Microsoft\.NETCore\.App (\S+) \[(.+)\]$/u.exec(line))
  .filter(Boolean)
  .map((match) => ({ version: match[1], base: match[2] }))
  .filter(({ version }) => Number(version.split('.')[0]) === targetMajor)
  .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
const runtime = candidates.at(-1);
if (!runtime) {
  throw new Error(`No Microsoft.NETCore.App runtime matches ${config.targetFramework}.`);
}
const runtimeDirectory = join(runtime.base, runtime.version);
const dotnetRoot = dirname(dirname(runtime.base));
const referencePackRoot = join(dotnetRoot, 'packs/Microsoft.NETCore.App.Ref');
const referenceVersions = readdirSync(referencePackRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && Number(entry.name.split('.')[0]) === targetMajor)
  .map((entry) => entry.name)
  .filter((version) => existsSync(join(referencePackRoot, version, 'ref', config.targetFramework)))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
const referenceVersion = referenceVersions.includes(runtime.version)
  ? runtime.version
  : referenceVersions.at(-1);
if (!referenceVersion) {
  throw new Error(`No Microsoft.NETCore.App.Ref pack matches ${config.targetFramework}.`);
}
const referenceDirectory = join(
  referencePackRoot,
  referenceVersion,
  'ref',
  config.targetFramework
);

let temporaryDirectory;
try {
  temporaryDirectory = check ? mkdtempSync(join(tmpdir(), 'traceclr-profile-check-')) : undefined;
  const requestedOutput = option('--output');
  const requestedPropsOutput = option('--props-output');
  if (check && (requestedOutput || requestedPropsOutput || customCorpusRoot || driverOutputDirectory)) {
    throw new Error('--check only verifies the committed product profile.');
  }
  if (Boolean(requestedOutput) !== Boolean(requestedPropsOutput)) {
    throw new Error('--output and --props-output must be provided together.');
  }
  if (customCorpusRoot && !requestedOutput) {
    throw new Error('A custom corpus requires --output and --props-output.');
  }
  const generatedProfile = check
    ? join(temporaryDirectory, 'profile.json')
    : resolve(requestedOutput ?? profilePath);
  const generatedProps = check
    ? join(temporaryDirectory, 'profile.props')
    : resolve(requestedPropsOutput ?? propsPath);
  const generatorArgs = [
    'run',
    '--project', join(root, 'tools/TraceCode.TraceClrProfile/TraceCode.TraceClrProfile.csproj'),
    '--',
    '--corpus-root', corpusRoot,
    '--problem-dir', problemDirectory,
    '--reference-dir', referenceDirectory,
    '--runtime-dir', runtimeDirectory,
    '--config', configPath,
    '--output', generatedProfile,
    '--props-output', generatedProps,
  ];
  if (driverOutputDirectory) {
    generatorArgs.push('--driver-output-dir', resolve(driverOutputDirectory));
  }
  const result = spawnSync('dotnet', generatorArgs, { cwd: root, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);

  if (check) {
    const mismatches = [
      [profilePath, generatedProfile],
      [propsPath, generatedProps],
    ].filter(([committed, generated]) => readFileSync(committed, 'utf8') !== readFileSync(generated, 'utf8'));
    if (mismatches.length > 0) {
      throw new Error(
        'TraceCLR algorithm profile is stale: '
        + mismatches.map(([committed]) => committed.slice(root.length + 1)).join(', ')
        + '. Run pnpm generate:traceclr-profile.'
      );
    }
    console.log('TraceCLR algorithm profile matches the product corpus.');
  }
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
