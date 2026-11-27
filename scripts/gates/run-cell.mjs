import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostInputs } from './host-pins.mjs';
import { git, loadCell, resolveCommit } from './inventory.mjs';
import { busyHarnessJobs, readJobs } from './job-log.mjs';
import { readPass, resultPath, storePath, writeResult } from './result-store.mjs';

const script = 'scripts/gates/run-cell.mjs';
const gateLogs = '/root/ci/gate-logs';

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${program} stopped by ${result.signal}.`);
  return result.status;
}

function execute(output) {
  const { cell, rev, gateCommit, hash, hostPins } = JSON.parse(readFileSync(join(output, 'input.json'), 'utf8'));
  const jobId = process.env.HEAVY_JOBLOG_ID;
  if (!jobId) throw new Error('Run this cell through the logging heavy wrapper.');
  writeFileSync(join(output, 'job-id'), jobId + '\n');
  if (resolveCommit('HEAD') !== rev || git('status', '--porcelain')) {
    throw new Error('Use a fresh worktree at the requested revision.');
  }
  const checkPins = () => {
    if (JSON.stringify(hostInputs(cell).pins) !== JSON.stringify(hostPins)) {
      throw new Error('Host inputs changed after lookup. Restage the pinned inputs and retry.');
    }
  };
  checkPins();
  const env = { ...process.env, GATE_OUTPUT: output, GATE_REV: rev, GATE_BRANCH_HEAD: gateCommit ?? '',
    GATE_INPUT_HASH: hash, GATE_TARBALL_SHA256: hostPins.candidateTarballSha256 ?? '' };
  const command = [cell.setup, cell.command].filter(Boolean).join(' && ');
  const code = run('bash', ['-e', '-o', 'pipefail', '-c', command], { env });
  checkPins();
  return code;
}

function runCell(cellId, rev, force, lockedHash) {
  const cell = loadCell(rev, cellId);
  if (cell.host !== 'agentrunner') throw new Error(`Run ${cellId} on its declared host (${cell.host}). See docs/gates.md.`);
  const gateCommit = cell.pins.gateRef ? resolveCommit(cell.pins.gateRef) : undefined;
  const { pins: hostPins, inputs } = hostInputs(cell);
  const hostPinsFile = process.env.GATE_PREFLIGHT_PINS;
  writeFileSync(hostPinsFile, JSON.stringify(hostPins) + '\n');
  const hash = execFileSync(process.execPath, [
    'scripts/gates/cell-hash.mjs', cellId, '--rev', rev, '--host-pins', hostPinsFile,
  ], { encoding: 'utf8' }).trim();
  if (gateCommit && resolveCommit(cell.pins.gateRef) !== gateCommit) {
    throw new Error('The gate ref changed during lookup. Retry against the updated ref.');
  }
  const path = resultPath(storePath, cellId, hash);
  if (!lockedHash) {
    mkdirSync(dirname(path), { recursive: true });
    return run('flock', [path + '.lock', process.execPath, script, cellId, rev, force, hash]);
  }
  if (lockedHash !== hash) throw new Error('Inputs changed while waiting for the cache lock. Retry the cell.');
  const pass = !force && readPass(storePath, cellId, hash);
  if (pass) {
    console.log(`cached pass ${hash} (job ${pass.jobId}, ${pass.end})`);
    return 0;
  }
  const busy = busyHarnessJobs(readJobs());
  if (busy.length >= 2 || busy.some(({ queued }) => queued.lane === process.env.HEAVY_JOB_LANE)) {
    throw new Error('Harness slots are busy. Retry when a lane job ends.');
  }

  mkdirSync(gateLogs, { recursive: true });
  const output = mkdtempSync(join(gateLogs, cellId + '.'));
  writeFileSync(join(output, 'input.json'), JSON.stringify({ cell, rev, gateCommit, hash, hostPins }) + '\n');
  const logPath = join(output, 'job.log');
  const log = openSync(logPath, 'wx');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:TRACECODE_|HEAVY_|GB_|TSX_|NODE_OPTIONS$|BASH_ENV$|ENV$)/.test(key)));
  Object.assign(env, inputs, {
    CI: '1', HEAVY_JOB_LANE: process.env.HEAVY_JOB_LANE, HEAVY_JOB_CANDIDATE: rev,
    HEAVY_JOB_CELL: cellId, HEAVY_JOB_INPUT_HASH: hash,
  });
  console.log(`running ${cellId} ${hash} (log ${logPath})`);
  let exitCode;
  try {
    exitCode = run('nice', ['-n', '10', 'ionice', '-c3', '/root/ci/bin/heavy', process.execPath, script, '--execute', output], {
      env, stdio: ['ignore', log, log],
    });
  } finally {
    closeSync(log);
  }
  const expectedJob = `${process.execPath} ${script} --execute ${output}`;
  const entry = [...readJobs().entries()].find(([, job]) => job.queued?.cmd === expectedJob);
  const [jobId, job] = entry ?? [];
  if (!job?.started || job.ended?.rc !== exitCode ||
    readFileSync(join(output, 'job-id'), 'utf8').trim() !== jobId) {
    throw new Error(`Incomplete heavy receipt for ${output}. Inspect ${logPath} and retry.`);
  }
  const status = exitCode === 0 ? 'pass' : 'fail';
  writeResult(storePath, { cell: cellId, hash, status, exitCode, jobId, rev, gateCommit, hostPins,
    start: job.started.ts, end: job.ended.ts, logPath });
  console.log(`${status} ${hash} (job ${jobId}, ${job.ended.ts}, exit ${exitCode})`);
  return exitCode;
}

try {
  const [, , cellId, rev, force, lockedHash] = process.argv;
  process.exitCode = cellId === '--execute' ? execute(rev) : runCell(cellId, rev, force, lockedHash);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
