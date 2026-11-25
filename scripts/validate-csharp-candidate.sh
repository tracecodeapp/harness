#!/usr/bin/env bash
# Run on a Linux build host with the repository's pinned Node, pnpm and Chromium.
# Usage: bash scripts/validate-csharp-candidate.sh /path/to/new-report-directory
# Set TRACECODE_VALIDATION_KEEP_PACKAGE=1 to retain the smoke-tested tarball in the report.
set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/new-report-directory" >&2
  exit 2
fi
mkdir -- "$1" || exit 2
out=$(cd -- "$1" && pwd -P) || exit 2
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." || exit 2
git rev-parse HEAD > "$out/head.txt" || exit 2
git diff --exit-code HEAD || exit 2

export CI=1 GIT_TERMINAL_PROMPT=0
started=$SECONDS
printf 'step\texit\n' > "$out/results.tsv"

step() {
  local name=$1
  shift
  printf '\nBEGIN %s\n' "$name"
  "$@" 2>&1 | tee "$out/$name.log"
  step_status=$?
  printf '%s\t%s\n' "$name" "$step_status" | tee -a "$out/results.tsv"
}

build_candidate() {
  pnpm build && git diff --exit-code HEAD
}

installed_package() (
  set -euo pipefail
  git diff --exit-code HEAD
  shopt -s nullglob
  scratch=$(mktemp -d)
  trap 'rm -rf -- "$scratch"' EXIT
  pnpm pack --pack-destination "$scratch"
  tarballs=("$scratch"/*.tgz)
  if (( ${#tarballs[@]} != 1 )); then
    echo 'Expected one candidate package.' >&2
    exit 1
  fi
  tarball=${tarballs[0]}
  consumer="$scratch/consumer"
  site="$scratch/site"
  mkdir "$consumer" "$site"
  printf '%s\n' '{"name":"csharp-installed-smoke","private":true,"type":"module"}' > "$consumer/package.json"
  pnpm --dir "$consumer" --ignore-workspace add --ignore-scripts --prefer-offline "$tarball"
  package="$consumer/node_modules/@tracecode/harness"
  cmp <(tar -xOzf "$tarball" package/dist/judge.js) "$package/dist/judge.js"
  cmp runtime-assets.lock.json "$package/runtime-assets.lock.json"
  node "$package/dist/cli.cjs" sync-assets "$site/workers" --languages csharp
  node --input-type=module - "$consumer" "$site" <<'JS'
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const [consumer, site] = process.argv.slice(2);
const shim = join(consumer, 'node_modules/@tracecode/harness/dist/zlib-browser-shim.js');
const cases = [
  {
    id: 'list', input: { tree: false },
    expected: { __type__: 'ListNode', val: 7, next: null },
  },
  {
    id: 'tree', input: { tree: true },
    expected: { __type__: 'TreeNode', val: 9, left: null, right: null },
  },
];
const code = `public class Solution {
  public object solve(bool tree) {
    if (tree) {
      var node = new TreeNode(1);
      node.val = 9;
      if (node.value != 9) throw new System.Exception("Tree alias read");
      return node;
    }
    var list = new ListNode(1);
    list.value = 7;
    if (list.val != 7) throw new System.Exception("List alias write");
    return list;
  }
}`;

await build({
  stdin: {
    resolveDir: consumer,
    sourcefile: 'installed-csharp-smoke.js',
    contents: `
      import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '@tracecode/harness/judge';
      export async function run() {
        const host = createBrowserJudgeHost({ providers: ['csharp'], assetBaseUrl: '/workers' });
        try {
          const bundle = await createAlgorithmJudgeBundle({
            id: 'installed-csharp-node-shape',
            language: 'csharp',
            executionStyle: 'solution-method',
            functionName: 'solve',
            code: ${JSON.stringify(code)},
            cases: ${JSON.stringify(cases)},
            comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
          });
          const result = await host.evaluateAlgorithm({ bundle, stopAtFirstRunaway: true });
          return { verdict: result.verdict, cases: result.evaluation.cases };
        } finally {
          await host.dispose();
        }
      }
    `,
  },
  alias: { zlib: shim, 'node:zlib': shim },
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  bundle: true,
  outfile: join(site, 'smoke.mjs'),
});
await writeFile(join(site, 'index.html'), '<!doctype html><meta charset="utf-8">');
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = resolve(site, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    if (!file.startsWith(site + sep)) throw new Error('Invalid asset path');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Asset is not a file');
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', done);
});

let browser;
let deadline;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await Promise.race([
    page.evaluate(async () => (await import('/smoke.mjs')).run()),
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Installed C# Judge did not complete within 120 seconds')), 120_000);
    }),
  ]);
  assert.equal(result.verdict, 'passed', JSON.stringify(result));
  assert.deepEqual(result.cases.map(({ caseId, status, value }) => ({ caseId, status, value })),
    cases.map(({ id, expected }) => ({ caseId: id, status: 'completed', value: expected })));
  console.log('PASS: isolated installed C# Judge returned both canonical node shapes');
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.close();
  server.closeAllConnections();
}
JS
  if [[ ${TRACECODE_VALIDATION_KEEP_PACKAGE:-0} == 1 ]]; then
    mv -- "$tarball" "$out/candidate.tgz"
    tarball="$out/candidate.tgz"
  fi
  sha256sum "$tarball" | tee "$out/package.sha256"
)

suite_names=(csharp-public-surface csharp-runtime csharp-worker-browser tracekernel-csharp-browser installed-package)
setup=(install materialize build lock typecheck)
outcome=0
for name in "${setup[@]}"; do
  if (( outcome != 0 )); then
    printf '%s\tnot-run\n' "$name" | tee -a "$out/results.tsv"
    continue
  fi
  case "$name" in
    install) step "$name" pnpm install --frozen-lockfile ;;
    materialize) step "$name" pnpm materialize:csharp-role-assets ;;
    build) step "$name" build_candidate ;;
    lock) step "$name" pnpm test:runtime-assets-lock ;;
    typecheck) step "$name" pnpm typecheck ;;
  esac
  outcome=$step_status
done

if (( outcome == 0 )); then
  for name in "${suite_names[@]}"; do
    case "$name" in
      installed-package) step "$name" installed_package ;;
      tracekernel-csharp-browser) step "$name" pnpm test:tracekernel:csharp-browser ;;
      *) step "$name" pnpm "test:$name" ;;
    esac
    if (( step_status != 0 )); then outcome=1; fi
  done
else
  for name in "${suite_names[@]}"; do
    printf '%s\t%s\n' "$name" not-run | tee -a "$out/results.tsv"
  done
fi
printf 'elapsed_seconds=%s\n' "$((SECONDS - started))" | tee "$out/summary.txt"
exit "$outcome"
