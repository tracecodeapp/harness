import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeTraceClrWireResult,
  encodeTraceClrWireInputs,
  type TraceClrWireContractDescriptor,
} from '../packages/runtime-csharp/src/traceclr-wire';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return resolve(value);
}

const profilePath = required('--profile');
const selectionPath = required('--selection');
const driversDirectory = required('--drivers');
const expectation = option('--expect', 'valid');
if (expectation !== 'valid' && expectation !== 'invalid') throw new Error('--expect must be valid or invalid.');
const limit = Number(option('--limit', '0'));
if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--limit must be a non-negative integer.');
const timeoutMs = Number(option('--timeout-ms', '2000'));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer.');

const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
const driverManifest = JSON.parse(readFileSync(join(driversDirectory, 'manifest.json'), 'utf8'));
const sources = new Map(profile.sources.map((source: { path: string }) => [source.path, source]));
const artifactsBySource = new Map<string, Array<{ signature: string; file: string }>>();
for (const artifact of driverManifest.artifacts) {
  const values = artifactsBySource.get(artifact.sourcePath) ?? [];
  values.push(artifact);
  artifactsBySource.set(artifact.sourcePath, values);
}

const skipped: Array<{ id: string; reason: string }> = [];
const prepared: Array<{
  id: string;
  contract: TraceClrWireContractDescriptor;
  expectedOutput: unknown;
  compareMode: string;
  assemblyPath: string;
  inputBase64: string;
}> = [];
for (const selected of selection.selection) {
  const source = sources.get(`${selected.id}.cs`) as {
    wireContracts?: Array<TraceClrWireContractDescriptor & { signature: string; directDriverSupported: boolean }>;
  } | undefined;
  const direct = (source?.wireContracts ?? []).filter((contract) => contract.directDriverSupported);
  const artifacts = artifactsBySource.get(`${selected.id}.cs`) ?? [];
  if (direct.length !== 1 || artifacts.length !== 1 || direct[0].signature !== artifacts[0].signature) {
    skipped.push({ id: selected.id, reason: 'ambiguous or unsupported direct driver' });
    continue;
  }
  try {
    const input = encodeTraceClrWireInputs(direct[0], selected.inputs ?? {});
    prepared.push({
      id: selected.id,
      contract: direct[0],
      expectedOutput: selected.expectedOutput,
      compareMode: selected.compareMode ?? 'exact',
      assemblyPath: join(driversDirectory, artifacts[0].file),
      inputBase64: Buffer.from(input).toString('base64'),
    });
  } catch (error) {
    skipped.push({ id: selected.id, reason: error instanceof Error ? error.message : String(error) });
  }
  if (limit > 0 && prepared.length >= limit) break;
}
if (prepared.length === 0) throw new Error('No TraceCLR corpus rows have an executable direct driver.');

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Set) return [...value].map(normalize);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const tagged = value as { __type__?: string; val?: unknown; next?: unknown; left?: unknown; right?: unknown };
    if (tagged.__type__ === 'ListNode') {
      const values: unknown[] = [];
      let node: typeof tagged | null = tagged;
      const seen = new Set<object>();
      while (node !== null) {
        if (seen.has(node)) throw new Error('Expected ListNode is cyclic.');
        seen.add(node);
        values.push(normalize(node.val));
        node = node.next === null || node.next === undefined ? null : node.next as typeof tagged;
      }
      return values;
    }
    if (tagged.__type__ === 'TreeNode') {
      const values: unknown[] = [];
      const nodes: Array<typeof tagged | null> = [tagged];
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (node === null) { values.push(null); continue; }
        values.push(normalize(node.val));
        nodes.push(node.left === null || node.left === undefined ? null : node.left as typeof tagged);
        nodes.push(node.right === null || node.right === undefined ? null : node.right as typeof tagged);
      }
      while (values.at(-1) === null) values.pop();
      return values;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

function canonical(value: unknown, compareMode: string): string {
  const normalized = normalize(value);
  if (compareMode === 'unordered-array' && Array.isArray(normalized)) {
    return JSON.stringify([...normalized].map((item) => JSON.stringify(item)).sort());
  }
  return JSON.stringify(normalized);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'traceclr-native-probe-'));
try {
  const projectPath = join(root, 'tools/TraceCode.TraceClrNativeProbe/TraceCode.TraceClrNativeProbe.csproj');
  const build = spawnSync('dotnet', ['build', projectPath, '-c', 'Release', '--nologo'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`TraceCLR native probe build failed:\n${build.stderr || build.stdout}`);
  const probePath = join(root, 'tools/TraceCode.TraceClrNativeProbe/bin/Release/net10.0/TraceCode.TraceClrNativeProbe.dll');
  const nativeResults: Array<{ id: string; outputBase64?: string; error?: string; elapsedMs?: number }> = [];
  const timedOut: string[] = [];
  for (const [index, item] of prepared.entries()) {
    const manifestPath = join(temporaryDirectory, `${index}.manifest.json`);
    const resultsPath = join(temporaryDirectory, `${index}.results.json`);
    writeFileSync(manifestPath, `${JSON.stringify({
      schema: 'tracecode.traceclr-native-probe.v1',
      cases: [{ id: item.id, assemblyPath: item.assemblyPath, inputBase64: item.inputBase64 }],
    })}\n`);
    const run = spawnSync('dotnet', [probePath, manifestPath, resultsPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (run.error && 'code' in run.error && run.error.code === 'ETIMEDOUT') {
      timedOut.push(item.id);
      continue;
    }
    if (!run.error && run.signal === 'SIGKILL') {
      timedOut.push(item.id);
      continue;
    }
    if (run.error) throw run.error;
    const resultDocument = JSON.parse(readFileSync(resultsPath, 'utf8'));
    nativeResults.push(...resultDocument.results);
  }
  const preparedById = new Map(prepared.map((value) => [value.id, value]));
  let matches = 0;
  let mismatches = 0;
  const errors: Array<{ id: string; error: string }> = [];
  const samples: Array<{ id: string; expected: unknown; actual: unknown }> = [];
  const timings: number[] = [];
  for (const result of nativeResults) {
    const item = preparedById.get(result.id)!;
    timings.push(result.elapsedMs);
    if (result.error) {
      errors.push({ id: result.id, error: result.error });
      continue;
    }
    const actual = decodeTraceClrWireResult(item.contract, Buffer.from(result.outputBase64, 'base64'));
    if (canonical(actual, item.compareMode) === canonical(item.expectedOutput, item.compareMode)) {
      matches++;
    } else {
      mismatches++;
      if (samples.length < 10) samples.push({ id: result.id, expected: item.expectedOutput, actual: normalize(actual) });
    }
  }
  timings.sort((left, right) => left - right);
  const summary = {
    schema: 'tracecode.traceclr-corpus-execution.v1',
    expectation,
    selected: selection.selectedSources,
    executed: prepared.length,
    skipped: skipped.length,
    matches,
    mismatches,
    executionErrors: errors.length,
    timeouts: timedOut.length,
    medianNativeExecuteMs: timings[Math.floor(timings.length / 2)],
    p95NativeExecuteMs: timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))],
    mismatchSamples: samples,
    errorSamples: errors.slice(0, 10),
    timeoutSamples: timedOut.slice(0, 10),
    skippedSamples: skipped.slice(0, 10),
  };
  console.log(JSON.stringify(summary, null, 2));
  const invalidBehaviors = mismatches + errors.length + timedOut.length;
  if (expectation === 'valid' ? invalidBehaviors > 0 : invalidBehaviors === 0) process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
