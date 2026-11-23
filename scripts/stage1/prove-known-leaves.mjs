import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { missingEvidence } from './leaf-ledger.mjs';
import { knownLeaves } from './suite-floor.mjs';

const [profile, source, destination] = process.argv.slice(2);
if (!['baseline', 'candidate'].includes(profile) || !source || !destination) {
  throw new Error('Usage: prove-known-leaves.mjs <baseline|candidate> <source> <receipt-directory>');
}
const root = resolve(source);
const output = resolve(destination);
const preload = new URL('./suite-preload.mjs', import.meta.url).href;
let unexpected = 0;
for (const [file, { id, assertions }] of Object.entries(knownLeaves)) {
  const ledger = join(output, `${profile}-${id}.jsonl`);
  const nonce = randomUUID();
  writeFileSync(ledger, '');
  const args = ['pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.base.json', file];
  if (id === 'js-destructured-iterable') args.push('--destructured-iterable');
  const started = performance.now();
  const result = spawnSync('corepack', args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      TRACECODE_SUITE_LEDGER: ledger,
      TRACECODE_SUITE_NONCE: nonce,
      TRACECODE_SUITE_ROOT: root,
    },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = result.stdout + result.stderr;
  writeFileSync(join(output, `${profile}-${id}.log`), log);
  const events = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const terminal = events.find((event) => event.kind === 'process-end' && event.leaf === file);
  const checks = events.filter((event) => event.kind === 'assertion');
  const issues = missingEvidence(id, assertions, events);
  const ms = Math.round(performance.now() - started);
  console.log(`G7/${profile}/${id} exit=${result.status} ms=${ms} checked=${checks.length}`);
  if (profile === 'baseline') {
    if (!terminal || result.error || terminal.nonce !== nonce || result.status === 0 ||
        (id !== 'js-destructured-iterable' && terminal.assertions.length !== 0)) {
      console.error(`G7/${profile}/${id}: could not witness a pre-assertion failure`);
      unexpected += 1;
    } else {
      console.log(`G7/${profile}/${id}/${id === 'js-destructured-iterable' ? 'unwitnessed-learner-assignment' : 'zero-assertions'}`);
    }
  } else if (result.status !== 0 || result.error || issues.length || !terminal) {
    console.error(issues.join('\n'));
    unexpected += 1;
  }
}
process.exitCode = Number(unexpected !== 0);
