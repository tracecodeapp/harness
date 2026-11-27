# Root Package Publishing

`@tracecode/harness` is the repository's only registry release. Every
`packages/*` workspace and every example application is private. Those
workspaces remain useful build, test, and ownership boundaries, but consumers
receive their APIs and assets through the root package's exported subpaths.

This boundary is enforced in three places:

1. Every non-root workspace manifest sets `"private": true`, so npm-compatible
   clients refuse to publish it.
2. `.npmrc` sets `include-workspace-root=false`, keeping the root release out
   of ordinary recursive workspace commands.
3. The root `prepublishOnly` lifecycle inventories the workspace and checks the
   release tag and runtime lock before the build, then rechecks the tag and
   generated runtime lock afterward. The workspace check verifies that every
   non-root manifest is private, verifies the root release wiring, and rejects
   recursive, filtered, or workspace-scoped publish environments. This matters
   because pnpm's recursive publish mode may select the workspace root specially
   even when ordinary recursive commands do not. `prepublishOnly` runs only for a directory
   publish; a tarball publish runs no lifecycle scripts, so the release process
   below runs the same checks explicitly before publishing.

Run the non-mutating audit directly:

```bash
pnpm release:check
```

For 0.x releases, backwards-incompatible public contract changes require a
minor version increment; patch releases must remain backwards compatible.

## Release process

The published bytes must be the bytes that were tested. `pnpm publish .` (and
so `pnpm release:root`) repacks the directory with npm's own packer, which
produces a different tarball (different shasum and integrity, same file paths)
from the `pnpm pack` artifact that the suites and consumer validation ran
against. From 0.20.1 on, **a release publishes the packed, tested tarball
itself**, and the guards that `prepublishOnly` would have run are run
explicitly first, because `npm publish <tarball>` runs no lifecycle scripts.

### 1. Freeze and validate a candidate

A candidate is an exact commit plus the tarball `pnpm pack` made from it after
`pnpm build`, identified by its sha256 and its runtime release ID
(`runtime-assets.lock.json` → `harness.releaseId`, read from the tarball:
`tar -xzOf <candidate.tgz> package/runtime-assets.lock.json`). Record the lock's
sha256 and release ID with the release evidence. Run the full suite and the
consumer validation (TraceCode's `validate-harness-release`) against that
tarball. Any change to the tree makes a new candidate.

From 0.22.0 the lock is generated, not committed. `pnpm build` writes it
(`generate:runtime-assets-lock`), `.gitignore` excludes it, and `files` ships
it, so the package still exports `@tracecode/harness/runtime-assets.lock.json`.
It is a function of the commit: the tracked `workers/` files, the engine
packages `pnpm-lock.yaml` pins, and the C# role artifacts. Pull requests never
commit it. `pnpm test:runtime-assets-lock` checks it in memory when no file is
present and byte-compares the file when one is. Through 0.21.0 the lock was
committed, so `git show v0.21.0:runtime-assets.lock.json` still works for
those tags.

### 2. Put the release commit on `main`

Merge the reviewed release tree so that `main` is the release commit,
preferably by fast-forward, so the tag names the tested commit:

```bash
git push origin <release-sha>:refs/heads/main
```

### 3. Release checkout: local branch `main` at the release commit

pnpm's publish guard rejects detached checkouts (`ERR_PNPM_GIT_UNKNOWN_BRANCH`,
publish-branch `master|main`), and the tag checks need a clean tree. Use a
fresh checkout on the local branch `main`, not the everyday working checkout:

```bash
git fetch origin main
git worktree add -B main <release-dir> origin/main   # only if no other worktree has `main` checked out
cd <release-dir>
test "$(git rev-parse HEAD)" = "<release-sha>"
```

`-B main` resets the local `main` branch to `origin/main`; check first that it
has nothing unpushed (`git rev-list origin/main..main` is empty). If another
worktree has `main` checked out, use a fresh clone instead
(`git clone --branch main <remote> <release-dir>`).

### 4. Reproduce the candidate

```bash
pnpm install --frozen-lockfile
pnpm materialize:csharp-role-assets   # packaged C# runtime files are gitignored
pnpm release:check
pnpm version:check
pnpm test:runtime-assets-lock
pnpm build
git diff --exit-code
pnpm pack --pack-destination <pack-dir>
shasum -a 256 <pack-dir>/tracecode-harness-<version>.tgz
```

The sha256 must equal the candidate's. If it differs, compare the unpacked
trees (`diff -r`); a file difference means stop. Either way, the file that is
published in step 6 is the **candidate tarball**, not a fresh pack. The lock is
ignored by git, so `git diff --exit-code` does not cover it;
`test:runtime-assets-lock` and step 6 do.

### 5. Tag

Create an annotated `v<version>` tag on the release commit and push it. The tag
is part of the release contract: generated open-source metadata links modified
runtime sources to that immutable GitHub ref. Never move a pushed release tag.

```bash
git tag -a v<version> -m "v<version>"
git push origin refs/tags/v<version>
pnpm release:tag-check
```

### 6. Publish the tested tarball

```bash
pnpm release:tarball <candidate.tgz> <candidate-sha256> --dry-run
pnpm release:tarball <candidate.tgz> <candidate-sha256>
```

`release:tarball` (`scripts/publish-release-tarball.mjs`) refuses to publish
unless:

- the file's sha256 is the candidate's;
- its package name and version are this checkout's;
- its `runtime-assets.lock.json`, and so its runtime release ID, is
  byte-identical to the lock the generator produces from this checkout, and to
  the checkout's built `runtime-assets.lock.json` if one is present;
- `release:check`, `release:tag-check` and `test:runtime-assets-lock` pass.
  A tarball publish runs no lifecycle scripts, so these are the guards
  `prepublishOnly` would run.

It then runs `npm publish <candidate.tgz> --access public --auth-type=web`.
Run it in an interactive terminal: npm's web second factor fails with `EOTP`
when output is redirected, and the script refuses a non-interactive publish.
`--dry-run` runs every check and prints the command without publishing.

### 7. Verify

The script prints the registry values to expect:

```bash
npm view @tracecode/harness@<version> dist.integrity dist.shasum
```

They must equal the printed `sha512-…` integrity and sha1 shasum of the
candidate. That proves the registry serves the tested bytes. npm can take a
while to list a new version: for 0.20.1 (52 MB), `npm view` returned E404 for
about fourteen minutes after npm printed `+ @tracecode/harness@0.20.1`. Wait
and retry; never republish.

### 8. Runtime assets

The consumer uploads the runtime assets from a checkout that pins exactly
`<version>` (TraceCode's `pnpm deploy:harness-runtime-assets`). Before
uploading, it checks the installed identity against the candidate:

```bash
node -p "require('@tracecode/harness/runtime-assets.lock.json').harness.releaseId"
```

From 0.20.2 the package exports `runtime-assets.lock.json`. For 0.20.1 and
earlier, read it by path
(`./node_modules/@tracecode/harness/runtime-assets.lock.json`); the specifier
above fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The upload is the whole staged runtime tree (`tracecode-harness sync-assets`),
not only the Harness components. The lock's `stagedInventory` records it: the
file and byte totals for every language, the totals per class and per staged
path group, and every alias by name. The classes are:

- `locked`: files the lock lists, the Harness components
  (`totalPackagedRuntimeBytes`) and the engine runtime entries
  (`engineDependencies.*.totalBytes`);
- `alias`: a second staged copy of a locked file. Today there is one:
  `project-cpp-worker.js`, a copy of the locked `workers/cpp/cpp-worker.js`
  (also staged as `cpp-worker.js`);
- `metadata`: staged files outside the locked totals: `THIRD_PARTY_NOTICES.md`,
  TraceCC's `cpp-runtime-manifest.json` and `tracecc-consumer-lock.json`, and
  TraceJVM's `legal/`, `source/` and `release.json`.

Summing the lock's component and engine totals therefore undercounts; use
`stagedInventory`. To get the per-file listing of what was staged, verified
against the target directory, sync with `--inventory`:

```bash
tracecode-harness sync-assets public/workers --inventory > staged-inventory.json
```

It prints every staged file with its size, sha256 and class, the totals, and
`matchesLock` (whether the staged totals equal the lock's `stagedInventory`).
It fails if a staged file is missing or differs, and it lists files in the
target that the Harness did not stage (`notStagedByHarness`), such as the
consumer's commit marker, without removing them.

For reference, 0.20.1 staged **607 files, 428,324,717 bytes** (reconciled by
hand before `stagedInventory` existed):

| Part | Files | Bytes |
| --- | ---: | ---: |
| `locked`: seven components, `tracecc` and `tracejvm` runtime entries | 348 | 425,626,587 |
| `metadata`: TraceJVM `legal/` files | 254 | 1,864,961 |
| `metadata`: TraceJVM `release.json` | 1 | 189,839 |
| `metadata`: TraceCC `cpp-runtime-manifest.json` and `tracecc-consumer-lock.json` | 2 | 8,541 |
| `metadata`: `THIRD_PARTY_NOTICES.md` | 1 | 10,886 |
| `alias`: `project-cpp-worker.js` (of `workers/cpp/cpp-worker.js`) | 1 | 623,903 |

Record the staged inventory with each release, and compare it with the
consumer's publication `--check` output before uploading. The consumer adds one
object, its commit marker, when it uploads.

### What `pnpm release:root` is now

`pnpm release:root` (`pnpm publish . --access public`) remains the
publish-safety audit's guarded entrypoint for publishing the workspace root,
and its `prepublishOnly` lifecycle still runs every guard. It is not the
release path, because it repacks the directory and cannot publish the tested
bytes. The release entrypoint is `pnpm release:tarball`; the publish-safety
audit checks both scripts. Recursive, filtered, and workspace-scoped publish
commands are rejected and are not release entrypoints either.

The structural audit intentionally fails closed when a workspace glob becomes
too complex to inventory. Extend the audit and its fixture tests before
introducing a new workspace layout.
