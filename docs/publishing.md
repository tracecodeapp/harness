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
(`runtime-assets.lock.json` → `harness.releaseId`). Run the full suite and the
consumer validation (TraceCode's `validate-harness-release`) against that
tarball. Any change to the tree makes a new candidate.

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
published in step 6 is the **candidate tarball**, not a fresh pack.

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
  byte-identical to the checkout's;
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
node -p "require('./node_modules/@tracecode/harness/runtime-assets.lock.json').harness.releaseId"
```

Read the lock by path. The package `exports` does not expose
`runtime-assets.lock.json`, so `require('@tracecode/harness/runtime-assets.lock.json')`
fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The upload is the whole staged runtime tree (`tracecode-harness sync-assets`),
not only the Harness components:

- the Harness components (`totalPackagedRuntimeBytes` in the lock);
- each engine dependency's installed tree, `tracecc` and `tracejvm`. An
  installed tree includes descriptor and release metadata beyond the lock's
  `engineDependencies.*.totalBytes`;
- the consumer's own commit-marker manifest.

Summing the lock's totals therefore undercounts. For 0.20.1 the components
are 283 files and 152,504,822 bytes, but the staged upload is
**607 files, 428,324,717 bytes**. Record the full staged inventory with each
release, and compare it with the consumer's publication `--check` output
before uploading.

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
