# Persisted terminal executable restoration

Base: origin/main ce330e977395525a0f7ff155fac71b3c52fded19 (0.17.1).
Branch: codex/terminal-restoration-20261007.

## Root causes and correction

Supplied snapshot files were hydrated through `writeFile`, discarding mode and
mtime although the snapshot/storage contract already preserves them. Hydration
now applies the complete existing RuntimeFile change for supplied and session
files. Directory metadata remains restored last to preserve directory mtimes.

C/C++ dispatch depended on an in-memory registry, and that registry let compiled
files execute with mode0666. Linked compiler outputs now receive mode0755 and
register only when an actual output file exists. Compile-only, assembly and
preprocessor invocations do not register commands. Existing explicit-path
registered dispatch checks file existence and execute bits. The default a.out
runner also respects execute bits on an existing artifact.

When there is no local registration, a validated WASI preview1 command module
selects the existing sandboxed C/C++ runner: versioned WebAssembly format,
function imports only from wasi_snapshot_preview1, exported memory and _start.
Recognition validates without instantiation; it serializes no executable
functions or host closures. Malformed modules and arbitrary host-import modules
do not select the loader. The runner retains responsibility for supported WASI
syscalls and runtime execution isolation. Native artifacts still use their
current-session compiler registration; persistence recognition is intentionally
limited to browser WASI commands.

## Producers and consumers

No exported API, message tag, encrypted envelope or snapshot wire format changed.
Existing RuntimeFile producers: TKFS snapshot-image walker, runtime live/final
file changes, project/session seeds and patches. Consumers: createRuntimeWorkspace
supplied/session hydration, browser project factory hydrated files, encrypted
kernel-storage normalizer, runtime project snapshot adapters and patch importer.
The existing mode/mtime fields survive storage JSON/encryption unchanged.

Compiler producer: createCppProjectCommands applies runner diffs then marks
linked output executable and registers it. Registry consumer: AST invocation
rewriter plus executeVirtualExecutable. Restored consumer: executeVirtualExecutable
calls internal isWasiCommandExecutable; it uses no persistent registry schema.
The new helper is internal, and the focused test is registered as a fast suite
contract task. Browser regression augments existing kernel-storage gate.

## Compatibility

No migration or encrypted version bump is required. Metadata-less legacy files
retain existing creation defaults. Old compiled artifacts stored as0666 remain
non-executable; explicit chmod+x allows supported WASI dispatch, and recompiling
produces durable0755. Automatically granting permission to old bytes would
undo an intentional chmod-x. Fixed0755 for new linked artifacts is documented;
compiler umask parity is not added here.

Mock runners that report compilation success must create their actual output.
Two existing project-workspace fixtures were corrected: the command adapter now
writes each requested -o path, and the browser workspace mock creates a.out.
Their snapshot expectations now include those real artifacts.

Atime remains an existing unsupported boundary: the TKFS backing adapter ignores
utimes atime and the regular-file snapshot walker omits it. This change restores
mode and mtime correctly; it does not claim atime restoration.

## Validation

Pinned Node22.18.0 / pnpm10.4.1 verified. Offline frozen-lockfile install passed;
unbuilt dist CLI symlink and ignored optional build-script warnings were expected.

- Focused restoration test: five cases covering ABI rejection, script metadata
  JSON recreation, fresh compile/executable recreation, chmod-x both sides,
  legacy chmod recovery, unchanged binary bytes and compile-only behavior.
- Tracekernel package typecheck and full tests typecheck passed.
- Asset-lock and publish-safety gates passed.
- Chromium encrypted IndexedDB save/flush, actual page.reload, hydration and
  script/WASI command execution passed. Compiler is mocked; actual C/C++ compiler
  and provider execution acceptance belongs to parent combined browser validation.
- git diff --check passed.

No broad compiler/corpus suite, publication, deployment, push or PR creation.

Follow-up: ten selected existing project-workspace fixture functions passed in a
disposable copy of the original monolithic test. Selection covered C++ adapters,
first compound execution, browser factory/config/translation, language takehome,
metadata consistency and readonly persistence hydration. This was a focused run,
not the full native compiler project suite.
