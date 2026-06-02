# TraceKernel HTTP Simulation

TraceKernel project workspaces include a small in-kernel HTTP simulation for
browser-hosted project mode. It is not a browser network stack and it does not
open real sockets. Instead, server runtimes register listeners with the
workspace kernel, and clients such as the built-in `curl` command dispatch
requests through that same kernel.

This lets a consuming app test endpoint-defined problems in one workspace while
keeping user terminals, agent commands, file mutations, process lifetime, and
network-facing behavior inside the simulated system.

## Browser-Side Security Model

TraceKernel HTTP is a browser-side simulation. It should be treated as a
deterministic workspace boundary, not as a host-network firewall. Browser
project code can call only listeners registered inside the same workspace unless
the consuming app explicitly grants an actor an external-fetch capability.

HTTP operations are checked against workspace actor capabilities:

- `principal` is the visible user/app actor.
- `test` and `hidden-test` are intended for grading/probe code.
- `runtime` is a user command process actor.
- `system` is reserved for kernel-owned work and may use external fetch.

The exported `RUNTIME_WORKSPACE_ACTOR_PRESETS`,
`runtimeWorkspaceActorPreset(...)`, and
`runtimeWorkspaceHttpCapabilitiesPreset(...)` helpers provide the default
browser policies. The default non-system HTTP policy allows simulated
`listen`, simulated `dispatch`, and diagnostics reads, while leaving
`externalFetch` disabled.

For JavaScript, prefer the worker-backed browser runner for any hardening-sensitive
surface. `createBrowserJavaScriptProjectRunner({ hardened: true, workerUrl })`
requires that worker-backed path and fails closed if a Worker is unavailable.
The same-realm fallback still patches `fetch`, `Headers`, `Request`, and
`Response` during execution and blocks common browser egress APIs such as
`XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon`, but it
shares a realm with the page and should be considered compatibility mode.

## Shared Workspace Model

Use one project workspace for both the visible user shell and agent work. A
foreground terminal session remains single-process from the user's perspective,
while separate `workspace.runCommand(...)` calls can run through the scheduler
and interact with the same files and HTTP listeners.

```ts
import {
  createBrowserProjectWorkspace,
  runtimeHttpResponseText,
} from '@tracecode/harness/browser/project';

const workspace = await createBrowserProjectWorkspace({
  assetBaseUrl: '/workers',
  kernel: {
    scheduler: { maxConcurrentCommands: 4 },
    user: { username: 'user' },
    host: { hostname: 'tracevm' },
    workspace: { name: 'queue-api' },
  },
  files: [
    {
      path: 'server.js',
      contents: `
const http = require("node:http");
const items = [];

http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/enqueue") {
      items.push(JSON.parse(body));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ size: items.length }) + "\\n");
      return;
    }
    if (req.method === "GET" && req.url === "/dequeue") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(items.shift() ?? null) + "\\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing\\n");
  });
}).listen(3000, "127.0.0.1");
`,
    },
  ],
});

const terminal = workspace.createTerminalSession();
await terminal.run('node server.js &');

const agentResult = await workspace.runCommand(
  'curl -s --json \'{"id":1}\' http://localhost:3000/enqueue'
);

const apiResult = await workspace.http.request({
  method: 'GET',
  url: 'http://localhost:3000/dequeue',
  headers: { accept: 'application/json' },
});
const apiText = runtimeHttpResponseText(apiResult);

const jsonResult = await workspace.http.json<{ id: number } | null>({
  method: 'GET',
  url: 'http://localhost:3000/dequeue',
});
```

The background server is owned by a kernel process. Killing that process closes
its listener, and `/proc/tracekernel/net/listeners` exposes the active simulated
listeners for diagnostics.

In a consumer app, keep the visible shell, agent commands, endpoint probes, and
mock services on the same workspace instance. That makes the harness behave like
one small machine: a user terminal can start the server, an agent can mutate
files or call `curl`, and the grader can use `workspace.http.request(...)`
without bypassing the simulated filesystem, process table, or network table.

```ts
const workspace = await createBrowserProjectWorkspace({
  assetBaseUrl: '/workers',
  kernel: { scheduler: { maxConcurrentCommands: 4 } },
  files: [{ path: 'server.js', contents: submittedServerSource }],
});

const terminal = workspace.createTerminalSession();
await terminal.run('node server.js &');

const upstream = workspace.http.listen({ host: '127.0.0.1', port: 9000 }, (request) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: request.path }) + '\n',
}));

try {
  await workspace.runCommand('curl -s http://localhost:3000/health');
  const response = await workspace.http.json<{ ok: boolean }>({
    url: 'http://localhost:3000/health',
    timeoutMs: 1000,
  });
  if (response.status !== 200 || response.json.ok !== true) {
    throw new Error('health endpoint failed');
  }
} finally {
  upstream.close();
}
```

`workspace.http.request(...)` is the consumer-facing endpoint test API. It uses
the same kernel dispatch path as `curl`, Node `http`, and Python outbound HTTP,
and records requests in `/proc/tracekernel/net/requests`. Use it when app code
wants to grade or probe endpoints without constructing shell command strings.

HTTP bodies are transported as UTF-8 text when possible. If a request or
response contains non-UTF-8 bytes, the bridge uses `bodyEncoding: 'base64'` and
stores the bytes in `body`. Responses also include `rawHeaders` when available,
so consumers can inspect repeated headers without parsing display output.
Use the exported helpers when callers should not care whether a response was
transported as UTF-8 or base64:

```ts
import {
  runtimeHttpBodyFromBytes,
  runtimeHttpResponseBytes,
  runtimeHttpResponseText,
} from '@tracecode/harness-project';

const binaryResponse = await workspace.http.request({
  method: 'POST',
  url: 'http://localhost:3000/blob',
  timeoutMs: 1000,
  ...runtimeHttpBodyFromBytes(new Uint8Array([0, 255, 1])),
});

console.log(runtimeHttpResponseText(binaryResponse));
console.log(Array.from(runtimeHttpResponseBytes(binaryResponse)));
```

`workspace.http.request(...)` also accepts `timeoutMs` and `signal`. A timeout
or abort returns a transport-style response with `status: 0` instead of leaving
the caller parked on a stalled endpoint. This is the programmatic equivalent of
using `curl --max-time` from inside the workspace, and it keeps scheduler slots
available for later commands.

Endpoint graders should set `timeoutMs` on every direct `workspace.http` probe
and should close mock listeners in `finally` blocks. Long-lived servers started
from terminal sessions or agent commands should be killed through the workspace
process API before the workspace is disposed; once killed, TraceKernel closes
their HTTP listeners and unblocks queued requests with transport-style failures.

`workspace.http.json(...)` is a convenience wrapper for endpoint tests. It sets
JSON `accept` and `content-type` defaults, stringifies the request body, and
returns the original response plus `text` and parsed `json` fields.

Consumers can also create mock or grading endpoints with
`workspace.http.listen(...)`. These listeners are owned by the simulated kernel
with pid `0`, show up in `/proc/tracekernel/net/listeners`, and can be reached
by project code through the same `curl`, `fetch`, Node `http`, and Python HTTP
paths as process-owned listeners.

```ts
const mockApi = workspace.http.listen({
  host: '127.0.0.1',
  port: 8080,
}, async (request) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: request.method, path: request.path }) + '\n',
}));

await workspace.runCommand('node client.js');
mockApi.close();
```

For API-style exercises, this gives consumers both directions without exposing
the host network. A test can create a mock upstream and let user code call it,
or user code can start an HTTP server and the test can call the submitted API:

```ts
const upstream = workspace.http.listen({ host: '127.0.0.1', port: 9000 }, (request) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: request.path }) + '\n',
}));

await workspace.runCommand('node sync-from-upstream.js');
upstream.close();

await terminal.run('node server.js &');
const result = await workspace.http.json<{ size: number }>({
  method: 'POST',
  url: 'http://localhost:3000/enqueue',
  body: { id: 1 },
});
```

Node project code can also act as an in-workspace client through `node:http`:

```js
const http = require("node:http");

const req = http.request({
  hostname: "localhost",
  port: 3000,
  path: "/enqueue",
  method: "POST",
  headers: { "content-type": "application/json" },
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", chunk => { body += chunk; });
  res.on("end", () => console.log(res.statusCode, body));
});

req.write(JSON.stringify({ id: 1 }));
req.end();
```

`http.request(...)` and `http.get(...)` dispatch through TraceKernel, so they can
call listeners owned by other running processes in the same workspace. They do
not reach the browser or host network. Request `timeout` and `AbortSignal`
options are honored by the shim so a hung endpoint cannot keep the command alive
forever.

JS project code can also use `fetch`:

```js
const response = await fetch("http://localhost:3000/enqueue", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: 1 }),
});

console.log(response.status, response.ok);
console.log(await response.json());
```

The TraceKernel fetch shim provides `Headers`, `Request`, and `Response` plus
the common response helpers: `text()`, `json()`, `arrayBuffer()`, `clone()`,
`status`, `ok`, `headers`, `bodyUsed`, and `url`. `AbortSignal` is supported for
request cancellation. During same-realm browser execution, global `fetch` is
routed back through TraceKernel even if page code assigned a different value
before the run started.

## Python ASGI

The Python browser runner installs lightweight `fastapi` and `uvicorn` shims
when those packages are not available. They are intentionally small, but support
the endpoint shapes needed for common harness tests: route decorators, path
parameters, query parameters, JSON request bodies, and decorator status codes.

```py
from fastapi import FastAPI
import uvicorn

app = FastAPI()
items = []

@app.post("/items/{item_id}", status_code=201)
def set_item(item_id, payload, verbose="false"):
    items.append({"id": item_id, "payload": payload})
    return {"id": item_id, "verbose": verbose}

uvicorn.run(app, host="127.0.0.1", port=8765)
```

From the same workspace, a user terminal or agent command can call:

```bash
curl -s --json '{"count":2}' 'http://localhost:8765/items/abc?verbose=true'
```

Python project code can also make outbound in-workspace requests through small
`urllib.request`, `http.client`, and `requests` shims:

```py
import requests

response = requests.post(
    "http://localhost:8765/items/abc",
    json={"count": 2},
)
print(response.status_code)
print(response.json())
```

These shims are scoped to project execution and dispatch through TraceKernel.
They are intended for endpoint tests, not general internet access. `timeout=`
values on `urllib.request.urlopen(...)`, `http.client.HTTPConnection(...)`, and
`requests.*(...)` are forwarded as TraceKernel dispatch timeouts.

Python browser project runs also patch the stdlib server path enough for small
endpoint projects built with `http.server`:

```py
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

items = []

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or "0")
        items.append(json.loads(self.rfile.read(length).decode("utf-8")))
        body = json.dumps({"size": len(items)}) + "\n"
        self.send_response(201)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
```

`HTTPServer`, `ThreadingHTTPServer`, and the `socketserver.TCPServer` base path
register TraceKernel HTTP listeners instead of opening browser sockets. Requests
arrive through `BaseHTTPRequestHandler` with `self.command`, `self.path`,
`self.headers`, `self.rfile`, and `self.wfile` populated from the simulated
kernel request.

## Java HTTP

Browser Java project runs install TraceKernel HTTP shims before invoking user
code. Common client APIs are supported:

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:8765/items"))
  .header("content-type", "application/json")
  .POST(HttpRequest.BodyPublishers.ofString("{\"id\":1}"))
  .build();

HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.statusCode());
System.out.println(response.body());
```

`HttpClient.newHttpClient()`, `HttpClient.newBuilder()`, `URL.openConnection()`,
and `HttpURLConnection` are routed through TraceKernel for browser Java project
commands. They can call listeners started by JavaScript, Python, `curl`, or
consumer-owned `workspace.http.listen(...)` handlers in the same workspace.
`HttpRequest.timeout(...)`, `HttpClient.Builder.connectTimeout(...)`,
`HttpURLConnection.setReadTimeout(...)`, and
`HttpURLConnection.setConnectTimeout(...)` are forwarded as TraceKernel dispatch
timeouts.

Java also includes a `com.sun.net.httpserver.HttpServer` shim for project code
that creates endpoints:

```java
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;

HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
server.createContext("/queue", exchange -> {
  byte[] body = "ok\n".getBytes(StandardCharsets.UTF_8);
  exchange.sendResponseHeaders(200, body.length);
  exchange.getResponseBody().write(body);
  exchange.close();
});
server.start();

int port = server.getAddress().getPort();
HttpResponse<String> response = HttpClient.newHttpClient().send(
  HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/queue")).GET().build(),
  HttpResponse.BodyHandlers.ofString()
);
```

`HttpServer.start()` registers a TraceKernel listener for browser Java project
commands. Java clients can call the server in-process, and external workspace
tests can call the same listener through `workspace.http.request(...)` or
`curl`. The Java bridge delivers one request at a time through the shared
browser-worker buffer and queues a small bounded backlog for concurrent callers;
use this for endpoint tests and small teaching workloads, not load testing.

## Bind Semantics

TraceKernel tracks listener ownership and port binding in the kernel:

- `listen(0)` allocates an ephemeral in-workspace port.
- `listen(port)` without a host binds `0.0.0.0`.
- Requests to `localhost` resolve to `127.0.0.1` and also match wildcard binds.
- A wildcard listener conflicts with exact-host listeners on the same port.
- Duplicate binds return `EADDRINUSE`.

## Validation And Limits

TraceKernel validates simulated HTTP traffic before it reaches listeners:

- Methods must be HTTP tokens.
- Hosts must be non-empty and cannot contain control characters, spaces, or
  path delimiters.
- Listener response statuses must be integers from `100` through `599`;
  invalid handler responses are converted to handler-failure responses.
- Request and response bodies are capped at 4 MiB.
- Header maps and raw header lists are capped at 128 entries and 64 KiB of
  encoded header bytes.
- A workspace can hold up to 128 listeners and 256 in-flight HTTP requests.
- `/proc/tracekernel/net/requests` keeps the latest 256 request diagnostics.
- Diagnostic fields are control-character escaped and truncated to 4096
  characters.

Invalid client input is reported as a transport-style failure where possible.
For example, a malformed connect target returns a `400` simulated response
instead of throwing out of the kernel dispatcher.

## Built-In Curl

`curl` is a TraceKernel command, not the host system binary. Supported options
cover the endpoint-test path:

- `-s`, `--silent`
- `-i`, `--include`
- `-I`, `--head`
- `-f`, `--fail`
- `-X`, `--request`
- `-H`, `--header`
- `-d`, `--data`, `--data-raw`, `--data-binary`
- `-G`, `--get`
- `--json`
- `-o`, `--output`
- `--max-time`

`-o` writes through the workspace filesystem, so output files participate in the
same kernel file locks and mutation events as other command writes.

## Boundaries

This simulation is designed for in-workspace HTTP tests, not external network
access. A request succeeds only when a process in the same workspace has
registered a matching `http://host:port` listener. That keeps browser execution
deterministic and lets consumers build agent workflows where server code,
tests, shell commands, and file changes all stay under TraceKernel control.

TraceKernel HTTP is part of the simulated workspace contract, not a standalone
security boundary. See [Isolation Boundaries](./isolation-boundaries.md) for
the broader sandbox model, browser-mode requirements, and native-runner caveats.
