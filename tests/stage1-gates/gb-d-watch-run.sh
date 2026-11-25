#!/usr/bin/env bash
# Run once the coordinator supplies the carried pin and grants a shared AgentRunner slot.
set -euo pipefail

step() {
  local name=$1 code=0
  shift
  "$@" || code=$?
  printf 'STEP %s exit=%s\n' "$name" "$code" >&2
  if [[ ${status_log:-} ]]; then
    printf '%s\t%s\n' "$name" "$code" >> "$status_log"
  fi
  return "$code"
}

verify_pin() {
  local recorded filename
  read -r recorded filename < "$tarball.sha256" || return
  [[ $recorded == "$pin" && $filename == "${tarball##*/}" ]] || return 2
  printf '%s  %s\n' "$pin" "$tarball" | sha256sum --check -
}

if [[ ${1:-} == --on-host ]]; then
  shift
  subject=$1 tarball=$2 pin=$3
  status_log=gb-d-watch-steps.tsv
  printf 'step\texit\n' > "$status_log"
  step verify-pin verify_pin
  controls=0 gate=0
  step seeded-controls node --test tests/stage1-gates/gb-controls.test.mjs || controls=$?
  step installed-deadline-gate env CI=1 GB_LANGUAGES=java,python GB_FIXTURES=transport \
    GB_ROUTES=deadline-keep,deadline-stop TRACECODE_STAGE1_SUBJECT="$subject" \
    TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball" TRACECODE_STAGE1_SUBJECT_SHA256="$pin" \
    bash tests/stage1-gates/gb-pack.sh d-watch || gate=$?
  if (( controls != 0 )); then exit "$controls"; fi
  exit "$gate"
fi

if [[ $# != 4 ]]; then
  printf '%s\n' 'Usage: gb-d-watch-run.sh SUBJECT HOST_TARBALL SHA256 OUTPUT_DIR' >&2
  exit 2
fi
subject=$1 tarball=$2 pin=$3 output=$4
[[ $subject =~ ^[0-9a-f]{40}$ && $pin =~ ^[0-9a-f]{64}$ &&
   $tarball =~ ^/root/ci/[A-Za-z0-9._/-]+\.tgz$ && $tarball != */../* ]] || exit 2
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
runner=$(git -C "$repo" rev-parse HEAD)
tool="$HOME/Code/tracecodeapp/harness-artifacts/tools/ar-harness.sh"
[[ -z $(git -C "$repo" status --porcelain) ]] || exit 2
step evidence-output mkdir -p "$output"
exec > >(tee "$output/launch.log") 2>&1
suffix="gb-d-watch-${subject:0:8}-$(date -u +%Y%m%dT%H%M%SZ)"

collect_evidence() {
  ssh -o BatchMode=yes agentrunner bash -s -- "/root/ci/work-harness-$suffix" <<'HOST' | tar -xf - -C "$output"
set -e
cd "$1"
set --
for file in install.log run.log gb-d-watch-steps.tsv gate-evidence/d-watch/{candidate,runner,tarball,installed-judge}.sha* \
            gate-evidence/d-watch/{planned.json,raw.ndjson,gb-*.json}; do
  if [[ -f $file ]]; then set -- "$@" "$file"; fi
done
test "$#" -gt 0
tar -cf - -- "$@"
HOST
}

check_inventory() {
  node --input-type=module - "$output" "$subject" "$pin" "$runner" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [output, subject, pin, runner] = process.argv.slice(2);
const folder = path.join(output, 'gate-evidence', 'd-watch');
const files = fs.readdirSync(folder).filter((file) => /^gb-.*\.json$/.test(file));
assert.equal(files.length, 1);
const report = JSON.parse(fs.readFileSync(path.join(folder, files[0]), 'utf8'));
assert.equal(report.candidate, subject);
assert.equal(report.sha256, pin);
assert.equal(report.head, runner);
assert.deepEqual(report.unexpected, []);
assert.deepEqual(report.repeated, []);
assert.deepEqual(report.notes, []);
assert.deepEqual(report.phases.map(({ id }) => id).sort(),
  ['java', 'python'].flatMap((language) => ['keep', 'stop'].map((stop) => `G4/${language}/transport/deadline-${stop}`)));
const routes = report.phases.map(({ id, expected, receipts, missing, step8Owned }) => {
  assert.equal(expected.length, 41);
  assert.deepEqual(step8Owned, []);
  assert.deepEqual([...receipts.map((receipt) => receipt.id), ...missing].sort(), [...expected].sort());
  return { id, passed: receipts.filter(({ status }) => status === 'passed').length,
    failures: receipts.filter(({ status }) => status === 'failed'), missing };
});
const ledger = { subject, pin, runner, routes };
fs.writeFileSync(path.join(output, 'deadline-ledger.json'), JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify(ledger, null, 2));
NODE
}

job=0 transfer=0 cleanup=0 inventory=0
step shared-slot env GIT_SSH_COMMAND='ssh -o BatchMode=yes' \
  bash "$tool" "$repo" "$suffix" bash tests/stage1-gates/gb-d-watch-run.sh \
  --on-host "$subject" "$tarball" "$pin" || job=$?
if (( job == 255 || job == 3 )); then exit "$job"; fi
step collect-evidence collect_evidence || transfer=$?
step clean-host-job bash "$tool" "$repo" "$suffix" --cleanup || cleanup=$?
step verify-inventory check_inventory || inventory=$?
for code in "$cleanup" "$transfer" "$inventory" "$job"; do
  if (( code != 0 )); then exit "$code"; fi
done
