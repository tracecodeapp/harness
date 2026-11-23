import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function withPythonScriptFile<T>(script: string, run: (filename: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'harness-python-fixture-'));
  try {
    const path = join(directory, 'program.py');
    writeFileSync(path, script, { encoding: 'utf8', mode: 0o600 });
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
