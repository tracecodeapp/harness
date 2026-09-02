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
   even when ordinary recursive commands do not.

Run the non-mutating audit directly:

```bash
pnpm release:check
```

For 0.x releases, backwards-incompatible public contract changes require a
minor version increment; patch releases must remain backwards compatible.

When a release version and changelog are already prepared, merge the reviewed
release tree and prove that its generated release artifacts reproduce before
creating the immutable release tag:

```bash
pnpm release:check
pnpm version:check
pnpm test:runtime-assets-lock
pnpm build
git diff --exit-code
```

Then create an annotated `v<version>` tag on that exact commit, push the tag to
`origin`, and publish only from the clean tagged checkout:

```bash
git tag -a v<version> -m "v<version>"
git push origin refs/tags/v<version>
pnpm release:tag-check
```

The tag is part of the release contract because generated open-source metadata
links modified runtime sources to that immutable GitHub ref. The tag check
fails unless the local and remote tag both resolve to the current commit and
the checkout is clean. Never move a pushed release tag; correct a failed
pre-tag build before creating the tag.

Publish only through:

```bash
pnpm release:root
```

That command targets the root directory explicitly and retains pnpm's normal
git and registry checks. Its `prepublishOnly` lifecycle verifies but does not
create or push the release tag. It does not bump versions or mutate Git state.
Recursive, filtered, and workspace-scoped publish commands are rejected; they
are not alternative release entrypoints.

The structural audit intentionally fails closed when a workspace glob becomes
too complex to inventory. Extend the audit and its fixture tests before
introducing a new workspace layout.
