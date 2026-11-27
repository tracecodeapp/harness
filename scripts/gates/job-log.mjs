import { readFileSync } from 'node:fs';

export const jobLogPath = '/root/ci/job-log/jobs.jsonl';

export function readJobs(path = jobLogPath) {
  const source = readFileSync(path, 'utf8');
  const jobs = new Map();
  // A concurrent append may leave the last line incomplete in this read.
  for (const line of source.slice(0, source.lastIndexOf('\n') + 1).split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    const job = jobs.get(row.id) ?? {};
    job[row.event] = row;
    jobs.set(row.id, job);
  }
  return jobs;
}

export function busyHarnessJobs(jobs) {
  return [...jobs.values()].filter(({ queued, started, ended }) =>
    queued?.lane?.startsWith('h022-') && started && !ended);
}
