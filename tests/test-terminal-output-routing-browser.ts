#!/usr/bin/env npx tsx

// Real runtimes in Chromium: a program's stdout and stderr reach the terminal
// only where the shell routes them. Each language runs the kernel-realism
// `*-streams` program (out1, err1, out2, err2, then stdin upper-cased, each
// write flushed). The expected values are what GNU Bash shows for the same
// line with a native program; see tests/test-workspace-output-routing.ts.

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

const RUNTIMES = (process.env.TRACECODE_OUTPUT_ROUTING_RUNTIMES ?? 'javascript,python,cpp').split(',');

async function syncAssets(targetDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('src/cli.ts'),
      'sync-assets',
      targetDirectory,
      '--languages',
      RUNTIMES.join(','),
    ], { cwd: process.cwd(), stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Asset sync failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function startStaticServer(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(root, decodeURIComponent(requestUrl.pathname)));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const stat = statSync(filePath);
    response.writeHead(200, {
      'Content-Length': String(stat.size),
      'Content-Type': contentType(filePath),
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve the test server address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }),
  };
}

interface Expected {
  screen: string;
  stdout: string;
  stderr: string;
  files?: Record<string, string>;
}

const interleaved = (input: string) => `out1\nerr1\nout2\nerr2\n${input}\n`;
const outOnly = (input: string) => `out1\nout2\n${input}\n`;
const errOnly = 'err1\nerr2\n';

/** [line, Bash's screen and files]; `P` is the language's run command. */
function cases(run: string): Array<[string, Expected]> {
  return [
    // Main also showed out1 out2 before ALPHA.
    [`echo alpha | ${run} | grep ALPHA`, { screen: `${errOnly}ALPHA\n`, stdout: 'ALPHA\n', stderr: errOnly }],
    // Main showed everything.
    [`echo beta | ${run} > std.out 2> std.err`, { screen: '', stdout: '', stderr: '', files: { 'std.out': outOnly('BETA'), 'std.err': errOnly } }],
    [`echo gamma | ${run} 2>&1 | grep err`, { screen: errOnly, stdout: errOnly, stderr: '' }],
    [`echo a | ${run} 2>&1 > std.out`, { screen: errOnly, stdout: errOnly, stderr: '', files: { 'std.out': outOnly('A') } }],
    [`echo a | ${run} > std.out 2>&1`, { screen: '', stdout: '', stderr: '', files: { 'std.out': interleaved('A') } }],
    [`echo a | ${run} | tee std.out`, { screen: `${errOnly}${outOnly('A')}`, stdout: outOnly('A'), stderr: errOnly, files: { 'std.out': outOnly('A') } }],
    // Unchanged: unredirected output streams as before.
    [`echo a | ${run}`, { screen: interleaved('A'), stdout: outOnly('A'), stderr: errOnly }],
  ];
}

const banner = '\n> demo@1.0.0 test\n> node main.js\n\n';
const npmCases: Array<[string, Expected]> = [
  ['echo a | npm test | grep A', { screen: `${errOnly}A\n`, stdout: 'A\n', stderr: errOnly }],
  ['echo a | npm test > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': `${banner}${outOnly('A')}` } }],
];

const LANGUAGES = {
  javascript: {
    path: 'main.js',
    contents: 'const fs = require("node:fs");\nconsole.log("out1"); console.error("err1"); console.log("out2"); console.error("err2");\nconsole.log(fs.readFileSync(0, "utf8").trim().toUpperCase());\n',
    run: 'node main.js',
    extraFiles: [{ path: 'package.json', contents: '{"name":"demo","version":"1.0.0","scripts":{"test":"node main.js"}}\n' }],
    extraCases: npmCases,
  },
  python: {
    path: 'main.py',
    contents: 'import sys\nprint("out1", flush=True)\nprint("err1", file=sys.stderr, flush=True)\nprint("out2", flush=True)\nprint("err2", file=sys.stderr, flush=True)\nprint(sys.stdin.read().strip().upper(), flush=True)\n',
    run: 'python3 main.py',
  },
  cpp: {
    path: 'main.cpp',
    contents: [
      '#include <cctype>',
      '#include <cstdio>',
      '#include <iostream>',
      '#include <string>',
      'int main() {',
      '  std::printf("out1\\n"); std::fflush(stdout);',
      '  std::fprintf(stderr, "err1\\n"); std::fflush(stderr);',
      '  std::printf("out2\\n"); std::fflush(stdout);',
      '  std::fprintf(stderr, "err2\\n"); std::fflush(stderr);',
      '  std::string line;',
      '  std::getline(std::cin, line);',
      '  for (char &c : line) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));',
      '  std::printf("%s\\n", line.c_str()); std::fflush(stdout);',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
    prepare: 'clang++ main.cpp -o main',
    run: './main',
  },
} as const;

interface LanguageRun {
  provider: string;
  files: Array<{ path: string; contents: string }>;
  prepare?: string;
  commands: string[];
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracekernel-output-routing-'));
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  try {
    await syncAssets(join(tempRoot, 'workers'));
    await build({
      entryPoints: [resolve('packages/runtime-browser/src/project.ts')],
      outfile: join(tempRoot, 'project-harness.mjs'),
      bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], logLevel: 'warning',
      alias: { zlib: resolve('packages/tracekernel/src/zlib-browser-shim.ts'), 'node:zlib': resolve('packages/tracekernel/src/zlib-browser-shim.ts') },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><meta charset="utf-8">');
    server = await startStaticServer(tempRoot);
    const expectations = new Map<string, Expected>();
    const runs: LanguageRun[] = RUNTIMES.map((provider) => {
      const language = LANGUAGES[provider as keyof typeof LANGUAGES];
      if (!language) throw new Error(`Unknown runtime ${provider}`);
      const all = [...cases(language.run), ...('extraCases' in language ? language.extraCases : [])];
      for (const [command, expected] of all) expectations.set(`${provider}:${command}`, expected);
      return {
        provider,
        files: [{ path: language.path, contents: language.contents }, ...('extraFiles' in language ? language.extraFiles : [])],
        ...('prepare' in language ? { prepare: language.prepare } : {}),
        commands: all.map(([command]) => command),
      };
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(600_000);
      page.on('pageerror', (error) => console.error('pageerror', error.message));
      await page.goto(`${server.origin}/index.html`);
      await page.evaluate('globalThis.__name = (fn) => fn');
      const receipts = await page.evaluate(async (languageRuns: LanguageRun[]) => {
        // @ts-expect-error Generated into the browser test server.
        const { createBrowserProjectWorkspace } = await import('/project-harness.mjs');
        const results = [];
        for (const { provider, files, prepare, commands } of languageRuns) {
          const workspace = await createBrowserProjectWorkspace({
            assetBaseUrl: '/workers', providers: [provider], files,
            nodeProjectTimeoutMs: 60_000, pythonProjectTimeoutMs: 120_000, cppProjectTimeoutMs: 120_000,
          });
          try {
            if (prepare) {
              const compiled = await workspace.runCommand(prepare);
              if (compiled.exitCode !== 0) throw new Error(JSON.stringify({ prepare, compiled }));
            }
            const terminal = workspace.createTerminalSession();
            for (const command of commands) {
              await workspace.runCommand('rm -f std.out std.err');
              const live = { stdout: '', stderr: '' };
              let screen = '';
              const started = performance.now();
              const result = await terminal.run(command, {
                onEvent: (event: { type: string; stream: 'stdout' | 'stderr'; data: string }) => {
                  if (event.type !== 'output') return;
                  live[event.stream] += event.data;
                  screen += event.data;
                },
              });
              const read = async (path: string) => workspace.readFile(path).catch(() => null);
              results.push({
                provider, command, screen, live,
                result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
                files: { 'std.out': await read('std.out'), 'std.err': await read('std.err') },
                elapsedMs: Math.round(performance.now() - started),
              });
            }
          } finally {
            await workspace.destroy();
          }
        }
        return results;
      }, runs);
      console.log(JSON.stringify(receipts, null, 2));
      const receiptPath = process.env.TRACECODE_OUTPUT_ROUTING_RECEIPT_PATH;
      if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipts, null, 2));
      const failures: string[] = [];
      for (const receipt of receipts) {
        const expected = expectations.get(`${receipt.provider}:${receipt.command}`)!;
        const actual = {
          screen: receipt.screen, stdout: receipt.live.stdout, stderr: receipt.live.stderr,
          ...(expected.files ? { files: Object.fromEntries(Object.keys(expected.files).map((path) => [path, receipt.files[path as 'std.out' | 'std.err']])) } : {}),
        };
        const matches = receipt.result.exitCode === 0 &&
          JSON.stringify(actual) === JSON.stringify(expected) &&
          receipt.result.stdout === receipt.live.stdout &&
          receipt.result.stderr === receipt.live.stderr;
        if (!matches) failures.push(`${receipt.provider}: ${receipt.command}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify({ ...actual, result: receipt.result })}`);
        else console.log(`PASS ${receipt.provider}: ${receipt.command}`);
      }
      if (receipts.length !== expectations.size) failures.push(`ran ${receipts.length} of ${expectations.size} cases`);
      if (failures.length > 0) throw new Error(`${failures.length} output routing cases differ from Bash:\n${failures.join('\n')}`);
      console.log(`PASS: ${receipts.length} piped and redirected lines in ${RUNTIMES.join(', ')} match Bash`);
    } finally {
      await browser.close();
    }
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
