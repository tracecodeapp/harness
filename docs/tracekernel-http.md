# TraceKernel HTTP Simulation

TraceKernel project workspaces include a small in-kernel HTTP simulation for
browser-hosted project mode. It is not a browser network stack and it does not
open real sockets. Instead, server runtimes register listeners with the
workspace kernel, and clients such as the built-in `curl` command dispatch
requests through that same kernel.

This lets a consuming app test endpoint-defined problems in one workspace while
keeping user terminals, agent commands, file mutations, process lifetime, and
network-facing behavior inside the simulated system.

## Shared Workspace Model

Use one project workspace for both the visible user shell and agent work. A
foreground terminal session remains single-process from the user's perspective,
while separate `workspace.runCommand(...)` calls can run through the scheduler
and interact with the same files and HTTP listeners.

```ts
import { createBrowserProjectWorkspace } from '@tracecode/harness/browser/project';

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

const jsonResult = await workspace.http.json<{ id: number } | null>({
  method: 'GET',
  url: 'http://localhost:3000/dequeue',
});
```

The background server is owned by a kernel process. Killing that process closes
its listener, and `/proc/tracekernel/net/listeners` exposes the active simulated
listeners for diagnostics.

`workspace.http.request(...)` is the consumer-facing endpoint test API. It uses
the same kernel dispatch path as `curl`, Node `http`, and Python outbound HTTP,
and records requests in `/proc/tracekernel/net/requests`. Use it when app code
wants to grade or probe endpoints without constructing shell command strings.

HTTP bodies are transported as UTF-8 text when possible. If a request or
response contains non-UTF-8 bytes, the bridge uses `bodyEncoding: 'base64'` and
stores the bytes in `body`. Responses also include `rawHeaders` when available,
so consumers can inspect repeated headers without parsing display output.

`workspace.http.json(...)` is a convenience wrapper for endpoint tests. It sets
JSON `accept` and `content-type` defaults, stringifies the request body, and
returns the original response plus `text` and parsed `json` fields.

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
request cancellation.

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
They are intended for endpoint tests, not general internet access.

## Bind Semantics

TraceKernel tracks listener ownership and port binding in the kernel:

- `listen(0)` allocates an ephemeral in-workspace port.
- `listen(port)` without a host binds `0.0.0.0`.
- Requests to `localhost` resolve to `127.0.0.1` and also match wildcard binds.
- A wildcard listener conflicts with exact-host listeners on the same port.
- Duplicate binds return `EADDRINUSE`.

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
