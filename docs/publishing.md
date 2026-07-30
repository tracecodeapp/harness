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
3. The root `prepublishOnly` lifecycle runs `pnpm release:check` before and
   after the build. The check inventories `pnpm-workspace.yaml`, verifies that
   every non-root manifest is private, verifies the root release wiring, and
   rejects recursive, filtered, or workspace-scoped publish environments.
   This final check matters because pnpm's recursive publish mode may select
   the workspace root specially even when ordinary recursive commands do not.

Run the non-mutating audit directly:

```bash
pnpm release:check
```

When a release version and changelog are already prepared, publish only through:

```bash
pnpm release:root
```

That command targets the root directory explicitly and retains pnpm's normal
git and registry checks. It does not bump versions, create tags, or push Git
state. Recursive, filtered, and workspace-scoped publish commands are rejected;
they are not alternative release entrypoints.

The structural audit intentionally fails closed when a workspace glob becomes
too complex to inventory. Extend the audit and its fixture tests before
introducing a new workspace layout.
