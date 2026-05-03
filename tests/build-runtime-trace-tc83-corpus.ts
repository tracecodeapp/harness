#!/usr/bin/env npx tsx

import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface Tc83Scenario {
  problemId: string;
}

interface ProblemJson {
  id?: string;
  patterns?: string[];
  compareMode?: string;
  functionName?: string;
  solutionCode?: string;
  testCases?: Array<{
    input?: Record<string, unknown>;
    expected?: unknown;
  }>;
}

type RuntimeEntry = {
  slug: string;
  family?: string;
  compareMode?: string;
  language: 'python' | 'javascript' | 'typescript' | 'csharp';
  supportExpectation: 'supported-now';
  functionName: string;
  source: { kind: 'file'; path: string };
  runtimeExecutionStyle: 'function' | 'solution-method' | 'ops-class';
  inputs: Record<string, unknown>;
  expectedOutput?: unknown;
};

function parseStringFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  const sourceRoot = resolve(parseStringFlag('source-root') ?? '/Users/obinnanwachukwu/Code/algoflow');
  const summaryPath = resolve(
    parseStringFlag('summary') ?? join(sourceRoot, 'tests', 'v3-corpus', 'tracecode83-semantic-baseline-summary.json')
  );
  const outPath = resolve(parseStringFlag('out') ?? join(process.cwd(), 'reports', 'runtime-trace-tc83-corpus.json'));
  const extractedSourceRoot = resolve(
    parseStringFlag('extracted-source-root') ?? join(process.cwd(), 'reports', 'runtime-trace-tc83-sources')
  );

  const summary = await readJson<{ scenarios: Tc83Scenario[] }>(summaryPath);
  rmSync(extractedSourceRoot, { recursive: true, force: true });

  const entries: RuntimeEntry[] = [];
  const missing: string[] = [];
  const opsClass: string[] = [];

  for (const scenario of summary.scenarios) {
    const slug = scenario.problemId;
    const problemPath = join(sourceRoot, 'data', 'problems', `${slug}.json`);
    if (!existsSync(problemPath)) {
      missing.push(`${slug}: missing problem JSON`);
      continue;
    }

    const problem = await readJson<ProblemJson>(problemPath);
    const testCase = problem.testCases?.[0];
    if (!problem.functionName || !problem.solutionCode || !testCase?.input) {
      missing.push(`${slug}: missing functionName, solutionCode, or first testcase input`);
      continue;
    }

    const isOpsClass = Array.isArray(testCase.input.operations) && Array.isArray(testCase.input.arguments);
    if (isOpsClass) opsClass.push(slug);

    const family = problem.patterns?.[0];
    const base = {
      slug,
      family,
      compareMode: problem.compareMode,
      supportExpectation: 'supported-now' as const,
      functionName: problem.functionName,
      inputs: testCase.input,
      ...(hasOwn(testCase, 'expected') ? { expectedOutput: testCase.expected } : {}),
    };

    const pythonSourcePath = join(extractedSourceRoot, slug, 'python.py');
    await mkdir(dirname(pythonSourcePath), { recursive: true });
    await writeFile(pythonSourcePath, problem.solutionCode, 'utf8');
    entries.push({
      ...base,
      language: 'python',
      source: { kind: 'file', path: pythonSourcePath },
      runtimeExecutionStyle: isOpsClass ? 'ops-class' : 'function',
    });

    const javascriptPath = join('data', 'reference-solutions', 'javascript', 'practice', `${slug}.js`);
    if (existsSync(join(sourceRoot, javascriptPath))) {
      entries.push({
        ...base,
        language: 'javascript',
        source: { kind: 'file', path: javascriptPath },
        runtimeExecutionStyle: isOpsClass ? 'ops-class' : 'solution-method',
      });
    } else {
      missing.push(`${slug}: missing JavaScript practice solution`);
    }

    const typescriptPath = join('data', 'reference-solutions', 'typescript', 'practice', `${slug}.ts`);
    if (existsSync(join(sourceRoot, typescriptPath))) {
      entries.push({
        ...base,
        language: 'typescript',
        source: { kind: 'file', path: typescriptPath },
        runtimeExecutionStyle: isOpsClass ? 'ops-class' : 'solution-method',
      });
    } else {
      missing.push(`${slug}: missing TypeScript practice solution`);
    }

    const csharpPath = join('data', 'reference-solutions', 'csharp', 'practice', `${slug}.cs`);
    if (existsSync(join(sourceRoot, csharpPath))) {
      entries.push({
        ...base,
        language: 'csharp',
        source: { kind: 'file', path: csharpPath },
        runtimeExecutionStyle: isOpsClass ? 'ops-class' : 'solution-method',
      });
    } else {
      missing.push(`${slug}: missing C# practice solution`);
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  console.log(`TC83 runtime corpus: groups=${new Set(entries.map((entry) => entry.slug)).size} entries=${entries.length}`);
  console.log(`Manifest: ${outPath}`);
  console.log(`Extracted Python sources: ${extractedSourceRoot}`);
  console.log(`Ops-class problems: ${opsClass.join(', ') || '(none)'}`);
  if (missing.length > 0) {
    console.log('Missing inputs:');
    for (const item of missing) console.log(`- ${item}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
