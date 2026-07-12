#!/usr/bin/env npx tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CHECK_MODE = process.argv.includes('--check');

const MODULE_POLICY_PATH = join(process.cwd(), 'workers', 'shared', 'runtime-kernel-policy.js');
const CLASSIC_POLICY_PATH = join(process.cwd(), 'workers', 'shared', 'runtime-kernel-policy-classic.js');

const EXPORTED_POLICY_NAMES = [
  'normalizeRuntimeKernelPath',
  'isRuntimeKernelProcPath',
  'isRuntimeKernelDeviceNamespacePath',
  'isRuntimeKernelDeviceDirectory',
  'normalizeRuntimeKernelDeviceReference',
  'normalizeRuntimeKernelManifestDevicePath',
  'runtimeKernelDeviceInfo',
  'runtimeKernelDeviceDirEntries',
  'runtimeKernelDeviceEntryKind',
  'runtimeKernelDeviceInputSource',
  'runtimeKernelDeviceOutputTarget',
  'runtimeKernelVirtualPathTarget',
  'runtimeKernelVirtualMutationTarget',
  'runtimeKernelVirtualOpenTarget',
  'withRuntimeUserAuthorityLockdown',
] as const;

function indentBlock(value: string): string {
  return value
    .trim()
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : `  ${line}`))
    .join('\n');
}

function buildClassicPolicyScript(moduleSource: string): string {
  const missingExports = EXPORTED_POLICY_NAMES.filter(
    (name) =>
      !moduleSource.includes(`export function ${name}`) &&
      !moduleSource.includes(`export async function ${name}`)
  );
  if (missingExports.length > 0) {
    throw new Error(`Missing runtime kernel policy exports: ${missingExports.join(', ')}`);
  }

  const classicSource = moduleSource.replace(/^export (async )?function /gm, '$1function ');
  if (/\bexport\b/.test(classicSource) || /\bimport\b/.test(classicSource)) {
    throw new Error('runtime-kernel-policy.js must stay self-contained for classic worker generation.');
  }

  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Source: workers/shared/runtime-kernel-policy.js
 * Generator: scripts/generate-runtime-kernel-policy-classic.ts
 */

(function installRuntimeKernelPolicy(globalThis) {
${indentBlock(classicSource)}

  Object.defineProperty(globalThis, 'TraceRuntimeKernelPolicy', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
${EXPORTED_POLICY_NAMES.map((name) => `    ${name},`).join('\n')}
    }),
  });
})(typeof self !== 'undefined' ? self : globalThis);
`;
}

async function ensureParentDir(pathname: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
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
      `Generated artifact is out of date: ${pathname}\nRun: pnpm generate:kernel-policy`
    );
  }
}

async function main(): Promise<void> {
  const moduleSource = await readFile(MODULE_POLICY_PATH, 'utf8');
  const classicPolicyScript = buildClassicPolicyScript(moduleSource);
  await writeOrCheck(CLASSIC_POLICY_PATH, classicPolicyScript);

  if (CHECK_MODE) {
    console.log('Runtime kernel classic worker policy is up to date.');
  } else {
    console.log('Generated runtime kernel classic worker policy.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
