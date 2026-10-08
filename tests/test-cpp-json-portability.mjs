import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const compiler = process.env.CXX || 'clang++';
const source = fileURLToPath(new URL('./fixtures/cpp-json-portability.cpp', import.meta.url));
const headerDirectory = fileURLToPath(new URL('../workers/cpp/', import.meta.url));

for (const standard of ['c++20', 'c++23']) {
  test(`recursive C++ JSON preserves value semantics under ${standard}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'tracecode-cpp-json-'));
    try {
      const binary = join(directory, 'json-test');
      const compilation = spawnSync(
        compiler,
        [`-std=${standard}`, '-O0', '-Wall', '-Wextra', '-pedantic-errors', '-I', headerDirectory, source, '-o', binary],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(compilation.error, undefined, `${compiler}: ${compilation.error}`);
      assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);
      const execution = spawnSync(binary, [], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(execution.error, undefined, `JSON probe: ${execution.error}`);
      assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
