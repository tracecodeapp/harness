import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

interface BrowserCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BrowserReadonlyRuntimeResult {
  language: string;
  result: BrowserCommandResult;
  before: string;
  after: string;
}

interface BrowserProjectSmokeResults {
  pythonCwd: BrowserCommandResult;
  pythonGenerated: string;
  pythonGeneratedAtRoot: string;
  pythonEnv: BrowserCommandResult;
  pythonStdin: BrowserCommandResult;
  pythonStdinGenerated: string;
  pythonStdinGeneratedAtRoot: string;
  pythonSideEffects: BrowserCommandResult;
  pythonCreated: string;
  pythonBytes: string;
  staleAfterPython: BrowserCommandResult;
  pythonModuleA: BrowserCommandResult;
  pythonModuleAGenerated: string;
  pythonModuleB: BrowserCommandResult;
  pythonModuleBGenerated: string;
  pythonPathPrecedence: BrowserCommandResult;
  pythonReloadOld: BrowserCommandResult;
  pythonReloadNew: BrowserCommandResult;
  nodeCwd: BrowserCommandResult;
  nodeGenerated: string;
  nodeGeneratedAtRoot: string;
  nodeSideEffects: BrowserCommandResult;
  nodeCreated: string;
  nodeBytes: string;
  staleAfterNode: BrowserCommandResult;
  nodePath: BrowserCommandResult;
  nodeEsm: BrowserCommandResult;
  nodeEsmGenerated: string;
  javaCwd: BrowserCommandResult;
  javaGenerated: string;
  javaCwdGenerated: string;
  javaGeneratedAtRoot: string;
  javaPropsGenerated: string;
  staleAfterJava: BrowserCommandResult;
  javaCwdCompile: BrowserCommandResult;
  javaCwdClass: string;
  javaCwdRun: BrowserCommandResult;
  javaArgCompile: BrowserCommandResult;
  javaArgClass: string;
  javaArgRun: BrowserCommandResult;
  javaSourcepathCompile: BrowserCommandResult;
  javaSourcepathMainClass: string;
  javaSourcepathHelperClass: string;
  javaSourcepathRun: BrowserCommandResult;
  javaStdin: BrowserCommandResult;
  javaJarCompile: BrowserCommandResult;
  javaJarClass: string;
  javaJarRun: BrowserCommandResult;
  devReadonly: {
    isReadOnly: boolean;
    read: string;
    writeRejected: boolean;
    nodeAppend: BrowserCommandResult;
    after: string;
  };
  projectSession: {
    id: string;
    workspaceRoot: string;
    testRun: BrowserCommandResult;
    report: string;
    readonly: {
      isReadOnly: boolean;
      read: string;
      writeRejected: boolean;
    };
    readonlyRuntimeWrites: BrowserReadonlyRuntimeResult[];
    readonlyNodeOperations: BrowserReadonlyRuntimeResult[];
  };
  takehome: {
    pythonRun: BrowserCommandResult;
    pythonReport: string;
    nodeRun: BrowserCommandResult;
    nodeReport: string;
    javaCompile: BrowserCommandResult;
    javaRun: BrowserCommandResult;
    javaReport: string;
    cppCompile: BrowserCommandResult;
    cppRun: BrowserCommandResult;
    cppReport: string;
    csharpRun: BrowserCommandResult;
    csharpReport: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}`
        )
      );
    });

    child.on('error', reject);
  });
}

async function createExternalJavaJarBase64(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tracecode-example-java-jar-'));
  try {
    const sourcePath = join(root, 'src/lib/External.java');
    const classesPath = join(root, 'classes');
    const jarPath = join(root, 'external.jar');
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(classesPath, { recursive: true });
    await writeFile(
      sourcePath,
      'package lib;\npublic class External { public static int value() { return 42; } }\n',
      'utf8'
    );
    await runCommand('javac', ['-d', classesPath, sourcePath], root);
    await runCommand('jar', ['cf', jarPath, '-C', classesPath, '.'], root);
    return (await readFile(jarPath)).toString('base64');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const isReady = await new Promise<boolean>((resolve) => {
      const req = request(url, (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode < 500));
      });

      req.on('error', () => resolve(false));
      req.end();
    });

    if (isReady) {
      return;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export function startPreviewServer(
  command: string,
  args: string[],
  cwd: string
): { process: ChildProcess; waitForExit: Promise<void>; waitForUrl: Promise<string> } {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolvedUrl = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const waitForUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const handleChunk = (chunk: Buffer | string): void => {
    const text = String(chunk);
    process.stdout.write(text);

    const match = text.match(/Local:\s+(http:\/\/[^\s/]+:\d+\/?)/);
    if (match && !resolvedUrl) {
      resolvedUrl = true;
      resolveUrl(match[1].replace(/\/$/, ''));
    }
  };

  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  const waitForExit = new Promise<void>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (!resolvedUrl) {
        rejectUrl(
          new Error(
            `${command} ${args.join(' ')} exited before reporting a preview URL`
          )
        );
      }

      if (code === 0 || signal === 'SIGTERM') {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} exited unexpectedly with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}`
        )
      );
    });

    child.on('error', reject);
  });

  child.on('error', (error) => {
    if (!resolvedUrl) {
      rejectUrl(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return { process: child, waitForExit, waitForUrl };
}

async function runLanguageExampleSmoke(
  page: import('playwright').Page,
  language: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp',
  options: {
    executionTimeoutMs: number;
    traceTimeoutMs: number;
    assertTrace?: (traceResult: { success?: boolean; trace?: unknown }) => void;
  }
): Promise<void> {
  await page.selectOption('#language', language);

  await page.click('#run');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#execution-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; output?: unknown };
          return (
            parsed.success === true &&
            Array.isArray(parsed.output) &&
            parsed.output.length === 2 &&
            parsed.output[0] === 0 &&
            parsed.output[1] === 1
          );
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: options.executionTimeoutMs }
    );
  } catch (error) {
    throw new Error(`Example ${language} execution did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }

  await page.click('#trace');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#trace-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; trace?: unknown };
          const trace = parsed.trace;
          const events = Array.isArray(trace)
            ? trace
            : trace && typeof trace === 'object' && Array.isArray((trace as { events?: unknown }).events)
              ? (trace as { events: unknown[] }).events
              : [];
          return parsed.success === true && events.length > 0;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: options.traceTimeoutMs }
    );
  } catch (error) {
    throw new Error(`Example ${language} trace did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }

  const traceText = await page.textContent('#trace-output');
  assertCondition(typeof traceText === 'string', `Expected trace output for ${language}`);
  const traceResult = JSON.parse(traceText) as { success?: boolean; trace?: unknown };
  const traceEvents = runtimeTraceEvents(traceResult.trace);
  assertCondition(traceResult.success === true, `Expected successful trace result for ${language}`);
  assertCondition(
    traceEvents.length > 0,
    `Expected non-empty runtime trace events for ${language}`
  );
  options.assertTrace?.(traceResult);
}

async function runCSharpExampleSmoke(page: import('playwright').Page): Promise<void> {
  await page.selectOption('#language', 'csharp');
  await page.click('#run');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#execution-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; output?: unknown };
          return parsed.success === true && parsed.output === 5;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 240_000 }
    );
  } catch (error) {
    throw new Error(`Example csharp execution did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }
}

async function runDevTerminalSmoke(page: import('playwright').Page, previewUrl: string): Promise<void> {
  await page.goto(`${previewUrl}/dev/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#dev-terminal-input', { timeout: 180_000 });
  await page.waitForFunction(
    () => document.querySelector('#dev-terminal-status')?.textContent?.endsWith('ready') === true,
    undefined,
    { timeout: 180_000 }
  );

  const runTerminalCommand = async (
    command: string,
    expectedOutput: string,
    predicate: (text: string) => boolean,
    timeoutMs = 60_000
  ): Promise<void> => {
    await page.fill('#dev-terminal-input', command);
    await page.press('#dev-terminal-input', 'Enter');
    try {
      await page.waitForFunction(
        (expected) => {
          const text = document.querySelector('#dev-terminal-output')?.textContent ?? '';
          const status = document.querySelector('#dev-terminal-status')?.textContent ?? '';
          return status.endsWith('ready') && text.includes(expected);
        },
        expectedOutput,
        { timeout: timeoutMs }
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector('#dev-terminal-status')?.textContent ?? '',
        output: document.querySelector('#dev-terminal-output')?.textContent ?? '',
      }));
      throw new Error(`Dev terminal command did not finish: ${JSON.stringify(diagnostics)}`, {
        cause: error,
      });
    }

    const output = await page.textContent('#dev-terminal-output');
    assertCondition(typeof output === 'string' && predicate(output), `Unexpected dev terminal output for ${command}`);
  };

  await runTerminalCommand('pwd', '/home/user/weather-api', (text) => text.includes('/home/user/weather-api'));
  await runTerminalCommand(
    'python3 main.py alpha beta',
    'args=alpha,beta',
    (text) => text.includes('5') && text.includes('args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'python3 globpy/*.py data/*.txt',
    'python_glob_args=data/a.txt,data/b.txt',
    (text) => text.includes('5') && text.includes('python_glob_args=data/a.txt,data/b.txt'),
    240_000
  );
  await runTerminalCommand(
    'python3 -m app.main alpha beta',
    'module_args=alpha,beta',
    (text) => text.includes('5') && text.includes('package=app') && text.includes('module_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'node index.js alpha beta',
    'node_args=alpha,beta',
    (text) => text.includes('5') && text.includes('node_args=alpha,beta')
  );
  await runTerminalCommand(
    'node globjs/*.js data/*.txt',
    'node_glob_args=data/a.txt,data/b.txt',
    (text) => text.includes('5') && text.includes('node_glob_args=data/a.txt,data/b.txt')
  );
  await runTerminalCommand(
    'java Main alpha beta',
    'java_args=alpha,beta',
    (text) => text.includes('5') && text.includes('java_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'javac -d out src/app/PackageMain.java src/app/PackageHelper.java',
    'weather-api % javac -d out src/app/PackageMain.java src/app/PackageHelper.java',
    (text) => text.includes('weather-api % javac -d out src/app/PackageMain.java src/app/PackageHelper.java') && !text.includes('Java compilation failed'),
    240_000
  );
  await runTerminalCommand(
    'find out -type f | sort',
    'out/app/PackageMain.class',
    (text) => text.includes('out/app/PackageHelper.class') && text.includes('out/app/PackageMain.class'),
    60_000
  );
  await runTerminalCommand(
    'java --class-path out app.PackageMain alpha beta',
    'java_package_args=alpha,beta',
    (text) => text.includes('5') && text.includes('java_package_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'javac -d glob-out src/app/*.java',
    'weather-api % javac -d glob-out src/app/*.java',
    (text) => text.includes('weather-api % javac -d glob-out src/app/*.java') && !text.includes('Java compilation failed'),
    240_000
  );
  await runTerminalCommand(
    'java --class-path glob-out app.PackageMain alpha beta',
    'java_package_args=alpha,beta',
    (text) => text.includes('5') && text.includes('java_package_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'java app.PackageMain alpha beta',
    'java_package_args=alpha,beta',
    (text) => text.includes('5') && text.includes('java_package_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'java right.Main',
    'weather-api % java right.Main',
    (text) => text.includes('weather-api % java right.Main') && text.includes('5'),
    240_000
  );
  await runTerminalCommand(
    'dotnet run -- alpha beta',
    'csharp_args=alpha,beta',
    (text) => text.includes('5') && text.includes('csharp_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'dotnet run -- data/*.txt',
    'csharp_args=data/a.txt,data/b.txt',
    (text) => text.includes('5') && text.includes('csharp_args=data/a.txt,data/b.txt'),
    240_000
  );
  await runTerminalCommand(
    'clang++ -std=c++17 main.cpp helper.cpp',
    'weather-api % clang++ -std=c++17 main.cpp helper.cpp',
    (text) => text.includes('weather-api % clang++ -std=c++17 main.cpp helper.cpp') && !text.includes('C++ compilation failed'),
    240_000
  );
  await runTerminalCommand(
    './a.out alpha beta',
    'cpp_args=alpha,beta',
    (text) => text.includes('5') && text.includes('cpp_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    'clang++ -std=c++17 *.cpp -o glob-app',
    'weather-api % clang++ -std=c++17 *.cpp -o glob-app',
    (text) => text.includes('weather-api % clang++ -std=c++17 *.cpp -o glob-app') && !text.includes('C++ compilation failed'),
    240_000
  );
  await runTerminalCommand(
    './glob-app alpha beta',
    'cpp_args=alpha,beta',
    (text) => text.includes('5') && text.includes('cpp_args=alpha,beta'),
    240_000
  );
  await runTerminalCommand(
    './glob-app data/*.txt',
    'cpp_args=data/a.txt,data/b.txt',
    (text) => text.includes('5') && text.includes('cpp_args=data/a.txt,data/b.txt'),
    240_000
  );
  const runProjectButton = async (
    buttonId: string,
    expectedOutput: string,
    predicate: (text: string) => boolean,
    timeoutMs = 240_000
  ): Promise<void> => {
    await page.evaluate((id) => {
      document.querySelector<HTMLButtonElement>(id)?.click();
    }, buttonId);
    await page.waitForFunction(
      (expected) => {
        const text = document.querySelector('#dev-terminal-output')?.textContent ?? '';
        const status = document.querySelector('#dev-terminal-status')?.textContent ?? '';
        return status.endsWith('ready') && text.includes(expected);
      },
      expectedOutput,
      { timeout: timeoutMs }
    );
    const output = await page.textContent('#dev-terminal-output');
    assertCondition(typeof output === 'string' && predicate(output), `Unexpected project command output for ${buttonId}`);
  };
  await runProjectButton(
    '#dev-menu-run-project-start',
    'weather-api % python3 main.py',
    (text) => text.includes('weather-api % python3 main.py') && text.includes('5')
  );
  await runProjectButton(
    '#dev-menu-run-project-test',
    'csharp:Acme:takehome',
    (text) =>
      text.includes('weather-api % python3 takehome/python/main.py') &&
      text.includes('python:Acme:takehome') &&
      text.includes('node:Acme:takehome') &&
      text.includes('ts:Acme:takehome') &&
      text.includes('java:Acme:takehome') &&
      text.includes('cpp:Acme:takehome') &&
      text.includes('csharp:Acme:takehome'),
    360_000
  );
  await runProjectButton(
    '#dev-menu-run-project-build',
    'weather-api % javac Main.java && clang++ -std=c++17 main.cpp helper.cpp -o session-cpp && dotnet build WeatherApi.csproj --nologo && dotnet build takehome/csharp/app/App.csproj --nologo',
    (text) =>
      text.includes('weather-api % javac Main.java && clang++ -std=c++17 main.cpp helper.cpp -o session-cpp && dotnet build WeatherApi.csproj --nologo && dotnet build takehome/csharp/app/App.csproj --nologo') &&
      !text.includes('Java compilation failed') &&
      !text.includes('C++ compilation failed') &&
      !text.includes('C# compilation failed'),
    360_000
  );

  const externalJar = await createExternalJavaJarBase64();
  const projectResults = (await page.evaluate(`(async () => {
    const workspace = window.__tracecodeProjectWorkspace;
    if (!workspace) throw new Error('Missing browser project workspace test handle');
    const externalJar = ${JSON.stringify(externalJar)};
    const safeReadFile = async (path, encoding) => {
      try {
        return await workspace.readFile(path, encoding);
      } catch (error) {
        return '__missing__:' + String(error);
      }
    };
    const devReadonlyRead = await safeReadFile('instructions/brief.md');
    let devReadonlyWriteRejected = false;
    try {
      await workspace.writeFile('instructions/brief.md', 'changed\\\\n');
    } catch {
      devReadonlyWriteRejected = true;
    }
    const devReadonlyNodeAppend = await workspace.runCommand('node -e "require(\\\\\\"node:fs\\\\\\").appendFileSync(\\\\\\"instructions/brief.md\\\\\\", \\\\\\"changed\\\\\\\\n\\\\\\")"');
    const devReadonlyAfter = await safeReadFile('instructions/brief.md');
    const pythonCwd = await workspace.runCommand('python3 main.py', { cwd: 'src/py' });
    const pythonGenerated = await safeReadFile('src/py/generated.txt');
    const pythonGeneratedAtRoot = await safeReadFile('generated.txt');
    const pythonEnv = await workspace.runCommand('python3 py_env.py', {
      env: { MODE: 'project', PYTHONPATH: 'vendor' },
    });
    const pythonStdin = await workspace.runCommand('python3 -', {
      cwd: 'src/py',
      stdin: [
        'import os',
        'from helper import value',
        'print(os.getcwd())',
        'print(value())',
        'open("stdin-generated.txt", "w").write("stdin-created\\\\n")',
        '',
      ].join('\\n'),
    });
    const pythonStdinGenerated = await safeReadFile('src/py/stdin-generated.txt');
    const pythonStdinGeneratedAtRoot = await safeReadFile('stdin-generated.txt');
    const pythonSideEffects = await workspace.runCommand(
      'python3 -c "open(\\\\\\"py-created.txt\\\\\\", \\\\\\"w\\\\\\").write(\\\\\\"created\\\\\\\\n\\\\\\"); open(\\\\\\"bytes.bin\\\\\\", \\\\\\"wb\\\\\\").write(bytes([0, 255])); import os; os.remove(\\\\\\"stale.txt\\\\\\")"'
    );
    const pythonCreated = await safeReadFile('py-created.txt');
    const pythonBytes = await safeReadFile('bytes.bin', 'base64');
    const staleAfterPython = await workspace.runCommand('test ! -e stale.txt && echo deleted');
    const pythonModuleA = await workspace.runCommand('python3 -m pkg_a.main');
    const pythonModuleAGenerated = await safeReadFile('pkg-a-generated.txt');
    const pythonModuleB = await workspace.runCommand('python3 -m pkg_b.main');
    const pythonModuleBGenerated = await safeReadFile('pkg-b-generated.txt');
    const pythonPathPrecedence = await workspace.runCommand('python3 -m pkg_b.main', {
      env: { PYTHONPATH: 'vendor' },
    });
    const pythonReloadOld = await workspace.runCommand('python3 reload_main.py');
    await workspace.writeFile('reload_target.py', [
      'def value():',
      '    return "new"',
      '',
    ].join('\\n'));
    const pythonReloadNew = await workspace.runCommand('python3 reload_main.py');
    await workspace.writeFile('src/js/helper.js', 'exports.value = () => 61;\\n');
    await workspace.writeFile('src/js/main.js', [
      'const fs = require("node:fs");',
      'const { value } = require("./helper");',
      'console.log(process.cwd());',
      'console.log(value());',
      'fs.writeFileSync("generated.txt", "node-created\\\\n");',
      '',
    ].join('\\n'));
    await workspace.writeFile('js-stale.txt', 'delete me\\n');
    const nodeCwd = await workspace.runCommand('node main.js', { cwd: 'src/js' });
    const nodeGenerated = await safeReadFile('src/js/generated.txt');
    const nodeGeneratedAtRoot = await safeReadFile('generated.txt');
    const nodeSideEffects = await workspace.runCommand(
      'node -e "const fs = require(\\\\\\"node:fs\\\\\\"); fs.writeFileSync(\\\\\\"node-created.txt\\\\\\", \\\\\\"created\\\\\\\\n\\\\\\"); fs.writeFileSync(\\\\\\"node-bytes.bin\\\\\\", Buffer.from([0, 255])); fs.unlinkSync(\\\\\\"js-stale.txt\\\\\\")"'
    );
    const nodeCreated = await safeReadFile('node-created.txt');
    const nodeBytes = await safeReadFile('node-bytes.bin', 'base64');
    const staleAfterNode = await workspace.runCommand('test ! -e js-stale.txt && echo deleted');
    await workspace.writeFile('vendor/envpkg.js', 'exports.value = 77;\\n');
    const nodePath = await workspace.runCommand('node -e "console.log(require(\\\\\\"envpkg\\\\\\").value)"', {
      env: { NODE_PATH: 'vendor' },
    });
    await workspace.writeFile('src/js-esm/helper.mjs', 'export const value = 88;\\n');
    await workspace.writeFile('src/js-esm/main.mjs', [
      'import { writeFileSync } from "node:fs";',
      'import { value } from "./helper.mjs";',
      'const dynamic = await import("./helper.mjs");',
      'console.log(value + dynamic.value);',
      'console.log(process.argv.slice(2).join(","));',
      'writeFileSync("esm-generated.txt", "esm-created\\\\n");',
      '',
    ].join('\\n'));
    const nodeEsm = await workspace.runCommand('node main.mjs alpha beta', { cwd: 'src/js-esm' });
    const nodeEsmGenerated = await safeReadFile('src/js-esm/esm-generated.txt');
    const javaCwd = await workspace.runCommand('java CwdMain', { cwd: 'src/javawd' });
    const javaGenerated = await safeReadFile('src/javawd/generated.txt');
    const javaCwdGenerated = await safeReadFile('src/javawd/cwd-generated.txt');
    const javaGeneratedAtRoot = await safeReadFile('generated.txt');
    const javaPropsGenerated = await safeReadFile('src/javawd/props.txt');
    const staleAfterJava = await workspace.runCommand('test ! -e java-stale.txt && echo deleted');
    const javaCwdCompile = await workspace.runCommand('javac -d out CompileMain.java', { cwd: 'src/javacwd' });
    const javaCwdClass = await safeReadFile('src/javacwd/out/CompileMain.class', 'base64');
    const javaCwdRun = await workspace.runCommand('java --class-path out CompileMain', { cwd: 'src/javacwd' });
    const javaArgCompile = await workspace.runCommand('javac @javac.args', { cwd: 'src/javaarg' });
    const javaArgClass = await safeReadFile('src/javaarg/out/ArgMain.class', 'base64');
    const javaArgRun = await workspace.runCommand('java --class-path out ArgMain', { cwd: 'src/javaarg' });
    const javaSourcepathCompile = await workspace.runCommand('javac @javac.args', { cwd: 'src/javasourcepath' });
    const javaSourcepathMainClass = await safeReadFile('src/javasourcepath/out/app/Main.class', 'base64');
    const javaSourcepathHelperClass = await safeReadFile('src/javasourcepath/out/app/Helper.class', 'base64');
    const javaSourcepathRun = await workspace.runCommand('java --class-path out app.Main', { cwd: 'src/javasourcepath' });
    const javaStdin = await workspace.runCommand('java InputMain', {
      cwd: 'src/javastdin',
      stdin: ['from-browser', ''].join('\\n'),
    });
    await workspace.writeFile('lib/external.jar', externalJar, 'base64');
    await workspace.writeFile('src/jar/JarMain.java', [
      'package jarapp;',
      'import lib.External;',
      'public class JarMain {',
      '  public static void main(String[] args) {',
      '    System.out.println(External.value());',
      '    System.out.println(String.join(",", args));',
      '  }',
      '}',
      '',
    ].join('\\n'));
    const javaJarCompile = await workspace.runCommand('javac -cp lib/external.jar -d jar-out src/jar/JarMain.java');
    const javaJarClass = await safeReadFile('jar-out/jarapp/JarMain.class', 'base64');
    const javaJarRun = await workspace.runCommand('java -cp jar-out:lib/external.jar jarapp.JarMain alpha beta');
    await workspace.writeFile('takehome/data/orders.csv', [
      'customer,sku,quantity,price',
      'Acme,A-100,2,19.50',
      'Beta,B-200,5,7.25',
      'Acme,C-300,1,100.00',
      'Delta,A-100,3,19.50',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/python/orders.py', [
      'from dataclasses import dataclass',
      'from pathlib import Path',
      '',
      '@dataclass',
      'class Order:',
      '    customer: str',
      '    sku: str',
      '    quantity: int',
      '    price: float',
      '',
      '    @property',
      '    def total(self):',
      '        return self.quantity * self.price',
      '',
      'def read_orders(path):',
      '    rows = Path(path).read_text().splitlines()[1:]',
      '    orders = []',
      '    for row in rows:',
      '        if not row:',
      '            continue',
      '        customer, sku, quantity, price = row.split(",")',
      '        orders.append(Order(customer, sku, int(quantity), float(price)))',
      '    return orders',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/python/report.py', [
      'from pathlib import Path',
      '',
      'def write_report(path, orders):',
      '    totals = {}',
      '    for order in orders:',
      '        totals[order.customer] = totals.get(order.customer, 0) + order.total',
      '    top = max(totals.items(), key=lambda item: item[1])[0]',
      '    target = Path(path)',
      '    target.parent.mkdir(parents=True, exist_ok=True)',
      '    target.write_text(f"top={top}\\\\ncount={len(totals)}\\\\n")',
      '    return top',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/python/main.py', [
      'import os',
      'from pathlib import Path',
      'from orders import read_orders',
      'from report import write_report',
      '',
      'root = Path.cwd()',
      'top = write_report(root / "reports" / "summary.txt", read_orders(root / "../data/orders.csv"))',
      'print(f"python:{top}:{os.environ.get(\\'MODE\\', \\'\\')}")',
      'print(os.getcwd())',
      '',
    ].join('\\n'));
    const takehomePythonRun = await workspace.runCommand('python3 main.py', { cwd: 'takehome/python', env: { MODE: 'takehome' } });
    const takehomePythonReport = await safeReadFile('takehome/python/reports/summary.txt');
    await workspace.writeFile('takehome/js/orders.js', [
      'const fs = require("node:fs");',
      '',
      'function readOrders(path) {',
      '  return fs.readFileSync(path, "utf8").trim().split(/\\\\n/).slice(1).filter(Boolean).map((line) => {',
      '    const [customer, sku, quantity, price] = line.split(",");',
      '    return { customer, sku, quantity: Number(quantity), price: Number(price), total: Number(quantity) * Number(price) };',
      '  });',
      '}',
      '',
      'module.exports = { readOrders };',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/js/report.js', [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      '',
      'function writeReport(target, orders) {',
      '  const totals = new Map();',
      '  for (const order of orders) totals.set(order.customer, (totals.get(order.customer) || 0) + order.total);',
      '  const top = [...totals.entries()].sort((left, right) => right[1] - left[1])[0][0];',
      '  fs.mkdirSync(path.dirname(target), { recursive: true });',
      '  fs.writeFileSync(target, "top=" + top + "\\\\ncount=" + totals.size + "\\\\n");',
      '  return top;',
      '}',
      '',
      'module.exports = { writeReport };',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/js/main.js', [
      'const path = require("node:path");',
      'const { readOrders } = require("./orders");',
      'const { writeReport } = require("./report");',
      '',
      'const root = process.cwd();',
      'const top = writeReport(path.join(root, "reports/summary.txt"), readOrders(path.join(root, "../data/orders.csv")));',
      'console.log("node:" + top + ":" + (process.env.MODE || ""));',
      'console.log(process.cwd());',
      '',
    ].join('\\n'));
    const takehomeNodeRun = await workspace.runCommand('node main.js', { cwd: 'takehome/js', env: { MODE: 'takehome' } });
    const takehomeNodeReport = await safeReadFile('takehome/js/reports/summary.txt');
    await workspace.writeFile('takehome/java/stressjava/Order.java', [
      'package stressjava;',
      'public record Order(String customer, String sku, int quantity, double price) {',
      '  public double total() { return quantity * price; }',
      '}',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/java/stressjava/OrderParser.java', [
      'package stressjava;',
      'import java.nio.file.*;',
      'import java.util.*;',
      'public final class OrderParser {',
      '  public static java.util.List<Order> read(Path path) throws Exception {',
      '    java.util.List<Order> out = new ArrayList<>();',
      '    for (String line : Files.readAllLines(path).subList(1, Files.readAllLines(path).size())) {',
      '      if (line.isBlank()) continue;',
      '      String[] p = line.split(",");',
      '      out.add(new Order(p[0], p[1], Integer.parseInt(p[2]), Double.parseDouble(p[3])));',
      '    }',
      '    return out;',
      '  }',
      '}',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/java/stressjava/ReportWriter.java', [
      'package stressjava;',
      'import java.nio.file.*;',
      'import java.util.*;',
      'public final class ReportWriter {',
      '  public static String write(Path path, Map<String, Double> totals) throws Exception {',
      '    Files.createDirectories(path.getParent());',
      '    String top = totals.entrySet().stream().max(Map.Entry.comparingByValue()).orElseThrow().getKey();',
      '    Files.writeString(path, "top=" + top + "\\\\ncount=" + totals.size() + "\\\\n");',
      '    return top;',
      '  }',
      '}',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/java/stressjava/Main.java', [
      'package stressjava;',
      'import java.nio.file.*;',
      'import java.util.*;',
      'public class Main {',
      '  public static void main(String[] args) throws Exception {',
      '    Path root = Path.of(System.getProperty("user.dir"));',
      '    var orders = OrderParser.read(root.resolve("../data/orders.csv"));',
      '    Map<String, Double> totals = new TreeMap<>();',
      '    for (Order order : orders) totals.merge(order.customer(), order.total(), Double::sum);',
      '    String top = ReportWriter.write(root.resolve("reports/summary.txt"), totals);',
      '    System.out.println("java:" + top + ":" + System.getenv("MODE"));',
      '    System.out.println(System.getProperty("user.dir"));',
      '  }',
      '}',
      '',
    ].join('\\n'));
    const takehomeJavaCompile = await workspace.runCommand('javac -d out stressjava/Main.java stressjava/Order.java stressjava/OrderParser.java stressjava/ReportWriter.java', { cwd: 'takehome/java' });
    const takehomeJavaRun = await workspace.runCommand('java --class-path out stressjava.Main', { cwd: 'takehome/java', env: { MODE: 'takehome' } });
    const takehomeJavaReport = await safeReadFile('takehome/java/reports/summary.txt');
    await workspace.writeFile('takehome/cpp/src/order.hpp', [
      '#pragma once',
      '#include <string>',
      '#include <vector>',
      'struct Order { std::string customer; std::string sku; int quantity; double price; };',
      'std::vector<Order> read_orders(const std::string& path);',
      'std::string write_report(const std::string& path, const std::vector<Order>& orders);',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/cpp/src/order.cpp', [
      '#include "order.hpp"',
      '#include <fstream>',
      '#include <map>',
      '#include <sstream>',
      'std::vector<Order> read_orders(const std::string& path) {',
      '  std::ifstream in(path); std::string line; std::getline(in, line); std::vector<Order> out;',
      "  while (std::getline(in, line)) { if (line.empty()) continue; std::stringstream ss(line); std::string c,s,q,p; std::getline(ss,c,','); std::getline(ss,s,','); std::getline(ss,q,','); std::getline(ss,p,','); out.push_back({c,s,std::stoi(q),std::stod(p)}); }",
      '  return out;',
      '}',
      'std::string write_report(const std::string& path, const std::vector<Order>& orders) {',
      '  std::map<std::string,double> totals; for (const auto& order : orders) totals[order.customer] += order.quantity * order.price;',
      '  std::string top; double best = -1; for (const auto& item : totals) if (item.second > best) { top = item.first; best = item.second; }',
      '  std::ofstream out(path); out << "top=" << top << "\\\\ncount=" << totals.size() << "\\\\n"; return top;',
      '}',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/cpp/src/main.cpp', [
      '#include "order.hpp"',
      '#include <cstdlib>',
      '#include <iostream>',
      'int main() {',
      '  auto orders = read_orders("../data/orders.csv");',
      '  std::string top = write_report("summary.txt", orders);',
      '  const char* mode = std::getenv("MODE");',
      '  std::cout << "cpp:" << top << ":" << (mode ? mode : "") << "\\\\n";',
      '}',
      '',
    ].join('\\n'));
    const takehomeCppCompile = await workspace.runCommand('clang++ -std=c++17 main.cpp order.cpp -o ../analyzer', { cwd: 'takehome/cpp/src' });
    const takehomeCppRun = await workspace.runCommand('./analyzer', { cwd: 'takehome/cpp', env: { MODE: 'takehome' } });
    const takehomeCppReport = await safeReadFile('takehome/cpp/summary.txt');
    await workspace.writeFile('takehome/csharp/app/App.csproj', [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>',
      '</Project>',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/csharp/app/Order.cs', 'record Order(string Customer, string Sku, int Quantity, double Price) { public double Total => Quantity * Price; }\\n');
    await workspace.writeFile('takehome/csharp/app/Parser.cs', [
      'static class Parser {',
      '  public static List<Order> Read(string path) => File.ReadAllLines(path).Skip(1).Where(line => line.Length > 0).Select(line => { var p = line.Split(","); return new Order(p[0], p[1], int.Parse(p[2]), double.Parse(p[3])); }).ToList();',
      '}',
      '',
    ].join('\\n'));
    await workspace.writeFile('takehome/csharp/app/Program.cs', [
      'using System.Diagnostics;',
      'var orders = Parser.Read("../data/orders.csv");',
      'var totals = orders.GroupBy(o => o.Customer).ToDictionary(g => g.Key, g => g.Sum(o => o.Total));',
      'var top = totals.OrderByDescending(kv => kv.Value).First().Key;',
      'Directory.CreateDirectory("reports");',
      'File.WriteAllText("reports/summary.txt", $"top={top}\\\\ncount={totals.Count}\\\\n");',
      'Console.WriteLine($"csharp:{top}:{Environment.GetEnvironmentVariable("MODE")}");',
      'try { Process.Start("echo", "child"); Console.WriteLine("process=ok"); } catch (Exception ex) { Console.WriteLine("process-error=" + ex.GetType().Name); }',
      '',
    ].join('\\n'));
    const takehomeCsharpRun = await workspace.runCommand('dotnet run --project app/App.csproj', { cwd: 'takehome/csharp', env: { MODE: 'takehome' } });
    const takehomeCsharpReport = await safeReadFile('takehome/csharp/reports/summary.txt');
    const createBrowserProjectWorkspace = window.__tracecodeCreateBrowserProjectWorkspace;
    if (!createBrowserProjectWorkspace) throw new Error('Missing browser project workspace factory test handle');
    const sessionWorkspace = await createBrowserProjectWorkspace({
      assetBaseUrl: '/workers',
      pythonProjectTimeoutMs: 120000,
      javaProjectTimeoutMs: 120000,
      csharpProjectTimeoutMs: 120000,
      cppProjectTimeoutMs: 120000,
      projectSession: {
        id: 'browser-session-takehome-1',
        projectId: 'browser-session-takehome',
        projectSlug: 'session-takehome',
        language: 'mixed',
        env: { MODE: 'session' },
        commands: {
          test: {
            command: 'python3 main.py',
            cwd: 'app',
            env: { CHECK: 'visible' },
          },
        },
        files: [
          {
            path: 'data/orders.csv',
            contents: [
              'customer,sku,quantity,price',
              'Acme,A-100,2,19.50',
              'Beta,B-200,5,7.25',
              'Acme,C-300,1,100.00',
              'Delta,A-100,3,19.50',
              '',
            ].join('\\n'),
          },
          {
            path: 'app/orders.py',
            contents: [
              'from pathlib import Path',
              'def read_orders(path):',
              '    rows = Path(path).read_text().splitlines()[1:]',
              '    return [row.split(",") for row in rows if row]',
              '',
            ].join('\\n'),
          },
          {
            path: 'app/main.py',
            contents: [
              'import os',
              'from pathlib import Path',
              'from orders import read_orders',
              'orders = read_orders("../data/orders.csv")',
              'totals = {}',
              'for customer, sku, quantity, price in orders:',
              '    totals[customer] = totals.get(customer, 0) + int(quantity) * float(price)',
              'top = max(totals.items(), key=lambda item: item[1])[0]',
              'Path("reports").mkdir(exist_ok=True)',
              'Path("reports/summary.txt").write_text(f"top={top}\\\\ncount={len(totals)}\\\\n")',
              'print(f"session:{top}:{os.environ.get(\\'MODE\\')}:{os.environ.get(\\'CHECK\\')}")',
              'print(os.getcwd())',
              '',
            ].join('\\n'),
          },
          {
            path: 'README.md',
            readonly: true,
            contents: 'session protected\\n',
          },
          {
            path: 'mutate-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.writeFileSync("README.md", "node changed\\\\n");\\nconsole.log("after node write");\\n',
          },
          {
            path: 'append-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.appendFileSync("README.md", "node appended\\\\n");\\nconsole.log("after node append");\\n',
          },
          {
            path: 'delete-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.unlinkSync("README.md");\\nconsole.log("after node delete");\\n',
          },
          {
            path: 'move-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.renameSync("README.md", "README.moved.md");\\nconsole.log("after node move");\\n',
          },
          {
            path: 'copy-over-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.copyFileSync("mutable-source.txt", "README.md");\\nconsole.log("after node copy");\\n',
          },
          {
            path: 'truncate-readonly.js',
            contents: 'const fs = require("node:fs");\\nfs.truncateSync("README.md", 0);\\nconsole.log("after node truncate");\\n',
          },
          {
            path: 'mutable-source.txt',
            contents: 'mutable source\\n',
          },
          {
            path: 'mutate-readonly.py',
            contents: 'from pathlib import Path\\nPath("README.md").write_text("python changed\\\\n")\\nprint("after python write")\\n',
          },
          {
            path: 'MutateReadonly.java',
            contents: [
              'import java.nio.file.*;',
              'public class MutateReadonly {',
              '  public static void main(String[] args) throws Exception {',
              '    Files.writeString(Path.of("README.md"), "java changed\\\\n");',
              '    System.out.println("after java write");',
              '  }',
              '}',
              '',
            ].join('\\n'),
          },
          {
            path: 'readonly-csharp/ReadonlyCsharp.csproj',
            contents: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\\n',
          },
          {
            path: 'readonly-csharp/Program.cs',
            contents: 'using System;\\nusing System.IO;\\nFile.WriteAllText("../README.md", "csharp changed\\\\n");\\nConsole.WriteLine("after csharp write");\\n',
          },
          {
            path: 'mutate-readonly.cpp',
            contents: [
              '#include <fstream>',
              '#include <iostream>',
              'int main() {',
              '  std::ofstream out("README.md");',
              '  out << "cpp changed\\\\n";',
              '  out.close();',
              '  std::cout << "after cpp write\\\\n";',
              '  return 0;',
              '}',
              '',
            ].join('\\n'),
          },
        ],
        metadata: { source: 'browser-smoke' },
      },
    });
    const projectSessionTestRun = await sessionWorkspace.runProjectCommand('test');
    const projectSessionReport = await sessionWorkspace.readFile('app/reports/summary.txt');
    let projectSessionReadonlyWriteRejected = false;
    try {
      await sessionWorkspace.writeFile('README.md', 'overwrite\\n');
    } catch {
      projectSessionReadonlyWriteRejected = true;
    }
    const projectSessionReadonlyRead = await sessionWorkspace.readFile('README.md');
    const readonlyRuntimeChecks = [
      ['node', 'node mutate-readonly.js'],
      ['python', 'python3 mutate-readonly.py'],
      ['java', 'javac MutateReadonly.java && java MutateReadonly'],
      ['csharp', 'dotnet run --project readonly-csharp/ReadonlyCsharp.csproj'],
      ['cpp', 'clang++ -std=c++17 mutate-readonly.cpp && ./a.out'],
    ];
    const readonlyRuntimeWrites = [];
    for (const [language, command] of readonlyRuntimeChecks) {
      const before = await sessionWorkspace.readFile('README.md');
      const result = await sessionWorkspace.runCommand(command);
      const after = await sessionWorkspace.readFile('README.md');
      readonlyRuntimeWrites.push({ language, result, before, after });
    }
    const readonlyNodeChecks = [
      ['append', 'node append-readonly.js'],
      ['delete', 'node delete-readonly.js'],
      ['move', 'node move-readonly.js'],
      ['copy', 'node copy-over-readonly.js'],
      ['truncate', 'node truncate-readonly.js'],
    ];
    const readonlyNodeOperations = [];
    for (const [language, command] of readonlyNodeChecks) {
      const before = await sessionWorkspace.readFile('README.md');
      const result = await sessionWorkspace.runCommand(command);
      const after = await sessionWorkspace.readFile('README.md');
      readonlyNodeOperations.push({ language, result, before, after });
    }
    const projectSessionInfo = sessionWorkspace.projectSession;
    sessionWorkspace.dispose();
    return {
      pythonCwd,
      pythonGenerated,
      pythonGeneratedAtRoot,
      pythonEnv,
      pythonStdin,
      pythonStdinGenerated,
      pythonStdinGeneratedAtRoot,
      pythonSideEffects,
      pythonCreated,
      pythonBytes,
      staleAfterPython,
      pythonModuleA,
      pythonModuleAGenerated,
      pythonModuleB,
      pythonModuleBGenerated,
      pythonPathPrecedence,
      pythonReloadOld,
      pythonReloadNew,
      nodeCwd,
      nodeGenerated,
      nodeGeneratedAtRoot,
      nodeSideEffects,
      nodeCreated,
      nodeBytes,
      staleAfterNode,
      nodePath,
      nodeEsm,
      nodeEsmGenerated,
      javaCwd,
      javaGenerated,
      javaCwdGenerated,
      javaGeneratedAtRoot,
      javaPropsGenerated,
      staleAfterJava,
      javaCwdCompile,
      javaCwdClass,
      javaCwdRun,
      javaArgCompile,
      javaArgClass,
      javaArgRun,
      javaSourcepathCompile,
      javaSourcepathMainClass,
      javaSourcepathHelperClass,
      javaSourcepathRun,
      javaStdin,
      javaJarCompile,
      javaJarClass,
      javaJarRun,
      devReadonly: {
        isReadOnly: workspace.isReadOnly('instructions/brief.md'),
        read: devReadonlyRead,
        writeRejected: devReadonlyWriteRejected,
        nodeAppend: devReadonlyNodeAppend,
        after: devReadonlyAfter,
      },
      projectSession: {
        id: projectSessionInfo?.id ?? '',
        workspaceRoot: projectSessionInfo?.workspaceRoot ?? '',
        testRun: projectSessionTestRun,
        report: projectSessionReport,
        readonly: {
          isReadOnly: sessionWorkspace.isReadOnly('README.md'),
          read: projectSessionReadonlyRead,
          writeRejected: projectSessionReadonlyWriteRejected,
        },
        readonlyRuntimeWrites,
        readonlyNodeOperations,
      },
      takehome: {
        pythonRun: takehomePythonRun,
        pythonReport: takehomePythonReport,
        nodeRun: takehomeNodeRun,
        nodeReport: takehomeNodeReport,
        javaCompile: takehomeJavaCompile,
        javaRun: takehomeJavaRun,
        javaReport: takehomeJavaReport,
        cppCompile: takehomeCppCompile,
        cppRun: takehomeCppRun,
        cppReport: takehomeCppReport,
        csharpRun: takehomeCsharpRun,
        csharpReport: takehomeCsharpReport,
      },
    };
  })()`)) as BrowserProjectSmokeResults;

  assertCondition(
    projectResults.pythonCwd.exitCode === 0 &&
      projectResults.pythonCwd.stdout.endsWith('/src/py\n31\n') &&
      projectResults.pythonGenerated === 'created\n',
    `Browser Python project cwd/files mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.pythonEnv.exitCode === 0 && projectResults.pythonEnv.stdout === '42\nproject\n',
    `Browser Python project env/PYTHONPATH mismatch: ${JSON.stringify(projectResults.pythonEnv)}`
  );
  assertCondition(
      projectResults.pythonStdin.exitCode === 0 &&
      projectResults.pythonStdin.stdout.endsWith('/src/py\n31\n') &&
      projectResults.pythonStdinGenerated === 'stdin-created\n',
    `Browser Python project stdin mismatch: ${JSON.stringify(projectResults.pythonStdin)}`
  );
  assertCondition(
    projectResults.pythonSideEffects.exitCode === 0 &&
      projectResults.pythonCreated === 'created\n' &&
      projectResults.pythonBytes === 'AP8=' &&
      projectResults.staleAfterPython.stdout === 'deleted\n',
    `Browser Python project side effects mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.pythonModuleA.exitCode === 0 &&
      projectResults.pythonModuleA.stdout === 'a-helper\n' &&
      projectResults.pythonModuleAGenerated === 'a-helper\n' &&
      projectResults.pythonModuleB.exitCode === 0 &&
      projectResults.pythonModuleB.stdout === 'b-helper\n' &&
      projectResults.pythonModuleBGenerated === 'b-helper\n',
    `Browser Python project module/duplicate import mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.pythonPathPrecedence.exitCode === 0 &&
      projectResults.pythonPathPrecedence.stdout === 'b-helper\n',
    `Browser Python project PYTHONPATH precedence mismatch: ${JSON.stringify(projectResults.pythonPathPrecedence)}`
  );
  assertCondition(
    projectResults.pythonReloadOld.exitCode === 0 &&
      projectResults.pythonReloadOld.stdout === 'old\n' &&
      projectResults.pythonReloadNew.exitCode === 0 &&
      projectResults.pythonReloadNew.stdout === 'new\n',
    `Browser Python project import cache invalidation mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.nodeCwd.exitCode === 0 &&
      projectResults.nodeCwd.stdout === '/home/user/weather-api/src/js\n61\n' &&
      projectResults.nodeGenerated === 'node-created\n' &&
      projectResults.nodeGeneratedAtRoot !== 'node-created\n',
    `Browser Node project cwd/files mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.nodeSideEffects.exitCode === 0 &&
      projectResults.nodeCreated === 'created\n' &&
      projectResults.nodeBytes === 'AP8=' &&
      projectResults.staleAfterNode.stdout === 'deleted\n',
    `Browser Node project side effects mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.nodePath.exitCode === 0 &&
      projectResults.nodePath.stdout === '77\n',
    `Browser Node project NODE_PATH mismatch: ${JSON.stringify(projectResults.nodePath)}`
  );
  assertCondition(
    projectResults.nodeEsm.exitCode === 0 &&
      projectResults.nodeEsm.stdout === '176\nalpha,beta\n' &&
      projectResults.nodeEsmGenerated === 'esm-created\n',
    `Browser Node project ESM/import side effects mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.javaCwd.exitCode === 0 &&
      projectResults.javaCwd.stdout === [
        '/home/user/weather-api/src/javawd',
        '/home/user',
        'user',
        'tracekernel',
        '0.7.0-beta6',
        '',
      ].join('\n') &&
      projectResults.javaGenerated === 'java-created\n' &&
      projectResults.javaCwdGenerated === 'cwd-created\n' &&
      projectResults.javaPropsGenerated === '/home/user/weather-api/src/javawd\ntracekernel\n' &&
      projectResults.staleAfterJava.stdout === 'deleted\n',
    `Browser Java project cwd/files mismatch: ${JSON.stringify({
      javaCwd: projectResults.javaCwd,
      javaGenerated: projectResults.javaGenerated,
      javaCwdGenerated: projectResults.javaCwdGenerated,
      javaPropsGenerated: projectResults.javaPropsGenerated,
      staleAfterJava: projectResults.staleAfterJava,
    })}`
  );
  assertCondition(
    projectResults.javaCwdCompile.exitCode === 0 &&
      typeof projectResults.javaCwdClass === 'string' &&
      projectResults.javaCwdClass.length > 0 &&
      !projectResults.javaCwdClass.startsWith('__missing__') &&
      projectResults.javaCwdRun.exitCode === 0 &&
      projectResults.javaCwdRun.stdout === 'cwd-compile\n',
    `Browser Java project cwd compile/classpath mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.javaArgCompile.exitCode === 0 &&
      typeof projectResults.javaArgClass === 'string' &&
      projectResults.javaArgClass.length > 0 &&
      !projectResults.javaArgClass.startsWith('__missing__') &&
      projectResults.javaArgRun.exitCode === 0 &&
      projectResults.javaArgRun.stdout === 'argfile-compile\n',
    `Browser Java project argfile compile mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.javaSourcepathCompile.exitCode === 0 &&
      typeof projectResults.javaSourcepathMainClass === 'string' &&
      projectResults.javaSourcepathMainClass.length > 0 &&
      !projectResults.javaSourcepathMainClass.startsWith('__missing__') &&
      typeof projectResults.javaSourcepathHelperClass === 'string' &&
      projectResults.javaSourcepathHelperClass.length > 0 &&
      !projectResults.javaSourcepathHelperClass.startsWith('__missing__') &&
      projectResults.javaSourcepathRun.exitCode === 0 &&
      projectResults.javaSourcepathRun.stdout === 'sourcepath-helper\n',
    `Browser Java project sourcepath transitive compile mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.javaStdin.exitCode === 0 &&
      projectResults.javaStdin.stdout === 'stdin=from-browser\n',
    `Browser Java project stdin mismatch: ${JSON.stringify(projectResults.javaStdin)}`
  );
  assertCondition(
    projectResults.javaJarCompile.exitCode === 0 &&
      typeof projectResults.javaJarClass === 'string' &&
      projectResults.javaJarClass.length > 0 &&
      !projectResults.javaJarClass.startsWith('__missing__') &&
      projectResults.javaJarRun.exitCode === 0 &&
      projectResults.javaJarRun.stdout === '42\nalpha,beta\n',
    `Browser Java project jar/classpath mismatch: ${JSON.stringify(projectResults)}`
  );
  assertCondition(
    projectResults.devReadonly.isReadOnly &&
      projectResults.devReadonly.read === 'readonly project brief\n' &&
      projectResults.devReadonly.writeRejected &&
      projectResults.devReadonly.nodeAppend.exitCode !== 0 &&
      projectResults.devReadonly.nodeAppend.stdout === '' &&
      projectResults.devReadonly.nodeAppend.stderr === "EROFS: readonly project file, append 'instructions/brief.md'\n" &&
      projectResults.devReadonly.after === projectResults.devReadonly.read,
    `Browser /dev readonly file mismatch: ${JSON.stringify(projectResults.devReadonly)}`
  );
  assertCondition(
    projectResults.projectSession.id === 'browser-session-takehome-1' &&
      projectResults.projectSession.workspaceRoot === '/home/user/session-takehome' &&
      projectResults.projectSession.testRun.exitCode === 0 &&
      projectResults.projectSession.testRun.stdout === 'session:Acme:session:visible\n/home/user/session-takehome/app\n' &&
      projectResults.projectSession.report === 'top=Acme\ncount=3\n' &&
      projectResults.projectSession.readonly.isReadOnly &&
      projectResults.projectSession.readonly.writeRejected &&
      projectResults.projectSession.readonly.read === 'session protected\n',
    `Browser ProjectSession takehome mismatch: ${JSON.stringify(projectResults.projectSession)}`
  );
  const expectedReadonlyRuntimeLanguages = ['node', 'python', 'java', 'csharp', 'cpp'];
  assertCondition(
    projectResults.projectSession.readonlyRuntimeWrites.length === expectedReadonlyRuntimeLanguages.length &&
      projectResults.projectSession.readonlyRuntimeWrites.every((write, index) =>
        write.language === expectedReadonlyRuntimeLanguages[index] &&
        write.before === 'session protected\n' &&
        write.after === 'session protected\n' &&
        write.result.exitCode !== 0 &&
        write.result.stdout === '' &&
        write.result.stderr === "EROFS: readonly project file, write 'README.md'\n"
      ),
    `Browser readonly runtime writes should fail at kernel boundary: ${JSON.stringify(projectResults.projectSession.readonlyRuntimeWrites)}`
  );
  const expectedReadonlyNodeOperations = ['append', 'delete', 'move', 'copy', 'truncate'];
  assertCondition(
    projectResults.projectSession.readonlyNodeOperations.length === expectedReadonlyNodeOperations.length &&
      projectResults.projectSession.readonlyNodeOperations.every((write, index) =>
        write.language === expectedReadonlyNodeOperations[index] &&
        write.before === 'session protected\n' &&
        write.after === 'session protected\n' &&
        write.result.exitCode !== 0 &&
        write.result.stdout === '' &&
        write.result.stderr === `EROFS: readonly project file, ${expectedReadonlyNodeOperations[index]} 'README.md'\n`
      ),
    `Browser Node readonly operations should fail at kernel boundary: ${JSON.stringify(projectResults.projectSession.readonlyNodeOperations)}`
  );
  assertCondition(
    projectResults.takehome.pythonRun.exitCode === 0 &&
      projectResults.takehome.pythonRun.stdout === 'python:Acme:takehome\n/home/user/weather-api/takehome/python\n' &&
      projectResults.takehome.pythonReport === 'top=Acme\ncount=3\n',
    `Browser Python takehome project mismatch: ${JSON.stringify(projectResults.takehome)}`
  );
  assertCondition(
    projectResults.takehome.nodeRun.exitCode === 0 &&
      projectResults.takehome.nodeRun.stdout === 'node:Acme:takehome\n/home/user/weather-api/takehome/js\n' &&
      projectResults.takehome.nodeReport === 'top=Acme\ncount=3\n',
    `Browser Node takehome project mismatch: ${JSON.stringify(projectResults.takehome)}`
  );
  assertCondition(
    projectResults.takehome.javaCompile.exitCode === 0 &&
      projectResults.takehome.javaRun.exitCode === 0 &&
      projectResults.takehome.javaRun.stdout === 'java:Acme:takehome\n/home/user/weather-api/takehome/java\n' &&
      projectResults.takehome.javaReport === 'top=Acme\ncount=3\n',
    `Browser Java takehome project mismatch: ${JSON.stringify(projectResults.takehome)}`
  );
  assertCondition(
    projectResults.takehome.cppCompile.exitCode === 0 &&
      projectResults.takehome.cppRun.exitCode === 0 &&
      projectResults.takehome.cppRun.stdout.includes('cpp:Acme:takehome\n') &&
      projectResults.takehome.cppReport === 'top=Acme\ncount=3\n',
    `Browser C++ takehome project mismatch: ${JSON.stringify(projectResults.takehome)}`
  );
  assertCondition(
    projectResults.takehome.csharpRun.exitCode === 0 &&
      projectResults.takehome.csharpRun.stdout.includes('csharp:Acme:takehome\n') &&
      projectResults.takehome.csharpRun.stdout.includes('process-error=PlatformNotSupportedException') &&
      projectResults.takehome.csharpReport === 'top=Acme\ncount=3\n',
    `Browser C# takehome project mismatch: ${JSON.stringify(projectResults.takehome)}`
  );
}

function runtimeTraceEvents(trace: unknown): unknown[] {
  if (Array.isArray(trace)) return trace;
  if (trace && typeof trace === 'object' && Array.isArray((trace as { events?: unknown }).events)) {
    return (trace as { events: unknown[] }).events;
  }
  return [];
}

async function readExampleSmokeDiagnostics(page: import('playwright').Page): Promise<string> {
  const state = await page.evaluate(() => ({
    status: document.querySelector('#status')?.textContent ?? '',
    executionOutput: document.querySelector('#execution-output')?.textContent ?? '',
    traceOutput: document.querySelector('#trace-output')?.textContent ?? '',
  }));
  return JSON.stringify(state);
}

export async function runExampleBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    for (const language of ['python', 'javascript', 'typescript', 'java', 'cpp'] as const) {
      await runLanguageExampleSmoke(page, language, {
        executionTimeoutMs: language === 'python' || language === 'java' || language === 'cpp' ? 240_000 : 60_000,
        traceTimeoutMs: language === 'python' || language === 'java' || language === 'cpp' ? 240_000 : 60_000,
      });
    }
    await runCSharpExampleSmoke(page);
    await runDevTerminalSmoke(page, previewUrl);
  } finally {
    await browser.close();
  }
}

export async function runJavaExampleBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    await runLanguageExampleSmoke(page, 'java', {
      executionTimeoutMs: 240_000,
      traceTimeoutMs: 240_000,
      assertTrace(traceResult) {
        const trace = runtimeTraceEvents(traceResult.trace);
        const callSteps = trace.filter((event) => (event as { kind?: unknown }).kind === 'call');
        const accessKinds = new Set(
          trace
            .map((event) => (event as { kind?: unknown }).kind)
            .filter((kind): kind is string => typeof kind === 'string')
        );
        assertCondition(callSteps.length > 0, 'Expected Java trace to include call events');
        assertCondition(accessKinds.has('read'), 'Expected Java trace to include read access events');
      },
    });
  } finally {
    await browser.close();
  }
}
