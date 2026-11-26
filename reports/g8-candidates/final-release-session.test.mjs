import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const session = await readFile(new URL('./session-final-release.sh', import.meta.url), 'utf8');
const dependencyStage = await readFile(
  new URL('./stage-final-release-dependencies.sh', import.meta.url), 'utf8');
const preflight = await readFile(new URL('./preflight-final-release.sh', import.meta.url), 'utf8');
const javaRunner = await readFile(new URL('./java-runner/run-g8.mjs', import.meta.url), 'utf8');
const preflightJob = await readFile(
  new URL('./run-final-release-preflight-job.sh', import.meta.url), 'utf8');

test('final session creates temporary runners under its self-contained stage', () => {
  assert.match(session, /test -d "\$stage\/node_modules" -a ! -L "\$stage\/node_modules"/u);
  assert.ok(session.indexOf('cd "$stage"') < session.indexOf('run_python()'));
  assert.match(session, /export SPEED_G8_RUNNER_COMMIT=/u);
  assert.match(javaRunner, /process\.env\.SPEED_G8_RUNNER_COMMIT/u);
});

test('dependency staging copies a real tree and rejects links outside the stage', () => {
  assert.match(dependencyStage, /cp -aL --reflink=auto/u);
  assert.match(dependencyStage, /@esbuild\/linux-x64/u);
  assert.match(dependencyStage, /playwright-core/u);
  assert.match(dependencyStage, /Runner dependency escapes stage/u);
  assert.doesNotMatch(dependencyStage, /\/tmp\//u);
});

test('ordinary preflight exercises every final version attempt without scoring', () => {
  assert.match(preflight, /SPEED_G8_PREFLIGHT_ORDINARY/u);
  assert.match(preflight, /assert\.equal\(kept, 206\)/u);
  assert.match(preflight, /local scope="\$1" dir window=phone left\n  dir=/u);
  assert.doesNotMatch(preflight, /heavy-exclusive|score-final-release/u);
  assert.match(preflightJob, /SPEED_G8_PREFLIGHT_ORDINARY=1/u);
  assert.doesNotMatch(preflightJob, /heavy-exclusive/u);
});

test('C# lesson continuation enables only the strict captured promotion shapes', () => {
  assert.match(javaRunner,
    /allowCsharpTrustedPromotion:[\s\S]*group\.journey === 'lesson'/u);
  assert.match(javaRunner,
    /csharpPromotedExecutionType:[\s\S]*group\.journey === 'lesson'[\s\S]*version\.startsWith\('candidate-'\)/u);
  assert.match(javaRunner,
    /csharpPromotedPrepareRole:[\s\S]*group\.journey === 'lesson'[\s\S]*\? 'ordinary'[\s\S]*: 'observer'/u);
  assert.match(javaRunner,
    /requireCsharpTrustedPromotionEvidence:[\s\S]*group\.journey === 'lesson'/u);
});
