#!/usr/bin/env npx tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CppConformanceEntryStyle, CppConformanceFixture } from '../tests/conformance/cpp-fixtures';
import type { CppConformanceRunResult, CppExecutionResult } from '../tests/conformance/cpp-runner';
import { runCppConformanceFixtureInIsolatedProcess } from '../tests/conformance/cpp-runner';

const DEFAULT_OUTPUT_PATH = 'tests/conformance/generated/cpp-fixtures.json';
const DEFAULT_FAILURE_DIR = 'reports/conformance-failures/cpp';
const DEFAULT_FIXTURE_TIMEOUT_MS = 15_000;
const ENTRY_STYLES = new Set<CppConformanceEntryStyle>([
  'solution_instance_method',
  'solution_static_method',
  'helper_methods',
  'private_state',
  'top_level_types',
  'nested_types',
]);

interface ImportArgs {
  inputPath: string;
  outputPath: string;
  failureDir: string;
  append: boolean;
  dryRun: boolean;
  failOnReject: boolean;
  limit?: number;
  fixtureTimeoutMs: number;
}

interface RejectedFixture {
  index: number;
  id: string;
  reason: string;
  fixture: unknown;
  validationErrors?: string[];
  run?: CppConformanceRunResult;
}

function usage(): string {
  return [
    'Usage: tsx scripts/import-cpp-conformance-fixtures.ts --input fixtures.json [options]',
    '',
    'Options:',
    `  --out <path>          Passing fixture JSON output. Default: ${DEFAULT_OUTPUT_PATH}`,
    `  --failure-dir <path>  Rejected fixture reports. Default: ${DEFAULT_FAILURE_DIR}`,
    '  --append              Merge passing fixtures into an existing output file by id.',
    '  --limit <n>           Validate only the first n candidates.',
    `  --fixture-timeout-ms <n>  Kill an individual fixture run after n milliseconds. Default: ${DEFAULT_FIXTURE_TIMEOUT_MS}`,
    '  --dry-run             Validate and write failure reports, but do not write passing fixtures.',
    '  --fail-on-reject      Exit nonzero if any candidate is rejected.',
    '  --help                Show this help.',
    '',
    'Use --input - to read the JSON array from stdin.',
  ].join('\n');
}

function readOption(argv: string[], name: string): string | undefined {
  const equalsPrefix = `--${name}=`;
  const equalsValue = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function positionalArgs(argv: string[]): string[] {
  const optionsWithValues = new Set(['--input', '--out', '--failure-dir', '--limit', '--fixture-timeout-ms']);
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (optionsWithValues.has(arg)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function parseArgs(argv: string[]): ImportArgs {
  if (hasFlag(argv, 'help')) {
    console.log(usage());
    process.exit(0);
  }

  const positionalInput = positionalArgs(argv)[0];
  const inputPath = readOption(argv, 'input') || positionalInput;
  if (!inputPath) {
    throw new Error(`${usage()}\n\nMissing --input.`);
  }

  const limitRaw = readOption(argv, 'limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && (!Number.isInteger(limit) || Number(limit) < 1)) {
    throw new Error(`--limit must be a positive integer, received ${limitRaw}`);
  }
  const fixtureTimeoutRaw = readOption(argv, 'fixture-timeout-ms');
  const fixtureTimeoutMs = fixtureTimeoutRaw === undefined ? DEFAULT_FIXTURE_TIMEOUT_MS : Number(fixtureTimeoutRaw);
  if (!Number.isInteger(fixtureTimeoutMs) || fixtureTimeoutMs < 1) {
    throw new Error(`--fixture-timeout-ms must be a positive integer, received ${fixtureTimeoutRaw}`);
  }

  return {
    inputPath,
    outputPath: readOption(argv, 'out') || DEFAULT_OUTPUT_PATH,
    failureDir: readOption(argv, 'failure-dir') || DEFAULT_FAILURE_DIR,
    append: hasFlag(argv, 'append'),
    dryRun: hasFlag(argv, 'dry-run'),
    failOnReject: hasFlag(argv, 'fail-on-reject'),
    fixtureTimeoutMs,
    ...(limit !== undefined ? { limit } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateCandidate(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['fixture must be an object'];

  const stringFields = ['id', 'title', 'entryStyle', 'methodName', 'source', 'notes'];
  for (const field of stringFields) {
    if (typeof value[field] !== 'string' || String(value[field]).trim().length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (typeof value.id === 'string' && !/^cpp(?:[0-9]+)?_[a-z0-9_]+$/.test(value.id)) {
    errors.push('id must match /^cpp(?:[0-9]+)?_[a-z0-9_]+$/');
  }
  if (typeof value.entryStyle === 'string' && !ENTRY_STYLES.has(value.entryStyle as CppConformanceEntryStyle)) {
    errors.push(`entryStyle must be one of ${[...ENTRY_STYLES].join(', ')}`);
  }
  if (!isRecord(value.input)) {
    errors.push('input must be an object');
  }
  if (!hasOwn(value, 'expectedReturn')) {
    errors.push('expectedReturn is required');
  }
  if (!isRecord(value.expectedMutations)) {
    errors.push('expectedMutations must be an object');
  }
  if (!Array.isArray(value.coverage) || value.coverage.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    errors.push('coverage must be an array of non-empty strings');
  }
  if (typeof value.source === 'string' && /\bmain\s*\(/.test(value.source)) {
    errors.push('source must not define main(); method-call conformance does not use stdin/stdout programs');
  }
  if (typeof value.source === 'string' && /\bstd::vector\s*\[/.test(value.source)) {
    errors.push('source contains std::vector[...] syntax; use std::vector<...> for C++ templates');
  }
  return errors;
}

function normalizeCandidate(value: Record<string, unknown>): CppConformanceFixture {
  const fixture: CppConformanceFixture = {
    id: String(value.id).trim(),
    title: String(value.title).trim(),
    entryStyle: value.entryStyle as CppConformanceEntryStyle,
    methodName: String(value.methodName).trim(),
    source: String(value.source),
    input: value.input as Record<string, unknown>,
    expectedReturn: value.expectedReturn,
    expectedMutations: value.expectedMutations as Record<string, unknown>,
    coverage: (value.coverage as string[]).map((entry) => entry.trim()),
    notes: String(value.notes).trim(),
  };
  if (hasOwn(value, 'expectedHarnessOutput')) {
    fixture.expectedHarnessOutput = value.expectedHarnessOutput;
  }
  return fixture;
}

async function readJsonInput(inputPath: string): Promise<unknown> {
  const text = inputPath === '-' ? await readFile(0, 'utf8') : await readFile(inputPath, 'utf8');
  return JSON.parse(text);
}

async function readExistingFixtures(outputPath: string): Promise<CppConformanceFixture[]> {
  try {
    const value = JSON.parse(await readFile(outputPath, 'utf8'));
    return Array.isArray(value) ? value as CppConformanceFixture[] : [];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function mergeFixtures(existing: CppConformanceFixture[], incoming: CppConformanceFixture[]): CppConformanceFixture[] {
  const byId = new Map<string, CppConformanceFixture>();
  for (const fixture of existing) byId.set(fixture.id, fixture);
  for (const fixture of incoming) byId.set(fixture.id, fixture);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function safeReportId(id: string, index: number): string {
  const safeId = id.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'unknown';
  return `${String(index + 1).padStart(3, '0')}-${safeId}`;
}

function summarizeExecutionResult(result: CppExecutionResult | undefined): unknown {
  if (!result) return undefined;
  const { trace, ...rest } = result;
  return {
    ...rest,
    ...(trace
      ? {
          trace: {
            eventCount: Array.isArray(trace.events) ? trace.events.length : 0,
            lineEventCount: trace.lineEventCount,
            traceStepCount: trace.traceStepCount,
            firstEvents: Array.isArray(trace.events) ? trace.events.slice(0, 20) : [],
          },
        }
      : {}),
  };
}

async function writeRejectedFixtureReport(args: ImportArgs, rejected: RejectedFixture): Promise<void> {
  await mkdir(args.failureDir, { recursive: true });
  const reportPath = join(args.failureDir, `${safeReportId(rejected.id, rejected.index)}.json`);
  const report = {
    index: rejected.index,
    id: rejected.id,
    reason: rejected.reason,
    validationErrors: rejected.validationErrors,
    fixture: rejected.fixture,
    expectedOutput: rejected.run?.expectedOutput,
    phase: rejected.run?.phase,
    error: rejected.run?.error,
    untraced: summarizeExecutionResult(rejected.run?.untraced),
    traced: summarizeExecutionResult(rejected.run?.traced),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function writeSummary(args: ImportArgs, accepted: CppConformanceFixture[], rejected: RejectedFixture[]): Promise<void> {
  await mkdir(args.failureDir, { recursive: true });
  const summary = {
    accepted: accepted.length,
    rejected: rejected.length,
    outputPath: args.dryRun ? null : args.outputPath,
    failures: rejected.map((entry) => ({
      index: entry.index,
      id: entry.id,
      reason: entry.reason,
      phase: entry.run?.phase,
      error: entry.run?.error,
      validationErrors: entry.validationErrors,
    })),
  };
  await writeFile(join(args.failureDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

const args = parseArgs(process.argv.slice(2));
const rawCandidates = await readJsonInput(args.inputPath);
if (!Array.isArray(rawCandidates)) {
  throw new Error('Input must be a JSON array of fixture candidates.');
}

const candidates = args.limit ? rawCandidates.slice(0, args.limit) : rawCandidates;
const accepted: CppConformanceFixture[] = [];
const rejected: RejectedFixture[] = [];

for (const [index, candidate] of candidates.entries()) {
  const id = isRecord(candidate) && typeof candidate.id === 'string' ? candidate.id : `candidate_${index + 1}`;
  const validationErrors = validateCandidate(candidate);
  if (validationErrors.length > 0) {
    rejected.push({ index, id, reason: 'validation', fixture: candidate, validationErrors });
    console.log(`REJECT: ${id} validation (${validationErrors.join('; ')})`);
    continue;
  }

  const fixture = normalizeCandidate(candidate as Record<string, unknown>);
  console.log(`RUN: C++ conformance import ${fixture.id}`);
  const run = await runCppConformanceFixtureInIsolatedProcess(fixture, {
    includeGeneratedSource: true,
    timeoutMs: args.fixtureTimeoutMs,
  });
  if (run.success) {
    accepted.push(fixture);
    console.log(`ACCEPT: ${fixture.id}`);
  } else {
    rejected.push({ index, id: fixture.id, reason: 'runtime', fixture, run });
    console.log(`REJECT: ${fixture.id} ${run.phase || 'runtime'} (${run.error || 'unknown error'})`);
  }
}

for (const entry of rejected) {
  await writeRejectedFixtureReport(args, entry);
}
await writeSummary(args, accepted, rejected);

if (!args.dryRun) {
  const existing = args.append ? await readExistingFixtures(args.outputPath) : [];
  const output = args.append ? mergeFixtures(existing, accepted) : accepted;
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

console.log(
  `C++ conformance import complete: accepted=${accepted.length}, rejected=${rejected.length}` +
    (args.dryRun ? ', dry-run=true' : `, output=${args.outputPath}`)
);

if (args.failOnReject && rejected.length > 0) {
  process.exitCode = 1;
}
