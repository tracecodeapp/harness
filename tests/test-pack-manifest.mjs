import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolvePackDevDependencies } from '../scripts/pack-manifest.mjs';

test('pack ranges and key order are independent of the input order', () => {
  const dependencies = {
    '@tracecode/tracekernel': 'workspace:^',
    typescript: '^5.0.0',
    '@tracecode/runtime-contracts': 'workspace:^0.20.2',
    '@types/node': '^20.0.0',
  };
  const expected = [
    ['@types/node', '^20.0.0'],
    ['typescript', '^5.0.0'],
    ['@tracecode/runtime-contracts', 'workspace:^0.21.0'],
    ['@tracecode/tracekernel', 'workspace:^0.21.0'],
  ];
  const reversed = Object.fromEntries(Object.entries(dependencies).reverse());
  assert.deepEqual(Object.entries(resolvePackDevDependencies(dependencies, '0.21.0')), expected);
  assert.deepEqual(Object.entries(resolvePackDevDependencies(reversed, '0.21.0')), expected);
});

test('the checked-in manifest already has the resolved ranges and key order', () => {
  const { devDependencies, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.entries(devDependencies),
    Object.entries(resolvePackDevDependencies(devDependencies, version)),
  );
});
