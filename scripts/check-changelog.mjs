import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const changelogPaths = [
  /^src\//,
  /^packages\/[^/]+\/src\//,
  /^workers\//,
  /^packages\/[^/]+\/package\.json$/,
  /^package\.json$/,
];

export function passesChangelogCheck(paths, body = '') {
  return paths.includes('CHANGELOG.md')
    || !paths.some((path) => changelogPaths.some((pattern) => pattern.test(path)))
    || (body ?? '').split('\n').some((line) => line.replace(/\r/g, '').replace(/ +$/, '') === 'Changelog: none');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { base, head, body } = event.pull_request;
  if (![base.sha, head.sha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error('Expected Git commit SHAs for the pull request base and head');
  }

  // Include both paths of a move so leaving a public directory still triggers the check.
  const paths = execFileSync('git', [
    'diff', '--name-only', '--no-renames', '-z', `${base.sha}...${head.sha}`, '--',
  ], { encoding: 'utf8' }).split('\0');

  if (!passesChangelogCheck(paths, body)) {
    console.error('Update CHANGELOG.md or add a line reading Changelog: none to the PR body.');
    process.exitCode = 1;
  }
}
