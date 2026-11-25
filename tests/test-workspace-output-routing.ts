import assert from 'node:assert/strict';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import type { JavaScriptProjectCommandRunner } from '../packages/tracekernel/src/workspace/index';
import type { TraceKernelSyscallRequest, TraceKernelSyscallResult } from '../packages/tracekernel/src/index';

// A language program's stdout and stderr reach the terminal only where the
// shell routes them. The fixture is the kernel-realism `*-streams` program: it
// writes out1, err1, out2, err2 through fd 1/2, then its stdin upper-cased.
//
// Each case lists what Bash shows for the same line (GNU Bash with Node 22,
// `bash -c LINE` with the screen captured per stream and merged), and the
// files it leaves. `screen` is every live event in order; `stdout`/`stderr`
// split it by stream. The terminal session's returned stdout/stderr must
// equal the live streams, so a renderer never replays output.
const program = (input: string) => [[1, 'out1\n'], [2, 'err1\n'], [1, 'out2\n'], [2, 'err2\n'], [1, `${input}\n`]] as const;

const RUNNER_ERROR = { code: 'EIO', errno: 5, message: 'runner transport failed' };

const descriptorRunner: JavaScriptProjectCommandRunner = Object.assign(async (request: Parameters<JavaScriptProjectCommandRunner>[0]) => {
  // A run whose runner reports a structured error (here at exit 0, as a transport failure can).
  if (request.scriptPath.endsWith('failing.js')) return { stdout: '', stderr: '', exitCode: 0, error: RUNNER_ERROR };
  if (request.scriptPath.endsWith('legacy.js')) {
    // A runner without descriptor stdio streams through onEvent and returns its output.
    let stdout = '';
    let stderr = '';
    for (const [fd, data] of program('LEGACY')) {
      request.onEvent?.({ type: 'output', stream: fd === 1 ? 'stdout' : 'stderr', data });
      if (fd === 1) stdout += data; else stderr += data;
    }
    return { stdout, stderr, exitCode: 0 };
  }
  const dispatch = (body: TraceKernelSyscallRequest) => request.kernelSyscalls!.dispatch(body) as Promise<TraceKernelSyscallResult>;
  const chunks: Uint8Array[] = [];
  while (!request.scriptPath.endsWith('nostdin.js')) {
    const read = await dispatch({ op: 'read', fd: 0, maxBytes: 4096 });
    assert.ok(read.ok && read.value.op === 'read');
    if (!read.ok || read.value.op !== 'read' || read.value.bytes.length === 0) break;
    chunks.push(read.value.bytes);
  }
  const input = Buffer.concat(chunks).toString().trim().toUpperCase();
  for (const [fd, data] of program(input)) {
    const written = await dispatch({ op: 'write', fd, bytes: new TextEncoder().encode(data) });
    assert.ok(written.ok);
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}, { capabilities: { descriptorStdio: true } });

interface Expected {
  screen: string;
  stdout: string;
  stderr: string;
  files?: Record<string, string | null>;
}

const banner = (script: string, command: string) => `\n> demo@1.0.0 ${script}\n> ${command}\n\n`;
const interleaved = (input: string) => `out1\nerr1\nout2\nerr2\n${input}\n`;
const outOnly = (input: string) => `out1\nout2\n${input}\n`;
const errOnly = 'err1\nerr2\n';

const cases: Array<[command: string, expected: Expected]> = [
  // Bash: stdout ALPHA, stderr err1 err2, screen err1 err2 ALPHA. Main showed out1 out2 too.
  ['echo alpha | node main.js | grep ALPHA', { screen: `${errOnly}ALPHA\n`, stdout: 'ALPHA\n', stderr: errOnly }],
  // Bash: nothing on screen.
  ['echo beta | node main.js > std.out 2> std.err', { screen: '', stdout: '', stderr: '', files: { 'std.out': outOnly('BETA'), 'std.err': errOnly } }],
  // Bash: stdout out1 out2 A, stderr to the file.
  ['echo a | node main.js 2> std.err', { screen: outOnly('A'), stdout: outOnly('A'), stderr: '', files: { 'std.err': errOnly } }],
  // Bash: nothing on screen; the file holds both streams in write order.
  ['echo a | node main.js > std.out 2>&1', { screen: '', stdout: '', stderr: '', files: { 'std.out': interleaved('A') } }],
  ['echo a | node main.js &> std.out', { screen: '', stdout: '', stderr: '', files: { 'std.out': interleaved('A') } }],
  // Bash: stdout interleaved through cat.
  ['echo a | node main.js 2>&1 | cat', { screen: interleaved('A'), stdout: interleaved('A'), stderr: '' }],
  ['echo gamma | node main.js 2>&1 | grep err', { screen: errOnly, stdout: errOnly, stderr: '' }],
  // Bash: stderr goes to the old stdout (the screen), stdout to the file.
  ['echo a | node main.js 2>&1 > std.out', { screen: errOnly, stdout: errOnly, stderr: '', files: { 'std.out': outOnly('A') } }],
  ['echo a | node main.js 2>&1 >/dev/null | cat', { screen: errOnly, stdout: errOnly, stderr: '' }],
  ['echo a | node main.js 2>/dev/stdout > std.out', { screen: errOnly, stdout: errOnly, stderr: '', files: { 'std.out': outOnly('A') } }],
  // Bash: both streams on one stream, in write order.
  ['echo a | node main.js 2>&1', { screen: interleaved('A'), stdout: interleaved('A'), stderr: '' }],
  ['echo a | node main.js >&2', { screen: interleaved('A'), stdout: '', stderr: interleaved('A') }],
  ['echo a | node main.js > /dev/null', { screen: errOnly, stdout: '', stderr: errOnly }],
  // Bash 5 `|&` is `2>&1 |`: stdout interleaved through cat.
  ['echo a | node main.js |& cat', { screen: interleaved('A'), stdout: interleaved('A'), stderr: '' }],
  // Bash: stderr live, tee's copy of stdout, and the file. The piped stage no longer streams live.
  ['echo a | node main.js | tee std.out', { screen: `${errOnly}${outOnly('A')}`, stdout: outOnly('A'), stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  // Bash shows out1 err1 out2 err2 A on the tty. The kernel shell writes the
  // redirected stdout to /dev/tty after the program exits: same bytes, once.
  ['echo a | node main.js > /dev/tty', { screen: `${errOnly}${outOnly('A')}`, stdout: outOnly('A'), stderr: errOnly }],
  // Compositions that redirect a function, group, script or substitution.
  ['f() { node main.js; }; echo a | f > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['f() { node main.js; }; echo a | f 2>&1 | cat', { screen: interleaved('A'), stdout: interleaved('A'), stderr: '' }],
  ['f() { node main.js; } > std.out; echo a | f', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['echo a | { node main.js; } > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['echo a | (node main.js) 2> std.err', { screen: outOnly('A'), stdout: outOnly('A'), stderr: '', files: { 'std.err': errOnly } }],
  ['echo a | bash run.sh > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['x=$(echo a | node main.js); echo "[$x]"', { screen: `${errOnly}[out1\nout2\nA]\n`, stdout: '[out1\nout2\nA]\n', stderr: errOnly }],
  ['echo a | command node main.js | grep A', { screen: `${errOnly}A\n`, stdout: 'A\n', stderr: errOnly }],
  // npm prints its banner on stdout; the script's node runs under npm.
  ['echo a | npm test | grep A', { screen: `${errOnly}A\n`, stdout: 'A\n', stderr: errOnly }],
  ['echo a | npm test > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': `${banner('test', 'node main.js')}${outOnly('A')}` } }],
  ['echo a | npm test 2>&1 | cat', { screen: `${banner('test', 'node main.js')}${interleaved('A')}`, stdout: `${banner('test', 'node main.js')}${interleaved('A')}`, stderr: '' }],
  ['echo a | npm test 2>&1 > std.out', { screen: errOnly, stdout: errOnly, stderr: '', files: { 'std.out': `${banner('test', 'node main.js')}${outOnly('A')}` } }],
  ['echo a | npm test 2> std.err', { screen: `${banner('test', 'node main.js')}${outOnly('A')}`, stdout: `${banner('test', 'node main.js')}${outOnly('A')}`, stderr: '', files: { 'std.err': errOnly } }],
  // Main printed these twice: npm replayed its script's output at exit.
  ['echo a | npm test', { screen: `${banner('test', 'node main.js')}${interleaved('A')}`, stdout: `${banner('test', 'node main.js')}${outOnly('A')}`, stderr: errOnly }],
  ['npm run quiet < input.txt', { screen: `${banner('quiet', 'node nostdin.js')}${interleaved('')}`, stdout: `${banner('quiet', 'node nostdin.js')}${outOnly('')}`, stderr: errOnly }],
  // Redirects held on the shell's own descriptors by `exec` apply to later commands.
  // (just-bash also applies a held stdout to the writer of a pipe, so these read a file.)
  ['exec > std.out; node main.js < input.txt', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('IGNORED') } }],
  ['exec 2> std.err; node main.js < input.txt', { screen: outOnly('IGNORED'), stdout: outOnly('IGNORED'), stderr: '', files: { 'std.err': errOnly } }],
  ['exec 1>&2; node main.js < input.txt', { screen: interleaved('IGNORED'), stdout: '', stderr: interleaved('IGNORED') }],
  // Sourced files and eval'd strings route like typed lines.
  ['source redirect.sh', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['. redirect.sh', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ["eval 'echo a | node main.js > std.out'", { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  // (A pipe into a redirected `source`/`eval`, and a redirected `if`, are not
  // redirected by just-bash at all: a separate shell gap, shown as before.)
  ['source quiet.sh > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('') } }],
  // Main stopped the line after a runtime inside source or eval.
  ['source quiet.sh; eval node nostdin.js; echo after', { screen: `${interleaved('')}${interleaved('')}after\n`, stdout: `${outOnly('')}${outOnly('')}after\n`, stderr: `${errOnly}${errOnly}` }],
  ['eval node main.js < input.txt 2> std.err', { screen: outOnly('IGNORED'), stdout: outOnly('IGNORED'), stderr: '', files: { 'std.err': errOnly } }],
  // More redirect shapes.
  ['echo a | node main.js 1>&2 2>&1', { screen: interleaved('A'), stdout: '', stderr: interleaved('A') }],
  ['echo a | node main.js >> std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['for i in 1; do echo a | node main.js; done > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('A') } }],
  ['node main.js <<< a | grep A', { screen: `${errOnly}A\n`, stdout: 'A\n', stderr: errOnly }],
  // Unchanged: an unredirected program streams everything.
  ['echo a | node main.js', { screen: interleaved('A'), stdout: outOnly('A'), stderr: errOnly }],
  ['npm run quiet', { screen: `${banner('quiet', 'node nostdin.js')}${interleaved('')}`, stdout: `${banner('quiet', 'node nostdin.js')}${outOnly('')}`, stderr: errOnly }],
  // A runner that streams through onEvent follows the same routes.
  ['node legacy.js | grep LEGACY', { screen: `${errOnly}LEGACY\n`, stdout: 'LEGACY\n', stderr: errOnly }],
  ['node legacy.js > std.out', { screen: errOnly, stdout: '', stderr: errOnly, files: { 'std.out': outOnly('LEGACY') } }],
];

const workspace = await createRuntimeWorkspace({
  nodeRunner: descriptorRunner,
  files: [
    { path: 'main.js', contents: '' },
    { path: 'nostdin.js', contents: '' },
    { path: 'legacy.js', contents: '' },
    { path: 'input.txt', contents: 'ignored\n' },
    { path: 'failing.js', contents: '' },
    { path: 'run.sh', contents: 'node main.js\n' },
    { path: 'redirect.sh', contents: 'echo a | node main.js > std.out\n' },
    { path: 'quiet.sh', contents: 'node nostdin.js\n' },
    { path: 'package.json', contents: JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node main.js', quiet: 'node nostdin.js', fail: 'node failing.js' } }) },
  ],
});
const failures: string[] = [];
try {
  for (const [command, expected] of cases) {
    await workspace.runCommand('rm -f std.out std.err');
    const terminal = workspace.createTerminalSession();
    const live = { stdout: '', stderr: '' };
    let screen = '';
    const result = await terminal.run(command, {
      onEvent: (event) => {
        if (event.type !== 'output') return;
        live[event.stream] += event.data;
        screen += event.data;
      },
    });
    const files: Record<string, string | null> = {};
    for (const path of Object.keys(expected.files ?? {})) {
      files[path] = await workspace.readFile(path).catch(() => null);
    }
    const actual = { screen, stdout: live.stdout, stderr: live.stderr, ...(expected.files ? { files } : {}) };
    try {
      assert.equal(result.exitCode, 0, `${command} exit`);
      assert.deepEqual(actual, expected, command);
      // The returned transcript is the live one: nothing replays at the end.
      assert.equal(result.stdout, live.stdout, `${command} returned stdout`);
      assert.equal(result.stderr, live.stderr, `${command} returned stderr`);
    } catch (error) {
      failures.push(`${command}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify({ ...actual, result: { stdout: result.stdout, stderr: result.stderr } })}`);
    }
  }

  // The workspace API (no terminal session) sees the same live routing.
  const apiLive = { stdout: '', stderr: '' };
  const api = await workspace.runCommand('echo alpha | node main.js | grep ALPHA', {
    presentation: 'terminal',
    onEvent: (event) => { if (event.type === 'output') apiLive[event.stream] += event.data; },
  });
  try {
    assert.deepEqual(apiLive, { stdout: 'ALPHA\n', stderr: errOnly });
    assert.equal(api.stdout, 'ALPHA\n');
  } catch {
    failures.push(`workspace.runCommand pipe: ${JSON.stringify({ apiLive, stdout: api.stdout })}`);
  }

  // A script's structured runtime error reaches the terminal result as a direct run's does.
  for (const command of ['node failing.js', 'npm run fail', 'npm run fail | cat', 'npm run fail > std.out', 'echo a | npm run fail']) {
    const result = await workspace.createTerminalSession().run(command);
    try {
      assert.equal(result.exitCode, 0, `${command} exit`);
      assert.equal(result.error?.code, RUNNER_ERROR.code, `${command} error code`);
      assert.equal(result.error?.message, RUNNER_ERROR.message, `${command} error message`);
    } catch {
      failures.push(`${command}: structured error ${JSON.stringify(result.error)} (exit ${result.exitCode})`);
    }
  }
} finally {
  workspace.dispose();
}
const total = cases.length + 6;
if (failures.length > 0) {
  console.error(`${failures.length} of ${total} output routing cases differ from Bash:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`workspace output routing: ${total} piped, redirected and composed lines match Bash`);
