# Changelog

All notable changes to this project are documented here.

This repo uses Git tags as release boundaries. Version notes below summarize what shipped in each tagged release.

## [0.5.0] - 2026-03-14

### Fixed

- JavaScript function-style tree inputs now hydrate fallback `root`/`head` array inputs even when no explicit static parameter materializer is available.
- Sparse level-order tree arrays now deserialize correctly in the JavaScript worker instead of being rebuilt as complete binary trees.

### Changed

- GitHub CI now runs the non-browser harness verification set and skips Playwright/Chrome example-app coverage.

### Notes

- `0.5.0` is a JavaScript runtime correctness and CI-trim release ahead of the next app cut.

## [0.4.0] - 2026-03-10

### Added

- Built ESM and CommonJS package outputs plus `.d.ts` publishing.
- `createBrowserHarness(...)` as the stable public browser runtime factory.
- `tracecode-harness sync-assets <target-dir>` for copying the canonical worker asset set into consumer apps.
- Packaging, asset-contract, and example-consumer smoke tests.
- In-repo minimal example app at `examples/web-ide`.

### Changed

- The public browser SDK now uses explicit runtime instances instead of app-coupled ambient bootstrap.
- Browser asset resolution is centralized around `assetBaseUrl` and per-asset overrides.
- `@tracecode/harness/browser` now exports the high-level stable API instead of low-level worker internals.

### Notes

- `0.4.0` is the clean public SDK cut for browser consumers.

## [0.3.4] - 2026-03-07

### Fixed

- TypeScript tracer line alignment for debugger-style playback.
- JS/TS runtime coverage around traced queue and traversal steps.

### Notes

- `0.3.4` is a tracer-alignment patch release focused on TypeScript step accuracy.

## [0.3.3] - 2026-03-07

### Fixed

- JavaScript tracer line mapping for debugger-style playback.
- JS runtime behavior around queue mutations, loop headers, and traversal line alignment.

### Notes

- `0.3.3` improves JS trace semantics without changing the public contract shape.

## [0.3.2] - 2026-03-07

### Fixed

- JavaScript/TypeScript input binding order during harness execution.

### Notes

- `0.3.2` is a JS/TS execution correctness patch release.

## [0.3.1] - 2026-03-07

### Fixed

- Python class-scope access instrumentation mangling in the tracing runtime.

### Notes

- `0.3.1` fixes Python access metadata emission for class-based solutions.

## [0.3.0] - 2026-03-07

### Added

- Runtime access metadata in the shared trace contract via an optional `accesses` field on trace steps.
- Public access event types for:
  - `indexed-read`
  - `indexed-write`
  - `cell-read`
  - `cell-write`
  - `mutating-call`
- JavaScript/TypeScript runtime instrumentation for array and grid access events, including indexed reads/writes and mutating queue/array calls.
- Python runtime instrumentation for aligned access metadata during tracing.

### Changed

- Trace adapters now preserve runtime access metadata end to end.
- Runtime contract coverage now validates the new access metadata surface.

### Notes

- `0.3.0` is an additive, backward-compatible contract release.
- Access metadata is state-aligned with debugger-style trace playback, so events appear on the next emitted step alongside the post-line state.

## [0.2.0] - 2026-03-06

### Added

- Structured runtime capability profiles for supported languages.
- Browser runtime capability guards and shared runtime-type metadata.
- Contract tests validating language profiles and declared support levels.

### Notes

- `0.2.0` formalizes the public runtime capability surface.

## [0.1.0] - 2026-03-06

### Added

- Initial public harness baseline with repository documentation and published package metadata.

### Notes

- `0.1.0` is the pre-profile baseline release.
