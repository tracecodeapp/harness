#!/usr/bin/env bash
set -euo pipefail
source_test=tests/test-tracekernel-hardening.ts
prefix=$(mktemp tests/.stage1-recorder-XXXXXX)
variant="$prefix.ts"
trap 'rm -f "$prefix" "$variant"' EXIT

run() {
  corepack pnpm exec tsx --tsconfig tsconfig.base.json "$1" --destructured-iterable
}

run "$source_test"
echo "G7/recorder-control: healthy passed"
python3 - "$source_test" "$variant" <<'PY'
from pathlib import Path
import sys
source, target = map(Path, sys.argv[1:])
text = source.read_text()
begin = text.index("async function testJavaScriptDestructuredIterableTracingDoesNotExhaustValues")
needle = "  const result = await response;"
index = text.index(needle, begin) + len(needle)
# Suppress only the recorder events received by the hardening fixture.
target.write_text(text[:index] + """
  if (result.trace?.events?.some((event) =>
    event.kind === 'write' && event.line === 18 && event.target?.variable === 'total' && event.value === 23
  )) {
    console.log('G7/recorder-control/suppression-applied');
    result.trace.events = [];
  }""" + text[index:])
PY
status=0
red=$(run "$variant" 2>&1) || status=$?
if [ "$status" = 0 ]; then
  echo "G7/recorder-control: suppressing the recorder passed"
  exit 1
fi
test "$status" = 1
test "$(grep -Fxc 'G7/recorder-control/suppression-applied' <<<"$red")" = 1
grep -F 'G7/suite/js-destructured-iterable/missing-assertion/learner-assignment' <<<"$red"
echo "G7/recorder-control: anchored learner assignment missing, hit=1"
run "$source_test"
echo "G7/recorder-control: repaired passed"
