#!/usr/bin/env npx tsx

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const packageRoot = resolve('packages/tracekernel');
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
    packageJson.version.startsWith('0.13.') &&
    packageJson.sideEffects === false,
  'TraceKernel package identity or side-effect contract changed.'
);
assertCondition(
  JSON.stringify(Object.keys(packageJson.exports).sort()) ===
    JSON.stringify(['.', './package.json']),
  `Unsupported deep package exports became public: ${JSON.stringify(
    packageJson.exports
  )}`
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
    readme.includes('## 0.13 boundary') &&
    readme.includes('tracekernel.syscall.v1'),
  'The packed README does not document the public or wire boundary.'
);

console.log(JSON.stringify({
  schema: 'tracekernel-013-public-package-v1',
  package: packageJson.name,
  version: packageJson.version,
  esmAndCommonJsParity: true,
  supportedEntryPoints: Object.keys(packageJson.exports),
  wireSchema: esm.TRACEKERNEL_SYSCALL_WIRE_SCHEMA,
  wireVersion: esm.TRACEKERNEL_SYSCALL_WIRE_VERSION,
  operationCount: Object.keys(
    esm.TRACEKERNEL_SYSCALL_OPERATION_CODES as object
  ).length,
}));
