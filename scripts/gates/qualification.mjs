import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './host-pins.mjs';
import { git } from './inventory.mjs';

const installArgs = ['install', '--frozen-lockfile', '--prefer-offline'];

function command(bin, args, options = {}) {
  execFileSync(bin, args, { stdio: 'inherit', ...options });
}

function runW(language, runner, gateHead, output) {
  const support = 'scripts/untraced-host-history.browser.ts';
  for (const file of [runner, support]) writeFileSync(file, git('show', gateHead + ':' + file));
  command('pnpm', installArgs);
  command('pnpm', ['build:tracekernel']);
  command('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.base.json', runner, language], {
    env: {
      ...process.env,
      TRACECODE_HOST_HISTORY_PROFILE: 'both',
      TRACECODE_HOST_HISTORY_APP_DATA: process.env.GATE_APP_DATA,
      TRACECODE_HOST_HISTORY_REPORT: join(output, 'host-history.json'),
    },
  });
}

function stageGate(gateHead, output) {
  const root = join(output, 'driver');
  mkdirSync(root);
  const archive = execFileSync('git', ['archive', gateHead, 'tests/stage1-gates'], { maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

function runPacked(gate, language, runner, gateHead, output) {
  const { GATE_CANDIDATE_TARBALL: tarball, GATE_TARBALL_SHA256: expectedSha, GATE_REV: rev } = process.env;
  if (sha256(tarball) !== expectedSha) throw new Error('Candidate tarball changed after the lookup.');
  command('pnpm', installArgs);
  const driver = stageGate(gateHead, output);
  const consumer = join(driver, 'consumer');
  const assets = join(output, 'workers');
  const receipts = join(output, 'receipts');
  mkdirSync(consumer);
  mkdirSync(receipts);
  writeFileSync(join(consumer, 'package.json'), '{"name":"gate-consumer","private":true,"type":"module"}\n');
  command('pnpm', ['--ignore-workspace', 'add', '--prefer-offline', '--ignore-scripts', tarball], { cwd: consumer });
  const installed = realpathSync(join(consumer, 'node_modules/@tracecode/harness/dist/judge.js'));
  if (!installed.startsWith(join(consumer, 'node_modules/.pnpm') + '/')) {
    throw new Error('Install the candidate into the isolated consumer.');
  }
  const packed = execFileSync('tar', ['-xOzf', tarball, 'package/dist/judge.js'], { maxBuffer: 32 * 1024 * 1024 });
  const packedSha = createHash('sha256').update(packed).digest('hex');
  if (sha256(installed) !== packedSha) throw new Error('Installed /judge differs from the candidate tarball.');
  command(process.execPath, [join(consumer, 'node_modules/@tracecode/harness/dist/cli.cjs'), 'sync-assets', assets, '--inventory']);
  writeFileSync(join(receipts, 'candidate.sha'), rev + '\n');
  writeFileSync(join(receipts, 'runner.sha'), gateHead + '\n');
  const env = {
    ...process.env,
    TRACECODE_STAGE1_SUBJECT: rev,
    TRACECODE_STAGE1_VERIFIED_JUDGE: installed,
    TRACECODE_STAGE1_MUX_INPUT: process.env.GATE_MUX_SOURCE,
    ...(gate === 'ga' ? {
      TRACECODE_STAGE1_CANDIDATE_SOURCE: process.cwd(),
      TRACECODE_STAGE1_FILTER: `^G[16]/${language}/`,
      TRACECODE_STAGE1_RECEIPT_LANGUAGES: language,
      TRACECODE_STAGE1_APP_INPUT: language === 'cpp' ? process.env.GATE_APP_DATA : '',
    } : { GB_LANGUAGES: language }),
  };
  command(process.execPath, [join(driver, runner), consumer, assets, receipts], { env });
}

try {
  const [, , gate, language, runner] = process.argv;
  const { GATE_BRANCH_HEAD: gateHead, GATE_OUTPUT: output } = process.env;
  if (!gateHead || !output) throw new Error('Run this qualification cell with scripts/gates/run-cell.sh.');
  if (gate === 'w') runW(language, runner, gateHead, output);
  else if (gate === 'ga' || gate === 'gb') runPacked(gate, language, runner, gateHead, output);
  else throw new Error(`Unknown qualification gate ${gate}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status ?? 2;
}
