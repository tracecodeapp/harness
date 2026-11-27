import { parseArgs } from 'node:util';
import { readJobs } from './job-log.mjs';
import { readResults, storePath } from './result-store.mjs';

function elapsed(start, end) {
  return start && end ? (Date.parse(end.ts) - Date.parse(start.ts)) / 1000 : null;
}

function report() {
  const { values } = parseArgs({
    options: { since: { type: 'string' }, 'lane-prefix': { type: 'string', default: 'h022-' } },
  });
  const since = values.since ? Date.parse(values.since) : -Infinity;
  if (Number.isNaN(since)) throw new Error('Use --since with an ISO timestamp.');
  const groups = new Map();
  const totals = new Map();
  const records = new Map(readResults(storePath).map((record) => [record.jobId, record]));
  for (const [id, { queued, started, ended }] of readJobs()) {
    if (!queued?.lane?.startsWith(values['lane-prefix']) || Date.parse(queued.ts) < since) continue;
    const key = JSON.stringify([queued.lane, queued.candidate, queued.cell]);
    const jobs = groups.get(key) ?? [];
    const run = elapsed(started, ended);
    jobs.push({
      id, queued: queued.ts, queueSeconds: elapsed(queued, started), runSeconds: run,
      result: ended ? ended.rc === 0 ? 'pass' : 'fail' : started ? 'running' : 'queued',
      exitCode: ended?.rc, hash: queued.input_hash, logPath: records.get(id)?.logPath,
    });
    groups.set(key, jobs);
    totals.set(queued.lane, (totals.get(queued.lane) ?? 0) + (run ?? 0));
  }
  const sum = (jobs, field) => jobs.reduce((total, job) => total + (job[field] ?? 0), 0);
  const cells = [...groups.keys()].sort().map((key) => {
    const [lane, candidate, cell] = JSON.parse(key);
    const jobs = groups.get(key);
    return {
      lane, candidate, cell, count: jobs.length, queueSeconds: sum(jobs, 'queueSeconds'),
      runSeconds: sum(jobs, 'runSeconds'), jobs,
    };
  });
  const hostHoursByLane = Object.fromEntries([...totals.keys()].sort().map((lane) =>
    [lane, totals.get(lane) / 3600]));
  console.log(JSON.stringify({ cells, hostHoursByLane }, null, 2));
}

try {
  report();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
