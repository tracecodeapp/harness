# Isolation Boundaries

TraceCode Harness provides a simulated project system for browser-first code
execution. TraceKernel enforces workspace rules inside that simulated system,
but it is not a replacement for an operating-system sandbox when running
hostile code.

## What TraceKernel Enforces

Project workspaces try to keep runtime behavior inside one simulated machine:

- Project paths and command cwd values are normalized and rejected when they
  escape the workspace.
- `/workspace` aliases, `/home/<user>/<workspace>`, `/proc`, and `/dev` are
  routed through TraceKernel instead of direct host paths.
- Kernel-owned namespaces such as `/proc` are read-only from project code.
- Readonly and hidden project-session files are protected from principal API
  writes, shell writes, final-diff runner output, and live runner output where
  that language path supports live I/O.
- File mutations pass through TraceKernel generation checks and lock-aware write
  paths so concurrent simulated commands do not silently overwrite each other.
- Terminal sessions model a single foreground process, while background jobs and
  separate `workspace.runCommand(...)` calls are scheduled as separate kernel
  processes.
- TraceKernel HTTP dispatch only reaches listeners registered in the same
  workspace. The built-in HTTP path is intended for in-workspace tests and mock
  services, not host or internet access.
- Commands and HTTP probes can be timed out, aborted, killed, or waited on
  through TraceKernel process APIs.

These rules are product-facing isolation semantics. They make the workspace feel
like a small deterministic system and keep normal project/test behavior from
bypassing TraceKernel state.

## Browser Mode

Browser project mode is the preferred mode for untrusted student or interview
workloads. It runs language runtimes in browser workers and WebAssembly where
possible, and it avoids direct host filesystem access.

Browser mode still depends on the embedding app's web security posture:

- Serve workers from origins you control.
- Keep the default per-command worker lifecycle for untrusted commands. Shared
  worker reuse is a trusted throughput capability and requires an explicit
  opt-in.
- Serve browser project consumers with cross-origin isolation headers when using
  `SharedArrayBuffer`:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Use a restrictive Content Security Policy for the page that embeds the
  harness.
- Treat `nodeProject.allowDynamicEval` as a capability decision. Keep it
  disabled unless a project genuinely needs dynamic eval semantics.
- Do not expose low-level worker objects or host application secrets to code
  running inside the workspace.
- Treat browser DevTools access as full control over the local client state. A
  user who can run arbitrary code in the embedding page can inspect or mutate
  the local workspace object model. Use a remote or OS-backed runner for
  authoritative grading.

Browser mode is much closer to an isolated harness than native mode, but it is
still an application-level sandbox. It should not be documented or sold as a
browser security boundary for malicious code.

A dedicated worker separates JavaScript realms; it does **not** create a new
origin. A same-origin worker can otherwise inherit origin-scoped capabilities
such as IndexedDB, Cache Storage, nested workers, and cross-context channels.
The built-in JavaScript project path routes supported network APIs through
TraceKernel and denies those ambient capabilities while user code is active,
and the other language workers should receive the same treatment at their
JavaScript interop boundary. This is defense in depth, not a substitute for an
origin boundary: hostile workloads that coexist with browser-held secrets must
run in an opaque/cross-origin sandboxed frame with a narrow message broker, or
on a remote/OS-backed runner.

Temporal API guards also cannot prove that every runtime has cancelled all
deferred user work before host globals are restored. The default project path
therefore retires each user-command worker; persistent Classic workers remain a
trusted-throughput mode, not a hostile-code security boundary.

The JavaScript project runner should use its worker-backed path in browser
project mode. The same-realm JavaScript fallback exists for constrained
environments and compatibility tests; it rejects common dynamic-eval and
constructor-chain escape patterns, but it is not equivalent to a worker,
iframe-origin, process, container, or VM boundary.

Hidden project-session files are a UI and file-tree affordance, not a client-side
secret store. They are available to the runtime snapshot so tests and hidden
commands can run locally. Keep real grading secrets and privileged tooling out
of the browser workspace, or copy the submitted workspace into a remote runner
that mounts only the server-side test harness.

## Native Mode

Native project mode runs real host binaries such as `python3`, `node`, `javac`,
`java`, `clang++`, and `dotnet` in temporary project directories. The native
runners validate TraceKernel paths before materializing files and collecting
results, but the child process itself is still a host process.

The native harness code API is the same security class. It is an opt-in
throughput interface for trusted batch execution and tracing using host-native
runners and Node VM-backed adapters. It is not designed to securely execute
arbitrary code; it exists to reuse TraceCode runtime contracts faster outside
the browser.

Use native mode for trusted local development, CI smoke tests, and packaging
verification. Do not use native mode as the only isolation layer for arbitrary
untrusted code.

If a product needs to run hostile code outside the browser, put native execution
behind an OS sandbox such as a container, VM, jail, seccomp profile, or a
dedicated remote execution service. TraceKernel can still provide the simulated
workspace contract inside that boundary, but the boundary must come from the OS
or infrastructure layer.

## Network Model

TraceKernel HTTP is an in-workspace transport. It is designed for endpoint
tests, mock upstream APIs, and project servers that should be visible to the
workspace but not to the host network.

Allowlisted external egress is a deliberate exfiltration channel and should stay
off for graded/interview surfaces. When a product enables `externalHttp`, the
app-owned delegate and allowlist become part of the security boundary, and
server-side proxy delegates must perform their own post-resolution IP checks.

The built-in clients and server shims route through TraceKernel when they use
supported APIs such as `curl`, JavaScript `fetch`, Node `http`, Python
`requests`/`urllib`/`http.client`, Python `http.server`/FastAPI shims, and Java
HTTP shims in browser project mode.

Unsupported APIs, native host networking, browser APIs outside the TraceKernel
bridge, and app-provided worker clients may have different behavior. Consumers
should test the exact execution path they expose.

The default browser external-HTTP delegate rejects literal non-public address
space and revalidates every exposed redirect, but browser `fetch` does not expose
the resolved peer address. It therefore cannot independently defeat DNS
rebinding. Use exact host allowlists for ordinary deployments; workloads that
need a strong egress boundary should use a consumer-controlled proxy that
resolves and pins public addresses on every hop.

## Runtime Assets And CDNs

Runtime delivery is consumer-owned configuration. The harness accepts
provider-neutral, versioned runtime manifests for every browser language; it
does not require a TraceCode-operated CDN. A first-party TraceCode application
may publish its own manifest, but that is application configuration rather than
an open-source harness dependency.

Dependent runtime artifacts may be hosted on a consumer CDN when their origin,
media type, decoded size, and integrity metadata satisfy the manifest policy.
The Worker wrapper URL itself remains subject to browser Worker-origin and CSP
rules and may need to be served or reverse-proxied from the application origin.
Manifest `integrity` verifies the harness's credential-free preflight response;
it is not execution-bound SRI for loaders that subsequently request the URL
again. Declare an immutable `delivery` policy with a `content` or `versioned`
address only when the publisher guarantees that contract. Successful
preflights are cached only for such assets. Use immutable, preferably
content-addressed URLs: preflight verification cannot universally force every
browser runtime loader to execute the exact response body that was previously
inspected, and a malicious CDN or Service Worker is outside this assurance.

Python manifests are authoritative for their loader and runtime index: once a
Python manifest is active, the harness never falls back to its legacy public
CDNs. Self-hosting publishers can additionally declare `assets.distribution`,
keyed by normalized paths beneath `runtimeIndex`, to preflight the lockfile,
stdlib, WASM/module files, package metadata, and other transitive distribution
artifacts. This is a complete preflight inventory, not execution-bound SRI.

Browser Project Java has no implicit runtime or manifest fallback. A workspace
that selects Java must provide an implementation-neutral Java 23 provider
through `java.createClient`, or deliberately supply a low-level
`javaWorkerClient`. The high-level adapter admits each `javac` or `java`
invocation to a fresh disposable client, and the provider owns the Worker
origin plus any implementation-specific asset validation. Project
`executionHost.providers` excludes Java so the harness cannot accidentally
claim authority over that provider-owned boundary.

The bundled low-level Java client currently integrates with CheerpJ, which is
not vendored. Consumers choosing that client must provide and preflight its
`worker`, `loader`, `helperJar`, `compilerJar`, `rewriterJar`, and `parserJar`
assets. JAR descriptors may use `runtimePath` for CheerpJ's virtual filesystem
while `url` remains the delivery and integrity boundary. Its `/files` mount is
IndexedDB-backed, so it must not receive application-origin storage authority;
use a credential-free execution origin and retire the client at the untrusted
command boundary. These constraints describe that concrete low-level client,
not the generic Java 23 provider contract.

C++ manifests retain an additional exact-binding boundary. The compiler frame
and compiler worker must share an origin. Compiler resources hosted on another
origin must declare an unambiguous `sha256-...` SRI token; the harness converts
that token and optional decoded `size` into the compiler worker's exact pin
manifest. List lazy compiler resources such as YoWASP `llvm.core*.wasm` and
`llvm-resources.tar` under `assets.toolchain`. Missing or incompatible pins fail
closed before compilation, and any lazy compiler fetch omitted from that map is
still rejected by the compiler worker.

## Consumer Checklist

- Prefer browser project mode for untrusted browser-side work.
- Keep user terminals, agent commands, tests, and mock HTTP services on one
  workspace instance so they all share the same TraceKernel state.
- Set `timeoutMs` on direct `workspace.http` probes and command-runner timeouts
  for grading flows.
- Kill or wait for long-lived background processes before disposing a workspace.
- Keep native execution inside an OS sandbox if code is not trusted.
- Document any language-specific limitations exposed by the app.

## Security Claim

TraceKernel is a deterministic simulation and coordination layer. It provides a
kernel-like workspace contract for product code, tests, and agents. It is not a
standalone security boundary for adversarial code.
