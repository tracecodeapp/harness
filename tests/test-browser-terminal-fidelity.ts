#!/usr/bin/env npx tsx

import {
  createRuntimeCommandStdinPipeFromText,
  type RuntimeCommandEvent,
  type RuntimeCommandResult,
} from '../packages/harness-core/src/runtime-project';
import { createBrowserProjectWorkspace } from '../packages/harness-browser/src/project';
import { createBrowserPythonProjectRunner } from '../packages/harness-python/src/project-browser';
import { createBrowserJavaProjectRunner } from '../packages/harness-java/src/project-browser';
import { createBrowserCSharpProjectRunner } from '../packages/harness-csharp/src/project-browser';
import { createBrowserCppProjectRunner } from '../packages/harness-cpp/src/project-browser';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const FORBIDDEN_TERMINAL_FRAGMENTS = [
  'tracekernel',
  'worker emitted',
  'worker request',
  'execution host',
  'browser project environment',
  'project command adapter',
  'blob:',
  '/users/',
  '/packages/harness-',
];

function assertTerminalFidelity(
  result: RuntimeCommandResult,
  label: string,
  options: { allowKernelIdentity?: boolean } = {}
): void {
  const terminal = `${result.stdout}\n${result.stderr}`.toLowerCase();
  for (const fragment of FORBIDDEN_TERMINAL_FRAGMENTS) {
    if (fragment === 'tracekernel' && options.allowKernelIdentity) continue;
    assertCondition(
      !terminal.includes(fragment),
      `${label} leaked implementation detail ${JSON.stringify(fragment)}: ${JSON.stringify(result)}`
    );
  }
}

async function testNativeCommandIdentity(): Promise<void> {
  const fail = async (): Promise<never> => {
    throw new Error('metadata commands must not start a language worker');
  };
  const workspace = await createBrowserProjectWorkspace({
    providers: ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'],
    files: [
      { path: 'package.json', contents: '{"name":"implicit-start","version":"1.0.0"}\n' },
      { path: 'server.js', contents: 'console.log("implicit server ready")\n' },
    ],
    nodeProject: {
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
    },
    pythonWorkerClient: { executeProjectPython: fail, terminate() {} },
    javaWorkerClient: { executeProjectJava: fail, terminate() {} },
    csharpWorkerClient: { executeProjectCSharp: fail, terminate() {} },
    cppWorkerClient: { executeProjectCpp: fail, terminate() {} },
  });

  try {
    const cases = [
      ['python3 --version', 'Python 3.13.2\n', ''],
      ['node --version', 'v22.0.0\n', ''],
      ['tsc --version', 'Version 5.9.3\n', ''],
      ['javac --version', 'javac 17\n', ''],
      [
        'java --version',
        'openjdk 17\nOpenJDK Runtime Environment (build 17)\nOpenJDK 64-Bit Server VM (build 17, mixed mode)\n',
        '',
      ],
      [
        'java -version',
        '',
        'openjdk 17\nOpenJDK Runtime Environment (build 17)\nOpenJDK 64-Bit Server VM (build 17, mixed mode)\n',
      ],
      [
        'clang++ --version',
        'clang version 22.0.0-git20542-10\nTarget: wasm32-unknown-wasi\nThread model: posix\n',
        '',
      ],
      ['dotnet --version', '10.0.9\n', ''],
      [
        'dotnet --info',
        '.NET SDK:\n Version:           10.0.9\n\nRuntime Environment:\n OS Name:     tracekernel\n OS Platform: tracekernel\n RID:         tracekernel-x64\n\nHost:\n  Version:      10.0.9\n  Architecture: x64\n',
        '',
      ],
    ] as const;

    for (const [command, stdout, stderr] of cases) {
      const result = await workspace.runCommand(command);
      assertCondition(
        result.exitCode === 0 && result.stdout === stdout && result.stderr === stderr,
        `${command} should report its embedded toolchain with native CLI shape: ${JSON.stringify(result)}`
      );
      assertTerminalFidelity(result, command, { allowKernelIdentity: command === 'dotnet --info' });
    }

    const helpCases = [
      ['bg --help', 'bg'],
      ['curl -h', 'curl'],
      ['fastfetch --help', 'fastfetch'],
      ['fg --help', 'fg'],
      ['getconf --help', 'getconf'],
      ['getent --help', 'getent'],
      ['groups --help', 'groups'],
      ['jobs --help', 'jobs'],
      ['kill --help', 'kill'],
      ['lsof -?', 'lsof'],
      ['locale --help', 'locale'],
      ['ls --help', 'ls'],
      ['man --help', 'man'],
      ['mktemp --help', 'mktemp'],
      ['neofetch --help', 'neofetch'],
      ['pgrep -h', 'pgrep'],
      ['ping --help', 'ping'],
      ['pkill --help', 'pkill'],
      ['ps --help', 'ps'],
      ['ss -h', 'ss'],
      ['stty --help', 'stty'],
      ['tput --help', 'tput'],
      ['tracekernelctl --help', 'tracekernelctl'],
      ['tracekernel-exec --help', 'tracekernel-exec'],
      ['tty --help', 'tty'],
      ['wait --help', 'wait'],
      ['wget -h', 'wget'],
      ['which --help', 'which'],
      ['command --help', 'command'],
      ['python3 -h', 'python3'],
      ['python --help', 'python'],
      ['node -h', 'node'],
      ['tsc --help', 'tsc'],
      ['javac -?', 'javac'],
      ['java -help', 'java'],
      ['clang++ --help', 'clang++'],
      ['clang --help', 'clang'],
      ['gcc --help', 'gcc'],
      ['g++ --help', 'g++'],
      ['cc --help', 'cc'],
      ['c++ --help', 'c++'],
      ['a.out --help', 'a.out'],
      ['dotnet -h', 'dotnet'],
      ['npm --help', 'npm'],
      ['npx -h', 'npx'],
    ] as const;

    for (const [command, commandName] of helpCases) {
      const result = await workspace.runCommand(command);
      assertCondition(
        result.exitCode === 0 &&
          result.stderr === '' &&
          result.stdout.startsWith(`${commandName} - `) &&
          result.stdout.includes(`Usage: ${commandName}`) &&
          result.stdout.includes('display this help and exit'),
        `${command} should expose concise command help without loading its runtime: ${JSON.stringify(result)}`
      );
      assertTerminalFidelity(result, command, {
        allowKernelIdentity:
          commandName.startsWith('tracekernel') ||
          commandName === 'fastfetch' ||
          commandName === 'neofetch',
      });
    }

    const inheritedHelpFailures: string[] = [];
    for (const commandName of [
      'basename',
      'cat',
      'chmod',
      'cp',
      'cut',
      'date',
      'dirname',
      'env',
      'find',
      'grep',
      'head',
      'mkdir',
      'mv',
      'rm',
      'rmdir',
      'sed',
      'sort',
      'tail',
      'tee',
      'touch',
      'tr',
      'uniq',
      'wc',
      'xargs',
    ]) {
      const builtinHelp = await workspace.runCommand(`${commandName} --help`);
      if (builtinHelp.exitCode !== 0 || !builtinHelp.stdout.includes(`Usage: ${commandName}`)) {
        inheritedHelpFailures.push(`${commandName}: ${JSON.stringify(builtinHelp)}`);
      }
      assertTerminalFidelity(builtinHelp, `${commandName} --help`);
    }
    assertCondition(
      inheritedHelpFailures.length === 0,
      `inherited command help should remain available:\n${inheritedHelpFailures.join('\n')}`
    );

    const shortLs = await workspace.runCommand('ls -h');
    assertCondition(
      shortLs.exitCode === 0 && !shortLs.stdout.includes('Usage:'),
      `ls -h should retain its human-readable-size meaning: ${JSON.stringify(shortLs)}`
    );

    const fastfetch = await workspace.runCommand('fastfetch');
    const neofetch = await workspace.runCommand('neofetch');
    assertCondition(
      fastfetch.exitCode === 0 &&
        fastfetch.stderr === '' &&
        neofetch.stdout === fastfetch.stdout &&
        neofetch.stderr === fastfetch.stderr &&
        fastfetch.stdout.includes('OS: TraceKernel') &&
        fastfetch.stdout.includes('Host: tracevm') &&
        fastfetch.stdout.includes('Shell: /bin/bash') &&
        fastfetch.stdout.includes('Terminal: dumb (80x24)') &&
        fastfetch.stdout.includes('Architecture: wasm32') &&
        fastfetch.stdout.includes('⣾⠋⠱⢦⣄⣀') &&
        !fastfetch.stdout.includes('\uFFFD') &&
        fastfetch.stdout.includes('Workspace: workspace') &&
        fastfetch.stdout.includes('Runtimes: 6 available') &&
        !fastfetch.stdout.toLowerCase().includes('linux'),
      `fastfetch and its neofetch alias should report only modeled TraceKernel identity: ${JSON.stringify({ fastfetch, neofetch })}`
    );
    assertTerminalFidelity(fastfetch, 'fastfetch', { allowKernelIdentity: true });

    const fetchPaths = await workspace.runCommand('which fastfetch neofetch');
    assertCondition(
      fetchPaths.exitCode === 0 &&
        fetchPaths.stdout === '/tracekernel/bin/fastfetch\n/tracekernel/bin/neofetch\n',
      `fastfetch and neofetch should resolve through the TraceKernel executable directory: ${JSON.stringify(fetchPaths)}`
    );

    const scriptHelpArgument = await workspace.runCommand(
      `node -e "console.log(process.argv.slice(1).join(','))" --help`
    );
    assertCondition(
      scriptHelpArgument.exitCode === 0 && scriptHelpArgument.stdout === '--help\n',
      `help flags after a Node program should remain program arguments: ${JSON.stringify(scriptHelpArgument)}`
    );

   const commandMetadata = await workspace.runCommand('cat /tracekernel/bin/curl');
    const explicitCommandHelp = await workspace.runCommand('/tracekernel/bin/curl --help');
    assertCondition(
      commandMetadata.exitCode === 0 &&
        commandMetadata.stdout === '#!/bin/sh\nexec tracekernel-dispatch-curl "$@"\n' &&
        explicitCommandHelp.exitCode === 0 &&
        explicitCommandHelp.stdout.includes('Usage: curl [OPTIONS] URL'),
      `virtual bin shims should dispatch explicit paths through the same help contract: ${JSON.stringify({ commandMetadata, explicitCommandHelp })}`
    );

    const implicitStart = await workspace.runCommand('npm start');
    assertCondition(
      implicitStart.exitCode === 0 &&
        implicitStart.stdout === '\n> implicit-start@1.0.0 start\n> node server.js\n\nimplicit server ready\n',
      `npm start should preserve npm's implicit node server.js lifecycle: ${JSON.stringify(implicitStart)}`
    );
    assertTerminalFidelity(implicitStart, 'implicit npm start');

    const identity = await workspace.runCommand([
      'node',
      '-e',
      '"const fs=require(\'node:fs\'); const os=require(\'node:os\'); const kernel=JSON.parse(fs.readFileSync(\'/proc/kernel/info\',\'utf8\')); console.log([process.execPath,process.version,process.platform,process.arch,os.type(),os.platform(),os.arch(),os.release(),os.version(),os.userInfo().shell,kernel.host.osName].join(\'|\'))"',
    ].join(' '));
    const kernelVersion = workspace.kernel.info.version;
    assertCondition(
      identity.exitCode === 0 &&
        identity.stdout === `/usr/local/bin/node|v22.0.0|tracekernel|x64|tracekernel|tracekernel|x64|${kernelVersion}|${kernelVersion}|/bin/bash|tracekernel\n`,
      `Node process and os identity should report TraceKernel without inventing a host OS: ${JSON.stringify(identity)}`
    );

    const processIdentity = await workspace.runCommand([
      'node',
      '-e',
      '"const fs=require(\'node:fs\'); const status=fs.readFileSync(\'/proc/self/status\',\'utf8\'); const pid=Number(/^Pid:\\s+(\\d+)/m.exec(status)[1]); const ppid=Number(/^PPid:\\s+(\\d+)/m.exec(status)[1]); console.log(process.pid===pid,process.ppid===ppid,process.pid)"',
    ].join(' '));
    const [, , pidText] = processIdentity.stdout.trim().split(/\s+/);
    assertCondition(
      processIdentity.exitCode === 0 &&
        processIdentity.stdout.startsWith('true true ') &&
        Number(pidText) > 1,
      `Node process identity should match the active kernel process and /proc/self: ${JSON.stringify(processIdentity)}`
    );
    assertTerminalFidelity(processIdentity, 'Node kernel process identity');

    await workspace.deleteFile('package.json');
    const missingManifest = await workspace.runCommand('npm run');
    assertCondition(
      missingManifest.exitCode === 254 &&
        missingManifest.stderr.includes('npm error code ENOENT') &&
        missingManifest.stderr.includes("open '/workspace/package.json'") &&
        !missingManifest.stderr.includes('package.json not found from'),
      `missing package manifests should fail like npm rather than a harness parser: ${JSON.stringify(missingManifest)}`
    );
    assertTerminalFidelity(missingManifest, 'npm missing package.json');

    await workspace.writeFile('package.json', '{not json}\n');
    const invalidManifest = await workspace.runCommand('npm run');
    assertCondition(
      invalidManifest.exitCode === 1 && invalidManifest.stderr.includes('npm error code EJSONPARSE'),
      `invalid package manifests should use npm's EJSONPARSE surface: ${JSON.stringify(invalidManifest)}`
    );
    assertTerminalFidelity(invalidManifest, 'npm invalid package.json');
  } finally {
    workspace.dispose();
  }
}

async function testBrowserJavaScriptTerminalSurface(): Promise<void> {
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript'],
    nodeProject: {
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
    },
    externalHttp: {
      allowHttp: true,
      hosts: ['allowed.example'],
      fetch: async () => ({ status: 200, body: 'ok\n' }),
    },
    files: [
      {
        path: 'package.json',
        contents: JSON.stringify({
          name: 'terminal-fidelity',
          version: '1.0.0',
          scripts: { start: 'node server.js' },
        }, null, 2) + '\n',
      },
      { path: 'server.js', contents: 'console.log("server ready")\n' },
      { path: 'missing.js', contents: 'require("node:fs").readFileSync("missing.txt", "utf8")\n' },
      { path: 'module.js', contents: 'require("not-installed")\n' },
      { path: 'syntax.js', contents: 'const = 1\n' },
      {
        path: 'fetch.js',
        contents: [
          '(async () => {',
          '  try {',
          '    await fetch("https://blocked.example/data")',
          '  } catch (error) {',
          '    console.log(error.name + ": " + error.message)',
          '    console.log(error.cause.code)',
          '    console.log(error.cause.message)',
          '  }',
          '})()',
          '',
        ].join('\n'),
      },
      {
        path: 'https.js',
        contents: [
          'const https = require("node:https")',
          'https.get("https://blocked.example/data").on("error", (error) => {',
          '  console.log(error.code)',
          '  console.log(error.message)',
          '})',
          '',
        ].join('\n'),
      },
    ],
  });

  try {
    const npmStart = await workspace.runCommand('npm start');
    assertCondition(
      npmStart.exitCode === 0 &&
        npmStart.stdout.includes('> terminal-fidelity@1.0.0 start') &&
        npmStart.stdout.endsWith('server ready\n'),
      `npm start should look and behave like the native npm script path: ${JSON.stringify(npmStart)}`
    );
    assertTerminalFidelity(npmStart, 'npm start');

    const missing = await workspace.runCommand('node missing.js');
    assertCondition(
      missing.exitCode === 1 &&
        missing.stderr.includes('ENOENT') &&
        missing.stderr.includes('/workspace/missing.js') &&
        !missing.stderr.includes('/Users/'),
      `uncaught fs errors should preserve user diagnostics without host frames: ${JSON.stringify(missing)}`
    );
    assertTerminalFidelity(missing, 'uncaught fs error');

    const moduleMissing = await workspace.runCommand('node module.js');
    assertCondition(
      moduleMissing.exitCode === 1 &&
        moduleMissing.stderr.includes("Cannot find module 'not-installed'") &&
        moduleMissing.stderr.includes('/workspace/module.js'),
      `missing modules should use Node-shaped diagnostics: ${JSON.stringify(moduleMissing)}`
    );
    assertTerminalFidelity(moduleMissing, 'missing module');

    const syntax = await workspace.runCommand('node syntax.js');
    assertCondition(
      syntax.exitCode === 1 && syntax.stderr.includes('SyntaxError') && syntax.stderr.includes('/workspace/syntax.js'),
      `syntax failures should point at the workspace file: ${JSON.stringify(syntax)}`
    );
    assertTerminalFidelity(syntax, 'syntax error');

    const fetch = await workspace.runCommand('node fetch.js');
    assertCondition(
      fetch.exitCode === 0 &&
        fetch.stdout === [
          'TypeError: fetch failed',
          'EHOSTUNREACH',
          'connect EHOSTUNREACH blocked.example:443',
          '',
        ].join('\n'),
      `fetch should fail like Node transport rather than return a synthetic HTTP response: ${JSON.stringify(fetch)}`
    );
    assertTerminalFidelity(fetch, 'fetch policy failure');

    const https = await workspace.runCommand('node https.js');
    assertCondition(
      https.exitCode === 0 &&
        https.stdout === 'EHOSTUNREACH\nconnect EHOSTUNREACH blocked.example:443\n',
      `node:https should share Node-shaped transport errors with fetch: ${JSON.stringify(https)}`
    );
    assertTerminalFidelity(https, 'node:https policy failure');

    const curl = await workspace.runCommand('curl -sS http:80');
    assertCondition(
      curl.exitCode === 6 && curl.stderr === 'curl: (6) Could not resolve host: http\n',
      `curl authority parsing should match native curl: ${JSON.stringify(curl)}`
    );
    assertTerminalFidelity(curl, 'curl DNS failure');
  } finally {
    workspace.dispose();
  }
}

async function testInterruptedNpmStartTerminalTranscript(): Promise<void> {
  let serverStarted!: () => void;
  const serverStartedPromise = new Promise<void>((resolve) => {
    serverStarted = resolve;
  });
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript'],
    nodeProject: {
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
    },
    files: [
      {
        path: 'package.json',
        contents: JSON.stringify({
          name: 'checkout-service',
          version: '2.4.0',
          scripts: { start: 'node src/index.js' },
        }, null, 2) + '\n',
      },
      {
        path: 'src/index.js',
        contents: [
          'const http = require("node:http")',
          'const server = http.createServer((_request, response) => response.end("ok\\n"))',
          'server.listen(3000, "127.0.0.1", () => console.log("checkout-service listening on http://127.0.0.1:3000"))',
          '',
        ].join('\n'),
      },
    ],
  });

  try {
    const terminal = workspace.createTerminalSession();
    const streamedOutput = { stdout: '', stderr: '' };
    const run = terminal.run('npm start', {
      onEvent: (event) => {
        if (event.type !== 'output') return;
        streamedOutput[event.stream] += event.data;
        if (streamedOutput.stdout.includes('checkout-service listening')) serverStarted();
      },
    });
    await serverStartedPromise;
    assertCondition(terminal.interrupt(), 'Ctrl+C should signal the active npm process group.');
    const result = await run;
    const banner = '> checkout-service@2.4.0 start';
    const renderedStdout = result.stdout.startsWith(streamedOutput.stdout)
      ? `${streamedOutput.stdout}${result.stdout.slice(streamedOutput.stdout.length)}`
      : `${streamedOutput.stdout}${result.stdout}`;

    assertCondition(
      result.exitCode === 130 &&
        result.error?.detail?.signal === 'SIGINT' &&
        result.stderr === '' &&
        result.stdout === streamedOutput.stdout &&
        result.stdout.includes('checkout-service listening on http://127.0.0.1:3000'),
      `interrupted npm start should return the complete streamed transcript once: ${JSON.stringify({ result, streamedOutput })}`
    );
    assertCondition(
      renderedStdout.split(banner).length - 1 === 1 && !renderedStdout.includes('Execution aborted'),
      `Ctrl+C should not replay npm output or expose an adapter abort: ${JSON.stringify(renderedStdout)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testInteractiveTerminalContract(): Promise<void> {
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript'],
    nodeProject: {
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
    },
    files: [
      {
        path: 'read-stdin.js',
        contents: [
          'let body = ""',
          'process.stdin.on("data", (chunk) => { body += chunk })',
          'process.stdin.on("end", () => console.log("eof:" + body))',
          '',
        ].join('\n'),
      },
      {
        path: 'graceful-server.js',
        contents: [
          'const http = require("node:http")',
          'const server = http.createServer((_request, response) => response.end("ok\\n"))',
          'server.listen(3010, "127.0.0.1", () => console.log("graceful-ready"))',
          'process.on("SIGINT", () => server.close(() => console.log("graceful-closed")))',
          '',
        ].join('\n'),
      },
      {
        path: 'node-tool',
        contents: '#!/usr/bin/env node\nconsole.log("node-shebang:" + process.argv.slice(2).join(","))\n',
      },
      {
        path: 'shell-tool',
        contents: '#!/bin/sh\nprintf "shell-shebang:%s\\n" "$*"\n',
      },
      {
        path: 'plain-tool',
        contents: 'printf "shell-fallback:%s\\n" "$*"\n',
      },
      {
        path: 'missing-tool',
        contents: '#!/missing/interpreter\nprintf "should-not-run\\n"\n',
      },
    ],
  });

  try {
    const controlEvents: Array<{ action: string; exitCode?: number }> = [];
    const terminal = workspace.createTerminalSession({
      columns: 132,
      rows: 41,
      onTerminalEvent: (event) => {
        if (event.type === 'control') controlEvents.push(event);
      },
    });
    const otherTerminal = workspace.createTerminalSession();

    const identity = await terminal.run('printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" "$USER" "$LOGNAME" "$HOME" "$HOSTNAME" "$SHELL" "$TMPDIR" "$TERM" "$OSTYPE" "$MACHTYPE" "$HOSTTYPE"; whoami; id; hostname; uname -a');
    assertCondition(
      identity.exitCode === 0 &&
        identity.stdout.startsWith('user|user|/home/user|tracevm|/bin/bash|/tmp|dumb|tracekernel|wasm32-tracekernel|wasm32\nuser\nuid=1000(user) gid=1000(user) groups=1000(user)\ntracevm\nTraceKernel tracevm ') &&
        identity.stdout.includes(' wasm32 wasm32 wasm32 TraceKernel\n') &&
        !identity.stdout.includes('Linux'),
      `the prompt, environment, and discovery commands should describe one TraceKernel identity: ${JSON.stringify(identity)}`
    );

    const terminalShape = await terminal.run("node -e \"console.log([process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY,process.stdout.columns,process.stdout.rows,process.env.TERM,process.env.NO_COLOR].join('|'))\"");
    const capturedShape = await workspace.runCommand("node -e \"console.log([process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY].join('|'))\"");
    assertCondition(
      terminalShape.stdout === 'true|true|true|132|41|dumb|1\n' &&
        capturedShape.stdout === 'false|false|false\n',
      `runtimes should distinguish an attached terminal from captured programmatic execution: ${JSON.stringify({ terminalShape, capturedShape })}`
    );
    terminal.resize(96, 30);
    const resizedShape = await terminal.run("node -e \"console.log(process.stdout.columns + 'x' + process.stdout.rows + '|' + process.env.COLUMNS + 'x' + process.env.LINES)\"");
    assertCondition(
      resizedShape.stdout === '96x30|96x30\n',
      `terminal dimensions should update for subsequent commands: ${JSON.stringify(resizedShape)}`
    );
    const terminalDiscovery = await terminal.run('stty size; tput cols; tput lines; tput colors; man stty');
    const capturedStty = await workspace.runCommand('stty size');
    assertCondition(
      terminalDiscovery.exitCode === 0 &&
        terminalDiscovery.stdout.startsWith('30 96\n96\n30\n-1\nstty - inspect terminal line settings\n') &&
        capturedStty.exitCode === 1 && capturedStty.stderr.includes('Inappropriate ioctl for device'),
      `terminal capability discovery should reflect the attached session without pretending captured commands have a TTY: ${JSON.stringify({ terminalDiscovery, capturedStty })}`
    );

    const terminalIdentity = await terminal.run('tty; tty -s; test -t 0; [ -t 1 ]; test ! -t 9; locale charmap; getconf OPEN_MAX; groups; getent passwd user; getent hosts localhost');
    const capturedTty = await workspace.runCommand('tty');
    const capturedTtyTest = await workspace.runCommand('test -t 0; printf "%s" $?');
    assertCondition(
      terminalIdentity.exitCode === 0 &&
        terminalIdentity.stdout === '/dev/tty\nUTF-8\n1024\nuser\nuser:x:1000:1000:TraceKernel user:/home/user:/bin/bash\n127.0.0.1 localhost\n' &&
        capturedTty.exitCode === 1 && capturedTty.stdout === 'not a tty\n' &&
        capturedTtyTest.exitCode === 0 && capturedTtyTest.stdout === '1',
      `terminal and identity discovery should report the attached TraceKernel environment truthfully: ${JSON.stringify({ terminalIdentity, capturedTty, capturedTtyTest })}`
    );
    const identityFiles = await terminal.run("cat /etc/os-release; cat /etc/hostname; cat /etc/passwd");
    const runtimeIdentityFiles = await terminal.run("node -e \"const fs=require('node:fs');console.log(fs.readFileSync('/etc/hostname','utf8').trim());try{fs.writeFileSync('/etc/hostname','other')}catch(error){console.log(error.code)}\"");
    const refusedIdentityMutation = await terminal.run('printf other > /etc/hostname');
    const identityDirectory = await workspace.readDir('/etc');
    const passwdStat = await workspace.stat('/etc/passwd');
    assertCondition(
      identityFiles.exitCode === 0 &&
        identityFiles.stdout.includes('NAME=\"TraceKernel\"\nID=tracekernel\n') &&
        identityFiles.stdout.includes('\ntracevm\nroot:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:TraceKernel user:/home/user:/bin/bash\n') &&
        runtimeIdentityFiles.exitCode === 0 && runtimeIdentityFiles.stdout === 'tracevm\nEROFS\n' &&
        refusedIdentityMutation.exitCode !== 0 && refusedIdentityMutation.stderr.includes('read-only file system') &&
        identityDirectory.join(',') === 'group,hostname,hosts,nsswitch.conf,os-release,passwd,shells' &&
        passwdStat.isFile && passwdStat.mode === 0o644 && passwdStat.uid === 0 && passwdStat.gid === 0,
      `standard identity files should expose the same read-only TraceKernel identity in the shell, workspace, and browser runtimes: ${JSON.stringify({ identityFiles, runtimeIdentityFiles, refusedIdentityMutation, identityDirectory, passwdStat })}`
    );
    const commandDiscovery = await terminal.run('type ls; type df; command -v ls; command -V df; which df');
    assertCondition(
      commandDiscovery.exitCode === 0 && commandDiscovery.stdout === [
        'ls is /tracekernel/bin/ls',
        'df is /tracekernel/bin/df',
        '/tracekernel/bin/ls',
        'df is /tracekernel/bin/df',
        '/tracekernel/bin/df',
        '',
      ].join('\n'),
      `shell discovery surfaces should agree on TraceKernel command paths: ${JSON.stringify(commandDiscovery)}`
    );

    const initialUmask = await terminal.run('umask');
    const privateCreation = await terminal.run('umask 077; touch private-file; mkdir private-dir; umask -S');
    const persistedUmask = await terminal.run('umask');
    const capturedUmask = await workspace.runCommand('umask');
    const privateFile = await workspace.stat('private-file');
    const privateDirectory = await workspace.stat('private-dir');
    const symbolicUmask = await terminal.run('umask u=rwx,g=rx,o=; umask -p; umask -S');
    assertCondition(
      initialUmask.stdout === '0022\n' &&
        privateCreation.exitCode === 0 && privateCreation.stdout === 'u=rwx,g=,o=\n' &&
        persistedUmask.stdout === '0077\n' && capturedUmask.stdout === '0022\n' &&
        (privateFile.mode! & 0o777) === 0o600 && (privateDirectory.mode! & 0o777) === 0o700 &&
        symbolicUmask.exitCode === 0 && symbolicUmask.stdout === 'umask 0027\nu=rwx,g=rx,o=\n',
      `umask should persist within a terminal, accept shell-shaped symbolic modes, and govern file and directory creation modes: ${JSON.stringify({ initialUmask, privateCreation, persistedUmask, capturedUmask, privateFile, privateDirectory, symbolicUmask })}`
    );
    const filesystemUsage = await terminal.run('df -k .; df -h .; df -i .');
    const nodeFilesystemUsage = await terminal.run("node -e \"const s=require('node:fs').statfsSync('.'); console.log((s.blocks*s.bsize)+'|'+s.files)\"");
    assertCondition(
      filesystemUsage.exitCode === 0 &&
        filesystemUsage.stdout.includes('Filesystem 1K-blocks Used Available Use% Mounted on\ntracekernel ') &&
        filesystemUsage.stdout.includes('Filesystem Size Used Available Use% Mounted on\ntracekernel ') &&
        filesystemUsage.stdout.includes('Filesystem Inodes IUsed IFree IUse% Mounted on\ntracekernel ') &&
        nodeFilesystemUsage.exitCode === 0 && nodeFilesystemUsage.stdout === '67108864|10000\n',
      `df and browser Node statfs should expose one workspace quota ledger: ${JSON.stringify({ filesystemUsage, nodeFilesystemUsage })}`
    );
    const mountTopology = await terminal.run('mount; cat /proc/mounts; cat /proc/self/mountinfo');
    const temporaryMountModes = await terminal.run("stat -c '%a' /tmp /var/tmp");
    const refusedMount = await terminal.run('mount none /tmp');
    const refusedSystemWrite = await terminal.run('printf bad > /system-file');
    assertCondition(
      mountTopology.exitCode === 0 &&
        mountTopology.stdout.includes('tracekernel:system on / type tracefs (ro,relatime)\n') &&
        mountTopology.stdout.includes('tracekernel:tmp on /tmp type tracefs (rw,nosuid,nodev)\n') &&
        mountTopology.stdout.includes('tracekernel:var-tmp on /var/tmp type tracefs (rw,nosuid,nodev)\n') &&
        mountTopology.stdout.includes('tracekernel:workspace on /workspace type tracefs (rw,relatime)\n') &&
        mountTopology.stdout.includes('tracekernel:proc on /proc type traceproc (ro,nosuid,nodev,noexec)\n') &&
        mountTopology.stdout.includes('tracekernel:skills /skills tracefs ro,nosuid,nodev,noexec 0 0\n') &&
        mountTopology.stdout.includes('26 20 0:3 / /proc ro,nosuid,nodev,noexec - traceproc tracekernel:proc ro\n') &&
        temporaryMountModes.exitCode === 0 && temporaryMountModes.stdout === '1777\n1777\n' &&
        refusedMount.exitCode === 32 && refusedMount.stderr.includes('filesystem topology is fixed') &&
        refusedSystemWrite.exitCode !== 0 && refusedSystemWrite.stderr.includes('read-only file system'),
      `mount, /proc/mounts, and mountinfo should expose and enforce one immutable TraceKernel topology: ${JSON.stringify({ mountTopology, temporaryMountModes, refusedMount, refusedSystemWrite })}`
    );
    const entryUsage = await terminal.run("mkdir -p usage/nested; printf abc > usage/a; printf 12345 > usage/nested/b; du -ba usage; du -sk usage");
    assertCondition(
      entryUsage.exitCode === 0 && entryUsage.stdout === [
        '3\tusage/a',
        '5\tusage/nested/b',
        '5\tusage/nested',
        '8\tusage',
        '1\tusage',
        '',
      ].join('\n'),
      `du should report logical file and directory usage with common project-script flags: ${JSON.stringify(entryUsage)}`
    );
    const metadataSetup = await terminal.run('printf metadata > mode-file; chmod 640 mode-file');
    const nodeReadMetadata = await terminal.run("node -e \"const fs=require('node:fs');const s=fs.statSync('mode-file');console.log((s.mode&511).toString(8)+'|'+s.uid+'|'+s.gid);fs.chmodSync('mode-file',0o600);fs.utimesSync('mode-file',new Date(1700000000000),new Date(1700000005000))\"");
    const persistedMetadata = await workspace.stat('mode-file');
    assertCondition(
      metadataSetup.exitCode === 0 &&
        nodeReadMetadata.exitCode === 0 && nodeReadMetadata.stdout === '640|1000|1000\n' &&
        (persistedMetadata.mode! & 0o777) === 0o600 &&
        persistedMetadata.mtimeMs === 1700000005000,
      `browser runtimes should receive and persist file permissions and timestamps instead of resetting metadata per command: ${JSON.stringify({ nodeReadMetadata, persistedMetadata })}`
    );
    const statMetadata = await terminal.run("ln -s mode-file mode-link; stat -c '%F|%a|%Y|%y|%U|%G' mode-file; stat -c '%F|%N' mode-link; stat -L -c '%F|%N' mode-link");
    assertCondition(
      statMetadata.exitCode === 0 && statMetadata.stdout === [
        'regular file|600|1700000005|2023-11-14 22:13:25.000 +0000|user|user',
        "symbolic link|'mode-link' -> 'mode-file'",
        "regular file|'mode-link'",
        '',
      ].join('\n'),
      `stat should expose useful GNU-style metadata fields and distinguish lstat from dereference: ${JSON.stringify(statMetadata)}`
    );

    const scriptExecution = await terminal.run('chmod +x node-tool shell-tool plain-tool missing-tool; ./node-tool one two; ./shell-tool three four; ./plain-tool five; ./missing-tool');
    assertCondition(
      scriptExecution.exitCode === 127 &&
        scriptExecution.stdout === 'node-shebang:one,two\nshell-shebang:three four\nshell-fallback:five\n' &&
        scriptExecution.stderr === 'bash: ./missing-tool: cannot execute: required file not found\n',
      `workspace executables should honor supported shebangs, preserve shell fallback, and reject missing interpreters: ${JSON.stringify(scriptExecution)}`
    );

    const signals = await terminal.run('kill -l; kill -l 15; kill -l TERM');
    assertCondition(
      signals.exitCode === 0 && signals.stdout.includes('15) TERM') && signals.stdout.endsWith('TERM\n15\n'),
      `kill should expose and translate the signals TraceKernel actually supports: ${JSON.stringify(signals)}`
    );

    const descriptorAliases = await workspace.runCommand(
      "node -e \"const fs=require('node:fs'); const input=fs.readFileSync('/dev/fd/0','utf8'); fs.writeFileSync('/dev/fd/1','out:' + input); fs.writeFileSync('/dev/fd/2','err:' + input)\"",
      { stdinPipe: createRuntimeCommandStdinPipeFromText('descriptor\n') }
    );
    assertCondition(
      descriptorAliases.exitCode === 0 && descriptorAliases.stdout === 'out:descriptor\n' && descriptorAliases.stderr === 'err:descriptor\n',
      `standard descriptor aliases should route through the command's real stdin, stdout, and stderr: ${JSON.stringify(descriptorAliases)}`
    );

    const pipeline = await terminal.run("printf 'beta\\nalpha\\nalpha\\n' | sort | uniq -c > counts.txt; cat counts.txt");
    assertCondition(
      pipeline.exitCode === 0 && pipeline.stdout.includes('alpha') && pipeline.stdout.includes('beta'),
      `pipes and redirects should compose in a browser terminal: ${JSON.stringify(pipeline)}`
    );
    const status = await terminal.run('false; printf "status=%s\\n" "$?"');
    assertCondition(
      status.exitCode === 0 && status.stdout === 'status=1\n',
      `shell status expansion should preserve the prior exit code: ${JSON.stringify(status)}`
    );

    await terminal.run('export TRACE_PROJECT_TOKEN=terminal-one; mkdir -p nested');
    const changedDirectory = await terminal.run('cd nested');
    const persistent = await terminal.run('printf "%s|%s\\n" "$TRACE_PROJECT_TOKEN" "$PWD"');
    const isolated = await otherTerminal.run('printf "%s|%s\\n" "${TRACE_PROJECT_TOKEN:-unset}" "$PWD"');
    assertCondition(
      persistent.stdout === 'terminal-one|/workspace/nested\n' && isolated.stdout === 'unset|/workspace\n',
      `cwd and environment should persist per terminal without leaking across sessions: ${JSON.stringify({ changedDirectory, cwd: terminal.cwd, persistent, isolated })}`
    );

    const stdinRun = terminal.run('node ../read-stdin.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertCondition(terminal.writeStdin('hello\n'), 'a running process should accept stdin');
    assertCondition(terminal.endStdin(), 'Ctrl+D should close the running process stdin');
    assertCondition(!terminal.endStdin(), 'repeated Ctrl+D should not report a second EOF delivery');
    assertCondition(!terminal.writeStdin('late input\n'), 'stdin writes should be rejected after EOF');
    const stdinResult = await stdinRun;
    assertCondition(
      stdinResult.exitCode === 0 && stdinResult.stdout === 'eof:hello\n\n',
      `stdin EOF should let the process finish naturally: ${JSON.stringify(stdinResult)}`
    );

    const clear = await terminal.run('clear');
    assertCondition(
      clear.exitCode === 0 && controlEvents.some((event) => event.action === 'clear'),
      `clear should use the terminal control channel: ${JSON.stringify({ clear, controlEvents })}`
    );

    const history = await terminal.run('history 3');
    assertCondition(
      history.stdout.includes('node ../read-stdin.js') && history.stdout.trimEnd().endsWith('history 3') && terminal.history.at(-1) === 'history 3',
      `terminal history should be owned by the session and exposed to host UIs: ${JSON.stringify({ history, entries: terminal.history.slice(-3) })}`
    );

    let gracefulReady!: () => void;
    const gracefulReadyPromise = new Promise<void>((resolve) => { gracefulReady = resolve; });
    const gracefulTerminal = workspace.createTerminalSession();
    const gracefulRun = gracefulTerminal.run('node graceful-server.js', {
      onEvent: (event) => {
        if (event.type === 'output' && event.stream === 'stdout' && event.data.includes('graceful-ready')) gracefulReady();
      },
    });
    await gracefulReadyPromise;
    assertCondition(gracefulTerminal.interrupt(), 'Ctrl+C should deliver SIGINT to the foreground runtime');
    const gracefulResult = await gracefulRun;
    assertCondition(
      gracefulResult.exitCode === 0 && gracefulResult.error === undefined && gracefulResult.stdout.includes('graceful-closed'),
      `a runtime signal handler should be allowed to close resources and finish naturally: ${JSON.stringify(gracefulResult)}`
    );

    const background = await otherTerminal.run('sleep 30 &');
    const jobs = await otherTerminal.run('jobs -l');
    const sleeping = await otherTerminal.run('pgrep -x sleep');
    const sleepingExists = await otherTerminal.run('kill -0 $(pgrep -x sleep)');
    assertCondition(
      background.exitCode === 0 && jobs.exitCode === 0 && jobs.stdout.includes('sleep 30') &&
        sleeping.exitCode === 0 && /^\d+\n$/.test(sleeping.stdout) && sleepingExists.exitCode === 0,
      `background jobs should remain inspectable and support signal-zero existence probes after the prompt returns: ${JSON.stringify({ background, jobs, sleeping, sleepingExists })}`
    );
    const stopped = await otherTerminal.run('pkill -x sleep; wait');
    const noSleepingProcess = await otherTerminal.run('pgrep -x sleep');
    assertCondition(
      stopped.exitCode === 0 && noSleepingProcess.exitCode === 1,
      `background jobs should be signalable and reapable from their shell: ${JSON.stringify({ stopped, noSleepingProcess })}`
    );
    await otherTerminal.run('sleep 300 &');
    const combinedPkill = await otherTerminal.run("pkill -fx 'sleep 300'");
    assertCondition(
      combinedPkill.exitCode === 0,
      `pkill should compose full-command and exact-match short flags: ${JSON.stringify(combinedPkill)}`
    );
    await otherTerminal.run('wait');
    const combinedPkillMissing = await otherTerminal.run("pgrep -fx 'sleep 300'");
    assertCondition(
      combinedPkillMissing.exitCode === 1,
      `the combined pkill match should be gone after wait: ${JSON.stringify(combinedPkillMissing)}`
    );

    const invalidExitTerminal = workspace.createTerminalSession();
    const invalidExit = await invalidExitTerminal.run('exit not-a-number');
    assertCondition(
      invalidExit.exitCode === 2 && invalidExitTerminal.closed &&
        invalidExit.stderr === 'exit: not-a-number: numeric argument required\n',
      `a numeric exit error should still terminate its shell session: ${JSON.stringify(invalidExit)}`
    );
    const tooManyExitTerminal = workspace.createTerminalSession();
    const tooManyExit = await tooManyExitTerminal.run('exit 1 2');
    const aliveAfterTooMany = await tooManyExitTerminal.run('pwd');
    assertCondition(
      tooManyExit.exitCode === 1 && !tooManyExitTerminal.closed && aliveAfterTooMany.exitCode === 0,
      `exit with too many arguments should reject the command without closing the shell: ${JSON.stringify({ tooManyExit, aliveAfterTooMany })}`
    );
    const overflowingExitTerminal = workspace.createTerminalSession();
    const overflowingExit = await overflowingExitTerminal.run('exit 9223372036854775808');
    assertCondition(
      overflowingExit.exitCode === 2 && overflowingExitTerminal.closed &&
        overflowingExit.stderr.includes('numeric argument required'),
      `out-of-range exit values should not lose precision or remain interactive: ${JSON.stringify(overflowingExit)}`
    );
    const compoundExitTerminal = workspace.createTerminalSession();
    const compoundExit = await compoundExitTerminal.run('printf before-exit; exit 9; printf after-exit');
    assertCondition(
      compoundExit.exitCode === 9 && compoundExit.stdout === 'before-exit' && compoundExitTerminal.closed,
      `exit inside a command list should close the shell and stop later statements: ${JSON.stringify(compoundExit)}`
    );

    const exit = await terminal.run('exit 7');
    const afterExit = await terminal.run('pwd');
    assertCondition(
      exit.exitCode === 7 && terminal.closed &&
        controlEvents.some((event) => event.action === 'exit' && event.exitCode === 7) &&
        afterExit.error?.code === 'EBADF',
      `exit should close only its terminal session: ${JSON.stringify({ exit, afterExit, controlEvents })}`
    );
    const otherStillWorks = await otherTerminal.run('pwd');
    assertCondition(
      otherStillWorks.exitCode === 0 && otherStillWorks.stdout === '/workspace\n',
      `exiting one session must not close another terminal: ${JSON.stringify(otherStillWorks)}`
    );
  } finally {
    workspace.dispose();
  }
}

async function testBrowserProcessAndNetworkInspection(): Promise<void> {
  let serverStarted!: () => void;
  const serverStartedPromise = new Promise<void>((resolve) => { serverStarted = resolve; });
  let secondServerStarted!: () => void;
  const secondServerStartedPromise = new Promise<void>((resolve) => { secondServerStarted = resolve; });
  const workspace = await createBrowserProjectWorkspace({
    providers: ['javascript'],
    nodeProject: {
      allowMainThreadExecution: true,
      trustedMainThreadExecution: true,
    },
    files: [{
      path: 'server.js',
      contents: [
        'const http = require("node:http")',
        'http.createServer((_req, res) => {',
        '  if (_req.url === "/redirect") {',
        '    res.writeHead(302, { location: "/", "content-type": "text/plain" })',
        '    res.end("redirecting\\n")',
        '    return',
        '  }',
        '  if (_req.url === "/loop") {',
        '    res.writeHead(302, { location: "/loop" })',
        '    res.end("loop\\n")',
        '    return',
        '  }',
        '  if (_req.url === "/cross-origin") {',
        '    res.writeHead(302, { location: "http://127.0.0.1:3001/" })',
        '    res.end("cross-origin\\n")',
        '    return',
        '  }',
        '  const status = _req.url === "/not-found" ? 404 : 200',
        '  res.writeHead(status, { "content-type": "application/json", "x-request-method": _req.method })',
        '  res.end(JSON.stringify(status === 200 ? { ok: true } : { error: "missing" }) + "\\n")',
        '}).listen(3000, "127.0.0.1", () => console.log("ready"))',
        '',
      ].join('\n'),
    }, {
      path: 'server2.js',
      contents: [
        'const http = require("node:http")',
        'http.createServer((req, res) => {',
        '  res.writeHead(200, { "content-type": "text/plain" })',
        '  res.end("authorization=" + (req.headers.authorization || "none") + "\\n")',
        '}).listen(3001, "127.0.0.1", () => console.log("ready2"))',
        '',
      ].join('\n'),
    }],
  });

  try {
    const serverTerminal = workspace.createTerminalSession();
    const secondServerTerminal = workspace.createTerminalSession();
    const inspectionTerminal = workspace.createTerminalSession();
    const serverRun = serverTerminal.run('node server.js', {
      onEvent: (event) => {
        if (event.type === 'output' && event.stream === 'stdout' && event.data.includes('ready')) serverStarted();
      },
    });
    await serverStartedPromise;
    const secondServerRun = secondServerTerminal.run('node server2.js', {
      onEvent: (event) => {
        if (event.type === 'output' && event.stream === 'stdout' && event.data.includes('ready2')) secondServerStarted();
      },
    });
    await secondServerStartedPromise;

    const duplicate = await inspectionTerminal.run('node server.js');
    assertCondition(
      duplicate.exitCode === 1 && duplicate.stderr.includes('EADDRINUSE: address already in use 127.0.0.1:3000'),
      `duplicate listeners should fail with the native address error: ${JSON.stringify(duplicate)}`
    );
    assertTerminalFidelity(duplicate, 'duplicate listener');

    const ss = await inspectionTerminal.run('ss -ltnp');
    const splitSs = await inspectionTerminal.run('ss -l -t -n -p');
    const lsof = await inspectionTerminal.run('lsof -i :3000');
    const pgrep = await inspectionTerminal.run('pgrep -af "node server.js"');
    const ps = await inspectionTerminal.run('ps aux');
    const malformedPgrep = await inspectionTerminal.run("pgrep '['");
    const protectedPkill = await inspectionTerminal.run('pkill -x tracekernel');
    assertCondition(
      ss.exitCode === 0 && ss.stdout.includes('127.0.0.1:3000') && ss.stdout.includes('pid='),
      `ss should expose the owning listener process: ${JSON.stringify(ss)}`
    );
    assertCondition(
      splitSs.exitCode === 0 && splitSs.stdout.includes('127.0.0.1:3000') && splitSs.stdout.includes('pid='),
      `ss should accept conventional split flag groups: ${JSON.stringify(splitSs)}`
    );
    assertCondition(
      lsof.exitCode === 0 && lsof.stdout.includes('TCP 127.0.0.1:3000 (LISTEN)'),
      `lsof should expose the listener with native-shaped columns: ${JSON.stringify(lsof)}`
    );
    assertCondition(
      pgrep.exitCode === 0 && pgrep.stdout.includes('node server.js'),
      `pgrep should find a process by full command: ${JSON.stringify(pgrep)}`
    );
    assertCondition(
      ps.exitCode === 0 && ps.stdout.startsWith('USER       PID %CPU %MEM') && ps.stdout.includes('node server.js'),
      `ps aux should expose useful process columns and commands: ${JSON.stringify(ps)}`
    );
    assertCondition(
      malformedPgrep.exitCode === 2 && malformedPgrep.stderr.includes('invalid regular expression') &&
        protectedPkill.exitCode === 1 && protectedPkill.stderr.includes('Operation not permitted'),
      `process matching should fail safely for malformed patterns and protected processes: ${JSON.stringify({ malformedPgrep, protectedPkill })}`
    );

    const curl = await inspectionTerminal.run("curl -fsS -o /dev/null -w '%{http_code} %{content_type} %{size_download}\\n' http://127.0.0.1:3000/");
    assertCondition(
      curl.exitCode === 0 && curl.stdout === '200 application/json 12\n',
      `common curl flags should compose like the native CLI: ${JSON.stringify(curl)}`
    );
    const wgetStdout = await inspectionTerminal.run('wget -qO- http://127.0.0.1:3000/');
    const wgetFile = await inspectionTerminal.run('wget -q http://127.0.0.1:3000/artifact.json');
    assertCondition(
      wgetStdout.exitCode === 0 && wgetStdout.stdout === '{"ok":true}\n' &&
        wgetFile.exitCode === 0 && await workspace.readFile('artifact.json') === '{"ok":true}\n',
      `wget should use the kernel HTTP transport for stdout and file downloads: ${JSON.stringify({ wgetStdout, wgetFile })}`
    );

    const combinedHead = await inspectionTerminal.run('curl -sSIL http://127.0.0.1:3000/');
    assertCondition(
      combinedHead.exitCode === 0 && combinedHead.stdout.includes('x-request-method: HEAD') &&
        !combinedHead.stdout.includes('{"ok":true}'),
      `combined curl flags should preserve HEAD semantics: ${JSON.stringify(combinedHead)}`
    );
    const silentFailure = await inspectionTerminal.run('curl -s http://missing.invalid/');
    const shownFailure = await inspectionTerminal.run('curl -sS http://missing.invalid/');
    assertCondition(
      silentFailure.exitCode !== 0 && silentFailure.stderr === '' &&
        shownFailure.exitCode === silentFailure.exitCode && shownFailure.stderr.includes('curl:'),
      `curl -s should suppress transfer errors while -sS restores them: ${JSON.stringify({ silentFailure, shownFailure })}`
    );
    const silentHttpFailure = await inspectionTerminal.run('curl -sf http://127.0.0.1:3000/not-found');
    const failedWithBody = await inspectionTerminal.run('curl -sS --fail-with-body http://127.0.0.1:3000/not-found');
    assertCondition(
      silentHttpFailure.exitCode === 22 && silentHttpFailure.stdout === '' && silentHttpFailure.stderr === '' &&
        failedWithBody.exitCode === 22 && failedWithBody.stdout === '{"error":"missing"}\n' &&
        failedWithBody.stderr.includes('curl: (22)'),
      `curl HTTP failure flags should keep their output and silence contracts: ${JSON.stringify({ silentHttpFailure, failedWithBody })}`
    );
    const noFollow = await inspectionTerminal.run('curl -sS http://127.0.0.1:3000/redirect');
    const followed = await inspectionTerminal.run('curl -sSL http://127.0.0.1:3000/redirect');
    assertCondition(
      noFollow.exitCode === 0 && noFollow.stdout === 'redirecting\n' &&
        followed.exitCode === 0 && followed.stdout === '{"ok":true}\n',
      `curl -L should follow redirects rather than act as a no-op: ${JSON.stringify({ noFollow, followed })}`
    );
    const missingOutputDirectory = await inspectionTerminal.run('curl -sS -o missing/output.json http://127.0.0.1:3000/');
    assertCondition(
      missingOutputDirectory.exitCode === 23 && !(await workspace.exists('missing')),
      `curl -o should not invent missing parent directories: ${JSON.stringify(missingOutputDirectory)}`
    );
    const redirectLoop = await inspectionTerminal.run('curl -sSL http://127.0.0.1:3000/loop');
    const crossOriginCredential = await inspectionTerminal.run(
      "curl -sSL -H 'Authorization: Bearer should-not-forward' http://127.0.0.1:3000/cross-origin"
    );
    assertCondition(
      redirectLoop.exitCode === 47 && redirectLoop.stderr.includes('Maximum (20) redirects followed') &&
        crossOriginCredential.exitCode === 0 && crossOriginCredential.stdout === 'authorization=none\n',
      `redirect loops should stop and cross-origin redirects should drop credentials: ${JSON.stringify({ redirectLoop, crossOriginCredential })}`
    );

    const malformedCommands: RuntimeCommandResult[] = [];
    for (const command of [
      'ss -l unexpected',
      'lsof -i :not-a-port',
      'pgrep',
      'pkill -NOPE anything',
      'ps --definitely-invalid',
      'curl --definitely-invalid',
      'curl',
    ]) malformedCommands.push(await inspectionTerminal.run(command));
    assertCondition(
      malformedCommands.every((result) => result.exitCode !== 0 && result.stderr.length > 0),
      `malformed diagnostic commands should fail promptly with user-facing usage errors: ${JSON.stringify(malformedCommands)}`
    );

    const killed = await inspectionTerminal.run('pkill -f "node server.js"');
    const serverResult = await serverRun;
    assertCondition(
      killed.exitCode === 0 && serverResult.exitCode === 143 && serverResult.error?.detail?.signal === 'SIGTERM',
      `pkill should signal the matched process instead of fabricating command output: ${JSON.stringify({ killed, serverResult })}`
    );
    await inspectionTerminal.run('wait');
    const missing = await inspectionTerminal.run('pgrep -f "node server.js"');
    assertCondition(missing.exitCode === 1 && missing.stdout === '', 'pgrep should return 1 when no process matches');
    assertCondition(secondServerTerminal.interrupt(), 'the second server should remain independently interruptible');
    const secondServerResult = await secondServerRun;
    assertCondition(secondServerResult.exitCode === 130, 'the second listener should stop with SIGINT');
  } finally {
    workspace.dispose();
  }
}

async function testBrowserWorkerFailureBoundary(): Promise<void> {
  const project = { cwd: '/workspace', files: [] };
  const cases = [
    {
      label: 'Python',
      diagnostic: 'Python worker emitted an error event at blob:internal',
      run: (onEvent: (event: RuntimeCommandEvent) => void) => createBrowserPythonProjectRunner({
        async executeProjectPython() { throw new Error('Python worker emitted an error event at blob:internal'); },
      })({ code: '', source: 'file', scriptPath: 'main.py', args: [], cwd: '/workspace', env: {}, project, onEvent }),
    },
    {
      label: 'Java',
      diagnostic: 'Java worker emitted an error event at /Users/host/java-worker.js',
      run: (onEvent: (event: RuntimeCommandEvent) => void) => createBrowserJavaProjectRunner({
        async executeProjectJava() { throw new Error('Java worker emitted an error event at /Users/host/java-worker.js'); },
      })({ code: '', source: 'run', scriptPath: 'Main.java', args: [], cwd: '/workspace', env: {}, project, onEvent }),
    },
    {
      label: 'C#',
      diagnostic: 'C# execution host crashed at blob:internal',
      run: (onEvent: (event: RuntimeCommandEvent) => void) => createBrowserCSharpProjectRunner({
        async executeProjectCSharp() { throw new Error('C# execution host crashed at blob:internal'); },
      })({ code: '', source: 'run', scriptPath: 'App.csproj', args: [], cwd: '/workspace', env: {}, project, onEvent }),
    },
    {
      label: 'C++',
      diagnostic: 'C++ compiler worker crashed in /packages/harness-cpp',
      run: (onEvent: (event: RuntimeCommandEvent) => void) => createBrowserCppProjectRunner({
        async executeProjectCpp() { throw new Error('C++ compiler worker crashed in /packages/harness-cpp'); },
      })({ code: '', source: 'run', scriptPath: 'app', args: [], cwd: '/workspace', env: {}, project, onEvent }),
    },
  ];

  for (const entry of cases) {
    const events: RuntimeCommandEvent[] = [];
    const result = await entry.run((event) => events.push(event));
    assertCondition(
      result.exitCode === 137 &&
        result.stderr === '' &&
        result.error?.code === 'EIO' &&
        result.error.detail?.diagnostic === entry.diagnostic,
      `${entry.label} infrastructure failure should terminate without becoming program stderr: ${JSON.stringify(result)}`
    );
    assertCondition(
      !events.some((event) => event.type === 'output' && event.stream === 'stderr') &&
        events.some((event) =>
          event.type === 'status' &&
          (event.phase === 'process-exit' || event.phase === 'compile-end') &&
          event.detail?.exitCode === 137 &&
          event.detail?.diagnostic === entry.diagnostic
        ),
      `${entry.label} infrastructure diagnostics should remain in status metadata: ${JSON.stringify(events)}`
    );
    assertTerminalFidelity(result, `${entry.label} worker crash`);
  }

  const timeout = await createBrowserCppProjectRunner({
    async executeProjectCpp() { throw new Error('C++ worker request timed out'); },
  })({ code: '', source: 'run', scriptPath: 'app', args: [], cwd: '/workspace', env: {}, project });
  assertCondition(
    timeout.exitCode === 124 && timeout.stderr === '' && timeout.error?.code === 'ETIMEDOUT',
    `worker timeouts should return a timeout status without raw bridge stderr: ${JSON.stringify(timeout)}`
  );
  assertTerminalFidelity(timeout, 'worker timeout');
}

async function testPatchedJustBashCompatibility(): Promise<void> {
  const workspace = await createBrowserProjectWorkspace({
    providers: [],
    files: [
      { path: 'existing', contents: 'content' },
    ],
  });

  try {
    const pattern = await workspace.runCommand(
      "case B in [[:alpha:]) echo wrong;; esac; case '[a' in [[:alpha:]) echo match;; esac"
    );
    assertCondition(
      pattern.exitCode === 0 && pattern.stdout === 'match\n' && pattern.stderr === '',
      `the patched malformed POSIX class behavior should match Bash without throwing: ${JSON.stringify(pattern)}`
    );

    const assignment = await workspace.runCommand(
      "false; plain=value; printf '%s:%s\\n' \"$?\" \"$plain\"; captured=$(false); printf '%s\\n' \"$?\""
    );
    assertCondition(
      assignment.exitCode === 0 && assignment.stdout === '0:value\n1\n',
      `assignment-only commands should follow Bash status rules: ${JSON.stringify(assignment)}`
    );

    const commands = await workspace.runCommand([
      'factor 81',
      'truncate -s 1k sized',
      'stat -c %s sized',
      'mktemp -u -t trace.XXXXXX',
      'realpath -m --relative-to /workspace /workspace/nested/file',
      'printf abc | sha384sum',
      'printf abc | sha512sum',
    ].join('; '));
    assertCondition(
      commands.exitCode === 0 &&
        commands.stdout.startsWith('81: 3 3 3 3\n1024\n/tmp/trace.') &&
        commands.stdout.includes('\nnested/file\n') &&
        commands.stdout.includes('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7  -\n') &&
        commands.stdout.endsWith('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f  -\n'),
      `the package patch should expose its added browser commands through TraceKernel: ${JSON.stringify(commands)}`
    );

    const utilities = await workspace.runCommand(`
      printf 'simple\\n' | base32 -w0; printf '\\n'
      printf hello | cksum
      id -u
      printf data > source
      install -D source nested/copy
      link source alias
      cmp source nested/copy && cmp source alias && echo ok
    `);
    assertCondition(
      utilities.exitCode === 0 &&
        utilities.stdout === 'ONUW24DMMUFA====\n3287646509 5\n1000\nok\n' &&
        utilities.stderr === '',
      `common file and identity utilities should run through the installed browser patch: ${JSON.stringify(utilities)}`
    );

    const suppliedStdin = await workspace.runCommand(
      "cat; printf 'simple\\n' | base32 -w0; printf '\\n'",
      { stdinPipe: createRuntimeCommandStdinPipeFromText('from-stdin\n') }
    );
    assertCondition(
      suppliedStdin.exitCode === 0 &&
        suppliedStdin.stdout === 'from-stdin\nONUW24DMMUFA====\n' &&
        suppliedStdin.stderr === '',
      `closed command stdin should reach the shell without affecting pipeline stdin: ${JSON.stringify(suppliedStdin)}`
    );

    const descriptorStdin = await workspace.runCommand(
      "cat /dev/stdin; printf 'from-pipeline\\n' | cat /dev/fd/0",
      { stdinPipe: createRuntimeCommandStdinPipeFromText('from-device\n') }
    );
    assertCondition(
      descriptorStdin.exitCode === 0 && descriptorStdin.stdout === 'from-device\nfrom-pipeline\n' && descriptorStdin.stderr === '',
      `shell utilities should treat standard descriptor paths as aliases for their actual stdin stream: ${JSON.stringify(descriptorStdin)}`
    );

    const temporaryEntries = await workspace.runCommand([
      'temp_file=$(mktemp)',
      'temp_dir=$(mktemp -d -p /var/tmp trace.XXXXXX)',
      '[ -f "$temp_file" ] && [ -d "$temp_dir" ]',
      'printf "%s|%s\\n" "$temp_file" "$temp_dir"',
    ].join('; '));
    assertCondition(
      temporaryEntries.exitCode === 0 && /^\/tmp\/tmp\.[a-z0-9]+\|\/var\/tmp\/trace\.[a-z0-9]+\n$/.test(temporaryEntries.stdout),
      `standard temporary directories and mktemp creation should work without project-specific setup: ${JSON.stringify(temporaryEntries)}`
    );

    const delegatedCommand = await workspace.runCommand(
      "env -i echo hello; env A=foo PATH= /usr/bin/printenv A"
    );
    assertCondition(
      delegatedCommand.exitCode === 0 &&
        delegatedCommand.stdout === 'hello\nfoo\n' &&
        delegatedCommand.stderr === '',
      `TraceKernel command discovery should preserve command execution used by env: ${JSON.stringify(delegatedCommand)}`
    );

    const invalidXargsBatch = await workspace.runCommand(
      "printf 'a\\n' | xargs -n 0 2>/dev/null || echo ok"
    );
    assertCondition(
      invalidXargsBatch.exitCode === 0 &&
        invalidXargsBatch.stdout === 'ok\n' &&
        invalidXargsBatch.stderr === '',
      `xargs should reject a zero batch size without looping or exhausting the browser: ${JSON.stringify(invalidXargsBatch)}`
    );

    const commonXargsForms = await workspace.runCommand(`
      printf 'one two three' > args
      printf 'stdin\\n' | xargs -a args printf '%s\\n'
      printf 'one two three' | xargs -n2
      printf x | xargs false; printf 'status=%s\\n' "$?"
    `);
    assertCondition(
      commonXargsForms.exitCode === 0 &&
        commonXargsForms.stdout ===
          'one\ntwo\nthree\none two\nthree\nstatus=123\n' &&
        commonXargsForms.stderr === '',
      `xargs should support argument files, attached batch sizes, and native exit mapping: ${JSON.stringify(commonXargsForms)}`
    );

    const maximumLineWidth = await workspace.runCommand(
      "printf 'first\\rsecond\\n\\ta\\nabc\\td\\nẅ\\n' | wc -L"
    );
    assertCondition(
      maximumLineWidth.exitCode === 0 &&
        maximumLineWidth.stdout === '9\n' &&
        maximumLineWidth.stderr === '',
      `wc -L should report terminal display width for tabs, carriage returns, and combining marks: ${JSON.stringify(maximumLineWidth)}`
    );

    const formattedText = await workspace.runCommand(
      "printf 'first paragraph of text\\n\\nand another\\n' | fmt -w 10"
    );
    assertCondition(
      formattedText.exitCode === 0 &&
        formattedText.stdout ===
          'first\nparagraph\nof text\n\nand\nanother\n' &&
        formattedText.stderr === '',
      `fmt should provide native-shaped paragraph wrapping in browser projects: ${JSON.stringify(formattedText)}`
    );

    const canonicalHex = await workspace.runCommand(
      "printf 'simple\\n' | hexdump -C"
    );
    assertCondition(
      canonicalHex.exitCode === 0 &&
        canonicalHex.stdout ===
          '00000000  73 69 6d 70 6c 65 0a                              |simple.|\n00000007\n' &&
        canonicalHex.stderr === '',
      `hexdump -C should provide canonical byte inspection in browser projects: ${JSON.stringify(canonicalHex)}`
    );

    const scriptUtilities = await workspace.runCommand(`
      getopt -o a: -l one:: -- -a value --one=arg tail
      printf 'one two\\nthree\\n' > search.txt
      grep -H -e one -e three search.txt
      printf 'stdin\\nrest' | head -n 1 -
      printf 'stdin\\nrest' | tail -n 1 -
      touch alpha beta && ls -1 alpha beta
      sleep .001 && echo awake
    `);
    assertCondition(
      scriptUtilities.exitCode === 0 &&
        scriptUtilities.stdout ===
          " -a 'value' --one 'arg' -- 'tail'\n" +
            'search.txt:one two\nsearch.txt:three\n' +
            'stdin\nrestalpha\nbeta\nawake\n' &&
        scriptUtilities.stderr === '',
      `common shell-script and file-inspection workflows should match native command behavior: ${JSON.stringify(scriptUtilities)}`
    );

    const replacement = await workspace.runCommand("exec printf 'replaced\\n'; echo unreachable");
    assertCondition(
      replacement.exitCode === 0 && replacement.stdout === 'replaced\n',
      `exec should replace the remaining shell program: ${JSON.stringify(replacement)}`
    );

    const timestamps = await workspace.runCommand('[ existing -nt missing ] && [ missing -ot existing ]');
    assertCondition(
      timestamps.exitCode === 0,
      `-nt and -ot should preserve Bash missing-file semantics: ${JSON.stringify(timestamps)}`
    );
  } finally {
    workspace.dispose();
  }
}

await testNativeCommandIdentity();
await testBrowserJavaScriptTerminalSurface();
await testInterruptedNpmStartTerminalTranscript();
await testInteractiveTerminalContract();
await testBrowserProcessAndNetworkInspection();
await testBrowserWorkerFailureBoundary();
await testPatchedJustBashCompatibility();

console.log('PASS: browser terminal errors preserve native CLI shape and hide runtime infrastructure');
