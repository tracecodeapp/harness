import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { metricEndpoints, stats } from './aa-score-lib.mjs';
import { production022, windowPlan022 } from './plan-022.mjs';
import { fails022Threshold } from './score-thresholds.mjs';
import { warmMetricName } from './warm-repeat-policy.mjs';

const schedule = windowPlan022();
const sha256 = /^[a-f0-9]{64}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const timingStats = ['median', 'p90'];
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function readSession(directory) {
  const metadata = await json(join(directory, 'window-metadata.json'));
  const rows = (await readFile(join(directory, 'window-samples.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(metadata.schema, 'tracecode.speed-022.window.v1');
  assert.match(metadata.rigCommit, commitSha);
  assert.equal(metadata.controlSha256, production022.sha256);
  assert.match(metadata.candidateSha256, sha256);
  for (const group of metadata.schedule) {
    assert.deepEqual(group, schedule[group.groupIndex], 'Session differs from the registered schedule');
  }
  const groups = new Map(metadata.schedule.map((group) => [group.groupIndex, []]));
  assert.equal(groups.size, metadata.schedule.length, 'Duplicate groups in session schedule');
  for (const row of rows) {
    const group = schedule[row.groupIndex];
    assert.ok(groups.has(row.groupIndex) && group.versions.includes(row.version), 'Unscheduled attempt');
    assert.equal(row.kept, !Boolean(row.invalid || row.refusal || row.excluded), 'Conflicting disposition');
    groups.get(row.groupIndex).push(row);
  }
  return { metadata, groups, directory };
}

function completedGroup(group, rows) {
  return group.versions.every((version) => {
    const kept = rows.filter((row) => row.version === version && row.kept);
    assert.ok(kept.length <= group.target, 'Too many kept attempts');
    assert.equal(new Set(kept.map(({ round }) => round)).size, kept.length, 'Duplicate kept rounds');
    return kept.length === group.target;
  });
}

function scoreCell(group, metric, rows, reference) {
  const [controlVersion, candidateVersion] = group.versions;
  const values = (version) => stats(rows.filter((row) => row.version === version && row.kept)
    .map((row) => {
      const value = row.metrics?.[metric];
      assert.ok(Number.isFinite(value) && value > 0, `Missing or invalid ${metric}`);
      return value;
    }));
  const control = values(controlVersion);
  const candidate = values(candidateVersion);
  const controlValid = reference && reference.aaPass !== false && timingStats.every((stat) => {
    assert.ok(Number.isFinite(reference[stat]) && reference[stat] > 0, `Invalid reference ${stat}`);
    return Math.abs(control[stat] / reference[stat] - 1) <= 0.10;
  });
  const failed = controlValid
    ? timingStats.filter((stat) => fails022Threshold(candidate[stat], control[stat])) : [];
  return {
    metric, control, candidate, failed,
    result: !controlValid ? 'controlInvalid' : failed.length ? 'fail' : 'pass',
  };
}

export async function score022(referenceFile, sessionDirectories) {
  assert.ok(sessionDirectories.length > 0, 'At least one window session is required');
  const reference = await json(referenceFile);
  assert.equal(reference.controlSha256, production022.sha256);
  const sessions = await Promise.all(sessionDirectories.map(readSession));
  const { rigCommit, candidateSha256 } = sessions[0].metadata;
  const allIndexes = new Set();
  for (const { metadata, groups } of sessions) {
    assert.equal(metadata.rigCommit, rigCommit, 'Rig commits differ between sessions');
    assert.equal(metadata.candidateSha256, candidateSha256, 'Candidate digests differ between sessions');
    for (const index of groups.keys()) allIndexes.add(index);
  }
  assert.ok(allIndexes.size > 0, 'No scheduled groups');
  const groups = [...allIndexes].sort((a, b) => a - b).map((index) => {
    const group = schedule[index];
    const sources = sessions.filter(({ groups }) => groups.has(index));
    const complete = sources.filter(({ groups }) => completedGroup(group, groups.get(index)));
    assert.ok(complete.length <= 1, `Group ${index} has multiple complete sessions`);
    const source = complete[0];
    const attempts = sources.flatMap(({ groups }) => groups.get(index));
    const counts = {
      invalid: attempts.filter(({ invalid }) => invalid).length,
      refusal: attempts.filter(({ refusal }) => refusal).length,
      excluded: attempts.filter(({ excluded }) => excluded).length,
    };
    return {
      group, counts,
      ...(source ? {
        source: source.directory,
        cells: metricEndpoints(group).map((endpoint) => {
          const metric = warmMetricName(group, endpoint);
          return scoreCell(group, metric, source.groups.get(index), reference.groups[index]?.[metric]);
        }),
      } : { incomplete: true, cells: [] }),
    };
  });
  const pass = groups.every(({ incomplete, cells }) =>
    !incomplete && cells.every(({ result }) => result === 'pass'));
  return { pass, rigCommit, controlSha256: production022.sha256, candidateSha256, groups };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reference, ...sessions] = process.argv.slice(2);
  assert.ok(reference && sessions.length, 'Usage: score-022.mjs <reference.json> <session> [...]');
  const score = await score022(reference, sessions);
  console.log(JSON.stringify(score));
  process.exitCode = Number(!score.pass);
}
