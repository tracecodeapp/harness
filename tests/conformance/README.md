# Runtime Conformance Fixtures

The reviewed conformance fixtures use simple semantics and unusual user-code
shapes to test runtime behavior rather than algorithm difficulty.

To validate a new ChatGPT-generated batch without trusting it as the oracle:

```sh
./node_modules/.bin/tsx scripts/import-cpp-conformance-fixtures.ts --input path/to/candidates.json
pnpm import:java-conformance -- --input path/to/java-candidates.json
pnpm import:python-conformance -- --input path/to/python-candidates.json
pnpm import:csharp-conformance -- --input path/to/csharp-candidates.json
pnpm import:javascript-conformance -- --input path/to/javascript-candidates.json
pnpm import:typescript-conformance -- --input path/to/typescript-candidates.json
```

Passing candidates are written to ignored `tests/conformance/generated/<language>-fixtures.json`. Rejected candidates are written under ignored `reports/conformance-failures/<language>/` with validation/runtime details. Promote useful failures or durable coverage into the reviewed fixture corpus after review.
