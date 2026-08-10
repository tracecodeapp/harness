#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
(async () => {
  const rootPackage = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const traceccVersion = rootPackage.dependencies?.['@tracecode/tracecc'];
  const tracejvmVersion = rootPackage.dependencies?.['@tracecode/tracejvm'];

  assert.equal(typeof traceccVersion, 'string', 'TraceCC dependency must be pinned');
  assert.equal(typeof tracejvmVersion, 'string', 'TraceJVM dependency must be pinned');
  assert.match(notices, /### TraceCC\n/u, 'notices must identify the current TraceCC runtime');
  assert.match(
    notices,
    new RegExp('@tracecode/tracecc` `' + traceccVersion + '`'),
    'notices must track the pinned TraceCC package version'
  );
  assert.match(
    notices,
    new RegExp('@tracecode/tracejvm` `' + tracejvmVersion + '`'),
    'notices must track the pinned TraceJVM package version'
  );
  assert.doesNotMatch(notices, /@yowasp\/clang|cpp\/compiler|YoWASP Clang/u);
  assert.doesNotMatch(notices, /TraceJVM 0\.3/u);
  assert.match(notices, /cpp\/tracecc\/<consumer-hash>/u);

  for (const packageName of [
    'judge',
    'runtime-browser',
    'runtime-contracts',
    'runtime-cpp',
    'runtime-csharp',
    'runtime-java',
    'runtime-javascript',
    'runtime-native',
    'runtime-python',
    'runtime-sql',
    'tracekernel',
  ]) {
    const packageNotice = join(root, 'packages', packageName, 'THIRD_PARTY_NOTICES.md');
    try {
      await access(packageNotice);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    assert.equal(
      await readFile(packageNotice, 'utf8'),
      notices,
      `${packageName} notice is stale; run pnpm sync:package-assets`
    );
  }

  console.log('PASS: runtime notices track current engine packages and generated copies');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
