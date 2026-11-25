#!/usr/bin/env npx tsx

// The browser JavaScript project runner (run here on the main thread, in
// Node's V8) must name the file, line and column of every frame the way Node
// does for the same files. Each case also runs the same files under real Node
// and checks that Node still prints the frames the case records.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntimeWorkspace } from '../packages/tracekernel/src/workspace/index';
import {
  createBrowserJavaScriptProjectRunner,
  createBrowserTypeScriptProjectRunner,
} from '../packages/runtime-javascript/src/project-browser';
import {
  STACK_FRAME_WORKSPACE_ROOT,
  stackFrameCases,
  workspaceFrames,
  type StackFrameCase,
} from './helpers/javascript-project-stack-frame-cases';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function show(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runInRunner(testCase: StackFrameCase): Promise<{ result: CommandOutput; files: Map<string, string> }> {
  const workspace = await createRuntimeWorkspace({
    files: Object.entries(testCase.files).map(([path, contents]) => ({ path, contents })),
    kernel: { workspace: { root: STACK_FRAME_WORKSPACE_ROOT } },
    nodeRunner: createBrowserJavaScriptProjectRunner({ allowMainThreadExecution: true, trustedMainThreadExecution: true }),
    typescriptRunner: createBrowserTypeScriptProjectRunner(),
  });
  try {
    for (const command of testCase.setup ?? []) {
      const setup = await workspace.runCommand(command);
      assertCondition(setup.exitCode === 0, `${testCase.name}: ${command} failed: ${show(setup)}`);
    }
    const result = await workspace.runCommand(testCase.command);
    // Node runs the same files: the sources, plus whatever setup emitted.
    const files = new Map(Object.entries(testCase.files));
    for (const path of emittedFiles(testCase)) {
      files.set(path, String(await workspace.readFile(path)));
    }
    return { result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, files };
  } finally {
    workspace.dispose();
  }
}

function emittedFiles(testCase: StackFrameCase): string[] {
  if (!testCase.setup?.length) return [];
  return [...testCase.node.stdout, ...testCase.node.stderr]
    .map((frame) => /\/home\/guest\/playground\/([^:)]+\.js):\d+:\d+/.exec(frame)?.[1])
    .filter((path): path is string => Boolean(path))
    .filter((path, index, paths) => paths.indexOf(path) === index);
}

async function runInNode(testCase: StackFrameCase, files: Map<string, string>): Promise<CommandOutput> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'tracecode-stack-frames-')));
  const folder = join(parent, 'playground');
  try {
    for (const [path, contents] of files) {
      const target = join(folder, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    const output = await new Promise<CommandOutput>((resolve) => {
      execFile(
        process.execPath,
        ['--stack-trace-limit=50', testCase.nodeEntry],
        { cwd: folder, env: { PATH: process.env.PATH ?? '' } },
        (error, stdout, stderr) => {
          const code = error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error ? 1 : 0;
          resolve({ exitCode: code, stdout, stderr });
        }
      );
    });
    const folderUrl = pathToFileURL(folder).href;
    const normalize = (text: string) => text
      .split(folderUrl).join(`file://${STACK_FRAME_WORKSPACE_ROOT}`)
      .split(folder).join(STACK_FRAME_WORKSPACE_ROOT);
    return { exitCode: output.exitCode, stdout: normalize(output.stdout), stderr: normalize(output.stderr) };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function textLines(text: string): string[] {
  return text.split('\n').filter((line) => line && !/^\s+at /.test(line));
}

async function checkCase(testCase: StackFrameCase): Promise<void> {
  const { result, files } = await runInRunner(testCase);
  const node = await runInNode(testCase, files);

  // Node still prints the frames this case records.
  for (const stream of ['stdout', 'stderr'] as const) {
    assertCondition(
      isDeepStrictEqual(workspaceFrames(node[stream]), testCase.node[stream]),
      `${testCase.name}: Node's ${stream} frames changed.\nNode printed:\n${node[stream]}\nrecorded:\n${show(testCase.node[stream])}`
    );
    // Every non-frame line the runner prints (messages, ordinary output)
    // is a line Node prints too.
    for (const line of textLines(testCase.expected[stream])) {
      assertCondition(
        node[stream].split('\n').includes(line),
        `${testCase.name}: Node's ${stream} has no line ${show(line)}:\n${node[stream]}`
      );
    }
  }
  assertCondition(
    (node.exitCode === 0) === (testCase.expected.exitCode === 0),
    `${testCase.name}: Node exited ${node.exitCode}, the case expects ${testCase.expected.exitCode}`
  );

  // The runner prints exactly the expected bytes, with Node's frames.
  assertCondition(
    result.exitCode === testCase.expected.exitCode &&
      result.stdout === testCase.expected.stdout &&
      result.stderr === testCase.expected.stderr,
    `${testCase.name}: the runner printed\n${show(result)}\nexpected\n${show(testCase.expected)}\nNode printed\n${show(node)}`
  );
  for (const stream of ['stdout', 'stderr'] as const) {
    assertCondition(
      isDeepStrictEqual(workspaceFrames(result[stream]), testCase.node[stream]),
      `${testCase.name}: the runner's ${stream} frames differ from Node's: ${show(workspaceFrames(result[stream]))}`
    );
  }
}

async function main(): Promise<void> {
  // tsx installs its own formatter; the runner must hand it back unchanged.
  const hostPrepareStackTrace = Error.prepareStackTrace;
  const failures: string[] = [];
  for (const testCase of stackFrameCases) {
    try {
      await checkCase(testCase);
      console.log(`ok - ${testCase.name}`);
    } catch (error) {
      failures.push(testCase.name);
      console.log(`not ok - ${testCase.name}`);
      console.log(error instanceof Error ? error.message : String(error));
    }
  }
  // The runner installs its stack formatter only while a command runs.
  assertCondition(Error.prepareStackTrace === hostPrepareStackTrace, 'the runner left its Error.prepareStackTrace installed');
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${stackFrameCases.length} stack-frame cases failed: ${failures.join('; ')}`);
  }
  console.log(`${stackFrameCases.length} stack-frame cases match Node`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
