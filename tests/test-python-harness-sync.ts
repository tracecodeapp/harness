#!/usr/bin/env npx tsx

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRuntimeCommandStdinPipeFromText } from '../packages/harness-core/src/runtime-project';
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

async function assertWorkerInitWarmupContract(workerSource: string): Promise<void> {
  const pending = new Map<string, (message: Record<string, unknown>) => void>();
  let loadPyodideCount = 0;
  let nextId = 0;

  const selfObject: Record<string, unknown> = {
    location: { search: '' },
    loadPyodide: async () => {
      loadPyodideCount += 1;
      return {};
    },
    postMessage: (message: Record<string, unknown>) => {
      const id = typeof message.id === 'string' ? message.id : null;
      if (!id) return;
      pending.get(id)?.(message);
      pending.delete(id);
    },
    onmessage: null,
  };

  const context = vm.createContext({
    console,
    performance: { now: () => Date.now() },
    self: selfObject,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(workerSource, context, {
    filename: 'pyodide-worker.js',
  });

  const onmessage = selfObject.onmessage as ((event: { data: Record<string, unknown> }) => void) | null;
  assertCondition(typeof onmessage === 'function', 'Worker should register an onmessage handler');

  async function send(type: string): Promise<Record<string, unknown>> {
    const id = String(++nextId);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for worker response: ${type}`));
      }, 1000);
    });
    onmessage?.({ data: { id, type, payload: {} } });
    return response;
  }

  const initMessage = await send('init');
  assertCondition(initMessage.type === 'init-result', 'Python worker init should return init-result');
  assertCondition(loadPyodideCount === 0, 'Python worker init should not load Pyodide');

  const warmupMessage = await send('warmup');
  assertCondition(warmupMessage.type === 'warmup-result', 'Python worker warmup should return warmup-result');
  assertCondition(loadPyodideCount === 1, 'Python worker warmup should load Pyodide exactly once');

  const repeatedWarmupMessage = await send('warmup');
  assertCondition(repeatedWarmupMessage.type === 'warmup-result', 'Repeated Python worker warmup should return warmup-result');
  assertCondition(loadPyodideCount === 1, 'Repeated Python worker warmup should reuse the loaded runtime');

  console.log('PASS: Python worker init stays light and warmup loads runtime');
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

async function assertProjectPythonEnvContract(workerSource: string): Promise<void> {
  let capturedCode = '';
  const selfObject: Record<string, unknown> = {
    location: { search: '' },
    loadPyodide: async () => ({
      runPythonAsync: async (code: string) => {
        capturedCode = code;
        return JSON.stringify({ stdout: '', stderr: '', exitCode: 0 });
      },
    }),
    postMessage: () => {},
    onmessage: null,
  };

  const context = vm.createContext({
    console,
    performance: { now: () => Date.now() },
    self: selfObject,
    setTimeout,
    clearTimeout,
  }) as vm.Context & {
    executeProjectPython?: (request: unknown) => Promise<unknown>;
  };

  vm.runInContext(workerSource, context, {
    filename: 'pyodide-worker.js',
  });

  assertCondition(typeof context.executeProjectPython === 'function', 'Worker should expose executeProjectPython in VM context');
  await context.executeProjectPython?.({
    code: 'from pkgtools import value',
    source: 'argument',
    scriptPath: '-c',
    args: [],
    cwd: '/workspace',
    env: { PYTHONPATH: '/workspace/vendor', MODE: 'project' },
    project: {
      files: [
        { path: 'vendor/pkgtools.py', contents: 'def value(): return 42\n' },
      ],
    },
  });

  assertCondition(capturedCode.includes('_env = {str(key): str(value)'), 'Project Python runner should normalize request env');
  assertCondition(capturedCode.includes('os.environ.update(_env)'), 'Project Python runner should apply request env');
  assertCondition(capturedCode.includes('def _project_pythonpath_entries()'), 'Project Python runner should compute project PYTHONPATH entries');
  assertCondition(capturedCode.includes('_env.get("PYTHONPATH", "")'), 'Project Python runner should read PYTHONPATH from request env');
  assertCondition(
    capturedCode.includes('_path.startswith(_workspace_root + "/")'),
    'Project Python runner should map workspace-root PYTHONPATH entries'
  );
  assertCondition(
    capturedCode.includes('Project path must stay within the workspace: {_entry}'),
    'Project Python runner should reject PYTHONPATH entries outside the workspace'
  );
  assertCondition(capturedCode.includes('def _project_cwd()'), 'Project Python runner should map request cwd into the project root');
  assertCondition(capturedCode.includes('Project cwd must stay inside the workspace'), 'Project Python runner should reject cwd outside the workspace');
  assertCondition(capturedCode.includes('def _project_script_absolute_path()'), 'Project Python runner should map absolute virtual script paths');
  assertCondition(capturedCode.includes('Project path must stay within the workspace'), 'Project Python runner should reject script paths outside the workspace');
  assertCondition(capturedCode.includes('def _project_files_after_execution()'), 'Project Python runner should collect changed project files');
  assertCondition(capturedCode.includes('"deleted": True'), 'Project Python runner should report deleted project files');
  assertCondition(capturedCode.includes('"files": _project_files_after_execution()'), 'Project Python runner should return file side effects');
  assertCondition(capturedCode.includes('def _clear_project_import_state()'), 'Project Python runner should clear project import state');
  assertCondition(capturedCode.includes('sys.path_importer_cache.pop'), 'Project Python runner should clear project import caches');
  assertCondition(capturedCode.includes('importlib.invalidate_caches()'), 'Project Python runner should invalidate importlib caches');
  assertCondition(capturedCode.includes('def _project_argv()'), 'Project Python runner should compute source-aware argv');
  assertCondition(capturedCode.includes('return ["-c"] + _args'), 'Project Python -c should expose -c as sys.argv[0]');
  assertCondition(capturedCode.includes('return ["-"] + _args'), 'Project Python stdin should expose - as sys.argv[0]');
  assertCondition(capturedCode.includes('importlib.util.find_spec(_script_path)'), 'Project Python -m should resolve module argv[0]');
  assertCondition(capturedCode.includes('sys.argv = _project_argv()'), 'Project Python runner should apply source-aware argv');
  assertCondition(capturedCode.includes('def _map_workspace_path(_value)'), 'Project Python runner should map virtual /workspace paths');
  assertCondition(capturedCode.includes('def _virtual_workspace_path(_value)'), 'Project Python runner should expose virtual /workspace cwd');
  assertCondition(capturedCode.includes('def _install_virtual_workspace_paths()'), 'Project Python runner should install virtual path shims');
  assertCondition(capturedCode.includes('builtins.open = _patched_open'), 'Project Python runner should map /workspace paths through open');
  assertCondition(capturedCode.includes('os.getcwd = _patched_getcwd'), 'Project Python runner should virtualize os.getcwd');
  assertCondition(capturedCode.includes('_restore_workspace_paths()'), 'Project Python runner should restore virtual path shims');
  assertCondition(!capturedCode.includes('"__file__": _script_path'), 'Project Python -c/stdin should not define __file__');

  console.log('PASS: Python project worker env/PYTHONPATH contract');
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
    'def _tracecode_ref_id(node_refs):',
    'return f"r{len(node_refs)}"',
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
  const semanticFactMarkers = [
    "'sliceExpressions': []",
    "'comparisonExpressions': []",
    "'variableAssignments': []",
    "'augmentedAssignments': []",
    "'propertyAssignments': []",
    "'methodCalls': []",
    "'functionCalls': []",
    "'loopIterations': []",
    "facts['comparisonExpressions'] = comparison_expressions",
    "facts['variableAssignments'] = variable_assignments",
    "facts['augmentedAssignments'] = augmented_assignments",
    "facts['propertyAssignments'] = property_assignments",
    "facts['methodCalls'] = method_calls",
    "facts['functionCalls'] = function_calls",
    "facts['loopIterations'] = loop_iterations",
    "facts['sliceExpressions'] = slice_expressions",
  ];
  for (const marker of semanticFactMarkers) {
    assertCondition(
      workerSource.includes(marker),
      `Worker semantic analyzer drift detected. Missing marker: ${marker}`
    );
  }
  console.log('PASS: worker semantic fact markers present');
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

  await assertWorkerInitWarmupContract(workerSource);
  await assertToPythonLiteralParity(workerSource);
  await assertProjectPythonEnvContract(workerSource);
  await assertDeprecatedRuntimeNotImported();

  console.log('\nPython harness sync checks passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
