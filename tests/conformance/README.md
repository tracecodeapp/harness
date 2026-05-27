# Runtime Conformance Fixtures

`cpp-fixtures.ts` is the reviewed C++ seed corpus. These fixtures use simple semantics and unusual user-code shapes to test runtime behavior rather than algorithm difficulty.

To validate a new ChatGPT-generated batch without trusting it as the oracle:

```sh
./node_modules/.bin/tsx scripts/import-cpp-conformance-fixtures.ts --input path/to/candidates.json
```

Passing candidates are written to ignored `tests/conformance/generated/cpp-fixtures.json`. Rejected candidates are written under ignored `reports/conformance-failures/cpp/` with validation/runtime details. Promote useful failures or durable coverage into `cpp-fixtures.ts` after review.
