import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const storePath = '/root/ci/gate-results';

export function resultPath(root, cell, hash) {
  if (!/^[a-z0-9-]+$/.test(cell) || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('Invalid gate cell or SHA-256.');
  }
  return join(root, cell, hash + '.json');
}

export function readPass(root, cell, hash) {
  const path = resultPath(root, cell, hash);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record?.status === 'pass' && record.exitCode === 0 && record.cell === cell &&
      record.hash === hash && record.jobId && record.end ? record : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function readCellPass(root, cell, hash, force) {
  // GA may pass with companion routes skipped. Keep its receipts for
  // diagnosis but always rerun the candidate-qualified gate.
  if (force || cell.id.startsWith('ga-')) return undefined;
  return readPass(root, cell.id, hash);
}

export function writeResult(root, record) {
  const path = resultPath(root, record.cell, record.hash);
  const temp = path + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function readResults(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const dir = join(root, name);
      return readdirSync(dir).filter((file) => /^[0-9a-f]{64}\.json$/.test(file))
        .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
    });
}
