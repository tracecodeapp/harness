#!/usr/bin/env npx tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  TEMPLATE_PYTHON_CLASS_DEFINITIONS,
  TEMPLATE_PYTHON_CONVERSION_HELPERS,
  TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  TEMPLATE_PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION,
  TEMPLATE_PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION,
  TEMPLATE_PYTHON_TRACE_SERIALIZE_FUNCTION,
  TEMPLATE_PYTHON_SERIALIZE_FUNCTION,
  templateToPythonLiteral,
} from '../packages/harness-python/src/python-harness-template';

const CHECK_MODE = process.argv.includes('--check');

const GENERATED_TS_PATH = join(
  process.cwd(),
  'packages',
  'harness-python',
  'src',
  'generated',
  'python-harness-snippets.ts'
);

const GENERATED_WORKER_JS_PATH = join(
  process.cwd(),
  'workers',
  'python',
  'generated-python-harness-snippets.js'
);

function buildLiteralFunctionSource(
  name: string,
  options: { exported?: boolean } = {}
): string {
  const raw = templateToPythonLiteral.toString();
  const renamed = raw.replace(/\btemplateToPythonLiteral\b/g, name);
  const normalized = renamed.replace(`function ${name}`, `function ${name}`);
  if (options.exported) {
    return normalized.replace(`function ${name}`, `export function ${name}`);
  }
  return normalized;
}

function buildGeneratedTypeScript(): string {
  const toPythonLiteralSource = buildLiteralFunctionSource('toPythonLiteral', { exported: true });

  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Source: packages/harness-python/src/python-harness-template.ts
 * Generator: scripts/generate-python-harness-artifacts.ts
 */

// @ts-nocheck

${toPythonLiteralSource}

export const PYTHON_CLASS_DEFINITIONS = ${JSON.stringify(TEMPLATE_PYTHON_CLASS_DEFINITIONS)};

export const PYTHON_CONVERSION_HELPERS = ${JSON.stringify(TEMPLATE_PYTHON_CONVERSION_HELPERS)};

export const PYTHON_TRACE_SERIALIZE_FUNCTION = ${JSON.stringify(TEMPLATE_PYTHON_TRACE_SERIALIZE_FUNCTION)};

export const PYTHON_EXECUTE_SERIALIZE_FUNCTION = ${JSON.stringify(TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION)};

export const PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION = ${JSON.stringify(TEMPLATE_PYTHON_PRACTICE_MATERIALIZE_SERIALIZE_FUNCTION)};

export const PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION = ${JSON.stringify(TEMPLATE_PYTHON_INTERVIEW_MATERIALIZE_SERIALIZE_FUNCTION)};

export const PYTHON_SERIALIZE_FUNCTION = ${JSON.stringify(TEMPLATE_PYTHON_SERIALIZE_FUNCTION)};
`;
}

function buildGeneratedWorkerScript(): string {
  const toPythonLiteralSource = buildLiteralFunctionSource('__tracecodeToPythonLiteral');

  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Source: packages/harness-python/src/python-harness-template.ts
 * Generator: scripts/generate-python-harness-artifacts.ts
 */

(function registerTraceCodeHarnessSnippets(scope) {
  ${toPythonLiteralSource}

  scope.__TRACECODE_PYTHON_HARNESS__ = Object.freeze({
    PYTHON_CLASS_DEFINITIONS: ${JSON.stringify(TEMPLATE_PYTHON_CLASS_DEFINITIONS)},
    PYTHON_CONVERSION_HELPERS: ${JSON.stringify(TEMPLATE_PYTHON_CONVERSION_HELPERS)},
    PYTHON_TRACE_SERIALIZE_FUNCTION: ${JSON.stringify(TEMPLATE_PYTHON_TRACE_SERIALIZE_FUNCTION)},
    PYTHON_EXECUTE_SERIALIZE_FUNCTION: ${JSON.stringify(TEMPLATE_PYTHON_EXECUTE_SERIALIZE_FUNCTION)},
    PYTHON_SERIALIZE_FUNCTION: ${JSON.stringify(TEMPLATE_PYTHON_SERIALIZE_FUNCTION)},
  });

  scope.__TRACECODE_toPythonLiteral = __tracecodeToPythonLiteral;
})(typeof self !== 'undefined' ? self : globalThis);
`;
}

async function ensureParentDir(pathname: string): Promise<void> {
  const parent = dirname(pathname);
  await mkdir(parent, { recursive: true });
}

async function writeOrCheck(pathname: string, nextContent: string): Promise<void> {
  if (!CHECK_MODE) {
    await ensureParentDir(pathname);
    await writeFile(pathname, nextContent, 'utf8');
    return;
  }

  let currentContent = '';
  try {
    currentContent = await readFile(pathname, 'utf8');
  } catch {
    throw new Error(`Generated artifact is missing: ${pathname}`);
  }

  if (currentContent !== nextContent) {
    throw new Error(
      `Generated artifact is out of date: ${pathname}\nRun: pnpm generate:python-harness`
    );
  }
}

async function main(): Promise<void> {
  const tsOutput = buildGeneratedTypeScript();
  const workerOutput = buildGeneratedWorkerScript();

  await writeOrCheck(GENERATED_TS_PATH, tsOutput);
  await writeOrCheck(GENERATED_WORKER_JS_PATH, workerOutput);

  if (CHECK_MODE) {
    console.log('Python harness artifacts are up to date.');
  } else {
    console.log('Generated Python harness artifacts.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
