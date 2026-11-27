import { spawn } from 'node:child_process';

interface FileServerOptions {
  noCache?: boolean;
  serveCppHeadersAsText?: boolean;
}

export function startPythonFileServer(
  directory: string,
  port: number,
  { noCache = false, serveCppHeadersAsText = false }: FileServerOptions = {},
) {
  const server = spawn('python3', ['-c', [
    'from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler',
    'class Handler(SimpleHTTPRequestHandler):',
    ...(serveCppHeadersAsText ? [
      '    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".hpp": "text/plain"}',
    ] : []),
    '    def end_headers(self):',
    '        self.send_header("Cross-Origin-Opener-Policy", "same-origin")',
    '        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")',
    ...(noCache ? ['        self.send_header("Cache-Control", "no-cache")'] : []),
    '        super().end_headers()',
    '    def log_message(self, format, *args):',
    '        pass',
    `ThreadingHTTPServer(("127.0.0.1", ${port}), Handler).serve_forever()`,
  ].join('\n')], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });

  // Any remaining output must be read so the server cannot block mid-response.
  server.stdout.resume();
  server.stderr.resume();
  return server;
}
