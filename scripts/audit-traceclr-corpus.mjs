import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return args[index + 1];
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

const corpusPath = resolve(requiredOption('--corpus'));
const outputPath = resolve(requiredOption('--output'));
const driversOutput = option('--drivers-output');
const limitText = option('--limit', '0');
const limit = Number(limitText);
if (!Number.isSafeInteger(limit) || limit < 0) {
  throw new Error(`--limit must be a non-negative integer, received ${limitText}.`);
}
if (!existsSync(corpusPath)) throw new Error(`TraceCLR corpus does not exist: ${corpusPath}`);

async function readRows(path) {
  if (extname(path) === '.jsonl') {
    const rows = [];
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
    return rows;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('TraceCLR corpus JSON must be an array.');
  return parsed;
}

function stableKey(row) {
  return createHash('sha256')
    .update(`${row.slug ?? ''}\0${row.solutionId ?? ''}\0${row.source?.path ?? ''}`)
    .digest('hex');
}

function selectProblemBalanced(rows, maximum) {
  const groups = new Map();
  for (const row of rows) {
    const slug = row.slug ?? '<unknown>';
    const group = groups.get(slug) ?? [];
    group.push(row);
    groups.set(slug, group);
  }
  for (const group of groups.values()) group.sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const selected = [];
  for (let index = 0; selected.length < maximum; index++) {
    let added = false;
    for (const [, group] of orderedGroups) {
      if (index < group.length) {
        selected.push(group[index]);
        added = true;
        if (selected.length === maximum) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

const rows = (await readRows(corpusPath)).filter((row) => row.language === 'csharp');
const deduplicated = [...new Map(rows.map((row) => [row.source?.path, row])).values()]
  .filter((row) => typeof row.source?.path === 'string')
  .sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
const selected = limit === 0 || limit >= deduplicated.length
  ? deduplicated
  : selectProblemBalanced(deduplicated, limit);
if (selected.length === 0) throw new Error('TraceCLR corpus contains no C# entries.');

const missing = selected.filter((row) => !existsSync(row.source.path));
if (missing.length > 0) {
  throw new Error(
    `TraceCLR corpus has ${missing.length} missing C# sources; first: ${missing[0].source.path}`
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'traceclr-corpus-audit-'));
const sourceDirectory = join(temporaryDirectory, 'sources');
const problemDirectory = join(temporaryDirectory, 'problems');
const profileOutput = outputPath;
const propsOutput = `${outputPath}.props`;
const selectionOutput = `${outputPath}.selection.json`;
try {
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(problemDirectory, { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  const selection = selected.map((row, index) => {
    const id = `${String(index).padStart(6, '0')}-${stableKey(row).slice(0, 16)}`;
    symlinkSync(resolve(row.source.path), join(sourceDirectory, `${id}.cs`));
    writeFileSync(
      join(problemDirectory, `${id}.json`),
      `${JSON.stringify({ functionName: row.functionName ?? null })}\n`
    );
    return {
      id,
      slug: row.slug,
      solutionId: row.solutionId,
      functionName: row.functionName,
      runtimeExecutionStyle: row.runtimeExecutionStyle,
      sourcePath: row.source.path,
      sourceKind: row.source.kind,
      inputs: row.inputs,
      expectedOutput: row.expectedOutput,
      compareMode: row.compareMode,
      acceptance: row.generation?.acceptance,
      mutationType: row.generation?.mutationType,
    };
  });
  writeFileSync(selectionOutput, `${JSON.stringify({
    schema: 'tracecode.traceclr-corpus-selection.v1',
    corpusPath,
    inputCSharpRows: rows.length,
    uniqueCSharpSources: deduplicated.length,
    selectedSources: selection.length,
    problems: new Set(selected.map((row) => row.slug)).size,
    selection,
  }, null, 2)}\n`);

  const generatorArgs = [
    join(root, 'scripts/generate-traceclr-algorithm-profile.mjs'),
    '--corpus-root', sourceDirectory,
    '--problem-dir', problemDirectory,
    '--output', profileOutput,
    '--props-output', propsOutput,
  ];
  if (driversOutput) generatorArgs.push('--driver-output-dir', resolve(driversOutput));
  const result = spawnSync('node', generatorArgs, { cwd: root, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (!existsSync(profileOutput)) {
    throw new Error('TraceCLR corpus generator did not produce a profile.');
  }

  const profile = JSON.parse(readFileSync(profileOutput, 'utf8'));
  const contracts = profile.sources.flatMap((source) => source.wireContracts ?? []);
  const summary = {
    schema: 'tracecode.traceclr-corpus-audit-summary.v1',
    corpusPath,
    profilePath: profileOutput,
    selectionPath: selectionOutput,
    propsPath: propsOutput,
    inputCSharpRows: rows.length,
    uniqueCSharpSources: deduplicated.length,
    selectedSources: selected.length,
    selectedProblems: new Set(selected.map((row) => row.slug)).size,
    compiledSources: profile.corpus.compiledSourceCount,
    compilationFailures: profile.corpus.failureCount,
    directAssemblyReferences: profile.directAssemblyReferences,
    wireContracts: contracts.length,
    supportedWireContracts: contracts.filter((contract) => contract.supported).length,
    unsupportedWireContracts: contracts.filter((contract) => !contract.supported).length,
  };
  writeFileSync(`${outputPath}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = result.status ?? 0;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
