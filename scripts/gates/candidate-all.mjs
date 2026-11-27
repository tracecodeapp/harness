import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { git, loadInventory, resolveCommit } from './inventory.mjs';
import { allowedEnvironment } from './host-pins.mjs';

const hosts = ['agentrunner', 'ci', 'laptop-unit'];
const ciBeforeBuild = [
  'runtime-info-sync', 'kernel-policy-sync', 'typescript-project-libs-sync', 'typecheck',
  'tracekernel-capabilities', 'runtime-assets-lock', 'build-tracekernel', 'python-sync',
  'runtime-contract', 'python-prepared-provider', 'native-python-serialization-limit',
  'python-runtime-snapshot-release', 'java-prepared-provider-chromium', 'build',
];

export function candidatePlan(cells) {
  return Object.fromEntries(hosts.map((host) => {
    const local = cells.filter((cell) => cell.host === host);
    if (host !== 'ci') return [host, local];
    const order = new Set(ciBeforeBuild);
    return [host, [
      ...ciBeforeBuild.map((id) => local.find((cell) => cell.id === id)).filter(Boolean),
      ...local.filter(({ id }) => !order.has(id)),
    ]];
  }));
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} stopped by ${result.signal}.`);
  return result.status;
}

function main() {
  const { values } = parseArgs({ options: { rev: { type: 'string' }, host: { type: 'string' } } });
  if (!values.rev || (values.host && !hosts.includes(values.host))) {
    throw new Error('Usage: node scripts/gates/candidate-all.mjs --rev <commit> [--host agentrunner|ci|laptop-unit]');
  }
  const rev = resolveCommit(values.rev);
  const plan = candidatePlan(loadInventory(rev).cells);
  if (!values.host) {
    const cellsByHost = Object.fromEntries(hosts.map((host) => [host, plan[host].map(({ id }) => id)]));
    console.log(JSON.stringify({ rev, cellsByHost }, null, 2));
    return 0;
  }
  if (values.host === 'agentrunner' && !/^h022-[a-z0-9-]+$/.test(process.env.HEAVY_JOB_LANE ?? '')) {
    throw new Error('Set HEAVY_JOB_LANE=h022-<lane> on agentrunner.');
  }
  if (values.host !== 'agentrunner' && (resolveCommit('HEAD') !== rev || git('status', '--porcelain'))) {
    throw new Error('Start with a clean disposable checkout at --rev on the declared host.');
  }
  const output = values.host === 'agentrunner' ? undefined : mkdtempSync(join(tmpdir(), 'gate-candidate-'));
  if (output) console.log(`Candidate gate output: ${output}`);
  const results = [];
  for (const cell of plan[values.host]) {
    let code;
    if (values.host === 'agentrunner') {
      code = run('bash', ['scripts/gates/run-cell.sh', cell.id, '--rev', rev], {
        ...process.env, GATE_WAIT_FOR_SLOT: '1',
      });
    } else {
      const cellOutput = join(output, cell.id);
      mkdirSync(cellOutput);
      const gateCommit = cell.pins.gateRef ? resolveCommit(cell.pins.gateRef) : '';
      const command = [cell.setup, cell.command].filter(Boolean).join(' && ');
      code = run('bash', ['-e', '-o', 'pipefail', '-c', command], {
        ...allowedEnvironment(), CI: '1', GATE_OUTPUT: cellOutput, GATE_BRANCH_HEAD: gateCommit, GATE_REV: rev,
      });
    }
    results.push({ cell: cell.id, exitCode: code });
  }
  console.log(JSON.stringify({ rev, host: values.host, results }, null, 2));
  return Number(results.some(({ exitCode }) => exitCode !== 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
