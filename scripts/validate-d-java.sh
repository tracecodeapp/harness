#!/usr/bin/env bash
# Run in one scheduled build-host slot, from the candidate checkout.
# Usage: bash scripts/validate-d-java.sh PINNED_MUX_DIR
set -euo pipefail

if [[ ${1:-} != --steps && ${1:-} != --gb-stable ]]; then
  if [[ $# -ne 1 || ! -f "$1/mux.sha" ]]; then
    echo "Usage: bash scripts/validate-d-java.sh PINNED_MUX_DIR" >&2
    exit 2
  fi
  mux=$(realpath "$1")
  cd "$(git rev-parse --show-toplevel)"
  if [[ -n ${D_JAVA_EVIDENCE_DIR:-} ]]; then
    mkdir "$D_JAVA_EVIDENCE_DIR"
    evidence=$(realpath "$D_JAVA_EVIDENCE_DIR")
  else
    evidence=$(mktemp -d "$PWD/d-java-evidence.XXXXXXXX")
  fi
  echo "evidence=$evidence"
  if [[ ${D_JAVA_MEASURE_RESOURCES:-1} == 0 ]]; then
    exec bash "$PWD/scripts/validate-d-java.sh" --steps "$evidence" "$mux"
  fi
  exec python3 - "$PWD/scripts/validate-d-java.sh" "$evidence" "$mux" <<'PY'
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

script, evidence, mux = sys.argv[1:]
evidence = Path(evidence)
ticks_per_second = os.sysconf("SC_CLK_TCK")
page_kib = os.sysconf("SC_PAGE_SIZE") / 1024


def sample_tree(root):
    children = {}
    with os.scandir("/proc") as entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                fields = (Path(entry.path) / "stat").read_text(errors="replace").rsplit(")", 1)[1].split()
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            parent = int(fields[1])
            # Waited-for descendants move from their own counters into cutime/cstime.
            cpu_ticks = sum(int(value) for value in fields[11:15])
            children.setdefault(parent, []).append(
                (int(entry.name), cpu_ticks, max(0, int(fields[21])) * page_kib)
            )

    def walk(pid):
        for child, cpu_ticks, rss_kib in children.get(pid, ()):
            yield cpu_ticks, rss_kib
            yield from walk(child)

    cpu_ticks = rss_kib = 0
    for ticks, rss in walk(root):
        cpu_ticks += ticks
        rss_kib += rss
    return cpu_ticks, rss_kib


started = previous_time = time.monotonic()
previous_ticks = peak_rss = peak_cpu = 0
job = subprocess.Popen(["bash", script, "--steps", str(evidence), mux])
while True:
    now = time.monotonic()
    ticks, rss = sample_tree(os.getpid())
    peak_rss = max(peak_rss, rss)
    if now - previous_time >= 0.5:
        peak_cpu = max(peak_cpu, (ticks - previous_ticks) / ticks_per_second / (now - previous_time))
        previous_time, previous_ticks = now, ticks
    try:
        status = job.wait(timeout=1)
        break
    except subprocess.TimeoutExpired:
        pass

usage = resource.getrusage(resource.RUSAGE_CHILDREN)
stats = {
    "exit": status if status >= 0 else 128 - status,
    "wall_seconds": round(time.monotonic() - started, 3),
    "cpu_seconds": round(usage.ru_utime + usage.ru_stime, 3),
    "sampled_peak_cpu_cores": round(peak_cpu, 3),
    "sampled_peak_aggregate_rss_mib": round(peak_rss / 1024, 1),
    "sampling_interval_seconds": 1,
}
receipt = json.dumps(stats, indent=2) + "\n"
(evidence / "resources.json").write_text(receipt)
print(receipt, end="")
sys.exit(stats["exit"])
PY
fi

evidence=$2
mux=$3
pnpm=(corepack pnpm)
gate_sha=a6c1485d9d165fe99861bc1028edc737d539edf5
mux_sha=82888fb7bc95272e43477ab5ae62b95cc28e9008
head=$(git rev-parse HEAD)
overall=0
ulimit -c 0
scratch=$(mktemp -d "$PWD/.d-java-validation.XXXXXXXX")
trap 'rm -r "$scratch"' EXIT

step() {
  local name=$1 started=$SECONDS status=0
  shift
  "$@" > "$evidence/$name.log" 2>&1 || status=$?
  printf '%s\t%d\t%d\n' "$name" "$status" "$((SECONDS - started))" | tee -a "$evidence/steps.tsv"
  if (( status != 0 )); then
    overall=1
    tail -30 "$evidence/$name.log" >&2
  fi
  return "$status"
}

gb_stable() (
  set -euo pipefail
  local gate="$scratch/gate" consumer="$scratch/consumer" assets="$scratch/assets"
  local report="$evidence/gb" packed_judge installed_judge
  local gb_git_dir=${D_JAVA_GB_GIT_DIR:-/root/ci/harness.git}
  mkdir -p "$gate" "$consumer" "$report"
  test "$(cat "$mux/mux.sha")" = "$mux_sha"
  if [[ -n ${D_JAVA_GB_SOURCE:-} ]]; then
    test "$(cat "$D_JAVA_GB_SOURCE/runner.sha")" = "$gate_sha"
    cp -R "$D_JAVA_GB_SOURCE/tests" "$gate/"
  else
    git --git-dir="$gb_git_dir" archive "$gate_sha" tests/stage1-gates | tar -xf - -C "$gate"
  fi
  ln -s "$PWD/packages" "$gate/packages"

  local pin_dir=$scratch
  if [[ ${D_JAVA_EXPORT_PIN:-0} == 1 ]]; then
    pin_dir="$evidence/pin"
    mkdir "$pin_dir"
  fi
  "${pnpm[@]}" pack --pack-destination "$pin_dir"
  local pins=("$pin_dir"/*.tgz)
  [[ ${#pins[@]} -eq 1 && -f ${pins[0]} ]]
  local pin=${pins[0]}
  (cd "$pin_dir" && sha256sum "$(basename "$pin")") > "$report/tarball.sha256"
  (cd "$pin_dir" && sha256sum --check "$report/tarball.sha256")
  if [[ ${D_JAVA_EXPORT_PIN:-0} == 1 ]]; then
    cp "$report/tarball.sha256" "$pin.sha256"
  fi
  printf '%s\n' "$head" > "$report/candidate.sha"
  printf '%s\n' "$gate_sha" > "$report/runner.sha"
  printf '%s\n' '{"name":"d-java-validation","type":"module","private":true}' > "$consumer/package.json"
  (
    cd "$consumer"
    "${pnpm[@]}" --ignore-workspace add --prefer-offline --ignore-scripts "$pin"
    node node_modules/@tracecode/harness/dist/cli.cjs sync-assets "$assets" --inventory
  )
  packed_judge=$(tar -xOzf "$pin" package/dist/judge.js | sha256sum | cut -d' ' -f1)
  installed_judge=$(realpath "$consumer/node_modules/@tracecode/harness/dist/judge.js")
  case "$installed_judge" in
    "$consumer/node_modules/.pnpm/"*) ;;
    *) echo "Judge resolved outside the isolated consumer: $installed_judge" >&2; exit 2 ;;
  esac
  printf '%s  %s\n' "$packed_judge" "$installed_judge" > "$report/installed-judge.sha256"
  sha256sum --check "$report/installed-judge.sha256"
  GB_LANGUAGES=java GB_FIXTURES=three-rows,stdout,step-cap,byte-cap \
    TRACECODE_STAGE1_SUBJECT="$head" TRACECODE_STAGE1_MUX_INPUT="$mux" \
    TRACECODE_STAGE1_VERIFIED_JUDGE="$installed_judge" \
    node "$gate/tests/stage1-gates/gb-run.mjs" "$consumer" "$assets" "$report"
)

if [[ $1 == --gb-stable ]]; then
  gb_stable
  exit
fi

printf 'candidate=%s\ngb_runner=%s\nmux=%s\n' "$head" "$gate_sha" "$mux_sha" | tee "$evidence/identity.txt"
printf 'step\texit\tseconds\n' > "$evidence/steps.tsv"

browser_install=(exec playwright install)
if [[ ${D_JAVA_PLAYWRIGHT_WITH_DEPS:-0} == 1 ]]; then
  browser_install+=(--with-deps)
fi
step browser-setup "${pnpm[@]}" "${browser_install[@]}" chromium firefox webkit || :
step tracekernel-build "${pnpm[@]}" build:tracekernel || :
for browser in chromium firefox webkit; do
  step "java-prepared-$browser" env TRACECODE_JAVA_PREPARED_ENGINES="$browser" \
    "${pnpm[@]}" test:java-prepared-provider:browser || :
done
step java-public-judge env TRACECODE_ALGORITHM_BATCH_LANGUAGES=java \
  "${pnpm[@]}" exec tsx --tsconfig tsconfig.base.json tests/test-browser-algorithm-batch.ts || :
step java-exit-zero-no-op env TRACECODE_JAVA_PREPARED_ENGINES=chromium TRACECODE_JAVA_EXIT_PROBE=1 \
  "${pnpm[@]}" test:java-prepared-provider:browser || :
if step package-build "${pnpm[@]}" build &&
  step package-source-identity git diff --exit-code HEAD -- packages src workers runtime-assets.lock.json; then
  step gb-stable bash "$0" --gb-stable "$evidence" "$mux" || :
else
  printf 'gb-stable\tskipped-package-prerequisite\t0\n' | tee -a "$evidence/steps.tsv"
fi
exit "$overall"
