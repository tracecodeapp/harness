import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function appendSuiteEvent(event) {
  const target = process.env.TRACECODE_SUITE_LEDGER;
  if (!target) return;
  const pid = process.pid;
  const path = process.env.TRACECODE_SUITE_ROOT ? `${target}.${pid}.jsonl` : target;
  appendFileSync(path, JSON.stringify({ ...event, pid, nonce: process.env.TRACECODE_SUITE_NONCE }) + '\n');
}

export function readSuiteEvents(target) {
  const dir = dirname(target);
  const prefix = basename(target) + '.';
  return readdirSync(dir).filter((path) => path.startsWith(prefix) && path.endsWith('.jsonl')).sort()
    .flatMap((path) => readFileSync(join(dir, path), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
