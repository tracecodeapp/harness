import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { missingEvidence } from './leaf-ledger.mjs';
import { knownLeaves } from './suite-floor.mjs';
import { readSuiteEvents } from './suite-events.mjs';

const [profile, source, destination] = process.argv.slice(2);
const browserControl = profile === 'browser-control';
if (!['baseline', 'candidate', 'browser-control', 'frozen-pack'].includes(profile) || !source || !destination) {
  throw new Error('Usage: prove-known-leaves.mjs <baseline|candidate|browser-control|frozen-pack> <source> <receipt-directory>');
}
const root = resolve(source);
const output = resolve(destination);
const preload = new URL('./suite-preload.mjs', import.meta.url).href;
if (profile === 'frozen-pack' && !process.env.TRACECODE_G7_INSTALLED_PACKAGE) {
  throw new Error('G7/frozen-pack: an isolated installed package is required');
}
const unexpected = [];
for (const [file, { id, assertions }] of Object.entries(knownLeaves)) {
  if (browserControl && id !== 'python-line-guard') continue;
  const ledger = join(output, `${profile}-${id}.jsonl`);
  const nonce = randomUUID();
  writeFileSync(ledger, '');
  const variant = browserControl ? join(root, 'tests', '.stage1-short-' + nonce + '.ts') : undefined;
  if (variant) {
    const original = readFileSync(join(root, file), 'utf8');
    const point = "      ledger.checked('browser-worker');";
    if (original.split(point).length !== 2) throw new Error('G7/control: unique worker witness not found');
    writeFileSync(variant, original.replace(point, point + '\n      console.log("G7/short-circuit-applied");\n      ledger.done();\n      return;'), { flag: 'wx' });
  }
  const args = ['pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.base.json', variant ?? file];
  if (id === 'js-destructured-iterable') args.push('--destructured-iterable');
  const started = performance.now();
  let result;
  try {
    const command = process.platform === 'linux' ? 'timeout' : 'corepack';
    const commandArgs = command === 'timeout' ? ['--kill-after=5s', '240s', 'corepack', ...args] : args;
    const inherited = profile === 'frozen-pack' ? process.env : { ...process.env, TRACECODE_G7_INSTALLED_PACKAGE: '' };
    result = spawnSync(command, commandArgs, {
      cwd: root,
      env: {
        ...inherited,
        NODE_OPTIONS: `--import=${preload}`,
        TRACECODE_SUITE_LEDGER: ledger,
        TRACECODE_SUITE_NONCE: nonce,
        TRACECODE_SUITE_ROOT: root,
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    if (variant) rmSync(variant, { force: true });
  }
  const log = result.stdout + result.stderr;
  writeFileSync(join(output, `${profile}-${id}.log`), log);
  const events = readSuiteEvents(ledger);
  const terminal = events.find((event) => event.kind === 'process-end' && event.leaf === file);
  const checks = events.filter((event) => event.kind === 'assertion');
  const issues = missingEvidence(id, assertions, events);
  const ms = Math.round(performance.now() - started);
  console.log(`G7/${profile}/${id} exit=${result.status} ms=${ms} checked=${checks.length}`);
  if (browserControl) {
    const expected = ['submit', 'run'].map((check) => `G7/suite/${id}/missing-assertion/${check}`);
    if (result.status !== 0 || result.error || log.split('G7/short-circuit-applied').length !== 2 || checks.length !== 1 || checks[0].id !== 'browser-worker' ||
        JSON.stringify(issues) !== JSON.stringify(expected)) {
      console.error('G7/browser-control: wrong stimulus, setup failure, or mutant survived');
      process.exitCode = 2;
    } else {
      console.error(issues.join('\n'));
      console.log('G7/browser-control: short-circuit hit=1 after browser worker start');
      process.exitCode = 1;
    }
    break;
  }
  if (profile === 'baseline') {
    const symptom = id === 'js-destructured-iterable'
      ? /Unable to load TypeScript compiler.*Unexpected importScripts/u
      : /Could not resolve .*@(tracecode\/tracekernel|tracecode\/runtime-contracts)/u;
    if (!terminal || result.error || terminal.nonce !== nonce || result.status !== 1 ||
        !symptom.test(log) || terminal.assertions.length !== 0) {
      console.error(`G7/${profile}/${id}: could not witness a pre-assertion failure`);
      unexpected.push(id);
    } else {
      console.log(`G7/${profile}/${id}/${id === 'js-destructured-iterable' ? 'unwitnessed-learner-assignment' : 'zero-assertions'}`);
    }
  } else if (result.status !== 0 || result.error || issues.length || !terminal) {
    console.error(issues.join('\n'));
    unexpected.push(id);
  }
}
if (!browserControl) {
  writeFileSync(join(output, `${profile}-verdict.json`), JSON.stringify({ unexpected }, null, 2) + '\n');
  process.exitCode = Number(unexpected.length !== 0);
}
