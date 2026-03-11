#!/usr/bin/env npx tsx

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  PYTHON_SERIALIZE_FUNCTION,
  toPythonLiteral as canonicalToPythonLiteral,
} from '../packages/harness-python/src/python-harness';

const WORKER_PATH = join(process.cwd(), 'workers', 'python', 'pyodide-worker.js');
const RUNTIME_CORE_PATH = join(process.cwd(), 'workers', 'python', 'runtime-core.js');
const LEGACY_RUNTIME_PATH = join(process.cwd(), 'packages', 'harness-python', 'src', 'pyodide.ts');

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function assertLineSubsequenceInSource(source: string, block: string, label: string): void {
  const sourceLines = normalizeLines(source);
  const blockLines = normalizeLines(block);

  let sourceIndex = 0;
  for (const expectedLine of blockLines) {
    let matched = false;
    while (sourceIndex < sourceLines.length) {
      if (sourceLines[sourceIndex] === expectedLine) {
        matched = true;
        sourceIndex += 1;
        break;
      }
      sourceIndex += 1;
    }

    if (!matched) {
      throw new Error(`Worker drift detected in ${label}. Missing line: ${expectedLine}`);
    }
  }
}

function countOccurrences(source: string, pattern: string): number {
  if (!pattern) return 0;
  return source.split(pattern).length - 1;
}

function createWorkerContext(source: string): vm.Context {
  const selfObject: Record<string, unknown> = {
    location: { search: '' },
    postMessage: () => {},
    onmessage: null,
  };

  const context = vm.createContext({
    console,
    performance: { now: () => Date.now() },
    self: selfObject,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(source, context, {
    filename: 'pyodide-worker.js',
  });

  return context;
}

async function assertToPythonLiteralParity(workerSource: string): Promise<void> {
  const context = createWorkerContext(workerSource) as vm.Context & {
    toPythonLiteral?: (value: unknown) => string;
  };

  const workerToPythonLiteral = context.toPythonLiteral;
  assertCondition(typeof workerToPythonLiteral === 'function', 'Worker toPythonLiteral function is not available');
  const workerToPythonLiteralFn = workerToPythonLiteral as (value: unknown) => string;

  const samples: unknown[] = [
    null,
    undefined,
    true,
    false,
    42,
    -3.5,
    'hello',
    'quote " test',
    [1, 2, 3],
    ['a', true, null],
    { a: 1, b: [2, 3], c: { d: false } },
    { __type__: 'ListNode', val: 1, next: null },
    { __type__: 'TreeNode', val: 1, left: null, right: { val: 2 } },
  ];

  for (const sample of samples) {
    const canonical = canonicalToPythonLiteral(sample);
    const worker = workerToPythonLiteralFn(sample);
    assertCondition(
      canonical === worker,
      `toPythonLiteral drift for sample ${JSON.stringify(sample)}\ncanonical=${canonical}\nworker=${worker}`
    );
  }

  console.log('PASS: toPythonLiteral parity');
}

function selectSerializeContractLines(serializedBlock: string, keepers: string[]): string {
  const lines = normalizeLines(serializedBlock);
  const filtered = lines.filter((line) => keepers.some((marker) => line.includes(marker)));
  return filtered.join('\n');
}

function selectTraceSerializeContractLines(serializedBlock: string): string {
  const keepers = [
    '_SKIP_SENTINEL = "__TRACECODE_SKIP__"',
    '_MAX_SERIALIZE_DEPTH = 48',
    '_MAX_OBJECT_FIELDS = 32',
    'def _serialize(obj, depth=0, node_refs=None):',
    "elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':",
    "elif isinstance(obj, (list, tuple)):",
    "elif isinstance(obj, dict):",
    "elif isinstance(obj, set):",
    'if obj_ref in node_refs:',
    '"__ref__": node_refs[obj_ref]',
    '"__id__": node_id',
    "elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):",
    "\"__type__\": \"TreeNode\"",
    "elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and hasattr(obj, 'next'):",
    "\"__type__\": \"ListNode\"",
    "elif hasattr(obj, '__dict__'):",
    "\"__type__\": \"object\"",
    "\"__class__\": class_name",
    'result["__truncated__"] = True',
    'elif callable(obj):',
    'return _SKIP_SENTINEL',
  ];
  return selectSerializeContractLines(serializedBlock, keepers);
}

function selectExecuteSerializeContractLines(serializedBlock: string): string {
  const keepers = [
    '_MAX_SERIALIZE_DEPTH = 48',
    'def _serialize(obj, depth=0):',
    "elif getattr(obj, '__class__', None) and getattr(obj.__class__, '__name__', '') == 'deque':",
    "elif isinstance(obj, (list, tuple)):",
    "elif isinstance(obj, dict):",
    "elif isinstance(obj, set):",
    "elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and (hasattr(obj, 'left') or hasattr(obj, 'right')):",
    "\"__type__\": \"TreeNode\"",
    "elif (hasattr(obj, 'val') or hasattr(obj, 'value')) and hasattr(obj, 'next'):",
    "\"__type__\": \"ListNode\"",
    'elif callable(obj):',
    'return None',
  ];
  return selectSerializeContractLines(serializedBlock, keepers);
}

async function assertDeprecatedRuntimeNotImported(): Promise<void> {
  const root = process.cwd();
  const allowedSelfImportPath = LEGACY_RUNTIME_PATH;
  const disallowedSpecifiers = new Set([
    '@/lib/execution/pyodide',
    '../execution/pyodide',
    './pyodide',
  ]);

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.next') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(fullPath)));
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  const files = await walk(root);
  for (const filePath of files) {
    if (filePath === allowedSelfImportPath) continue;
    const contents = await readFile(filePath, 'utf8');
    const importRegex = /^\s*import[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm;
    const dynamicImportRegex = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const match of contents.matchAll(importRegex)) {
      const specifier = match[1];
      if (disallowedSpecifiers.has(specifier)) {
        throw new Error(`Deprecated runtime import found in ${filePath}: ${specifier}`);
      }
    }

    for (const match of contents.matchAll(dynamicImportRegex)) {
      const specifier = match[1];
      if (disallowedSpecifiers.has(specifier)) {
        throw new Error(`Deprecated runtime dynamic import found in ${filePath}: ${specifier}`);
      }
    }
  }

  console.log('PASS: deprecated pyodide.ts has no consumers');
}

async function main(): Promise<void> {
  const workerSource = await readFile(WORKER_PATH, 'utf8');
  const runtimeCoreSource = await readFile(RUNTIME_CORE_PATH, 'utf8');

  assertCondition(
    workerSource.includes('generated-python-harness-snippets.js'),
    'Worker should attempt to load generated python harness snippets'
  );
  assertCondition(
    workerSource.includes('__TRACECODE_toPythonLiteral'),
    'Worker should reference generated toPythonLiteral implementation'
  );
  console.log('PASS: generated snippet integration markers present');

  assertCondition(
    workerSource.includes('runtime-core.js'),
    'Worker should attempt to load runtime-core module'
  );
  assertCondition(
    workerSource.includes('__TRACECODE_PYODIDE_RUNTIME__'),
    'Worker should reference runtime-core export namespace'
  );
  assertCondition(
    countOccurrences(runtimeCoreSource, 'deps.PYTHON_CLASS_DEFINITIONS_SNIPPET') >= 2,
    'Runtime core should wire shared class definitions into tracing/execute templates'
  );
  assertCondition(
    countOccurrences(runtimeCoreSource, 'deps.PYTHON_CONVERSION_HELPERS_SNIPPET') >= 3,
    'Runtime core should wire shared conversion helpers into tracing/execute templates'
  );
  assertCondition(
    countOccurrences(runtimeCoreSource, 'deps.PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET') >= 1,
    'Runtime core should wire trace serialize snippet into tracing template'
  );
  assertCondition(
    countOccurrences(runtimeCoreSource, 'deps.PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET') >= 1,
    'Runtime core should wire execute serialize snippet into execute template'
  );
  assertCondition(
    countOccurrences(workerSource, 'class TreeNode:') >= 1,
    'Worker should keep fallback TreeNode definition available'
  );
  assertCondition(
    countOccurrences(workerSource, 'class ListNode:') >= 1,
    'Worker should keep fallback ListNode definition available'
  );
  assertCondition(
    countOccurrences(workerSource, 'def _dict_to_tree') >= 1,
    'Worker should keep fallback _dict_to_tree helper available'
  );
  assertCondition(
    countOccurrences(workerSource, 'def _dict_to_list') >= 1,
    'Worker should keep fallback _dict_to_list helper available'
  );
  assertCondition(
    countOccurrences(workerSource, '_MAX_SERIALIZE_DEPTH = 48') >= 2,
    'Worker should keep fallback _MAX_SERIALIZE_DEPTH guards in trace/execute snippets'
  );
  console.log('PASS: shared snippet wiring + fallback snippets present');

  assertLineSubsequenceInSource(workerSource, PYTHON_CLASS_DEFINITIONS, 'PYTHON_CLASS_DEFINITIONS');
  console.log('PASS: class definitions synced');

  assertLineSubsequenceInSource(workerSource, PYTHON_CONVERSION_HELPERS, 'PYTHON_CONVERSION_HELPERS');
  console.log('PASS: conversion helpers synced');

  const traceSerializeContractBlock = selectTraceSerializeContractLines(PYTHON_TRACE_SERIALIZE_FUNCTION);
  assertLineSubsequenceInSource(workerSource, traceSerializeContractBlock, 'PYTHON_TRACE_SERIALIZE_FUNCTION core contract');
  const executeSerializeContractBlock = selectExecuteSerializeContractLines(PYTHON_EXECUTE_SERIALIZE_FUNCTION);
  assertLineSubsequenceInSource(workerSource, executeSerializeContractBlock, 'PYTHON_EXECUTE_SERIALIZE_FUNCTION core contract');
  const compatSerializeContractBlock = selectExecuteSerializeContractLines(PYTHON_SERIALIZE_FUNCTION);
  assertLineSubsequenceInSource(workerSource, compatSerializeContractBlock, 'PYTHON_SERIALIZE_FUNCTION compatibility contract');
  console.log('PASS: serialize contracts synced');

  await assertToPythonLiteralParity(workerSource);
  await assertDeprecatedRuntimeNotImported();

  console.log('\nPython harness sync checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
