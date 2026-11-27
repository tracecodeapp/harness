import assert from 'node:assert/strict';
import test from 'node:test';
import { passesChangelogCheck } from '../scripts/check-changelog.mjs';

const publicPaths = [
  'src/index.ts',
  'packages/judge/src/index.ts',
  'workers/java/worker.js',
  'packages/tracekernel/package.json',
  'package.json',
];

test('each listed path requires a changelog entry or an opt-out', () => {
  for (const path of publicPaths) {
    assert.equal(passesChangelogCheck([path], 'Summary'), false, path);
  }
});

test('a CHANGELOG.md diff passes', () => {
  assert.equal(passesChangelogCheck([...publicPaths, 'CHANGELOG.md']), true);
});

test('an exact opt-out line passes', () => {
  assert.equal(passesChangelogCheck(publicPaths, 'Summary\n\nChangelog: none\n'), true);
});

test('a CRLF body with trailing spaces passes', () => {
  assert.equal(passesChangelogCheck(publicPaths, 'Summary\r\nChangelog: none  \r\n'), true);
});

test('punctuation, leading indentation and embedded text invalidate the opt-out', () => {
  for (const body of ['Changelog: none.', ' Changelog: none', 'See Changelog: none']) {
    assert.equal(passesChangelogCheck(publicPaths, body), false, body);
  }
});

test('an empty, missing or null body fails', () => {
  for (const body of ['', undefined, null]) {
    assert.equal(passesChangelogCheck(publicPaths, body), false, String(body));
  }
});

test('unlisted paths alone pass', () => {
  assert.equal(passesChangelogCheck(['docs/publishing.md', 'tests/foo.ts', 'packages/judge/README.md']), true);
});
