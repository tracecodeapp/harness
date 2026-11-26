#!/usr/bin/env npx tsx

// Shell state that an interactive Bash carries from one typed line to the
// next: `$?`, the previous directory and `~`, and an environment that holds
// only variables, never interpreter internals. Each case runs its lines as
// separate terminal submissions and names the output GNU Bash 5 prints for
// the same lines.

import { test } from 'node:test';
import { parseSimpleCommandWords } from '../packages/tracekernel/src/workspace/arg-parsers';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import type { RuntimeCommandResult } from '../packages/runtime-contracts/src/runtime-project';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The interpreter's own names, and the storage of the arrays these tests create.
const INTERNAL_ENV_LINE = /^(?:[?#$!@*-]|\d+|IFS|OPTIND|OPTARG|SHELLOPTS|BASHOPTS|OSTYPE|MACHTYPE|HOSTTYPE|__GETOPTS_CHARINDEX|PIPESTATUS(?:_\d+|__length)|BASH_REMATCH(?:_\d+|__length)|arr(?:_\d+|__length))=/m;
// An associative array's storage, hidden while the interpreter that declared
// it runs. A later line's shell no longer knows it is associative (a known
// limit, like other declare attributes).
const SAME_LINE_ASSOCIATIVE = /^same(?:_\w+|__length)=/m;

interface Line {
  command: string;
  // What Bash prints on stdout for this line, and its status.
  bash: { stdout: string; exitCode: number };
}

async function createShellStateWorkspace(capturedEnv: Array<Record<string, string>> = []) {
  let interruptibleStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    interruptibleStarted = resolve;
  });
  const workspace = await createRuntimeWorkspace({
    kernel: {
      user: { username: 'obi' },
      host: { hostname: 'tracevm' },
      workspace: { name: 'weather-api' },
    },
    files: [
      { path: 'src/app.txt', contents: 'src\n' },
      { path: 'exit3.js', contents: 'process.exit(3)\n' },
      { path: 'throws.js', contents: 'throw new Error("boom")\n' },
      { path: 'env.js', contents: 'console.log(JSON.stringify(process.env))\n' },
      { path: 'wait.js', contents: 'await new Promise(() => {})\n' },
      { path: 'raises.py', contents: 'raise ValueError("boom")\n' },
    ],
    nodeRunner: async (request): Promise<RuntimeCommandResult> => {
      if (request.scriptPath.endsWith('exit3.js')) return { stdout: '', stderr: '', exitCode: 3 };
      if (request.scriptPath.endsWith('throws.js')) {
        const stderr = 'Uncaught Error: boom\n';
        request.onEvent?.({ type: 'output', stream: 'stderr', data: stderr });
        return { stdout: '', stderr, exitCode: 1 };
      }
      if (request.scriptPath.endsWith('env.js')) {
        capturedEnv.push({ ...request.env });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (request.scriptPath.endsWith('wait.js')) {
        interruptibleStarted();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    pythonRunner: async (request): Promise<RuntimeCommandResult> => {
      capturedEnv.push({ ...request.env });
      const stderr = 'Traceback (most recent call last):\n  File "/home/obi/weather-api/raises.py", line 1, in <module>\nValueError: boom\n';
      request.onEvent?.({ type: 'output', stream: 'stderr', data: stderr });
      return { stdout: '', stderr, exitCode: 1 };
    },
  });
  return { workspace, interruptibleStarted: started };
}

async function runLines(
  session: { run(command: string): Promise<RuntimeCommandResult> },
  label: string,
  lines: readonly Line[]
): Promise<void> {
  for (const line of lines) {
    const result = await session.run(line.command);
    assertCondition(
      result.stdout === line.bash.stdout && result.exitCode === line.bash.exitCode,
      `${label}: ${JSON.stringify(line.command)} should print what Bash prints ` +
        `(${JSON.stringify(line.bash)}), got ${JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode })}`
    );
  }
}

test('$? carries the previous line\'s status, as in an interactive Bash', async () => {
  const { workspace, interruptibleStarted } = await createShellStateWorkspace();
  try {
    const session = workspace.createTerminalSession();
    await runLines(session, 'plain failure', [
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      // `echo` itself succeeded.
      { command: 'echo $?', bash: { stdout: '0\n', exitCode: 0 } },
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo "last=$?"', bash: { stdout: 'last=1\n', exitCode: 0 } },
      { command: 'true', bash: { stdout: '', exitCode: 0 } },
      { command: 'echo $?', bash: { stdout: '0\n', exitCode: 0 } },
    ]);
    await runLines(session, 'explicit exit status', [
      { command: "bash -c 'exit 7'", bash: { stdout: '', exitCode: 7 } },
      { command: 'echo $?', bash: { stdout: '7\n', exitCode: 0 } },
      { command: '(exit 9)', bash: { stdout: '', exitCode: 9 } },
      { command: 'echo $?', bash: { stdout: '9\n', exitCode: 0 } },
      // A nested shell starts with its own status, not the caller's.
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      { command: "bash -c 'echo $?'", bash: { stdout: '0\n', exitCode: 0 } },
    ]);
    await runLines(session, 'program exit status', [
      { command: 'node exit3.js', bash: { stdout: '', exitCode: 3 } },
      { command: 'echo $?', bash: { stdout: '3\n', exitCode: 0 } },
      { command: 'node throws.js', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      { command: 'python3 raises.py', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
    ]);
    await runLines(session, 'terminal-handled commands', [
      { command: 'cd missing-directory', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      { command: 'pwd', bash: { stdout: '/home/obi/weather-api\n', exitCode: 0 } },
      { command: 'echo $?', bash: { stdout: '0\n', exitCode: 0 } },
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      // An empty line runs nothing and keeps the status.
      { command: '', bash: { stdout: '', exitCode: 0 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      // So does a line that is only comments.
      { command: 'false', bash: { stdout: '', exitCode: 1 } },
      { command: '# note', bash: { stdout: '', exitCode: 0 } },
      { command: '   # indented', bash: { stdout: '', exitCode: 0 } },
      { command: '# one\n# two', bash: { stdout: '', exitCode: 0 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      // A comment after a command is part of a command line.
      { command: 'false # trailing', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
    ]);
    await runLines(session, 'other statuses', [
      { command: 'no-such-command', bash: { stdout: '', exitCode: 127 } },
      { command: 'echo $?', bash: { stdout: '127\n', exitCode: 0 } },
      { command: 'echo "unterminated', bash: { stdout: '', exitCode: 2 } },
      { command: 'echo $?', bash: { stdout: '2\n', exitCode: 0 } },
      { command: 'false && true', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
      { command: 'false || true', bash: { stdout: '', exitCode: 0 } },
      { command: 'echo $?', bash: { stdout: '0\n', exitCode: 0 } },
      { command: 'true | false', bash: { stdout: '', exitCode: 1 } },
      { command: 'echo $?', bash: { stdout: '1\n', exitCode: 0 } },
    ]);

    // Ctrl-C: Bash reports 128 + SIGINT.
    const interrupted = session.run('node wait.js');
    await interruptibleStarted;
    assertCondition(session.interrupt(), 'Ctrl-C should signal the foreground program');
    const interruptedResult = await interrupted;
    assertCondition(interruptedResult.exitCode === 130, `Ctrl-C should end with 130: ${JSON.stringify(interruptedResult)}`);
    await runLines(session, 'interrupt', [{ command: 'echo $?', bash: { stdout: '130\n', exitCode: 0 } }]);
  } finally {
    await workspace.destroy();
  }
});

test('a bare exit closes the terminal with the last status', async () => {
  const { workspace } = await createShellStateWorkspace();
  try {
    for (const lines of [['false', 'exit'], ['node exit3.js', 'exit'], ['false; exit']]) {
      const exits: number[] = [];
      const session = workspace.createTerminalSession({
        onTerminalEvent: (event) => {
          if (event.type === 'control' && event.action === 'exit' && event.exitCode !== undefined) exits.push(event.exitCode);
        },
      });
      let result: RuntimeCommandResult | undefined;
      for (const line of lines) result = await session.run(line);
      // Bash: `false` then `exit` leaves the shell with status 1; after a
      // program that exited 3, with 3.
      const expected = lines[0] === 'node exit3.js' ? 3 : 1;
      assertCondition(
        session.closed && result?.exitCode === expected && exits.length === 1 && exits[0] === expected,
        `${JSON.stringify(lines)} should close the terminal with ${expected}: ${JSON.stringify({ result, exits, closed: session.closed })}`
      );
    }
    const explicit = workspace.createTerminalSession();
    await explicit.run('false');
    const explicitExit = await explicit.run('exit 0');
    assertCondition(explicitExit.exitCode === 0 && explicit.closed, `exit 0 should still close with 0: ${JSON.stringify(explicitExit)}`);
  } finally {
    await workspace.destroy();
  }
});

test('cd - and cd ~ move between directories as Bash does', async () => {
  const { workspace } = await createShellStateWorkspace();
  try {
    const session = workspace.createTerminalSession();
    const root = '/home/obi/weather-api';
    const firstPrevious = await session.run('cd -');
    // Bash: `bash: cd: OLDPWD not set`, status 1. The terminal prints its
    // usual `cd:` prefix.
    assertCondition(
      firstPrevious.exitCode === 1 && firstPrevious.stderr === 'cd: OLDPWD not set\n' && session.cwd === root,
      `cd - before any cd should fail like Bash: ${JSON.stringify(firstPrevious)}`
    );
    await runLines(session, 'cd -', [
      { command: 'cd src', bash: { stdout: '', exitCode: 0 } },
      // `cd -` prints the directory it moves to.
      { command: 'cd -', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd -', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'echo "$PWD $OLDPWD"', bash: { stdout: `${root}/src ${root}\n`, exitCode: 0 } },
    ]);
    assertCondition((session.cwd as string) === `${root}/src`, `cd - should move the terminal: ${session.cwd}`);

    await runLines(session, 'cd ~', [
      { command: 'cd ~', bash: { stdout: '', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: '/home/obi\n', exitCode: 0 } },
      { command: 'echo "$OLDPWD"', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'cd -', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'cd ~/weather-api', bash: { stdout: '', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd ~/src', bash: { stdout: '', exitCode: 1 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
    ]);
    assertCondition(session.prompt.label === 'weather-api', `failed cd should leave the prompt: ${session.prompt.text}`);

    await runLines(session, 'compound cd', [
      { command: 'cd ~ && pwd', bash: { stdout: '/home/obi\n', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: '/home/obi\n', exitCode: 0 } },
      { command: 'cd - && pwd', bash: { stdout: `${root}\n${root}\n`, exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd src; cd -', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd ~/weather-api/src && pwd', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'cd -', bash: { stdout: `${root}\n`, exitCode: 0 } },
    ]);
    assertCondition(session.cwd === root, `compound cd should leave the terminal in the workspace: ${session.cwd}`);

    // OLDPWD outside the terminal's navigation limits (here outside
    // /home/obi) is never stored. Bash would print /home on these lines; the
    // terminal keeps the last allowed directory instead.
    await runLines(session, 'OLDPWD outside the limits', [
      { command: 'cd src', bash: { stdout: '', exitCode: 0 } },
      { command: 'cd ..', bash: { stdout: '', exitCode: 0 } },
      // The prompt did not move: the previous allowed OLDPWD stays.
      { command: 'OLDPWD=/home', bash: { stdout: '', exitCode: 0 } },
      { command: 'echo "$OLDPWD"', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'cd - && pwd', bash: { stdout: `${root}/src\n${root}/src\n`, exitCode: 0 } },
      // The prompt moved: the directory it left is stored.
      { command: 'cd /home && cd ~/weather-api', bash: { stdout: '', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd -', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
      { command: 'cd ..', bash: { stdout: '', exitCode: 0 } },
    ]);
    assertCondition(session.cwd === root, `the terminal should be back in the workspace: ${session.cwd}`);
    // A line that ends outside the limits runs there (as before this change)
    // but leaves the prompt and OLDPWD where they were.
    await runLines(session, 'final directory outside the limits', [
      { command: 'cd /home && pwd', bash: { stdout: '/home\n', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'cd ..; cd ..; cd ..', bash: { stdout: '', exitCode: 0 } },
      { command: 'pwd', bash: { stdout: `${root}\n`, exitCode: 0 } },
      { command: 'echo "$OLDPWD"', bash: { stdout: `${root}/src\n`, exitCode: 0 } },
    ]);

    // The prompt labels the home directory `~`.
    await session.run('cd ~');
    assertCondition((session.prompt.label as string) === '~', `cd ~ should label the prompt ~: ${session.prompt.text}`);
  } finally {
    await workspace.destroy();
  }
});

test('env and program environments hold variables, not interpreter internals', async () => {
  const capturedEnv: Array<Record<string, string>> = [];
  const { workspace } = await createShellStateWorkspace(capturedEnv);
  try {
    const session = workspace.createTerminalSession();
    // Lines that make just-bash record status, pipe status, positional
    // parameters, regex matches and arrays.
    for (const line of [
      'false | true',
      'set -- a b',
      '[[ abc =~ (b) ]]',
      'arr=(x y)',
      'declare -A map; map[k]=v',
      'export TRACE_EXPORTED=kept',
      // Learner names that only look like array storage.
      'arr_backup=kept',
      'export __TRACE=1',
      'export count__length=3',
      'false',
    ]) {
      await session.run(line);
    }
    const env = await session.run('env | sort');
    assertCondition(
      env.exitCode === 0 &&
        !INTERNAL_ENV_LINE.test(env.stdout) &&
        !env.stdout.split('\n').slice(0, -1).includes('') &&
        /^HOME=\/home\/obi$/m.test(env.stdout) &&
        /^PATH=/m.test(env.stdout) &&
        /^USER=obi$/m.test(env.stdout) &&
        /^PWD=\/home\/obi\/weather-api$/m.test(env.stdout) &&
        /^TRACE_EXPORTED=kept$/m.test(env.stdout) &&
        /^arr_backup=kept$/m.test(env.stdout) &&
        /^__TRACE=1$/m.test(env.stdout) &&
        /^count__length=3$/m.test(env.stdout),
      `env | sort should list variables only, learner names included: ${JSON.stringify(env)}`
    );
    // Within one line the interpreter knows its arrays exactly, associative
    // ones included, and its regex match.
    const sameLine = await session.run('declare -A same; same[key]=v; same[other]=w; [[ abc =~ (b) ]]; env | sort');
    assertCondition(
      sameLine.exitCode === 0 &&
        !INTERNAL_ENV_LINE.test(sameLine.stdout) &&
        !SAME_LINE_ASSOCIATIVE.test(sameLine.stdout) &&
        /^arr_backup=kept$/m.test(sameLine.stdout),
      `env should hide associative-array storage and BASH_REMATCH on the same line: ${JSON.stringify(sameLine)}`
    );
    // Bash: printenv of a shell-only name prints nothing and fails.
    await runLines(session, 'printenv', [
      { command: "printenv '?' IFS", bash: { stdout: '', exitCode: 1 } },
      { command: 'printenv TRACE_EXPORTED', bash: { stdout: 'kept\n', exitCode: 0 } },
    ]);
    const printenv = await session.run('printenv');
    assertCondition(!INTERNAL_ENV_LINE.test(printenv.stdout), `printenv should list variables only: ${JSON.stringify(printenv)}`);
    // Shell expansion still sees the interpreter's own variables.
    await runLines(session, 'shell variables', [
      { command: 'echo "$OSTYPE"', bash: { stdout: 'tracekernel\n', exitCode: 0 } },
      { command: 'echo "${arr[1]}"', bash: { stdout: 'y\n', exitCode: 0 } },
      { command: 'echo "$TRACE_EXPORTED"', bash: { stdout: 'kept\n', exitCode: 0 } },
    ]);

    await session.run('node env.js');
    await session.run('python3 raises.py');
    assertCondition(capturedEnv.length === 2, `both programs should have run: ${capturedEnv.length}`);
    for (const programEnv of capturedEnv) {
      const lines = Object.entries(programEnv).map(([key, value]) => `${key}=${value}`).join('\n');
      assertCondition(
        !INTERNAL_ENV_LINE.test(lines) &&
          programEnv.TRACE_EXPORTED === 'kept' &&
          programEnv.HOME === '/home/obi' &&
          programEnv.arr_backup === 'kept' &&
          programEnv.__TRACE === '1' &&
          programEnv.count__length === '3',
        `a learner program's environment should hold variables only: ${JSON.stringify(programEnv)}`
      );
    }
  } finally {
    await workspace.destroy();
  }
});

test('terminal word parsing expands an unqualified ~ only when asked', () => {
  const home = '/home/obi';
  const cases: Array<[string, string[] | null, string[] | null]> = [
    ['cd ~', null, ['cd', home]],
    ['cd ~/src', null, ['cd', `${home}/src`]],
    ['cd "~"', ['cd', '~'], ['cd', '~']],
    ['cd ~other', null, null],
    ['cd a~', ['cd', 'a~'], ['cd', 'a~']],
    ['cd -', ['cd', '-'], ['cd', '-']],
  ];
  for (const [command, plain, expanded] of cases) {
    assertCondition(
      JSON.stringify(parseSimpleCommandWords(command)) === JSON.stringify(plain) &&
        JSON.stringify(parseSimpleCommandWords(command, { home })) === JSON.stringify(expanded),
      `words of ${JSON.stringify(command)}: ${JSON.stringify([parseSimpleCommandWords(command), parseSimpleCommandWords(command, { home })])}`
    );
  }
});
