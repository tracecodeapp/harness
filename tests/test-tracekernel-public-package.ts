#!/usr/bin/env npx tsx

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const packageRoot = resolve('packages/tracekernel');
const workspacePackageJson = JSON.parse(
  await readFile(resolve('package.json'), 'utf8')
) as {
  readonly version: string;
};
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8')
) as {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly sideEffects: boolean;
};
assertCondition(
  packageJson.name === '@tracecode/tracekernel' &&
    packageJson.version === workspacePackageJson.version &&
    packageJson.sideEffects === false,
  'TraceKernel package identity or side-effect contract changed.'
);

const supportedEntryPoints = [
  '.',
  './workspace',
  './package.json',
] as const;
assertCondition(
  JSON.stringify(Object.keys(packageJson.exports).sort()) ===
    JSON.stringify([...supportedEntryPoints].sort()),
  `Unsupported deep package exports became public: ${JSON.stringify(
    packageJson.exports
  )}`
);
for (const [entryPoint, expectedTargets] of Object.entries({
  '.': {
    types: './dist/index.d.ts',
    import: './dist/index.js',
    require: './dist/index.cjs',
    default: './dist/index.js',
  },
  './workspace': {
    types: './dist/workspace.d.ts',
    import: './dist/workspace.js',
    require: './dist/workspace.cjs',
    default: './dist/workspace.js',
  },
})) {
  assertCondition(
    JSON.stringify(packageJson.exports[entryPoint]) ===
      JSON.stringify(expectedTargets),
    `TraceKernel entry point ${entryPoint} targets changed: ${JSON.stringify(
      packageJson.exports[entryPoint]
    )}`
  );
}
assertCondition(
  packageJson.exports['./package.json'] === './package.json',
  'TraceKernel package metadata entry point changed.'
);
assertCondition(
  JSON.stringify([...packageJson.files].sort()) ===
    JSON.stringify(
      ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'dist'].sort()
    ),
  `Packed TraceKernel files changed: ${JSON.stringify(packageJson.files)}`
);

const esm = await import(
  pathToFileURL(resolve(packageRoot, 'dist/index.js')).href
) as Record<string, unknown>;
const require = createRequire(import.meta.url);
const cjs = require(resolve(packageRoot, 'dist/index.cjs')) as
  Record<string, unknown>;
const [
  workspaceDeclarations,
  workspaceEsmSource,
  workspaceCjsSource,
] = await Promise.all([
  readFile(resolve(packageRoot, 'dist/workspace.d.ts'), 'utf8'),
  readFile(resolve(packageRoot, 'dist/workspace.js'), 'utf8'),
  readFile(resolve(packageRoot, 'dist/workspace.cjs'), 'utf8'),
]);
const requiredExports = [
  'makeTraceKernelHost',
  'TraceKernelControlledRuntime',
  'TraceKernelFileSystem',
  'TraceKernelSharedSyscallServer',
  'TraceKernelSyscallDispatcher',
  'TRACEKERNEL_SYSCALL_OPERATION_CODES',
  'TRACEKERNEL_SYSCALL_WIRE_SCHEMA',
  'TRACEKERNEL_SYSCALL_WIRE_VERSION',
] as const;
for (const name of requiredExports) {
  assertCondition(
    name in esm && name in cjs,
    `The ${name} public export is missing from ESM or CommonJS.`
  );
}
const requiredWorkspaceExports = [
  'RuntimeProjectWorkspace',
  'RuntimeProjectWorkspaceTerminalSession',
  'createRuntimeWorkspace',
  'createPackageManagerProjectCommands',
  'createPythonProjectCommands',
  'createNodeProjectCommands',
  'createTypeScriptProjectCommands',
  'createJavaProjectCommands',
  'createCppProjectCommands',
  'createCSharpProjectCommands',
  'normalizeRuntimeWorkspaceStorageLimits',
] as const;
const workspaceDeclarationExport =
  workspaceDeclarations
    .split('\n')
    .find((line) => line.startsWith('export {')) ?? '';
for (const name of requiredWorkspaceExports) {
  assertCondition(
    workspaceDeclarationExport.includes(name) &&
      workspaceEsmSource.includes(name) &&
      workspaceCjsSource.includes(name),
    `The workspace ${name} public export is missing from declarations, ESM, or CommonJS.`
  );
}
assertCondition(
  esm.TRACEKERNEL_SYSCALL_WIRE_SCHEMA === 'tracekernel.syscall.v1' &&
    cjs.TRACEKERNEL_SYSCALL_WIRE_SCHEMA ===
      esm.TRACEKERNEL_SYSCALL_WIRE_SCHEMA &&
    cjs.TRACEKERNEL_SYSCALL_WIRE_VERSION ===
      esm.TRACEKERNEL_SYSCALL_WIRE_VERSION &&
    JSON.stringify(cjs.TRACEKERNEL_SYSCALL_OPERATION_CODES) ===
      JSON.stringify(esm.TRACEKERNEL_SYSCALL_OPERATION_CODES) &&
    Object.isFrozen(esm.TRACEKERNEL_SYSCALL_OPERATION_CODES),
  'ESM and CommonJS expose different or mutable syscall wire identities.'
);

const readme = await readFile(resolve(packageRoot, 'README.md'), 'utf8');
assertCondition(
  readme.includes('## Public compatibility boundary') &&
    readme.includes('## Supported kernel boundary') &&
    readme.includes('@tracecode/tracekernel/workspace') &&
    readme.includes('tracekernel.syscall.v1'),
  'The packed README does not document the public or wire boundary.'
);

console.log(JSON.stringify({
  schema: 'tracekernel-public-package-v1',
  package: packageJson.name,
  version: packageJson.version,
  esmAndCommonJsParity: true,
  supportedEntryPoints,
  wireSchema: esm.TRACEKERNEL_SYSCALL_WIRE_SCHEMA,
  wireVersion: esm.TRACEKERNEL_SYSCALL_WIRE_VERSION,
  operationCount: Object.keys(
    esm.TRACEKERNEL_SYSCALL_OPERATION_CODES as object
  ).length,
}));
