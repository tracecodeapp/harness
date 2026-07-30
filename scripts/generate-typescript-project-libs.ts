#!/usr/bin/env npx tsx

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CHECK_MODE = process.argv.includes('--check');
const ROOT = process.cwd();
const TYPESCRIPT_LIB_DIR = join(ROOT, 'node_modules', 'typescript', 'lib');
const GENERATED_PATH = join(
  ROOT,
  'packages',
  'runtime-javascript',
  'src',
  'generated',
  'typescript-project-libs.ts'
);
const DEFAULT_LIB_FILE = 'lib.es2020.d.ts';

function generatedSource(files: Record<string, string>): string {
  return `/**
 * AUTO-GENERATED FILE. DO NOT EDIT MANUALLY.
 *
 * Source: node_modules/typescript/lib/lib.es*.d.ts and decorator libs
 * Generator: scripts/generate-typescript-project-libs.ts
 */

export const TYPESCRIPT_PROJECT_DEFAULT_LIB_FILE = ${JSON.stringify(DEFAULT_LIB_FILE)};

export const TYPESCRIPT_PROJECT_LIB_FILES: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(files, null, 2)});
`;
}

async function writeOrCheck(pathname: string, nextContent: string): Promise<void> {
  if (!CHECK_MODE) {
    await mkdir(dirname(pathname), { recursive: true });
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
      `Generated artifact is out of date: ${pathname}\nRun: pnpm generate:typescript-project-libs`
    );
  }
}

async function main(): Promise<void> {
  const entries = await readdir(TYPESCRIPT_LIB_DIR);
  const libFiles = entries
    .filter((entry) =>
      /^lib\.es(?:5|6|20\d{2}|next)(?:\..*)?\.d\.ts$/.test(entry) ||
      /^lib\.decorators(?:\.legacy)?\.d\.ts$/.test(entry)
    )
    .sort((left, right) => left.localeCompare(right));

  if (!libFiles.includes(DEFAULT_LIB_FILE)) {
    throw new Error(`Missing TypeScript project default lib file: ${DEFAULT_LIB_FILE}`);
  }

  const files: Record<string, string> = {};
  for (const fileName of libFiles) {
    files[fileName] = await readFile(join(TYPESCRIPT_LIB_DIR, fileName), 'utf8');
  }

  await writeOrCheck(GENERATED_PATH, generatedSource(files));

  if (CHECK_MODE) {
    console.log('TypeScript project lib artifact is up to date.');
  } else {
    console.log(`Generated TypeScript project lib artifact with ${libFiles.length} lib files.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
