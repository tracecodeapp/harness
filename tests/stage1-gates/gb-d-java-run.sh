#!/usr/bin/env bash
set -euo pipefail

step() {
  local name=$1 status=0
  shift
  "$@" || status=$?
  printf 'STEP %s exit=%s\n' "$name" "$status" >&2
  if [[ ${step_log:-} ]]; then
    printf 'STEP %s exit=%s\n' "$name" "$status" >> "$step_log"
  fi
  return "$status"
}

verify_pin() {
  local recorded filename
  read -r recorded filename < "$tarball.sha256" || return
  [[ $recorded == "$pin" && $filename == "${tarball##*/}" ]] || return 2
  printf '%s  %s\n' "$pin" "$tarball" | sha256sum --check -
}

stage_host_mux() {
  mkdir gate-mux || return
  printf '%s' "$mux" | base64 -d | tar -xzf - -C gate-mux || return
  test "$(cat gate-mux/mux.sha)" = 82888fb7bc95272e43477ab5ae62b95cc28e9008
}

if [[ ${1:-} == --on-host ]]; then
  shift
  subject=$1 tarball=$2 pin=$3 mux=$4
  step_log=gb-step-status.log
  step verify-pin verify_pin
  step pinned-mux stage_host_mux
  controls=0 gate=0
  step seeded-controls node --test tests/stage1-gates/gb-controls.test.mjs || controls=$?
  step installed-gate env CI=1 GB_LANGUAGES=java TRACECODE_STAGE1_MUX_INPUT="$PWD/gate-mux" \
    TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball" \
    TRACECODE_STAGE1_SUBJECT_SHA256="$pin" bash tests/stage1-gates/gb-pack.sh d-java || gate=$?
  if (( controls != 0 )); then exit "$controls"; fi
  exit "$gate"
fi

if [[ $# -ne 5 ]]; then
  printf '%s\n' 'Usage: gb-d-java-run.sh SUBJECT HOST_TARBALL PIN OUTPUT_DIR BASELINE_DELTA' >&2
  exit 2
fi
subject=$1 tarball=$2 pin=$3 output=$4 baseline=$5
[[ $subject =~ ^[0-9a-f]{40}$ && $pin =~ ^[0-9a-f]{64}$ &&
   $tarball =~ ^/root/ci/coord-artifacts/[A-Za-z0-9._-]+\.tgz$ && -r $baseline ]] || exit 2
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tool="$HOME/Code/tracecodeapp/harness-artifacts/tools/ar-harness.sh"
mux_repo="$HOME/Code/tracecodeapp/multiplexer"
[[ -z $(git -C "$repo" status --porcelain) ]] || exit 2
step output mkdir -p "$output"
exec > >(tee "$output/launch.log") 2>&1
suffix="gb-d-java-${subject:0:8}-$(date -u +%Y%m%dT%H%M%SZ)"
mux_dir=$(mktemp -d /tmp/gb-d-java-run.XXXXXX)
trap 'rm -f "$mux_dir"/{judge-browser-slot.ts,project-wire.ts,mux.sha}; rmdir "$mux_dir"' EXIT
step stage-mux bash "$repo/tests/stage1-gates/stage-mux.sh" "$mux_repo" "$mux_dir"
encode_mux() {
  mux=$(tar -czf - -C "$mux_dir" judge-browser-slot.ts project-wire.ts mux.sha | base64 | tr -d '\n')
}
step encode-mux encode_mux

fetch_evidence() {
  ssh -o BatchMode=yes agentrunner bash -s -- "/root/ci/work-harness-$suffix" <<'HOST' | tar -xf - -C "$output"
set -e
cd "$1"
set --
for file in install.log run.log gb-step-status.log gate-evidence/d-java/{candidate,runner,tarball,installed-judge}.sha* \
            gate-evidence/d-java/{raw.ndjson,gb-*.json}; do
  if [[ -f $file ]]; then set -- "$@" "$file"; fi
done
test "$#" -gt 0
tar -cf - -- "$@"
HOST
}

compare_ids() {
  node --input-type=module - "$baseline" "$output" "$subject" "$pin" "$(git -C "$repo" rev-parse HEAD)" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [baselinePath, output, subject, pin, gate] = process.argv.slice(2);
const dir = path.join(output, 'gate-evidence', 'd-java');
const reports = fs.readdirSync(dir).filter((file) => /^gb-.*\.json$/.test(file));
assert.equal(reports.length, 1);
const report = JSON.parse(fs.readFileSync(path.join(dir, reports[0]), 'utf8'));
assert.equal(report.candidate, subject);
assert.equal(report.sha256, pin);
assert.equal(report.head, gate);
assert.equal(report.muxPin, '82888fb7bc95272e43477ab5ae62b95cc28e9008');
assert.deepEqual(report.unexpected, []);
assert.deepEqual(report.repeated, []);
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const current = new Map(report.phases.flatMap((phase) => [
  ...phase.receipts.map(({id, status}) => [id, status]),
  ...phase.missing.map((id) => [id, 'missing']),
  ...phase.step8Owned.map((id) => [id, 'step8Owned']),
]));
assert.deepEqual([...current.keys()].sort(), baseline.byID.map(({id}) => id).sort());
const byID = baseline.byID.map(({id, baseline: preDJava, candidate: archived}) => ({
  id, preDJava, archived, current: current.get(id),
}));
const byRoute = {};
for (const row of byID) {
  const route = row.id.split('/').slice(0, 4).join('/');
  const change = row.archived + ' → ' + row.current;
  const counts = byRoute[route] ??= {};
  counts[change] = (counts[change] ?? 0) + 1;
}
const regressions = byID.filter(({preDJava, archived, current}) =>
  (preDJava === 'passed' || archived === 'passed') && current !== 'passed');
const result = {
  subject, pin, gate, storedBaseline: baseline.candidateCommit, priorProduct: baseline.baselineCommit,
  counts: report.byLanguage, notes: report.notes, byRoute, regressions, byID,
};
fs.writeFileSync(path.join(output, 'gb-delta-by-id.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ counts: result.counts, byRoute, regressions }, null, 2));
NODE
}

job_status=0 fetch_status=0 cleanup_status=0 delta_status=0
step shared-slot env GIT_SSH_COMMAND='ssh -o BatchMode=yes' \
  bash "$tool" "$repo" "$suffix" bash tests/stage1-gates/gb-d-java-run.sh \
  --on-host "$subject" "$tarball" "$pin" "$mux" || job_status=$?
# With BatchMode, SSH exits on an unavailable or unauthorized connection.
if (( job_status == 255 || job_status == 3 )); then exit "$job_status"; fi
step collect-evidence fetch_evidence || fetch_status=$?
step clean-host-job bash "$tool" "$repo" "$suffix" --cleanup || cleanup_status=$?
step delta-by-id compare_ids || delta_status=$?
for status in "$cleanup_status" "$fetch_status" "$delta_status" "$job_status"; do
  if (( status != 0 )); then exit "$status"; fi
done
