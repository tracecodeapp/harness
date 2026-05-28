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
```

The background server is owned by a kernel process. Killing that process closes
its listener, and `/proc/tracekernel/net/listeners` exposes the active simulated
listeners for diagnostics.

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
