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

Browser mode is much closer to an isolated harness than native mode, but it is
still an application-level sandbox. It should not be documented or sold as a
browser security boundary for malicious code.

## Native Mode

Native project mode runs real host binaries such as `python3`, `node`, `javac`,
`java`, `clang++`, and `dotnet` in temporary project directories. The native
runners validate TraceKernel paths before materializing files and collecting
results, but the child process itself is still a host process.

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

The built-in clients and server shims route through TraceKernel when they use
supported APIs such as `curl`, JavaScript `fetch`, Node `http`, Python
`requests`/`urllib`/`http.client`, Python `http.server`/FastAPI shims, and Java
HTTP shims in browser project mode.

Unsupported APIs, native host networking, browser APIs outside the TraceKernel
bridge, and app-provided worker clients may have different behavior. Consumers
should test the exact execution path they expose.

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
