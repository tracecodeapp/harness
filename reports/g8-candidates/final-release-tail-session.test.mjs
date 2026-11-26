import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wrapper = await readFile(
  new URL('./session-and-score-final-release-tail.sh', import.meta.url), 'utf8');
const session = await readFile(new URL('./session-final-release-tail.sh', import.meta.url), 'utf8');
const runner = await readFile(new URL('./java-runner/run-g8.mjs', import.meta.url), 'utf8');

test('tail derives a unique Session 3 or 4 directory and prefix from its plan', () => {
  assert.match(wrapper, /final-release-session\$\{sample_session\}-\$\(date -u \+%Y%m%dT%H%M%SZ\)/u);
  assert.match(session, /SPEED_G8_OUTPUT_TAG="\$output_tag"/u);
  assert.match(session, /\$output_tag-final-\$language-\$scope\.log/u);
  assert.match(runner, /session: finalReleaseTail\?\.sampleSession/u);
});

test('tail selection cannot run outside final-release remainder mode', () => {
  assert.match(runner,
    /finalReleaseTailFile === undefined \|\| finalReleaseRemainder && \/\^session\[34\]\$\/u\.test\(outputTag\)/u);
  assert.match(runner, /sourceGroupIndex: originalGroupIndex/u);
});

test('tail wrapper derives its cap before taking heavy-exclusive', () => {
  assert.ok(wrapper.indexOf('cap_minutes=') < wrapper.indexOf('heavy-exclusive'));
  assert.match(wrapper, /g8_stop_and_verify/u);
});
