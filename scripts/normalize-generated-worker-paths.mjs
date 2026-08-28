#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = process.cwd();
const files = process.argv.slice(2);

if (files.length === 0) {
  throw new Error('Pass at least one generated worker path to normalize.');
}

for (const file of files) {
  const pathname = resolve(root, file);
  const source = await readFile(pathname, 'utf8');
  const normalized = source
    .replace(
      /^\/\/ (?:.*\/)?node_modules\//gmu,
      '// node_modules/'
    )
    .replace(
      /(['"])(?:[^"'\n]*\/)+node_modules\//gmu,
      '$1node_modules/'
    );
  const hasCheckoutRelativeNodeModulesPath = normalized
    .split('\n')
    .some((line) =>
      ((line.trimStart().startsWith('//')) ||
        line.trimStart().startsWith('"') ||
        line.trimStart().startsWith("'")) &&
      line.includes('../') &&
      line.includes('node_modules/')
    );
  if (hasCheckoutRelativeNodeModulesPath) {
    throw new Error(
      `Generated worker ${relative(root, pathname)} still contains a checkout-relative dependency path.`
    );
  }
  if (normalized !== source) {
    await writeFile(pathname, normalized, 'utf8');
  }
}
