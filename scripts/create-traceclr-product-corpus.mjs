import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

const productRootOption = option('--product-root', process.env.TRACECODE_PRODUCT_ROOT);
const outputOption = option('--output');
if (!productRootOption || !outputOption) {
  throw new Error('Usage: create-traceclr-product-corpus --product-root <algoflow> --output <json>');
}
const productRoot = resolve(productRootOption);
const output = resolve(outputOption);
const sources = join(productRoot, 'data/reference-solutions/csharp/practice');
const problems = join(productRoot, 'data/problems');
if (!existsSync(sources) || !existsSync(problems)) throw new Error(`Invalid product root: ${productRoot}`);

const rows = [];
const skipped = [];
for (const entry of readdirSync(sources, { withFileTypes: true }).filter((value) => value.isFile() && value.name.endsWith('.cs'))) {
  const id = basename(entry.name, '.cs');
  const problemPath = join(problems, `${id}.json`);
  if (!existsSync(problemPath)) {
    skipped.push({ id, reason: 'missing problem metadata' });
    continue;
  }
  const problem = JSON.parse(readFileSync(problemPath, 'utf8'));
  if (problem.compareMode === 'any-valid') {
    skipped.push({ id, reason: 'requires product custom validator' });
    continue;
  }
  const testCase = problem.testCases?.find((value) => value && typeof value.input === 'object' && 'expected' in value);
  if (!testCase) {
    skipped.push({ id, reason: 'no concrete test case' });
    continue;
  }
  rows.push({
    slug: id,
    solutionId: `tracecode-product-reference:${id}:${testCase.id ?? 'first'}`,
    language: 'csharp',
    functionName: problem.functionName,
    runtimeExecutionStyle: problem.executionStyle ?? 'solution-method',
    compareMode: problem.compareMode ?? 'exact',
    source: { kind: 'tracecode-product-reference', path: join(sources, entry.name) },
    inputs: testCase.input,
    expectedOutput: testCase.expected,
    productTestId: testCase.id ?? null,
    customValidator: testCase.customValidator ?? null,
  });
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify({
  schema: 'tracecode.traceclr-product-corpus-build.v1',
  productRoot,
  output,
  rows: rows.length,
  skipped: skipped.length,
  skippedSamples: skipped.slice(0, 10),
}, null, 2));
